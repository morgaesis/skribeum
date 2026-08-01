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

## Navigation and controls

`mod+k` opens one command surface. Enter a note or file name directly, or start
the query with `>` for commands and individual settings, `#` for tags, or `?`
for note text. `mod+o`, `mod+p`, `mod+shift+p`, and `mod+shift+f` open the same
surface in their familiar modes. On wide viewports, the application bar exposes
these aliases and an Actions menu for the file tree, outline, in-note find,
settings, note creation, saving, copy-link actions, and navigation history.

At 60rem (960 CSS pixels) and narrower, the file tree and outline leave the
editor column and open as modal bottom sheets. The permanent top bar contains
a Files button, the current note title, and an overflow button. The overflow
sheet provides the quick switcher, search, command palette, settings, outline,
file tree, note creation, saving, in-note find, navigation history, and vault
opening. The editor retains 24px inline gutters, which leaves 312px for prose
on a 360px viewport and 342px on a 390px viewport. Properties remain collapsed
above the note, and raw frontmatter remains hidden until explicitly requested.

Every visible control accepts pointer, touch, and keyboard activation. Tab and
Shift+Tab stay inside an open modal sheet, Escape closes it, and focus returns
to the control that opened it. On narrow viewports, the command surface anchors
above the on-screen keyboard and scrolls its results internally. Keyboard
shortcuts remain visible beside command results and in selection toolbar
tooltips.

Copy link to note is available from Actions and command mode. Browser links use
the current absolute note URL, while desktop links use the vault's configured
note-link form. Outline rows copy heading links from their trailing action, and
command mode can copy the heading nearest the caret.

## Settings

Open Settings from Actions or with `mod+,`. The surface is organized into
Appearance, Editor, Files and vault, Search, Updates and About. Its search box
filters settings by their names and plain-language descriptions. Every setting
is also a `>` mode action that opens this surface aligned to the matching row
with its control focused.

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
