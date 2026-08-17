import { showConfirmDialog, showPromptDialog } from "../dialogs";
import { currentWikilinkContext } from "../editor/decorations/engine";
import type { CommandContext, CommandRegistry } from "../registry";
import { formatString, STRINGS } from "../strings";
import { type LinkUpdateSummary, planLinkUpdates } from "./links";

/** The parent folder of a vault path, empty for a vault-root entry. */
function parentFolder(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

/** Every folder in the vault, derived from the indexed note paths. */
function vaultFolders(paths: readonly string[]): Set<string> {
  const folders = new Set<string>([""]);
  for (const path of paths) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      folders.add(segments.slice(0, depth).join("/"));
    }
  }
  return folders;
}

/**
 * The sentence shown before a move writes anything: how many other notes it
 * rewrites and which, or that it rewrites none. Naming them is the point;
 * a rename that edits notes the person did not open has to say so first.
 */
export function linkUpdateDescription(
  updates: readonly LinkUpdateSummary[],
): string {
  if (updates.length === 0) {
    return STRINGS.linkUpdateNone;
  }
  const heading =
    updates.length === 1
      ? STRINGS.linkUpdateOne
      : formatString(STRINGS.linkUpdateMany, { notes: updates.length });
  return [heading, ...updates.map((update) => update.path)].join("\n");
}

/**
 * Asks before a move writes. Returns false when the person declines, so a
 * rename that would edit other notes can be called off while every file is
 * still exactly as they left it.
 */
async function confirmMove(
  context: CommandContext,
  title: string,
  from: string,
  to: string,
): Promise<boolean> {
  const view = context.view;
  const updates =
    view === null
      ? []
      : await planLinkUpdates(currentWikilinkContext(view.state), from, to);
  return showConfirmDialog({
    title,
    message: linkUpdateDescription(updates),
    confirmLabel: title,
  });
}

/**
 * The entry a contextual tree command acts on: the row that opened a tree
 * menu, or the note the reader is in when the command comes from a surface
 * that has no row, such as the header menu or the palette.
 */
function targetEntry(context: CommandContext): string | undefined {
  if (context.treePath !== undefined) {
    return context.treePath;
  }
  const view = context.view;
  return view === null
    ? undefined
    : (currentWikilinkContext(view.state).currentPath ?? undefined);
}

/**
 * Waits for the surface that invoked a command to finish dismissing. A menu
 * returns focus to the control that opened it as it closes, which would
 * otherwise pull focus straight back out of a dialog opened in the same
 * turn and leave the reader typing into nothing.
 */
function afterInvokingSurfaceCloses(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * Runs the move: the destination folder comes from a drag when there is
 * one, and is asked for otherwise, so the command works from every surface
 * that offers it rather than only from a drag.
 */
async function runMove(context: CommandContext): Promise<void> {
  const path = targetEntry(context);
  if (path === undefined) {
    return;
  }
  const folders = vaultFolders(context.notePaths());
  let destination = context.treeDestination ?? null;
  if (context.treeDestination === undefined) {
    await afterInvokingSurfaceCloses();
    const entered = await showPromptDialog({
      title: STRINGS.treeMove,
      inputLabel: STRINGS.treeMoveDestinationPrompt,
      initialValue: parentFolder(path),
      confirmLabel: STRINGS.treeMove,
      validate: (value) =>
        folders.has(value.trim().replace(/^\/+|\/+$/g, ""))
          ? null
          : STRINGS.treeMoveUnknownFolder,
    });
    if (entered === null) {
      return;
    }
    destination = entered.trim().replace(/^\/+|\/+$/g, "");
  }
  const name = path.split("/").at(-1) ?? path;
  const target =
    destination === null || destination === ""
      ? name
      : `${destination}/${name}`;
  if (target === path) {
    return;
  }
  if (!(await confirmMove(context, STRINGS.treeMove, path, target))) {
    return;
  }
  await context.moveTreeEntry?.(path, destination);
}

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
    run: (context) => runMove(context),
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
