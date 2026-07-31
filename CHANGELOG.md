# Changelog

All notable changes to Skribeum are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Crash-safe write path: temp file, fsync, rename over the target, parent
  directory fsync, `F_FULLFSYNC` semantics on macOS, permission mode and
  obtainable ownership preserved, symlinks resolved and written through.
  The simulator models every step as an interleaving point with injectable
  failures (out-of-space and torn writes included) and kill points, and a
  1,000-iteration write-abort harness asserts no truncated file, no
  temporary residue and visible failure.
- `note_write` IPC command: change-set based saves verified against the
  expected projection hash, with a conflict variant carrying the current
  on-disk hash and a reconciliation handle instead of ever overwriting.
- Byte-to-buffer line-ending mapping in `skribeum-core`: each line's
  original terminator is recorded on open and re-emitted for untouched
  lines when buffer edits convert to byte change sets, property-tested
  over the CRLF, LF and mixed-ending corpus files.
- Watcher reconciliation: hash-based external change detection that never
  reverts, unstable-read gating with size-shrink and zero-byte guards over
  a settle interval, own-write echo suppression with a write-settle banner
  window, bulk-divergence review above a threshold, and typed events for
  the editor layer; the invariant that no externally written bytes are
  replaced without explicit user action holds over 10,000 simulator seeds.
- Crash journal in the OS app-data directory, enabled by default and
  size-capped: unsaved change sets are journaled durably before each write
  and replayed on the next start, recovering the pre-crash buffer or
  surfacing the reconciliation banner when the file changed on disk, with
  kill points swept across every interleaving point of the save sequence.
- Round-trip gate driven through the change-set write path over every
  corpus file, a 4,096-case declared-range containment property with
  committed regression seeds, fuzz targets for the frontmatter extractor
  and the change-set applier, and mutation-test companions pinning each
  property against deliberately broken implementations.
- Cargo workspace (`skribeum-core`, `skribeum-vault`, `skribeum-app`) with a
  Tauri 2 shell rendering a fixed Markdown document in CodeMirror 6.
- UTF-16 to UTF-8 offset conversion in `skribeum-core`, the boundary rule for
  every position that crosses IPC.
- Vault model in `skribeum-vault`: vault open with zero writes, tree
  indexing with reconciliation exclusions, `VaultPath` (slash-separated,
  NFC-normalized, vault-root-relative) with case- and normalization-collision
  detection, and note reads returning bytes, encoding classification
  (UTF-8, UTF-8 with BOM, non-UTF-8 read-only) and a SHA-256 projection
  hash.
- Filesystem and clock traits with a seeded deterministic simulator
  (interleaving scheduler, watcher coalescing and loss, network-mount
  latency and stale reads, read-only vault mode) beside the real
  implementation, plus a guard test confining direct filesystem calls to
  the real implementation module.
- Typed IPC surface via `tauri-specta`: `vault_open`, `vault_tree`,
  `note_read` (bytes over a raw channel), `watch_subscribe` with a vault
  change event stream, a stable-coded `AppError` shape, committed generated
  TypeScript bindings, and a committed `ipc-allowlist.json` checked in CI
  against the bindings.
- Read-only vault browsing in the shell: a directory picker, a
  keyboard-navigable file tree, and read-only note rendering in CodeMirror,
  with user-facing strings centralized in one module.
