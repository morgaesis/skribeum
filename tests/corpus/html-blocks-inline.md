# HTML blocks and inline HTML

## Block-level HTML

<div class="corpus-block">
  <p>A paragraph living inside a raw HTML block.</p>
</div>

## HTML block interrupting markdown

Text before the block.

<table>
  <tr><td>raw table cell</td></tr>
</table>

Text after the block.

## Comment block

<!-- A comment block that renderers must not display. -->

<!--
A multi-line comment
spanning three lines.
-->

## Self-closing and void elements

A horizontal rule element follows.

<hr />

An image element with attributes.

<img src="local-figure.png" alt="synthesized figure" width="120" />

## Inline HTML

A sentence with an inline <span class="marker">span element</span> in it.

A sentence with <em>inline emphasis tags</em> and <strong>inline strong tags</strong>.

A line break element<br>splits this sentence visually.

Inline <abbr title="hypertext markup language">HTML</abbr> with an attribute.

A <kbd>Ctrl</kbd>+<kbd>S</kbd> key combination in prose.

## Markdown inside inline HTML stays active

A <span>span containing *emphasized* markdown</span> per CommonMark inline rules.
