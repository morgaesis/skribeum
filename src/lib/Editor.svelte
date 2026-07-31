<script lang="ts">
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import {
  Annotation,
  type ChangeSet,
  Compartment,
  EditorState,
  Transaction,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { onMount } from "svelte";
import type { ByteChange } from "./editor/byteChangeSet";
import { assertDecorationsInert } from "./editor/decorationGuard";
import { NoteSession } from "./editor/noteSession";
import type { ByteRangeReplace, VaultHandle } from "./ipc/bindings";
import { IpcError, type LoadedNote, noteWrite, readNote } from "./ipc/vault";

let {
  doc = "",
  note = null,
  vault = null,
  path = null,
  onConflict,
  onWriteError,
}: {
  /** Fallback document when no note is open (the scaffold fixture). */
  doc?: string;
  note?: LoadedNote | null;
  vault?: VaultHandle | null;
  path?: string | null;
  onConflict?: () => void;
  onWriteError?: (message: string) => void;
} = $props();

const IDLE_SAVE_DELAY_MILLISECONDS = 400;

let host: HTMLDivElement;
let view: EditorView | undefined;
let session: NoteSession | null = null;
/** Set when the open note disappeared from disk; saving pauses. */
let removed = false;
let idleSaveTimer: ReturnType<typeof setTimeout> | undefined;
/** Serializes saves so change sets always apply to the base they expect. */
let saveChain: Promise<void> = Promise.resolve();

const historyCompartment = new Compartment();

// Marks transactions whose changes the session has already accounted for
// (external ingests, recoveries, reconciles), so the dispatcher does not
// fold them into the pending set a second time.
const externalIngest = Annotation.define<boolean>();

function stateFor(content: string, locked: boolean): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [
      markdown(),
      EditorView.lineWrapping,
      historyCompartment.of(history()),
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            requestSave();
            return true;
          },
        },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorState.readOnly.of(locked),
      EditorView.editable.of(!locked),
      EditorView.domEventHandlers({
        blur: () => {
          requestSave();
          return false;
        },
      }),
    ],
  });
}

function scheduleIdleSave() {
  clearTimeout(idleSaveTimer);
  idleSaveTimer = setTimeout(() => {
    requestSave();
  }, IDLE_SAVE_DELAY_MILLISECONDS);
}

function dispatchTransactions(
  transactions: readonly Transaction[],
  target: EditorView,
) {
  assertDecorationsInert(transactions);
  target.update(transactions);
  for (const transaction of transactions) {
    if (
      transaction.changes.empty ||
      transaction.annotation(externalIngest) === true
    ) {
      continue;
    }
    session?.recordLocalChanges(transaction.changes);
    scheduleIdleSave();
  }
}

/**
 * Undo discipline across external ingests. The history extension in
 * `@codemirror/commands` keeps its undo log in a private state field and
 * exposes no API to truncate or clear it: `isolateHistory` only prevents
 * adjacent events from merging, and transactions with `addToHistory:
 * false` are still mapped through the stored steps, so a retained
 * pre-ingest undo step replayed after an ingest rebuilds a document that
 * combines the local rollback with the external edit in an order neither
 * device ever produced. The one supported way to drop stored steps is to
 * remove the extension from the configuration (which destroys its state
 * field) and add it back (which starts an empty one); the compartment
 * swap below does exactly that at every external ingest point. Post-ingest
 * edits accumulate fresh undo steps that stop exactly at the ingest state,
 * which satisfies the invariant: undo after an ingest never reproduces a
 * pre-ingest text that does not incorporate the ingest.
 */
function clearUndoHistory(target: EditorView) {
  target.dispatch({ effects: historyCompartment.reconfigure([]) });
  target.dispatch({ effects: historyCompartment.reconfigure(history()) });
}

/**
 * Dispatches session-produced changes (external ingest, recovery,
 * reconcile) onto the live document: never undoable, never recorded as
 * local edits, and the selection maps through the changes rather than
 * resetting.
 */
function dispatchSessionChanges(changes: ChangeSet) {
  if (view === undefined) {
    return;
  }
  if (!changes.empty) {
    view.dispatch({
      changes,
      annotations: [
        externalIngest.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
    clearUndoHistory(view);
  }
}

async function performSave(): Promise<void> {
  if (
    view === undefined ||
    session === null ||
    vault === null ||
    path === null ||
    removed
  ) {
    return;
  }
  let request: ReturnType<NoteSession["beginSave"]>;
  try {
    request = session.beginSave();
  } catch (error) {
    // A conversion failure means the session state diverged from the
    // document; recover by re-reading the note.
    onWriteError?.(String(error));
    await rereadAndReconcile();
    return;
  }
  if (request === null) {
    return;
  }
  try {
    const result = await noteWrite(
      vault,
      path,
      toIpcChanges(request.changeSet),
      request.expectedProjectionHash,
    );
    if (result.result === "written") {
      try {
        session.commitSave(result.projection_hash);
      } catch {
        await rereadAndReconcile();
      }
    } else {
      // The on-disk projection moved: never overwrite. Roll the save
      // back, surface the reconciliation state and re-read.
      session.rollbackSave();
      onConflict?.();
      await rereadAndReconcile();
    }
  } catch (error) {
    session.rollbackSave();
    onWriteError?.(
      error instanceof IpcError ? error.app.message : String(error),
    );
  }
}

/** Queues a save; consecutive requests coalesce onto one serialized chain. */
export function requestSave(): Promise<void> {
  saveChain = saveChain.then(performSave);
  return saveChain;
}

/** Saves any pending edits and resolves when the write concluded. */
export function flush(): Promise<void> {
  clearTimeout(idleSaveTimer);
  return requestSave();
}

function toIpcChanges(changes: readonly ByteChange[]): ByteRangeReplace[] {
  return changes.map((change) => ({
    start: change.start,
    end: change.end,
    bytes: Array.from(change.bytes),
  }));
}

function fromIpcChanges(changes: readonly ByteRangeReplace[]): ByteChange[] {
  return changes.map((change) => ({
    start: change.start,
    end: change.end,
    bytes: Uint8Array.from(change.bytes),
  }));
}

/**
 * Ingests a stable external change to the open note, delivered as a byte
 * change set against the session's base projection. Falls back to a full
 * re-read when the delta does not fit the tracked base.
 */
export async function ingestExternal(
  changeSet: readonly ByteRangeReplace[],
  projectionHash: string,
): Promise<void> {
  if (session === null) {
    return;
  }
  removed = false;
  try {
    dispatchSessionChanges(
      session.ingestDelta(fromIpcChanges(changeSet), projectionHash),
    );
  } catch {
    await rereadAndReconcile();
  }
}

/** Applies a journal-recovered delta as pending (unsaved) buffer edits. */
export function ingestRecovered(changeSet: readonly ByteRangeReplace[]): void {
  if (session === null) {
    return;
  }
  try {
    dispatchSessionChanges(session.recoverDelta(fromIpcChanges(changeSet)));
  } catch (error) {
    onWriteError?.(String(error));
  }
}

/** Rebases the session onto a re-read of the note. */
export function reconcileWith(loaded: LoadedNote): void {
  if (session === null) {
    return;
  }
  removed = false;
  dispatchSessionChanges(
    session.reconcile(loaded.bytes, loaded.meta.projection_hash),
  );
}

/** Marks the open note as removed from disk: the buffer stays, saving pauses. */
export function markRemoved(): void {
  removed = true;
}

async function rereadAndReconcile(): Promise<void> {
  if (vault === null || path === null) {
    return;
  }
  try {
    reconcileWith(await readNote(vault, path));
  } catch (error) {
    onWriteError?.(
      error instanceof IpcError ? error.app.message : String(error),
    );
  }
}

function initializeForNote(current: LoadedNote | null) {
  clearTimeout(idleSaveTimer);
  removed = false;
  if (current === null) {
    session = null;
    view?.setState(stateFor(doc, false));
    return;
  }
  if (current.readOnly) {
    session = null;
    view?.setState(stateFor(current.text, true));
    return;
  }
  session = new NoteSession(current.bytes, current.meta.projection_hash);
  let text = session.base.text;
  if (current.recoveredChangeSet !== undefined) {
    // Journal recovery delivered before the note was opened: the delta
    // becomes pending edits of the fresh session, so the initial document
    // already shows the recovered buffer and the next save persists it.
    try {
      session.recoverDelta(fromIpcChanges(current.recoveredChangeSet));
      const changes = session.pending;
      text = changes.empty
        ? text
        : EditorState.create({ doc: text })
            .update({ changes })
            .state.doc.toString();
    } catch (error) {
      onWriteError?.(String(error));
    }
  }
  view?.setState(stateFor(text, false));
}

onMount(() => {
  view = new EditorView({
    state: stateFor(doc, false),
    parent: host,
    dispatchTransactions,
  });
  initializeForNote(note);
  return () => {
    clearTimeout(idleSaveTimer);
    view?.destroy();
  };
});

// Re-initialize when another document is opened or closed. Re-reads of the
// same note go through `reconcileWith`, which preserves cursor and pending
// edits; this effect only runs when the note identity changes.
let initializedNote: LoadedNote | null = null;
$effect(() => {
  if (view !== undefined && note !== initializedNote) {
    initializedNote = note;
    initializeForNote(note);
  }
});
</script>

<div class="editor h-full" bind:this={host}></div>

<style>
  .editor :global(.cm-editor) {
    height: 100%;
    font-size: 0.95rem;
  }
  .editor :global(.cm-editor.cm-focused) {
    outline: 2px solid #3b82f6;
    outline-offset: -2px;
  }
  .editor :global(.cm-content) {
    font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo,
      Consolas, monospace;
  }
</style>
