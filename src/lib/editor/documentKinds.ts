// What kind of document a vault path opens as. Every indexed file opens:
// the vault never holds a path the application refuses to show.
//
// The classification is a pure function of the path. Nothing here reads a
// file's bytes, so a file's contents can never talk the application into
// treating it as a type it is not named as. The image branch reuses the
// Markdown image pipeline's own extension allowlist, so a standalone
// viewer and an embedded image agree on exactly which formats exist and on
// which media type each one is served as.

import { isNotePath } from "../noteTitles";
import { imageMediaType } from "./decorations/images";

/** How a vault path presents when it opens. */
export type VaultDocumentKind =
  /** A Markdown-family note: the full reading and editing surface. */
  | "note"
  /** A canvas board. */
  | "canvas"
  /** A raster or vector image, shown in the image viewer. */
  | "image"
  /** Any other file: an editable plain-text buffer. */
  | "text";

/**
 * The lowercase extension of a path's final segment, or the empty string
 * when it has none. A leading dot is the start of the name, not an
 * extension separator, so `.gitignore` has no extension.
 */
export function fileExtension(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The lowercase final path segment. */
export function fileBaseName(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  return name.toLowerCase();
}

/** How the path at `path` presents when opened. */
export function vaultDocumentKind(path: string): VaultDocumentKind {
  if (isNotePath(path)) {
    return "note";
  }
  if (fileExtension(path) === "canvas") {
    return "canvas";
  }
  return imageMediaType(path) === null ? "text" : "image";
}

/**
 * Whether a path's document is parsed and presented as Markdown. Markdown
 * services (the outline, frontmatter and the properties panel, wikilink and
 * tag affordances, title resolution from a leading heading) apply to these
 * documents and to no others: a shell script's `# comment` is a comment,
 * and a YAML document's leading `---` is a document marker, not a
 * frontmatter fence.
 */
export function isMarkdownDocument(path: string | null): boolean {
  return path === null || isNotePath(path);
}
