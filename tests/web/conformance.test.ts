// Criterion 5 (M2): the two-parser conformance gate, TypeScript side.
// The Lezer-extended parse emits `<kind> <start_byte>..<end_byte>` lines
// per corpus file in the exact format tests/syntax-spec.toml defines and
// diffs them against the committed Rust goldens in tests/conformance/rust/.
// Any byte difference fails; remediation is a normalization shim in
// tests/web/conformanceEmitter.ts pinned to a spec ruling (decision 103),
// with a documented allowlist as last resort.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { emitExtractions } from "./conformanceEmitter";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const corpusDirectory = path.join(testDirectory, "..", "corpus");
const goldenDirectory = path.join(testDirectory, "..", "conformance", "rust");

const corpusFiles = readdirSync(corpusDirectory)
  .filter((name) => name.endsWith(".md"))
  .sort();

describe("two-parser conformance gate", () => {
  it("the Rust golden directory is committed", () => {
    expect(existsSync(goldenDirectory)).toBe(true);
  });

  it.each(corpusFiles)(
    "%s extracts identically to Rust",
    { timeout: 60000 },
    (name) => {
      const goldenPath = path.join(goldenDirectory, `${name}.txt`);
      expect(existsSync(goldenPath), `missing Rust golden ${goldenPath}`).toBe(
        true,
      );
      const bytes = readFileSync(path.join(corpusDirectory, name));
      const emitted = emitExtractions(new Uint8Array(bytes));
      const golden = readFileSync(goldenPath, "utf8");
      expect(emitted).toBe(golden);
    },
  );
});
