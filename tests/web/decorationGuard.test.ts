// Criterion 2 (M2, carried from M1b): decorations are inert. Every
// transaction the engine causes carries the `decorationOrigin` annotation,
// and the dispatch wrapper asserts `docChanged === false` for annotated
// transactions. The corpus sweep below mounts the real decoration engine
// over every corpus file and drives cursor movement (which rebuilds the
// decoration set through cursor reveal) and engine context updates at
// sampled positions, asserting the document never changes.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  assertDecorationsInert,
  decorationOrigin,
  guardedDecorations,
} from "../../src/lib/editor/decorationGuard";
import {
  decorationEngine,
  dispatchWikilinkContext,
  engineDecorations,
} from "../../src/lib/editor/decorations/engine";
import { DEFAULT_OBSIDIAN_APP_CONFIG } from "../../src/lib/editor/decorations/wikilinks";
import { obsidianMarkdownExtensions } from "../../src/lib/editor/markdown/obsidian";

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

  it("answers a failed build with the decorations the note already had", () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const fallback = Decoration.set([
        Decoration.mark({ class: "kept" }).range(0, 4),
      ]);
      const result = guardedDecorations(() => {
        throw new RangeError("Mark decorations may not be empty");
      }, fallback);
      expect(result).toBe(fallback);
      expect(reported).toHaveBeenCalledOnce();
    } finally {
      reported.mockRestore();
    }
  });

  it("answers a successful build with its own decorations", () => {
    const built = Decoration.set([
      Decoration.mark({ class: "built" }).range(0, 4),
    ]);
    expect(guardedDecorations(() => built, Decoration.none)).toBe(built);
  });

  it("holds over every corpus file with the real engine at sampled cursor positions", {
    timeout: 120000,
  }, () => {
    const documents = corpusDocuments();
    expect(documents.length).toBeGreaterThan(0);
    for (const document of documents) {
      const view = new EditorView({
        state: EditorState.create({
          doc: document.text,
          extensions: [
            markdown({
              base: markdownLanguage,
              extensions: obsidianMarkdownExtensions,
            }),
            decorationEngine(),
          ],
        }),
        dispatchTransactions: (transactions, target) => {
          assertDecorationsInert(transactions);
          target.update(transactions);
        },
      });
      try {
        // The editor buffer normalizes terminators on load; the invariant
        // is that no engine-caused transaction moves the document from
        // its mounted state.
        const mounted = view.state.doc.toString();
        // The engine's own dispatch site: a wikilink context update, which
        // must pass the guard and leave the document untouched.
        dispatchWikilinkContext(view, {
          paths: ["garden-journal.md"],
          config: DEFAULT_OBSIDIAN_APP_CONFIG,
        });
        for (const position of samplePositions(view.state.doc.length)) {
          // Cursor movement rebuilds the decoration set through cursor
          // reveal; the annotated transaction must stay inert.
          view.dispatch({
            selection: { anchor: position },
            annotations: decorationOrigin.of(true),
          });
        }
        expect(view.state.doc.toString()).toBe(mounted);
        expect(engineDecorations(view)).not.toBeNull();
      } finally {
        view.destroy();
      }
    }
  });
});
