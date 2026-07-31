// Wikilink display resolution for the open buffer. The Rust index is the
// authority for vault-wide link structure; this module only answers the
// presentation question the decoration engine asks synchronously per
// visible wikilink: does this target name a note in the vault tree the
// webview already holds? Configuration knobs are read from
// `.obsidian/app.json` and honored, never overridden (decision 27).

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
