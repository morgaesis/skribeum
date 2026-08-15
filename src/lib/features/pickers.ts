// Item building for the unified command surface. Prefix parsing selects one
// result builder, so unrelated result kinds never enter the same ranked list.

import { fuzzyMatch, segmentByPositions, type TextSegment } from "../fuzzy";
import { byteRangesToCharRanges, type SearchResult } from "../ipc/services";
import { resolveTitleCollisions } from "../noteTitles";
import type { CommandRegistry } from "../registry";
import { formatKeybinding } from "../registry";
import { STRINGS } from "../strings";

/** One row of a picker overlay. */
export type PickerItem = {
  /** Stable identity of the row within the open surface. */
  id: string;
  /** The value consumed when the row is invoked. */
  value: string;
  /** Search mode owning this row. */
  kind: PickerMode;
  /** Optional semantic subtype within command mode. */
  actionKind?: "command" | "setting";
  /** Optional labeled group for file-mode ordering. */
  group?: string;
  /** Registered command identity, when this row invokes one. */
  commandId?: string;
  /** Title as highlight segments. */
  titleSegments: TextSegment[];
  /** Optional secondary line (search snippet) as segments. */
  detailSegments?: TextSegment[];
  /** Muted file-name suffix used to distinguish colliding display titles. */
  titleSuffix?: string;
  /** Displayed keybinding, when one exists. */
  keybinding?: string;
  /** Prefix hint shown by discovery rows in bare file mode. */
  prefixHint?: ">" | "#";
  /**
   * Why this row cannot be invoked right now. A row carrying one is listed
   * so the capability stays discoverable, shown as unavailable, and refuses
   * to run.
   */
  unavailableReason?: string;
};

export type PickerMode = "file" | "command" | "tag" | "text";

export type ParsedPickerQuery = { mode: PickerMode; query: string };

export function parsePickerQuery(query: string): ParsedPickerQuery {
  switch (query[0]) {
    case ">":
      return { mode: "command", query: query.slice(1) };
    case "#":
      return { mode: "tag", query: query.slice(1) };
    case "?":
      return { mode: "text", query: query.slice(1) };
    default:
      return { mode: "file", query };
  }
}

function plainSegments(text: string): TextSegment[] {
  return text.length === 0 ? [] : [{ text, highlighted: false }];
}

function bestCommandMatch(
  query: string,
  command: ReturnType<CommandRegistry["paletteCommands"]>[number],
) {
  return (
    [command.title, ...(command.searchTerms ?? [])]
      .map((text) => fuzzyMatch(query, text))
      .filter((match) => match !== null)
      .sort((left, right) => (right?.score ?? 0) - (left?.score ?? 0))[0] ??
    null
  );
}

/** Command-mode results, with ordinary commands winning equal setting scores. */
export function commandItems(
  registry: CommandRegistry,
  query: string,
  macPlatform: boolean,
): PickerItem[] {
  return registry
    .paletteCommands()
    .map((command) => ({ command, match: bestCommandMatch(query, command) }))
    .filter((entry) => entry.match !== null)
    .sort((a, b) => {
      const score = (b.match?.score ?? 0) - (a.match?.score ?? 0);
      if (score !== 0) return score;
      const kind =
        (a.command.kind === "setting" ? 1 : 0) -
        (b.command.kind === "setting" ? 1 : 0);
      return kind !== 0 ? kind : a.command.title.localeCompare(b.command.title);
    })
    .map(({ command }) => {
      const binding = command.keybindings?.[0];
      const titleMatch = fuzzyMatch(query, command.title);
      return {
        id: `command:${command.id}`,
        value: command.id,
        kind: "command" as const,
        actionKind: command.kind ?? "command",
        group: STRINGS.commandSurfaceCommands,
        commandId: command.id,
        titleSegments: segmentByPositions(
          command.title,
          titleMatch?.positions ?? [],
        ),
        ...(binding === undefined
          ? {}
          : { keybinding: formatKeybinding(binding, macPlatform) }),
      };
    });
}

function displayName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.replace(/\.(?:md|markdown|txt)$/iu, "");
}

/** File-mode results grouped as open notes, recent notes, then the vault. */
export function fileItems(
  paths: readonly string[],
  recents: readonly string[],
  openPaths: readonly string[],
  query: string,
  limit = 100,
  titleSources: Readonly<Record<string, string>> = {},
): PickerItem[] {
  const known = new Set(paths);
  const open = [...new Set(openPaths)].filter((path) => known.has(path));
  const recent = [...new Set(recents)].filter(
    (path) => known.has(path) && !open.includes(path),
  );
  const reserved = new Set([...open, ...recent]);
  const vault = paths.filter((path) => !reserved.has(path));
  const resolvedTitles = resolveTitleCollisions(
    paths.map((path) => ({
      path,
      source: titleSources[path] ?? "",
    })),
  );
  const titles = new Map(
    paths.map((path, index) => [path, resolvedTitles[index]]),
  );
  const ranked = (candidates: readonly string[], group: string) => {
    return candidates
      .map((path) => {
        const title = titles.get(path);
        const name = title?.displayTitle ?? displayName(path);
        const nameMatch = fuzzyMatch(query, name);
        const fileNameMatch = fuzzyMatch(query, displayName(path));
        const pathMatch = fuzzyMatch(query, path);
        const match =
          [nameMatch, fileNameMatch, pathMatch]
            .filter((candidate) => candidate !== null)
            .sort(
              (left, right) => (right?.score ?? -1) - (left?.score ?? -1),
            )[0] ?? null;
        return { path, name, nameMatch, match, title };
      })
      .filter((entry) => entry.match !== null)
      .sort(
        (a, b) =>
          (b.match?.score ?? 0) - (a.match?.score ?? 0) ||
          a.path.localeCompare(b.path),
      )
      .map(({ path, name, nameMatch, title }) => ({
        id: `file:${path}`,
        value: path,
        kind: "file" as const,
        group,
        titleSegments: segmentByPositions(name, nameMatch?.positions ?? []),
        ...(title?.collisionSuffix === undefined
          ? {}
          : { titleSuffix: title.collisionSuffix }),
        detailSegments: plainSegments(path),
      }));
  };
  const items: PickerItem[] = [
    ...ranked(open, STRINGS.commandSurfaceOpenNotes),
    ...ranked(recent, STRINGS.commandSurfaceRecent),
    ...ranked(vault, STRINGS.commandSurfaceVault),
  ].slice(0, limit);
  if (query.length > 0) {
    items.push({
      id: `text-search:${query}`,
      value: query,
      kind: "file",
      group: STRINGS.commandSurfaceVault,
      titleSegments: plainSegments(
        `${STRINGS.commandSurfaceSearchTextPrefix}${query}`,
      ),
    });
  }
  return items;
}

export function tagItems(
  tags: readonly { tag: string; noteCount: number; occurrenceCount: number }[],
  query: string,
): PickerItem[] {
  return tags
    .map((entry) => ({ entry, match: fuzzyMatch(query, entry.tag) }))
    .filter(({ match }) => match !== null)
    .sort(
      (a, b) =>
        (b.match?.score ?? 0) - (a.match?.score ?? 0) ||
        a.entry.tag.localeCompare(b.entry.tag),
    )
    .map(({ entry, match }) => ({
      id: `tag:${entry.tag}`,
      value: entry.tag,
      kind: "tag",
      group: STRINGS.commandSurfaceTags,
      titleSegments: segmentByPositions(
        `#${entry.tag}`,
        (match?.positions ?? []).map((position) => position + 1),
      ),
    }));
}

/**
 * Adds the bounded discovery groups to a non-empty bare query while keeping
 * each result kind in its own labeled group. The note-text fallback remains
 * the final row.
 */
export function appendBareDiscoveryItems(
  files: readonly PickerItem[],
  commands: readonly PickerItem[],
  tags: readonly PickerItem[],
  query: string,
): PickerItem[] {
  if (query.length === 0) return [...files];
  const textSearch = files.find((item) => item.id.startsWith("text-search:"));
  const fileResults = files.filter(
    (item) => !item.id.startsWith("text-search:"),
  );
  return [
    ...fileResults,
    ...commands.slice(0, 3).map(({ keybinding: _keybinding, ...item }) => ({
      ...item,
      group: STRINGS.commandSurfaceCommands,
      prefixHint: ">" as const,
    })),
    ...tags.slice(0, 3).map((item) => ({
      ...item,
      group: STRINGS.commandSurfaceTags,
      prefixHint: "#" as const,
    })),
    ...(textSearch === undefined
      ? []
      : [(({ group: _group, ...item }) => item)(textSearch)]),
  ];
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
    id: `text:${result.path}`,
    value: result.path,
    kind: "text",
    group: STRINGS.commandSurfaceNoteText,
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
