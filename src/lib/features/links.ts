// Wikilink addresses and the rules that keep them resolving.
//
// One resolution model serves the editor, the renderer, and the vault: a
// written target names a note through Obsidian's exact, shortest-path and
// case-folded tiers, and the same rules decide what a rename has to change
// so the links that named a note keep naming it. Renaming rewrites the
// targets that resolved to the old path and nothing else: only the bytes of
// the target inside the brackets move, the alias, subpath and extension
// come across untouched, and a target written in shortest form stays as
// short as still resolves to that note alone.
//
// The module is pure: no IPC, no components, no editor state. That is what
// lets the browser vault, the command layer and the tests all share it.

import type { ByteChange } from "../editor/byteChangeSet";
import {
  bufferEditsToChangeSet,
  bufferFromBytes,
  buildLineEndingMap,
} from "../editor/lineEndingMap";
import { skribeumMarkdownParser } from "../editor/markdown/obsidian";
import { utf16OffsetToByteOffset } from "../editor/offsets";
import { isNotePath, withoutNoteExtension } from "../noteTitles";

export type ObsidianAppConfig = {
  /** Link format the vault is configured to emit. */
  newLinkFormat: "shortest" | "relative" | "absolute";
  /** Whether the vault prefers markdown links over wikilinks. */
  useMarkdownLinks: boolean;
  /** Configured attachment folder mode, null when none is configured. */
  attachmentFolderPath: string | null;
};

export const DEFAULT_OBSIDIAN_APP_CONFIG: ObsidianAppConfig = {
  newLinkFormat: "shortest",
  useMarkdownLinks: false,
  attachmentFolderPath: null,
};

/** Parses the supported `.obsidian/app.json` link settings tolerantly. */
export function parseObsidianAppConfig(jsonText: string): ObsidianAppConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return DEFAULT_OBSIDIAN_APP_CONFIG;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return DEFAULT_OBSIDIAN_APP_CONFIG;
  }
  const record = parsed as Record<string, unknown>;
  const format = record.newLinkFormat;
  const useMarkdown = record.useMarkdownLinks;
  const attachments = record.attachmentFolderPath;
  return {
    newLinkFormat:
      format === "relative" || format === "absolute" ? format : "shortest",
    useMarkdownLinks: useMarkdown === true,
    attachmentFolderPath:
      typeof attachments === "string" && attachments.length > 0
        ? attachments
        : null,
  };
}

export type WikilinkResolutionContext = {
  /** Every note and file path in the open vault, vault-root-relative. */
  paths: readonly string[];
  config: ObsidianAppConfig;
  /** The note whose editor owns this context. */
  currentPath?: string | null;
  /** Read-only note loader used by rendered embeds and link previews. */
  loadNote?: (path: string) => Promise<string | null>;
  /** Read-only byte loader for vault files rendered images read. */
  loadAsset?: (path: string) => Promise<Uint8Array | null>;
  /** Resolved note paths enclosing a nested embed. */
  embedAncestry?: readonly string[];
  /** Current rendered-embed nesting depth. */
  embedDepth?: number;
  /** Whether note links expose delayed rendered previews. */
  linkPreviews?: boolean;
  /** Nested embeds render as headers only inside a transient link preview. */
  previewMode?: boolean;
};

export const EMPTY_WIKILINK_CONTEXT: WikilinkResolutionContext = {
  paths: [],
  config: DEFAULT_OBSIDIAN_APP_CONFIG,
};

export type NoteAddress = {
  /** NFC, slash-separated, vault-root-relative note path including `.md`. */
  path: string;
  /** Obsidian heading or block suffix without the leading `#`. */
  fragment?: string;
};

export type WikilinkResolution =
  | { kind: "self"; fragment?: string }
  | { kind: "note"; path: string; fragment?: string }
  | { kind: "unresolved"; candidate: NoteAddress | null };

type SplitTarget = { path: string; fragment?: string };

function splitWikilinkTarget(target: string): SplitTarget {
  const hash = target.indexOf("#");
  const path = (hash === -1 ? target : target.slice(0, hash)).trim();
  const fragment = hash === -1 ? "" : target.slice(hash + 1).trim();
  return fragment.length === 0 ? { path } : { path, fragment };
}

function joinVaultPath(baseDirectory: string, target: string): string | null {
  const segments = `${baseDirectory}/${target}`.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (normalized.length === 0) {
        return null;
      }
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join("/").normalize("NFC");
}

function sourceDirectory(sourcePath: string | null | undefined): string {
  if (sourcePath === null || sourcePath === undefined) {
    return "";
  }
  const slash = sourcePath.lastIndexOf("/");
  return slash === -1 ? "" : sourcePath.slice(0, slash);
}

function resolutionTarget(
  path: string,
  context: WikilinkResolutionContext,
): string | null {
  const rootPath = path.startsWith("/") ? path.slice(1) : path;
  if (path.startsWith("./") || path.startsWith("../")) {
    return joinVaultPath(sourceDirectory(context.currentPath), rootPath);
  }
  return rootPath.normalize("NFC");
}

function targetHasExtension(target: string): boolean {
  const name = target.slice(target.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (
    dot > 0 &&
    dot < name.length - 1 &&
    [...name.slice(dot + 1)].every((character) => /[A-Za-z0-9]/.test(character))
  );
}

function exactWikilinkMatch(path: string, target: string): boolean {
  return (
    path === target ||
    (!targetHasExtension(target) &&
      isNotePath(path) &&
      withoutNoteExtension(path) === target)
  );
}

function suffixWikilinkMatch(path: string, target: string): boolean {
  const tailMatches = (candidate: string) => {
    const prefix = candidate.slice(0, -target.length);
    return candidate.endsWith(target) && prefix.endsWith("/");
  };
  return (
    tailMatches(path) ||
    (!targetHasExtension(target) &&
      isNotePath(path) &&
      tailMatches(withoutNoteExtension(path)))
  );
}

function deterministicPathOrder(left: string, right: string): number {
  const segmentDifference = left.split("/").length - right.split("/").length;
  if (segmentDifference !== 0) {
    return segmentDifference;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function attachmentCandidate(
  target: string,
  context: WikilinkResolutionContext,
): string | null {
  const configured = context.config.attachmentFolderPath;
  if (configured === null || target.includes("/")) {
    return null;
  }
  if (configured === "/") {
    return target;
  }
  if (configured === "./") {
    return joinVaultPath(sourceDirectory(context.currentPath), target);
  }
  return joinVaultPath(configured, target);
}

/** Mirrors the Rust index's exact, suffix, then case-folded match tiers. */
function resolvePath(target: string, paths: readonly string[]): string | null {
  const foldedTarget = target.toLowerCase();
  const tiers = [
    (path: string) => exactWikilinkMatch(path, target),
    (path: string) => suffixWikilinkMatch(path, target),
    (path: string) => exactWikilinkMatch(path.toLowerCase(), foldedTarget),
    (path: string) => suffixWikilinkMatch(path.toLowerCase(), foldedTarget),
  ];
  for (const matches of tiers) {
    const candidates = paths.filter(matches).sort(deterministicPathOrder);
    if (candidates.length > 0) {
      return candidates[0] ?? null;
    }
  }
  return null;
}

/** Resolves a target with Obsidian-compatible path, suffix, and fragment rules. */
export function resolveWikilinkTarget(
  target: string,
  context: WikilinkResolutionContext,
): WikilinkResolution {
  const split = splitWikilinkTarget(target);
  if (split.path.length === 0) {
    return split.fragment === undefined
      ? { kind: "self" }
      : { kind: "self", fragment: split.fragment };
  }

  const targetPath = resolutionTarget(split.path, context);
  const attachment = attachmentCandidate(split.path, context);
  const resolved =
    (attachment === null ? null : resolvePath(attachment, context.paths)) ??
    (targetPath === null ? null : resolvePath(targetPath, context.paths));
  if (resolved !== null) {
    return split.fragment === undefined
      ? { kind: "note", path: resolved }
      : { kind: "note", path: resolved, fragment: split.fragment };
  }
  return {
    kind: "unresolved",
    candidate: candidateAddressForTarget(target, context),
  };
}

/** Produces the deterministic note path shown by the not-found surface. */
export function candidateAddressForTarget(
  target: string,
  context: WikilinkResolutionContext,
): NoteAddress | null {
  const split = splitWikilinkTarget(target);
  if (split.path.length === 0) {
    const source = context.currentPath;
    if (source === null || source === undefined) {
      return null;
    }
    return split.fragment === undefined
      ? { path: source }
      : { path: source, fragment: split.fragment };
  }
  const candidate = resolutionTarget(split.path, context);
  if (candidate === null || candidate.length === 0) {
    return null;
  }
  const path = /\.[^/]+$/.test(candidate) ? candidate : `${candidate}.md`;
  const normalized = normalizeNotePath(path);
  if (normalized === null) {
    return null;
  }
  return split.fragment === undefined
    ? { path: normalized }
    : { path: normalized, fragment: split.fragment };
}

/** Validates and normalizes a permalink path without allowing vault escape. */
export function normalizeNotePath(path: string): string | null {
  const slashPath = path.replaceAll("\\", "/").normalize("NFC");
  if (slashPath.startsWith("/") || slashPath.length === 0) {
    return null;
  }
  const segments = slashPath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return slashPath;
}

/**
 * One path change a rename or a move produces: the path references resolve
 * to now, and the path they must resolve to afterwards.
 */
export type PathChange = { from: string; to: string };

/** One note whose link targets a move changes, and the edits that change them. */
export type LinkUpdate = {
  /** Vault-relative path of the note holding the references. */
  path: string;
  /** How many of its links the move retargets. */
  references: number;
  /** Byte-range replacements against that note's current bytes. */
  changes: ByteChange[];
};

/** The path `path` takes when `change` applies, or null when it is untouched. */
export function remapPath(path: string, change: PathChange): string | null {
  if (path === change.from) {
    return change.to;
  }
  return path.startsWith(`${change.from}/`)
    ? `${change.to}${path.slice(change.from.length)}`
    : null;
}

/** The path list after `changes` apply, given the list before. */
export function indexAfter(
  before: readonly string[],
  changes: readonly PathChange[],
): string[] {
  return before.map((path) => {
    for (const change of changes) {
      const moved = remapPath(path, change);
      if (moved !== null) {
        return moved;
      }
    }
    return path;
  });
}

/**
 * The per-file path changes moving `from` to `to` produces: one for a file,
 * one for every indexed file beneath it for a folder.
 */
export function pathChangesForMove(
  paths: readonly string[],
  from: string,
  to: string,
): PathChange[] {
  const root = { from, to };
  const changes: PathChange[] = [];
  for (const path of paths) {
    const moved = remapPath(path, root);
    if (moved !== null) {
      changes.push({ from: path, to: moved });
    }
  }
  return changes;
}

/**
 * Whether `text` can hold a reference to any of `changes`. Every resolution
 * tier requires the written target to end with the moved file's own name,
 * so a note without that name cannot reference it. Lets a rename skip
 * parsing the large majority of a vault.
 */
export function mayReference(
  text: string,
  changes: readonly PathChange[],
): boolean {
  const folded = text.toLowerCase();
  return changes.some((change) => {
    const name = change.from.split("/").at(-1) ?? "";
    const stem = withoutNoteExtension(name).toLowerCase();
    return stem.length > 0 && folded.includes(stem);
  });
}

/**
 * The target text that replaces `written`, keeping the form it was written
 * in: a full vault path stays full, a shortest-form target stays as short
 * as still resolves to the moved note alone, and the extension is present
 * exactly as before.
 */
function retargetedTarget(
  written: string,
  change: PathChange,
  after: WikilinkResolutionContext,
): string {
  const keepExtension = targetHasExtension(written);
  const shorten = (path: string) =>
    keepExtension ? path : withoutNoteExtension(path);
  const full = shorten(change.to);
  if (
    written === change.from ||
    withoutNoteExtension(change.from) === written
  ) {
    return full;
  }
  const segments = change.to.split("/");
  for (let taken = 1; taken < segments.length; taken += 1) {
    const candidate = shorten(
      segments.slice(segments.length - taken).join("/"),
    );
    const resolution = resolveWikilinkTarget(candidate, after);
    if (resolution.kind === "note" && resolution.path === change.to) {
      return candidate;
    }
  }
  return full;
}

/** The byte-order-mark length of `bytes`, zero when it carries none. */
function bomLength(bytes: Uint8Array): number {
  return bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
    ? 3
    : 0;
}

/**
 * The minimal change set that retargets every wikilink and embed in `bytes`
 * whose target resolves to a path in `changes`.
 *
 * `sourcePath` is the note's own path after the move, so relative targets
 * resolve from where the note now sits. Bytes that are not valid UTF-8
 * yield no changes: those notes are never written. The result is sorted and
 * non-overlapping, ready for `applyByteChangeSet`.
 */
export function retargetLinks(
  bytes: Uint8Array,
  sourcePath: string,
  before: WikilinkResolutionContext,
  after: WikilinkResolutionContext,
  changes: readonly PathChange[],
): ByteChange[] {
  const mark = bomLength(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      bufferFromBytes(bytes.subarray(mark)),
    );
  } catch {
    return [];
  }
  if (!mayReference(text, changes)) {
    return [];
  }
  const beforeContext = { ...before, currentPath: sourcePath };
  const afterContext = { ...after, currentPath: sourcePath };
  const encoder = new TextEncoder();
  const edits: { start: number; end: number; insert: Uint8Array }[] = [];
  skribeumMarkdownParser.parse(text).iterate({
    enter(reference) {
      if (reference.name !== "WikilinkTarget") {
        return undefined;
      }
      const raw = text.slice(reference.from, reference.to);
      const hash = raw.indexOf("#");
      const notePart = hash === -1 ? raw : raw.slice(0, hash);
      const written = notePart.trim();
      if (written.length === 0) {
        return undefined;
      }
      const resolution = resolveWikilinkTarget(written, beforeContext);
      if (resolution.kind !== "note") {
        return undefined;
      }
      const change = changes.find((entry) => entry.from === resolution.path);
      if (change === undefined) {
        return undefined;
      }
      const replacement = retargetedTarget(written, change, afterContext);
      // A replacement carrying link punctuation would rewrite the shape of
      // the link, not its target. Refuse it: the reference is left dangling
      // and visible rather than the note silently restructured.
      if (replacement === written || /[[\]|#\n\r]/.test(replacement)) {
        return undefined;
      }
      const start =
        reference.from + notePart.length - notePart.trimStart().length;
      edits.push({
        start: mark + utf16OffsetToByteOffset(text, start),
        end: mark + utf16OffsetToByteOffset(text, start + written.length),
        insert: encoder.encode(replacement),
      });
      return undefined;
    },
  });
  edits.sort((left, right) => left.start - right.start);
  return bufferEditsToChangeSet(buildLineEndingMap(bytes), edits);
}

/**
 * The change set that restores `base` from the bytes `changes` produce.
 * Applying `changes` and then this yields `base` byte for byte, which is
 * what makes a rename one undoable step.
 */
export function invertChanges(
  base: Uint8Array,
  changes: readonly ByteChange[],
): ByteChange[] {
  const inverse: ByteChange[] = [];
  let drift = 0;
  for (const change of changes) {
    const start = change.start + drift;
    inverse.push({
      start,
      end: start + change.bytes.length,
      bytes: base.slice(change.start, change.end),
    });
    drift += change.bytes.length - (change.end - change.start);
  }
  return inverse;
}

/** One note a move rewrites, named for the person who has to approve it. */
export type LinkUpdateSummary = { path: string; references: number };

/**
 * The notes a move of `from` to `to` would rewrite, read through the
 * resolution context's own note loader. This is what the person is shown
 * before anything is written; the vault performs the authoritative rewrite
 * from the same rules over the same paths.
 */
export async function planLinkUpdates(
  context: WikilinkResolutionContext,
  from: string,
  to: string,
): Promise<LinkUpdateSummary[]> {
  const loadNote = context.loadNote;
  const paths = [...context.paths];
  const changes = pathChangesForMove(paths, from, to);
  if (loadNote === undefined || changes.length === 0) {
    return [];
  }
  const before = { ...context, paths };
  const after = { ...context, paths: indexAfter(paths, changes) };
  const encoder = new TextEncoder();
  const root = { from, to };
  const updates: LinkUpdateSummary[] = [];
  for (const path of paths) {
    if (!isNotePath(path)) {
      continue;
    }
    const text = await loadNote(path);
    if (text === null || !mayReference(text, changes)) {
      continue;
    }
    const references = retargetLinks(
      encoder.encode(text),
      remapPath(path, root) ?? path,
      before,
      after,
      changes,
    ).length;
    if (references > 0) {
      updates.push({ path, references });
    }
  }
  return updates;
}
