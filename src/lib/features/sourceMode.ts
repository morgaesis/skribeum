import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

export const TOGGLE_SOURCE_MODE_COMMAND = "editor.toggle-source-mode";

/** Registers the transient document-wide source presentation command. */
export function registerSourceMode(registry: CommandRegistry): void {
  registry.register({
    id: TOGGLE_SOURCE_MODE_COMMAND,
    title: STRINGS.commandToggleSourceMode,
    keybindings: ["Mod-e"],
    pointer: ["action-menu", "command-palette"],
    run: (context) => context.toggleSourceMode?.() ?? false,
  });
}
