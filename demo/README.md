# Browser demo

The browser build demonstrates Skribeum's editing surface. The desktop
application is the product and keeps files on disk as the source of truth.

The demo opens with a seeded sample vault. Sample edits stay in browser memory
and are lost when the page reloads. Browsers that implement the File System
Access API can open a local folder from the Open vault empty state, overflow
menu, or command surface. The demo reads the
folder's Markdown files recursively into its in-memory vault.

The browser requests write permission when a folder opens. When permission is
granted, note saves are written back to the selected files. When permission is
unavailable or the browser cannot open a writable stream, editing continues in
memory and the notice above the editor reports that state. A failure after a
write starts is reported as a save error and leaves the edit pending in the
open editor. Browser write-through does not provide the desktop application's
crash-safe atomic write path or filesystem watcher. The browser API cannot make
the conflict check and file replacement one atomic operation, so an external
edit that lands in the final replacement window can be overwritten.

`mod+k` opens the unified command surface. Plain queries find notes, while `>`,
`#`, and `?` select commands and settings, tags, and note text. The familiar
switcher, palette, and search shortcuts open this surface with the matching
prefix. On viewports up to 60rem wide, the surface anchors to the visual
viewport above the on-screen keyboard. The top bar contains Files, the note
display title, and an overflow button. The overflow sheet provides the surface
aliases, settings, note actions, navigation history, and vault opening. The file
tree and outline appear over the editor instead of narrowing it. Modal surfaces
keep keyboard focus inside until they close and return focus to their opening
control. On wide viewports, icon-only note history and an anchored overflow
menu replace the phone controls. Copy link to note is available from either
overflow menu.

`mod+e` toggles complete Markdown source in the monospace face. The Source chip
in the title region indicates this transient mode, and the Syntax reveal
setting continues to govern caret-based marker reveal in reading presentation.

Rendered note-link previews are enabled by default. Hover a resolved note link
for 450ms, or focus it and press `P`, to open a preview rendered by the same
reading pipeline as the note. The preview remains open while the pointer
travels toward it and closes after pointer departure or with `Escape`. Slow
previews and embeds share delayed skeleton bars. The Settings view includes an
off switch.

On wide viewports, opening a second note adds tabs beneath the header. Tabs
reorder by drag and can move into a right-hand split pane. The sidebar and
outline resize from their dividers and collapse completely; their geometry,
the tree expansion, tabs, split, and pane histories belong to the vault
workspace. Narrow viewports keep one pane and expose open notes through the
command surface.

Run the demo locally with:

```sh
bun run demo:dev
```

Build its static assets with:

```sh
bun run demo:build
```
