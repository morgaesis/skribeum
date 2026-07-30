# Links and reference definitions

## Inline links

An [inline link](https://example.com/path) in a sentence.
An [inline link with title](https://example.com/other "Example title") follows.
A relative [inline link](../sibling/page.md) to a path.

## Full reference links

A [full reference link][refone] resolves through its label.
A second use of [the same label][refone] shares the definition.

## Collapsed and shortcut reference links

A [collapsed reference][] link uses its own text as label.
A shortcut reference to [refthree] works when the label is defined.

## Wikilink and reference definition with the same label

The wikilink [[Foo]] must remain a wikilink even though a reference
definition for the label Foo exists below. The bracketed form [Foo]
is a shortcut reference link to that definition, which is the ambiguity
this file exists to pin down.

## Link with escaped brackets

A sentence with \[literal brackets\] that are not a link.

## Definitions

[refone]: https://example.com/refone
[collapsed reference]: https://example.com/collapsed
[refthree]: https://example.com/refthree "Third definition title"
[Foo]: https://example.com/foo-definition

[unused-definition]: https://example.com/never-referenced
