// Keystroke-latency report harness (M2, informational; gates nothing).
// Replays keystrokes and cursor movements into an EditorView holding the
// two pathological corpus files, sampling the wall-clock cost of each
// dispatch, in three configurations: no language support (baseline), the
// markdown language alone, and markdown plus the decoration engine. The
// difference between the last two isolates what the decoration engine
// adds; cursor movement is replayed because cursor reveal rebuilds the
// decoration set on selection changes, not only on edits.
//
// Runs under jsdom via `bun scripts/keystroke-latency.ts`, so the numbers
// characterize compute cost, not any webview's paint cost; the M3b gate
// measures p99 on the reference machine. Keystroke counts are modest
// because a single dispatch on the 100k-line file costs seconds in this
// environment (the cost sits in the language state's incremental-parse
// bookkeeping, present with the stock markdown language and unchanged by
// the decoration engine).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
});
const jsdomWindow = dom.window;
const globals = globalThis as unknown as Record<string, unknown>;
globals.window = jsdomWindow;
globals.document = jsdomWindow.document;
globals.navigator = jsdomWindow.navigator;
for (const name of [
  "Node",
  "Element",
  "HTMLElement",
  "Range",
  "Text",
  "MutationObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "CustomEvent",
  "KeyboardEvent",
  "InputEvent",
  "DOMRect",
]) {
  const value = (jsdomWindow as unknown as Record<string, unknown>)[name];
  if (value !== undefined) {
    globals[name] = value;
  }
}

// jsdom performs no layout; give CodeMirror empty geometry, as the web
// test setup does.
const emptyRect = {
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
} as DOMRect;
jsdomWindow.Range.prototype.getBoundingClientRect = () => emptyRect;
jsdomWindow.Range.prototype.getClientRects = () => {
  const rects = [] as unknown as DOMRectList;
  (rects as unknown as { item: (index: number) => DOMRect | null }).item = () =>
    null;
  return rects;
};
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(jsdomWindow as unknown as Record<string, unknown>).ResizeObserver =
  ResizeObserverStub;
globals.ResizeObserver = ResizeObserverStub;

const { markdown, markdownLanguage } = await import(
  "@codemirror/lang-markdown"
);
const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { decorationEngine } = await import(
  "../src/lib/editor/decorations/engine"
);
const { obsidianMarkdownExtensions } = await import(
  "../src/lib/editor/markdown/obsidian"
);

const corpusDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "tests",
  "corpus",
);

const KEYSTROKES = Number(process.env.SKRIBEUM_LATENCY_KEYSTROKES ?? "40");

function quantile(sorted: number[], q: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.floor(q * (sorted.length - 1)),
  );
  return sorted[index] ?? 0;
}

const markdownSupport = () =>
  markdown({ base: markdownLanguage, extensions: obsidianMarkdownExtensions });

const configurations: [string, () => unknown[]][] = [
  ["baseline", () => []],
  ["markdown", () => [markdownSupport()]],
  ["markdown+decorations", () => [markdownSupport(), decorationEngine()]],
];

function replay(file: string, label: string, extensions: unknown[]): void {
  const text = readFileSync(path.join(corpusDirectory, file), "utf8");
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: extensions as never,
    }),
  });
  try {
    const deltas: number[] = [];
    // Deterministic pseudo-random cursor targets so runs are comparable.
    let seed = 0x2f6e2b1;
    const nextRandom = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let cursor = Math.floor(view.state.doc.length / 2);
    for (let index = 0; index < KEYSTROKES; index += 1) {
      const moveCursor = index % 5 === 4;
      const start = performance.now();
      if (moveCursor) {
        cursor = Math.floor(nextRandom() * view.state.doc.length);
        view.dispatch({ selection: { anchor: cursor } });
      } else {
        view.dispatch({
          changes: { from: cursor, to: cursor, insert: "x" },
          selection: { anchor: cursor + 1 },
        });
        cursor += 1;
      }
      deltas.push(performance.now() - start);
    }
    deltas.sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        file,
        configuration: label,
        keystrokes: KEYSTROKES,
        p50_ms: Number(quantile(deltas, 0.5).toFixed(2)),
        p95_ms: Number(quantile(deltas, 0.95).toFixed(2)),
        p99_ms: Number(quantile(deltas, 0.99).toFixed(2)),
        max_ms: Number((deltas[deltas.length - 1] ?? 0).toFixed(2)),
      }),
    );
  } finally {
    view.destroy();
  }
}

for (const file of ["large-100k-lines.md", "large-2mb-single-line.md"]) {
  for (const [label, extensions] of configurations) {
    replay(file, label, extensions());
  }
}
