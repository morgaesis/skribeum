import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { bracketMatching } from "@codemirror/language";
import type { Extension, Text } from "@codemirror/state";
import { mathMarkdownExtension } from "../rendering/math";
import {
  decorationEngine,
  LONG_LINE_DECORATION_LIMIT,
} from "./decorations/engine";
import { obsidianMarkdownExtensions } from "./markdown/obsidian";

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
  if (hasOverlongLine(doc)) {
    return [];
  }
  return [
    markdown({
      base: markdownLanguage,
      extensions: [...obsidianMarkdownExtensions, mathMarkdownExtension],
    }),
    bracketMatching(),
    decorationEngine(),
  ];
}
