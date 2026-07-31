# Architecture

Skribeum is a Tauri 2 desktop application. A Rust core owns files and
parsing; a Svelte 5 + CodeMirror 6 webview owns the editing surface. The
split is strict: logic lives in Tauri-independent core crates, and the shell
crate contains glue only.

## Crates

- `skribeum-core`: pure functions over source text (parsing, link
  resolution, offset conversion). No I/O. Everything is a function of its
  arguments, which is what makes byte-fidelity properties testable.
- `skribeum-vault`: vault filesystem access, watcher, index. Filesystem and
  clock access go through the `FileSystem` and `Clock` traits; vault logic
  runs identically under the seeded deterministic simulator (`sim`) and the
  real implementation (`real`). A committed guard test asserts no
  `std::fs`/`tokio::fs` call site exists outside the real implementation
  module. The simulator models network-mount semantics (delivery latency,
  stale reads, event loss), watcher coalescing and overflow, and a
  read-only-vault mode; a write counter proves mechanically that opening a
  vault performs zero writes.
- `skribeum-app` (`src-tauri/`): the Tauri shell. Window setup, IPC command
  registration and the `AppError` mapping at the boundary only.

## IPC invariants

- Every position crossing IPC is a UTF-8 byte offset, converted at the
  boundary. CodeMirror indexes in UTF-16 code units and Rust `str` in bytes;
  the spaces agree on ASCII and diverge on emoji and CJK, so the conversion
  lives in `skribeum-core` and is tested over astral-plane and combining
  characters.
- Full document text never crosses IPC per keystroke. The buffer lives in
  CodeMirror; Rust receives the file on open and versioned change sets on
  save and idle.
- The IPC command surface is the committed `ipc-allowlist.json`, checked in
  CI against the `tauri-specta` generated bindings
  (`src/lib/ipc/bindings.ts`, also committed and regeneration-checked). It
  grows deliberately, never incidentally. Current commands: `vault_open`
  (the only command accepting an absolute path), `vault_tree`, `note_read`,
  `note_write`, `watch_subscribe`.
- `note_write` is change-set based: a list of byte-range replacements
  against the last-read projection, plus the expected projection hash. The
  hash is verified against the current on-disk projection before anything
  is written; a mismatch returns the conflict variant carrying the current
  hash and a reconciliation handle, never a silent overwrite.
- Errors cross IPC as `AppError { code, message, path }` with `code` stable
  and pinned by a committed test. Messages never contain note content.
- Paths cross IPC as `VaultPath` strings: slash-separated, NFC-normalized,
  vault-root-relative. Case and normalization collisions are detected at
  index time and surfaced as an event, never silently merged.
- Note bytes returned by `note_read` travel as a single raw channel payload
  (an `ArrayBuffer` in the webview), never as JSON, so large files do not
  pay JSON bridge cost.

## The editing surface

The buffer lives in CodeMirror. Each open UTF-8 note has an editing
session (`src/lib/editor/noteSession.ts`) holding the durable base (the
exact on-disk projection last read or written) and the pending buffer
edits since that base as a CodeMirror `ChangeSet`. Saves run on the
explicit save chord, on a 400ms idle debounce and on editor blur: the
pending set converts at the boundary from UTF-16 positions to UTF-8
buffer-byte offsets, then through a TypeScript mirror of the
`skribeum-core` line-ending map into the byte space of the base
projection, and crosses IPC as a `note_write` change set with the
expected projection hash. A conflict result never overwrites: the save
rolls back, the note is re-read, and the local edits are rebased onto the
disk content with the reconciliation state surfaced. The offset and
line-ending mirrors are pinned to the Rust semantics by parity tests over
the same cases. Non-UTF-8 notes stay read-only behind a banner and have
no session.

External changes to the open note arrive as byte change sets against the
same base and dispatch with `addToHistory: false`, never undoable; cursor
and selection map through the incoming changes, never reset, and pending
local edits are rebased over the ingest rather than dropped. Undo never
crosses an external ingest into a state that existed on no device: the
undo history is emptied at every ingest point, so post-ingest undo stops
exactly at the ingest state. Journal-recovered deltas apply as pending
(unsaved) edits over the on-disk base, so the next save persists them.
Every transaction annotated as decoration-originated is asserted inert
(`docChanged === false`) by the dispatch wrapper in dev and test builds.

The `webdriver`-feature build (end-to-end tests only, never release
artifacts) announces the vault named by `SKRIBEUM_E2E_VAULT` to the
webview on page load, which opens it on startup; the directory-picker
dialog cannot be driven headlessly.

## Files are the source of truth

Notes are plain `.md` files. Opening a vault performs no writes, asserted
mechanically by the simulator's write counter. Saving rewrites only the
bytes the edit touched: files are read as bytes, a byte-to-buffer mapping
layer in `skribeum-core` records each line's original terminator on open
and re-emits it for untouched lines when buffer edits convert to byte
change sets (only lines an edit touched may carry a new terminator), UTF-8
BOMs survive round trips byte-for-byte, and non-UTF-8 files open read-only
with a banner and are never written. Every note read carries a
`projection_hash` (SHA-256 over the exact bytes), the opaque token the
reconciliation layer tracks. Sync-tool internals, VCS state, Obsidian
configuration and Skribeum's own vault-local state (including the write
sequence's own temporary files) are excluded from indexing and watching.
Device-local state (layout, caches, indexes, keys) lives in the OS app-data
directory, never inside the vault.

## Crash-safe writes

Every mirror write goes through one durable sequence in `skribeum-vault`:
resolve symlinks and write through to the final target, write a sibling
temporary file, fsync it (`F_FULLFSYNC` semantics on macOS), copy the
target's permission mode and, where obtainable, ownership, rename over the
target, and fsync the parent directory. A failure before the rename
removes the temporary file and leaves the target byte-identical;
out-of-space at any write or fsync site fails the save visibly with the
on-disk file intact; no reader can ever observe a truncated target. The
sequence is composed from `FileSystem` trait primitives, so the
deterministic simulator drives the exact production code through every
interleaving point with injectable failures (torn writes included) and
kill points, restarting over precisely the state a crash would leave.

## Crash journal

The crash journal is enabled by default and lives in the OS app-data
directory (`write-journal.jsonl`), never inside a vault. Before each
mirror write the note's change set is appended and fsynced as a delta
record; a commit record follows the completed write. The file is
size-capped, compacting committed chains away while never discarding
uncommitted recovery data; a torn trailing record from a crash mid-append
is ignored on replay. On the next start each uncommitted chain is checked
against the on-disk bytes: a matching base recovers the pre-crash buffer
as a delta event, a matching result means the save completed, and anything
else surfaces the reconciliation banner instead of applying, because a
file that changed while the app was dead is an external edit.

## Reconciliation

The watcher feeds a reconciliation state machine written entirely against
the `FileSystem` and `Clock` traits. External changes are detected by
content hash against the last projection and are never reverted. No read
classifies until it is stable across a settle interval; a read that shrank
past a guard fraction or came back empty for a previously non-empty note
takes the banner path, never silent ingest. An observed hash equal to this
device's own last projection for the document is an echo of its own mirror
write and is suppressed; a differing external edit landing within the
settle window of that write also takes the banner path. When more files
diverge in one pass than a review threshold, nothing is applied and one
bulk review event carries the whole set. The editor layer consumes typed
events: an external update with a byte change set for open notes, an
external removal, a reconciliation banner with its reason, the bulk
review, and journal recovery.
