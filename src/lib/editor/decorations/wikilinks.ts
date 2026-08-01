// Wikilink display resolution for the open buffer. The Rust index is the
// authority for vault-wide link structure; this module only answers the
// presentation question the decoration engine asks synchronously per
// visible wikilink: does this target name a note in the vault tree the
// webview already holds? Configuration knobs are read from
// `.obsidian/app.json` or the application's explicit vault preferences.

/** The `.obsidian/app.json` knobs the link layer honors. */
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

/**
 * Parses the text of `.obsidian/app.json` tolerantly: unknown fields are
 * ignored, malformed or missing content yields the defaults, and only
 * recognized values override them.
 */
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

/** What the decoration engine needs to classify wikilink targets. */
export type WikilinkResolutionContext = {
  /** Every note and file path in the open vault, vault-root-relative. */
  paths: readonly string[];
  config: ObsidianAppConfig;
  /** The note whose editor owns this context. */
  currentPath?: string | null;
  /** Read-only note loader used by rendered embeds. */
  loadNote?: (path: string) => Promise<string | null>;
  /** Resolved note paths enclosing a nested embed. */
  embedAncestry?: readonly string[];
  /** Current rendered-embed nesting depth. */
  embedDepth?: number;
  /** Whether note links expose delayed rendered previews. */
  linkPreviews?: boolean;
};

export const EMPTY_WIKILINK_CONTEXT: WikilinkResolutionContext = {
  paths: [],
  config: DEFAULT_OBSIDIAN_APP_CONFIG,
};

type ResolutionIndex = {
  /** Full lowercase NFC path (with extension) to the stored path. */
  byPath: Map<string, string>;
  /** Lowercase NFC basename without `.md` to the shortest stored path. */
  byName: Map<string, string>;
};

const indexCache = new WeakMap<readonly string[], ResolutionIndex>();

function normalizeKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function resolutionIndex(paths: readonly string[]): ResolutionIndex {
  const cached = indexCache.get(paths);
  if (cached !== undefined) {
    return cached;
  }
  const byPath = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const path of paths) {
    byPath.set(normalizeKey(path), path);
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const stem = basename.toLowerCase().endsWith(".md")
      ? basename.slice(0, -3)
      : basename;
    const key = normalizeKey(stem);
    const existing = byName.get(key);
    if (existing === undefined || path.length < existing.length) {
      byName.set(key, path);
    }
  }
  const index = { byPath, byName };
  indexCache.set(paths, index);
  return index;
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
    const current = context.currentPath ?? "";
    const separator = current.lastIndexOf("/");
    return separator === -1
      ? target
      : `${current.slice(0, separator)}/${target}`;
  }
  return `${configured.replace(/\/$/u, "")}/${target}`;
}

export type WikilinkResolution =
  /** The target names the current note (`[[#Heading]]`, `[[#^block]]`). */
  | { kind: "self" }
  /** The target resolves to a vault path. */
  | { kind: "note"; path: string }
  /** No vault entry matches; styled distinctly, never an error. */
  | { kind: "unresolved" };

/**
 * Resolves a wikilink target the way Obsidian's shortest-path rules read
 * it against the vault tree: heading and block suffixes are stripped, an
 * exact vault-root-relative path (with or without `.md`) wins, then the
 * shortest path whose basename matches. Comparison is NFC- and
 * case-insensitive to match Obsidian's tolerant lookup.
 */
export function resolveWikilinkTarget(
  target: string,
  context: WikilinkResolutionContext,
): WikilinkResolution {
  const hash = target.indexOf("#");
  const pathPart = (hash === -1 ? target : target.slice(0, hash)).trim();
  if (pathPart.length === 0) {
    return { kind: "self" };
  }
  const index = resolutionIndex(context.paths);
  const key = normalizeKey(pathPart);
  const attachment = attachmentCandidate(pathPart, context);
  if (attachment !== null) {
    const attachmentKey = normalizeKey(attachment);
    const configuredMatch = index.byPath.get(attachmentKey);
    if (configuredMatch !== undefined) {
      return { kind: "note", path: configuredMatch };
    }
  }
  const exact = index.byPath.get(key) ?? index.byPath.get(`${key}.md`);
  if (exact !== undefined) {
    return { kind: "note", path: exact };
  }
  const slash = key.lastIndexOf("/");
  const byName = index.byName.get(slash === -1 ? key : key.slice(slash + 1));
  if (byName !== undefined && slash === -1) {
    return { kind: "note", path: byName };
  }
  return { kind: "unresolved" };
}

/** Resolves a local Markdown-link URL to a canonical preview target. */
export function resolveMarkdownLinkTarget(
  rawTarget: string,
  context: WikilinkResolutionContext,
): string | null {
  const unwrapped =
    rawTarget.startsWith("<") && rawTarget.endsWith(">")
      ? rawTarget.slice(1, -1)
      : rawTarget;
  let decoded: string;
  try {
    decoded = decodeURIComponent(unwrapped);
  } catch {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(decoded) || decoded.startsWith("//")) {
    return null;
  }
  const hash = decoded.indexOf("#");
  const pathPart = hash === -1 ? decoded : decoded.slice(0, hash);
  const fragment = hash === -1 ? "" : decoded.slice(hash);
  if (pathPart.length === 0) {
    return context.currentPath === null || context.currentPath === undefined
      ? null
      : fragment;
  }
  if (pathPart.startsWith("/") || pathPart.includes("?")) {
    return null;
  }
  const base = context.currentPath?.split("/").slice(0, -1) ?? [];
  const segments = [...base];
  for (const segment of pathPart.split("/")) {
    if (segment === "." || segment.length === 0) {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const candidates = [segments.join("/"), pathPart];
  for (const candidate of candidates) {
    const resolution = resolveWikilinkTarget(candidate, context);
    if (resolution.kind === "note") {
      return `${resolution.path}${fragment}`;
    }
  }
  return null;
}
