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
 * Entries beyond either limit are removed oldest-first after they are durable,
 * leaving the newest undo or redo frontier available for recovery.
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
  | { kind: "entry"; node: RuntimeEntry; sequence: number }
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
  private generation = 0;
  private retryBatch: EditHistoryBatch | null = null;
  private batchPreparation: BatchPreparation | null = null;
  private readonly batchGenerations = new WeakMap<EditHistoryBatch, number>();
  private operationChain: Promise<void> = Promise.resolve();
  private readonly readyPromise: Promise<void>;

  private readonly batchNodes = new WeakMap<EditHistoryBatch, RuntimeEntry[]>();

  constructor(
    private readonly transport: EditHistoryTransport,
    private readonly limits: DurableHistoryLimits = DEFAULT_DURABLE_HISTORY_LIMITS,
  ) {
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
        this.trimRetained();
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
      actions.length > 1 && actions.every((action) => action.kind === "entry")
        ? actions.map((action) => action.node)
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
        action.kind === "entry" ? [action.node] : [],
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
    if (actions.every((action) => action.kind === "entry")) {
      const nodes = actions.map((action) => action.node);
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
          entry: await this.serializeEntry(action.node, stateChecks),
        });
      } else {
        serializedActions.push({ kind: action.kind, count: action.count });
      }
    }
    return serializedActions;
  }

  /** Drops a successfully fsynced prefix from the pending queue. */
  commitFlush(batch: EditHistoryBatch): void {
    this.pending = this.pending.filter(
      (action) => action.sequence > batch.cutoff,
    );
    if (this.retryBatch?.id === batch.id) this.retryBatch = null;
    this.releaseSerializedDocuments(batch);
    this.trimRetained();
  }

  /** Persists the current action prefix in order with fences and replays. */
  async flush(): Promise<void> {
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
    void this.enqueueOperation(() => this.transport.fence(id));
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

  /** Test and command-surface observation of retained controller memory. */
  async retention(): Promise<{
    entries: number;
    serializedBytes: number;
    retainedDocumentChars: number;
  }> {
    await this.readyPromise;
    await this.operationChain;
    const entries = this.retainedTimeline();
    return {
      entries: entries.length,
      serializedBytes: entries.reduce(
        (total, node) => total + this.serializedBytes(node),
        0,
      ),
      retainedDocumentChars: [...this.undoEntries, ...this.redoEntries].reduce(
        (total, node) =>
          total + (node.beforeDoc?.length ?? 0) + (node.afterDoc?.length ?? 0),
        0,
      ),
    };
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
    this.undoEntries = [];
    this.redoEntries = [];
    this.pending = [];
    this.queued = [];
    this.retryBatch = null;
    this.batchPreparation = null;
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
    return entry === undefined
      ? undefined
      : (this.replayedDocument(entry, direction, current) ?? undefined);
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

  private trimRetained(): void {
    let entries = this.retainedTimeline();
    let bytes = entries.reduce(
      (total, node) => total + this.serializedBytes(node),
      0,
    );
    while (
      entries.length > this.limits.entryCap ||
      bytes > this.limits.byteCap
    ) {
      const oldest = entries[0];
      if (oldest === undefined || !this.dropOldest(oldest)) return;
      entries = this.retainedTimeline();
      bytes = entries.reduce(
        (total, node) => total + this.serializedBytes(node),
        0,
      );
    }
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

  private serializedBytes(node: RuntimeEntry): number {
    const entry = node.compactedRun?.serialized ?? node.serialized;
    return entry === undefined
      ? 0
      : encoder.encode(JSON.stringify(entry)).length;
  }

  private dropOldest(oldest: RuntimeEntry): boolean {
    const members = oldest.compactedRun?.nodes ?? [oldest];
    const memberSet = new Set(members);
    const undoCount = this.undoEntries.filter((node) =>
      memberSet.has(node),
    ).length;
    const redoCount = this.redoEntries.filter((node) =>
      memberSet.has(node),
    ).length;
    if (undoCount + redoCount !== members.length) return false;
    this.undoEntries = this.undoEntries.filter((node) => !memberSet.has(node));
    this.redoEntries = this.redoEntries.filter((node) => !memberSet.has(node));
    this.pending = this.pending.filter(
      (action) => action.kind !== "entry" || !memberSet.has(action.node),
    );
    return true;
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
