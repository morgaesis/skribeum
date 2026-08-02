# Decoration rules

The live-preview decoration engine is data-driven: one table in
`src/lib/editor/decorations/table.ts` maps Lezer markdown node names to
presentation and cursor-reveal behavior, and the engine in
`src/lib/editor/decorations/engine.ts` interprets rows without knowing any
construct by name. The table below mirrors that file row for row;
`tests/web/decorationRules.test.ts` asserts the two stay identical and
carries a behavioral reveal test for every row.

The main cursor selects one active reveal region before any row is rendered.
Composite regions take precedence over nested regions, then the smallest
matching region wins. Every table row is evaluated against that one region,
so moving the cursor selects a new region and restores decorations in the
previous one.

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

Motion uses the theme tokens `--skr-motion-duration` and
`--skr-motion-easing`. The duration is `49ms`, below the `50ms` editing
latency ceiling, and the easing is `linear`. The shared
`--skr-motion-distance` token limits directional movement to `0.25rem`, the
smallest spacing step in the theme.

Heading marker geometry changes instantly. Entering the line moves the marker
in from the inline leading edge while raising its opacity; leaving reverses
both properties. Links, embeds and callouts use the same duration and easing
for source and rendered entry states. Source enters from the leading edge,
while the rendered state enters from the trailing edge, which makes expansion
and collapse read as opposite directions of one swap.

Motion state follows the one active reveal region. Link marks change state
when that link owns the region. Embed source receives a temporary mark while
its atomic replacement is absent. Source-backed callout line decorations stay
mounted while a state mark moves the visible text on every line in the
composite region. Nested links do not receive independent source motion while
their owning callout is active.

Motion changes only opacity and transform. It does not animate width, height,
padding, margin, font metrics or other layout properties, so the animation
cannot move surrounding text. Under `prefers-reduced-motion: reduce`, the
duration and distance tokens resolve to zero and every transition or animation
becomes instant.

## Table geometry and overflow

CodeMirror represents each Markdown table row as a separate block replacement.
The decoration engine derives one column template from every source row in the
enclosing `Table` node and gives that same template to each rendered row. The
template uses bounded fractional weights based on the longest source cell in
each column, so header typography and row content cannot produce independent
track boundaries.

Tables remain inside the editor's reading column at every viewport width. Cell
content wraps within the shared tracks when the source-derived proportions need
more room, rather than making individual rows horizontally scrollable. This
keeps every cell aligned with its header and keeps the table available through
one reading surface on both narrow and wide viewports.

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
| `EmbedMark` | `-` | `hide` | cursor-inside |
| `TableHeader` | `-` | `widget table-row` | cursor-inside |
| `TableDelimiter` | `parent=Table` | `widget table-separator` | cursor-inside |
| `TableRow` | `-` | `widget table-row` | cursor-inside |
| `ListMark` | `-` | `mark cm-skr-list-mark` | never |
| `Task` | `-` | `mark cm-skr-task` | never |
| `TaskMarker` | `-` | `widget task-checkbox` | cursor-inside |
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
| `HashTag` | `-` | `mark cm-skr-tag` | never |
| `BlockId` | `-` | `mark cm-skr-block-id` | never |
| `Frontmatter` | `revealScope=node revealDescendants` | `line cm-skr-frontmatter` | cursor-inside |

Context-dependent attributes come from nine documented engine builtins a row
opts into: `markdown-link-preview` adds preview targets and link semantics to
supported Markdown links, `wikilink-resolution` stamps `data-resolved` from
the vault tree (unresolved links style distinctly), `callout-type` stamps
`data-callout` on source markers and icons inside a typed callout, and
`plain-blockquote` limits the generic line to untyped blockquotes.
`rich-callout` limits source-backed themed lines to typed callouts and stamps
canonical type, accent, foldability and line-position attributes.
`code-language` stamps `data-language` from the fence info string.
`mermaid-block` restricts the diagram widget to a Mermaid fence and stamps its
language attribute. `tag-search` stamps rendered tags with their source text
without the leading hash, link semantics and an accessible search label.
`task-status` stamps the configured symbol, category and theme color token on
the enclosing task.

## Task status configuration

`settings.json` stores the task vocabulary as an ordered `task_statuses`
array. Each entry has this shape:

```json
{
  "symbol": " ",
  "name": "Unchecked",
  "category": "TODO",
  "glyph": "○",
  "color_token": "--skr-accent",
  "next_status": "/"
}
```

`symbol` and `next_status` are single source characters. `category` is one of
`TODO`, `IN_PROGRESS`, `ON_HOLD`, `DONE`, `CANCELLED` or `NON_TASK`.
`color_token` names an existing `--skr-*` theme custom property. Array order
drives the listbox and command surface. Symbols must be unique, and every
`next_status` must refer to another entry. A malformed array, duplicate symbol
or dangling transition loads the complete default list. Unknown keys in the
settings document and inside retained status entries survive writes.
The settings surface edits every field, preserves graph validity while symbols
are remapped or removed, and provides controls for adding and reordering rows.

Tapping the checkbox writes `next_status`. The default primary cycle is
Unchecked to Half Done to Regular to Unchecked. Holding a press within 8 CSS
pixels for 500ms opens the full status listbox with every option clear of the
finger. Dragging updates `aria-activedescendant`, releasing over an option
selects it, and releasing outside cancels the gesture. Pointer hover also opens
the listbox. With the checkbox focused, Arrow Down opens the same listbox, the
arrow keys move through options, Enter or Space selects, and Escape dismisses
it.

The six categories remain visually distinct from the configured glyph and
color. TODO uses the strong unfilled border, IN_PROGRESS uses a tinted active
box, ON_HOLD uses a dashed tinted box, DONE uses a filled box and strikes the
task text, CANCELLED dims and strikes the task text, and NON_TASK removes the
box border. All colors resolve through the configured theme token and the
shared design-system variables.

The shipped SlRvb-compatible status list is:

| Symbol | Name | Category | Glyph | Color token | Next |
| --- | --- | --- | --- | --- | --- |
| `(space)` | Unchecked | `TODO` | ○ | `--skr-accent` | `/` |
| `x` | Regular | `DONE` | ✓ | `--skr-success` | `(space)` |
| `X` | Checked | `DONE` | ✔ | `--skr-success` | `(space)` |
| `-` | Dropped | `CANCELLED` | ✕ | `--skr-danger` | `(space)` |
| `>` | Forward | `TODO` | → | `--skr-accent` | `/` |
| `<` | Migrated | `TODO` | ← | `--skr-accent` | `/` |
| `D` | Date | `TODO` | ◷ | `--skr-accent` | `/` |
| `?` | Question | `TODO` | ? | `--skr-accent` | `/` |
| `/` | Half Done | `IN_PROGRESS` | ◐ | `--skr-warning` | `x` |
| `+` | Add | `TODO` | + | `--skr-accent` | `/` |
| `R` | Research | `TODO` | ⌕ | `--skr-accent` | `/` |
| `!` | Important | `TODO` | ! | `--skr-accent` | `/` |
| `i` | Idea | `TODO` | ◇ | `--skr-accent` | `/` |
| `B` | Brainstorm | `TODO` | ◎ | `--skr-accent` | `/` |
| `P` | Pro | `TODO` | + | `--skr-accent` | `/` |
| `C` | Con | `TODO` | − | `--skr-accent` | `/` |
| `Q` | Quote | `TODO` | ❝ | `--skr-accent` | `/` |
| `N` | Note | `TODO` | ▤ | `--skr-accent` | `/` |
| `b` | Bookmark | `TODO` | ◆ | `--skr-accent` | `/` |
| `I` | Information | `TODO` | ⓘ | `--skr-accent` | `/` |
| `p` | Paraphrase | `TODO` | ¶ | `--skr-accent` | `/` |
| `L` | Location | `TODO` | ⌖ | `--skr-accent` | `/` |
| `E` | Example | `TODO` | ◇ | `--skr-accent` | `/` |
| `A` | Answer | `TODO` | ↳ | `--skr-accent` | `/` |
| `r` | Reward | `TODO` | ★ | `--skr-accent` | `/` |
| `c` | Choice | `TODO` | ◆ | `--skr-accent` | `/` |
| `d` | Doing | `IN_PROGRESS` | ◒ | `--skr-warning` | `x` |
| `T` | Time | `TODO` | ◷ | `--skr-accent` | `/` |
| `@` | Character | `TODO` | @ | `--skr-accent` | `/` |
| `t` | Talk | `TODO` | ◖ | `--skr-accent` | `/` |
| `O` | Outline | `TODO` | ☰ | `--skr-accent` | `/` |
| `~` | Conflict | `TODO` | ≈ | `--skr-accent` | `/` |
| `W` | World | `TODO` | ◉ | `--skr-accent` | `/` |
| `f` | Clue | `TODO` | ? | `--skr-accent` | `/` |
| `F` | Foreshadow | `TODO` | ⋙ | `--skr-accent` | `/` |
| `H` | Favorite | `TODO` | ♥ | `--skr-accent` | `/` |
| `&` | Symbolism | `TODO` | § | `--skr-accent` | `/` |
| `s` | Secret | `TODO` | ◆ | `--skr-accent` | `/` |

No decoration is computed on a document line longer than 10,000 characters.
Marks, line decorations and inline widgets are windowed to visible ranges.
Table rows, math blocks and Mermaid replacements are held in a full-document
decoration field because CodeMirror requires vertical-layout decorations to
come from editor state. Expensive rendering starts only when CodeMirror mounts
the widget.

KaTeX font files are emitted as local build assets. Mermaid is a dynamic
chunk loaded by the first diagram, and neither renderer adds a remote CSP
source.
