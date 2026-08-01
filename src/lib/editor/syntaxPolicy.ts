import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching, syntaxHighlighting } from "@codemirror/language";
import type { Extension, Text } from "@codemirror/state";
import {
  DEFAULT_TASK_STATUSES,
  normalizeTaskStatuses,
  type TaskStatus,
} from "../taskStatuses";
import {
  decorationEngine,
  LONG_LINE_DECORATION_LIMIT,
  taskStatusConfiguration,
  tokenHighlightStyle,
} from "./decorations/engine";
import type { WikilinkResolutionContext } from "./decorations/wikilinks";
import { codeLanguage } from "./markdown/codeLanguages";
import { obsidianMarkdownExtensionsFor } from "./markdown/obsidian";

type DocumentText = string | Text;

/** Whether any line exceeds the editor's syntax-processing budget. */
export function hasOverlongLine(doc: DocumentText): boolean {
  if (typeof doc !== "string") {
    for (let lineNumber = 1; lineNumber <= doc.lines; lineNumber += 1) {
      if (doc.line(lineNumber).length > LONG_LINE_DECORATION_LIMIT) {
        return true;
      }
    }
    return false;
  }

  let lineStart = 0;
  for (;;) {
    const lineEnd = doc.indexOf("\n", lineStart);
    if (lineEnd === -1) {
      return doc.length - lineStart > LONG_LINE_DECORATION_LIMIT;
    }
    if (lineEnd - lineStart > LONG_LINE_DECORATION_LIMIT) {
      return true;
    }
    lineStart = lineEnd + 1;
  }
}

/**
 * Syntax services for an editor document. Pathological long lines stay plain
 * text because language parsing, bracket matching, and decorations are all
 * omitted together.
 */
export function editorSyntaxExtensions(doc: DocumentText): Extension[] {
  const rendering = noteRenderingExtensions(doc);
  return rendering.length === 0 ? [] : [...rendering, bracketMatching()];
}

/**
 * Markdown parsing, highlighting and decorations shared by editable notes
 * and read-only note surfaces.
 */
export function noteRenderingExtensions(
  doc: DocumentText,
  context?: WikilinkResolutionContext,
  taskStatuses: readonly TaskStatus[] = DEFAULT_TASK_STATUSES,
): Extension[] {
  if (hasOverlongLine(doc)) {
    return [];
  }
  const normalizedTaskStatuses = normalizeTaskStatuses(taskStatuses);
  return [
    markdown({
      base: markdownLanguage,
      codeLanguages: codeLanguage,
      extensions: obsidianMarkdownExtensionsFor(normalizedTaskStatuses),
    }),
    syntaxHighlighting(tokenHighlightStyle, { fallback: true }),
    taskStatusConfiguration.of(normalizedTaskStatuses),
    decorationEngine(context),
  ];
}
