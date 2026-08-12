function focus(target: HTMLElement | null): boolean {
  if (target === null || !target.isConnected) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

/** Focuses the first stable control revealed by keyboard sidebar expansion. */
export function focusExpandedSidebarTarget(
  root: ParentNode = document,
): boolean {
  return focus(
    root.querySelector<HTMLElement>(
      '.skr-desktop-sidebar [role="treeitem"][tabindex="0"]',
    ) ??
      root.querySelector<HTMLElement>(
        '.skr-desktop-sidebar [data-command-id="note.create"]',
      ) ??
      root.querySelector<HTMLElement>(
        '.skr-desktop-sidebar [data-command-id="panel.sidebar.toggle"]',
      ),
  );
}

/** Hands focus from a removed active tab to its surviving surface. */
export function focusTabCloseSuccessor(
  pane: ParentNode,
  fallback: HTMLElement | null,
): boolean {
  return (
    focus(
      pane.querySelector<HTMLElement>(
        '[role="tab"][aria-selected="true"][tabindex="0"]',
      ),
    ) || focus(fallback)
  );
}
