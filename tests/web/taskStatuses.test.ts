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
  it("registers one named palette command per configured status", () => {
    const registry = createAppRegistry(CUSTOM_STATUSES);
    const commands = registry
      .paletteCommands()
      .filter((command) => command.id.startsWith("task.status."));
    expect(commands.map((command) => command.title)).toEqual([
      "Set task status: Finished",
      "Set task status: Paused",
      "Set task status: Ready",
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
