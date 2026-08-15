import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

function withTreePath(
  path: string | undefined,
  action: (path: string) => Promise<void> | void,
): false | void | Promise<void> {
  return path === undefined ? false : action(path);
}

/** Registers tree, panel, tab, and split-pane commands. */
export function registerWorkspaceCommands(
  registry: CommandRegistry,
  desktop: boolean,
): void {
  registry.register({
    id: "tree.note.create",
    title: STRINGS.treeCreateNote,
    palette: false,
    pointer: ["action-menu"],
    run: (context) =>
      withTreePath(
        context.treePath,
        (path) => context.createTreeNote?.(path) ?? Promise.resolve(),
      ),
  });
  registry.register({
    id: "tree.folder.create",
    title: STRINGS.treeCreateFolder,
    palette: false,
    pointer: ["action-menu"],
    run: (context) =>
      withTreePath(
        context.treePath,
        (path) => context.createTreeFolder?.(path) ?? Promise.resolve(),
      ),
  });
  registry.register({
    id: "tree.entry.rename",
    title: STRINGS.treeRename,
    palette: false,
    pointer: ["action-menu"],
    run: (context) =>
      withTreePath(
        context.treePath,
        (path) =>
          context.renameTreeEntry?.(path, context.restoreTreeFocus) ??
          Promise.resolve(),
      ),
  });
  registry.register({
    id: "tree.entry.delete",
    title: STRINGS.treeDelete,
    palette: false,
    pointer: ["action-menu"],
    run: (context) =>
      withTreePath(
        context.treePath,
        (path) =>
          context.deleteTreeEntry?.(path, context.restoreTreeFocus) ??
          Promise.resolve(),
      ),
  });
  registry.register({
    id: "tree.entry.move",
    title: STRINGS.treeMove,
    palette: false,
    pointer: ["action-menu"],
    run: (context) =>
      withTreePath(
        context.treePath,
        (path) =>
          context.moveTreeEntry?.(path, context.treeDestination ?? null) ??
          Promise.resolve(),
      ),
  });
  registry.register({
    id: "tree.note.open-in-new-tab",
    title: STRINGS.openInNewTab,
    palette: false,
    pointer: ["action-menu"],
    run: (context) =>
      withTreePath(
        context.treePath,
        (path) => context.openNoteInNewTab?.(path) ?? Promise.resolve(),
      ),
  });
  registry.register({
    id: "tree.note.copy-link",
    title: STRINGS.treeCopyLink,
    palette: false,
    pointer: ["action-menu"],
    run: (context) =>
      withTreePath(
        context.treePath,
        (path) => context.copyTreeNoteLink?.(path) ?? Promise.resolve(),
      ),
  });
  if (desktop) {
    registry.register({
      id: "tree.entry.reveal",
      title: STRINGS.treeReveal,
      palette: false,
      pointer: ["action-menu"],
      run: (context) =>
        withTreePath(
          context.treePath,
          (path) => context.revealTreeEntry?.(path) ?? Promise.resolve(),
        ),
    });
  }

  registry.register({
    id: "panel.sidebar.toggle",
    title: STRINGS.toggleSidebar,
    keybindings: ["Mod-\\"],
    pointer: ["app-bar", "action-menu", "command-palette"],
    run: (context) => context.togglePanel?.("sidebar"),
  });
  registry.register({
    id: "panel.outline.toggle",
    title: STRINGS.toggleOutline,
    keybindings: ["Mod-Shift-\\"],
    pointer: ["app-bar", "action-menu", "command-palette"],
    run: (context) => context.togglePanel?.("outline"),
  });

  registry.register({
    id: "tab.new",
    title: STRINGS.newTab,
    keybindings: ["Mod-t"],
    pointer: ["action-menu", "command-palette"],
    run: (context) => context.createTab?.(),
  });
  registry.register({
    id: "tab.close",
    title: STRINGS.closeTab,
    keybindings: ["Mod-w"],
    pointer: ["action-menu", "command-palette"],
    run: (context) => context.closeTab?.(),
  });
  registry.register({
    id: "tab.reopen-closed",
    title: STRINGS.reopenClosedTab,
    keybindings: ["Mod-Shift-t"],
    pointer: ["action-menu", "command-palette"],
    run: (context) => context.reopenClosedTab?.(),
  });
  registry.register({
    id: "tab.next",
    title: STRINGS.nextTab,
    keybindings: ["Ctrl-Tab"],
    pointer: ["action-menu", "command-palette"],
    run: (context) => context.cycleTab?.(1),
  });
  registry.register({
    id: "tab.previous",
    title: STRINGS.previousTab,
    keybindings: ["Ctrl-Shift-Tab"],
    pointer: ["action-menu", "command-palette"],
    run: (context) => context.cycleTab?.(-1),
  });
  for (let index = 1; index <= 9; index += 1) {
    registry.register({
      id: `tab.activate-${index}`,
      title: `${STRINGS.activateTab} ${index}`,
      keybindings: [`Mod-${index}`],
      palette: false,
      pointer: ["action-menu"],
      run: (context) => context.activateTab?.(index === 9 ? "last" : index - 1),
    });
  }
  const paneDirections = [
    {
      side: "up",
      split: STRINGS.splitUp,
      focus: STRINGS.focusPaneAbove,
      move: STRINGS.moveTabToPaneAbove,
      key: "Mod-Alt-ArrowUp",
    },
    {
      side: "down",
      split: STRINGS.splitDown,
      focus: STRINGS.focusPaneBelow,
      move: STRINGS.moveTabToPaneBelow,
      key: "Mod-Alt-ArrowDown",
    },
    {
      side: "left",
      split: STRINGS.splitLeft,
      focus: STRINGS.focusLeftPane,
      move: STRINGS.moveTabToPaneLeft,
      key: "Mod-Alt-ArrowLeft",
    },
    {
      side: "right",
      split: STRINGS.splitRight,
      focus: STRINGS.focusRightPane,
      move: STRINGS.moveTabToPaneRight,
      key: "Mod-Alt-ArrowRight",
    },
  ] as const;
  for (const direction of paneDirections) {
    registry.register({
      id: `pane.split-${direction.side}`,
      title: direction.split,
      pointer: ["action-menu", "command-palette"],
      run: (context) => context.splitPane?.(direction.side),
    });
    registry.register({
      id: `pane.focus-${direction.side}`,
      title: direction.focus,
      keybindings: [direction.key],
      pointer: ["action-menu", "command-palette"],
      run: (context) => context.focusPane?.(direction.side),
    });
    registry.register({
      id: `pane.move-tab-${direction.side}`,
      title: direction.move,
      pointer: ["action-menu", "command-palette"],
      run: (context) => context.moveTabToPane?.(direction.side),
    });
  }
}
