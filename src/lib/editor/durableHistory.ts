import {
  Annotation,
  ChangeSet,
  EditorSelection,
  type SelectionRange,
  type Text,
  Transaction,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

export type EditHistoryChange = {
  from: number;
  to: number;
  insert: string;
};

export type EditHistorySelection = {
  ranges: Array<{ anchor: number; head: number }>;
  main: number;
};

export type EditHistoryStateCheck = {
  length: number;
  projection_hash: string;
};

export type EditHistoryEntry = {
  changes: EditHistoryChange[];
  inverse: EditHistoryChange[];
  selection_before: EditHistorySelection;
  selection_after: EditHistorySelection;
  before: EditHistoryStateCheck;
  after: EditHistoryStateCheck;
};

export type EditHistoryAction =
  | { kind: "entry"; entry: EditHistoryEntry }
  | { kind: "undo"; count: number }
  | { kind: "redo"; count: number }
  | { kind: "fence" };

export type EditHistorySnapshot = {
  undo: EditHistoryEntry[];
  redo: EditHistoryEntry[];
};

export type EditHistoryTransport = {
  read(): Promise<EditHistorySnapshot>;
  append(batch: string, actions: EditHistoryAction[]): Promise<void>;
  fence(batch: string): Promise<void>;
  clear(): Promise<void>;
};

type RuntimeEntry = {
  serialized?: EditHistoryEntry;
  serializing?: Promise<EditHistoryEntry>;
  beforeDoc?: Text;
  afterDoc?: Text;
  source?: {
    changes: ChangeSet;
    inverse: ChangeSet;
    selectionBefore: EditorSelection;
    selectionAfter: EditorSelection;
  };
};

type PendingAction =
  | { kind: "entry"; node: RuntimeEntry; sequence: number }
  | { kind: "undo"; count: number; sequence: number }
  | { kind: "redo"; count: number; sequence: number };

type QueuedOperation =
  | { kind: "entry"; node: RuntimeEntry; sequence: number }
  | { kind: "undo-to"; doc: Text; sequence: number }
  | { kind: "redo-to"; doc: Text; sequence: number };

export type EditHistoryBatch = {
  id: string;
  cutoff: number;
  actions: EditHistoryAction[];
};

/** Marks a transaction applied from the persisted journal. */
export const durableHistoryReplay = Annotation.define<"undo" | "redo">();

const encoder = new TextEncoder();
let fallbackBatchId = 0;

function batchId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackBatchId += 1;
  return `history-${Date.now()}-${fallbackBatchId}`;
}

/** SHA-256 state check over the normalized editor projection. */
export async function editHistoryStateCheck(
  text: string,
): Promise<EditHistoryStateCheck> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(text),
  );
  return {
    length: text.length,
    projection_hash: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}

function serializeChanges(changes: ChangeSet): EditHistoryChange[] {
  const serialized: EditHistoryChange[] = [];
  changes.iterChanges((from, to, _fromAfter, _toAfter, inserted) => {
    serialized.push({ from, to, insert: inserted.toString() });
  });
  return serialized;
}

function serializeSelection(selection: EditorSelection): EditHistorySelection {
  return {
    ranges: selection.ranges.map((range) => ({
      anchor: range.anchor,
      head: range.head,
    })),
    main: selection.mainIndex,
  };
}

function deserializeSelection(
  selection: EditHistorySelection,
  length: number,
): EditorSelection {
  if (
    selection.ranges.length === 0 ||
    selection.main < 0 ||
    selection.main >= selection.ranges.length
  ) {
    throw new Error("invalid persisted selection");
  }
  const ranges: SelectionRange[] = selection.ranges.map((range) => {
    if (
      range.anchor < 0 ||
      range.anchor > length ||
      range.head < 0 ||
      range.head > length
    ) {
      throw new Error("persisted selection is outside the document");
    }
    return EditorSelection.range(range.anchor, range.head);
  });
  return EditorSelection.create(ranges, selection.main);
}

function changeSet(
  changes: readonly EditHistoryChange[],
  length: number,
): ChangeSet {
  return ChangeSet.of(
    changes.map((change) => ({
      from: change.from,
      to: change.to,
      insert: change.insert,
    })),
    length,
  );
}

function checksEqual(
  left: EditHistoryStateCheck,
  right: EditHistoryStateCheck,
): boolean {
  return (
    left.length === right.length &&
    left.projection_hash === right.projection_hash
  );
}

function loadedNode(entry: EditHistoryEntry): RuntimeEntry {
  return { serialized: entry };
}

/**
 * Mirrors CodeMirror's current-session history into a persisted linear
 * journal. CodeMirror remains authoritative while its own undo or redo
 * command succeeds; this controller takes over only at that history edge.
 */
export class DurableEditHistory {
  private undoEntries: RuntimeEntry[] = [];
  private redoEntries: RuntimeEntry[] = [];
  private pending: PendingAction[] = [];
  private queued: QueuedOperation[] = [];
  private initialized = false;
  private discardLoaded = false;
  private nextSequence = 0;
  private retryBatch: EditHistoryBatch | null = null;
  private batchPreparation: Promise<EditHistoryBatch | null> | null = null;
  private operationChain: Promise<void> = Promise.resolve();
  private readonly readyPromise: Promise<void>;

  constructor(private readonly transport: EditHistoryTransport) {
    this.readyPromise = transport
      .read()
      .catch(() => ({ undo: [], redo: [] }))
      .then((snapshot) => {
        this.undoEntries = this.discardLoaded
          ? []
          : snapshot.undo.map(loadedNode);
        this.redoEntries = this.discardLoaded
          ? []
          : snapshot.redo.map(loadedNode);
        this.initialized = true;
        for (const operation of this.queued.splice(0)) {
          this.applyQueued(operation);
        }
      });
  }

  /** Records one document-changing transaction after CodeMirror applied it. */
  record(transaction: Transaction): void {
    if (transaction.changes.empty) return;
    this.nextSequence += 1;
    const sequence = this.nextSequence;
    const replay = transaction.annotation(durableHistoryReplay);
    if (replay === "undo") {
      this.applyReplayMovement("undo", sequence);
      return;
    }
    if (replay === "redo") {
      this.applyReplayMovement("redo", sequence);
      return;
    }
    if (transaction.isUserEvent("undo")) {
      this.enqueue({
        kind: "undo-to",
        doc: transaction.newDoc,
        sequence,
      });
      return;
    }
    if (transaction.isUserEvent("redo")) {
      this.enqueue({
        kind: "redo-to",
        doc: transaction.newDoc,
        sequence,
      });
      return;
    }

    const inverse = transaction.changes.invert(transaction.startState.doc);
    const node: RuntimeEntry = {
      beforeDoc: transaction.startState.doc,
      afterDoc: transaction.newDoc,
      source: {
        changes: transaction.changes,
        inverse,
        selectionBefore: transaction.startState.selection,
        selectionAfter: transaction.newSelection,
      },
    };
    this.enqueue({ kind: "entry", node, sequence });
  }

  /** Captures the actions that must become durable before the current save. */
  async beginFlush(
    cutoff = this.nextSequence,
  ): Promise<EditHistoryBatch | null> {
    await this.readyPromise;
    await this.operationChain;
    if (this.retryBatch !== null) return this.retryBatch;
    if (this.batchPreparation !== null) return this.batchPreparation;
    const preparation = this.prepareFlush(cutoff);
    this.batchPreparation = preparation;
    try {
      return await preparation;
    } finally {
      if (this.batchPreparation === preparation) this.batchPreparation = null;
    }
  }

  private async prepareFlush(cutoff: number): Promise<EditHistoryBatch | null> {
    const actions = this.pending.filter((action) => action.sequence <= cutoff);
    if (actions.length === 0) return null;
    const stateChecks = new Map<Text, Promise<EditHistoryStateCheck>>();
    const serializedActions: EditHistoryAction[] = [];
    for (const action of actions) {
      if (action.kind === "entry") {
        serializedActions.push({
          kind: "entry",
          entry: await this.serializeEntry(action.node, stateChecks),
        });
      } else {
        serializedActions.push({ kind: action.kind, count: action.count });
      }
    }
    const batch = {
      id: batchId(),
      cutoff,
      actions: serializedActions,
    };
    this.retryBatch = batch;
    return batch;
  }

  /** Drops a successfully fsynced prefix from the pending queue. */
  commitFlush(batch: EditHistoryBatch): void {
    this.pending = this.pending.filter(
      (action) => action.sequence > batch.cutoff,
    );
    if (this.retryBatch?.id === batch.id) this.retryBatch = null;
  }

  /** Persists the current action prefix in order with fences and replays. */
  async flush(): Promise<void> {
    const cutoff = this.nextSequence;
    for (;;) {
      const batch = await this.beginFlush(cutoff);
      if (batch === null) return;
      const write = this.operationChain.then(() =>
        this.transport.append(batch.id, batch.actions),
      );
      this.operationChain = write.catch(() => undefined);
      await write;
      this.commitFlush(batch);
    }
  }

  /** Applies the next persisted inverse after CodeMirror undo is exhausted. */
  undo(view: EditorView): void {
    this.enqueueReplay("undo", view);
  }

  /** Applies the next persisted forward change after CodeMirror redo is exhausted. */
  redo(view: EditorView): void {
    this.enqueueReplay("redo", view);
  }

  /** Fences all reachable history at a genuine external ingest. */
  fence(): void {
    this.resetReachable();
    const id = batchId();
    this.operationChain = this.operationChain
      .then(() => this.transport.fence(id))
      .catch(() => undefined);
  }

  /** Physically removes this note's persisted journal. */
  async clear(): Promise<void> {
    await this.readyPromise;
    await this.operationChain;
    await this.transport.clear();
    this.resetReachable();
  }

  /** Test and command-surface observation of the loaded stack depths. */
  async depths(): Promise<{ undo: number; redo: number }> {
    await this.readyPromise;
    await this.operationChain;
    return { undo: this.undoEntries.length, redo: this.redoEntries.length };
  }

  private enqueue(operation: QueuedOperation): void {
    if (!this.initialized) {
      this.queued.push(operation);
      return;
    }
    this.applyQueued(operation);
  }

  private applyQueued(operation: QueuedOperation): void {
    if (operation.kind === "entry") {
      this.redoEntries = [];
      this.undoEntries.push(operation.node);
      this.pending.push({
        kind: "entry",
        node: operation.node,
        sequence: operation.sequence,
      });
      return;
    }
    const source =
      operation.kind === "undo-to" ? this.undoEntries : this.redoEntries;
    const target =
      operation.kind === "undo-to" ? this.redoEntries : this.undoEntries;
    let count = 0;
    let matched = false;
    while (source.length > 0) {
      const node = source.at(-1);
      if (node === undefined) break;
      const expectedDoc =
        operation.kind === "undo-to" ? node.beforeDoc : node.afterDoc;
      if (expectedDoc === undefined) break;
      source.pop();
      target.push(node);
      count += 1;
      if (expectedDoc.eq(operation.doc)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      this.fence();
      return;
    }
    this.pending.push({
      kind: operation.kind === "undo-to" ? "undo" : "redo",
      count,
      sequence: operation.sequence,
    });
  }

  private enqueueReplay(direction: "undo" | "redo", view: EditorView): void {
    this.operationChain = this.operationChain
      .then(async () => {
        await this.readyPromise;
        const source =
          direction === "undo" ? this.undoEntries : this.redoEntries;
        const node = source.at(-1);
        if (node === undefined) return;
        const entry = await this.serializeEntry(node, new Map());
        const startingText = view.state.doc.toString();
        const expected = direction === "undo" ? entry.after : entry.before;
        const actual = await editHistoryStateCheck(startingText);
        if (view.state.doc.toString() !== startingText) return;
        if (!checksEqual(actual, expected)) {
          await this.fenceMismatch();
          return;
        }
        try {
          const changes = changeSet(
            direction === "undo" ? entry.inverse : entry.changes,
            startingText.length,
          );
          const nextLength = changes.newLength;
          const selection = deserializeSelection(
            direction === "undo"
              ? entry.selection_before
              : entry.selection_after,
            nextLength,
          );
          view.dispatch({
            changes,
            selection,
            annotations: [
              durableHistoryReplay.of(direction),
              Transaction.addToHistory.of(false),
            ],
          });
        } catch {
          await this.fenceMismatch();
        }
      })
      .catch(() => undefined);
  }

  private async fenceMismatch(): Promise<void> {
    this.resetReachable();
    await this.transport.fence(batchId()).catch(() => undefined);
  }

  private resetReachable(): void {
    this.discardLoaded = true;
    this.undoEntries = [];
    this.redoEntries = [];
    this.pending = [];
    this.queued = [];
    this.retryBatch = null;
  }

  private serializeEntry(
    node: RuntimeEntry,
    stateChecks: Map<Text, Promise<EditHistoryStateCheck>>,
  ): Promise<EditHistoryEntry> {
    if (node.serialized !== undefined) return Promise.resolve(node.serialized);
    if (node.serializing !== undefined) return node.serializing;
    const source = node.source;
    if (
      source === undefined ||
      node.beforeDoc === undefined ||
      node.afterDoc === undefined
    ) {
      return Promise.reject(new Error("history entry cannot be serialized"));
    }
    const check = (doc: Text): Promise<EditHistoryStateCheck> => {
      let pending = stateChecks.get(doc);
      if (pending === undefined) {
        pending = editHistoryStateCheck(doc.toString());
        stateChecks.set(doc, pending);
      }
      return pending;
    };
    const serializing = Promise.all([
      check(node.beforeDoc),
      check(node.afterDoc),
    ]).then(([before, after]) => {
      const entry = {
        changes: serializeChanges(source.changes),
        inverse: serializeChanges(source.inverse),
        selection_before: serializeSelection(source.selectionBefore),
        selection_after: serializeSelection(source.selectionAfter),
        before,
        after,
      };
      node.serialized = entry;
      delete node.source;
      return entry;
    });
    node.serializing = serializing;
    return serializing.finally(() => {
      if (node.serializing === serializing) delete node.serializing;
    });
  }

  private applyReplayMovement(
    direction: "undo" | "redo",
    sequence: number,
  ): void {
    const source = direction === "undo" ? this.undoEntries : this.redoEntries;
    const target = direction === "undo" ? this.redoEntries : this.undoEntries;
    const node = source.pop();
    if (node === undefined) {
      this.fence();
      return;
    }
    target.push(node);
    this.pending.push({ kind: direction, count: 1, sequence });
  }
}
