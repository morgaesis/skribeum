import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { applyByteChangeSet } from "../../src/lib/editor/byteChangeSet";
import { taskStatusConfiguration } from "../../src/lib/editor/decorations/engine";
import { obsidianMarkdownExtensionsFor } from "../../src/lib/editor/markdown/obsidian";
import { NoteSession } from "../../src/lib/editor/noteSession";
import { createAppRegistry } from "../../src/lib/features";
import { setTaskStatusAtCursor } from "../../src/lib/features/taskCommands";
import type { CommandContext } from "../../src/lib/registry";
import {
  defaultTaskStatuses,
  normalizeTaskStatuses,
  type TaskStatus,
  taskStatusCommandId,
} from "../../src/lib/taskStatuses";

const CUSTOM_STATUSES: TaskStatus[] = [
  {
    symbol: " ",
    name: "Ready",
    category: "TODO",
    glyph: "○",
    color_token: "--skr-accent",
    next_status: "~",
  },
  {
    symbol: "~",
    name: "Paused",
    category: "ON_HOLD",
    glyph: "Ⅱ",
    color_token: "--skr-callout-purple",
    next_status: "x",
  },
  {
    symbol: "x",
    name: "Finished",
    category: "DONE",
    glyph: "✓",
    color_token: "--skr-success",
    next_status: " ",
  },
];

let view: EditorView | undefined;

function state(doc: string, cursor: number): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [
      markdown({
        base: markdownLanguage,
        extensions: obsidianMarkdownExtensionsFor(CUSTOM_STATUSES),
      }),
      taskStatusConfiguration.of(CUSTOM_STATUSES),
    ],
  });
}

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.textContent = "";
});

describe("task status commands and byte fidelity", () => {
  it("assigns the exact default vocabulary to four tracks", () => {
    const statuses = defaultTaskStatuses();
    const symbols = (track: string) =>
      statuses
        .filter((status) => status.track === track)
        .map((status) => status.symbol)
        .join("");
    expect(symbols("task")).toBe(" /x-X");
    expect(symbols("time")).toBe("D<>");
    expect(symbols("importance")).toBe("!");
    expect(symbols("reference")).toBe("?+RiBPCQNbIpLEArcdT@tO~WfFH&s");
    expect(
      statuses.slice(0, 9).map(({ symbol, name, next_status, payload }) => ({
        symbol,
        name,
        next_status,
        payload,
      })),
    ).toEqual([
      { symbol: " ", name: "Todo", next_status: "/", payload: null },
      { symbol: "/", name: "Doing", next_status: "x", payload: null },
      { symbol: "x", name: "Done", next_status: " ", payload: null },
      { symbol: "-", name: "Cancelled", next_status: " ", payload: null },
      {
        symbol: "X",
        name: "Done (alternate)",
        next_status: " ",
        payload: null,
      },
      { symbol: "D", name: "Due", next_status: "x", payload: "date" },
      { symbol: "<", name: "Scheduled", next_status: "x", payload: "date" },
      { symbol: ">", name: "Forwarded", next_status: "x", payload: "date" },
      {
        symbol: "!",
        name: "Important",
        next_status: "!",
        payload: "level",
      },
    ]);
  });

  it("resolves backend default names through the message catalogue", () => {
    const backendDefaults = defaultTaskStatuses().map((status) => ({
      ...status,
      name: "",
    }));
    expect(
      normalizeTaskStatuses(backendDefaults).map(({ name }) => name),
    ).toEqual(defaultTaskStatuses().map(({ name }) => name));
  });

  it("preserves a custom name that resembles an old default identifier", () => {
    const statuses = CUSTOM_STATUSES.map((status) =>
      status.symbol === "x" ? { ...status, name: "default:x" } : status,
    );
    expect(
      normalizeTaskStatuses(statuses).find(({ symbol }) => symbol === "x")
        ?.name,
    ).toBe("default:x");
  });

  it("rejects undefined theme color tokens", () => {
    const statuses = CUSTOM_STATUSES.map((status) =>
      status.symbol === "x"
        ? { ...status, color_token: "--skr-not-defined" }
        : status,
    );
    expect(normalizeTaskStatuses(statuses)).toEqual(defaultTaskStatuses());
  });

  it("registers one named palette command per configured status", () => {
    const registry = createAppRegistry(CUSTOM_STATUSES);
    const commands = registry
      .paletteCommands()
      .filter((command) => command.id.startsWith("task.status."));
    expect(commands.map((command) => command.title)).toEqual([
      "Reference: Paused",
      "Task: Finished",
      "Task: Ready",
    ]);
  });

  it("sets a specific status on the task under the cursor", () => {
    const source = "- [ ] task body\n\noutside";
    view = new EditorView({
      state: state(source, source.indexOf("body")),
      parent: document.body,
    });
    const registry = createAppRegistry(CUSTOM_STATUSES);
    const context: CommandContext = {
      view,
      openNote: () => Promise.resolve(),
      openView: () => {},
      openCommandSurface: () => {},
      toggleView: () => {},
      closeSurfaces: () => {},
      requestSave: () => {},
      notePaths: () => [],
      recentNotePaths: () => [],
    };
    expect(registry.run(taskStatusCommandId("~"), context)).toBe(true);
    expect(view.state.doc.toString()).toBe("- [~] task body\n\noutside");
  });

  it("leaves an unconfigured marker as plain text", () => {
    const source = "- [?] unknown\n- [~] configured";
    const editorState = state(source, source.length);
    const taskMarkers: string[] = [];
    const tree = ensureSyntaxTree(editorState, editorState.doc.length, 2_000);
    expect(tree).not.toBeNull();
    tree?.iterate({
      enter: (node) => {
        if (node.name === "TaskMarker") {
          taskMarkers.push(editorState.doc.sliceString(node.from, node.to));
        }
      },
    });
    expect(taskMarkers).toEqual(["[~]"]);
    expect(editorState.doc.toString()).toBe(source);
  });

  it("leaves removed conventional markers as plain text", () => {
    const statuses: TaskStatus[] = [
      {
        symbol: "~",
        name: "Paused",
        category: "ON_HOLD",
        glyph: "Ⅱ",
        color_token: "--skr-warning",
        next_status: "~",
      },
    ];
    const source = "- [ ] removed open\n- [x] removed done\n- [~] configured";
    const editorState = EditorState.create({
      doc: source,
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: obsidianMarkdownExtensionsFor(statuses),
        }),
        taskStatusConfiguration.of(statuses),
      ],
    });
    const taskMarkers: string[] = [];
    ensureSyntaxTree(editorState, editorState.doc.length, 2_000)?.iterate({
      enter: (node) => {
        if (node.name === "TaskMarker") {
          taskMarkers.push(editorState.doc.sliceString(node.from, node.to));
        }
      },
    });
    expect(taskMarkers).toEqual(["[~]"]);
    expect(editorState.doc.toString()).toBe(source);
  });

  it("round-trips an unknown-marker corpus without recognizing task nodes", () => {
    const source = ["?", "u", "🌱", "·"]
      .map((symbol) => `- [${symbol}] untouched ${symbol}`)
      .join("\n");
    const editorState = state(source, source.length);
    const markers: string[] = [];
    const linkMarks: string[] = [];
    ensureSyntaxTree(editorState, editorState.doc.length, 2_000)?.iterate({
      enter(node) {
        if (node.name === "TaskMarker") {
          markers.push(editorState.doc.sliceString(node.from, node.to));
        }
        if (node.name === "LinkMark") {
          linkMarks.push(editorState.doc.sliceString(node.from, node.to));
        }
      },
    });
    expect(markers).toEqual([]);
    expect(linkMarks).toEqual([]);
    expect(editorState.doc.toString()).toBe(source);
  });

  it("persists one marker byte while preserving BOM, UTF-8 and CRLF bytes", () => {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
    const original = encoder.encode("\uFEFF- [ ] café\r\nnext\n");
    const session = new NoteSession(original, "base-hash");
    const editorState = state(
      session.base.text,
      session.base.text.indexOf("café"),
    );
    const transaction = setTaskStatusAtCursor(editorState, "~");
    expect(transaction).not.toBeNull();
    if (transaction === null) {
      return;
    }
    session.recordLocalChanges(transaction.changes);
    const request = session.beginSave();
    expect(request).not.toBeNull();
    if (request === null) {
      return;
    }
    expect(request.changeSet).toHaveLength(1);
    expect(
      decoder.decode(applyByteChangeSet(original, request.changeSet)),
    ).toBe("\uFEFF- [~] café\r\nnext\n");
  });
});
