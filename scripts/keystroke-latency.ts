// Keystroke-latency and retained-memory harness. Replays edits and selection
// drags into an EditorView holding the pathological corpus files. An update
// listener records input-to-update latency because cursor reveal rebuilds
// decorations on selection changes as well as edits.
//
// Runs under jsdom via `bun scripts/keystroke-latency.ts`, so the numbers
// characterize editor update cost rather than webview paint cost. Profile
// mode adds parser-only configurations that isolate incremental parsing.
// Set SKRIBEUM_MEMORY_GROWTH=1 to run the workload in the real debug binary
// and sample that process's resident set from procfs.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

if (process.env.SKRIBEUM_MEMORY_GROWTH === "1") {
  const { runEditorScaleHarness } = await import("./editor-scale");
  await runEditorScaleHarness({ memoryOnly: true });
  process.exit(0);
}

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

const { commonmarkLanguage, markdown, markdownLanguage } = await import(
  "@codemirror/lang-markdown"
);
const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const { obsidianMarkdownExtensions } = await import(
  "../src/lib/editor/markdown/obsidian"
);
const { mathMarkdownExtension } = await import("../src/lib/rendering/math");
const { editorSyntaxExtensions, hasOverlongLine } = await import(
  "../src/lib/editor/syntaxPolicy"
);

const corpusDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "tests",
  "corpus",
);

const KEYSTROKES = Number(process.env.SKRIBEUM_LATENCY_KEYSTROKES ?? "10000");
const WARMUP_EVENTS = Number(
  process.env.SKRIBEUM_LATENCY_WARMUP_EVENTS ?? "1000",
);
const P99_BUDGET_MILLISECONDS = 16;
const ASSERT_BUDGET =
  process.env.SKRIBEUM_LATENCY_ASSERT !== "0" &&
  process.env.SKRIBEUM_LATENCY_PROFILE !== "1";
const failures: string[] = [];

function quantile(sorted: number[], q: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.floor(q * (sorted.length - 1)),
  );
  return sorted[index] ?? 0;
}

const markdownSupport = () =>
  markdown({
    base: markdownLanguage,
    extensions: [...obsidianMarkdownExtensions, mathMarkdownExtension],
  });

const configurations: [string, (text: string) => unknown[]][] = [
  ["baseline", () => []],
  ["markdown", (text) => (hasOverlongLine(text) ? [] : [markdownSupport()])],
  ["markdown+decorations", (text) => editorSyntaxExtensions(text)],
];

if (process.env.SKRIBEUM_LATENCY_PROFILE === "1") {
  configurations.splice(
    1,
    0,
    [
      "commonmark",
      () => [markdown({ base: commonmarkLanguage, extensions: [] })],
    ],
    ["gfm", () => [markdown({ base: markdownLanguage, extensions: [] })]],
    [
      "unbounded-obsidian",
      () => [
        markdown({
          base: markdownLanguage,
          extensions: [
            ...obsidianMarkdownExtensions.slice(1),
            mathMarkdownExtension,
          ],
        }),
      ],
    ],
  );
}

type InputKind = "edit" | "selection";

function drive(
  view: InstanceType<typeof EditorView>,
  count: number,
  seed: number,
  onDispatchStart: (startedAt: number, kind: InputKind) => void,
): number {
  const nextRandom = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  let cursor = Math.floor(view.state.doc.length / 2);
  for (let index = 0; index < count; index += 1) {
    const moveCursor = index % 5 === 4;
    if (moveCursor) {
      onDispatchStart(performance.now(), "selection");
      const anchor = Math.floor(nextRandom() * view.state.doc.length);
      cursor = Math.floor(nextRandom() * view.state.doc.length);
      view.dispatch({ selection: { anchor, head: cursor } });
    } else {
      onDispatchStart(performance.now(), "edit");
      view.dispatch({
        changes: { from: cursor, to: cursor, insert: "x" },
        selection: { anchor: cursor + 1 },
      });
      cursor += 1;
    }
  }
  return seed;
}

function replay(
  file: string,
  label: string,
  extensionFactory: (text: string) => unknown[],
): void {
  const text = readFileSync(path.join(corpusDirectory, file), "utf8");
  const extensions = extensionFactory(text);
  const deltas: number[] = [];
  const editDeltas: number[] = [];
  const selectionDeltas: number[] = [];
  let dispatchStartedAt = 0;
  let inputKind: InputKind = "edit";
  let recording = false;
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        ...(extensions as never[]),
        EditorView.updateListener.of(() => {
          if (!recording) {
            return;
          }
          const delta = performance.now() - dispatchStartedAt;
          deltas.push(delta);
          (inputKind === "edit" ? editDeltas : selectionDeltas).push(delta);
        }),
      ],
    }),
  });
  try {
    let seed = 0x2f6e2b1;
    seed = drive(view, WARMUP_EVENTS, seed, (startedAt, kind) => {
      dispatchStartedAt = startedAt;
      inputKind = kind;
    });
    recording = true;
    drive(view, KEYSTROKES, seed, (startedAt, kind) => {
      dispatchStartedAt = startedAt;
      inputKind = kind;
    });
    if (deltas.length !== KEYSTROKES) {
      throw new Error(
        `expected ${KEYSTROKES} editor updates, observed ${deltas.length}`,
      );
    }
    deltas.sort((a, b) => a - b);
    editDeltas.sort((a, b) => a - b);
    selectionDeltas.sort((a, b) => a - b);
    const p99 = quantile(deltas, 0.99);
    if (
      ASSERT_BUDGET &&
      label === "markdown+decorations" &&
      p99 >= P99_BUDGET_MILLISECONDS
    ) {
      failures.push(
        `${file} ${label}: p99 ${p99.toFixed(2)}ms is not below ${P99_BUDGET_MILLISECONDS}ms`,
      );
    }
    console.log(
      JSON.stringify({
        file,
        configuration: label,
        warmup_events: WARMUP_EVENTS,
        keystrokes: KEYSTROKES,
        p50_ms: Number(quantile(deltas, 0.5).toFixed(2)),
        p95_ms: Number(quantile(deltas, 0.95).toFixed(2)),
        p99_ms: Number(p99.toFixed(2)),
        edit_p99_ms: Number(quantile(editDeltas, 0.99).toFixed(2)),
        selection_p99_ms: Number(quantile(selectionDeltas, 0.99).toFixed(2)),
        max_ms: Number((deltas[deltas.length - 1] ?? 0).toFixed(2)),
      }),
    );
  } finally {
    view.destroy();
  }
}

const corpusFiles = (
  process.env.SKRIBEUM_LATENCY_FILES ??
  "large-100k-lines.md,large-2mb-single-line.md"
).split(",");
const selectedConfigurations = process.env.SKRIBEUM_LATENCY_CONFIGURATIONS
  ? new Set(process.env.SKRIBEUM_LATENCY_CONFIGURATIONS.split(","))
  : null;

for (const file of corpusFiles) {
  for (const [label, extensionFactory] of configurations) {
    if (selectedConfigurations !== null && !selectedConfigurations.has(label)) {
      continue;
    }
    replay(file, label, extensionFactory);
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(failure);
  }
  process.exitCode = 1;
}
