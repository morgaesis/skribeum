// Component-level evidence for the M1b cursor-and-undo criterion: cursor
// and selection map through external ingests at sampled positions, and
// undo after an ingest never reproduces a pre-ingest text that does not
// incorporate the ingest. The tests build a real EditorView, drive it the
// way Editor.svelte does (local transactions recorded into the session,
// session-produced changes dispatched with addToHistory: false, history
// cleared through the compartment swap at every ingest), and assert on the
// resulting documents, selections and histories.

import { history, redo, undo } from "@codemirror/commands";
import {
  ChangeSet,
  Compartment,
  EditorState,
  Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { ByteChange } from "../../src/lib/editor/byteChangeSet";
import { NoteSession } from "../../src/lib/editor/noteSession";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function byteChange(start: number, end: number, insert: string): ByteChange {
  return { start, end, bytes: encoder.encode(insert) };
}

/** Structural view of a byte change set for realm-independent equality. */
function asPlain(changes: readonly ByteChange[] | undefined) {
  return changes?.map((change) => ({
    start: change.start,
    end: change.end,
    bytes: Array.from(change.bytes),
  }));
}

const views: EditorView[] = [];
const historyCompartment = new Compartment();

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
});

/** Builds a view plus session the way the editor component wires them. */
function openNote(diskContent: string): {
  view: EditorView;
  session: NoteSession;
} {
  const session = new NoteSession(encoder.encode(diskContent), "hash-0");
  const view = new EditorView({
    state: EditorState.create({
      doc: session.base.text,
      extensions: [historyCompartment.of(history())],
    }),
  });
  views.push(view);
  return { view, session };
}

/** A local user edit: dispatched to the view and recorded in the session. */
function typeLocal(
  view: EditorView,
  session: NoteSession,
  from: number,
  to: number,
  insert: string,
) {
  const changes = view.state.changes({ from, to, insert });
  view.dispatch({ changes, selection: { anchor: from + insert.length } });
  session.recordLocalChanges(changes);
}

/** Session-produced changes: never undoable, history cleared at the ingest. */
function dispatchIngest(view: EditorView, changes: ChangeSet) {
  if (!changes.empty) {
    view.dispatch({
      changes,
      annotations: [Transaction.addToHistory.of(false)],
    });
    view.dispatch({ effects: historyCompartment.reconfigure([]) });
    view.dispatch({ effects: historyCompartment.reconfigure(history()) });
  }
}

describe("external ingest cursor mapping", () => {
  it("maps a cursor after the ingested change forward", () => {
    const { view, session } = openNote("alpha\nbeta\ngamma\n");
    view.dispatch({ selection: { anchor: 11 } }); // at "gamma"
    const changes = session.ingestDelta(
      [byteChange(0, 0, "X")],
      "hash-0",
      "hash-1",
    );
    dispatchIngest(view, changes);
    expect(view.state.doc.toString()).toBe("Xalpha\nbeta\ngamma\n");
    expect(view.state.selection.main.anchor).toBe(12);
  });

  it("keeps a cursor before the ingested change in place", () => {
    const { view, session } = openNote("alpha\nbeta\ngamma\n");
    view.dispatch({ selection: { anchor: 2 } });
    const changes = session.ingestDelta(
      [byteChange(6, 10, "BETA!")],
      "hash-0",
      "hash-1",
    );
    dispatchIngest(view, changes);
    expect(view.state.doc.toString()).toBe("alpha\nBETA!\ngamma\n");
    expect(view.state.selection.main.anchor).toBe(2);
  });

  it("maps a selection range across the ingest instead of resetting it", () => {
    const { view, session } = openNote("alpha\nbeta\ngamma\n");
    view.dispatch({ selection: { anchor: 11, head: 16 } }); // "gamma"
    const changes = session.ingestDelta(
      [byteChange(0, 5, "prologue")],
      "hash-0",
      "hash-1",
    );
    dispatchIngest(view, changes);
    expect(view.state.doc.toString()).toBe("prologue\nbeta\ngamma\n");
    expect(
      view.state.doc.sliceString(
        view.state.selection.main.from,
        view.state.selection.main.to,
      ),
    ).toBe("gamma");
  });

  it("rebases pending local edits over the ingest and saves the merge", () => {
    const { view, session } = openNote("one two three");
    typeLocal(view, session, 4, 7, "TWO");
    const changes = session.ingestDelta(
      [byteChange(8, 13, "3")],
      "hash-0",
      "hash-1",
    );
    dispatchIngest(view, changes);
    expect(view.state.doc.toString()).toBe("one TWO 3");
    expect(decoder.decode(session.base.bytes)).toBe("one two 3");
    const request = session.beginSave();
    expect(request).not.toBeNull();
    expect(request?.expectedProjectionHash).toBe("hash-1");
    session.commitSave("hash-2");
    expect(decoder.decode(session.base.bytes)).toBe("one TWO 3");
    expect(session.dirty).toBe(false);
  });
});

describe("undo across external ingests", () => {
  it("never resurrects a pre-ingest-only state", () => {
    const { view, session } = openNote("base line\n");
    typeLocal(view, session, 9, 9, " typed");
    expect(view.state.doc.toString()).toBe("base line typed\n");

    const changes = session.ingestDelta(
      [byteChange(0, 0, "external ")],
      "hash-0",
      "hash-1",
    );
    dispatchIngest(view, changes);
    expect(view.state.doc.toString()).toBe("external base line typed\n");

    // The pre-ingest undo step is dropped: undo is a no-op, so no state
    // lacking the ingested text can reappear.
    const documentBefore = view.state.doc.toString();
    undo(view);
    expect(view.state.doc.toString()).toBe(documentBefore);
    expect(view.state.doc.toString()).toContain("external ");
  });

  it("keeps post-ingest edits undoable exactly down to the ingest state", () => {
    const { view, session } = openNote("base line\n");
    const ingest = session.ingestDelta(
      [byteChange(0, 0, "external ")],
      "hash-0",
      "hash-1",
    );
    dispatchIngest(view, ingest);
    typeLocal(view, session, 0, 0, "after ");
    expect(view.state.doc.toString()).toBe("after external base line\n");

    undo(view);
    expect(view.state.doc.toString()).toBe("external base line\n");
    // Undo stops at the ingest state; it cannot cross it.
    undo(view);
    expect(view.state.doc.toString()).toBe("external base line\n");
    redo(view);
    expect(view.state.doc.toString()).toBe("after external base line\n");
  });

  it("rejects a structurally valid delta from an older base projection", () => {
    const { view, session } = openNote("fresh table bytes\n");
    const before = view.state.doc.toString();

    expect(() =>
      session.ingestDelta(
        [byteChange(0, 5, "stale")],
        "hash-from-older-read",
        "hash-stale-result",
      ),
    ).toThrow("external delta base does not match the open note");
    expect(view.state.doc.toString()).toBe(before);
    expect(session.base.text).toBe(before);
    expect(session.base.projectionHash).toBe("hash-0");
  });
});

describe("save conversion through the session", () => {
  it("converts a typed edit on a CRLF file into projection byte space", () => {
    const { view, session } = openNote("first\r\nsecond\r\nthird\r\n");
    expect(view.state.doc.toString()).toBe("first\nsecond\nthird\n");
    typeLocal(view, session, 12, 12, "!"); // end of "second"
    const request = session.beginSave();
    expect(request).not.toBeNull();
    expect(asPlain(request?.changeSet)).toEqual([
      { start: 13, end: 13, bytes: [0x21] },
    ]);
    session.commitSave("hash-1");
    expect(decoder.decode(session.base.bytes)).toBe(
      "first\r\nsecond!\r\nthird\r\n",
    );
    expect(session.base.projectionHash).toBe("hash-1");
  });

  it("converts positions after astral-plane characters into byte offsets", () => {
    const { view, session } = openNote("a\u{1F600}b\n");
    // Insert after the emoji: UTF-16 position 3, UTF-8 byte offset 5.
    typeLocal(view, session, 3, 3, "!");
    const request = session.beginSave();
    expect(asPlain(request?.changeSet)).toEqual([
      { start: 5, end: 5, bytes: [0x21] },
    ]);
    session.commitSave("hash-1");
    expect(decoder.decode(session.base.bytes)).toBe("a\u{1F600}!b\n");
    expect(view.state.doc.toString()).toBe("a\u{1F600}!b\n");
  });

  it("preserves a byte-order mark by offsetting every change past it", () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const content = encoder.encode("hi\n");
    const bytes = new Uint8Array([...bom, ...content]);
    const session = new NoteSession(bytes, "hash-0");
    expect(session.base.text).toBe("hi\n");
    session.recordLocalChanges(
      ChangeSet.of([{ from: 0, to: 0, insert: "X" }], 3),
    );
    const request = session.beginSave();
    expect(asPlain(request?.changeSet)).toEqual([
      { start: 3, end: 3, bytes: [0x58] },
    ]);
    session.commitSave("hash-1");
    expect(Array.from(session.base.bytes.subarray(0, 3))).toEqual([
      0xef, 0xbb, 0xbf,
    ]);
    expect(decoder.decode(session.base.bytes.subarray(3))).toBe("Xhi\n");
  });

  it("rolls a conflicted save back losslessly", () => {
    const { view, session } = openNote("alpha\n");
    typeLocal(view, session, 0, 0, "!");
    const request = session.beginSave();
    expect(request).not.toBeNull();
    expect(session.dirty).toBe(false);
    session.rollbackSave();
    expect(session.dirty).toBe(true);
    // The re-read after a conflict rebases the same pending edit onto the
    // disk content that won.
    const changes = session.reconcile(
      encoder.encode("alpha external\n"),
      "hash-disk",
    );
    dispatchIngest(view, changes);
    expect(view.state.doc.toString()).toBe("!alpha external\n");
    const retry = session.beginSave();
    expect(retry?.expectedProjectionHash).toBe("hash-disk");
  });
});

describe("journal recovery through the session", () => {
  it("applies a recovered delta as pending edits without moving the base", () => {
    const { view, session } = openNote("on disk\n");
    const changes = session.recoverDelta([byteChange(7, 7, " recovered")]);
    dispatchIngest(view, changes);
    expect(view.state.doc.toString()).toBe("on disk recovered\n");
    expect(decoder.decode(session.base.bytes)).toBe("on disk\n");
    expect(session.dirty).toBe(true);
    const request = session.beginSave();
    expect(request?.expectedProjectionHash).toBe("hash-0");
  });
});
