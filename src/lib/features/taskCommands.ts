// Registry commands for configured task statuses. Each command replaces only
// the source character inside the TaskMarker node under the cursor.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { taskStatusConfiguration } from "../editor/decorations/engine";
import type { Command, CommandRegistry } from "../registry";
import {
  normalizeTaskStatuses,
  type TaskStatus,
  taskStatusCommandId,
  taskStatusTrack,
  taskTrackLabel,
} from "../taskStatuses";

const taskCommandIds = new WeakMap<CommandRegistry, string[]>();

function taskAncestor(node: SyntaxNode | null): SyntaxNode | null {
  for (let current = node; current !== null; current = current.parent) {
    if (current.name === "Task") {
      return current;
    }
  }
  return null;
}

export function taskMarkerAtCursor(state: EditorState): SyntaxNode | null {
  const head = state.selection.main.head;
  const tree = syntaxTree(state);
  const task =
    taskAncestor(tree.resolveInner(head, -1)) ??
    taskAncestor(tree.resolveInner(head, 1));
  return task?.getChild("TaskMarker") ?? null;
}

export function setTaskStatusAtCursor(
  state: EditorState,
  symbol: string,
): ReturnType<EditorState["update"]> | null {
  if (
    !state
      .facet(taskStatusConfiguration)
      .some((entry) => entry.symbol === symbol)
  ) {
    return null;
  }
  const marker = taskMarkerAtCursor(state);
  if (marker === null) {
    return null;
  }
  const from = marker.from + 1;
  const to = marker.to - 1;
  if (state.doc.sliceString(from, to) === symbol) {
    return state.update({ selection: state.selection });
  }
  return state.update({
    changes: { from, to, insert: symbol },
    userEvent: "input.task-status",
  });
}

/** Replaces the registry's configured task commands without touching others. */
export function registerTaskStatusCommands(
  registry: CommandRegistry,
  statuses: readonly TaskStatus[],
): void {
  for (const id of taskCommandIds.get(registry) ?? []) {
    registry.unregister(id);
  }
  const ids: string[] = [];
  for (const status of normalizeTaskStatuses(statuses)) {
    const id = taskStatusCommandId(status.symbol);
    const command: Command = {
      id,
      title: `${taskTrackLabel(taskStatusTrack(status))}: ${status.name}`,
      scope: "editor",
      pointer: ["command-palette", "task-status-menu"],
      run: (context) => {
        const view = context.view;
        if (view === null || view.state.readOnly) {
          return false;
        }
        const transaction = setTaskStatusAtCursor(view.state, status.symbol);
        if (transaction === null) {
          return false;
        }
        view.dispatch(transaction);
        return true;
      },
    };
    registry.register(command);
    ids.push(id);
  }
  taskCommandIds.set(registry, ids);
}
