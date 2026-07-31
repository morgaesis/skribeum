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

const RUNS = Number(process.env.SKRIBEUM_COLD_START_RUNS ?? "20");
const NOTE_COUNT = 5_000;
const START_TIMEOUT_MILLISECONDS = 60_000;
const INDEX_TIMEOUT_MILLISECONDS = 120_000;
const MARKER = "SKRIBEUM_COLD_START ";
const TRACE = process.env.SKRIBEUM_COLD_START_TRACE === "1";
const repositoryRoot = path.resolve(import.meta.dir, "..");
const appBinary = path.join(repositoryRoot, "target", "debug", "skribeum-app");

interface ColdStartEvent {
  event: "first-editor-paint" | "full-text-index-complete";
  process_ms: number;
  webview_ms?: number;
}

interface RunMeasurement {
  firstEditorPaintMs: number;
  fullTextIndexCompleteMs?: number;
}

function requireHarnessPrerequisites(): void {
  if (!existsSync(appBinary)) {
    throw new Error(
      `missing debug binary at ${appBinary}; build it with bun tauri build --debug --no-bundle`,
    );
  }
  if (Bun.which("xvfb-run") === null) {
    throw new Error(
      "xvfb-run is required to run the cold-start harness headlessly",
    );
  }
  if (Bun.which("openbox") === null) {
    throw new Error(
      "openbox is required to map the headless application window",
    );
  }
}

function createSyntheticVault(root: string): string {
  const vault = path.join(root, "vault");
  mkdirSync(vault, { recursive: true });
  const body = [
    "# Synthetic cold-start note",
    "",
    "This deterministic corpus exercises full-text indexing without opening the editor path.",
    "Repeated searchable text keeps every generated note structurally equivalent.",
    "",
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu.",
    "",
  ].join("\n");
  for (let index = 0; index < NOTE_COUNT; index += 1) {
    const name = index.toString().padStart(4, "0");
    writeFileSync(
      path.join(vault, `note-${name}.md`),
      `${body}\nunique-cold-start-token-${name}\n`,
    );
  }
  return vault;
}

function observeOutput(
  stream: ReadableStream<Uint8Array> | null,
  onEvent: (event: ColdStartEvent) => void,
  onLine: (line: string) => void,
): Promise<void> {
  if (stream === null) {
    return Promise.resolve();
  }
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  return (async () => {
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        onLine(line);
        const marker = line.indexOf(MARKER);
        if (marker < 0) {
          continue;
        }
        try {
          onEvent(
            JSON.parse(line.slice(marker + MARKER.length)) as ColdStartEvent,
          );
        } catch {
          // Ignore unrelated backend output with the marker prefix.
        }
      }
    }
  })();
}

async function waitFor(
  predicate: () => boolean,
  timeoutMilliseconds: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function runOnce(
  vault: string,
  run: number,
  verifyIndexOrdering: boolean,
): Promise<RunMeasurement> {
  const dataRoot = mkdtempSync(
    path.join(tmpdir(), "skribeum-cold-start-data-"),
  );
  const appPidPath = path.join(dataRoot, "app.pid");
  let firstEditorPaintMs: number | undefined;
  let fullTextIndexCompleteMs: number | undefined;
  const appOutput: string[] = [];
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
        SKRIBEUM_E2E_VAULT: vault,
        WEBKIT_DISABLE_COMPOSITING_MODE: "1",
        WEBKIT_DISABLE_DMABUF_RENDERER: "1",
        XDG_CONFIG_HOME: path.join(dataRoot, "config"),
        XDG_DATA_HOME: path.join(dataRoot, "data"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const record = (event: ColdStartEvent) => {
    if (TRACE) {
      process.stderr.write(`[cold-start event] ${JSON.stringify(event)}\n`);
    }
    if (event.event === "first-editor-paint") {
      firstEditorPaintMs ??= event.process_ms;
    } else if (event.event === "full-text-index-complete") {
      fullTextIndexCompleteMs ??= event.process_ms;
    }
  };
  const recordOutput = (line: string) => {
    if (TRACE) {
      process.stderr.write(`[cold-start child] ${line}\n`);
    }
    appOutput.push(line);
    if (appOutput.length > 40) {
      appOutput.shift();
    }
  };
  const outputReaders = [
    observeOutput(child.stdout, record, recordOutput),
    observeOutput(child.stderr, record, recordOutput),
  ];

  try {
    try {
      await waitFor(
        () => firstEditorPaintMs !== undefined,
        START_TIMEOUT_MILLISECONDS,
        `first editor paint for run ${run}`,
      );
      if (verifyIndexOrdering) {
        await waitFor(
          () => fullTextIndexCompleteMs !== undefined,
          INDEX_TIMEOUT_MILLISECONDS,
          `full-text index completion for run ${run}`,
        );
      }
    } catch (error) {
      throw new Error(`${String(error)}\n${appOutput.join("\n")}`);
    }
    if (firstEditorPaintMs === undefined) {
      throw new Error(`incomplete cold-start measurement for run ${run}`);
    }
    if (
      fullTextIndexCompleteMs !== undefined &&
      firstEditorPaintMs >= fullTextIndexCompleteMs
    ) {
      throw new Error(
        `first editor paint (${firstEditorPaintMs}ms) waited for full-text indexing (${fullTextIndexCompleteMs}ms) on run ${run}`,
      );
    }
    return { firstEditorPaintMs, fullTextIndexCompleteMs };
  } finally {
    try {
      const appPid = Number.parseInt(readFileSync(appPidPath, "utf8"), 10);
      if (Number.isSafeInteger(appPid) && appPid > 1) {
        process.kill(appPid, "SIGTERM");
      } else {
        child.kill();
      }
    } catch {
      child.kill();
    }
    await Promise.race([Promise.allSettled(outputReaders), Bun.sleep(500)]);
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([child.exited, Bun.sleep(1_000)]);
    }
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil((percentileValue / 100) * sorted.length) - 1];
}

async function main(): Promise<void> {
  requireHarnessPrerequisites();
  const root = mkdtempSync(path.join(tmpdir(), "skribeum-cold-start-"));
  try {
    const vault = createSyntheticVault(root);
    const measurements: RunMeasurement[] = [];
    for (let run = 1; run <= RUNS; run += 1) {
      const measurement = await runOnce(vault, run, run === 1);
      measurements.push(measurement);
      process.stdout.write(
        `${JSON.stringify({
          schema: "skribeum.cold-start.v1",
          event: "run",
          run,
          first_editor_paint_ms: measurement.firstEditorPaintMs,
          full_text_index_complete_ms: measurement.fullTextIndexCompleteMs,
        })}\n`,
      );
    }
    const firstPaints = measurements.map(
      ({ firstEditorPaintMs }) => firstEditorPaintMs,
    );
    const indexedMeasurement = measurements.find(
      ({ fullTextIndexCompleteMs }) => fullTextIndexCompleteMs !== undefined,
    );
    if (indexedMeasurement?.fullTextIndexCompleteMs === undefined) {
      throw new Error("the index-ordering validation run is absent");
    }
    process.stdout.write(
      `${JSON.stringify({
        schema: "skribeum.cold-start.v1",
        runs: RUNS,
        first_editor_paint_ms: firstPaints,
        full_text_index_complete_ms: indexedMeasurement.fullTextIndexCompleteMs,
        p50_ms: percentile(firstPaints, 50),
        p95_ms: percentile(firstPaints, 95),
        index_after_first_paint_ms:
          indexedMeasurement.fullTextIndexCompleteMs -
          indexedMeasurement.firstEditorPaintMs,
        index_after_first_paint:
          indexedMeasurement.firstEditorPaintMs <
          indexedMeasurement.fullTextIndexCompleteMs,
      })}\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
