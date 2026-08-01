# Browser demo

The browser build demonstrates Skribeum's editing surface. The desktop
application is the product and keeps files on disk as the source of truth.

The demo opens with a seeded sample vault. Sample edits stay in browser memory
and are lost when the page reloads. Browsers that implement the File System
Access API can open a local folder from the editor header. The demo reads the
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

On viewports up to 60rem wide, the bottom action bar opens files, search, the
quick switcher, the command palette, and the Actions sheet. The file tree and
outline appear over the editor instead of narrowing it. Modal surfaces keep
keyboard focus inside until they close and return focus to their opening
control. Settings is available from Actions.

Rendered note-link previews are enabled by default. Hover a resolved note link
briefly, or focus it and press `P`, to open a preview. Pointer out and `Escape`
dismiss it. The Settings view includes an off switch.

Run the demo locally with:

```sh
bun run demo:dev
```

Build its static assets with:

```sh
bun run demo:build
```
