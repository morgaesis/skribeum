import {
  EditorView,
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
      // observeVisualViewport runs its callback once synchronously to
      // establish the initial state, and that first call lands inside the
      // EditorView construction this plugin is part of. Dispatching there
      // would recurse into an update already in progress, so the initial
      // call only repositions; every later, genuinely async callback also
      // scrolls the caret back into view.
      let mounted = false;
      this.stopObserving = observeVisualViewport(() => {
        // A shrinking visual viewport (an on-screen keyboard opening) can
        // leave the caret below the editor's now-shorter scroll area.
        // Tooltip positions are anchored to the caret's document position,
        // so CodeMirror clips a tooltip whose anchor has scrolled out of
        // view: scrolling the caret back into view before repositioning is
        // what brings the tooltip back rather than leaving it hidden until
        // the next keystroke. The scroll runs only while a tooltip is
        // actually open; with none showing, a viewport event must not move
        // a reading position the person scrolled away from the caret.
        if (mounted && view.dom.querySelector(".cm-tooltip") !== null) {
          view.dispatch({
            effects: EditorView.scrollIntoView(view.state.selection.main.head, {
              y: "nearest",
            }),
          });
        }
        repositionTooltips(view);
      }, target);
      mounted = true;
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
