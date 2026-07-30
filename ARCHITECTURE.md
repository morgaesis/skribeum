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
  clock access go through traits so reconciliation logic runs under a seeded
  deterministic simulator in tests; only the store implementation touches
  the real filesystem.
- `skribeum-app` (`src-tauri/`): the Tauri shell. Window setup and IPC
  command registration only.

## IPC invariants

- Every position crossing IPC is a UTF-8 byte offset, converted at the
  boundary. CodeMirror indexes in UTF-16 code units and Rust `str` in bytes;
  the spaces agree on ASCII and diverge on emoji and CJK, so the conversion
  lives in `skribeum-core` and is tested over astral-plane and combining
  characters.
- Full document text never crosses IPC per keystroke. The buffer lives in
  CodeMirror; Rust receives the file on open and versioned change sets on
  save and idle.
- The IPC command surface is a committed allowlist checked against the
  generated bindings in CI. It grows deliberately, never incidentally.

## Files are the source of truth

Notes are plain `.md` files. Opening a vault performs no writes. Saving
rewrites only the bytes the edit touched: files are read as bytes, a
byte-to-buffer mapping layer preserves each untouched line's original
terminator, UTF-8 BOMs survive round trips, and non-UTF-8 files open
read-only. Device-local state (layout, caches, indexes, keys) lives in the
OS app-data directory, never inside the vault.
