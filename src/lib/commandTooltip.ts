import {
  enterMotionSurface,
  exitMotionSurface,
  hoverIntentDelay,
} from "./motion";

export type CommandTooltipOptions = {
  title: string;
  keybinding?: string;
};

let nextTooltipId = 0;

/** Attaches the shared, visual-viewport-clamped tooltip to an icon control. */
export function commandTooltip(
  node: HTMLElement,
  initialOptions: CommandTooltipOptions,
) {
  let options = initialOptions;
  let hoverTimer: ReturnType<typeof setTimeout> | null = null;
  let tooltip: HTMLDivElement | null = null;
  const tooltipId = `skr-command-tooltip-${++nextTooltipId}`;

  const hide = () => {
    if (hoverTimer !== null) clearTimeout(hoverTimer);
    hoverTimer = null;
    const visibleTooltip = tooltip;
    tooltip = null;
    if (visibleTooltip !== null) {
      void exitMotionSurface(visibleTooltip, () => visibleTooltip.remove());
    }
    node.removeAttribute("aria-describedby");
  };

  const show = () => {
    if (tooltip !== null) return;
    tooltip = document.createElement("div");
    tooltip.id = tooltipId;
    tooltip.className = "skr-command-tooltip";
    tooltip.dataset.motionStateSurface = "true";
    tooltip.setAttribute("role", "tooltip");
    const label = document.createElement("span");
    label.textContent = options.title;
    tooltip.append(label);
    if (options.keybinding !== undefined) {
      const chip = document.createElement("kbd");
      chip.textContent = options.keybinding;
      tooltip.append(chip);
    }
    document.body.append(tooltip);
    node.setAttribute("aria-describedby", tooltipId);

    const viewport = window.visualViewport;
    const leftEdge = (viewport?.offsetLeft ?? 0) + 4;
    const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 8;
    const topEdge = (viewport?.offsetTop ?? 0) + 4;
    const buttonBox = node.getBoundingClientRect();
    const tooltipBox = tooltip.getBoundingClientRect();
    const left = Math.min(
      Math.max(
        leftEdge,
        buttonBox.left + buttonBox.width / 2 - tooltipBox.width / 2,
      ),
      rightEdge - tooltipBox.width,
    );
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(topEdge, buttonBox.top - tooltipBox.height - 6)}px`;
    enterMotionSurface(tooltip);
  };

  const pointerEnter = () => {
    if (hoverTimer !== null) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(show, hoverIntentDelay());
  };
  const pointerMove = () => {
    if (tooltip !== null) return;
    if (hoverTimer !== null) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(show, hoverIntentDelay());
  };
  const focus = () => {
    if (node.matches(":focus-visible")) show();
  };

  node.addEventListener("pointerenter", pointerEnter);
  node.addEventListener("pointerleave", hide);
  node.addEventListener("pointermove", pointerMove);
  node.addEventListener("focus", focus);
  node.addEventListener("blur", hide);

  return {
    update(nextOptions: CommandTooltipOptions) {
      options = nextOptions;
      if (tooltip !== null) {
        hide();
        show();
      }
    },
    destroy() {
      node.removeEventListener("pointerenter", pointerEnter);
      node.removeEventListener("pointerleave", hide);
      node.removeEventListener("pointermove", pointerMove);
      node.removeEventListener("focus", focus);
      node.removeEventListener("blur", hide);
      hide();
    },
  };
}
