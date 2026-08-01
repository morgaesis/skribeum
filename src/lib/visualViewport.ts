import {
  type EditorView,
  repositionTooltips,
  tooltips,
  ViewPlugin,
} from "@codemirror/view";

export type VisualViewportRect = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
};

/** The screen area that remains usable above an on-screen keyboard. */
export function visualViewportRect(
  target: Window = window,
): VisualViewportRect {
  const viewport = target.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? target.innerWidth;
  const height = viewport?.height ?? target.innerHeight;
  return {
    top,
    right: left + width,
    bottom: top + height,
    left,
    width,
    height,
  };
}

/** Runs immediately and whenever the usable viewport moves or resizes. */
export function observeVisualViewport(
  callback: () => void,
  target: Window = window,
): () => void {
  const viewport = target.visualViewport;
  callback();
  viewport?.addEventListener("resize", callback);
  viewport?.addEventListener("scroll", callback);
  target.addEventListener("resize", callback);
  return () => {
    viewport?.removeEventListener("resize", callback);
    viewport?.removeEventListener("scroll", callback);
    target.removeEventListener("resize", callback);
  };
}

/** Publishes visual-viewport bounds for fixed Svelte and CSS surfaces. */
export function bindVisualViewportCss(
  target: Window = window,
  root: HTMLElement = document.documentElement,
): () => void {
  return observeVisualViewport(() => {
    const viewport = visualViewportRect(target);
    root.style.setProperty("--skr-visual-viewport-top", `${viewport.top}px`);
    root.style.setProperty("--skr-visual-viewport-left", `${viewport.left}px`);
    root.style.setProperty(
      "--skr-visual-viewport-width",
      `${viewport.width}px`,
    );
    root.style.setProperty(
      "--skr-visual-viewport-height",
      `${viewport.height}px`,
    );
  }, target);
}

const visualViewportTooltipListener = ViewPlugin.fromClass(
  class {
    private readonly stopObserving: () => void;

    constructor(readonly view: EditorView) {
      const target = view.dom.ownerDocument.defaultView ?? window;
      this.stopObserving = observeVisualViewport(() => {
        repositionTooltips(view);
      }, target);
    }

    destroy(): void {
      this.stopObserving();
    }
  },
);

/** Keeps every CodeMirror tooltip inside the visual viewport. */
export const visualViewportTooltips = [
  tooltips({
    tooltipSpace: (view) =>
      visualViewportRect(view.dom.ownerDocument.defaultView ?? window),
  }),
  visualViewportTooltipListener,
];
