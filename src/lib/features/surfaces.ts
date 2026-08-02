// The application surfaces (unified command surface, settings, outline)
// registered as views with their opening commands, plus the save command.
// The host maps view ids to concrete
// components; the registry knows only ids and titles.

import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

export const VIEW_COMMAND_SURFACE = "view.command-surface";
export const VIEW_SETTINGS = "view.settings";
export const VIEW_OUTLINE = "view.outline";
export const VIEW_FILE_TREE = "view.file-tree";
export const VIEW_CANVAS = "view.canvas";

/** Registers the surface views and their commands. */
export function registerSurfaces(registry: CommandRegistry): void {
  registry.registerView({
    id: VIEW_COMMAND_SURFACE,
    title: STRINGS.commandSurfaceLabel,
    kind: "overlay",
  });
  registry.registerView({
    id: VIEW_SETTINGS,
    title: STRINGS.settingsLabel,
    kind: "overlay",
  });
  registry.registerView({
    id: VIEW_OUTLINE,
    title: STRINGS.outlineLabel,
    kind: "panel",
  });
  registry.registerView({
    id: VIEW_FILE_TREE,
    title: STRINGS.vaultTreeLabel,
    kind: "panel",
  });
  registry.registerView({
    id: VIEW_CANVAS,
    title: STRINGS.canvasViewerLabel,
    kind: "content",
  });

  registry.register({
    id: "palette.open",
    title: STRINGS.commandOpenPalette,
    keybindings: ["Mod-p", "Mod-Shift-p"],
    palette: false,
    pointer: ["app-bar", "overflow-menu"],
    run: (context) => {
      context.openCommandSurface(">");
    },
  });
  registry.register({
    id: "quick-switcher.open",
    title: STRINGS.commandOpenCommandSurface,
    keybindings: ["Mod-k", "Mod-o"],
    pointer: ["app-bar", "overflow-menu", "command-palette"],
    run: (context) => {
      context.openCommandSurface("");
    },
  });
  registry.register({
    id: "vault-search.open",
    title: STRINGS.commandOpenVaultSearch,
    keybindings: ["Mod-Shift-f"],
    pointer: ["app-bar", "overflow-menu", "command-palette"],
    run: (context) => {
      context.openCommandSurface("?");
    },
  });
  registry.register({
    id: "settings.open",
    title: STRINGS.commandOpenSettings,
    keybindings: ["Mod-,"],
    pointer: ["action-menu", "command-palette"],
    run: (context) => {
      context.openView(VIEW_SETTINGS);
    },
  });
  registry.register({
    id: "outline.toggle",
    title: STRINGS.commandToggleOutline,
    keybindings: ["Mod-Shift-o"],
    pointer: ["action-menu", "command-palette"],
    run: (context) => {
      context.toggleView(VIEW_OUTLINE);
    },
  });
  registry.register({
    id: "file-tree.open",
    title: STRINGS.commandOpenFileTree,
    keybindings: ["Mod-Shift-e"],
    pointer: ["app-bar", "action-menu", "command-palette"],
    run: (context) => {
      context.openView(VIEW_FILE_TREE);
    },
  });
  registry.register({
    id: "note.create",
    title: STRINGS.commandCreateNote,
    keybindings: ["Mod-n"],
    pointer: ["action-menu", "command-palette"],
    run: (context) => context.createNote?.(),
  });
  registry.register({
    id: "note.save",
    title: STRINGS.commandSaveNote,
    keybindings: ["Mod-s"],
    scope: "editor",
    pointer: ["action-menu", "command-palette"],
    run: (context) => {
      context.requestSave();
    },
  });
  registry.register({
    id: "vault.open",
    title: STRINGS.openVault,
    pointer: ["command-palette", "overflow-menu"],
    run: (context) => {
      if (context.openVault === undefined) {
        return false;
      }
      void context.openVault();
      return true;
    },
  });
}
