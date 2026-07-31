// The registration surface's vocabulary. Every user-invocable feature
// (command, palette entry, view, keybinding, slash item) is described by
// these types and registered through the `CommandRegistry`; nothing is
// wired ad hoc. This module is the future public plugin API's contract
// (the extensibility principle publishes exactly this surface), so it
// depends on nothing but CodeMirror's view type: no components, no IPC,
// no shell state. Hosts and plugins meet only through stable string ids
// and the `CommandContext` capability interface.

import type { EditorView } from "@codemirror/view";

/**
 * The capabilities a command receives when it runs. The host (the shell
 * today, a capability-scoped broker for sandboxed plugins later) supplies
 * an implementation per invocation; commands hold no references to shell
 * internals between runs.
 */
export type CommandContext = {
  /** The active editor view, or null when no editor exists. */
  view: EditorView | null;
  /** Opens a note by vault-relative path. */
  openNote(path: string): Promise<void>;
  /** Opens the view registered under `id`. */
  openView(id: string): void;
  /** Toggles the view registered under `id`. */
  toggleView(id: string): void;
  /** Closes any open transient surface (palette, switcher, dialogs). */
  closeSurfaces(): void;
  /** Saves the open note's pending edits. */
  requestSave(): void;
  /** Vault-relative paths of every note in the open vault. */
  notePaths(): readonly string[];
  /** Recently opened note paths, most recent first. */
  recentNotePaths(): readonly string[];
};

/**
 * Where a command's keybindings bind. Global commands fire from the
 * window-level handler anywhere in the application; editor commands bind
 * inside the CodeMirror keymap and receive the view they fired in.
 */
export type CommandScope = "global" | "editor";

/**
 * One registered command. `run` returns `false` to decline (the key event
 * falls through to the next binding), anything else counts as handled.
 */
export type Command = {
  /**
   * Stable dot-namespaced identifier (`"table.row.insert-below"`).
   * Ids are the forward-compatibility contract: they never change meaning
   * once published, and everything else about a command may.
   */
  id: string;
  /** Human-readable title, shown in the palette. */
  title: string;
  /** Keybindings in CodeMirror syntax (`"Mod-p"`, `"Shift-Tab"`). */
  keybindings?: readonly string[];
  /** Binding scope; `"global"` when omitted. */
  scope?: CommandScope;
  /** Listed in the command palette unless explicitly false. */
  palette?: boolean;
  /**
   * Listed in the slash menu when present; `keywords` extend fuzzy
   * matching beyond the title.
   */
  /**
   * Slash-menu registration. `label` overrides the command title inside the
   * menu, which already sits under an insert heading: the palette needs the
   * verb ("Insert table") to be findable, the menu does not repeat it.
   */
  slash?: { keywords?: readonly string[]; label?: string };
  run(context: CommandContext): boolean | void | Promise<void>;
};

/** The kinds of surface a view occupies. */
export type ViewKind = "overlay" | "panel" | "content";

/**
 * One registered view. The registry knows views only as ids with titles;
 * the host maps ids to concrete surfaces, which is what keeps component
 * code out of the registration core.
 */
export type ViewDescriptor = {
  /** Stable dot-namespaced identifier. */
  id: string;
  /** Human-readable title. */
  title: string;
  kind: ViewKind;
};
