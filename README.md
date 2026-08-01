# Skribeum

A byte-faithful, local-first Markdown editor for Obsidian-compatible vaults.
Plain `.md` files on disk remain the source of truth; opening and saving a
file never rewrites bytes outside the edit you made.

The desktop application opens Obsidian-compatible vaults, preserves byte-level
file details outside edited ranges, and provides rendered Markdown editing,
search, navigation, settings, and JSON Canvas viewing. The browser demo uses a
seeded vault and can open local folders in browsers with the File System Access
API, with its storage behavior stated directly above the editor.

Skribeum is pre-alpha software and has not received an independent security
audit. Use it only with files that are backed up and versioned.

## Settings

Open Settings with `mod+,`. The surface is organized into Appearance, Editor,
Files and vault, Search, Updates and About. Its search box filters settings by
their names and plain-language descriptions.

Appearance controls the light, dark or system theme, separate named palettes
for light and dark modes, prose and code font stacks, font size, line spacing,
text column width and motion. Editor
settings cover autosave, spell checking, indentation, wrapping, line numbers,
visible whitespace, Markdown source reveal, link previews and configurable task
statuses.
Files and vault settings control
the folder used by the `Create new note` command, attachment resolution and
compatible Obsidian configuration. Search settings control result count, title
or full-text scope and case sensitivity. Updates selects the stable or beta
channel and checks signed manifests, with stable fallback when no beta is
published.

Settings live in the operating system's application configuration directory,
outside every vault. Unknown keys survive writes so a newer settings document
can still be used by an older build.

Development and commit history are public.
See [SECURITY](SECURITY.md) for the security scope and vulnerability reporting
process.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at
your option.
