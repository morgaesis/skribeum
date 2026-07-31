---
title: Synthesized corpus note with frontmatter
title: Duplicate adjacent title key that YAML loaders may reject or last-wins
aliases:
  - fjörður-glósa
  - café-notat
tags:
  - corpus/frontmatter
  - próf
author: Björk Þórsdóttir
location: Reykjavík, Ísland
summary: "Ómerkileg lýsing með séríslenskum stöfum: áéíóúýðþæö"
rating: 4
published: false
created: 2024-03-01
weird spacing:    value with leading spaces preserved by some loaders
---

# Body after frontmatter

The frontmatter above contains a duplicate adjacent `title` key and
non-ASCII values, both of which the vault model must round-trip
byte-exactly regardless of how a YAML parser would interpret them.

A second thematic break below must not be treated as frontmatter.

---

Closing prose after the horizontal rule.
