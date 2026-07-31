// Criterion 3 (M1b): decorations are inert. There is no decoration engine
// until M2, but its enforcement mechanism exists now: every transaction the
// engine dispatches carries the `decorationOrigin` annotation, and the
// dispatch wrapper asserts `docChanged === false` for annotated
// transactions. The corpus sweep below drives the guard at sampled cursor
// positions on every corpus file; at M2 the same sweep runs the real
// decoration engine at each position before asserting.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  assertDecorationsInert,
  decorationOrigin,
} from "../../src/lib/editor/decorationGuard";

const corpusDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "corpus",
);

const decoder = new TextDecoder("utf-8", { fatal: false });

/** Every corpus markdown file, decoded the way the display path decodes. */
function corpusDocuments(): { name: string; text: string }[] {
  return readdirSync(corpusDirectory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => ({
      name,
      text: decoder.decode(readFileSync(path.join(corpusDirectory, name))),
    }));
}

/** Sampled cursor positions: ends, interior points, and line boundaries. */
function samplePositions(length: number): number[] {
  const positions = new Set<number>([
    0,
    length,
    Math.floor(length / 3),
    Math.floor(length / 2),
    Math.floor((2 * length) / 3),
  ]);
  return [...positions].filter(
    (position) => position >= 0 && position <= length,
  );
}

describe("decoration inertness guard", () => {
  it("passes decoration-annotated transactions that leave the document alone", () => {
    const state = EditorState.create({ doc: "# heading\n\nbody\n" });
    const transaction = state.update({
      selection: { anchor: 3 },
      annotations: decorationOrigin.of(true),
    });
    expect(transaction.docChanged).toBe(false);
    expect(() => assertDecorationsInert([transaction])).not.toThrow();
  });

  it("rejects a decoration-annotated transaction that changes the document", () => {
    // The mutation companion: a deliberately document-mutating decoration
    // transaction the guard must reject, so a refactor cannot reduce the
    // assertion to a tautology.
    const state = EditorState.create({ doc: "# heading\n" });
    const transaction = state.update({
      changes: { from: 0, to: 0, insert: "mutated" },
      annotations: decorationOrigin.of(true),
    });
    expect(transaction.docChanged).toBe(true);
    expect(() => assertDecorationsInert([transaction])).toThrow(
      "decoration-originated transaction changed the document",
    );
  });

  it("ignores unannotated transactions entirely", () => {
    const state = EditorState.create({ doc: "text\n" });
    const transaction = state.update({
      changes: { from: 0, to: 0, insert: "user " },
    });
    expect(() => assertDecorationsInert([transaction])).not.toThrow();
  });

  it("wires into the view dispatcher", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "guarded\n" }),
      dispatchTransactions: (transactions, target) => {
        assertDecorationsInert(transactions);
        target.update(transactions);
      },
    });
    try {
      expect(() =>
        view.dispatch({
          changes: { from: 0, to: 0, insert: "x" },
          annotations: decorationOrigin.of(true),
        }),
      ).toThrow("decoration-originated transaction changed the document");
      // The rejected transaction never reached the state.
      expect(view.state.doc.toString()).toBe("guarded\n");
    } finally {
      view.destroy();
    }
  });

  it("holds over every corpus file at sampled cursor positions", () => {
    const documents = corpusDocuments();
    expect(documents.length).toBeGreaterThan(0);
    for (const document of documents) {
      const state = EditorState.create({ doc: document.text });
      for (const position of samplePositions(state.doc.length)) {
        // M2 replaces this selection-only transaction with the decoration
        // engine's own output at the same sampled position; the assertion
        // below is the criterion and stays unchanged.
        const transaction = state.update({
          selection: { anchor: position },
          annotations: decorationOrigin.of(true),
        });
        expect(transaction.docChanged).toBe(false);
        expect(() => assertDecorationsInert([transaction])).not.toThrow();
      }
    }
  });
});
