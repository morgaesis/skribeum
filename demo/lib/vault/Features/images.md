---
title: Images, footnotes and rules
tags:
  - reference
---

# Images, footnotes and rules

Standard Markdown images render in the reading surface, and the source
returns whenever the caret enters it.

## Vault images

A file in the vault renders from the note's own folder:

![Three stacked note cards](skribeum-mark.svg)

An image is only ever displayed, never executed: the file reaches the page
as the source of an image element and nothing else, so a vector file in a
note carries no script, no external reference and no interactivity.

An `https` address and a `data` URL render through the same frame.

## Missing targets

A target the vault does not contain reports the failure in place instead of
leaving a gap:

![A picture that is not in this vault](no-such-picture.png)

## Footnotes

A footnote reference marks the sentence it belongs to[^measure], and the
definition carries the note itself. Activating either one travels to the
other[^travel].

[^measure]: The reading column is measured in characters, so the same
    setting holds at every font size.
[^travel]: The caret lands on the counterpart, which reveals that
    construct's source exactly as arriving by keyboard would.

---

A thematic break renders as the rule it stands for, and its source returns
when the caret reaches that line.
