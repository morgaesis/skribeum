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
  `watch_subscribe`.
- Errors cross IPC as `AppError { code, message, path }` with `code` stable
  and pinned by a committed test. Messages never contain note content.
- Paths cross IPC as `VaultPath` strings: slash-separated, NFC-normalized,
  vault-root-relative. Case and normalization collisions are detected at
  index time and surfaced as an event, never silently merged.
- Note bytes returned by `note_read` travel as a single raw channel payload
  (an `ArrayBuffer` in the webview), never as JSON, so large files do not
  pay JSON bridge cost.

## Files are the source of truth

Notes are plain `.md` files. Opening a vault performs no writes, asserted
mechanically by the simulator's write counter. Saving rewrites only the
bytes the edit touched: files are read as bytes, a byte-to-buffer mapping
layer preserves each untouched line's original terminator, UTF-8 BOMs
survive round trips byte-for-byte, and non-UTF-8 files open read-only with
a banner and are never written. Every note read carries a `projection_hash`
(SHA-256 over the exact bytes), the opaque token the reconciliation layer
tracks. Sync-tool internals, VCS state, Obsidian configuration and
Skribeum's own vault-local state are excluded from indexing and watching.
Device-local state (layout, caches, indexes, keys) lives in the OS app-data
directory, never inside the vault.
