// The `format.*` commands: inline marker toggles registered with their
// keybindings and palette entries. The selection toolbar's buttons run
// exactly these commands.

import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";
import { MARKERS, type MarkerName, toggleInlineMarker } from "./formatting";

/** Registers the inline formatting commands. */
export function registerFormatting(registry: CommandRegistry): void {
  const entries: readonly {
    id: string;
    title: string;
    marker: MarkerName;
    keybindings?: readonly string[];
  }[] = [
    {
      id: "format.bold",
      title: STRINGS.formatBold,
      marker: "bold",
      keybindings: ["Mod-b"],
    },
    {
      id: "format.italic",
      title: STRINGS.formatItalic,
      marker: "italic",
      keybindings: ["Mod-i"],
    },
    {
      id: "format.code",
      title: STRINGS.formatCode,
      marker: "code",
      keybindings: ["Mod-Shift-c"],
    },
    {
      id: "format.strikethrough",
      title: STRINGS.formatStrikethrough,
      marker: "strikethrough",
      keybindings: ["Mod-Shift-x"],
    },
    {
      id: "format.wikilink",
      title: STRINGS.formatWikilink,
      marker: "wikilink",
      keybindings: ["Mod-Shift-k"],
    },
  ];
  for (const entry of entries) {
    registry.register({
      id: entry.id,
      title: entry.title,
      ...(entry.keybindings === undefined
        ? {}
        : { keybindings: entry.keybindings }),
      scope: "editor",
      pointer: ["command-palette", "selection-toolbar"],
      run: (context) => {
        const view = context.view;
        if (view === null || view.state.readOnly) {
          return false;
        }
        view.dispatch(toggleInlineMarker(view.state, MARKERS[entry.marker]));
        return true;
      },
    });
  }
}
