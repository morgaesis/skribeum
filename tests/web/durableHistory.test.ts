import { EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DurableEditHistory,
  type DurableHistoryLimits,
  type EditHistoryAction,
  type EditHistoryEntry,
  type EditHistorySnapshot,
  type EditHistoryTransport,
  editHistoryStateCheck,
} from "../../src/lib/editor/durableHistory";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  vi.restoreAllMocks();
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

function harness(
  snapshot: EditHistorySnapshot,
  text: string,
  transportOverrides: Partial<EditHistoryTransport> = {},
  limits?: DurableHistoryLimits,
) {
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
  history = new DurableEditHistory(
    {
      read: async () => snapshot,
      append: async (batch, actions) => {
        appended.push({ batch, actions });
      },
      fence,
      clear,
      ...transportOverrides,
    },
    limits,
  );
  return { history, view, appended, fence, clear };
}

function controlDigests() {
  const originalDigest = globalThis.crypto.subtle.digest.bind(
    globalThis.crypto.subtle,
  );
  const releases: Array<() => void> = [];
  vi.spyOn(globalThis.crypto.subtle, "digest").mockImplementation(
    (algorithm, data) =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        releases.push(() => {
          void originalDigest(algorithm, data).then(resolve, reject);
        });
      }),
  );
  return releases;
}

async function releaseDigests(
  releases: Array<() => void>,
  expected: number,
): Promise<void> {
  await vi.waitFor(() => expect(releases).toHaveLength(expected));
  for (const release of releases.splice(0)) release();
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

  it("bounds blocked initialization, fences its discarded prefix, and preserves its frontier", async () => {
    const read = Promise.withResolvers<EditHistorySnapshot>();
    const calls: string[] = [];
    const appended: EditHistoryAction[][] = [];
    const persisted = await replaceEntry("before", "seed");
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const { history, view } = harness(
      { undo: [], redo: [] },
      "seed",
      {
        read: () => read.promise,
        append: async (_batch, actions) => {
          calls.push("append");
          appended.push(actions);
        },
        fence: async () => {
          calls.push("fence");
        },
      },
      { entryCap: 4, byteCap: 8_000 },
    );

    for (let index = 0; index < 2_048; index += 1) {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "x" },
        userEvent: "input.type",
      });
      const retention = await history.retention();
      expect(retention.entries).toBeLessThanOrEqual(4);
      expect(retention.serializedBytes).toBeLessThanOrEqual(8_000);
    }
    expect(digest).not.toHaveBeenCalled();

    const finalText = view.state.doc.toString();
    read.resolve({ undo: [persisted], redo: [] });
    await vi.waitFor(() => expect(calls).toEqual(["fence", "append"]));

    const frontier = appended[0]?.[0];
    if (frontier?.kind !== "entry") {
      throw new Error("pre-initialization frontier entry missing");
    }
    expect(appended[0]).toHaveLength(1);

    const recovered = harness({ undo: [frontier.entry], redo: [] }, finalText);
    recovered.history.undo(recovered.view);
    await recovered.history.depths();
    expect(recovered.view.state.doc.toString()).not.toBe(finalText);
    recovered.history.redo(recovered.view);
    await recovered.history.depths();
    expect(recovered.view.state.doc.toString()).toBe(finalText);
  });

  it("orders reset, clear, and fence after blocked initialization", async () => {
    const read = Promise.withResolvers<EditHistorySnapshot>();
    const calls: string[] = [];
    const persisted = await replaceEntry("before", "seed");
    const { history, view } = harness({ undo: [], redo: [] }, "seed", {
      read: () => read.promise,
      fence: async () => {
        calls.push("fence");
      },
      clear: async () => {
        calls.push("clear");
      },
    });

    view.dispatch({
      changes: { from: 0, to: 4, insert: "external" },
      annotations: Transaction.userEvent.of("undo"),
    });
    const clearing = history.clear();
    history.fence();

    read.resolve({ undo: [persisted], redo: [] });
    await clearing;
    await history.depths();

    expect(calls).toEqual(["fence", "clear", "fence"]);
    expect(await history.retention()).toEqual({
      entries: 0,
      serializedBytes: 0,
      retainedDocumentChars: 0,
    });
    expect(await history.beginFlush()).toBeNull();
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

  it("does not publish a pre-fence batch after preparation completes", async () => {
    const releases = controlDigests();
    const calls: string[] = [];
    const { history, view, appended } = harness(
      { undo: [], redo: [] },
      "alpha",
      {
        append: async (batch, actions) => {
          calls.push("append");
          appended.push({ batch, actions });
        },
        fence: async () => {
          calls.push("fence");
        },
      },
    );
    view.dispatch({ changes: { from: 5, insert: " old" } });

    const preparing = history.beginFlush();
    await releaseDigests(releases, 2);
    history.fence();
    view.dispatch({ changes: { from: 9, insert: " new" } });

    await expect(preparing).resolves.toBeNull();
    const flushing = history.flush();
    await releaseDigests(releases, 2);
    await flushing;

    expect(calls).toEqual(["fence", "append"]);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.actions).toMatchObject([
      { kind: "entry", entry: { changes: [{ insert: " new" }] } },
    ]);
    expect(await history.beginFlush()).toBeNull();
  });

  it("does not publish a pre-clear batch after preparation completes", async () => {
    const releases = controlDigests();
    const calls: string[] = [];
    const { history, view, appended } = harness(
      { undo: [], redo: [] },
      "alpha",
      {
        append: async (batch, actions) => {
          calls.push("append");
          appended.push({ batch, actions });
        },
        clear: async () => {
          calls.push("clear");
        },
      },
    );
    view.dispatch({ changes: { from: 5, insert: " old" } });

    const preparing = history.beginFlush();
    await releaseDigests(releases, 2);
    await history.clear();
    view.dispatch({ changes: { from: 9, insert: " new" } });

    await expect(preparing).resolves.toBeNull();
    const flushing = history.flush();
    await releaseDigests(releases, 2);
    await flushing;

    expect(calls).toEqual(["clear", "append"]);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.actions).toMatchObject([
      { kind: "entry", entry: { changes: [{ insert: " new" }] } },
    ]);
    expect(await history.beginFlush()).toBeNull();
  });

  it("invalidates preparation when clear starts before the batch publishes", async () => {
    const releases = controlDigests();
    const clearStarted = Promise.withResolvers<void>();
    const clearFinished = Promise.withResolvers<void>();
    const { history, view, appended } = harness(
      { undo: [], redo: [] },
      "alpha",
      {
        clear: async () => {
          clearStarted.resolve();
          await clearFinished.promise;
        },
      },
    );
    view.dispatch({ changes: { from: 5, insert: " old" } });

    const preparing = history.beginFlush();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    const clearing = history.clear();
    await clearStarted.promise;
    for (const release of releases.splice(0)) release();
    await expect(preparing).resolves.toBeNull();
    expect(appended).toHaveLength(0);

    clearFinished.resolve();
    await clearing;
  });

  it("does not append a published retry batch once clear has started", async () => {
    const clearStarted = Promise.withResolvers<void>();
    const clearFinished = Promise.withResolvers<void>();
    const { history, view, appended } = harness(
      { undo: [], redo: [] },
      "alpha",
      {
        clear: async () => {
          clearStarted.resolve();
          await clearFinished.promise;
        },
      },
    );
    view.dispatch({ changes: { from: 5, insert: " old" } });
    expect(await history.beginFlush()).not.toBeNull();

    const clearing = history.clear();
    await clearStarted.promise;
    const flushing = history.flush();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(appended).toHaveLength(0);

    clearFinished.resolve();
    await clearing;
    await flushing;
  });

  it("orders an external fence after an active clear", async () => {
    const calls: string[] = [];
    const clearStarted = Promise.withResolvers<void>();
    const clearFinished = Promise.withResolvers<void>();
    const { history, fence } = harness({ undo: [], redo: [] }, "alpha", {
      clear: async () => {
        calls.push("clear");
        clearStarted.resolve();
        await clearFinished.promise;
      },
      fence: async () => {
        calls.push("fence");
      },
    });

    const clearing = history.clear();
    await clearStarted.promise;
    history.fence();
    expect(fence).not.toHaveBeenCalled();

    clearFinished.resolve();
    await clearing;
    await history.depths();
    expect(calls).toEqual(["clear", "fence"]);
  });

  it("does not publish a pre-reset batch after preparation completes", async () => {
    const releases = controlDigests();
    const calls: string[] = [];
    const { history, view, appended } = harness(
      { undo: [], redo: [] },
      "alpha",
      {
        append: async (batch, actions) => {
          calls.push("append");
          appended.push({ batch, actions });
        },
        fence: async () => {
          calls.push("fence");
        },
      },
    );
    view.dispatch({ changes: { from: 5, insert: " old" } });

    const preparing = history.beginFlush();
    await releaseDigests(releases, 2);
    view.dispatch({
      changes: { from: 0, to: 9, insert: "external" },
      annotations: Transaction.userEvent.of("undo"),
    });
    view.dispatch({ changes: { from: 8, insert: " new" } });

    await expect(preparing).resolves.toBeNull();
    const flushing = history.flush();
    await releaseDigests(releases, 2);
    await flushing;

    expect(calls).toEqual(["fence", "append"]);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.actions).toMatchObject([
      { kind: "entry", entry: { changes: [{ insert: " new" }] } },
    ]);
    expect(await history.beginFlush()).toBeNull();
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

  it("coalesces a long retry batch at one durable frontier", async () => {
    const releases: Array<() => void> = [];
    let activeDigests = 0;
    let peakDigests = 0;
    const originalDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    const digest = vi
      .spyOn(globalThis.crypto.subtle, "digest")
      .mockImplementation((algorithm, data) => {
        activeDigests += 1;
        peakDigests = Math.max(peakDigests, activeDigests);
        return new Promise<ArrayBuffer>((resolve) => {
          releases.push(() => {
            activeDigests -= 1;
            void originalDigest(algorithm, data).then(resolve);
          });
        });
      });
    const calls: Array<{ batch: string; actions: EditHistoryAction[] }> = [];
    let attempts = 0;
    const { history, view } = harness({ undo: [], redo: [] }, "", {
      append: async (batch, actions) => {
        calls.push({ batch, actions });
        attempts += 1;
        if (attempts === 1) throw new Error("ambiguous response");
      },
      fence: async () => undefined,
      clear: async () => undefined,
    });

    for (let index = 0; index < 64; index += 1) {
      view.dispatch({ changes: { from: index, insert: String(index % 10) } });
    }
    expect(digest).not.toHaveBeenCalled();

    const preparing = history.beginFlush();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(peakDigests).toBeLessThanOrEqual(2);

    for (const release of releases.splice(0)) release();

    const batch = await preparing;
    expect(batch?.actions).toHaveLength(1);
    expect(batch?.actions[0]).toMatchObject({
      kind: "entry",
      entry: {
        changes: [
          {
            insert:
              "0123456789012345678901234567890123456789012345678901234567890123",
          },
        ],
      },
    });
    expect(digest).toHaveBeenCalledTimes(2);

    const compacted = batch?.actions[0];
    if (compacted?.kind !== "entry") {
      throw new Error("compacted history entry missing");
    }
    const recovered = harness(
      { undo: [compacted.entry], redo: [] },
      "0123456789012345678901234567890123456789012345678901234567890123",
    );
    vi.restoreAllMocks();
    recovered.history.undo(recovered.view);
    await recovered.history.depths();
    expect(recovered.view.state.doc.toString()).toBe("");
    recovered.history.redo(recovered.view);
    await recovered.history.depths();
    expect(recovered.view.state.doc.toString()).toBe(
      "0123456789012345678901234567890123456789012345678901234567890123",
    );

    await expect(history.flush()).rejects.toThrow("ambiguous response");
    await history.flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]?.batch).toBe(calls[0]?.batch);
    expect(calls[1]?.actions).toEqual(calls[0]?.actions);

    history.undo(view);
    await history.depths();
    expect(view.state.doc.toString()).toHaveLength(63);
  });

  it("maps a compacted typing group through native undo and redo", async () => {
    const { history, view } = harness({ undo: [], redo: [] }, "");
    const source =
      "0123456789012345678901234567890123456789012345678901234567890123";
    for (const character of source) {
      const head = view.state.doc.length;
      view.dispatch({ changes: { from: head, insert: character } });
    }
    const entryBatch = await history.beginFlush();
    if (entryBatch === null) throw new Error("compacted entry batch missing");
    history.commitFlush(entryBatch);

    view.dispatch({
      changes: { from: 0, to: source.length, insert: "" },
      annotations: Transaction.userEvent.of("undo"),
    });
    const undoBatch = await history.beginFlush();
    expect(undoBatch?.actions).toEqual([{ kind: "undo", count: 1 }]);
    if (undoBatch === null) throw new Error("compacted undo batch missing");
    history.commitFlush(undoBatch);

    view.dispatch({
      changes: { from: 0, insert: source },
      annotations: Transaction.userEvent.of("redo"),
    });
    const redoBatch = await history.beginFlush();
    expect(redoBatch?.actions).toEqual([{ kind: "redo", count: 1 }]);
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

  it("bounds a long large-note session and replays its surviving durable steps", async () => {
    const source = "x".repeat(256_000);
    const { history, view, appended } = harness(
      { undo: [], redo: [] },
      source,
      {},
      { entryCap: 3, byteCap: 1_024 * 1_024 },
    );

    for (let index = 0; index < 8; index += 1) {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: String(index) },
        userEvent: "input.type",
      });
      await history.flush();
    }

    expect(await history.depths()).toEqual({ undo: 3, redo: 0 });
    expect(await history.retention()).toEqual({
      entries: 3,
      serializedBytes: expect.any(Number),
      retainedDocumentChars: 2 * source.length + 15,
    });
    expect(appended).toHaveLength(8);

    for (let index = 0; index < 3; index += 1) {
      history.undo(view);
      await history.depths();
    }
    expect(view.state.doc.toString()).toBe(`${source}01234`);
    for (let index = 0; index < 3; index += 1) {
      history.redo(view);
      await history.depths();
    }
    expect(view.state.doc.toString()).toBe(`${source}01234567`);
  });

  it("bounds continuous large input before a blocked transport can flush it", async () => {
    const appendStarted = Promise.withResolvers<void>();
    const releaseAppend = Promise.withResolvers<void>();
    const appended: EditHistoryAction[][] = [];
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const source = "x".repeat(128_000);
    const { history, view, fence } = harness(
      { undo: [], redo: [] },
      source,
      {
        append: async (_batch, actions) => {
          appendStarted.resolve();
          await releaseAppend.promise;
          appended.push(actions);
        },
      },
      { entryCap: 4, byteCap: 40_000 },
    );

    for (let index = 0; index < 2_048; index += 1) {
      const beforeRecord = digest.mock.calls.length;
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "y".repeat(2_048) },
        userEvent: "input.type",
      });
      expect(digest).toHaveBeenCalledTimes(beforeRecord);
      const retention = await history.retention();
      expect(retention.entries).toBeLessThanOrEqual(4);
      expect(retention.serializedBytes).toBeLessThanOrEqual(40_000);
      expect(retention.retainedDocumentChars).toBeLessThanOrEqual(
        view.state.doc.length * 8,
      );
    }

    // Input never hashes the full document. One deferred preparation is
    // allowed to start, then the blocked append prevents work from fanning
    // out while more input continues to arrive.
    await appendStarted.promise;
    expect(digest).toHaveBeenCalledTimes(2);
    expect(fence).toHaveBeenCalledOnce();

    const afterInput = view.state.doc.toString();
    releaseAppend.resolve();
    await history.depths();
    expect(appended.length).toBeGreaterThanOrEqual(1);
    expect(appended.at(-1)?.map((action) => action.kind)).toEqual(["entry"]);

    const action = appended.at(-1)?.[0];
    if (action?.kind !== "entry") {
      throw new Error("pressure frontier entry missing");
    }
    const recovered = harness({ undo: [action.entry], redo: [] }, afterInput);
    recovered.history.undo(recovered.view);
    await recovered.history.depths();
    expect(recovered.view.state.doc.toString()).not.toBe(afterInput);
    recovered.history.redo(recovered.view);
    await recovered.history.depths();
    expect(recovered.view.state.doc.toString()).toBe(afterInput);
  });

  it("keeps clear and reset ordered while a pressure fence waits behind a write", async () => {
    const appendStarted = Promise.withResolvers<void>();
    const releaseAppend = Promise.withResolvers<void>();
    const calls: string[] = [];
    const { history, view } = harness(
      { undo: [], redo: [] },
      "start",
      {
        append: async () => {
          calls.push("append");
          appendStarted.resolve();
          await releaseAppend.promise;
        },
        fence: async () => {
          calls.push("fence");
        },
        clear: async () => {
          calls.push("clear");
        },
      },
      { entryCap: 1, byteCap: 100_000 },
    );

    view.dispatch({ changes: { from: 5, insert: " one" } });
    view.dispatch({ changes: { from: 9, insert: " two" } });
    await appendStarted.promise;

    const clearing = history.clear();
    history.fence();
    releaseAppend.resolve();
    await clearing;
    await history.depths();

    expect(calls).toEqual(["fence", "append", "clear", "fence"]);
    expect(await history.retention()).toEqual({
      entries: 0,
      serializedBytes: 0,
      retainedDocumentChars: 0,
    });
  });
});
