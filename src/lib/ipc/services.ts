// Typed wrappers for the search, settings and tree-refresh commands over
// the generated bindings, following the same unwrap-to-`IpcError`
// pattern as the vault layer, plus the byte-to-character range
// conversion search highlighting needs.

import {
  commands,
  type OpenFileTarget,
  type SearchHit,
  type SettingsDoc,
  type TagFrequency,
  type TreeEntry,
  type UpdateCheckDoc,
  type VaultHandle,
} from "./bindings";
import { unwrap } from "./vault";

/** One ranked search hit; `match_ranges` are byte offsets into `snippet`. */
export type SearchResult = SearchHit;

/** One indexed vault tag with aggregate usage counts. */
export type TagCatalogEntry = TagFrequency;

/** The persisted settings document. */
export type SettingsDocument = SettingsDoc;

/** Runs a ranked full-text query over the vault's search index. */
export async function searchQuery(
  handle: VaultHandle,
  query: string,
  limit: number,
  searchNoteBodies = true,
  caseSensitive = false,
): Promise<SearchResult[]> {
  return unwrap(
    await commands.searchQuery(
      handle,
      query,
      limit,
      searchNoteBodies,
      caseSensitive,
    ),
  );
}

/** Returns the indexed vault tag catalog. */
export async function tagCatalog(
  handle: VaultHandle,
): Promise<TagCatalogEntry[]> {
  return unwrap(await commands.tagCatalog(handle));
}

/** Reads the settings document from the app config directory. */
export async function settingsRead(): Promise<SettingsDocument> {
  return unwrap(await commands.settingsRead());
}

/** Returns the resolved desktop settings document path. */
export async function settingsPath(): Promise<string> {
  return unwrap(await commands.settingsPath());
}

/** Persists the settings document. */
export async function settingsWrite(doc: SettingsDocument): Promise<void> {
  unwrap(await commands.settingsWrite(doc));
}

/** Persists and applies one application webview zoom percentage. */
export async function zoomSet(zoomPercent: number): Promise<number> {
  return unwrap(await commands.zoomSet(zoomPercent));
}

/** Starts the platform-specific first-paint warm-up for the hidden window. */
export async function windowWarmup(): Promise<void> {
  unwrap(await commands.windowWarmup());
}

/** Reveals the desktop window after its first committed frontend render. */
export async function windowReady(webviewMilliseconds: number): Promise<void> {
  unwrap(await commands.windowReady(webviewMilliseconds));
}

/** Drains native file-open paths queued by argv or operating-system events. */
export async function openFilesTake(): Promise<string[]> {
  return unwrap(await commands.openFilesTake());
}

/** Resolves a native file path to the vault root and relative note path. */
export async function fileOpenResolve(path: string): Promise<OpenFileTarget> {
  return unwrap(await commands.fileOpenResolve(path));
}

/** Checks the selected signed update manifest. */
export async function updateCheck(channel: string): Promise<UpdateCheckDoc> {
  return unwrap(await commands.updateCheck(channel));
}

/** Re-indexes and returns the vault tree. */
export async function vaultTreeRefresh(
  handle: VaultHandle,
): Promise<TreeEntry[]> {
  return unwrap(await commands.vaultTreeRefresh(handle));
}

/**
 * Converts UTF-8 byte ranges over a string (the IPC offset space) into
 * UTF-16 character ranges (the DOM offset space). Out-of-bounds or
 * boundary-splitting inputs clamp to the nearest character boundary.
 */
export function byteRangesToCharRanges(
  text: string,
  byteRanges: readonly [number, number][],
): [number, number][] {
  // Prefix map from byte offset to character offset.
  const encoder = new TextEncoder();
  const byteToChar = new Map<number, number>();
  let byteOffset = 0;
  byteToChar.set(0, 0);
  for (let charOffset = 0; charOffset < text.length; ) {
    const codePoint = text.codePointAt(charOffset) ?? 0;
    const characterLength = codePoint > 0xffff ? 2 : 1;
    byteOffset += encoder.encode(
      text.slice(charOffset, charOffset + characterLength),
    ).length;
    charOffset += characterLength;
    byteToChar.set(byteOffset, charOffset);
  }
  const totalBytes = byteOffset;
  const clamp = (byte: number): number => {
    const clamped = Math.max(0, Math.min(byte, totalBytes));
    for (let candidate = clamped; candidate >= 0; candidate -= 1) {
      const char = byteToChar.get(candidate);
      if (char !== undefined) {
        return char;
      }
    }
    return 0;
  };
  return byteRanges.map(([start, end]) => [clamp(start), clamp(end)]);
}
