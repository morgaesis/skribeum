# Decoration rules

The live-preview decoration engine is data-driven: one table in
`src/lib/editor/decorations/table.ts` maps Lezer markdown node names to
presentation and cursor-reveal behavior, and the engine in
`src/lib/editor/decorations/engine.ts` interprets rows without knowing any
construct by name. The table below mirrors that file row for row;
`tests/web/decorationRules.test.ts` asserts the two stay identical and
carries a behavioral reveal test for every row.

Reveal policies:

- **cursor-inside**: hidden or replaced text returns as plain source, and
  receded source styling clears, while any selection endpoint touches the
  enclosing construct.
- **cursor-line**: the hidden text returns while any selection endpoint
  touches a document line the enclosing construct covers.
- **never**: the decoration applies regardless of the cursor. Rows that
  only style (marks, line classes) reveal nothing and are `never` by
  construction.

The Context column restricts a row: `parent=` requires one of the listed
direct parents, `notParent=` excludes them, `ancestor=` requires an
enclosing node, `withSibling=`/`withoutSibling=` condition on a sibling
node under the same parent, and `codeInfo=` matches the first fenced-code
info token case-insensitively. `-` means the row applies to every node of
that name.

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
| `Blockquote` | `-` | `widget callout` | cursor-inside |
| `Blockquote` | `-` | `line cm-skr-blockquote` | never |
| `QuoteMark` | `-` | `mark cm-skr-quote-mark` | never |
| `CalloutMark` | `ancestor=Blockquote` | `mark cm-skr-callout-mark` | never |
| `CalloutType` | `ancestor=Blockquote` | `mark cm-skr-callout-type` | never |
| `HashTag` | `-` | `mark cm-skr-tag` | never |
| `BlockId` | `-` | `mark cm-skr-block-id` | never |
| `Frontmatter` | `-` | `line cm-skr-frontmatter` | never |

Context-dependent attributes come from five documented engine builtins a
row opts into: `wikilink-resolution` stamps `data-resolved` from the vault
tree (unresolved links style distinctly), `callout-type` stamps
`data-callout` and the `cm-skr-callout` line class when a blockquote is
headed by a callout mark, while `rich-callout` limits the replacement widget
to those blockquotes. `code-language` stamps `data-language` from the fence
info string. `mermaid-block` restricts the diagram widget to a Mermaid fence
and stamps its language attribute.

No decoration is computed on a document line longer than 10,000 characters.
Marks and inline widgets are windowed to visible ranges. Table rows, rich
callouts, math blocks and Mermaid replacements are held in a full-document
decoration field because CodeMirror requires vertical-layout decorations to
come from editor state. Expensive rendering starts only when CodeMirror mounts
the widget.

KaTeX font files are emitted as local build assets. Mermaid is a dynamic
chunk loaded by the first diagram, and neither renderer adds a remote CSP
source.
