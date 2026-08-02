import {
  type EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { type Command, keymap } from "@codemirror/view";
import { taskStatusBySymbol, taskTrackEntrySymbol } from "../taskStatuses";
import { taskStatusConfiguration } from "./decorations/engine";

// registry-exempt keydown: task marker continuation and character deletion
// are text-editing semantics, not application commands.

type InjectedMarker = {
  from: number;
  to: number;
  source: string;
};

type MarkerDeletion = {
  lineFrom: number;
  bulletFrom: number;
};

type TaskEditingState = {
  injected: InjectedMarker | null;
  deletion: MarkerDeletion | null;
};

const EMPTY_TASK_EDITING_STATE: TaskEditingState = {
  injected: null,
  deletion: null,
};
const setTaskEditingState = StateEffect.define<TaskEditingState>();

const taskEditingState = StateField.define<TaskEditingState>({
  create: () => EMPTY_TASK_EDITING_STATE,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setTaskEditingState)) {
        return effect.value;
      }
    }
    if (transaction.docChanged) {
      return EMPTY_TASK_EDITING_STATE;
    }
    if (transaction.selection !== transaction.startState.selection) {
      const range = transaction.state.selection.main;
      if (!range.empty) {
        return EMPTY_TASK_EDITING_STATE;
      }
      if (value.injected !== null && range.head === value.injected.to) {
        return value;
      }
      if (
        value.deletion !== null &&
        transaction.state.doc.lineAt(range.head).from ===
          value.deletion.lineFrom &&
        range.head > value.deletion.bulletFrom
      ) {
        return value;
      }
      return EMPTY_TASK_EDITING_STATE;
    }
    return value;
  },
});

const TASK_LINE =
  /^((?:(?:[ \t]*>[ \t]*)*)[ \t]*)([-+*]|(\d+)([.)]))([ \t]+)\[([^\]])\]([ \t]+)/u;

function taskLineMatch(state: EditorState, position: number) {
  const line = state.doc.lineAt(position);
  const match = TASK_LINE.exec(line.text);
  if (match === null || match[6] === undefined) {
    return null;
  }
  const status = taskStatusBySymbol(
    state.facet(taskStatusConfiguration),
    match[6],
  );
  return status === undefined ? null : { line, match, status };
}

const continueTaskTrack: Command = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (!range.empty) {
    return false;
  }
  const parsed = taskLineMatch(state, range.head);
  if (parsed === null || range.head !== parsed.line.to) {
    return false;
  }
  const statuses = state.facet(taskStatusConfiguration);
  const entry = taskTrackEntrySymbol(parsed.status, statuses);
  const indentation = parsed.match[1] ?? "";
  const marker = parsed.match[2] ?? "-";
  const number = parsed.match[3];
  const delimiter = parsed.match[4];
  const listMarker =
    number === undefined || delimiter === undefined
      ? marker
      : `${Number.parseInt(number, 10) + 1}${delimiter}`;
  const spacing = parsed.match[5] ?? " ";
  const continuation = `${indentation}${listMarker}${spacing}[${entry}] `;
  const inserted = `${state.lineBreak}${continuation}`;
  const from = range.head + state.lineBreak.length;
  dispatch(
    state.update({
      changes: { from: range.head, insert: inserted },
      selection: { anchor: range.head + inserted.length },
      effects: setTaskEditingState.of({
        injected: {
          from,
          to: range.head + inserted.length,
          source: continuation,
        },
        deletion: null,
      }),
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

const deleteTaskMarkerBackward: Command = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (!range.empty) {
    return false;
  }
  const editing = state.field(taskEditingState);
  const injected = editing.injected;
  if (
    injected !== null &&
    range.head === injected.to &&
    state.doc.sliceString(injected.from, injected.to) === injected.source
  ) {
    dispatch(
      state.update({
        changes: { from: injected.from, to: injected.to },
        selection: { anchor: injected.from },
        effects: setTaskEditingState.of(EMPTY_TASK_EDITING_STATE),
        userEvent: "delete.backward",
      }),
    );
    return true;
  }

  const activeDeletion = editing.deletion;
  if (
    activeDeletion !== null &&
    state.doc.lineAt(range.head).from === activeDeletion.lineFrom &&
    range.head > activeDeletion.bulletFrom
  ) {
    const from = range.head - 1;
    dispatch(
      state.update({
        changes: { from, to: range.head },
        selection: { anchor: from },
        effects: setTaskEditingState.of(
          from === activeDeletion.bulletFrom
            ? EMPTY_TASK_EDITING_STATE
            : { injected: null, deletion: activeDeletion },
        ),
        userEvent: "delete.backward",
      }),
    );
    return true;
  }

  const parsed = taskLineMatch(state, range.head);
  if (
    parsed === null ||
    range.head !== parsed.line.from + parsed.match[0].length
  ) {
    return false;
  }
  const from = range.head - 1;
  const bulletFrom = parsed.line.from + (parsed.match[1]?.length ?? 0);
  dispatch(
    state.update({
      changes: { from, to: range.head },
      selection: { anchor: from },
      effects: setTaskEditingState.of({
        injected: null,
        deletion: { lineFrom: parsed.line.from, bulletFrom },
      }),
      userEvent: "delete.backward",
    }),
  );
  return true;
};

const deleteTaskMarkerForward: Command = ({ state, dispatch }) => {
  const range = state.selection.main;
  if (!range.empty) {
    return false;
  }
  const parsed = taskLineMatch(state, range.head);
  if (parsed === null) {
    return false;
  }
  const markerOpen =
    parsed.line.from +
    (parsed.match[1]?.length ?? 0) +
    (parsed.match[2]?.length ?? 0) +
    (parsed.match[5]?.length ?? 0);
  if (range.head !== markerOpen) {
    return false;
  }
  dispatch(
    state.update({
      changes: { from: markerOpen, to: markerOpen + 1 },
      selection: { anchor: markerOpen },
      userEvent: "delete.forward",
    }),
  );
  return true;
};

/** Task continuation and character-wise marker deletion ahead of stock Markdown keys. */
export const taskEditing: Extension = [
  taskEditingState,
  Prec.highest(
    keymap.of([
      { key: "Enter", run: continueTaskTrack },
      { key: "Backspace", run: deleteTaskMarkerBackward },
      { key: "Delete", run: deleteTaskMarkerForward },
    ]),
  ),
];
