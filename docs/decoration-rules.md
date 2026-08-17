# Decoration rules

The live-preview decoration engine is data-driven: one table in
`src/lib/editor/decorations/table.ts` maps Lezer markdown node names to
presentation and cursor-reveal behavior, and the engine in
`src/lib/editor/decorations/engine.ts` interprets rows without knowing any
construct by name. The table below mirrors that file row for row;
`tests/web/decorationRules.test.ts` asserts the two stay identical and
carries a behavioral reveal test for every row.

Only a collapsed main caret selects one active reveal region before any row is
rendered. A non-empty range selects no region, so every construct keeps its
rendered presentation throughout selection. Secondary carets never reveal.
Composite regions take precedence over nested regions, then the smallest
matching region wins. Every table row is evaluated against that one region,
so moving the cursor selects a new region and restores decorations in the
previous one.

Whole-note source mode omits this decoration engine while retaining Markdown
parsing and syntax highlighting. Every source character then remains in the
CodeMirror text DOM, the properties panel is absent, and the Syntax reveal
setting has no presentation replacement to modify. Leaving source mode restores
this table with the setting and editor state unchanged.

Frontmatter follows the same rule as other source-backed constructs. Its
properties panel is the primary presentation while the cursor is elsewhere.
Entering any line in the frontmatter block reveals the complete source block
and replaces the panel, while leaving the block restores the panel.

Reveal policies:

- **cursor-inside**: hidden or replaced text returns as plain source, and
  receded source styling clears, while the main cursor touches the selected
  construct.
- **cursor-line**: the hidden text returns while the main cursor touches a
  document line the selected construct covers.
- **never**: the decoration applies regardless of the cursor. Rows that
  only style usually reveal nothing and use `never`.

A construct with no text between its markers has no presentation. A mark or a
replacement covers a run of source, so a row whose node is empty — the target
or the alias either side of a bare `|` in a wikilink, mid-edit — emits
nothing rather than an empty range. A decoration build that fails for any
other reason costs that build and nothing else: the note keeps the
decorations it already has and the next successful build replaces them,
because a decoration provider that throws is one CodeMirror disables for the
life of the view, leaving the note as raw source with no way back.

`revealScope=node` makes the syntax node itself the candidate region instead
of the row's usual enclosing construct. `revealDescendants` makes that region
composite: selecting it retains the owning presentation while revealing every
nested decoration as source in the same region. Hidden and replaced ranges are
atomic while decorated, so keyboard motion skips invisible syntax rather than
entering a position the DOM cannot display.

## Source-backed block interaction

A replacement decoration removes its document range from CodeMirror's text
DOM and substitutes a `contenteditable=false` widget. Pointer hit testing can
therefore resolve only to a boundary before or after the replacement, not to
any source position inside it. A callout replacement compounds that loss by
rendering its body in a second read-only `EditorView`: the nested view owns a
separate selection and decoration engine, while ignored widget events never
move the parent selection. A link in that nested view can remain revealed at
the same time as a link selected in the parent view because neither engine
knows the other's active region.

The replacement row also owns the callout type and accent attributes. Revealing
the row removes that widget, leaving the independent generic blockquote line
rule to style the same `Blockquote` node. The rendered and revealed states
therefore derive identity from different rules, which lets a typed callout use
its accent while rendered and the generic blockquote colour while revealed.

Callouts use line decorations over the parent editor's source and an inserted,
non-replacing icon. Every visible title and body character therefore retains
its document position. The callout row is a composite reveal region, so a
cursor anywhere in the callout reveals the complete block as one unit and
suppresses independent reveals for nested links or other constructs. Its line
decoration remains present during reveal, so the callout type and accent stay
attached to the construct while its source markers are visible. The generic
blockquote row applies only to plain blockquotes, making the two block
presentations mutually exclusive.

The alternatives have these tradeoffs:

| Alternative | Cursor mapping | Reveal state | Result |
| --- | --- | --- | --- |
| Block replacement with an edit affordance | The affordance can choose a boundary or approximate a transformed body position, but the rendered DOM has no exact source positions. | A nested editor still requires cross-view selection coordination. | Rejected because direct clicks remain indirect or approximate. |
| Source-backed line decorations with atomic hidden ranges | Browser hit testing maps directly to parent-editor source, while atomic syntax remains keyboard-safe when hidden. | One parent selection chooses one composite or nested region. | Used for callouts because it preserves direct editing and a single reveal authority. |
| Per-block editing mode | Source positions exist only after an explicit mode transition. | Each block needs additional persistent interaction state and exit behavior. | Rejected because it adds a second editing state and makes ordinary cursor movement insufficient. |

Motion uses theme-level state, surface, and panel duration and easing tokens.
The state class is `50ms linear`, the entrance-only surface class is `120ms`
with `cubic-bezier(0.2, 0, 0, 1)`, and the panel class is `160ms` with the same
curve. Transient surface exits use the state duration and animate opacity only.

Heading marker geometry changes instantly. Entering the line raises the
marker opacity with the state class, while leaving lowers it. Link, embed, and
callout source swaps do not animate text or geometry. Source mode also applies
without a transition.

Motion state follows the one active reveal region. Link marks change state
when that link owns the region. Embed source receives a temporary mark while
its atomic replacement is absent. Source-backed callout line decorations stay
mounted while one state mark owns the composite region. Nested links do not
receive an independent reveal state while their owning callout is active.

Reveal motion changes opacity only. It does not animate width, height,
transform, padding, margin, or font metrics, so cursor travel cannot move text.
Under `prefers-reduced-motion: reduce`, all three class durations resolve to
zero. The loading pulse stops at a fixed opacity, while the editor caret keeps
its default blink.

## Table geometry and overflow

CodeMirror represents a Markdown `Table` as one block replacement containing
an ARIA grid. Each cell contains a nested single-line editor backed by that
cell's trimmed source span. Focusing a cell parks the parent selection at the
table boundary, hides the parent caret, and gives the nested editor the only
visible caret. A nested edit dispatches one parent-document change over that
cell span; unedited pipes, padding, alignment markers, rows, and neighboring
cells retain their exact source bytes. A typed pipe is stored as `\|`.

The table replacement never follows ordinary cursor reveal. Pointer placement
or keyboard entry focuses a rendered cell, while the registered table-source
command temporarily removes the replacement for that table. Whole-note source
mode omits the decoration engine and exposes every table in the same way as
other Markdown source.

The replacement derives one column template from every source row in the
complete table block and gives that template to every rendered row. The
template uses bounded fractional weights based on the longest source cell in
each column, so header typography and row content cannot produce independent
track boundaries.
Each cell write updates the persistent replacement in place, preserving cell
editor identity while applying the same recomputed geometry to every row
before the next paint.

Tables remain inside the editor's reading column at every viewport width. Cell
content wraps within the shared tracks when the source-derived proportions need
more room, rather than making individual rows horizontally scrollable. This
keeps every cell aligned with its header and keeps the table available through
one reading surface on both narrow and wide viewports.

### The cell key contract

A rendered cell declares `aria-multiline="false"`: it is one field holding one
logical line, and its editable surface is nested inside the note's own. Every
key event that reaches a focused cell falls into exactly one of four classes,
and none of them is "whatever happens by default" — the default is the browser
editing the note's editable surface around the cell, which puts the following
keystrokes in places nobody addressed.

| Class | Keys | Effect |
| --- | --- | --- |
| Cell action | `Home`, `End`, `PageUp`, `PageDown`, with `Shift` extending; `ArrowLeft`/`ArrowRight` within the cell and to the adjacent cell at its bounds; `ArrowUp`/`ArrowDown` to the cell above or below; `Shift` with an arrow at the table's bounds, which promotes the selection to the note over the whole table; `Tab` and `Shift-Tab`; `Enter`; `Escape`; `Mod-a`; `Backspace` at the cell's start and `Delete` at its end | Answered against the cell's own bounds and consumed. `Tab` past the last cell and `Enter` on the last row add a row; `Escape`, and travel past the table's bounds, move the caret into the note deliberately. `Mod-a` selects the cell's text |
| Cell text entry | A character key without the primary modifier, including one composed with AltGr; `Backspace` and `Delete` inside the cell; the composition keys an input method delivers | Left to the browser, which edits the element holding focus: the cell |
| Clipboard | `Mod-c`, `Mod-x`, `Mod-v`, `Ctrl-Insert`, `Shift-Insert` | Left to the browser, acting on the cell's own selection |
| Note action | The undo and redo chords | Handed to the note, whose history owns the cell's edits |
| Refused | Everything else | Consumed with no effect. The note never sees it. A window-level application shortcut on the same chord still runs, because refusing suppresses the key's own default and nothing else |

`tests/web/renderedDecorations.test.ts` drives every printable, navigation and
editing key against a focused cell under every modifier combination and asserts
after each one that the note's text and caret are untouched and that focus is
still in the cell or has left it by the contract.

The focus ring is painted from where the keystrokes go, not from the editing
session, so a cell cannot show a ring while the caret is elsewhere.

A table structure command leaves the caret in the table it changed: the cell
in the column being edited within an inserted row, the inserted cell of a new
column, or the cell that took the place of what it deleted. `Tab` past the
last cell lands in the first cell of the row it adds. Focus arriving at the note while a cell
holds the editing session belongs to that cell and is handed back, so a
command run from a surface that restores focus behind itself does not park the
note's caret inside a rendered table.

The Context column restricts a row: `parent=` requires one of the listed
direct parents, `notParent=` excludes them, `ancestor=` requires an
enclosing node, `withSibling=`/`withoutSibling=` condition on a sibling
node under the same parent, and `codeInfo=` matches the first fenced-code
info token case-insensitively. Reveal scope flags use the names described
above. `-` means the row applies to every node of that name.

| Node | Context | Presentation | Reveal |
| --- | --- | --- | --- |
| `ATXHeading1` | `-` | `line cm-skr-heading cm-skr-heading-1` | never |
| `ATXHeading2` | `-` | `line cm-skr-heading cm-skr-heading-2` | never |
| `ATXHeading3` | `-` | `line cm-skr-heading cm-skr-heading-3` | never |
| `ATXHeading4` | `-` | `line cm-skr-heading cm-skr-heading-4` | never |
| `ATXHeading5` | `-` | `line cm-skr-heading cm-skr-heading-5` | never |
| `ATXHeading6` | `-` | `line cm-skr-heading cm-skr-heading-6` | never |
| `SetextHeading1` | `-` | `line cm-skr-heading cm-skr-heading-1` | never |
| `SetextHeading2` | `-` | `line cm-skr-heading cm-skr-heading-2` | never |
| `HeaderMark` | `parent=ATXHeading1,ATXHeading2,ATXHeading3,ATXHeading4,ATXHeading5,ATXHeading6` | `hide` | cursor-line |
| `HeaderMark` | `parent=SetextHeading1,SetextHeading2` | `mark cm-skr-setext-underline` | never |
| `Emphasis` | `-` | `mark cm-skr-emphasis` | never |
| `StrongEmphasis` | `-` | `mark cm-skr-strong` | never |
| `EmphasisMark` | `-` | `hide` | cursor-inside |
| `Strikethrough` | `-` | `mark cm-skr-strikethrough` | never |
| `StrikethroughMark` | `-` | `hide` | cursor-inside |
| `Link` | `-` | `mark cm-skr-link` | never |
| `Image` | `-` | `widget image` | cursor-inside |
| `Image` | `-` | `mark cm-skr-link` | never |
| `LinkMark` | `-` | `hide` | cursor-inside |
| `URL` | `parent=Link,Image` | `hide` | cursor-inside |
| `URL` | `notParent=Link,Image` | `mark cm-skr-url` | never |
| `LinkTitle` | `-` | `hide` | cursor-inside |
| `LinkLabel` | `-` | `mark cm-skr-link-label` | never |
| `Wikilink` | `-` | `mark cm-skr-wikilink` | never |
| `WikilinkMark` | `-` | `hide` | cursor-inside |
| `WikilinkTarget` | `withSibling=WikilinkAlias` | `hide` | cursor-inside |
| `WikilinkTarget` | `withoutSibling=WikilinkAlias` | `mark cm-skr-wikilink-target` | never |
| `WikilinkAlias` | `-` | `mark cm-skr-wikilink-alias` | never |
| `Embed` | `-` | `widget embed` | cursor-inside |
| `Table` | `-` | `widget table` | never |
| `ListMark` | `-` | `mark cm-skr-list-mark` | never |
| `Task` | `-` | `mark cm-skr-task` | never |
| `TaskMarker` | `-` | `widget task-checkbox` | cursor-inside |
| `TaskDatePayload` | `ancestor=Task revealScope=node` | `mark cm-skr-task-payload` | cursor-inside |
| `TaskLevelPayload` | `ancestor=Task revealScope=node` | `mark cm-skr-task-payload` | cursor-inside |
| `InlineMath` | `-` | `widget math-inline` | cursor-inside |
| `BlockMath` | `-` | `widget math-block` | cursor-inside |
| `InlineCode` | `-` | `mark cm-skr-inline-code` | never |
| `CodeMark` | `parent=InlineCode` | `hide` | cursor-inside |
| `CodeMark` | `parent=FencedCode` | `mark cm-skr-code-fence` | cursor-inside |
| `FencedCode` | `-` | `line cm-skr-code-block` | never |
| `CodeBlock` | `-` | `line cm-skr-code-block` | never |
| `CodeInfo` | `-` | `mark cm-skr-code-info` | cursor-inside |
| `FencedCode` | `-` | `widget code-copy` | never |
| `FencedCode` | `codeInfo=mermaid` | `widget mermaid-diagram` | cursor-inside |
| `Blockquote` | `revealScope=node revealDescendants` | `line cm-skr-rich-callout` | cursor-inside |
| `Blockquote` | `-` | `line cm-skr-blockquote` | never |
| `QuoteMark` | `ancestor=Blockquote` | `hide` | never |
| `QuoteMark` | `-` | `mark cm-skr-quote-mark` | never |
| `CalloutMark` | `ancestor=Blockquote` | `hide` | never |
| `CalloutMark` | `ancestor=Blockquote` | `mark cm-skr-callout-mark` | never |
| `CalloutMark` | `ancestor=Blockquote` | `widget callout-icon` | never |
| `CalloutType` | `ancestor=Blockquote` | `mark cm-skr-callout-type` | never |
| `FootnoteReference` | `revealScope=node` | `mark cm-skr-footnote-ref` | cursor-inside |
| `FootnoteMark` | `-` | `hide` | cursor-inside |
| `FootnoteDefinition` | `-` | `line cm-skr-footnote-definition` | never |
| `FootnoteDefinitionMark` | `-` | `hide` | cursor-line |
| `FootnoteLabel` | `parent=FootnoteDefinition` | `mark cm-skr-footnote-definition-label` | cursor-line |
| `HorizontalRule` | `revealScope=node` | `widget thematic-break` | cursor-line |
| `HashTag` | `-` | `mark cm-skr-tag` | never |
| `BlockId` | `-` | `mark cm-skr-block-id` | never |
| `Frontmatter` | `revealScope=node revealDescendants` | `line cm-skr-frontmatter` | cursor-inside |

Context-dependent attributes come from thirteen documented engine builtins a row
opts into: `markdown-link-preview` adds preview targets to local note links and
external-link semantics to HTTP and HTTPS targets, `wikilink-resolution` stamps
`data-resolved` from the vault tree (unresolved links style distinctly),
`callout-type` stamps `data-callout` on source markers and icons inside a typed
callout, and `plain-blockquote` limits the generic line to untyped blockquotes.
`rich-callout` limits source-backed themed lines to typed callouts and stamps
canonical type, accent, foldability and line-position attributes.
`code-language` stamps `data-language` from the fence info string.
`mermaid-block` restricts the diagram widget to a Mermaid fence and stamps its
language attribute. `tag-search` stamps rendered tags with their source text
without the leading hash, link semantics and an accessible search label.
`task-status` stamps the configured symbol, category and theme color token on
the enclosing task. `inline-image` limits the image replacement to a target
this product renders, and `reference-image` limits the link presentation to
every other image, so the two rows are mutually exclusive.
`footnote-reference` and `footnote-definition` stamp the label, the travel
direction and the document roles the two halves of a footnote carry.

## Images

An image target resolves to one of three sources. An `https` address and a
`data` URL whose declared media type is an allowed image format are used as
the element source verbatim. A vault-relative target whose extension names an
allowed image format resolves against the vault index, which is also how
attachment folders are honoured. Every other target, a cleartext `http`
address and every other scheme among them, is not an image this product
renders, and the construct keeps its link presentation instead. A target that
names an image the vault does not contain still resolves to a source, so it
reaches the failure state rather than disappearing into prose.

Image bytes reach the page only as the source of an `img` element. Nothing
parses them into the document, so a vector file loads in the user agent's
secure static mode with scripts, external references and interactivity all
disabled. Vault bytes become a blob whose media type comes from the extension
allowlist rather than from the file's own content, and the object URL is
revoked with the widget. A file whose extension is outside that allowlist has
no rendered form at all.

The frame follows the asynchronous-content rules the embeds use: nothing
appears during the grace period, placeholder bars hold the space after it, and
a target that fails, times out, or is absent swaps in place to the failure
line and its retry control while keeping the frame. The alt text is the
element's accessible name; an image written without alt text takes its file
name instead, so no rendered graphic is unlabelled. The rendered image scales
down to the reading column and never widens it.

Where the shell supplies a byte loader, every allowed format renders from the
vault. Without one, a vector file still renders because its contents are text
and the note loader reads it, while a raster file reaches the failure state.

## Footnotes

A footnote reference is the label alone, raised, in the link color, with the
brackets hidden until the caret enters the reference. A definition line is set
in the muted secondary size with its head reduced to the label and a
separating period; entering the line restores `[^label]: ` as source. A run of
definitions written without blank lines between them stays a run of
definitions rather than folding into the first one's body.

Activating either half travels to the other: a reference moves the caret to
its definition, and a definition's label moves the caret to the first
reference that cites it. The caret landing on the counterpart reveals that
construct exactly as arriving by keyboard would.

## Thematic breaks

A standalone `---`, `***` or `___` renders as the rule it stands for, and the
delimiter returns as source while the caret is on that line. A document whose
first line is `---` opens frontmatter only when the line after it can belong
to a YAML mapping: a mapping entry, a sequence entry, a comment, or an
immediate closing delimiter. Any other following line means the delimiter was
a thematic break that happens to sit first, and it renders as one. An opener
that is followed by mapping-shaped lines but never closed within the bounded
scan also yields a thematic break, with the scanned body as one paragraph.

Resolved note embeds and link previews mount a nested read-only editor with
this same table and token set. Preview mode omits frontmatter and renders a
nested embed as its path header only. Both surfaces use the shared delayed
skeleton runner; preview hover starts the vault read during its intent delay,
then the preview controller owns placement, safe-triangle pointer travel, and
Escape dismissal without moving focus.

## Quote and callout line editing

Enter on a line holding only quote markers leaves the block. One press drops
the innermost level, so a single-level quote or callout ends immediately and a
nested quote steps out one level at a time. Enter anywhere else in a quote
continues it, and list and task continuation are unaffected. Content that
follows a callout therefore belongs to the document rather than to the block
the reader already left.

Content that already carries its own quote marker keeps exactly that marker.
Typing or pasting quoted text onto a line holding only markers replaces that
line, because a markers-only line is the continuation the editor wrote rather
than something the reader typed. The inserted text is never rewritten: the
marker that survives is the one in the source the reader supplied.

## Task status configuration

`settings.json` stores the task vocabulary as an ordered `task_statuses`
array. Each entry has this shape:

```json
{
  "symbol": " ",
  "name": "Todo",
  "category": "TODO",
  "glyph": "○",
  "color_token": "--skr-accent",
  "next_status": "/",
  "track": "task",
  "payload": null
}
```

`symbol` and `next_status` are single source characters. `category` is one of
`TODO`, `IN_PROGRESS`, `ON_HOLD`, `DONE`, `CANCELLED` or `NON_TASK`.
`color_token` names an existing `--skr-*` theme custom property. `track` is
`task`, `time`, `importance` or `reference`; `payload` is `date`, `level` or
absent. Stored entries without these optional fields remain valid. The default
symbols derive their documented assignments, while every other symbol derives
Reference with no payload. Symbols are unique, and every `next_status` refers
to another entry. A malformed array, duplicate symbol or dangling transition
loads the complete default graph. Unknown keys in the settings document and
inside retained status entries survive writes. The settings surface edits
every field and preserves graph validity while symbols are remapped or removed.

The menu groups statuses in Task, Time, Importance and Reference order. Task,
Time and Importance stay expanded. Reference appears as one `More statuses
(n)` row until activated, except when the current marker belongs to Reference.
The default menu therefore contains ten selectable rows. Holding a press within
8 CSS pixels for 500ms opens the menu clear of the finger. Dragging updates
`aria-activedescendant`, releasing over a status selects it, and releasing
outside cancels the gesture. Pointer hover opens the same menu. With the
checkbox focused, Arrow Down opens it; arrow keys, Home and End move through
options; Enter or Space selects; and Escape dismisses it.

Task advances through Todo, Doing and Done. Cancelled and Done (alternate) are
menu-only states that return to Todo when activated directly. Time statuses
advance to Done. Important keeps the `!` marker and cycles its level token
through none, `⏫`, `🔼`, `🔽` and none. Reference follows its configured
`next_status`. Command titles include the track, such as `Task: Done` and
`Time: Due`.

Time statuses use a plain ` 📅 YYYY-MM-DD` token. Choosing one opens the menu
footer date field with the local date filled in. Enter or a touch date change
writes the marker and token; Escape writes only the marker. Important uses one
plain `⏫`, `🔼` or `🔽` token. Both token kinds render as interface-font chips,
and an overdue date uses the danger color. A caret inside a chip reveals its
source. Editing or deleting that source edits or deletes the payload because
the document contains no separate payload state.

Enter at the end of a task line creates a sibling marker in the same track:
`[ ]`, `[D]`, `[!]`, or the same Reference symbol. Payloads do not inherit.
Backspace immediately after this continuation removes the complete inserted
marker and all inserted spacing. Backspace at the start of existing task text
reveals the source and consumes the separator, closing bracket, status symbol,
opening bracket, list-marker separator and list marker one character at a time.

The six categories remain visually distinct from the configured glyph and
color. TODO uses the strong unfilled border, IN_PROGRESS uses a tinted active
box, ON_HOLD uses a dashed tinted box, DONE uses a filled box and strikes the
task text, CANCELLED dims and strikes the task text, and NON_TASK removes the
box border. All colors resolve through the configured theme token and the
shared design-system variables.

The default vocabulary is:

| Track | Symbol | Name | Category | Glyph | Payload | Next |
| --- | --- | --- | --- | --- | --- | --- |
| Task | `(space)` | Todo | `TODO` | ○ | none | `/` |
| Task | `/` | Doing | `IN_PROGRESS` | ◐ | none | `x` |
| Task | `x` | Done | `DONE` | ✓ | none | `(space)` |
| Task | `-` | Cancelled | `CANCELLED` | ✕ | none | `(space)` |
| Task | `X` | Done (alternate) | `DONE` | ✔ | none | `(space)` |
| Time | `D` | Due | `TODO` | ◷ | `date` | `x` |
| Time | `<` | Scheduled | `TODO` | ← | `date` | `x` |
| Time | `>` | Forwarded | `TODO` | → | `date` | `x` |
| Importance | `!` | Important | `TODO` | ! | `level` | `!` |
| Reference | `?` | Question | `TODO` | ? | none | `/` |
| Reference | `+` | Add | `TODO` | + | none | `/` |
| Reference | `R` | Research | `TODO` | ⌕ | none | `/` |
| Reference | `i` | Idea | `TODO` | ◇ | none | `/` |
| Reference | `B` | Brainstorm | `TODO` | ◎ | none | `/` |
| Reference | `P` | Pro | `TODO` | + | none | `/` |
| Reference | `C` | Con | `TODO` | − | none | `/` |
| Reference | `Q` | Quote | `TODO` | ❝ | none | `/` |
| Reference | `N` | Note | `TODO` | ▤ | none | `/` |
| Reference | `b` | Bookmark | `TODO` | ◆ | none | `/` |
| Reference | `I` | Information | `TODO` | ⓘ | none | `/` |
| Reference | `p` | Paraphrase | `TODO` | ¶ | none | `/` |
| Reference | `L` | Location | `TODO` | ⌖ | none | `/` |
| Reference | `E` | Example | `TODO` | ◇ | none | `/` |
| Reference | `A` | Answer | `TODO` | ↳ | none | `/` |
| Reference | `r` | Reward | `TODO` | ★ | none | `/` |
| Reference | `c` | Choice | `TODO` | ◆ | none | `/` |
| Reference | `d` | Doing | `IN_PROGRESS` | ◒ | none | `x` |
| Reference | `T` | Time | `TODO` | ◷ | none | `/` |
| Reference | `@` | Character | `TODO` | @ | none | `/` |
| Reference | `t` | Talk | `TODO` | ◖ | none | `/` |
| Reference | `O` | Outline | `TODO` | ☰ | none | `/` |
| Reference | `~` | Conflict | `TODO` | ≈ | none | `/` |
| Reference | `W` | World | `TODO` | ◉ | none | `/` |
| Reference | `f` | Clue | `TODO` | ? | none | `/` |
| Reference | `F` | Foreshadow | `TODO` | ⋙ | none | `/` |
| Reference | `H` | Favorite | `TODO` | ♥ | none | `/` |
| Reference | `&` | Symbolism | `TODO` | § | none | `/` |
| Reference | `s` | Secret | `TODO` | ◆ | none | `/` |

No decoration is computed on a document line longer than 10,000 characters.
Marks, line decorations and inline widgets are windowed to visible ranges.
Table rows, math blocks and Mermaid replacements are held in a full-document
decoration field because CodeMirror requires vertical-layout decorations to
come from editor state. Expensive rendering starts only when CodeMirror mounts
the widget.

KaTeX font files are emitted as local build assets. Mermaid is a dynamic
chunk loaded by the first diagram, and neither renderer adds a remote CSP
source.
