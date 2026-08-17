# Changelog

All notable changes to Skribeum are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A headless list-move primitive: given a document, a list item and a
  destination list and index, it returns the declared spans that relocate
  the item and nothing else. The moved extent is the item's whole lines
  including nested sublists, continuation paragraphs and indented code,
  together with the blank line that separates it from its neighbour, so a
  loose list stays loose and a tight one stays tight at both ends of the
  move. Indentation and the marker character are rewritten only where the
  destination list writes them differently, numbered items keep the numbers
  the author gave them, and a file with no final newline still has none
  afterwards. A move that cannot be written without changing a byte it was
  not asked to touch is refused rather than approximated. A corpus of
  board-shaped and list-shaped documents, covering CRLF, mixed and absent
  terminators, tabs, every bullet marker, ordered lists, loose and tight
  lists, continuations and nested sublists, asserts on the bytes the edit
  path writes that every legal move relocates its extent and leaves the rest
  of the file untouched, and that undoing a move restores the file exactly.
- The Updates settings section can now act on what it reports: an available
  update offers an "Install update" button showing its release notes inline,
  a running download shows progress that reads honestly whether or not the
  server reports a download size, and an installed update offers "Restart to
  apply", which confirms first and saves any unsaved work through the same
  path any other window-closing action uses before restarting.
- Every file a vault holds opens. A file that is not a note opens as an
  editable buffer through the same read and write path notes use: line
  endings, a byte-order mark, trailing whitespace, and a missing final
  newline all survive an edit unchanged, the vault compares the on-disk
  projection before writing, and a file that changed underneath the editor
  reports a conflict rather than being overwritten. Those documents carry
  creation and modification times in the note-information panel too.
- Common formats get syntax highlighting, chosen from the file extension and
  never from the file's contents: YAML, JSON, TOML, shell, and the rest of
  the bundled language set, plus a small table of extensionless names such as
  `Dockerfile` and shell startup files. A path naming no known language opens
  as plain text and is still fully editable.
- Image files open in a viewer: PNG, JPEG, GIF, WebP, SVG, and the other
  formats the image extension allowlist names. Bytes reach an image element
  and nothing else and are typed from the extension, so a vector image loads
  in the user agent's secure static mode with scripts, event handlers, and
  external references all disabled.
- The browser demo vault ships a `.gitignore`, a YAML pipeline file, and a
  PDF, so the non-note surfaces are visible without opening a local folder.

### Changed

- An update failure now reports something a person can act on instead of a
  raw error object: a signature or authentication failure is called out as a
  security concern rather than reading like an ordinary network hiccup, and
  it is announced assertively rather than as routine status text.
- The file tree opens every row it shows. A file that is neither a note nor a
  canvas is no longer drawn muted and inert, and the unified command surface
  reaches every indexed file rather than notes and canvases alone.
- A file that is neither an image nor valid UTF-8 opens read-only with the
  non-UTF-8 notice, the same treatment a non-UTF-8 note gets, so no editing
  pass can write a lossy re-encoding over a binary file.
- Markdown services stay with Markdown documents. The outline, frontmatter
  and the properties panel, source mode, and title resolution from a leading
  heading apply to notes only, so a YAML document's leading `---` is not
  folded away as frontmatter and a script's leading `#` is not read as a
  heading.
- A chosen local folder in the browser demo loads every file it contains, and
  its tree shows dot-prefixed names, matching what the desktop application
  indexes.
- Search still indexes notes and nothing else, and now says so consistently:
  the incremental update after a save and after an external change both skip
  a path a full index rebuild would not have recorded, so a row can no longer
  appear in results until the next rebuild silently removes it.

### Fixed

- Opening a note that lives inside a collapsed folder no longer stops the
  application. The file tree measured a row the same update had released,
  and the resulting error, thrown from inside a reactive effect, halted every
  surface with no message and no recovery. The workspace it left behind was
  saved, so the next visit reproduced it; a stored workspace now reconciles a
  selected note with the folders on the way to it, so a record like that
  heals when it is read.
- A failure inside one panel of the shell now takes down only that panel,
  which reports the failure in place and offers to rebuild itself, while the
  rest of the workspace keeps rendering and responding.

## [0.0.8] - 2026-08-15

### Added

- Markdown images render: `![alt](target)` resolves a vault file, a `data:`
  URL, or an HTTPS URL, with the alt text as the accessible name, the prose
  measure as the width ceiling, and a retryable failure state when a target
  is missing. Image bytes never enter the document as markup, a vault file is
  typed from an extension allowlist rather than from its own content, and
  only HTTPS and already-typed data URLs resolve, so an SVG renders as a
  picture and executes nothing.
- Footnotes render: `[^label]` marks up as a reference and `[^label]: text`
  as its definition, either half moves the caret to its counterpart, and a
  run of definitions written without blank lines stays a run of definitions.
- A standalone `---` renders as a thematic break. A leading `---` opens
  frontmatter only when the line after it can belong to a mapping, so a
  document may open with a rule.
- Stable note permalinks: `Copy permalink` in the command palette writes an
  11-character id into the note's frontmatter on first use and copies
  `https://skribeum.app/?n=<id>`, a URL that survives file moves and renames
  because the id lives in the note content. The browser demo resolves the id
  to the note and falls back to normal landing when nothing matches;
  `?note=<path>` URLs keep working.
- Editor panes form a split tree: any pane splits up, down, left, or right,
  splits nest, and dividers resize each split 1:1 with the pointer against a
  20rem width and 12rem height floor per pane. `Mod-Alt-Arrow` moves focus to
  the nearest pane in that direction by bounding box, `Move tab to pane
  above/below/left/right` relocates the active tab the same way, and closing a
  pane's last tab collapses it into its sibling. A tab dragged over a pane's
  four edge zones creates a split there; the center zone joins that pane's
  strip. Eight panes is the ceiling.
- Every pane in a split carries its own tab strip, so each one is named and
  closable, and a `+` control opens an empty tab that the next note fills in
  place. Tab strips hold their widths after a close while the pointer stays
  over them, so repeated clicks close successive tabs, and arrow keys move
  between tabs per the ARIA tabs pattern.
- Canvas boards are directly manipulable: double-click opens a card's note,
  single click selects it, cards drag 1:1 with the pointer and persist their
  position, a toolbar action adds an existing note as a card, and a per-card
  control removes it from the board without touching the note file. Canvas
  changes write through a whole-document atomic file path in the vault.

### Changed

- Opening a note reuses the focused pane's active tab instead of adding one,
  and switches to the note's existing tab when it is already open in any pane.
  Four routes still open a new tab deliberately: mod-click or middle-click on
  a link or tree row, `Open in new tab` in a tree row's menu, the strip's `+`
  control, and `Mod-Enter` on a file in the command surface.
- Reveal marker glyphs enter with a 120ms fade and a small slide inside their
  instantly reserved space, and leave mirroring the same motion; the reserved
  width still applies in one frame, so the caret is never dragged sideways.
- The file tree's open-note highlight and the tab strip's active-tab
  indicator travel to the newly active row or tab instead of reappearing,
  entering in place when no previous position is on screen.
- Switching tabs keeps each tab's live editor state: undo history, caret, and
  scroll position restore instantly, the pane crossfades instead of
  rebuilding, and the first note after startup transitions in place rather
  than remounting the editor.
- Menus share one anchored placement and dismissal engine: outside-press,
  Escape, and window-blur dismissal, viewport-aware flipping from the
  invoking control, arrow-key navigation, interface typography, and hover
  highlights, covering the all-tabs list, the wide-viewport overflow menu,
  the file tree's row menu, and the task status control, which now tracks
  its checkbox while the editor scrolls.
- Canvas wheel input stays on the board: an unmodified wheel or two-finger
  scroll pans, ctrl-wheel and trackpad pinch zoom anchored at the pointer,
  and keyboard and toolbar zoom anchor at the viewport center.

### Fixed

- Canvas cards no longer draw their path label, title, and content on top of
  each other; content clips with a bottom fade.
- Notes with frontmatter no longer show an oversized gap between the
  properties panel and the first block, and ArrowUp from the first visible
  line keeps the caret out of the hidden frontmatter text instead of
  stranding it at the top of the document.
- Opening a note by URL in the browser demo no longer rebuilds the page
  shell, and opening a note after viewing a canvas works again instead of
  failing silently for the rest of the session.
- Startup no longer stalls on the placeholder document when the window is
  not painting: post-paint editor work now runs through a bounded timer
  fallback when no animation frame arrives, so a vault opened in a
  background tab or an occluded window loads its note and the navigation
  queue keeps draining instead of blocking until the first visible paint.
- Typing a space at the end of a rendered table cell no longer loses the
  space before the next character arrives: the cell keeps mid-typed edge
  whitespace while it owns the caret, so multi-word content can be typed
  at any speed.
- Closing every tab no longer leaves the editor showing a stale document: the
  pane's empty state and every route out of it now agree, and the tab strip's
  geometry effects no longer throw when the strip is removed mid-update.
- The address bar follows the focused pane's active tab, including plain tab
  switches and renames, without overwriting the note a `?note=<path>` address
  asks for: reloading such a link opens that note and adds it to the focused
  pane's strip, so every restored tab survives. A restored workspace decides
  what opens only when the address names no note.
- The workspace reserves the sidebar's width from the first paint, so the
  editor area no longer jumps sideways when the vault finishes opening.
- Structure commands on a rendered table no longer corrupt the note. A table
  block end that stopped inside a row made that row parse as a truncated
  line, so an edit aimed at the row's end landed inside the row's source; a
  block end now completes the row it stops inside, and a line carrying no
  column separator is still not a row, so a block never grows over prose.
- Editing a rendered table cell no longer writes into the note around the
  table. A cell's editable surface bound no caret keys, so keys it did not
  claim resolved against the note's document instead of the cell: `End`
  stopped at a wrap point in a cell wide enough to wrap, and `Control-End`
  moved the caret out of the cell while the cell still held the editing
  session, so the next character landed outside the table. A cell is one
  field and now answers those keys against its own bounds.
- An empty quote line ends its block instead of trapping what follows inside
  it, dropping one nesting level per press, and text that already carries its
  own `>` marker keeps that marker instead of gaining a second one.
- The task status menu, link previews, and every other surface the editor
  hosts paint where they are placed. The editor shell held a compositor hint
  while idle, which made it the containing block for the fixed-position
  surfaces inside it and offset each one by the pane's own origin; the hint
  is now held only while a surface is moving.
- A hover-summoned menu waits for the pointer to rest before opening and
  stays open while the pointer travels toward it, so reaching an option no
  longer requires beating the dismissal.

## [0.0.7] - 2026-08-05

### Added

- The properties panel renders frontmatter in its compact form: a caps header
  row with the property count, one flat line per property with a fixed label
  column, checkbox, chip, ISO date, and wikilink-typed values, click-to-edit
  values that write through to the exact frontmatter bytes, and an Add
  property ghost row backed by the `Note: add property` command. The panel
  opens expanded on wide viewports, collapsed on narrow ones, and history
  returns paint the recorded state in the first frame.
- A desktop statusline shows the note's last-edited time with a note-info
  popover, center-slot confirmations such as `Link copied`, the word count
  with a selection form and a source-mode line and column segment, and a
  persistence slot that surfaces slow and failed writes. Phones carry no
  statusline; the `Note statistics` command serves the same facts on every
  viewport.
- The desktop window draws its own chrome: the header is the titlebar, with a
  drag region, double-click-to-maximize, and a right-click window menu. macOS
  keeps the native hidden-titlebar style with the traffic lights and menu bar;
  Windows and Linux draw Minimize, Maximize or Restore, and Close caption
  buttons. An unmaximized window keeps a 1px border, with an 8px corner radius
  on Linux; every window dims its header to 60% opacity while unfocused.
- Desktop undo and redo history persists across note switches and application
  restarts in a per-note application-data journal. External ingests and state
  mismatches fence older history, each replay restores its recorded selection,
  and `Note: clear edit history` removes one note's journal after confirmation.
- On Windows, the Maximize caption button participates in native hit-testing,
  so Windows 11 snap layouts appear on hover and hold exactly as they do over
  a system titlebar; the drag region's right-click menu is the real platform
  system menu, carrying Move, Size, and keyboard-driven resize alongside
  Minimize, Maximize or Restore, and Close. Every other platform is unchanged.
- Transient surfaces leave with the mirror of their entrance motion alongside
  the unchanged 50ms fade, folder expand and collapse animate as a reveal in
  the file tree while keyboard focus and the accessibility tree read final
  row geometry throughout, and dragging a tab opens its landing gap by
  animating the tabs it passes over; the dragged tab itself follows the
  pointer with no animation, and reduced motion or the animations setting
  turns every one of these transitions into its instant final state.

### Changed

- The installed version shows in the Updates section directly beside the
  check-for-updates control, replacing the About section row; version search
  and the command palette land on the one remaining row.

### Security

- Rust advisory checks reject unsound transitive dependencies, and JavaScript
  dependency audits reject every reported severity. The Tauri 2 Linux GTK 3
  stack's `RUSTSEC-2024-0429` advisory remains an explicit exception because
  its published crates require `glib` 0.18.

### Fixed

- The desktop window always appears at startup. A corrupt or unreadable
  settings file falls back to default settings and the window still shows; a
  native watchdog reveals the window even when the frontend fails to boot; a
  second launch reveals and focuses a hidden running instance instead of
  exiting silently; and a broken single-instance endpoint or capability file
  degrades to running without instance dedup rather than stopping the
  application before a window exists.
- Release-profile builds compile: the development-only TypeScript bindings
  export is confined to debug assertions, and continuous integration checks
  the release profile so the shipping configuration is gated.
- Release-note bullet validation accepts every Unicode block emoji
  presentation draws from, so a generated summary whose bullet leads with an
  arrows- or technical-block emoji passes instead of falling back to the
  plain changelog body.
- Plain HTTP and HTTPS URLs and Markdown links open in the system browser from
  the desktop application and in a new `noopener` tab from the browser demo.
- Desktop watcher events use the same monotonic clock as note saves, so genuine
  external edits ingest after autosave while matching self-write echoes remain
  suppressed by projection hash and preserve undo and redo history.
- Desktop windows remain hidden until the first frontend frame is painted and
  use the active theme surface behind the webview during startup.
- Note history restores UTF-8 caret offsets, content-anchored reading position,
  and properties-panel state without focusing the editor.
- The unified command surface accepts native typing and contains all keyboard
  input while it is open.
- Whole-note and section embeds remain mounted when vault link context loads,
  and unresolved content retains its existing visible status treatment.
- Fenced code resolves the full lazy CodeMirror language registry, loads
  language-specific browser chunks on demand, and applies their tokens without
  reloading the note.
- The file tree's rename and folder-creation prompts and its delete
  confirmation use the application's own themed dialog, replacing the
  browser's native prompt and confirm; the destructive confirm actions (note
  and vault-entry deletion, clearing a note's edit history) use the
  destructive button role. Renaming a note now validates the target name
  before applying it: a name outside `.md`, `.markdown`, or `.txt` is refused
  with the reason shown inline, rather than silently producing a file the
  tree can no longer select or open.
- A tree row's overflow menu trigger and the settings jump-to-section trigger
  toggle: a second activation while the menu is already open closes it
  instead of reopening it.
- A pane that has not navigated no longer re-renders its decorations,
  including a rendered Mermaid diagram, when a sibling pane in a split view
  opens a different note.
- The default Todo task marker renders as an empty checkbox rather than a
  circled glyph.
- Mod-F claims the in-note find and replace surface on both the desktop
  application and the browser demo regardless of which element has focus,
  instead of falling through to the browser's own find bar before the editor
  gains focus.
- The browser demo's notice no longer renders as a full-width amber alert
  block outranking the note beneath it. It is now a muted, hairline-bounded
  strip sharing the accent-subtle treatment of the persistent storage status
  bar it hands off to, at roughly three-quarters the vertical footprint,
  still dismissible and still readable.

### Changed

- The default dark palette, formerly Lamplight, is renamed Nightroom and
  retuned to the brand's Night Ink ground with a Jade accent; the default
  light palette Manuscript keeps its name and takes the brand's Spruce
  accent. The former warm charcoal-and-amber dark palette is removed rather
  than kept as an alternative, and a single fixed, mode-independent
  `--skr-lamplight` token reserves the brand's actual Lamplight glow for a
  future room-unlocked indicator.
- Labelled buttons carry one of three roles: primary as an accent fill,
  secondary as flat text, and destructive as danger text. No labelled button
  draws a border at rest, and at most one primary button appears per dialog,
  empty state, or footer.
- A three-value radius scale governs every rounded surface in the product:
  0.25rem for controls and chips, 0.375rem for floating surfaces and content
  blocks, 0.75rem for dialogs and sheets. Text inputs, the settings search,
  and slider readouts in entry mode de-box to flat fields with a bottom rule;
  segmented controls and the stepper lose their outer frame in favor of
  hairline separators between options; overflow-menu and settings-jump-menu
  rows flatten to full-width rows with no rounded row card. Only the
  checkbox, the toggle switch, and the Windows and Linux caption buttons keep
  geometry outside the scale, each specified elsewhere in the design system.
- The file tree uses display titles, collision suffixes, authored note icons,
  indent guides, persistent expansion, a vault header, drag moves, and
  pointer, keyboard, context-menu, and touch routes to registered row actions.
- Sidebar and outline panels resize by pointer or keyboard, reset on divider
  double-click, collapse fully, and persist their geometry per vault.
- Note-link previews preload during hover intent, preserve pointer travel
  through a safe triangle, and render through the same reading pipeline as
  embeds. Both surfaces share delayed skeleton, timeout, and failure behavior.
- Wide workspaces support ordered note tabs and a two-pane split with focused
  command targeting, per-pane navigation history, and per-vault restoration.

- The desktop application handles `.md`, `.markdown`, and `.txt` files from
  operating-system open-with actions, including requests forwarded from a
  second launch.
- Application zoom is available from the command surface and the standard
  `mod++`, `mod+-`, and `mod+0` shortcuts, with the selected factor persisted.
- Application and browser icons use the lit Skribeum lamp mark, brand palette,
  and a simplified silhouette at 16 pixels.
- Rust and JavaScript dependency requirements and lockfiles track their latest
  compatible stable releases, with transitive WebdriverIO serialization moved
  beyond its published security advisories.
- Appearance settings use one six-card palette chooser. Choosing a card applies
  its light or dark appearance, while Match system appearance follows the last
  chosen palette for each mode.
- Settings use the larger continuous dialog, token-coloured scrollbars,
  capability-specific desktop requirements, and typed entry for numeric
  readouts.
- Mermaid diagrams resolve their base theme from the active palette and render
  again after appearance changes.
- One prefix-routed command surface handles note and file names, commands and
  settings, tags, and note text. Existing switcher, palette, and vault-search
  shortcuts open the same surface with their corresponding mode preloaded.
- Selection toolbar buttons expose registry-derived command titles and
  keybindings after hover intent or immediately on keyboard focus.
- Interface motion uses shared state, surface, and panel classes. Note arrivals
  fade over their restored frame, transient surfaces use compositor-only
  entrances, panel toggles preserve content measure, and both reduction routes
  make class motion instant while stopping loading pulses.
- Narrow viewports use a three-region top bar for Files, the scroll-aware note
  title, and an overflow sheet containing every shell command available to
  touch. The editor occupies the remaining note area.
- Wide viewports use icon-only note history, a scroll-aware display-title
  region, conditional read-only and Source indicators, and one anchored
  overflow menu. Opening a vault remains directly available from the no-vault
  empty state.
- Note title regions use a non-empty frontmatter `title`, a first-line H1, or
  the trimmed file name. The properties panel keeps the vault path visible as
  the note identity.
- Transient surfaces clamp to the visual viewport when an on-screen keyboard
  changes the usable area. Narrow command surfaces anchor at the top, and tag
  completion prefers space below the caret before flipping above it.
- Task status controls advance on a short tap and expose the grouped menu
  after a 500ms stationary press. A continuous drag highlights and selects a
  status, while release outside cancels the gesture.
- `Task: set status` opens the grouped task menu without a hold gesture from
  the command surface or a task-line contextual overflow row. Tap, click,
  keyboard selection, Escape, and outside press use the same menu state.
- Task statuses belong to Task, Time, Importance, and Reference tracks. The
  grouped menu keeps its default view to ten status rows, new task lines inherit
  their track, and marker editing operates on exact source characters.
- A non-empty editor selection keeps headings, callouts, tasks, and other
  rendered constructs quiet. Source reveal applies only to a collapsed main
  caret.

### Added

- Rendered Markdown tables support one-caret, in-grid cell editing with exact
  source-span writes, keyboard travel and boundary growth, explicit row and
  column commands, pointer insertion strips, whole-table selection, deliberate
  source access, and ARIA grid semantics.
- `mod+e` toggles a transient whole-note source presentation with Markdown
  syntax colouring, complete source text, monospace typography, and a Source
  chip in the title region. Syntax reveal remains an independent reading-mode
  setting.

- Time statuses store due dates as plain Obsidian Tasks tokens, and Importance
  stores its level as a plain glyph token. Both payloads render as editable
  chips without hidden state.

- Copy-link commands produce browser note URLs or desktop configured links.
  Note links are available from the overflow menu and command mode, while heading links
  are available from outline rows and the heading nearest the caret.
- Every settings row is a searchable command action that opens settings,
  aligns the target row to the pane, and focuses its control.
- Embedded notes show a theme-derived loading skeleton before content or an
  unresolved-reference status appears.
- The browser demo and desktop surface publish a scheme-aware SVG favicon and
  a matching 180-pixel touch icon.
- Release notes use a human-focused summary generated from the matching
  changelog section, deterministic structure and grounding checks, a separate
  fabrication and voice judge, one critique-driven rewrite, and a plain
  changelog fallback when generation is unavailable or fails validation.
- The Release workflow supports a manual quality check for an intended tag,
  with an optional raw changelog section override, prints the validated
  candidate in the workflow summary, and uploads it without creating or
  changing a release.

## [0.0.6] - 2026-08-01

### Changed

- Release pages use the matching version section from this changelog, publish
  one signed checksum manifest and one updater signature map, and refresh the
  browser demo after publication.
- Settings use one searchable scrolling pane with header jump navigation,
  compact palette cards, and live previews of each selected palette's text,
  link, code, rule, accent, and task treatments.

### Fixed

- Restore defaults reapplies and persists the complete default settings
  document in the browser demo.
- Tag completion ignores the active query when autosave refreshes the tag
  catalog, so arrow and acceptance keys continue to operate on real matches.
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
- A responsive overflow sheet provides pointer and touch routes to files,
  search, the quick switcher, outline, command palette, settings, note actions,
  navigation history, and vault opening.
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
