import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DurableEditHistory,
  type EditHistoryAction,
  type EditHistoryEntry,
  type EditHistorySnapshot,
  editHistoryStateCheck,
} from "../../src/lib/editor/durableHistory";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
});

async function replaceEntry(
  beforeText: string,
  afterText: string,
  beforeSelection = 0,
  afterSelection = afterText.length,
): Promise<EditHistoryEntry> {
  return {
    changes: [{ from: 0, to: beforeText.length, insert: afterText }],
    inverse: [{ from: 0, to: afterText.length, insert: beforeText }],
    selection_before: {
      ranges: [{ anchor: beforeSelection, head: beforeSelection }],
      main: 0,
    },
    selection_after: {
      ranges: [{ anchor: afterSelection, head: afterSelection }],
      main: 0,
    },
    before: await editHistoryStateCheck(beforeText),
    after: await editHistoryStateCheck(afterText),
  };
}

function harness(snapshot: EditHistorySnapshot, text: string) {
  const appended: Array<{ batch: string; actions: EditHistoryAction[] }> = [];
  const fence = vi.fn(async () => undefined);
  const clear = vi.fn(async () => undefined);
  let history: DurableEditHistory;
  const view = new EditorView({
    state: EditorState.create({ doc: text }),
    dispatchTransactions: (transactions, target) => {
      target.update(transactions);
      for (const transaction of transactions) history.record(transaction);
    },
  });
  views.push(view);
  history = new DurableEditHistory({
    read: async () => snapshot,
    append: async (batch, actions) => {
      appended.push({ batch, actions });
    },
    fence,
    clear,
  });
  return { history, view, appended, fence, clear };
}

describe("durable edit history", () => {
  it("captures a transaction, its inverse, and both selections", async () => {
    const { history, view } = harness({ undo: [], redo: [] }, "alpha");
    view.dispatch({
      changes: { from: 5, insert: " beta" },
      selection: { anchor: 10 },
    });

    const batch = await history.beginFlush();
    expect(batch?.actions).toHaveLength(1);
    const action = batch?.actions[0];
    expect(action?.kind).toBe("entry");
    if (action?.kind !== "entry") throw new Error("entry action missing");
    expect(action.entry.changes).toEqual([{ from: 5, to: 5, insert: " beta" }]);
    expect(action.entry.inverse).toEqual([{ from: 5, to: 10, insert: "" }]);
    expect(action.entry.selection_before.ranges[0]).toEqual({
      anchor: 0,
      head: 0,
    });
    expect(action.entry.selection_after.ranges[0]).toEqual({
      anchor: 10,
      head: 10,
    });
  });

  it("defers large-document serialization and hashing until persistence", async () => {
    const document = "x".repeat(1_000_000);
    const state = EditorState.create({ doc: document });
    const transaction = state.update({
      changes: { from: document.length, insert: "!" },
    });
    const beforeToString = vi.spyOn(transaction.startState.doc, "toString");
    const afterToString = vi.spyOn(transaction.newDoc, "toString");
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const history = new DurableEditHistory({
      read: async () => ({ undo: [], redo: [] }),
      append: async () => undefined,
      fence: async () => undefined,
      clear: async () => undefined,
    });

    history.record(transaction);

    expect(beforeToString).not.toHaveBeenCalled();
    expect(afterToString).not.toHaveBeenCalled();
    expect(digest).not.toHaveBeenCalled();

    await history.beginFlush();

    expect(beforeToString).toHaveBeenCalledOnce();
    expect(afterToString).toHaveBeenCalledOnce();
    expect(digest).toHaveBeenCalledTimes(2);
  });

  it("reconciles native history with an equivalent document value", async () => {
    const { history, view } = harness({ undo: [], redo: [] }, "alpha");
    view.dispatch({ changes: { from: 5, insert: " beta" } });
    view.dispatch({ changes: { from: 10, insert: " gamma" } });
    view.dispatch({
      changes: { from: 0, to: 16, insert: "alpha" },
      annotations: Transaction.userEvent.of("undo"),
    });

    expect(await history.depths()).toEqual({ undo: 0, redo: 2 });
    const batch = await history.beginFlush();
    expect(batch?.actions.map((action) => action.kind)).toEqual([
      "entry",
      "entry",
      "undo",
    ]);
    expect(batch?.actions.at(-1)).toEqual({ kind: "undo", count: 2 });
  });

  it("keeps edits typed during a history flush in the next batch", async () => {
    let releaseRead: ((snapshot: EditHistorySnapshot) => void) | undefined;
    const read = new Promise<EditHistorySnapshot>((resolve) => {
      releaseRead = resolve;
    });
    let history: DurableEditHistory;
    const view = new EditorView({
      state: EditorState.create({ doc: "alpha" }),
      dispatchTransactions: (transactions, target) => {
        target.update(transactions);
        for (const transaction of transactions) history.record(transaction);
      },
    });
    views.push(view);
    history = new DurableEditHistory({
      read: () => read,
      append: async () => undefined,
      fence: async () => undefined,
      clear: async () => undefined,
    });

    view.dispatch({ changes: { from: 5, insert: " one" } });
    const firstFlush = history.beginFlush();
    view.dispatch({ changes: { from: 9, insert: " two" } });
    releaseRead?.({ undo: [], redo: [] });

    const first = await firstFlush;
    expect(first?.actions).toHaveLength(1);
    if (first !== null) history.commitFlush(first);
    expect((await history.beginFlush())?.actions).toHaveLength(1);
  });

  it("does not discard a post-fence edit when an older flush commits", async () => {
    const { history, view } = harness({ undo: [], redo: [] }, "alpha");
    view.dispatch({ changes: { from: 5, insert: " one" } });
    const first = await history.beginFlush();
    if (first === null) throw new Error("first history batch missing");

    history.fence();
    view.dispatch({ changes: { from: 9, insert: " two" } });
    history.commitFlush(first);

    const next = await history.beginFlush();
    expect(next?.actions).toHaveLength(1);
    expect(next?.actions[0]?.kind).toBe("entry");
  });

  it("orders an external fence after an in-flight append", async () => {
    let releaseAppend: (() => void) | undefined;
    const appendStarted = Promise.withResolvers<void>();
    const appendFinished = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const fence = vi.fn(async () => undefined);
    let history: DurableEditHistory;
    const view = new EditorView({
      state: EditorState.create({ doc: "alpha" }),
      dispatchTransactions: (transactions, target) => {
        target.update(transactions);
        for (const transaction of transactions) history.record(transaction);
      },
    });
    views.push(view);
    history = new DurableEditHistory({
      read: async () => ({ undo: [], redo: [] }),
      append: async () => {
        appendStarted.resolve();
        await appendFinished;
      },
      fence,
      clear: async () => undefined,
    });
    view.dispatch({ changes: { from: 5, insert: " one" } });

    const flushing = history.flush();
    await appendStarted.promise;
    history.fence();
    expect(fence).not.toHaveBeenCalled();
    releaseAppend?.();
    await flushing;
    await history.depths();

    expect(fence).toHaveBeenCalledOnce();
  });

  it("reuses an ambiguous batch and then flushes newer saved edits", async () => {
    const calls: Array<{ batch: string; actions: EditHistoryAction[] }> = [];
    let attempt = 0;
    let history: DurableEditHistory;
    const view = new EditorView({
      state: EditorState.create({ doc: "alpha" }),
      dispatchTransactions: (transactions, target) => {
        target.update(transactions);
        for (const transaction of transactions) history.record(transaction);
      },
    });
    views.push(view);
    history = new DurableEditHistory({
      read: async () => ({ undo: [], redo: [] }),
      append: async (batch, actions) => {
        calls.push({ batch, actions });
        attempt += 1;
        if (attempt === 1) throw new Error("ambiguous response");
      },
      fence: async () => undefined,
      clear: async () => undefined,
    });

    view.dispatch({ changes: { from: 5, insert: " one" } });
    await expect(history.flush()).rejects.toThrow("ambiguous response");
    view.dispatch({ changes: { from: 9, insert: " two" } });
    await history.flush();

    expect(calls).toHaveLength(3);
    expect(calls[1]?.batch).toBe(calls[0]?.batch);
    expect(calls[2]?.batch).not.toBe(calls[0]?.batch);
    expect(calls.map((call) => call.actions.length)).toEqual([1, 1, 1]);
    expect(await history.beginFlush()).toBeNull();
  });

  it("applies a persisted inverse and restores its recorded selection", async () => {
    const entry = await replaceEntry("alpha", "alpha beta", 2, 10);
    const { history, view } = harness(
      { undo: [entry], redo: [] },
      "alpha beta",
    );

    history.undo(view);
    expect(await history.depths()).toEqual({ undo: 0, redo: 1 });
    expect(view.state.doc.toString()).toBe("alpha");
    expect(view.state.selection.main.anchor).toBe(2);

    history.redo(view);
    expect(await history.depths()).toEqual({ undo: 1, redo: 0 });
    expect(view.state.doc.toString()).toBe("alpha beta");
    expect(view.state.selection.main.anchor).toBe(10);
  });

  it("fences quietly instead of applying an inverse on state mismatch", async () => {
    const entry = await replaceEntry("alpha", "alpha beta");
    const { history, view, fence } = harness(
      { undo: [entry], redo: [] },
      "external alpha beta",
    );

    history.undo(view);
    expect(await history.depths()).toEqual({ undo: 0, redo: 0 });
    expect(view.state.doc.toString()).toBe("external alpha beta");
    expect(fence).toHaveBeenCalledOnce();
  });

  it("external ingest fencing drops loaded and pending history", async () => {
    const loaded = await replaceEntry("alpha", "alpha beta");
    const { history, view, fence } = harness(
      { undo: [loaded], redo: [] },
      "alpha beta",
    );
    view.dispatch({ changes: { from: 10, insert: " gamma" } });
    history.fence();

    expect(await history.depths()).toEqual({ undo: 0, redo: 0 });
    expect(await history.beginFlush()).toBeNull();
    expect(fence).toHaveBeenCalledOnce();
  });

  it("clear removes the journal and leaves no reachable persisted step", async () => {
    const loaded = await replaceEntry("alpha", "alpha beta");
    const { history, clear } = harness(
      { undo: [loaded], redo: [] },
      "alpha beta",
    );

    await history.clear();
    expect(clear).toHaveBeenCalledOnce();
    expect(await history.depths()).toEqual({ undo: 0, redo: 0 });
  });
});
