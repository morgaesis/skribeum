// Content insertion commands (headings, task, code fence, callout, table
// skeleton, wikilink), registered as slash-menu and palette entries.
// Every insertion is a declared-range mutation at the cursor or line
// start through a normal transaction.

import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

function insertLinePrefix(view: EditorView, prefix: string): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  view.dispatch({
    changes: { from: line.from, to: line.from, insert: prefix },
    userEvent: "input.insert",
  });
  return true;
}

function insertSnippet(
  view: EditorView,
  text: string,
  cursorOffset: number,
): boolean {
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: head, to: head, insert: text },
    selection: EditorSelection.cursor(head + cursorOffset),
    userEvent: "input.insert",
  });
  return true;
}

const TABLE_SKELETON = "|     |     |\n| --- | --- |\n|     |     |\n";

/** Registers the content insertion commands. */
export function registerInsertions(registry: CommandRegistry): void {
  const linePrefixed: readonly {
    id: string;
    title: string;
    prefix: string;
    keywords: readonly string[];
  }[] = [
    {
      id: "insert.heading-1",
      title: STRINGS.insertHeading1,
      prefix: "# ",
      keywords: ["h1", "title"],
    },
    {
      id: "insert.heading-2",
      title: STRINGS.insertHeading2,
      prefix: "## ",
      keywords: ["h2"],
    },
    {
      id: "insert.heading-3",
      title: STRINGS.insertHeading3,
      prefix: "### ",
      keywords: ["h3"],
    },
    {
      id: "insert.task",
      title: STRINGS.insertTask,
      prefix: "- [ ] ",
      keywords: ["todo", "checkbox"],
    },
    {
      id: "insert.callout",
      title: STRINGS.insertCallout,
      prefix: "> [!note] ",
      keywords: ["note", "admonition"],
    },
  ];
  for (const entry of linePrefixed) {
    registry.register({
      id: entry.id,
      title: entry.title,
      scope: "editor",
      slash: { keywords: entry.keywords },
      run: (context) =>
        context.view === null
          ? false
          : insertLinePrefix(context.view, entry.prefix),
    });
  }
  registry.register({
    id: "insert.code-fence",
    title: STRINGS.insertCodeFence,
    scope: "editor",
    slash: { keywords: ["code", "fence", "block"] },
    run: (context) =>
      context.view === null
        ? false
        : insertSnippet(context.view, "```\n\n```", 4),
  });
  registry.register({
    id: "insert.table",
    title: STRINGS.insertTable,
    scope: "editor",
    slash: { keywords: ["table", "grid"] },
    run: (context) =>
      context.view === null
        ? false
        : insertSnippet(context.view, TABLE_SKELETON, 2),
  });
  registry.register({
    id: "insert.wikilink",
    title: STRINGS.insertWikilink,
    scope: "editor",
    slash: { keywords: ["link", "note"] },
    run: (context) =>
      context.view === null ? false : insertSnippet(context.view, "[[]]", 2),
  });
}
