// Component-level evidence for the tab-switch and note-arrival motion
// contract (section 5.1 of the design specification): switching between
// already open tabs never rebuilds the editor, so the outgoing tab's DOM
// node, undo history, caret and scroll survive the round trip exactly; a
// fresh open (a wikilink follow, a tree activation) still starts clean even
// when the target path happens to be cached; and the very first note a
// freshly opened vault loads reuses the same CodeMirror view rather than
// mounting a second one alongside the placeholder it replaces.

import { redo, undo } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import Editor from "../../src/lib/Editor.svelte";
import type { LoadedNote } from "../../src/lib/ipc/vault";
import { reactiveState } from "./support/reactiveState.svelte";

const encoder = new TextEncoder();

function loadedNote(text: string, hash: string): LoadedNote {
  return {
    meta: {
      encoding: "utf8",
      projection_hash: hash,
      byte_length: encoder.encode(text).length,
    },
    bytes: encoder.encode(text),
    text,
    readOnly: false,
  };
}

type EditorExports = {
  getView: () => EditorView | undefined;
  preparePaneSwitch: (kind: "note" | "history" | "tab") => void;
  forgetTab: (path: string) => void;
};

const mounted: EditorExports[] = [];

function mountEditor(initial: {
  note: LoadedNote | null;
  path: string | null;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const props = reactiveState<{
    note: LoadedNote | null;
    path: string | null;
  }>(initial);
  const component = mount(Editor, {
    target: host,
    props,
  }) as unknown as EditorExports;
  mounted.push(component);
  flushSync();
  return { host, props, component };
}

afterEach(async () => {
  for (const component of mounted.splice(0)) {
    await unmount(component);
  }
  document.body.textContent = "";
});

describe("tab-strip switching preserves live editor state", () => {
  it("keeps the same view, undo history, caret and scroll across a tab switch", () => {
    const noteA = loadedNote("alpha document\nsecond line\n", "hash-a");
    const noteB = loadedNote("bravo document\n", "hash-b");
    const { props, component } = mountEditor({ note: noteA, path: "a.md" });

    const view = component.getView();
    expect(view).toBeDefined();
    if (view === undefined) throw new Error("view did not mount");
    const editorDom = view.dom;

    // An unsaved edit and a moved caret and scroll position: exactly the
    // per-tab facts section 5.1 requires switching tabs to preserve.
    view.dispatch({
      changes: { from: 0, insert: "EDITED " },
      selection: { anchor: 7 },
    });
    expect(view.state.doc.toString()).toBe(
      "EDITED alpha document\nsecond line\n",
    );
    view.scrollDOM.scrollTop = 42;

    // Switch to a different, already open tab. App.svelte always flushes
    // pending edits to disk before a switch, so the note this tab reads on
    // return reflects the edit already made.
    component.preparePaneSwitch("tab");
    props.note = noteB;
    props.path = "b.md";
    flushSync();
    expect(component.getView()?.state.doc.toString()).toBe(noteB.text);

    // Switch back: the live cache should restore the exact prior state
    // rather than rebuilding a fresh one from the flushed disk text.
    const noteAAfterFlush = loadedNote(
      "EDITED alpha document\nsecond line\n",
      "hash-a-2",
    );
    component.preparePaneSwitch("tab");
    props.note = noteAAfterFlush;
    props.path = "a.md";
    flushSync();

    const restored = component.getView();
    expect(restored).toBe(view); // same EditorView: never destroyed
    expect(restored?.dom).toBe(editorDom); // same DOM node: never remounted
    expect(restored?.state.doc.toString()).toBe(
      "EDITED alpha document\nsecond line\n",
    );
    expect(restored?.state.selection.main.head).toBe(7);
    expect(restored?.scrollDOM.scrollTop).toBe(42);

    // The undo entry made before switching away survived the round trip.
    expect(restored !== undefined && undo(restored)).toBe(true);
    expect(restored?.state.doc.toString()).toBe(noteA.text);
    expect(restored !== undefined && redo(restored)).toBe(true);
  });

  it("does not reuse the tab cache for a fresh open of the same path", () => {
    const noteA = loadedNote("alpha document\n", "hash-a");
    const noteB = loadedNote("bravo document\n", "hash-b");
    const { props, component } = mountEditor({ note: noteA, path: "a.md" });

    const view = component.getView();
    if (view === undefined) throw new Error("view did not mount");
    view.dispatch({ selection: { anchor: 5 } });
    view.scrollDOM.scrollTop = 30;

    component.preparePaneSwitch("tab");
    props.note = noteB;
    props.path = "b.md";
    flushSync();

    // A fresh open (a wikilink follow, not a tab activation) back to "a.md"
    // starts clean per section 6.4 even though a live snapshot for it
    // exists: caret at the document start, scrolled to the top.
    component.preparePaneSwitch("note");
    props.note = noteA;
    props.path = "a.md";
    flushSync();

    const opened = component.getView();
    expect(opened?.state.doc.toString()).toBe(noteA.text);
    expect(opened?.state.selection.main.head).toBe(0);
    expect(opened?.scrollDOM.scrollTop).toBe(0);
  });

  it("discards a closed tab's cache so it cannot be resurrected stale", () => {
    const noteA = loadedNote("alpha document\n", "hash-a");
    const noteB = loadedNote("bravo document\n", "hash-b");
    const { props, component } = mountEditor({ note: noteA, path: "a.md" });

    const view = component.getView();
    if (view === undefined) throw new Error("view did not mount");
    view.dispatch({ selection: { anchor: 5 } });
    view.scrollDOM.scrollTop = 30;

    component.preparePaneSwitch("tab");
    props.note = noteB;
    props.path = "b.md";
    flushSync();

    component.forgetTab("a.md");

    component.preparePaneSwitch("tab");
    props.note = noteA;
    props.path = "a.md";
    flushSync();

    // The forgotten tab rebuilds clean instead of restoring the stale
    // caret and scroll a live cache hit would have supplied.
    const reopened = component.getView();
    expect(reopened?.state.selection.main.head).toBe(0);
    expect(reopened?.scrollDOM.scrollTop).toBe(0);
  });

  it("keeps the properties panel mounted across a tab switch but not a fresh open", () => {
    const noteA = loadedNote("---\ntitle: Alpha\n---\nbody a\n", "hash-a");
    const noteB = loadedNote("---\ntitle: Bravo\n---\nbody b\n", "hash-b");
    const { host, props, component } = mountEditor({
      note: noteA,
      path: "a.md",
    });

    expect(host.querySelector(".skr-properties")).not.toBeNull();

    // Switching to note B is a cache miss (never open before) and
    // legitimately composes a fresh arrival frame, including a fresh
    // properties panel for B's own frontmatter.
    component.preparePaneSwitch("tab");
    props.note = noteB;
    props.path = "b.md";
    flushSync();
    const panelForB = host.querySelector(".skr-properties");
    expect(panelForB).not.toBeNull();

    // Switching back to A is a cache hit: the panel already mounted for B
    // is reused in place, its content updated reactively, not rebuilt.
    component.preparePaneSwitch("tab");
    props.note = noteA;
    props.path = "a.md";
    flushSync();
    expect(host.querySelector(".skr-properties")).toBe(panelForB);

    component.preparePaneSwitch("note");
    props.note = noteB;
    props.path = "b.md";
    flushSync();
    const panelForFreshB = host.querySelector(".skr-properties");
    component.preparePaneSwitch("note");
    props.note = noteA;
    props.path = "a.md";
    flushSync();

    // A fresh open composes its arrival frame from scratch (section 6.4),
    // which for the properties panel means a new mount.
    expect(host.querySelector(".skr-properties")).not.toBe(panelForFreshB);
  });
});

describe("first note arrival reuses the mounted view", () => {
  it("does not mount a second CodeMirror instance when a note loads after startup", () => {
    const { host, props, component } = mountEditor({ note: null, path: null });

    const placeholderView = component.getView();
    expect(placeholderView).toBeDefined();
    const placeholderDom = placeholderView?.dom;

    const noteA = loadedNote("first real note\n", "hash-a");
    component.preparePaneSwitch("note");
    props.note = noteA;
    props.path = "a.md";
    flushSync();

    const loadedView = component.getView();
    expect(loadedView).toBe(placeholderView);
    expect(loadedView?.dom).toBe(placeholderDom);
    expect(loadedView?.state.doc.toString()).toBe(noteA.text);
    // Exactly one `.cm-editor` root exists: the placeholder was never left
    // behind as an orphaned second instance.
    expect(host.querySelectorAll(".cm-editor").length).toBe(1);
  });
});
