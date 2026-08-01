// The heading outline model: a pure function from the editor's syntax
// tree to a nested outline, consumed by the outline panel. Navigation is
// selection movement only; the outline never mutates the document.

import { syntaxTree } from "@codemirror/language";
import type { EditorState, Text } from "@codemirror/state";
import type { Tree } from "@lezer/common";

export type OutlineEntry = {
  /** Heading text without markers. */
  title: string;
  /** Heading level, 1 through 6. */
  level: number;
  /** Document position of the heading start, for navigation. */
  from: number;
  children: OutlineEntry[];
};

const HEADING_LEVELS = new Map<string, number>([
  ["ATXHeading1", 1],
  ["ATXHeading2", 2],
  ["ATXHeading3", 3],
  ["ATXHeading4", 4],
  ["ATXHeading5", 5],
  ["ATXHeading6", 6],
  ["SetextHeading1", 1],
  ["SetextHeading2", 2],
]);

/**
 * Extracts the nested heading outline from the tree CodeMirror already has.
 * A partial parse yields a partial outline; callers refresh during idle work
 * as the background parser extends the tree.
 */
export function computeOutline(state: EditorState): OutlineEntry[] {
  return outlineFromTree(state.doc, syntaxTree(state));
}

/** Extracts an outline from a specific parser result. */
export function outlineFromTree(doc: Text, tree: Tree): OutlineEntry[] {
  const root: OutlineEntry = { title: "", level: 0, from: 0, children: [] };
  const stack: OutlineEntry[] = [root];
  tree.iterate({
    enter: (ref) => {
      const level = HEADING_LEVELS.get(ref.name);
      if (level === undefined) {
        return undefined;
      }
      const firstLine = doc.lineAt(ref.from);
      const title = firstLine.text.replace(/^#{1,6}\s+/, "").trim();
      const entry: OutlineEntry = {
        title,
        level,
        from: ref.from,
        children: [],
      };
      while (
        stack.length > 1 &&
        (stack[stack.length - 1]?.level ?? 0) >= level
      ) {
        stack.pop();
      }
      stack[stack.length - 1]?.children.push(entry);
      stack.push(entry);
      return false;
    },
  });
  return root.children;
}

/** The outline flattened in document order with nesting depth. */
export type FlatOutlineRow = {
  entry: OutlineEntry;
  depth: number;
  hasChildren: boolean;
};

/**
 * Flattens the outline for list rendering, omitting the descendants of
 * collapsed entries (`collapsed` holds `from` positions).
 */
export function flattenOutline(
  entries: readonly OutlineEntry[],
  collapsed: ReadonlySet<number>,
  depth = 1,
): FlatOutlineRow[] {
  const rows: FlatOutlineRow[] = [];
  for (const entry of entries) {
    rows.push({ entry, depth, hasChildren: entry.children.length > 0 });
    if (!collapsed.has(entry.from)) {
      rows.push(...flattenOutline(entry.children, collapsed, depth + 1));
    }
  }
  return rows;
}

/** Returns the nearest heading at or before a document position. */
export function headingAtOrBefore(
  entries: readonly OutlineEntry[],
  position: number,
): OutlineEntry | null {
  let nearest: OutlineEntry | null = null;
  for (const row of flattenOutline(entries, new Set())) {
    if (row.entry.from > position) break;
    nearest = row.entry;
  }
  return nearest;
}
