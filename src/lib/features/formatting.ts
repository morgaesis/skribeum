// Inline marker toggling for the selection toolbar and format commands.
// A toggle is a declared-range mutation: it inserts or deletes exactly
// the marker characters around each selection range, never rewrites the
// selected text, so the byte-fidelity gates hold over it by construction.

import type { EditorState, TransactionSpec } from "@codemirror/state";
import { EditorSelection } from "@codemirror/state";

/** One inline marker pair. */
export type InlineMarker = {
  before: string;
  after: string;
  /**
   * When true, the characters just outside a detected marker must differ
   * from the marker's own character, so toggling `*` never bites into a
   * surrounding `**`.
   */
  exclusiveBoundary?: boolean;
};

export const MARKERS = {
  bold: { before: "**", after: "**" },
  italic: { before: "*", after: "*", exclusiveBoundary: true },
  code: { before: "`", after: "`" },
  strikethrough: { before: "~~", after: "~~" },
  wikilink: { before: "[[", after: "]]" },
} as const satisfies Record<string, InlineMarker>;

export type MarkerName = keyof typeof MARKERS;

function surroundedBy(
  state: EditorState,
  from: number,
  to: number,
  marker: InlineMarker,
): boolean {
  const beforeStart = from - marker.before.length;
  const afterEnd = to + marker.after.length;
  if (beforeStart < 0 || afterEnd > state.doc.length) {
    return false;
  }
  if (
    state.doc.sliceString(beforeStart, from) !== marker.before ||
    state.doc.sliceString(to, afterEnd) !== marker.after
  ) {
    return false;
  }
  if (marker.exclusiveBoundary === true) {
    const edge = marker.before[0] ?? "";
    if (
      state.doc.sliceString(beforeStart - 1, beforeStart) === edge ||
      state.doc.sliceString(afterEnd, afterEnd + 1) === edge
    ) {
      return false;
    }
  }
  return true;
}

function wrappedInside(
  state: EditorState,
  from: number,
  to: number,
  marker: InlineMarker,
): boolean {
  const minimum = marker.before.length + marker.after.length;
  return (
    to - from >= minimum &&
    state.doc.sliceString(from, from + marker.before.length) ===
      marker.before &&
    state.doc.sliceString(to - marker.after.length, to) === marker.after
  );
}

/**
 * Builds the toggle transaction for `marker` over the current selection:
 * removes the marker pair when the range is wrapped (markers adjacent
 * outside the range, or included at its edges), inserts it otherwise. An
 * empty selection inserts the pair with the cursor between the markers.
 * Selections map so a second toggle restores the original document.
 */
export function toggleInlineMarker(
  state: EditorState,
  marker: InlineMarker,
): TransactionSpec {
  const changes = state.changeByRange((range) => {
    const { from, to } = range;
    if (surroundedBy(state, from, to, marker)) {
      return {
        changes: [
          { from: from - marker.before.length, to: from, insert: "" },
          { from: to, to: to + marker.after.length, insert: "" },
        ],
        range: EditorSelection.range(
          from - marker.before.length,
          to - marker.before.length,
        ),
      };
    }
    if (wrappedInside(state, from, to, marker)) {
      return {
        changes: [
          { from, to: from + marker.before.length, insert: "" },
          { from: to - marker.after.length, to, insert: "" },
        ],
        range: EditorSelection.range(
          from,
          to - marker.before.length - marker.after.length,
        ),
      };
    }
    return {
      changes: [
        { from, to: from, insert: marker.before },
        { from: to, to, insert: marker.after },
      ],
      range: EditorSelection.range(
        from + marker.before.length,
        to + marker.before.length,
      ),
    };
  });
  return { ...changes, userEvent: "input.format" };
}
