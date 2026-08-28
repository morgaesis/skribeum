// Typed wrappers for the search, settings and tree-refresh commands over
// the generated bindings, following the same unwrap-to-`IpcError`
// pattern as the vault layer, plus the byte-to-character range
// conversion search highlighting needs.

import type { Channel } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  commands,
  type MaximizeButtonRect,
  type OpenFileTarget,
  type SearchHit,
  type SettingsDoc,
  type TagFrequency,
  type TreeEntry,
  type UpdateCheckDoc,
  type UpdateProgressDoc,
  type VaultHandle,
  type VaultSessionDoc,
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

/** Shows the drag region's right-click window menu at the pointer: the real
 * platform system menu on Windows, a predefined-item approximation
 * elsewhere. */
export async function windowShowSystemMenu(): Promise<void> {
  unwrap(await commands.windowShowSystemMenu());
}

/** Reports the Maximize caption button's current rectangle so Windows
 * native hit-testing can answer `WM_NCHITTEST` for it; a no-op everywhere
 * except Windows. */
export async function windowSetMaximizeButtonRect(
  rect: MaximizeButtonRect | null,
): Promise<void> {
  unwrap(await commands.windowSetMaximizeButtonRect(rect));
}

/** Drains native file-open paths queued by argv or operating-system events. */
export async function openFilesTake(): Promise<string[]> {
  return unwrap(await commands.openFilesTake());
}

/** Reads the device-local vault recovery session. */
export async function vaultSessionRead(): Promise<VaultSessionDoc> {
  return unwrap(await commands.vaultSessionRead());
}

/** Removes one stale vault path from the device-local recovery session. */
export async function vaultSessionForget(
  path: string,
): Promise<VaultSessionDoc> {
  return unwrap(await commands.vaultSessionForget(path));
}

/** Resolves a native file path to the vault root and relative note path. */
export async function fileOpenResolve(path: string): Promise<OpenFileTarget> {
  return unwrap(await commands.fileOpenResolve(path));
}

/** Checks the newest published release's own signed update manifest. */
export async function updateCheck(): Promise<UpdateCheckDoc> {
  return unwrap(await commands.updateCheck());
}

/**
 * Downloads and installs the announced update through the same resolved
 * manifest the check read, reporting bytes as they arrive.
 */
export async function updateInstall(
  progress: Channel<UpdateProgressDoc>,
): Promise<UpdateCheckDoc> {
  return unwrap(await commands.updateInstall(progress));
}

/** Re-indexes and returns the vault tree. */
export async function vaultTreeRefresh(
  handle: VaultHandle,
): Promise<TreeEntry[]> {
  return unwrap(await commands.vaultTreeRefresh(handle));
}

/** Opens an HTTP or HTTPS URL through the desktop system browser. */
export async function openSystemUrl(url: string): Promise<void> {
  await openUrl(url);
}

/** Creates a folder and returns the refreshed tree. */
export async function treeFolderCreate(
  handle: VaultHandle,
  path: string,
): Promise<TreeEntry[]> {
  return unwrap(await commands.treeFolderCreate(handle, path));
}

/** Moves or renames an entry and returns the refreshed tree. */
export async function treeEntryMove(
  handle: VaultHandle,
  fromPath: string,
  toPath: string,
): Promise<TreeEntry[]> {
  return unwrap(await commands.treeEntryMove(handle, fromPath, toPath));
}

/** Deletes an entry and returns the refreshed tree. */
export async function treeEntryDelete(
  handle: VaultHandle,
  path: string,
): Promise<TreeEntry[]> {
  return unwrap(await commands.treeEntryDelete(handle, path));
}

/** Reveals an indexed entry in the system file manager. */
export async function treeEntryReveal(
  handle: VaultHandle,
  path: string,
): Promise<void> {
  unwrap(await commands.treeEntryReveal(handle, path));
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
