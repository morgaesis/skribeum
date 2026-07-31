import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Browser, remote } from "webdriverio";

const NOTE_OPEN_RUNS = Number(process.env.SKRIBEUM_NOTE_OPEN_RUNS ?? "20");
const MEMORY_BATCHES = Number(process.env.SKRIBEUM_MEMORY_BATCHES ?? "4");
const EVENTS_PER_BATCH = 10_000;
const START_TIMEOUT_MILLISECONDS = 60_000;
const MEMORY_TAIL_TOLERANCE_BYTES = 16 * 1024 * 1024;
const WEBDRIVER_PORT = 4_445;
const repositoryRoot = path.resolve(import.meta.dir, "..");
const appBinary = path.join(repositoryRoot, "target", "debug", "skribeum-app");

type HarnessOptions = {
  memoryOnly?: boolean;
  noteOpenOnly?: boolean;
};

type RunningApp = {
  browser: Browser;
  child: ReturnType<typeof Bun.spawn>;
  dataRoot: string;
  pid: number;
};

function requirePrerequisites(): void {
  if (!existsSync(appBinary)) {
    throw new Error(
      `missing debug webdriver binary at ${appBinary}; build it with bun tauri build --debug --no-bundle --features webdriver --config src-tauri/tauri.webdriver.conf.json`,
    );
  }
  if (Bun.which("xvfb-run") === null) {
    throw new Error("xvfb-run is required to run the editor scale harness");
  }
  if (Bun.which("openbox") === null) {
    throw new Error(
      "openbox is required to map the headless application window",
    );
  }
}

function createNoteOpenVault(root: string): string {
  const vault = path.join(root, "note-open-vault");
  mkdirSync(vault, { recursive: true });
  const ordinaryLine =
    "Deterministic note-open content exercises the raw IPC read and editor state swap.\n";
  writeFileSync(path.join(vault, "open.md"), ordinaryLine.repeat(128));
  return vault;
}

function createMemoryVault(root: string): string {
  const vault = path.join(root, "memory-vault");
  mkdirSync(vault, { recursive: true });
  writeFileSync(
    path.join(vault, "memory.md"),
    readFileSync(
      path.join(repositoryRoot, "tests", "corpus", "large-100k-lines.md"),
    ),
  );
  return vault;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  description: string,
): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function startApp(vault: string, note: string): Promise<RunningApp> {
  const port = WEBDRIVER_PORT;
  const dataRoot = mkdtempSync(path.join(tmpdir(), "skribeum-editor-scale-"));
  const appPidPath = path.join(dataRoot, "app.pid");
  const child = Bun.spawn(
    [
      "xvfb-run",
      "-a",
      "sh",
      "-c",
      'openbox >/dev/null 2>&1 & wm=$!; trap \'kill "$wm" 2>/dev/null || true\' EXIT; "$2" & app=$!; printf "%s" "$app" > "$1"; wait "$app"',
      "sh",
      appPidPath,
      appBinary,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        SKRIBEUM_E2E_NOTE: note,
        SKRIBEUM_E2E_VAULT: vault,
        SKRIBEUM_PERF_HARNESS: "1",
        TAURI_WEBDRIVER_PORT: String(port),
        WDIO_EMBEDDED_SERVER: "true",
        XDG_CONFIG_HOME: path.join(dataRoot, "config"),
        XDG_DATA_HOME: path.join(dataRoot, "data"),
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  try {
    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/status`)).ok;
      } catch {
        return false;
      }
    }, "embedded WebDriver");
    await waitFor(() => existsSync(appPidPath), "application process id");
    const pid = Number.parseInt(readFileSync(appPidPath, "utf8"), 10);
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error("application process id is invalid");
    }
    const browser = await remote({
      hostname: "127.0.0.1",
      port,
      logLevel: "silent",
      capabilities: { browserName: "tauri" },
    });
    await browser.setTimeout({ script: 180_000 });
    await waitFor(async () => {
      try {
        return await browser.execute(() => {
          const debugWindow = window as Window & {
            __SKRIBEUM_DEBUG_EDITOR__?: { state: { doc: { length: number } } };
            __SKRIBEUM_DEBUG_NOTE_OPEN_MS__?: number;
          };
          return (
            debugWindow.__SKRIBEUM_DEBUG_EDITOR__?.state.doc.length !==
              undefined &&
            typeof debugWindow.__SKRIBEUM_DEBUG_NOTE_OPEN_MS__ === "number"
          );
        });
      } catch {
        return false;
      }
    }, `editor opening ${note}`);
    return { browser, child, dataRoot, pid };
  } catch (error) {
    child.kill();
    rmSync(dataRoot, { recursive: true, force: true });
    throw error;
  }
}

async function stopApp(app: RunningApp): Promise<void> {
  await app.browser.deleteSession().catch(() => undefined);
  try {
    process.kill(app.pid, "SIGTERM");
  } catch {
    app.child.kill();
  }
  await Promise.race([app.child.exited, Bun.sleep(500)]);
  if (app.child.exitCode === null) {
    app.child.kill();
    await Promise.race([app.child.exited, Bun.sleep(1_000)]);
  }
  rmSync(app.dataRoot, { recursive: true, force: true });
}

function readProcessResidentSetBytes(pid: number): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  if (match?.[1] === undefined) {
    throw new Error(`VmRSS is absent for process ${pid}`);
  }
  return Number.parseInt(match[1], 10) * 1024;
}

function processTree(pid: number): number[] {
  const processes = [pid];
  for (let index = 0; index < processes.length; index += 1) {
    const current = processes[index];
    try {
      const children = readFileSync(
        `/proc/${current}/task/${current}/children`,
        "utf8",
      )
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
      processes.push(...children);
    } catch {
      // A short-lived helper may exit between process-tree samples.
    }
  }
  return processes;
}

function readResidentSetBytes(pid: number): number {
  return processTree(pid).reduce((total, processId) => {
    try {
      return total + readProcessResidentSetBytes(processId);
    } catch {
      return total;
    }
  }, 0);
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((percentileValue / 100) * sorted.length) - 1] ?? 0;
}

async function measureNoteOpen(vault: string): Promise<number[]> {
  const measurements: number[] = [];
  const app = await startApp(vault, "open.md");
  try {
    for (let run = 0; run < NOTE_OPEN_RUNS; run += 1) {
      const result = await app.browser.executeAsync(
        (
          path: string,
          done: (value: { duration?: number; error?: string }) => void,
        ) => {
          const debugWindow = window as Window & {
            __SKRIBEUM_DEBUG_NOTE_OPEN_MS__?: number;
            __SKRIBEUM_DEBUG_OPEN_NOTE__?: (path: string) => Promise<void>;
          };
          const openNote = debugWindow.__SKRIBEUM_DEBUG_OPEN_NOTE__;
          if (openNote === undefined) {
            done({ error: "debug note-open function is absent" });
            return;
          }
          openNote(path).then(
            () =>
              done({ duration: debugWindow.__SKRIBEUM_DEBUG_NOTE_OPEN_MS__ }),
            (error: unknown) => done({ error: String(error) }),
          );
        },
        "open.md",
      );
      if (result.error !== undefined || typeof result.duration !== "number") {
        throw new Error(result.error ?? "note-open duration is absent");
      }
      measurements.push(result.duration);
    }
  } finally {
    await stopApp(app);
  }
  return measurements;
}

async function driveBatch(browser: Browser, seed: number): Promise<number> {
  const result = await browser.executeAsync(
    (
      count: number,
      initialSeed: number,
      done: (value: { error?: string; seed?: number }) => void,
    ) => {
      type DebugEditor = {
        state: { doc: { length: number } };
        dispatch(spec: unknown): void;
      };
      const editor = (
        window as Window & { __SKRIBEUM_DEBUG_EDITOR__?: DebugEditor }
      ).__SKRIBEUM_DEBUG_EDITOR__;
      if (editor === undefined) {
        done({ error: "debug editor is absent" });
        return;
      }
      let currentSeed = initialSeed;
      let cursor = Math.floor(editor.state.doc.length / 2);
      let index = 0;
      const nextRandom = () => {
        currentSeed = (currentSeed * 1103515245 + 12345) & 0x7fffffff;
        return currentSeed / 0x7fffffff;
      };
      const chunk = () => {
        const end = Math.min(index + 250, count);
        for (; index < end; index += 1) {
          if (index % 5 === 4) {
            const anchor = Math.floor(nextRandom() * editor.state.doc.length);
            cursor = Math.floor(nextRandom() * editor.state.doc.length);
            editor.dispatch({ selection: { anchor, head: cursor } });
          } else {
            editor.dispatch({
              changes: { from: cursor, to: cursor, insert: "x" },
              selection: { anchor: cursor + 1 },
            });
            cursor += 1;
          }
        }
        if (index < count) {
          requestAnimationFrame(chunk);
        } else {
          requestAnimationFrame(() => done({ seed: currentSeed }));
        }
      };
      chunk();
    },
    EVENTS_PER_BATCH,
    seed,
  );
  if (result.error !== undefined || result.seed === undefined) {
    throw new Error(result.error ?? "memory replay returned no seed");
  }
  return result.seed;
}

async function measureMemory(vault: string): Promise<number[]> {
  const app = await startApp(vault, "memory.md");
  try {
    const samples = [readResidentSetBytes(app.pid)];
    let seed = 0x2f6e2b1;
    for (let batch = 0; batch < MEMORY_BATCHES; batch += 1) {
      seed = await driveBatch(app.browser, seed);
      samples.push(readResidentSetBytes(app.pid));
    }
    const tail = samples.slice(-3);
    const tailGrowth = (tail.at(-1) ?? 0) - (tail[0] ?? 0);
    const earlyGrowth = (samples[2] ?? samples.at(-1) ?? 0) - samples[0];
    if (
      tailGrowth > MEMORY_TAIL_TOLERANCE_BYTES ||
      (earlyGrowth > 0 && tailGrowth > earlyGrowth)
    ) {
      throw new Error(
        `RSS did not flatten: final two-batch growth is ${(tailGrowth / 1048576).toFixed(2)} MiB`,
      );
    }
    return samples;
  } finally {
    await stopApp(app);
  }
}

export async function runEditorScaleHarness(
  options: HarnessOptions = {},
): Promise<void> {
  if (options.memoryOnly === true && options.noteOpenOnly === true) {
    throw new Error(
      "memory-only and note-open-only modes are mutually exclusive",
    );
  }
  requirePrerequisites();
  const root = mkdtempSync(path.join(tmpdir(), "skribeum-editor-scale-vault-"));
  try {
    if (!options.memoryOnly) {
      const noteOpen = await measureNoteOpen(createNoteOpenVault(root));
      const p50 = percentile(noteOpen, 50);
      const p95 = percentile(noteOpen, 95);
      const output = {
        schema: "skribeum.note-open.v1",
        runs: NOTE_OPEN_RUNS,
        samples_ms: noteOpen.map((value) => Number(value.toFixed(2))),
        p50_ms: Number(p50.toFixed(2)),
        p95_ms: Number(p95.toFixed(2)),
      };
      process.stdout.write(`${JSON.stringify(output)}\n`);
      if (p95 >= 100) {
        throw new Error(`note-open p95 ${p95.toFixed(2)}ms is not below 100ms`);
      }
    }
    if (!options.noteOpenOnly) {
      const rss = await measureMemory(createMemoryVault(root));
      process.stdout.write(
        `${JSON.stringify({
          schema: "skribeum.memory-growth.v1",
          events_per_batch: EVENTS_PER_BATCH,
          batches: MEMORY_BATCHES,
          rss_mib: rss.map((value) => Number((value / 1048576).toFixed(2))),
          final_two_batch_growth_mib: Number(
            (((rss.at(-1) ?? 0) - (rss.at(-3) ?? 0)) / 1048576).toFixed(2),
          ),
          flattened: true,
        })}\n`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await runEditorScaleHarness({
    memoryOnly: process.env.SKRIBEUM_MEMORY_GROWTH === "1",
    noteOpenOnly: process.env.SKRIBEUM_NOTE_OPEN_ONLY === "1",
  });
}
