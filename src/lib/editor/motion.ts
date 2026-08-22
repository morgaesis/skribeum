// Editor-surface motion: the reveal's glyph entrance and exit, and the caret.
//
// The reveal cannot express its motion in CSS alone. CodeMirror rebuilds an
// inline element whenever the decoration class over it changes, so the node
// carrying the revealed state is a different node from the one that carried
// the hidden state: it is created already in its final state, and a CSS
// transition between the two has no starting value to run from. Measured on
// the running editor, a heading marker declaring a 120ms opacity and
// translate transition went from opacity 0 to opacity 1 between two
// consecutive frames, with no transition event fired and an empty animation
// list every frame. The reveal therefore drives its motion from script, on
// the node the view has just built, in the frame the reveal changed.
//
// The timings themselves stay in the stylesheet. Every value read here comes
// from a motion-class custom property, so reduced motion and the appearance
// animations toggle zero these animations by zeroing the same tokens that
// zero every CSS transition in the product.

import type { Extension } from "@codemirror/state";
import {
  Direction,
  drawSelection,
  type EditorView,
  layer,
  RectangleMarker,
  EditorView as View,
  ViewPlugin,
} from "@codemirror/view";
import {
  motionDistance,
  motionDurationMilliseconds,
  motionEasing,
} from "../motion";

/** One motion class, resolved against the element that will animate. */
export type MotionTiming = { duration: number; easing: string };

/** The 50ms linear class: dismissals, exits, and colour shifts. */
export function stateTiming(element: Element): MotionTiming {
  return {
    duration: motionDurationMilliseconds(
      "--skr-motion-state-duration",
      element,
    ),
    easing: motionEasing("--skr-motion-state-easing", element),
  };
}

/** The 120ms class: a surface, or a glyph, arriving. */
export function surfaceTiming(element: Element): MotionTiming {
  return {
    duration: motionDurationMilliseconds(
      "--skr-motion-surface-duration",
      element,
    ),
    easing: motionEasing("--skr-motion-surface-easing", element),
  };
}

/** Marks the animations this module owns, so a retarget can cancel its own. */
const REVEAL_ANIMATION_ID = "skr-reveal";

function play(
  element: HTMLElement,
  keyframes: Keyframe[],
  timing: MotionTiming,
): Animation | null {
  if (timing.duration <= 0) return null;
  if (typeof element.animate !== "function") return null;
  for (const running of element.getAnimations?.() ?? []) {
    if (running.id === REVEAL_ANIMATION_ID) running.cancel();
  }
  const animation = element.animate(keyframes, {
    duration: timing.duration,
    easing: timing.easing,
    fill: "none",
  });
  animation.id = REVEAL_ANIMATION_ID;
  return animation;
}

/**
 * A revealed marker glyph arriving. The space it occupies was reserved in the
 * same frame the caret entered the line, with no transition of its own, so
 * this animates nothing that moves the text around it: the glyph fades in
 * while travelling the shared entrance distance from the reading direction,
 * inside geometry that has already settled.
 */
export function playGlyphEntrance(element: HTMLElement): Animation | null {
  return play(
    element,
    [
      { opacity: "0", transform: `translateX(${motionDistance(element)})` },
      { opacity: "1", transform: "translateX(0)" },
    ],
    surfaceTiming(element),
  );
}

/** The same glyph leaving, on the state clock, mirroring its own entrance. */
export function playGlyphExit(element: HTMLElement): Animation | null {
  return play(
    element,
    [
      { opacity: "1", transform: "translateX(0)" },
      { opacity: "0", transform: `translateX(${motionDistance(element)})` },
    ],
    stateTiming(element),
  );
}

/**
 * A construct swapping between its rendered and its source form. The swap
 * happens in place, so this is opacity only: a translate here would move the
 * very text the caret is sitting in.
 */
export function playFormEntrance(element: HTMLElement): Animation | null {
  return play(
    element,
    [{ opacity: "0" }, { opacity: "1" }],
    surfaceTiming(element),
  );
}

/** Set on the editor while a keystroke holds the caret solid. */
export const CARET_SOLID_CLASS = "cm-skr-caret-solid";

/** How long after the last keystroke the blink resumes, from visible. */
export function caretResumeDelay(element: Element): number {
  const value = getComputedStyle(element)
    .getPropertyValue("--skr-caret-blink-resume")
    .trim();
  if (value.endsWith("ms")) return Number.parseFloat(value);
  if (value.endsWith("s")) return Number.parseFloat(value) * 1000;
  return 0;
}

/**
 * The caret holds solid while the hand is working and resumes its blink from
 * visible once the keystrokes stop. The blink itself is a CSS animation on
 * the cursor layer; this only decides when it runs, because a caret that
 * fades out under an active cursor reads as a dropped keystroke.
 */
const caretTypingPlugin = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(readonly view: EditorView) {}

    update(update: { docChanged: boolean; selectionSet: boolean }): void {
      if (!update.docChanged && !update.selectionSet) return;
      this.view.dom.classList.add(CARET_SOLID_CLASS);
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        // Dropping the class restarts the blink animation from its first
        // keyframe, which is the visible one, so the caret never resumes
        // mid-fade.
        this.view.dom.classList.remove(CARET_SOLID_CLASS);
      }, caretResumeDelay(this.view.dom));
    }

    destroy(): void {
      if (this.timer !== null) clearTimeout(this.timer);
      this.view.dom.classList.remove(CARET_SOLID_CLASS);
    }
  },
);

/**
 * CodeMirror derives a selection rectangle's "open" edge — where a range
 * continues past the end of a wrapped or multi-line row — from `.cm-line`'s
 * own padding added to `.cm-content`'s unpadded box. This editor's reading
 * column is inset on `.cm-content` itself, so a bled construct (a code
 * block, a callout) can escape it without every line carrying its own
 * padding; CodeMirror's geometry has no way to see that inset, and draws
 * the open edge at the unpadded content edge instead, spilling the
 * highlight into the gutter. This layer replaces the stock selection layer:
 * it takes CodeMirror's own rectangles for each range and clamps their
 * horizontal extent to the reading column. Clamping only ever narrows a
 * rectangle, so within-line edges, which come from correct per-glyph
 * coordinates, pass through untouched.
 */
const SELECTION_MARKER_CLASS = "cm-selectionBackground";

/** The reading column's viewport edges: the content box inset by its own
 * padding, scaled the way marker coordinates are. */
function readingColumn(view: EditorView): { left: number; right: number } {
  const content = view.contentDOM.getBoundingClientRect();
  const style = window.getComputedStyle(view.contentDOM);
  return {
    left:
      content.left + Number.parseFloat(style.paddingLeft || "0") * view.scaleX,
    right:
      content.right -
      Number.parseFloat(style.paddingRight || "0") * view.scaleX,
  };
}

/** The origin marker coordinates are relative to, per CodeMirror's own
 * layer geometry: the scroller's scrolled-back leading edge. */
function markerBaseLeft(view: EditorView): number {
  const rect = view.scrollDOM.getBoundingClientRect();
  const left =
    view.textDirection === Direction.LTR
      ? rect.left
      : rect.right - view.scrollDOM.clientWidth * view.scaleX;
  return left - view.scrollDOM.scrollLeft * view.scaleX;
}

function clampToColumn(
  marker: RectangleMarker,
  column: { left: number; right: number },
  baseLeft: number,
): RectangleMarker {
  if (marker.width === null) return marker;
  const left = baseLeft + marker.left;
  const right = left + marker.width;
  const clampedLeft = Math.max(left, column.left);
  const clampedRight = Math.min(right, column.right);
  if (clampedLeft === left && clampedRight === right) return marker;
  return new RectangleMarker(
    SELECTION_MARKER_CLASS,
    clampedLeft - baseLeft,
    marker.top,
    Math.max(0, clampedRight - clampedLeft),
    marker.height,
  );
}

const columnSelectionLayer = layer({
  above: false,
  class: "cm-skr-selectionLayer",
  update: (update) =>
    update.docChanged ||
    update.selectionSet ||
    update.viewportChanged ||
    update.geometryChanged,
  markers(view) {
    const column = readingColumn(view);
    const baseLeft = markerBaseLeft(view);
    const markers: RectangleMarker[] = [];
    for (const range of view.state.selection.ranges) {
      if (range.empty) continue;
      for (const marker of RectangleMarker.forRange(
        view,
        SELECTION_MARKER_CLASS,
        range,
      )) {
        markers.push(clampToColumn(marker, column, baseLeft));
      }
    }
    return markers;
  },
});

/** The stock selection layer still runs under `drawSelection`, which owns
 * the cursor layer and the native-selection hiding this editor keeps; only
 * its selection rectangles are replaced, so they are not painted. */
const columnSelectionTheme = View.theme({
  ".cm-layer.cm-selectionLayer": { display: "none" },
});

/**
 * The caret: a drawn 2px bar in the caret token, blinking smoothly. The
 * platform caret cannot be styled or eased, so the editor draws its own.
 */
export function caretMotion(): Extension {
  return [
    drawSelection(),
    caretTypingPlugin,
    columnSelectionLayer,
    columnSelectionTheme,
  ];
}
