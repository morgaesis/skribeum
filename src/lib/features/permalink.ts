// Stable note identity: a short, YouTube-style id written into a note's
// frontmatter under the `id` key (decision: lazily allocated on the first
// "Copy permalink", through the same positional frontmatter edit path the
// properties panel uses). The id survives moves and renames because it
// lives in note content rather than the vault-relative path. The public
// URL scheme is `https://skribeum.app/?n=<id>`; the browser demo resolves
// it back to a vault path by scanning frontmatter (see `resolveNoteId`),
// while the desktop application never parses it, having no address bar.

import { parseFrontmatter } from "../editor/frontmatter";

/** YouTube's own video-id alphabet: unpadded base64url. */
const ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ID_LENGTH = 11;
const ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${ID_LENGTH}}$`);

/**
 * Generates one 11-character base64url id from a cryptographically random
 * byte source. The alphabet has 64 characters and a byte has 256 possible
 * values, an exact multiple, so `byte % 64` carries no modulo bias.
 */
export function generateNoteId(): string {
  const bytes = new Uint8Array(ID_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(
    bytes,
    (byte) => ID_ALPHABET[byte % ID_ALPHABET.length],
  ).join("");
}

/** True for exactly the shapes `generateNoteId` can produce. */
export function isNoteId(candidate: string): boolean {
  return ID_PATTERN.test(candidate);
}

/**
 * The published origin every permalink resolves against. Desktop and the
 * browser demo copy the identical URL regardless of the vault instance or
 * the demo deployment's own origin, so it is fixed rather than derived
 * from `window.location`.
 */
export const PERMALINK_ORIGIN = "https://skribeum.app";
export const PERMALINK_ID_PARAMETER = "n";

/** Builds the public permalink URL for a note id. */
export function permalinkUrlForId(id: string): string {
  const url = new URL(PERMALINK_ORIGIN);
  url.searchParams.set(PERMALINK_ID_PARAMETER, id);
  return url.href;
}

/** Strips one layer of matching quotes a hand-authored id might carry. */
export function normalizeNoteIdScalar(raw: string): string {
  if (raw.length >= 2) {
    const first = raw.charAt(0);
    const last = raw.charAt(raw.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

// Frontmatter is only ever panel-edited within this many leading
// characters (mirrors the editor's own scan limit); a document whose `id`
// key sits beyond it would never be reachable through the properties
// panel either, so the permalink scan applies the same bound.
const FRONTMATTER_SCAN_LIMIT = 16384;

/** Reads the `id` frontmatter property from note text, if present. */
export function noteIdFromContent(text: string): string | null {
  const frontmatter = parseFrontmatter(
    text.slice(0, Math.min(text.length, FRONTMATTER_SCAN_LIMIT)),
  );
  if (frontmatter === null) {
    return null;
  }
  const entry = frontmatter.entries.find((candidate) => candidate.key === "id");
  return entry === undefined ? null : normalizeNoteIdScalar(entry.raw);
}

/**
 * Resolves a permalink id to its note path by scanning vault content
 * through the supplied reader. Returns null when no note carries a
 * matching id: the caller's not-found fallback is normal landing, not an
 * error surface.
 */
export async function resolveNoteId(
  id: string,
  paths: readonly string[],
  readNoteText: (path: string) => Promise<string>,
): Promise<string | null> {
  const contents = await Promise.all(
    paths.map(async (path) => {
      try {
        return await readNoteText(path);
      } catch {
        return null;
      }
    }),
  );
  for (const [index, text] of contents.entries()) {
    if (text !== null && noteIdFromContent(text) === id) {
      return paths[index] ?? null;
    }
  }
  return null;
}
