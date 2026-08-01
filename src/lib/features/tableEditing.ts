// Table editing commands: cell navigation on Tab/Shift-Tab and row and
// column insertion, registered through the registry (palette and slash
// entries included). Every mutation dispatches the declared spans built
// by `tableOperations`, so table edits are covered by the containment
// property over exactly what they declare.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";
import {
  editTable,
  type TableCell,
  type TableOperation,
  tableCellRanges,
} from "./tableOperations";

type TableContext = {
  /** Document offset of the table block start. */
  blockFrom: number;
  /** The table block's source text. */
  text: string;
  /** Navigable cells in traversal order, block-relative offsets. */
  cells: TableCell[];
  /** Index of the cell the cursor sits in or before. */
  currentIndex: number;
  /** Block-relative line number of the cursor. */
  currentLine: number;
};

/** The enclosing table of the primary cursor, or null. */
function tableContextAt(state: EditorState): TableContext | null {
  const head = state.selection.main.head;
  let node = syntaxTree(state).resolveInner(head, -1);
  while (node.parent !== null && node.name !== "Table") {
    node = node.parent;
  }
  if (node.name !== "Table") {
    return null;
  }
  const text = state.sliceDoc(node.from, node.to);
  const cells = tableCellRanges(text);
  const relative = head - node.from;
  let currentIndex = 0;
  for (const [index, cell] of cells.entries()) {
    if (cell.from <= relative) {
      currentIndex = index;
    }
  }
  const currentLine =
    text.slice(0, Math.max(0, relative)).split("\n").length - 1;
  return { blockFrom: node.from, text, cells, currentIndex, currentLine };
}

function moveToCell(view: EditorView, blockFrom: number, cell: TableCell) {
  view.dispatch({
    selection: { anchor: blockFrom + cell.to },
    scrollIntoView: true,
    userEvent: "select",
  });
}

function dispatchOperation(
  view: EditorView,
  context: TableContext,
  operation: TableOperation,
): boolean {
  const spans = editTable(context.text, operation);
  if (spans.length === 0) {
    return true;
  }
  view.dispatch({
    changes: spans.map((span) => ({
      from: context.blockFrom + span.from,
      to: context.blockFrom + span.to,
      insert: span.insert,
    })),
    userEvent: "input.table",
  });
  return true;
}

function nextCell(view: EditorView): boolean {
  const context = tableContextAt(view.state);
  if (context === null) {
    return false;
  }
  const following = context.cells[context.currentIndex + 1];
  if (following !== undefined) {
    moveToCell(view, context.blockFrom, following);
    return true;
  }
  // Tab past the last cell grows the table by one row.
  dispatchOperation(view, context, {
    kind: "insert-row",
    line: context.currentLine,
    position: "below",
  });
  const grown = tableContextAt(view.state);
  const target = grown?.cells.find((cell) => cell.line > context.currentLine);
  if (grown !== null && target !== undefined) {
    moveToCell(view, grown.blockFrom, target);
  }
  return true;
}

function previousCell(view: EditorView): boolean {
  const context = tableContextAt(view.state);
  if (context === null) {
    return false;
  }
  const preceding = context.cells[Math.max(0, context.currentIndex - 1)];
  if (preceding !== undefined) {
    moveToCell(view, context.blockFrom, preceding);
  }
  return true;
}

function operationCommand(operation: {
  kind: TableOperation["kind"];
  position: "above" | "below" | "before" | "after";
}): (view: EditorView) => boolean {
  return (view) => {
    const context = tableContextAt(view.state);
    if (context === null) {
      return false;
    }
    const currentColumn = context.cells[context.currentIndex]?.column ?? 0;
    const built: TableOperation =
      operation.kind === "insert-row"
        ? {
            kind: "insert-row",
            line: context.currentLine,
            position: operation.position as "above" | "below",
          }
        : {
            kind: "insert-column",
            column: currentColumn,
            position: operation.position as "before" | "after",
          };
    return dispatchOperation(view, context, built);
  };
}

/** Registers table navigation and structure commands. */
export function registerTableEditing(registry: CommandRegistry): void {
  registry.register({
    id: "table.cell.next",
    title: STRINGS.insertTable,
    keybindings: ["Tab"],
    scope: "editor",
    palette: false,
    audience: "widget",
    run: (context) => (context.view === null ? false : nextCell(context.view)),
  });
  registry.register({
    id: "table.cell.previous",
    title: STRINGS.insertTable,
    keybindings: ["Shift-Tab"],
    scope: "editor",
    palette: false,
    audience: "widget",
    run: (context) =>
      context.view === null ? false : previousCell(context.view),
  });
  const structural: readonly {
    id: string;
    title: string;
    kind: TableOperation["kind"];
    position: "above" | "below" | "before" | "after";
  }[] = [
    {
      id: "table.row.insert-below",
      title: STRINGS.tableInsertRowBelow,
      kind: "insert-row",
      position: "below",
    },
    {
      id: "table.row.insert-above",
      title: STRINGS.tableInsertRowAbove,
      kind: "insert-row",
      position: "above",
    },
    {
      id: "table.column.insert-after",
      title: STRINGS.tableInsertColumnAfter,
      kind: "insert-column",
      position: "after",
    },
    {
      id: "table.column.insert-before",
      title: STRINGS.tableInsertColumnBefore,
      kind: "insert-column",
      position: "before",
    },
  ];
  for (const entry of structural) {
    registry.register({
      id: entry.id,
      title: entry.title,
      scope: "editor",
      pointer: ["command-palette", "slash-menu"],
      slash: { keywords: ["table", "row", "column"] },
      run: (context) =>
        context.view === null
          ? false
          : operationCommand({ kind: entry.kind, position: entry.position })(
              context.view,
            ),
    });
  }
}
