# Skribeum

A byte-faithful, local-first Markdown editor for Obsidian-compatible vaults.
Plain `.md`, `.markdown`, and `.txt` files on disk remain the source of truth;
opening and saving a file never rewrites bytes outside the edit you made.

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
surface in their familiar modes. On wide viewports, the header contains icon
buttons for note history, the note's display title, an optional read-only or
Source indicator, and one overflow button. The anchored overflow menu contains
the command aliases, file tree, outline, in-note find, settings, note creation,
saving, copy-link actions, navigation history, and vault opening.

At 60rem (960 CSS pixels) and narrower, the file tree and outline leave the
editor column and open as modal bottom sheets. The permanent top bar contains
a Files button, the current note display title, and an overflow button. The
overflow sheet provides the quick switcher, search, command palette, settings,
outline, file tree, note creation, saving, in-note find, navigation history,
and vault opening. The editor retains 24px inline gutters, which leaves 312px
for prose on a 360px viewport and 342px on a 390px viewport. Properties remain
collapsed above the note. A frontmatter `title` supplies the display title,
followed by a first-line H1 and then the file name. The properties panel
continues to identify the note by its vault path.

Every visible control accepts pointer, touch, and keyboard activation. Tab and
Shift+Tab stay inside an open modal sheet, Escape closes it, and focus returns
to the control that opened it. On narrow viewports, the command surface anchors
above the on-screen keyboard and scrolls its results internally. Keyboard
shortcuts remain visible beside command results and in selection toolbar
tooltips.

The desktop application zooms its complete webview with `mod++` and `mod+-`.
`mod+0` returns to 100 percent. Zoom is stored from 50 to 200 percent in
10 percent steps and applies to every application window. Browser builds do
not register these commands because the browser owns its own zoom shortcuts.

Packaged desktop builds register `.md`, `.markdown`, and `.txt` file handlers.
Opening a file inside the active vault keeps that vault and selects the file.
Opening a file outside the active vault opens its containing folder through
the normal vault-opening flow, then selects the file. Later open-with requests
are forwarded to the running application.

Back and forward restore each note's exact UTF-8 caret offsets,
content-anchored reading position, and properties-panel state without moving
keyboard focus into the editor. A newly opened note starts at the top with its
caret parked and the form-factor panel default. The panel starts expanded on
wide viewports and collapsed on narrow viewports.

`mod+e` toggles the active note between reading presentation and its complete
Markdown source. Source mode keeps syntax colouring but shows frontmatter,
tables, math, embeds, task markers, callouts, and other constructs as source in
the monospace face. A Source chip in the title region is the mode indicator.
The Syntax reveal setting remains independent and controls caret-based marker
reveal only in the normal reading presentation.

## Tables

Tables remain rendered while the document caret moves through the note. Click
a cell to place the caret at that text position and edit inside the grid. Arrow
keys cross cell and row boundaries, Tab and Shift+Tab move between cells, Enter
moves down the current column, and Escape returns to the document after the
table. Tab from the final cell and Enter from the final row append a padded row.
Typing a pipe stores its Markdown-safe `\|` form without changing any other
cell, delimiter, alignment marker, or existing padding.

The command surface and More actions menu contain row and column insertion and
deletion commands for the focused cell, plus `Table: edit source`. Pointer
insertion strips at the bottom and right edges append a row or column.
Extending a cell selection past its boundary selects the complete table, so
copy preserves the exact Markdown source and Delete or Backspace removes the
block. `Table: edit source` and `mod+e` are the deliberate routes to
pipe-delimited source.

## Tasks

Task markers belong to Task, Time, Importance, or Reference tracks. A short tap
advances the current track. Task cycles through Todo, Doing, and Done; Time
finishes as Done; and Importance keeps its marker while cycling the plain-text
level glyphs `⏫`, `🔼`, and `🔽`. Reference statuses follow their configured
transitions.

Hold a marker, focus it and press Arrow Down, or invoke `Task: set status` from
the command surface to open the grouped status menu. The overflow menu also
shows this command while the caret or checkbox focus is on a task line. The
deliberate route stays open for a tap or click and closes on Escape or an
outside press. Choosing a Time status opens its due-date field. A touch date
change or
Enter writes an Obsidian Tasks token such as `📅 2031-04-05` directly into the
note, while Escape applies the status without a date. Date and level tokens
render as chips, but remain ordinary Markdown source that can be edited or
deleted.

Enter at the end of a task creates another marker from the same track without
copying its payload. One immediate Backspace removes that new marker and its
spacing. At the start of existing task text, Backspace reveals and deletes the
marker one source character at a time.

Copy link to note is available from the overflow menu and command mode. Browser links use
the current absolute note URL, while desktop links use the vault's configured
note-link form. Outline rows copy heading links from their trailing action, and
command mode can copy the heading nearest the caret.

Plain HTTP and HTTPS URLs and Markdown links open in the system browser from
the desktop application. The browser demo opens the same external links in a
new tab without granting the new page access to its opener. Click a rendered
link or place the caret in its source and run Follow link. Other URL schemes
are not opened.

## Settings

Open Settings from the overflow menu or with `mod+,`. The surface is organized into
Appearance, Editor, Files and vault, Search, Updates and About. Its search box
filters settings by their names and plain-language descriptions. Every setting
is also a `>` mode action that opens this surface aligned to the matching row
with its control focused.

Appearance presents six light and dark palette cards in one chooser. Selecting
a card applies and pins its appearance. Match system appearance follows the
operating system between the last chosen light and dark palettes. Slider
readouts accept typed values for font size, line spacing and text column width,
and Mermaid diagrams use the active palette. Appearance also controls prose and
code font stacks and motion. Editor settings cover autosave, spell checking,
indentation, wrapping, line numbers, visible whitespace, Markdown source
reveal, link previews and configurable task tracks, statuses, and payloads.
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
process. See the [dependency policy](docs/dependency-policy.md) for version and
audit requirements.

## License

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at
your option.
