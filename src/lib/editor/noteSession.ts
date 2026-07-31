// Editing session state for one open note: the durable base (the exact
// on-disk projection this session last read or wrote) and the pending
// buffer edits since that base, held as a CodeMirror ChangeSet whose start
// document is the base's buffer projection.
//
// The session is the single place where the three index spaces meet:
// CodeMirror positions (UTF-16 code units), buffer-byte offsets (UTF-8 over
// the `\n`-normalized projection) and on-disk byte offsets (through the
// line-ending map). Saves convert pending edits into a byte change set
// against the base; external changes arrive as byte change sets against the
// same base and are rebased onto the live document with CodeMirror's
// operational-transformation pairing: for local changes A and remote
// changes B over one base, `A.compose(B.map(A))` and
// `B.compose(A.map(B, true))` produce the same document.

import { ChangeSet } from "@codemirror/state";
import {
  applyByteChangeSet,
  type ByteChange,
  changedTextSpan,
} from "./byteChangeSet";
import {
  type BufferEdit,
  bufferEditsToChangeSet,
  bufferFromBytes,
  buildLineEndingMap,
  type LineEndingMap,
} from "./lineEndingMap";
import { utf16OffsetToByteOffset } from "./offsets";

/** The durable base of a session: one on-disk projection and its derived views. */
export type NoteBase = {
  /** The exact on-disk projection bytes, byte-order mark included. */
  bytes: Uint8Array;
  /** Projection hash of `bytes`; opaque, tracked for `note_write`. */
  projectionHash: string;
  /**
   * The editor projection: byte-order mark stripped, terminators
   * normalized to `\n`. This is the document text at the base.
   */
  text: string;
  /** Byte length of the UTF-8 byte-order mark, 0 or 3. */
  bomLength: number;
  /** Per-line terminator record over the full `bytes`. */
  lineEndings: LineEndingMap;
};

/** A save in flight: the snapshot taken at `beginSave` time. */
type SaveInFlight = {
  /** Pending changes at snapshot time, from the base document. */
  changes: ChangeSet;
  /** The byte change set sent to `note_write`. */
  byteChanges: ByteChange[];
  /** Base epoch at snapshot time; a reconcile in between voids the save. */
  epoch: number;
};

/** A save request produced by `beginSave`. */
export type SaveRequest = {
  /** Byte change set in the byte space of the current base projection. */
  changeSet: ByteChange[];
  /** The projection hash `note_write` must verify before applying. */
  expectedProjectionHash: string;
};

const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const utf8Encoder = new TextEncoder();

/** Builds the derived base views from exact on-disk projection bytes. */
export function makeNoteBase(
  bytes: Uint8Array,
  projectionHash: string,
): NoteBase {
  const bomLength =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
      ? 3
      : 0;
  return {
    bytes,
    projectionHash,
    text: utf8Decoder.decode(bufferFromBytes(bytes.subarray(bomLength))),
    bomLength,
    lineEndings: buildLineEndingMap(bytes),
  };
}

export class NoteSession {
  base: NoteBase;
  /**
   * Buffer edits since the base, as a ChangeSet whose start document is
   * `base.text`. Composed from local transactions; rebased when the base
   * moves under an external ingest.
   */
  pending: ChangeSet;
  /** Bumped whenever the base moves without a save; voids in-flight saves. */
  private epoch = 0;
  private inFlight: SaveInFlight | null = null;

  constructor(bytes: Uint8Array, projectionHash: string) {
    this.base = makeNoteBase(bytes, projectionHash);
    this.pending = ChangeSet.empty(this.base.text.length);
  }

  /** Whether unsaved buffer edits exist. */
  get dirty(): boolean {
    return !this.pending.empty;
  }

  /** Whether a save is currently in flight. */
  get saving(): boolean {
    return this.inFlight !== null;
  }

  /** Folds one local (user-originated) transaction's changes into the session. */
  recordLocalChanges(changes: ChangeSet): void {
    this.pending = this.pending.compose(changes);
  }

  /**
   * Snapshots the pending edits into a save request, converting them into
   * a byte change set against the current base projection: CodeMirror
   * UTF-16 positions become buffer-byte offsets, then the line-ending map
   * re-emits terminators into on-disk byte space. Returns null when there
   * is nothing to save or a save is already in flight. The session keeps
   * accepting local edits while the request is outstanding; conclude with
   * `commitSave` or `rollbackSave`.
   */
  beginSave(): SaveRequest | null {
    if (this.pending.empty || this.inFlight !== null) {
      return null;
    }
    const changes = this.pending;
    const baseText = this.base.text;
    const bomLength = this.base.bomLength;
    const edits: BufferEdit[] = [];
    changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      edits.push({
        start: bomLength + utf16OffsetToByteOffset(baseText, fromA),
        end: bomLength + utf16OffsetToByteOffset(baseText, toA),
        insert: utf8Encoder.encode(inserted.toString()),
      });
    });
    const byteChanges = bufferEditsToChangeSet(this.base.lineEndings, edits);
    this.inFlight = { changes, byteChanges, epoch: this.epoch };
    this.pending = ChangeSet.empty(changes.newLength);
    return {
      changeSet: byteChanges,
      expectedProjectionHash: this.base.projectionHash,
    };
  }

  /**
   * Concludes an in-flight save that `note_write` applied: the base
   * advances to the written bytes. Throws when the recomputed projection
   * text disagrees with the document the snapshot produced, which would
   * mean the TypeScript conversion diverged from the Rust apply; the
   * caller recovers by re-reading the note.
   */
  commitSave(projectionHash: string): void {
    const flight = this.inFlight;
    this.inFlight = null;
    if (flight === null || flight.epoch !== this.epoch) {
      return;
    }
    const bytes = applyByteChangeSet(this.base.bytes, flight.byteChanges);
    const base = makeNoteBase(bytes, projectionHash);
    if (base.text.length !== flight.changes.newLength) {
      // Restore the pending edits before surfacing the divergence.
      this.pending = flight.changes.compose(this.pending);
      throw new Error("saved projection does not match the editor document");
    }
    this.base = base;
  }

  /** Concludes an in-flight save that failed or conflicted: nothing moved. */
  rollbackSave(): void {
    const flight = this.inFlight;
    this.inFlight = null;
    if (flight === null || flight.epoch !== this.epoch) {
      return;
    }
    this.pending = flight.changes.compose(this.pending);
  }

  /**
   * Moves the base to a new on-disk projection (an external change, a
   * conflict re-read, or journal-divergence review) and rebases the
   * pending local edits over it. Returns the changes to dispatch onto the
   * live document; the external content is never reverted and local edits
   * are never dropped. The caller dispatches with `addToHistory: false`
   * and clears the undo history.
   */
  reconcile(bytes: Uint8Array, projectionHash: string): ChangeSet {
    // A save in flight was computed against the old base; fold its
    // snapshot back into pending and void the response via the epoch.
    if (this.inFlight !== null && this.inFlight.epoch === this.epoch) {
      this.pending = this.inFlight.changes.compose(this.pending);
      this.inFlight = null;
    }
    this.epoch += 1;
    const newBase = makeNoteBase(bytes, projectionHash);
    const span = changedTextSpan(this.base.text, newBase.text);
    const external =
      span === null
        ? ChangeSet.empty(this.base.text.length)
        : ChangeSet.of([span], this.base.text.length);
    const forDispatch = external.map(this.pending);
    this.pending = this.pending.map(external, true);
    this.base = newBase;
    return forDispatch;
  }

  /**
   * Ingests an external delta (the `ExternalNoteUpdate` payload): a byte
   * change set against this session's base projection. Throws when the
   * delta does not fit the tracked base, in which case the caller falls
   * back to a full re-read plus `reconcile`.
   */
  ingestDelta(
    changes: readonly ByteChange[],
    projectionHash: string,
  ): ChangeSet {
    const bytes = applyByteChangeSet(this.base.bytes, changes);
    return this.reconcile(bytes, projectionHash);
  }

  /**
   * Applies a journal-recovered delta: a byte change set against the
   * current on-disk bytes whose result is the buffer as it was before the
   * crash. Unlike an external ingest the base does not move; the recovered
   * difference becomes pending local edits, so the next save persists it.
   * Returns the changes to dispatch onto the live document.
   */
  recoverDelta(changes: readonly ByteChange[]): ChangeSet {
    const recoveredBytes = applyByteChangeSet(this.base.bytes, changes);
    const recovered = makeNoteBase(recoveredBytes, "");
    const span = changedTextSpan(this.base.text, recovered.text);
    const overBase =
      span === null
        ? ChangeSet.empty(this.base.text.length)
        : ChangeSet.of([span], this.base.text.length);
    const forDispatch = this.pending.empty
      ? overBase
      : overBase.map(this.pending);
    this.pending = this.pending.compose(forDispatch);
    return forDispatch;
  }
}
