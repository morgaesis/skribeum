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
  registry.register({
    id: "pane.split-right",
    title: STRINGS.splitRight,
    pointer: ["action-menu", "command-palette"],
    run: (context) => context.splitPane?.(),
  });
  registry.register({
    id: "pane.focus-left",
    title: STRINGS.focusLeftPane,
    keybindings: ["Mod-Alt-ArrowLeft"],
    pointer: ["action-menu", "command-palette"],
    run: (context) => context.focusPane?.("left"),
  });
  registry.register({
    id: "pane.focus-right",
    title: STRINGS.focusRightPane,
    keybindings: ["Mod-Alt-ArrowRight"],
    pointer: ["action-menu", "command-palette"],
    run: (context) => context.focusPane?.("right"),
  });
  registry.register({
    id: "pane.move-tab",
    title: STRINGS.moveTabToOtherPane,
    pointer: ["action-menu", "command-palette"],
    run: (context) => context.moveTabToOtherPane?.(),
  });
}
