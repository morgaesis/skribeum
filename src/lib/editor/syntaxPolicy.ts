import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  bracketMatching,
  type LanguageDescription,
  syntaxHighlighting,
} from "@codemirror/language";
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
import { fileBaseName, fileExtension } from "./documentKinds";
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

/**
 * Language names for well-known files that carry no extension of their own.
 * Keyed by the lowercase file name, so the choice still comes from the
 * path and never from the file's contents.
 */
const FILE_NAME_LANGUAGES: Readonly<Record<string, string>> = Object.freeze({
  ".bash_profile": "bash",
  ".bashrc": "bash",
  ".editorconfig": "ini",
  ".env": "ini",
  ".gitconfig": "ini",
  ".npmrc": "ini",
  ".profile": "bash",
  ".zshrc": "bash",
  dockerfile: "dockerfile",
});

/**
 * The language a file path selects, or null when the path names no
 * language this build can highlight. The choice comes from the path's
 * extension, falling back to a small table of extensionless names; a
 * file's own bytes never take part, so no payload can choose how it is
 * parsed.
 */
export function fileLanguageDescription(
  path: string,
): LanguageDescription | null {
  const extension = fileExtension(path);
  if (extension.length > 0) {
    return codeLanguage(extension);
  }
  const named = FILE_NAME_LANGUAGES[fileBaseName(path)];
  return named === undefined ? null : codeLanguage(named);
}

/**
 * Syntax services for a document that is not a note: the language its path
 * names, token colour, and bracket matching. A path naming no known
 * language, and a document with a line past the syntax budget, resolve to
 * plain text, which is still fully editable. Resolving the language loads
 * its grammar, so this is asynchronous and the caller reconfigures the
 * running editor when it settles.
 */
export async function fileSyntaxExtensions(
  path: string,
  doc: DocumentText,
): Promise<Extension[]> {
  if (hasOverlongLine(doc)) {
    return [];
  }
  const description = fileLanguageDescription(path);
  if (description === null) {
    return [];
  }
  const support = await description.load();
  return [
    support,
    syntaxHighlighting(tokenHighlightStyle, { fallback: true }),
    bracketMatching(),
  ];
}

/**
 * Markdown parsing and token colour without reading-presentation decorations.
 * The live document remains unchanged while every source character renders.
 */
export function noteSourceExtensions(
  doc: DocumentText,
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
  ];
}
