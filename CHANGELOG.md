# Changelog

All notable changes to Skribeum are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Settings use one searchable scrolling pane with header jump navigation,
  compact palette cards, and live previews of each selected palette's text,
  link, code, rule, accent, and task treatments.

### Fixed

- Restore defaults reapplies and persists the complete default settings
  document in the browser demo.
- Rendered Markdown tables share one source-derived column geometry across
  their header and body rows, and wide cell content wraps inside the reading
  column instead of creating an independent horizontal scroller for each row.
- Narrow viewports keep a readable editor measure while the file tree and
  outline open as focus-managed overlay sheets, and frontmatter starts in its
  collapsed properties view.
- Narrow settings navigation stays within the viewport without clipped
  controls or horizontally displaced content.
- Touch controls meet the 44px platform target, avoid hover-only command
  access, and restore keyboard focus after modal dismissal.
- Editor reading-column styles match CodeMirror 6's rendered structure, so
  prose typography, a bounded text measure, responsive gutters, callout bleed,
  and narrow block padding apply consistently.
- Frontmatter source reveals when the cursor enters its block and collapses
  back to the properties panel when the cursor leaves.
- Following a note link leaves the destination editor unfocused for reading,
  including when the source editor already held the cursor.
- Headings no longer inherit hyperlink decoration or forced bold styling from
  CodeMirror, and syntax colors remain readable in both color modes.
- Editor typography uses platform-resolvable system faces, supported weights,
  and motion that stays within the 50ms interaction ceiling.
- Canvas pans clear and suppress text selection, overflowing cards consume
  wheel input before the camera, and note cards use the editor's read-only
  Markdown decoration pipeline.
- Large multi-line editor input lands as one CodeMirror transaction instead
  of triggering native contenteditable paragraph reconstruction.
- The editor caret and selection formatting toolbar remain visible and
  readable across light, dark, code and callout surfaces.
- Callouts retain parent-editor source positions under their rendered lines,
  so pointer placement reveals the complete editable block and one cursor
  controls nested and adjacent reveal regions.

### Added

- Packaged-browser regression coverage for tag completion verifies Enter and
  Control+Enter acceptance, arrow-key selection, Escape cleanup, saved source,
  and recent-tag ordering.
- A responsive bottom action bar and Actions sheet provide pointer and touch
  routes to files, search, the quick switcher, outline, command palette,
  settings, note actions, and navigation history.
- Command registrations declare pointer surfaces or an explicit widget-only
  audience, with runtime and test coverage for every registered user command.
- Registered link-following and tag-search commands, clickable tag search
  results, and fuzzy inline tag completion using vault tag frequency and
  recent usage.
- A searchable, sectioned settings surface for appearance, editing, files and
  vaults, search, updates and application information. Every control includes a
  plain-language description, and desktop-only controls remain visible but
  unavailable in the browser demo.
- Direct system, light and dark controls plus paired Manuscript and Lamplight,
  Studio and Graphite, and Gazette and Signal palettes. Each palette uses shared
  theme variables and passes automated WCAG AA contrast checks in both modes.
- Persisted prose and code font stacks, font size, line spacing, text column
  width, motion, autosave, spell checking, indentation, wrapping, line numbers,
  visible whitespace, Markdown source reveal, note and attachment folders,
  Obsidian compatibility, search scope and case matching, and update channel.
- Configurable multi-state task checkboxes with an ordered status editor,
  per-status glyphs and theme tokens, click transitions, keyboard selection and
  commands for applying any configured status without rewriting task text.
- `Create new note` command (`mod+n`) with no-overwrite naming in the configured
  default folder.
- Wikilink and note-embed navigation with click and Enter activation,
  unresolved-target notices, vault-relative browser permalinks, shared
  browser and desktop history, back and forward commands, and explicit
  missing-note states.
- Browser-only editor demo with a seeded sample vault, in-memory edits that
  reset on reload, and a static GitHub Pages build.
- Browser demo folder access through the File System Access API, with recursive
  Markdown loading, permission-aware writes to selected files, explicit
  in-memory fallback, and an unsupported-browser explanation.
- Delayed rendered previews for resolved note links, shared with the embed
  renderer, dismissed by pointer out or Escape, keyboard-accessible with `P`,
  and controlled by a persisted setting.
- Local KaTeX rendering for inline and block math with cursor-source reveal,
  MathML output, and visible source-preserving errors for malformed formulas.
- Lazy Mermaid rendering for `mermaid` fences with cursor-source reveal and
  inline parse errors; Mermaid stays outside the initial application chunk.
- Registered read-only JSON Canvas view with stored-position cards, file
  previews, SVG edges, and pointer plus keyboard pan and zoom controls.
- Persisted system, light and dark themes with Manuscript, Studio and Gazette
  light palettes plus Lamplight, Graphite and Signal dark palettes. Every
  palette uses shared CSS variables and carries programmatic WCAG contrast
  checks.
- Linux axe accessibility gates for the vault, decorated editor, command
  palette, settings and canvas surfaces, with expanded keyboard traversal.
- Rendered GFM table rows, recursive whole-note and section embeds, lazy
  fenced-code syntax highlighting, exact-source copy controls, cursor-aware
  fence receding, and the full Obsidian callout taxonomy with icons, themed
  accents and source-backed body rendering.
- Shared live-preview motion tokens with sub-50ms heading-marker, link, embed
  and callout source transitions, stable surrounding layout, and instant
  reduced-motion behavior.

- Standalone `skribeum-import` CLI converting Notion Markdown and CSV export
  archives into Obsidian-compatible vaults, with readable collision-safe
  names, wikilink and attachment rewriting, database row frontmatter,
  dry-run planning, and corpus-gated golden fidelity tests.
- Registration API: every command, palette entry, view, keybinding and
  slash-menu item registers through one typed registry with stable
  dot-namespaced ids, enforced by a CI sweep for key wiring outside the
  registry plus runtime assertions that the palette and slash menu list
  exactly the registry's contents.
- Command palette (`mod+p`) and quick switcher (`mod+o`): fuzzy-filtered
  ARIA comboboxes with full keyboard operation; the switcher ranks
  recently opened notes first and opens on Enter.
- Ranked vault search (`mod+shift+f`): debounced queries against the
  search index, results with title and snippet, match ranges highlighted
  as text segments, Enter opening the note with its first match
  selected.
- In-note find and replace (`mod+f`) over the editor buffer with a live
  match count; replace-one and replace-all flow through the normal
  change-set save path.
- Heading outline panel: a collapsible ARIA tree computed from the
  editor syntax tree; click or Enter navigates, the document is never
  mutated.
- Slash commands: `/` at a line start or after whitespace opens a
  registry-driven insert menu (headings, task, code fence, callout,
  table skeleton, wikilink); accepting removes the query as a declared
  range and inserts through a normal transaction.
- Select-to-style toolbar: a floating toolbar over non-empty selections
  toggling bold, italic, code, strikethrough and wikilink markers as
  declared-range insertions and deletions that round-trip exactly.
- Table editing: Tab and Shift-Tab cell navigation (Tab past the last
  cell grows the table), row and column insertion via palette and slash
  commands, GFM alignment preserved; every operation declares its byte
  ranges, including the formatting pass over re-padded cells, and the
  containment property is asserted over generated tables.
- Live preview: a data-driven decoration engine over the Lezer syntax
  tree renders headings, emphasis, links, wikilinks, embeds, lists,
  tasks, inline and fenced code, blockquotes, callouts, tags and block
  identifiers as source-text decoration with per-construct cursor-reveal
  (documented in `docs/decoration-rules.md`), windowed to the viewport,
  disabled on over-long lines, and asserted inert against the buffer over
  the whole corpus; decoration sets serialize to committed golden
  snapshots so rendering changes are reviewed diffs.
- Obsidian syntax extensions for the editor's markdown parser: wikilinks
  with aliases, embeds, tags, block identifiers, callout marks and the
  frontmatter block, shared by decoration and the conformance emitter.
- Wikilink display resolution honoring `.obsidian/app.json`, resolving
  targets against the vault tree with shortest-path semantics and styling
  unresolved links distinctly.
- Properties panel above the editor: frontmatter keys render in order
  with typed inputs for dates, numbers, booleans and lists (honoring
  `.obsidian/types.json`), and edits replace exactly the value's bytes
  through the normal change-set save path.
- TypeScript half of the two-parser conformance gate: the extended Lezer
  parse emits `(kind, start_byte, end_byte)` lines per corpus file and
  must match the committed Rust goldens byte for byte.
- UI-string externalization check over the Svelte templates and a
  keystroke-latency report harness for the two pathological corpus files.
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

### Changed

- The editor uses a system serif prose stack, monospace only for code,
  centred text column width, a six-level heading hierarchy and smoothly
  revealed heading markers.
- Frontmatter uses a collapsed properties panel as its primary presentation,
  with the unchanged raw source available from an explicit panel control.
- File tree rendering now uses windowing: only visible rows and a small
  overscan exist in the DOM, reducing layout and paint overhead for large
  vaults. Keyboard navigation (arrows, Home/End, focus management) and ARIA
  semantics remain identical; focused rows outside the window scroll into
  view automatically.
