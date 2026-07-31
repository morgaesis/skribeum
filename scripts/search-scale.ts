// Search-scale report harness. It creates a deterministic 5,000-note vault,
// starts the Rust helper through Cargo, then measures only the rebuild command
// after the helper has opened the vault and initialized its SQLite database.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const NOTE_COUNT = 5_000;
const SEED = 0x51ca_1e5e_d00d_f00dn;

function scaleValue(index: number): bigint {
  let value = SEED ^ BigInt(index);
  value ^= value >> 30n;
  value = BigInt.asUintN(64, value * 0xbf58_476d_1ce4_e5b9n);
  value ^= value >> 27n;
  value = BigInt.asUintN(64, value * 0x94d0_49bb_1331_11ebn);
  return BigInt.asUintN(64, value ^ (value >> 31n));
}

function noteContent(index: number): string {
  const value = scaleValue(index);
  const group = value % 29n;
  const topic = (value >> 16n) % 37n;
  return `# Search scale ${index}\n\nscaleanchor group${group} topic${topic} unique${index}\n`;
}

async function lineReader(
  stream: ReadableStream<Uint8Array>,
): Promise<() => Promise<string>> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  return async () => {
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        return line;
      }
      const { done, value } = await reader.read();
      if (done) {
        if (pending.length > 0) {
          const line = pending;
          pending = "";
          return line;
        }
        throw new Error(
          "search-scale helper closed stdout before reporting a result",
        );
      }
      pending += value;
    }
  };
}

const temporaryRoot = mkdtempSync(
  path.join(tmpdir(), "skribeum-search-scale-"),
);
const vaultRoot = path.join(temporaryRoot, "vault");
const appDataDir = path.join(temporaryRoot, "app-data");

try {
  mkdirSync(vaultRoot);
  mkdirSync(appDataDir);
  for (let index = 0; index < NOTE_COUNT; index += 1) {
    writeFileSync(
      path.join(
        vaultRoot,
        `scale-note-${index.toString().padStart(4, "0")}.md`,
      ),
      noteContent(index),
    );
  }

  const helper = Bun.spawn(
    [
      "cargo",
      "run",
      "--quiet",
      "--release",
      "-p",
      "skribeum-vault",
      "--bin",
      "search-scale-helper",
      "--",
      vaultRoot,
      appDataDir,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const nextLine = await lineReader(helper.stdout);
  const ready = await nextLine();
  if (ready !== "READY") {
    throw new Error(`unexpected search-scale helper response: ${ready}`);
  }

  const started = performance.now();
  helper.stdin.write("build\n");
  helper.stdin.end();
  const result = await nextLine();
  const indexBuildMilliseconds = performance.now() - started;
  const exitCode = await helper.exited;
  if (exitCode !== 0) {
    const stderr = await new Response(helper.stderr).text();
    throw new Error(`search-scale helper exited ${exitCode}: ${stderr.trim()}`);
  }
  const match = /^BUILT (\d+)$/.exec(result);
  if (!match) {
    throw new Error(`unexpected search-scale build result: ${result}`);
  }
  const indexed = Number(match[1]);
  if (indexed !== NOTE_COUNT) {
    throw new Error(`expected ${NOTE_COUNT} indexed notes, got ${indexed}`);
  }

  console.log(
    JSON.stringify({
      seed: `0x${SEED.toString(16)}`,
      notes: NOTE_COUNT,
      indexed,
      index_build_ms: Number(indexBuildMilliseconds.toFixed(2)),
    }),
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
