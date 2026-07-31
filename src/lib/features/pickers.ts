// Item building for the picker overlays: the command palette listing
// (exactly the registry's palette commands), quick-switcher ranking over
// the vault tree with recent notes first, and vault-search result rows
// with match highlighting as text segments, never markup.

import { fuzzyMatch, segmentByPositions, type TextSegment } from "../fuzzy";
import { byteRangesToCharRanges, type SearchResult } from "../ipc/services";
import type { CommandRegistry } from "../registry";
import { formatKeybinding } from "../registry";

/** One row of a picker overlay. */
export type PickerItem = {
  /** Stable identity of the row (command id, note path). */
  id: string;
  /** Title as highlight segments. */
  titleSegments: TextSegment[];
  /** Optional secondary line (search snippet) as segments. */
  detailSegments?: TextSegment[];
  /** Displayed keybinding, when one exists. */
  keybinding?: string;
};

function plainSegments(text: string): TextSegment[] {
  return text.length === 0 ? [] : [{ text, highlighted: false }];
}

/** The palette listing for `query`: the registry's palette commands. */
export function paletteItems(
  registry: CommandRegistry,
  query: string,
  macPlatform: boolean,
): PickerItem[] {
  return registry
    .paletteCommands()
    .map((command) => ({ command, match: fuzzyMatch(query, command.title) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
    .map(({ command, match }) => {
      const binding = command.keybindings?.[0];
      return {
        id: command.id,
        titleSegments: segmentByPositions(
          command.title,
          match?.positions ?? [],
        ),
        ...(binding === undefined
          ? {}
          : { keybinding: formatKeybinding(binding, macPlatform) }),
      };
    });
}

/**
 * Ranks note paths for the quick switcher: with an empty query, recent
 * notes first (most recent leading) then the rest alphabetically; with a
 * query, fuzzy score ordering with a recency bonus.
 */
export function quickSwitcherItems(
  paths: readonly string[],
  recents: readonly string[],
  query: string,
  limit = 100,
): PickerItem[] {
  const recentRank = new Map<string, number>();
  for (const [index, path] of recents.entries()) {
    if (!recentRank.has(path)) {
      recentRank.set(path, index);
    }
  }
  if (query.length === 0) {
    const known = new Set(paths);
    const recentFirst = recents.filter((path) => known.has(path));
    const rest = paths
      .filter((path) => !recentRank.has(path))
      .sort((a, b) => a.localeCompare(b));
    return [...recentFirst, ...rest].slice(0, limit).map((path) => ({
      id: path,
      titleSegments: plainSegments(path),
    }));
  }
  return paths
    .map((path) => ({ path, match: fuzzyMatch(query, path) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => {
      const recencyA = recentRank.has(a.path) ? 20 : 0;
      const recencyB = recentRank.has(b.path) ? 20 : 0;
      return (
        (b.match?.score ?? 0) + recencyB - ((a.match?.score ?? 0) + recencyA)
      );
    })
    .slice(0, limit)
    .map(({ path, match }) => ({
      id: path,
      titleSegments: segmentByPositions(path, match?.positions ?? []),
    }));
}

/** Splits `text` into segments from `[from, to)` character ranges. */
export function segmentByCharRanges(
  text: string,
  ranges: readonly [number, number][],
): TextSegment[] {
  const positions: number[] = [];
  for (const [from, to] of ranges) {
    for (
      let index = Math.max(0, from);
      index < Math.min(to, text.length);
      index += 1
    ) {
      positions.push(index);
    }
  }
  return segmentByPositions(text, positions);
}

/**
 * Search result rows: title plus snippet with the match ranges (UTF-8
 * byte offsets over the snippet) highlighted as segments.
 */
export function searchResultItems(
  results: readonly SearchResult[],
): PickerItem[] {
  return results.map((result) => ({
    id: result.path,
    titleSegments: plainSegments(
      result.title.length > 0 ? result.title : result.path,
    ),
    detailSegments: segmentByCharRanges(
      result.snippet,
      byteRangesToCharRanges(result.snippet, result.match_ranges),
    ),
  }));
}

/**
 * The text under a result's first match range, for locating the match in
 * the opened note. Null when the result carries no ranges.
 */
export function firstMatchText(result: SearchResult): string | null {
  const first = result.match_ranges[0];
  if (first === undefined) {
    return null;
  }
  const [range] = byteRangesToCharRanges(result.snippet, [first]);
  if (range === undefined || range[1] <= range[0]) {
    return null;
  }
  return result.snippet.slice(range[0], range[1]);
}
