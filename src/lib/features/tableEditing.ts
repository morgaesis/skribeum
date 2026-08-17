import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import {
  blurRenderedTableCell,
  closeRenderedTableSource,
  editRenderedTableSource,
  explicitTableSource,
  focusedRenderedTableCell,
  focusRenderedTableCell,
} from "../editor/decorations/engine";
import type { CommandContext, CommandRegistry } from "../registry";
import { STRINGS } from "../strings";
import {
  editTable,
  extendedTableDocumentEnd,
  type TableCell,
  type TableOperation,
  tableCellRanges,
} from "./tableOperations";

type TableContext = {
  blockFrom: number;
  text: string;
  cells: TableCell[];
  currentIndex: number;
  currentLine: number;
  currentRow: number;
  currentColumn: number;
};

function enclosingTable(node: SyntaxNode | null): SyntaxNode | null {
  for (let current = node; current !== null; current = current.parent) {
    if (current.name === "Table") {
      return current;
    }
  }
  return null;
}

function tableNodeAt(state: EditorState, position: number): SyntaxNode | null {
  const direct =
    enclosingTable(syntaxTree(state).resolveInner(position, -1)) ??
    enclosingTable(syntaxTree(state).resolveInner(position, 1));
  if (direct !== null) {
    return direct;
  }
  let lineNumber = state.doc.lineAt(position).number;
  while (lineNumber >= 1) {
    const line = state.doc.line(lineNumber);
    const text = line.text.trim();
    if (!text.startsWith("|") || !text.endsWith("|")) {
      return null;
    }
    const candidate =
      enclosingTable(syntaxTree(state).resolveInner(line.from, 1)) ??
      enclosingTable(syntaxTree(state).resolveInner(line.to, -1));
    if (
      candidate !== null &&
      extendedTableEnd(state, candidate.from, candidate.to) >= position
    ) {
      return candidate;
    }
    lineNumber -= 1;
  }
  return null;
}

function extendedTableEnd(
  state: EditorState,
  tableFrom: number,
  tableTo: number,
): number {
  return extendedTableDocumentEnd(state.doc, tableFrom, tableTo);
}

/** The active rendered table, or the table containing the host caret. */
function tableContextAt(
  state: EditorState,
  view?: EditorView,
): TableContext | null {
  const focused = view === undefined ? null : focusedRenderedTableCell(view);
  const node = tableNodeAt(
    state,
    focused?.tableFrom ?? state.selection.main.head,
  );
  if (node === null) {
    return null;
  }
  const blockTo = extendedTableEnd(state, node.from, node.to);
  const text = state.sliceDoc(node.from, blockTo);
  const cells = tableCellRanges(text);
  const relative = state.selection.main.head - node.from;
  let currentIndex = 0;
  if (focused !== null) {
    currentIndex = Math.max(
      0,
      cells.findIndex(
        (cell) => cell.row === focused.row && cell.column === focused.column,
      ),
    );
  } else {
    for (const [index, cell] of cells.entries()) {
      if (cell.from <= relative) {
        currentIndex = index;
      }
    }
  }
  const current = cells[currentIndex];
  return {
    blockFrom: node.from,
    text,
    cells,
    currentIndex,
    currentLine:
      current?.line ??
      text.slice(0, Math.max(0, relative)).split("\n").length - 1,
    currentRow: current?.row ?? 0,
    currentColumn: current?.column ?? 0,
  };
}

function restoreCell(
  view: EditorView,
  tableFrom: number,
  row: number,
  column: number,
  selection: "start" | "end" | "all" | number,
): void {
  queueMicrotask(() => {
    const context = tableContextAt(view.state);
    if (context === null || context.blockFrom !== tableFrom) {
      blurRenderedTableCell(view);
      return;
    }
    const target =
      context.cells.find(
        (cell) => cell.row === row && cell.column === column,
      ) ?? context.cells.at(-1);
    if (target !== undefined) {
      focusRenderedTableCell(
        view,
        context.blockFrom,
        target.row,
        target.column,
        selection,
      );
    }
  });
}

function dispatchOperation(
  view: EditorView,
  context: TableContext,
  operation: TableOperation,
  target: {
    row: number;
    column: number;
    selection?: "start" | "end" | "all" | number;
  },
): boolean {
  if (view.state.readOnly) {
    return false;
  }
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
    selection: { anchor: context.blockFrom },
    userEvent: "input.table",
  });
  restoreCell(
    view,
    context.blockFrom,
    target.row,
    target.column,
    target.selection ?? "end",
  );
  return true;
}

function nextCell(view: EditorView): boolean {
  const context = tableContextAt(view.state, view);
  if (context === null) {
    return false;
  }
  const focused = focusedRenderedTableCell(view);
  if (focused === null) {
    return focusRenderedTableCell(
      view,
      context.blockFrom,
      context.currentRow,
      context.currentColumn,
      "all",
    );
  }
  const following = context.cells[context.currentIndex + 1];
  if (following !== undefined) {
    return focusRenderedTableCell(
      view,
      context.blockFrom,
      following.row,
      following.column,
      "all",
    );
  }
  return dispatchOperation(
    view,
    context,
    { kind: "insert-row", line: context.currentLine, position: "below" },
    { row: context.currentRow + 1, column: 0, selection: "all" },
  );
}

function previousCell(view: EditorView): boolean {
  const context = tableContextAt(view.state, view);
  if (context === null) {
    return false;
  }
  const focused = focusedRenderedTableCell(view);
  if (focused === null) {
    return focusRenderedTableCell(
      view,
      context.blockFrom,
      context.currentRow,
      context.currentColumn,
      "all",
    );
  }
  const preceding = context.cells[context.currentIndex - 1];
  return (
    preceding === undefined ||
    focusRenderedTableCell(
      view,
      context.blockFrom,
      preceding.row,
      preceding.column,
      "all",
    )
  );
}

function adjacentTable(
  state: EditorState,
  direction: "up" | "down",
): SyntaxNode | null {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const lineNumber = line.number + (direction === "down" ? 1 : -1);
  if (lineNumber < 1 || lineNumber > state.doc.lines) {
    return null;
  }
  const adjacent = state.doc.line(lineNumber);
  const node = tableNodeAt(
    state,
    direction === "down" ? adjacent.from : adjacent.to,
  );
  if (node === null) {
    return null;
  }
  const boundaryLine = state.doc.lineAt(
    direction === "down"
      ? node.from
      : Math.max(node.from, extendedTableEnd(state, node.from, node.to) - 1),
  );
  return boundaryLine.number === lineNumber ? node : null;
}

function enterAdjacentTable(
  view: EditorView,
  direction: "up" | "down",
): boolean {
  if (
    !view.state.selection.main.empty ||
    focusedRenderedTableCell(view) !== null
  ) {
    return false;
  }
  const table = adjacentTable(view.state, direction);
  if (table === null) {
    return false;
  }
  const tableTo = extendedTableEnd(view.state, table.from, table.to);
  const cells = tableCellRanges(view.state.sliceDoc(table.from, tableTo));
  const row =
    direction === "down" ? 0 : Math.max(0, ...cells.map((cell) => cell.row));
  const rowCells = cells.filter((cell) => cell.row === row);
  const caretLeft = view.coordsAtPos(view.state.selection.main.head)?.left ?? 0;
  const rendered = rowCells.map((cell) => {
    const element = view.dom.querySelector<HTMLElement>(
      `.cm-skr-table-cell[data-table-from="${table.from}"][data-row="${cell.row}"][data-column="${cell.column}"]`,
    );
    const box = element?.getBoundingClientRect();
    return {
      cell,
      distance:
        box === undefined
          ? cell.column
          : Math.abs((box.left + box.right) / 2 - caretLeft),
    };
  });
  rendered.sort((left, right) => left.distance - right.distance);
  const target = rendered[0]?.cell;
  return (
    target !== undefined &&
    focusRenderedTableCell(
      view,
      table.from,
      target.row,
      target.column,
      direction === "down" ? "start" : "end",
    )
  );
}

function operationCommand(
  operation: "delete-row" | "delete-column" | "edit-source",
) {
  return (view: EditorView): boolean => {
    const context = tableContextAt(view.state, view);
    if (context === null) {
      return false;
    }
    if (operation === "edit-source") {
      return editRenderedTableSource(view);
    }
    switch (operation) {
      case "delete-row":
        return dispatchOperation(
          view,
          context,
          { kind: "delete-row", line: context.currentLine },
          {
            row: Math.min(
              context.currentRow,
              Math.max(0, ...context.cells.map((cell) => cell.row)) - 1,
            ),
            column: context.currentColumn,
          },
        );
      case "delete-column":
        return dispatchOperation(
          view,
          context,
          { kind: "delete-column", column: context.currentColumn },
          {
            row: context.currentRow,
            column: Math.max(0, context.currentColumn - 1),
          },
        );
    }
  };
}

function insertCommand(
  kind: "insert-row" | "insert-column",
  position: "above" | "below" | "before" | "after",
) {
  return (view: EditorView): boolean => {
    const context = tableContextAt(view.state, view);
    if (context === null) {
      return false;
    }
    if (kind === "insert-row") {
      const row =
        position === "above" ? context.currentRow : context.currentRow + 1;
      // An inserted row is empty, and its first cell is where a person
      // continues: they are filling the row in, left to right.
      return dispatchOperation(
        view,
        context,
        {
          kind,
          line: context.currentLine,
          position: position as "above" | "below",
        },
        { row: Math.max(1, row), column: 0, selection: "all" },
      );
    }
    const column =
      position === "before" ? context.currentColumn : context.currentColumn + 1;
    return dispatchOperation(
      view,
      context,
      {
        kind,
        column: context.currentColumn,
        position: position as "before" | "after",
      },
      { row: context.currentRow, column },
    );
  };
}

/** Routes table pointer controls through the same command registry. */
export function tableEditingExtension(
  registry: CommandRegistry,
  contextProvider: () => CommandContext,
): Extension {
  return ViewPlugin.define((view) => {
    const run = (event: Event) => {
      if (
        !(event instanceof CustomEvent) ||
        typeof event.detail?.id !== "string"
      ) {
        return;
      }
      registry.run(event.detail.id, { ...contextProvider(), view });
    };
    view.dom.addEventListener("skribeum:table-command", run);
    return {
      destroy() {
        blurRenderedTableCell(view);
        view.dom.removeEventListener("skribeum:table-command", run);
      },
    };
  });
}

/** Registers rendered-cell navigation and explicit table structure commands. */
export function registerTableEditing(registry: CommandRegistry): void {
  const widgetCommands = [
    { id: "table.cell.next", key: "Tab", run: nextCell },
    { id: "table.cell.previous", key: "Shift-Tab", run: previousCell },
    {
      id: "table.cell.enter-down",
      key: "ArrowDown",
      run: (view: EditorView) => enterAdjacentTable(view, "down"),
    },
    {
      id: "table.cell.enter-up",
      key: "ArrowUp",
      run: (view: EditorView) => enterAdjacentTable(view, "up"),
    },
    {
      id: "table.source.close",
      key: "Escape",
      run: (view: EditorView) =>
        explicitTableSource(view.state) !== null &&
        closeRenderedTableSource(view, true),
    },
  ] as const;
  for (const command of widgetCommands) {
    registry.register({
      id: command.id,
      title: STRINGS.insertTable,
      keybindings: [command.key],
      scope: "editor",
      palette: false,
      audience: "widget",
      run: (context) => context.view !== null && command.run(context.view),
    });
  }

  const structural = [
    {
      id: "table.row.insert-above",
      title: STRINGS.tableInsertRowAbove,
      run: insertCommand("insert-row", "above"),
    },
    {
      id: "table.row.insert-below",
      title: STRINGS.tableInsertRowBelow,
      run: insertCommand("insert-row", "below"),
    },
    {
      id: "table.column.insert-before",
      title: STRINGS.tableInsertColumnBefore,
      run: insertCommand("insert-column", "before"),
    },
    {
      id: "table.column.insert-after",
      title: STRINGS.tableInsertColumnAfter,
      run: insertCommand("insert-column", "after"),
    },
    {
      id: "table.row.delete",
      title: STRINGS.tableDeleteRow,
      run: operationCommand("delete-row"),
    },
    {
      id: "table.column.delete",
      title: STRINGS.tableDeleteColumn,
      run: operationCommand("delete-column"),
    },
    {
      id: "table.edit-source",
      title: STRINGS.tableEditSource,
      run: operationCommand("edit-source"),
    },
  ] as const;
  for (const command of structural) {
    registry.register({
      id: command.id,
      title: command.title,
      scope: "editor",
      pointer: ["command-palette", "overflow-menu", "slash-menu"],
      slash: { keywords: ["table", "row", "column"] },
      searchTerms: ["table", "row", "column"],
      run: (context) => context.view !== null && command.run(context.view),
    });
  }
}
