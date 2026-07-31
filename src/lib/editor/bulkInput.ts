import { Annotation, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

/** Minimum text size that bypasses native contenteditable insertion. */
export const BULK_TEXT_INPUT_LENGTH = 2_000;

/** Marks the single transaction produced for a large multi-line input. */
export const bulkTextInputAnnotation = Annotation.define<boolean>();

/**
 * Applies large multi-line text input as one CodeMirror transaction. Without
 * interception, an `insertText` payload lets the browser build every paragraph
 * in contenteditable before CodeMirror can reconcile the change.
 */
export function bulkTextInput(): Extension {
  return EditorView.domEventHandlers({
    beforeinput(event, view) {
      const text = event.data;
      if (
        event.inputType !== "insertText" ||
        text === null ||
        text.length < BULK_TEXT_INPUT_LENGTH ||
        (!text.includes("\n") && !text.includes("\r")) ||
        event.isComposing ||
        view.composing ||
        view.state.readOnly
      ) {
        return false;
      }
      view.dispatch({
        ...view.state.replaceSelection(text),
        annotations: bulkTextInputAnnotation.of(true),
        scrollIntoView: true,
        userEvent: "input.type",
      });
      return true;
    },
  });
}
