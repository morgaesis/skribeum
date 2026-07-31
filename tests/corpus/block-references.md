# Block references

A paragraph that carries a block identifier at its end. ^para-anchor

- A list item with its own block identifier ^item-anchor
- A second item without one
- A third item whose identifier follows ^item-anchor-three

> A quoted line holding an identifier ^quote-anchor

## Identifier on its own line after a block

The paragraph above the marker ends here.

^standalone-anchor

## Referencing the anchors

A same-file reference to [[#^para-anchor]] resolves locally.
A cross-file reference to [[block-target-note#^remote-anchor]] resolves remotely.
An embed of a block ![[block-target-note#^remote-anchor]] renders the block.

## Non-anchors

A caret in math like 2^10 is not a block identifier.
A mid-sentence ^not-an-anchor caret phrase is not an identifier either.

Table rows can carry identifiers after the table.

| Column | Value |
| ------ | ----- |
| alpha | one |

^table-anchor
