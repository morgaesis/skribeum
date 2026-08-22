// Blockquote and callout line editing: leaving a quote block, and keeping
// one quote marker where content already carries its own. Both are text
// editing semantics rather than application commands, so neither is a
// registry entry, the same exemption the task marker keys hold.

import { type Extension, Prec } from "@codemirror/state";
import { type Command, EditorView, keymap } from "@codemirror/view";

// registry-exempt keydown: leaving a quote block on Enter is text-editing
// semantics, not an application command.

/**
 * A line carrying only blockquote markers: any number of `>` levels with
 * their optional single space, and nothing after them but whitespace. The
 * capture is the marker run without that trailing whitespace.
 */
const MARKERS_ONLY_LINE = /^((?:[ \t]{0,3}>[ \t]?)+)[ \t]*$/;
/**
 * The innermost blockquote level of a marker run. The match starts at the
 * `>` itself so stepping out of `> > ` leaves `> ` rather than swallowing
 * the space that belongs to the level above it.
 */
const INNERMOST_LEVEL = />[ \t]?$/;
/** Text whose first line already opens with a blockquote marker. */
const LEADING_MARKER = /^[ \t]{0,3}>/;

/** The marker run of a line that holds nothing else, else null. */
function markersOnly(text: string): string | null {
  return MARKERS_ONLY_LINE.exec(text)?.[1] ?? null;
}

/**
 * Enter on a line that holds only quote markers leaves the block instead
 * of continuing it. One press drops the innermost level, so a nested quote
 * steps out one level at a time and a single-level quote or callout ends
 * on the first press. Stock Markdown continuation only ends a quote after
 * a second aligned empty quoted line, which leaves the following heading
 * or paragraph inside the block the reader already left.
 */
const exitQuoteBlock: Command = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (!range.empty) {
    return false;
  }
  const line = state.doc.lineAt(range.head);
  const markers = markersOnly(line.text);
  if (markers === null) {
    return false;
  }
  const remaining = markers.replace(INNERMOST_LEVEL, "");
  dispatch(
    state.update({
      changes: { from: line.from, to: line.to, insert: remaining },
      selection: { anchor: line.from + remaining.length },
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

/**
 * Whether inserting `insert` on a line reading `lineText` would double a
 * quote marker. A line holding nothing but markers is the continuation the
 * editor wrote, not something the reader typed, so quoted text inserted
 * there replaces it rather than nesting under it.
 */
export function doublesQuoteMarker(lineText: string, insert: string): boolean {
  return LEADING_MARKER.test(insert) && markersOnly(lineText) !== null;
}

/**
 * Content that already carries its own quote marker keeps exactly that
 * marker. The inserted text is never rewritten: the marker that survives
 * is the one in the source the reader supplied.
 */
function replaceRedundantMarkers(
  view: EditorView,
  insert: string,
  userEvent: string,
): boolean {
  const range = view.state.selection.main;
  if (!range.empty) {
    return false;
  }
  const line = view.state.doc.lineAt(range.head);
  if (!doublesQuoteMarker(line.text, insert)) {
    return false;
  }
  const text = view.state.toText(insert);
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: text },
    selection: { anchor: line.from + text.length },
    scrollIntoView: true,
    userEvent,
  });
  return true;
}

/**
 * The native input path's marker de-duplication, ahead of stock Markdown
 * keys. A single typed character is never "content that already carries
 * its own quote marker": after one keystroke a bare `>` is indistinguishable
 * from the reader deepening the nesting level by hand, and collapsing it
 * would eat every `>` past the first one typed at a line that currently
 * reads as markers-only. The multi-character insert an IME commit or a
 * programmatic snippet delivers in one shot is the case this guards against;
 * real pasted content goes through the paste handler below instead.
 */
export function handleQuoteInput(
  view: EditorView,
  from: number,
  to: number,
  text: string,
): boolean {
  return (
    from === to &&
    text.length > 1 &&
    replaceRedundantMarkers(view, text, "input.type")
  );
}

/** Quote-block exit and marker de-duplication, ahead of stock Markdown keys. */
export const quoteEditing: Extension = [
  Prec.highest(keymap.of([{ key: "Enter", run: exitQuoteBlock }])),
  Prec.high(
    EditorView.domEventHandlers({
      paste(event, view) {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (
          text.length === 0 ||
          !replaceRedundantMarkers(view, text, "input.paste")
        ) {
          return false;
        }
        event.preventDefault();
        return true;
      },
    }),
  ),
  Prec.highest(EditorView.inputHandler.of(handleQuoteInput)),
];
