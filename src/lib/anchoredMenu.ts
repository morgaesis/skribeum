// Shared placement and dismissal engine for every transient, anchored menu
// and popover in the product: the tab strip's "all tabs" list, the header
// overflow menu, file tree row actions, and the task status control on a
// task checkbox. Each surface used to reinvent its own flip-to-fit math and
// its own (sometimes missing) outside-dismiss wiring; this module is the one
// place that logic lives, so every menu gets the same guarantees. It is
// framework-agnostic on purpose: the CodeMirror-hosted task status control
// is plain DOM, not a Svelte component, and consumes these functions
// directly, while chrome menus reach them through `AnchoredMenu.svelte`.
//
// registry-exempt keydown: Escape here is the ARIA menu pattern's own
// dismissal, internal to whichever menu surface attaches this helper, not
// a user-invocable command.

export type ViewportRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type AnchorRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type MenuSize = { width: number; height: number };

export type AnchoredPosition = {
  left: number;
  top: number;
  /** Which side of the anchor the menu actually landed on. */
  placement: "below" | "above";
  /** Remaining room on the chosen side, for the menu's own internal scroll. */
  maxHeight: number;
};

const DEFAULT_GAP = 4;
const DEFAULT_INSET = 8;

/**
 * Places a menu against its anchor: below and left-aligned by default,
 * flipping above when the space below cannot hold it and the space above
 * is larger. The result is always clamped inside the given viewport, both
 * axes, so the menu never renders off-screen or under a keyboard.
 */
export function computeAnchoredPosition(
  anchor: AnchorRect,
  menu: MenuSize,
  viewport: ViewportRect,
  options: { gap?: number; inset?: number; align?: "start" | "end" } = {},
): AnchoredPosition {
  const gap = options.gap ?? DEFAULT_GAP;
  const inset = options.inset ?? DEFAULT_INSET;
  const align = options.align ?? "start";

  const maximumLeft = Math.max(
    viewport.left + inset,
    viewport.right - menu.width - inset,
  );
  const anchorX = align === "end" ? anchor.right - menu.width : anchor.left;
  const left = Math.min(Math.max(anchorX, viewport.left + inset), maximumLeft);

  const spaceBelow = viewport.bottom - anchor.bottom - gap;
  const spaceAbove = anchor.top - gap - viewport.top;

  if (spaceBelow >= menu.height || spaceBelow >= spaceAbove) {
    return {
      left,
      top: anchor.bottom + gap,
      placement: "below",
      maxHeight: Math.max(0, viewport.bottom - (anchor.bottom + gap) - inset),
    };
  }
  return {
    left,
    top: Math.max(viewport.top + inset, anchor.top - gap - menu.height),
    placement: "above",
    maxHeight: Math.max(0, spaceAbove - inset),
  };
}

export type MenuDismissalOptions = {
  onDismiss: () => void;
  /** Elements that count as "inside" for outside-press detection, besides the surface itself (the invoking control, most often). */
  ignore?: readonly (HTMLElement | null | undefined)[];
  /** Close on Escape, keyed on the surface itself. Defaults to true. */
  escape?: boolean;
  /** Close when the window loses focus: alt-tab, devtools, another app. Defaults to true. */
  blur?: boolean;
  ownerDocument?: Document;
  ownerWindow?: Window;
};

/**
 * Wires the three dismissal guarantees every anchored menu makes: a
 * capture-phase pointerdown outside the surface (so a press that opens a
 * different control cannot leave this one stuck open behind it), Escape,
 * and window blur. Returns a cleanup function.
 */
export function attachMenuDismissal(
  surface: HTMLElement,
  options: MenuDismissalOptions,
): () => void {
  const doc = options.ownerDocument ?? surface.ownerDocument ?? document;
  const win = options.ownerWindow ?? doc.defaultView ?? window;
  const dismissOnEscape = options.escape ?? true;
  const dismissOnBlur = options.blur ?? true;
  const ignore = options.ignore ?? [];

  const isInside = (target: EventTarget | null): boolean => {
    if (!(target instanceof Node)) return false;
    if (surface.contains(target)) return true;
    return ignore.some((element) => element?.contains(target));
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!isInside(event.target)) options.onDismiss();
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      options.onDismiss();
    }
  };
  const onBlur = () => options.onDismiss();

  doc.addEventListener("pointerdown", onPointerDown, true);
  if (dismissOnEscape) surface.addEventListener("keydown", onKeydown);
  if (dismissOnBlur) win.addEventListener("blur", onBlur);

  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    if (dismissOnEscape) surface.removeEventListener("keydown", onKeydown);
    if (dismissOnBlur) win.removeEventListener("blur", onBlur);
  };
}

const ROW_SELECTOR =
  '[role="menuitem"], [role="menuitemradio"], [role="option"]';

/** The actionable rows inside an open menu surface, in document order. */
export function menuRows(surface: HTMLElement): HTMLElement[] {
  return [...surface.querySelectorAll<HTMLElement>(ROW_SELECTOR)].filter(
    (row) => !row.hasAttribute("disabled"),
  );
}

/**
 * Arrow-key, Home, and End roving focus across a menu's actionable rows.
 * Enter and Space activate through the browser's native button behavior,
 * so this only ever moves focus. Returns true when it handled the key.
 */
export function moveMenuFocus(surface: HTMLElement, key: string): boolean {
  const rows = menuRows(surface);
  if (rows.length === 0) return false;
  const current = rows.indexOf(document.activeElement as HTMLElement);
  let next: number;
  switch (key) {
    case "ArrowDown":
      next = current < 0 ? 0 : (current + 1) % rows.length;
      break;
    case "ArrowUp":
      next =
        current < 0
          ? rows.length - 1
          : (current - 1 + rows.length) % rows.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = rows.length - 1;
      break;
    default:
      return false;
  }
  rows[next]?.focus();
  return true;
}
