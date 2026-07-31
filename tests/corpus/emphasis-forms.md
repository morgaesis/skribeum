# Emphasis forms

Plain sentence with *asterisk italics* in the middle.

Plain sentence with _underscore italics_ in the middle.

Strong with **double asterisks** and strong with __double underscores__.

Combined ***bold italic asterisks*** and ___bold italic underscores___.

Nested forms: **bold containing *italic* inside** and *italic containing **bold** inside*.

Mixed delimiters: **bold containing _underscore italic_ inside**.

Strikethrough uses ~~two tildes around the span~~ in extended markdown.

Highlight uses ==two equals signs around the span== in Obsidian.

Intraword underscores like snake_case_name should not open emphasis.

Intraword asterisks like odd*star*case do open emphasis per CommonMark.

Escaped markers stay literal: \*not italic\* and \_not italic\_ and \~\~not struck\~\~.

A lone * asterisk and a lone _ underscore with spaces stay literal.

Emphasis across
a soft line break *keeps
working* in one paragraph.
