// The application surfaces (command palette, quick switcher, vault
// search, settings, outline) registered as views with their opening
// commands, plus the save command. The host maps view ids to concrete
// components; the registry knows only ids and titles.

import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

export const VIEW_COMMAND_PALETTE = "view.command-palette";
export const VIEW_QUICK_SWITCHER = "view.quick-switcher";
export const VIEW_VAULT_SEARCH = "view.vault-search";
export const VIEW_SETTINGS = "view.settings";
export const VIEW_OUTLINE = "view.outline";
export const VIEW_CANVAS = "view.canvas";

/** Registers the surface views and their commands. */
export function registerSurfaces(registry: CommandRegistry): void {
  registry.registerView({
    id: VIEW_COMMAND_PALETTE,
    title: STRINGS.commandPaletteLabel,
    kind: "overlay",
  });
  registry.registerView({
    id: VIEW_QUICK_SWITCHER,
    title: STRINGS.quickSwitcherLabel,
    kind: "overlay",
  });
  registry.registerView({
    id: VIEW_VAULT_SEARCH,
    title: STRINGS.vaultSearchLabel,
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
    id: VIEW_CANVAS,
    title: STRINGS.canvasViewerLabel,
    kind: "content",
  });

  registry.register({
    id: "palette.open",
    title: STRINGS.commandOpenPalette,
    keybindings: ["Mod-p", "Mod-Shift-p"],
    palette: false,
    run: (context) => {
      context.openView(VIEW_COMMAND_PALETTE);
    },
  });
  registry.register({
    id: "quick-switcher.open",
    title: STRINGS.commandOpenQuickSwitcher,
    keybindings: ["Mod-o"],
    run: (context) => {
      context.openView(VIEW_QUICK_SWITCHER);
    },
  });
  registry.register({
    id: "vault-search.open",
    title: STRINGS.commandOpenVaultSearch,
    keybindings: ["Mod-Shift-f"],
    run: (context) => {
      context.openView(VIEW_VAULT_SEARCH);
    },
  });
  registry.register({
    id: "settings.open",
    title: STRINGS.commandOpenSettings,
    keybindings: ["Mod-,"],
    run: (context) => {
      context.openView(VIEW_SETTINGS);
    },
  });
  registry.register({
    id: "outline.toggle",
    title: STRINGS.commandToggleOutline,
    keybindings: ["Mod-Shift-o"],
    run: (context) => {
      context.toggleView(VIEW_OUTLINE);
    },
  });
  registry.register({
    id: "note.create",
    title: STRINGS.commandCreateNote,
    keybindings: ["Mod-n"],
    run: (context) => context.createNote?.(),
  });
  registry.register({
    id: "note.save",
    title: STRINGS.commandSaveNote,
    keybindings: ["Mod-s"],
    scope: "editor",
    run: (context) => {
      context.requestSave();
    },
  });
}
