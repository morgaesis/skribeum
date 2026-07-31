# Tags

A sentence carrying a simple #woodwork tag inline.

A line ending with a tag #evening

#morning starts this line with a tag.

Nested tags use slashes: #projects/greenhouse and #projects/greenhouse/frame.

Tags with allowed punctuation: #tag-with-dash, #tag_with_underscore, #tag123.

A tag with non-ASCII letters: #verkstæði and #café-notes.

Multiple tags together: #one #two #three on a single line.

A numeric-only #2024 token is not a valid Obsidian tag; #y2024 is.

Not tags: a URL fragment https://example.com/page#section keeps its hash,
an escaped \#literal stays plain, and a heading marker below is not a tag.

# Heading, not a tag

Tags inside other constructs:

- A list item with a #listed-tag inline
> A quoted line with a #quoted-tag inline

`A code span with #not-a-tag inside` and a fence below:

```text
#not-a-tag-in-code
```
