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

/**
 * The live controller mirrors the journal's per-note retention envelope.
 * Entries beyond either limit are removed oldest-first at record time,
 * leaving the newest undo or redo frontier available for recovery even while
 * the journal transport is unavailable.
 */
export type DurableHistoryLimits = {
  entryCap: number;
  byteCap: number;
};

/** Matches the native journal's 2,000-entry, 8 MiB retention policy. */
export const DEFAULT_DURABLE_HISTORY_LIMITS: DurableHistoryLimits = {
  entryCap: 2_000,
  byteCap: 8 * 1024 * 1024,
};

type RuntimeEntry = {
  serialized?: EditHistoryEntry;
  serializing?: Promise<EditHistoryEntry>;
  /** Conservative reservation for this entry before it is serialized. */
  reservedBytes: number;
  compactedRun?: CompactedEntryRun;
  beforeDoc?: Text;
  afterDoc?: Text;
  source?: {
    changes: ChangeSet;
    inverse: ChangeSet;
    selectionBefore: EditorSelection;
    selectionAfter: EditorSelection;
  };
};

type CompactedEntryRun = {
  nodes: RuntimeEntry[];
  serialized?: EditHistoryEntry;
};

type PendingAction =
  | { kind: "entry"; nodes: RuntimeEntry[]; sequence: number }
  | { kind: "undo"; count: number; sequence: number }
  | { kind: "redo"; count: number; sequence: number };

type QueuedOperation =
  | { kind: "entry"; node: RuntimeEntry; sequence: number }
  | { kind: "undo-to"; doc: Text; startDoc: Text; sequence: number }
  | { kind: "redo-to"; doc: Text; startDoc: Text; sequence: number };

export type EditHistoryBatch = {
  id: string;
  cutoff: number;
  actions: EditHistoryAction[];
};

type BatchPreparation = {
  generation: number;
  promise: Promise<EditHistoryBatch | null>;
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
  return { serialized: entry, reservedBytes: serializedEntryBytes(entry) };
}

/**
 * Bound JSON storage before persistence without materializing or hashing a
 * whole document. Six bytes per UTF-16 code unit covers JSON escaping; the
 * structural allowance covers coordinates, selections and record syntax.
 */
function sourceReservation(
  changes: ChangeSet,
  inverse: ChangeSet,
  selectionBefore: EditorSelection,
  selectionAfter: EditorSelection,
): number {
  let bytes = 512;
  const reserveChanges = (set: ChangeSet) => {
    set.iterChanges((from, to, _fromAfter, _toAfter, inserted) => {
      bytes +=
        192 + String(from).length + String(to).length + inserted.length * 6;
    });
  };
  reserveChanges(changes);
  reserveChanges(inverse);
  bytes += (selectionBefore.ranges.length + selectionAfter.ranges.length) * 96;
  return bytes;
}

function serializedEntryBytes(entry: EditHistoryEntry): number {
  return encoder.encode(JSON.stringify(entry)).length;
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
  private initialized = false;
  private preInitializationChanged = false;
  private discardLoaded = false;
  private preservePendingOnRead = false;
  private nextSequence = 0;
  private generation = 0;
  private retryBatch: EditHistoryBatch | null = null;
  private batchPreparation: BatchPreparation | null = null;
  private readonly batchGenerations = new WeakMap<EditHistoryBatch, number>();
  private operationChain: Promise<void> = Promise.resolve();
  private readonly readyPromise: Promise<void>;
  private pressureFenceQueued = false;
  private pressureFlushQueued = false;
  private pressureFlushRunning = false;
  private pressureFlushRequested = false;

  private readonly batchNodes = new WeakMap<EditHistoryBatch, RuntimeEntry[]>();

  constructor(
    private readonly transport: EditHistoryTransport,
    private readonly limits: DurableHistoryLimits = DEFAULT_DURABLE_HISTORY_LIMITS,
  ) {
    this.readyPromise = transport
      .read()
      .catch(() => ({ undo: [], redo: [] }))
      .then((snapshot) => {
        if (this.discardLoaded && !this.preservePendingOnRead) {
          this.undoEntries = [];
          this.redoEntries = [];
        } else {
          const loadedUndo = this.discardLoaded
            ? []
            : snapshot.undo.map(loadedNode);
          const loadedRedo = this.discardLoaded
            ? []
            : snapshot.redo.map(loadedNode);
          this.undoEntries = [...loadedUndo, ...this.undoEntries];
          this.redoEntries = this.preInitializationChanged
            ? [...loadedRedo, ...this.redoEntries]
            : loadedRedo;
        }
        const discarded = this.trimRetained();
        this.enforcePendingBounds(discarded);
        this.initialized = true;
        if (this.pressureFlushRequested) this.requestPressureFlush();
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
        startDoc: transaction.startState.doc,
        sequence,
      });
      return;
    }
    if (transaction.isUserEvent("redo")) {
      this.enqueue({
        kind: "redo-to",
        doc: transaction.newDoc,
        startDoc: transaction.startState.doc,
        sequence,
      });
      return;
    }

    const inverse = transaction.changes.invert(transaction.startState.doc);
    const node: RuntimeEntry = {
      reservedBytes: sourceReservation(
        transaction.changes,
        inverse,
        transaction.startState.selection,
        transaction.newSelection,
      ),
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
    const generation = this.generation;
    for (;;) {
      const active = this.batchPreparation;
      if (active !== null) {
        const batch = await active.promise;
        if (generation !== this.generation) return null;
        if (active.generation === generation) return batch;
        continue;
      }
      if (generation !== this.generation) return null;
      const preparation = this.prepareFlush(cutoff, generation);
      const next = { generation, promise: preparation };
      this.batchPreparation = next;
      try {
        const batch = await preparation;
        if (generation !== this.generation) return null;
        return batch;
      } finally {
        if (this.batchPreparation === next) this.batchPreparation = null;
      }
    }
  }

  private async prepareFlush(
    cutoff: number,
    generation: number,
  ): Promise<EditHistoryBatch | null> {
    const actions = this.pending.filter((action) => action.sequence <= cutoff);
    if (actions.length === 0) return null;
    const stateChecks = new Map<Text, Promise<EditHistoryStateCheck>>();
    const compactedNodes =
      actions.length > 1 &&
      actions.every(
        (action) =>
          action.kind === "entry" &&
          action.nodes.every((node) => node.source !== undefined),
      )
        ? actions.flatMap((action) =>
            action.kind === "entry" ? action.nodes : [],
          )
        : null;
    if (compactedNodes !== null) {
      const compactedRun = { nodes: compactedNodes };
      for (const node of compactedNodes) node.compactedRun = compactedRun;
    }
    const serializedActions = await this.serializeActions(
      actions,
      stateChecks,
      compactedNodes === null ? undefined : compactedNodes[0]?.compactedRun,
    );
    if (generation !== this.generation) return null;
    const batch = {
      id: batchId(),
      cutoff,
      actions: serializedActions,
    };
    this.batchGenerations.set(batch, generation);
    this.batchNodes.set(
      batch,
      actions.flatMap((action) =>
        action.kind === "entry" ? action.nodes : [],
      ),
    );
    this.retryBatch = batch;
    return batch;
  }

  /**
   * A flush containing only new entries is one durable frontier: its inverse
   * restores the batch start and its forward change restores the batch end.
   * Keep movement-bearing batches expanded because their action counts name
   * individual reachable entries in the journal.
   */
  private async serializeActions(
    actions: PendingAction[],
    stateChecks: Map<Text, Promise<EditHistoryStateCheck>>,
    compactedRun?: CompactedEntryRun,
  ): Promise<EditHistoryAction[]> {
    if (compactedRun !== undefined) {
      const nodes = actions.flatMap((action) =>
        action.kind === "entry" ? action.nodes : [],
      );
      const entry = await this.serializeEntryRun(nodes, stateChecks);
      if (compactedRun !== undefined) compactedRun.serialized = entry;
      return [
        {
          kind: "entry",
          entry,
        },
      ];
    }
    const serializedActions: EditHistoryAction[] = [];
    for (const action of actions) {
      if (action.kind === "entry") {
        serializedActions.push({
          kind: "entry",
          entry: await this.serializeEntryRun(action.nodes, stateChecks),
        });
      } else {
        serializedActions.push({ kind: action.kind, count: action.count });
      }
    }
    return serializedActions;
  }

  /** Drops a successfully fsynced prefix from the pending queue. */
  commitFlush(batch: EditHistoryBatch): void {
    if (!this.ownsBatch(batch)) return;
    this.pending = this.pending.filter(
      (action) => action.sequence > batch.cutoff,
    );
    if (this.retryBatch?.id === batch.id) this.retryBatch = null;
    this.pressureFenceQueued = false;
    this.releaseSerializedDocuments(batch);
    const discarded = this.trimRetained();
    this.enforcePendingBounds(discarded);
  }

  /** Persists the current action prefix in order with fences and replays. */
  async flush(): Promise<void> {
    // A caller that is already saving owns this drain. The pressure timer stays
    // latched only until a real flush begins, never until typing stops.
    this.pressureFlushRequested = false;
    const cutoff = this.nextSequence;
    for (;;) {
      const batch = await this.beginFlush(cutoff);
      if (batch === null) return;
      if (!this.ownsBatch(batch)) return;
      const write = this.enqueueOperation(() =>
        this.transport.append(batch.id, batch.actions),
      );
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
    void this.enqueueOperation(async () => {
      await this.readyPromise;
      await this.transport.fence(id);
    });
  }

  /** Physically removes this note's persisted journal. */
  async clear(): Promise<void> {
    this.resetReachable();
    await this.enqueueOperation(async () => {
      await this.readyPromise;
      await this.transport.clear();
    });
  }

  /** Test and command-surface observation of the loaded stack depths. */
  async depths(): Promise<{ undo: number; redo: number }> {
    await this.readyPromise;
    await this.operationChain;
    return { undo: this.undoEntries.length, redo: this.redoEntries.length };
  }

  /**
   * Test and command-surface observation of retained controller memory. This
   * intentionally does not wait for transport: the record-time invariant must
   * remain observable while a journal append is blocked.
   */
  async retention(): Promise<{
    entries: number;
    serializedBytes: number;
    retainedDocumentChars: number;
  }> {
    const entries = this.retainedTimeline();
    const retained = this.retainedNodes();
    return {
      entries: entries.length,
      serializedBytes: entries.reduce(
        (total, node) => total + this.reservedBytes(node),
        0,
      ),
      retainedDocumentChars: [...retained].reduce(
        (total, node) =>
          total + (node.beforeDoc?.length ?? 0) + (node.afterDoc?.length ?? 0),
        0,
      ),
    };
  }

  /** Observation of the bounded, not-yet-durable action queue. */
  pendingRetention(): {
    actions: number;
    serializedBytes: number;
    retainedDocumentChars: number;
  } {
    const retained = this.retainedNodes();
    return {
      actions: this.pending.length,
      serializedBytes: this.pendingBytes(),
      retainedDocumentChars: [...retained].reduce(
        (total, node) =>
          total + (node.beforeDoc?.length ?? 0) + (node.afterDoc?.length ?? 0),
        0,
      ),
    };
  }

  private enqueue(operation: QueuedOperation): void {
    if (!this.initialized) {
      this.preInitializationChanged = true;
    }
    this.applyQueued(operation);
  }

  private applyQueued(operation: QueuedOperation): void {
    if (operation.kind === "entry") {
      const discardedRedo = this.redoEntries.length > 0;
      this.redoEntries = [];
      this.undoEntries.push(operation.node);
      this.pending.push({
        kind: "entry",
        nodes: [operation.node],
        sequence: operation.sequence,
      });
      const discarded = this.trimRetained();
      this.enforcePendingBounds(discardedRedo || discarded);
      return;
    }
    const source =
      operation.kind === "undo-to" ? this.undoEntries : this.redoEntries;
    const target =
      operation.kind === "undo-to" ? this.redoEntries : this.undoEntries;
    const moved: RuntimeEntry[] = [];
    let matched = false;
    let cursor = operation.startDoc;
    while (source.length > 0) {
      const node = source.at(-1);
      if (node === undefined) break;
      const run = node.compactedRun;
      if (run !== undefined) {
        const expectedNodes =
          operation.kind === "undo-to" ? run.nodes : [...run.nodes].reverse();
        const suffix = source.slice(-expectedNodes.length);
        const entry = run.serialized;
        if (
          entry === undefined ||
          suffix.length !== expectedNodes.length ||
          !suffix.every((member, index) => member === expectedNodes[index])
        ) {
          break;
        }
        const expectedDoc = this.replayedDocument(
          entry,
          operation.kind === "undo-to" ? "undo" : "redo",
          cursor,
        );
        if (expectedDoc === null || !expectedDoc.eq(operation.doc)) {
          break;
        }
        for (const member of [...expectedNodes].reverse()) {
          if (source.pop() !== member) {
            this.fence();
            return;
          }
          target.push(member);
          moved.push(member);
        }
        matched = true;
        break;
      }
      const expectedDoc = this.expectedDocument(
        node,
        operation.kind === "undo-to" ? "undo" : "redo",
        cursor,
      );
      if (expectedDoc === undefined) break;
      source.pop();
      target.push(node);
      moved.push(node);
      cursor = expectedDoc;
      if (expectedDoc.eq(operation.doc)) {
        matched = true;
        break;
      }
    }
    if (!matched) {
      this.fence();
      return;
    }
    const count = this.persistedMovementCount(moved);
    if (count === null) {
      this.fence();
      return;
    }
    this.pending.push({
      kind: operation.kind === "undo-to" ? "undo" : "redo",
      count,
      sequence: operation.sequence,
    });
    this.enforcePendingBounds();
  }

  private enqueueReplay(direction: "undo" | "redo", view: EditorView): void {
    this.operationChain = this.operationChain
      .then(async () => {
        await this.readyPromise;
        const source =
          direction === "undo" ? this.undoEntries : this.redoEntries;
        const node = source.at(-1);
        if (node === undefined) return;
        const entry = await this.replayEntry(node);
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
    this.generation += 1;
    this.discardLoaded = true;
    this.preservePendingOnRead = false;
    this.undoEntries = [];
    this.redoEntries = [];
    this.pending = [];
    this.retryBatch = null;
    this.batchPreparation = null;
    this.pressureFlushRequested = false;
    this.pressureFenceQueued = false;
  }

  private ownsBatch(batch: EditHistoryBatch): boolean {
    return this.batchGenerations.get(batch) === this.generation;
  }

  private enqueueOperation(operation: () => Promise<void>): Promise<void> {
    const queued = this.operationChain.then(operation);
    this.operationChain = queued.catch(() => undefined);
    return queued;
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
      if (node.compactedRun === undefined) delete node.source;
      return entry;
    });
    node.serializing = serializing;
    return serializing.finally(() => {
      if (node.serializing === serializing) delete node.serializing;
    });
  }

  private async serializeEntryRun(
    nodes: RuntimeEntry[],
    stateChecks: Map<Text, Promise<EditHistoryStateCheck>>,
  ): Promise<EditHistoryEntry> {
    const first = nodes[0];
    const last = nodes.at(-1);
    if (first === undefined || last === undefined) {
      throw new Error("history entry run is empty");
    }
    const existingRun = first.compactedRun;
    if (
      existingRun !== undefined &&
      existingRun.serialized !== undefined &&
      existingRun.nodes.length === nodes.length &&
      existingRun.nodes.every((node, index) => node === nodes[index])
    ) {
      return existingRun.serialized;
    }
    if (nodes.length === 1) return this.serializeEntry(first, stateChecks);
    if (first.beforeDoc === undefined || last.afterDoc === undefined) {
      throw new Error("history entry run cannot be serialized");
    }
    const firstSource = first.source;
    if (firstSource === undefined) {
      throw new Error("history entry run cannot be serialized");
    }
    let changes = firstSource.changes;
    let lastSource = firstSource;
    for (const node of nodes.slice(1)) {
      const nextSource = node.source;
      if (nextSource === undefined) {
        throw new Error("history entry run cannot be serialized");
      }
      changes = changes.compose(nextSource.changes);
      lastSource = nextSource;
    }
    const [before, after] = await Promise.all([
      this.stateCheck(first.beforeDoc, stateChecks),
      this.stateCheck(last.afterDoc, stateChecks),
    ]);
    return {
      changes: serializeChanges(changes),
      inverse: serializeChanges(changes.invert(first.beforeDoc)),
      selection_before: serializeSelection(firstSource.selectionBefore),
      selection_after: serializeSelection(lastSource.selectionAfter),
      before,
      after,
    };
  }

  private stateCheck(
    doc: Text,
    stateChecks: Map<Text, Promise<EditHistoryStateCheck>>,
  ): Promise<EditHistoryStateCheck> {
    let pending = stateChecks.get(doc);
    if (pending === undefined) {
      pending = editHistoryStateCheck(doc.toString());
      stateChecks.set(doc, pending);
    }
    return pending;
  }

  private releaseSerializedDocuments(batch: EditHistoryBatch): void {
    const nodes = this.batchNodes.get(batch) ?? [];
    const newest = nodes.at(-1);
    for (const node of nodes) {
      if (node === newest) continue;
      delete node.beforeDoc;
      delete node.afterDoc;
      delete node.source;
    }
    this.batchNodes.delete(batch);
    this.releaseStaleDocumentReferences();
  }

  /**
   * An entry-only pending stream serializes as one frontier. Keep only its
   * two boundary documents now, rather than retaining one whole document pair
   * for every keystroke while an autosave timer is continually reset.
   */
  private releasePendingDocumentReferences(): void {
    if (!this.initialized) return;
    if (
      this.pending.length === 0 ||
      !this.pending.every((action) => action.kind === "entry")
    ) {
      return;
    }
    const first = this.pending[0]?.nodes[0];
    const last = this.pending.at(-1)?.nodes.at(-1);
    if (first === undefined || last === undefined) return;
    for (const node of this.undoEntries) {
      if (node === first || node === last) continue;
      delete node.beforeDoc;
      delete node.afterDoc;
    }
  }

  /**
   * Keeps the pending journal delta inside the same envelope as the live
   * history. Branching over a redo suffix discards its queued prefix, so the
   * replacement is rebuilt from the surviving stacks behind a durable fence.
   */
  private enforcePendingBounds(discardedPrefix = false): void {
    this.compactPendingMovements();
    if (discardedPrefix || this.hasDetachedPendingEntries()) {
      this.rebuildPendingFromRetained();
      this.pressureFence();
    }
    while (!this.pendingWithinLimits()) {
      const oldest = this.retainedTimeline()[0];
      if (oldest === undefined || !this.dropOldest(oldest)) {
        this.releaseDetachedPendingReferences();
        this.pending = [];
        this.pressureFence();
        break;
      }
      this.rebuildPendingFromRetained();
      this.pressureFence();
    }
    this.releasePendingDocumentReferences();
  }

  /** Cancels inverse cursor movement and folds adjacent movement records. */
  private compactPendingMovements(): void {
    const compacted: PendingAction[] = [];
    for (const action of this.pending) {
      const previous = compacted.at(-1);
      if (
        action.kind === "entry" ||
        previous === undefined ||
        previous.kind === "entry"
      ) {
        compacted.push(action);
        continue;
      }
      if (previous.kind === action.kind) {
        compacted[compacted.length - 1] = {
          kind: previous.kind,
          count: previous.count + action.count,
          sequence: action.sequence,
        };
        continue;
      }
      if (previous.count > action.count) {
        compacted[compacted.length - 1] = {
          kind: previous.kind,
          count: previous.count - action.count,
          sequence: action.sequence,
        };
        continue;
      }
      if (previous.count === action.count) {
        compacted.pop();
        continue;
      }
      compacted[compacted.length - 1] = {
        kind: action.kind,
        count: action.count - previous.count,
        sequence: action.sequence,
      };
    }
    this.pending = compacted;
  }

  private hasDetachedPendingEntries(): boolean {
    const retained = this.stackNodes();
    return this.pending.some(
      (action) =>
        action.kind === "entry" &&
        action.nodes.some((node) => !retained.has(node)),
    );
  }

  private rebuildPendingFromRetained(): void {
    this.releaseDetachedPendingReferences();
    const sequence = this.nextSequence;
    const timeline = this.persistedTimeline();
    const redoCount = this.persistedMovementCount(this.redoEntries);
    if (redoCount === null) {
      this.pending = [];
      return;
    }
    this.pending = timeline.map((nodes) => ({
      kind: "entry",
      nodes,
      sequence,
    }));
    if (redoCount > 0) {
      this.pending.push({ kind: "undo", count: redoCount, sequence });
    }
  }

  private persistedTimeline(): RuntimeEntry[][] {
    const timeline: RuntimeEntry[][] = [];
    const runs = new Set<CompactedEntryRun>();
    const add = (node: RuntimeEntry) => {
      const run = node.compactedRun;
      if (run === undefined) {
        timeline.push([node]);
        return;
      }
      if (runs.has(run)) return;
      runs.add(run);
      timeline.push(run.nodes);
    };
    for (const node of this.undoEntries) add(node);
    for (const node of [...this.redoEntries].reverse()) add(node);
    return timeline;
  }

  private retainedNodes(): Set<RuntimeEntry> {
    const nodes = this.stackNodes();
    for (const action of this.pending) {
      if (action.kind === "entry") {
        for (const node of action.nodes) nodes.add(node);
      }
    }
    return nodes;
  }

  private stackNodes(): Set<RuntimeEntry> {
    return new Set([...this.undoEntries, ...this.redoEntries]);
  }

  private releaseDetachedPendingReferences(): void {
    const retained = this.stackNodes();
    for (const action of this.pending) {
      if (action.kind !== "entry") continue;
      for (const node of action.nodes) {
        if (retained.has(node)) continue;
        delete node.beforeDoc;
        delete node.afterDoc;
        delete node.source;
      }
    }
  }

  private pendingWithinLimits(): boolean {
    return (
      this.pending.length <= this.limits.entryCap &&
      this.pendingBytes() <= this.limits.byteCap
    );
  }

  private pendingBytes(): number {
    return this.pending.reduce((total, action) => {
      if (action.kind === "entry") {
        return (
          total +
          action.nodes.reduce(
            (bytes, node) => bytes + this.reservedBytes(node),
            0,
          )
        );
      }
      return total + encoder.encode(JSON.stringify(action)).length;
    }, 0);
  }

  /** Keeps exact native-history matching only at the two live stack edges. */
  private releaseStaleDocumentReferences(): void {
    const retained = new Set<RuntimeEntry>();
    const undo = this.undoEntries.at(-1);
    const redo = this.redoEntries.at(-1);
    if (undo !== undefined) retained.add(undo);
    if (redo !== undefined) retained.add(redo);
    for (const node of [...this.undoEntries, ...this.redoEntries]) {
      if (retained.has(node)) continue;
      delete node.beforeDoc;
      delete node.afterDoc;
      delete node.source;
    }
  }

  private expectedDocument(
    node: RuntimeEntry,
    direction: "undo" | "redo",
    current: Text,
  ): Text | undefined {
    const retained = direction === "undo" ? node.beforeDoc : node.afterDoc;
    if (retained !== undefined) return retained;
    const entry = node.serialized;
    if (entry !== undefined) {
      return this.replayedDocument(entry, direction, current) ?? undefined;
    }
    const source = node.source;
    if (source === undefined) return undefined;
    try {
      return (direction === "undo" ? source.inverse : source.changes).apply(
        current,
      );
    } catch {
      return undefined;
    }
  }

  private replayEntry(node: RuntimeEntry): Promise<EditHistoryEntry> {
    if (node.serialized !== undefined) return Promise.resolve(node.serialized);
    if (node.beforeDoc !== undefined && node.afterDoc !== undefined) {
      return this.serializeEntry(node, new Map());
    }
    const source = node.source;
    const grouped = node.compactedRun?.serialized;
    if (source === undefined || grouped === undefined) {
      return Promise.reject(new Error("history entry cannot be replayed"));
    }
    return Promise.resolve({
      changes: serializeChanges(source.changes),
      inverse: serializeChanges(source.inverse),
      selection_before: serializeSelection(source.selectionBefore),
      selection_after: serializeSelection(source.selectionAfter),
      before: grouped.before,
      after: grouped.after,
    });
  }

  private replayedDocument(
    entry: EditHistoryEntry,
    direction: "undo" | "redo",
    current: Text,
  ): Text | null {
    const expected = direction === "undo" ? entry.after : entry.before;
    if (current.length !== expected.length) return null;
    try {
      return changeSet(
        direction === "undo" ? entry.inverse : entry.changes,
        current.length,
      ).apply(current);
    } catch {
      return null;
    }
  }

  private trimRetained(): boolean {
    let entries = this.retainedTimeline();
    let bytes = entries.reduce(
      (total, node) => total + this.reservedBytes(node),
      0,
    );
    let discarded = false;
    while (
      entries.length > this.limits.entryCap ||
      bytes > this.limits.byteCap
    ) {
      const oldest = entries[0];
      if (oldest === undefined || !this.dropOldest(oldest)) return discarded;
      discarded = true;
      entries = this.retainedTimeline();
      bytes = entries.reduce(
        (total, node) => total + this.reservedBytes(node),
        0,
      );
    }
    return discarded;
  }

  private retainedTimeline(): RuntimeEntry[] {
    const timeline: RuntimeEntry[] = [];
    const runs = new Set<CompactedEntryRun>();
    const add = (node: RuntimeEntry) => {
      const run = node.compactedRun;
      if (run !== undefined) {
        if (runs.has(run)) return;
        runs.add(run);
      }
      timeline.push(node);
    };
    for (const node of this.undoEntries) add(node);
    for (const node of [...this.redoEntries].reverse()) add(node);
    return timeline;
  }

  private reservedBytes(node: RuntimeEntry): number {
    const entry = node.compactedRun?.serialized ?? node.serialized;
    return entry === undefined
      ? node.reservedBytes
      : Math.max(node.reservedBytes, serializedEntryBytes(entry));
  }

  private dropOldest(oldest: RuntimeEntry): boolean {
    const members = oldest.compactedRun?.nodes ?? [oldest];
    const memberSet = new Set(members);
    const timeline = this.retainedTimeline();
    const next = timeline[timeline.indexOf(oldest) + 1];
    const boundary = members.at(-1)?.afterDoc;
    if (
      next !== undefined &&
      next.beforeDoc === undefined &&
      boundary !== undefined
    ) {
      next.beforeDoc = boundary;
    }
    const undoCount = this.undoEntries.filter((node) =>
      memberSet.has(node),
    ).length;
    const redoCount = this.redoEntries.filter((node) =>
      memberSet.has(node),
    ).length;
    if (undoCount + redoCount !== members.length) return false;
    this.undoEntries = this.undoEntries.filter((node) => !memberSet.has(node));
    this.redoEntries = this.redoEntries.filter((node) => !memberSet.has(node));
    return true;
  }

  /**
   * The native journal can only drop old entries after an append. Once the
   * live cap discards an unflushed prefix, fence the durable timeline before
   * the surviving suffix is allowed to append so crash recovery cannot bridge
   * that missing segment. The queue makes this ordering hold across retries.
   */
  private pressureFence(): void {
    this.pressureFlushRequested = true;
    if (!this.pressureFenceQueued) {
      this.pressureFenceQueued = true;
      // A fence issued before the initial read makes that snapshot unreachable.
      this.discardLoaded = true;
      if (!this.initialized) this.preservePendingOnRead = true;
      this.generation += 1;
      this.retryBatch = null;
      this.batchPreparation = null;
      const id = batchId();
      void this.enqueueOperation(async () => {
        await this.readyPromise;
        await this.transport.fence(id);
      })
        .then(
          () => {
            this.requestPressureFlush();
          },
          () => {
            this.pressureFenceQueued = false;
            this.pressureFlushRequested = true;
            this.requestPressureFlush();
          },
        )
        .finally(() => {
          this.requestPressureFlush();
        });
    }
    this.requestPressureFlush();
  }

  /** A pressure flush is latched rather than reset by continued input. */
  private requestPressureFlush(): void {
    if (!this.initialized) return;
    if (this.pressureFlushQueued || this.pressureFlushRunning) return;
    this.pressureFlushQueued = true;
    setTimeout(() => {
      this.pressureFlushQueued = false;
      void this.drainPressureFlush();
    }, 0);
  }

  private async drainPressureFlush(): Promise<void> {
    if (this.pressureFlushRunning) return;
    this.pressureFlushRunning = true;
    try {
      while (this.pressureFlushRequested) {
        this.pressureFlushRequested = false;
        await this.flush();
      }
    } catch {
      // The normal save path owns visible transport failures and retries.
    } finally {
      this.pressureFlushRunning = false;
      if (this.pressureFlushRequested) this.requestPressureFlush();
    }
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
    const count = this.persistedMovementCount([node]);
    if (count === null) {
      this.fence();
      return;
    }
    this.pending.push({ kind: direction, count, sequence });
  }

  /**
   * A compacted run occupies one durable stack slot. Native history normally
   * replays the whole typing group at once; a partial replay cannot map to
   * that durable slot, so fencing is safer than recording a divergent move.
   */
  private persistedMovementCount(moved: RuntimeEntry[]): number | null {
    const movedSet = new Set(moved);
    const countedRuns = new Set<CompactedEntryRun>();
    let count = 0;
    for (const node of moved) {
      const run = node.compactedRun;
      if (run === undefined) {
        count += 1;
        continue;
      }
      if (run.nodes.some((member) => !movedSet.has(member))) return null;
      if (!countedRuns.has(run)) {
        countedRuns.add(run);
        count += 1;
      }
    }
    return count;
  }
}
