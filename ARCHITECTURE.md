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
  (the only command accepting an absolute path), `vault_tree`,
  `vault_tree_refresh` (on-demand re-index of the tree from current
  filesystem state), `note_read`, `note_write`, `watch_subscribe`,
  `search_query`, `settings_read`, `settings_write`.
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

## Registration surface

Every user-invocable feature registers through one typed API
(`src/lib/registry/`): commands with stable dot-namespaced string ids,
palette entries, views, keybindings and slash-menu items. The registry
core imports no components and no IPC; commands receive their
capabilities per invocation through a `CommandContext` interface the
shell implements, and the shell maps registered view ids to concrete
surfaces. This is the surface the extensibility principle later
publishes as the plugin API, so ids are the compatibility contract:
they never change meaning once shipped.

Key events reach commands through exactly two interpreters, both inside
the registry module: a window-level handler for global-scope bindings
and the editor keymap builder for editor-scope bindings (which also
carries CodeMirror's stock editing keymaps). Several commands may share
a chord; they chain in registration order, each declining until one
handles it, which is how conditional surfaces (the slash menu's
navigation keys, the find panel's Escape) coexist on common keys. A CI
check sweeps the source tree for key wiring outside the registry
module: any occurrence must be a documented ARIA-pattern-internal
widget key (a combobox's arrows, a tree's roving tabindex) held in a
committed allowlist, and a runtime assertion pins the command and slash
listings to exactly the registry's contents.

Registered on this surface: one prefix-routed command surface with isolated
file, command and setting, tag, and note-text result builders. Note-text mode
uses debounced `search_query` calls with snippets highlighted by byte ranges
rendered as text segments, never injected markup. Each settings action targets
a stable row identifier that the settings pane aligns and focuses. Note and
heading link commands share browser URL and desktop configured-link generators.
Other registered features include in-note find and replace over
`@codemirror/search` with a custom match-counting panel, the heading
outline (an ARIA tree over the syntax tree, navigation only), the
settings view (optimistic updates over `settings_read`/`settings_write`
with revert on failure), inline formatting toggles behind the selection
toolbar with registry-derived tooltips, content insertions behind the slash
menu, and table editing.
Table operations (row and column insertion, cell navigation growth) are
pure functions over the table block that return declared spans, the
structural change composed with the formatting pass that re-pads other
cells, so the byte-containment property is asserted over exactly what
each operation declares and GFM alignment survives every edit.

## Note navigation and addresses

Note addresses use the vault-relative Markdown path already shared by the
vault index and Obsidian links. The browser demo serializes an address as
`?note=<percent-encoded-vault-path>#<percent-encoded-fragment>`, for example
`?note=Examples%2FWork%2Fmeeting-notes.md#Open%20questions`. The query form
keeps permalinks valid when the static demo is hosted below a URL prefix. The
optional fragment is an Obsidian heading or `^block-id` suffix without the
leading `#`. Desktop navigation stores the same `{ path, fragment }` address
objects in an in-app stack, so link resolution, back and forward behavior, and
fragment selection do not depend on the host surface.

Each history entry also stores the main selection's anchor and head as UTF-8
byte offsets, the first fully visible line as a UTF-8 byte offset, its pixel
offset from the viewport, and the properties-panel expansion state. Each pane
retains at most 100 in-memory entries. Traversal constructs the editor state
with that selection before paint, restores the content-anchored position
without animation, resolves the properties panel to its recorded state, and
keeps focus on the reading surface. A fresh note open stores no restoration,
starts at the top with the form-factor panel default, and leaves its parked
caret unfocused.

Paths are NFC-normalized, slash-separated, vault-root-relative values. A path
is the durable address because vault handles are session-local and notes do
not carry stable identifiers. Renaming a note therefore changes its address.
Existing links continue to follow Obsidian path and shortest-name resolution;
an old permalink whose path no longer exists opens the not-found surface
instead of guessing at a renamed target. The desktop surface instructs the
user to create the Markdown file at that path and provides a refresh action.
The browser demo explains that it does not create the file automatically.

The navigation feature (`src/lib/features/navigation.ts`) owns address
encoding, Obsidian-aware resolution, browser and desktop history adapters,
fragment lookup, and the registered `navigation.back`, `navigation.forward`,
and `navigation.follow-link` commands. A plain click follows a rendered
wikilink or the header of a rendered note embed. A click on revealed wikilink
source remains an editing gesture. Control-click and Command-click follow
without moving the cursor. Enter follows the link under the editor cursor or a
focused embed header and otherwise falls through to CodeMirror's ordinary
Enter behavior. Unresolved links announce the resolution failure and open
their deterministic missing-note address when one can be formed.

## Live preview

The editor renders source-text decoration: the buffer holds the exact
source and presentation is decoration only, never a text transform. The
`@lezer/markdown` parse is extended in
`src/lib/editor/markdown/obsidian.ts` with the Obsidian constructs the
stock grammar lacks (wikilinks, embeds, tags, block identifiers, callout
marks, the frontmatter block), and that module's node vocabulary is the
only one decoration speaks. The decoration engine
(`src/lib/editor/decorations/engine.ts`) is data-driven: one table
(`src/lib/editor/decorations/table.ts`) maps node names to marks, hidden
ranges, line classes or widgets, each row carrying a cursor-reveal policy
(`docs/decoration-rules.md` mirrors the table row for row, test-enforced).
The engine interprets rows synchronously inside the view plugin's update,
windowed to the visible ranges, with decorations disabled on lines past a
length threshold so pathological lines stay editable. Decoration sets
serialize to stable text for golden-snapshot review, and the same
serialized attributes carry the accessibility roles and names widgets
render.

Render-only Markdown uses the same decoration table. A rendering parser
extension recognizes inline and block math without changing the vault-wide
extraction contract. KaTeX replaces each recognized expression with local
HTML and MathML, while malformed expressions remain visible in an error
widget. Mermaid fences use the stock fenced-code nodes and load Mermaid only
when the first diagram widget mounts. Mermaid uses the base theme with colours
resolved from the active theme tokens, and connected diagrams render again when
the palette changes because SVG output contains fixed colours. Fenced-code
language parsers also load on demand, while unknown info strings stay plain.
GFM tables render as aligned row widgets so cursor entry reveals one source row.
Note and section embeds
mount nested read-only instances of the same decoration engine with a bounded
ancestry context for depth and cycle notices. Callouts use the same nested
renderer for their bodies, with typed icon and accent metadata and native fold
controls. Block replacements live in a decoration state field because they
affect vertical layout; ordinary marks and inline widgets remain
viewport-windowed.

Wikilink display resolution honors `.obsidian/app.json` read through the
`vault_config_read` command, resolves targets against the vault tree
with shortest-path semantics, and styles unresolved links distinctly; the
Rust index stays the authority for vault-wide link structure. Frontmatter
renders as a properties panel above the editor: a positional parser
records each value's exact character range, typed inputs (dates, numbers,
booleans, lists, honoring `.obsidian/types.json`) replace precisely that
range through a normal editor transaction, and untouched keys are
byte-preserved through the ordinary change-set save path. The panel starts
expanded on wide layouts and collapsed on narrow layouts, and identifies the
note by its vault path. A shared
title resolver derives reading-surface labels from a non-empty frontmatter
`title`, a first-line H1, or the trimmed file name, in that order.

Whole-note source mode reconfigures the editor's rendering compartment to keep
Markdown parsing and token highlighting while omitting presentation
decorations. The CodeMirror document, history, selection, save session, and
settings compartment remain in place. The Syntax reveal setting therefore
resumes unchanged when source mode closes, while the properties panel stays
absent and the complete source projection is visible in the monospace face.

The two-parser split (decision 11) is held together by a permanent
conformance gate: `tests/syntax-spec.toml` is the shared syntax contract,
and both the Rust extractor and the Lezer-based emitter
(`tests/web/conformanceEmitter.ts`) must produce identical
`(kind, start_byte, end_byte)` sets over `tests/corpus/`, compared
against the committed goldens in `tests/conformance/rust/`.

The `webdriver`-feature build (end-to-end tests only, never release
artifacts) announces the vault named by `SKRIBEUM_E2E_VAULT` to the
webview on page load, which opens it on startup; the directory-picker
dialog cannot be driven headlessly.

## Render-only vault files

JSON Canvas files remain outside note editing and search state. The vault
exposes one read-only file command for indexed regular files, and the
registered canvas content view parses the JSON in the webview. Cards retain
their stored coordinates and dimensions, SVG edges connect their stored
endpoints, and file cards display read-only text previews. Pointer, wheel,
button and keyboard camera controls alter only the view transform.

## Themes and accessibility

The persisted `system`, `light` or `dark` setting selects a CSS custom-property
palette shared by shell chrome, CodeMirror and rendered decorations. System
mode follows `prefers-color-scheme` through a reactive media query. Unit tests
compute WCAG contrast ratios from the deployed variables. The Linux end-to-end
suite runs axe against the vault, decorated editor, palette, settings and
canvas surfaces, alongside keyboard-only traversal and camera controls.

The shell switches to its narrow layout at 60rem (960 CSS pixels). This point
keeps the 16rem file tree, 15rem outline, 45-character minimum reading measure,
and specified gutters from competing for the same inline space. At and below
the breakpoint, permanent side columns become modal overlay sheets, settings
fills the visual viewport, and palette surfaces anchor to its top edge. The
editor keeps the design-system gutter floor of 1.5rem on each side. A 3rem top
bar provides Files, the scroll-aware note title, and the overflow sheet as the
permanent touch routes. The desktop header remains 2.5rem high and contains
icon-only Back and Forward controls, the same scroll-aware display title,
conditional read-only and Source indicators, and one overflow icon. Its menu is
anchored to the trailing button. A no-vault reading area contains the single
labelled Open vault empty-state action.

Modal surfaces measure against the visual viewport, make the background inert,
trap Tab and Shift+Tab, close with Escape or a visible Close button, and restore
the invoking control. File and outline rows expand from their desktop geometry
to 44px touch targets in sheets. The command registry records each user
command's pointer surfaces; ARIA widget navigation commands are explicitly
marked as widget-internal, and registry coverage rejects an unclassified or
unreachable user command. The task-status command checks the live caret or task
checkbox focus before joining an overflow menu and asks the existing checkbox
widget to enter tap mode, so pointer, keyboard, and hold-drag routes share one
grouped menu and one status application path.

## Two parsers, one contract

Two markdown parsers exist by design, with a hard split of authority. The
Lezer tree in the webview is the sole authority for what an open buffer
shows. The `skribeum-core` extraction layer (`extract.rs`, pulldown-cmark
offset iteration plus post-passes for the Obsidian constructs CommonMark
lacks) is the sole authority for vault-wide structure: links, wikilinks,
embeds, tags, headings, block identifiers, and code regions, feeding the
link graph, backlinks and search. Neither ever computes the other's
output. Both implement the shared specification in `tests/syntax-spec.toml`
and must emit an identical `(kind, start_byte, end_byte)` set over every
file in `tests/corpus/`; the committed snapshots under
`tests/conformance/rust/` are the comparison point, and any divergence
fails CI. Wikilink resolution (`resolve_wikilink`) is a pure function over
the vault index's path list implementing Obsidian shortest-path semantics:
exact path, then unique suffix, then the same case-insensitively, with
heading and block subpaths split off.

## Files are the source of truth

Editable notes are plain `.md`, `.markdown`, and `.txt` files. Opening a vault
performs no writes, asserted mechanically by the simulator's write counter.
Saving rewrites only the
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

Watchers are treated as lossy: overflow means rescan, and a watcher whose
root was deleted heals by re-subscribing once the root reappears, reporting
unknown state in between. Windows cannot signal that death in-process
(delete-pending semantics keep the name alive while the subscription dies
silently), so recovery there flows through the application-level rescan
paths: the on-demand tree refresh and projection-hash verification on every
read and save.

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

## Full-text search

Search is ranked and snippeted, served by a SQLite FTS5 index in
`skribeum-vault` (`search.rs`). The index is device-local derived state:
it lives under the OS app-data directory (one database per vault, named by
a hash of the vault root), never inside the vault, and a full
open-rebuild-query cycle provably writes nothing under the vault root.
Each note indexes as three BM25-weighted fields, title above headings
above body, with headings extracted through the `skribeum-core`
extraction layer. Updates are incremental: a note indexes on read,
re-indexes on save, follows external edits and removals through the
reconciliation events, and a tree refresh or vault open rebuilds in the
background. The index is rebuildable at any time; a corrupted or missing
database file is discarded and recreated transparently on open. Snippets
are assembled in Rust from the indexed note text, and match positions
cross IPC as byte ranges into the snippet, so the UI highlights by
slicing text, never by injecting HTML.

## Settings

`settings.json` lives in the OS app-config directory, never in a vault.
The document carries a `schema_version` and typed known keys (theme,
editor font size, application `zoom_percent`, search result limit and the
ordered `task_statuses` graph). Application zoom is an integer from 50 to 200
in steps of 10. Rust persists it and applies the corresponding 0.5 to 2.0
webview factor to every application window.
Each task status has a track and an optional plain-text payload kind. Writes are
whole-document,
validated, durable through the crash-safe sequence, and preserve every
unknown key already in the file, so settings written by a newer build
survive a round trip through an older one. A missing file reads as the
defaults; a file that does not parse as a JSON object fails loudly on
read and write rather than being silently replaced. Invalid task status
entries, duplicate symbols and dangling transitions load the default graph.
Unknown fields inside retained task status entries survive writes.
