# Skribeum

A byte-faithful, local-first Markdown editor for Obsidian-compatible vaults.
Plain `.md` files on disk remain the source of truth; opening and saving a
file never rewrites bytes outside the edit you made.

The desktop application opens Obsidian-compatible vaults, preserves byte-level
file details outside edited ranges, and provides rendered Markdown editing,
search, navigation, settings, and JSON Canvas viewing. The browser demo uses a
seeded vault and can open local folders in browsers with the File System Access
API, with its storage behavior stated directly above the editor.

Development and commit history are public.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at
your option.
