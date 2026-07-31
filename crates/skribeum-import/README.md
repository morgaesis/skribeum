# skribeum-import

`skribeum-import` converts a Notion **Markdown & CSV** workspace export ZIP
into an Obsidian-compatible Markdown vault.

```console
skribeum-import notion workspace-export.zip --out my-vault
```

The importer removes Notion's trailing 32-character page IDs from file and
directory names, adds numeric suffixes when readable names collide, rewrites
local page links as wikilinks, copies attachments, and rewrites attachment
paths. CSV databases become one directory containing an index note and one
Markdown note per row. CSV values that are unambiguous booleans, numbers, ISO
dates, or ISO timestamps remain typed in YAML frontmatter. `Created time` and
`Last edited time` values become `created` and `edited` frontmatter fields when
the export contains them.

Use `--dry-run` to print the planned file, collision, and link-rewrite counts
without creating or changing files:

```console
skribeum-import notion workspace-export.zip --out my-vault --dry-run
```

An existing output directory is rejected by default. `--force` permits the
importer to overwrite files in its plan while leaving unrelated files in the
directory untouched.

The supported input is Notion's **Export all workspace content** archive in
**Markdown & CSV** format. Notion API imports, HTML exports, Confluence,
Evernote, and reconstruction of block details absent from the Markdown export
are outside this command's scope.

## License

Licensed under either of Apache License, Version 2.0 or MIT at your option.
