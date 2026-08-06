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
  /** Creates and opens a note in the configured default folder. */
  createNote?(): Promise<void>;
  /** Opens the platform vault picker. */
  openVault?(): Promise<void> | void;
  /** Opens the view registered under `id`. */
  openView(id: string): void;
  /** Opens the unified command surface with an optional prefix preloaded. */
  openCommandSurface(initialQuery: string): void;
  /** Opens settings aligned to one registered setting row. */
  openSetting?(id: string): void;
  /** Toggles the view registered under `id`. */
  toggleView(id: string): void;
  /** Closes any open transient surface (command surface or dialog). */
  closeSurfaces(): void;
  /** Saves the open note's pending edits. */
  requestSave(): void;
  /** Confirms and clears the open note's persisted edit history. */
  clearEditHistory?(): Promise<void>;
  /** Vault-relative paths of every note in the open vault. */
  notePaths(): readonly string[];
  /** Recently opened note paths, most recent first. */
  recentNotePaths(): readonly string[];
  /** Moves to the previous note address, declining when none exists. */
  navigateBack(): boolean;
  /** Moves to the next note address, declining when none exists. */
  navigateForward(): boolean;
  /** Follows the wikilink under the editor cursor, declining outside one. */
  followLink(view?: EditorView | null): boolean;
  /** Copies a link to the active note. */
  copyNoteLink?(): Promise<void>;
  /** Copies the active note's stable public permalink, allocating its id. */
  copyPermalink?(): Promise<void>;
  /** Tree row targeted by a contextual command. */
  treePath?: string;
  /** Folder targeted by a tree move, or null for the vault root. */
  treeDestination?: string | null;
  /** Creates a note inside a named folder. */
  createTreeNote?(folder: string): Promise<void>;
  /** Creates a folder inside a named folder. */
  createTreeFolder?(folder: string): Promise<void>;
  /** Renames one vault entry. */
  renameTreeEntry?(path: string): Promise<void>;
  /** Deletes one vault entry after confirmation. */
  deleteTreeEntry?(path: string): Promise<void>;
  /** Moves one vault entry into a folder or the vault root. */
  moveTreeEntry?(path: string, destination: string | null): Promise<void>;
  /** Copies a stable link to a tree note. */
  copyTreeNoteLink?(path: string): Promise<void>;
  /** Reveals one vault entry in the system file manager. */
  revealTreeEntry?(path: string): Promise<void>;
  /** Toggles one wide-viewport panel. */
  togglePanel?(panel: "sidebar" | "outline"): void;
  /** Opens a new untitled tab. */
  createTab?(): Promise<void>;
  /** Closes or reopens the active tab. */
  closeTab?(): void | Promise<void>;
  reopenClosedTab?(): Promise<void>;
  /** Cycles or activates tabs in the focused pane. */
  cycleTab?(direction: -1 | 1): void;
  activateTab?(index: number | "last"): void;
  /** Creates and controls the second editor pane. */
  splitPane?(): void | Promise<void>;
  focusPane?(direction: "left" | "right"): void;
  moveTabToOtherPane?(): void | Promise<void>;
  /** Copies a link to a named heading, or the heading nearest the caret. */
  copyHeadingLink?(heading?: string): Promise<void>;
  /** Toggles the active note's transient whole-document source presentation. */
  toggleSourceMode?(): boolean;
  /** Opens the note-statistics surface for the active note. */
  openNoteStatistics?(): void;
  /** Starts the add-property flow in the active note's properties panel. */
  addProperty?(): void;
  /** Task marker selected when a command surface opened, if any. */
  taskStatusMarkerFrom?: number | null;
  /** Applies one persisted desktop webview zoom action. */
  changeApplicationZoom?: (action: "in" | "out" | "reset") => Promise<void>;
  /** An explicit heading supplied by an outline-row pointer action. */
  heading?: string;
};

/**
 * Where a command's keybindings bind. Global commands fire from the
 * window-level handler anywhere in the application; editor commands bind
 * inside the CodeMirror keymap and receive the view they fired in.
 */
export type CommandScope = "global" | "editor";

/** Who invokes a command and whether it belongs on user action surfaces. */
export type CommandAudience = "user" | "widget" | "developer";

/** A visible pointer surface that invokes a user command. */
export type PointerSurface =
  | "app-bar"
  | "command-palette"
  | "action-menu"
  | "overflow-menu"
  | "editor-link"
  | "editor-tag"
  | "find-panel"
  | "outline"
  | "selection-toolbar"
  | "slash-menu"
  | "task-status-menu";

/**
 * One registered command. `run` returns `false` to decline (the key event
 * falls through to the next binding), anything else counts as handled.
 */
type CommandBase = {
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
  /** Result subtype used to break command-surface score ties. */
  kind?: "command" | "setting";
  /** Additional searchable text that is not displayed as the title. */
  searchTerms?: readonly string[];
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

/**
 * User commands declare every pointer surface that can invoke them. Widget
 * commands are internal ARIA interactions, while developer commands are
 * intentionally absent from product surfaces.
 */
export type Command = CommandBase &
  (
    | {
        audience?: "user";
        pointer: readonly PointerSurface[];
      }
    | {
        audience: "widget" | "developer";
        pointer?: readonly PointerSurface[];
      }
  );

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
