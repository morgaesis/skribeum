# Changelog

All notable changes to Skribeum are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
