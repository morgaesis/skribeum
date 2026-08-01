import { DEMO_FILES } from "../vault/seed";
import type {
  SearchHit,
  SettingsDoc,
  TreeEntry,
  VaultHandle,
} from "./bindings";
import { readNote, vaultTree } from "./vault";

export type SearchResult = SearchHit;
export type SettingsDocument = SettingsDoc;

const SETTINGS_KEY = "skribeum.demo.settings";
const DEFAULT_SETTINGS: SettingsDocument = {
  schema_version: 1,
  theme: "system",
  editor_font_size: 17,
  editor_reading_measure: 76,
  search_result_limit: 50,
};
const THEMES = new Set(["system", "light", "dark"]);
const FONT_SIZE_RANGE = [6, 128] as const;
const READING_MEASURE_RANGE = [45, 120] as const;
const RESULT_LIMIT_RANGE = [1, 1000] as const;
const encoder = new TextEncoder();

function queryTerms(query: string): string[] {
  return [
    ...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []),
  ];
}

function byteOffset(text: string, characterOffset: number): number {
  return encoder.encode(text.slice(0, characterOffset)).byteLength;
}

function snippetFor(
  text: string,
  matches: readonly { start: number; end: number }[],
): Pick<SearchResult, "snippet" | "match_ranges"> {
  const first = matches[0];
  if (first === undefined) {
    return { snippet: "", match_ranges: [] };
  }
  const start = Math.max(0, first.start - 70);
  const end = Math.min(text.length, first.end + 120);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  const body = text.slice(start, end).replaceAll("\n", " ");
  const snippet = `${prefix}${body}${suffix}`;
  const prefixLength = prefix.length;
  const ranges = matches
    .filter((match) => match.start < end && match.end > start)
    .map((match): [number, number] => {
      const localStart = prefixLength + Math.max(0, match.start - start);
      const localEnd = prefixLength + Math.min(end - start, match.end - start);
      return [byteOffset(snippet, localStart), byteOffset(snippet, localEnd)];
    });
  return { snippet, match_ranges: ranges };
}

export async function searchQuery(
  handle: VaultHandle,
  query: string,
  limit: number,
): Promise<SearchResult[]> {
  const terms = queryTerms(query);
  if (terms.length === 0 || limit <= 0) {
    return [];
  }

  const results: Array<SearchResult & { firstPosition: number }> = [];
  for (const path of Object.keys(DEMO_FILES)) {
    if (!path.toLowerCase().endsWith(".md")) {
      continue;
    }
    const text = (await readNote(handle, path)).text;
    const folded = text.toLocaleLowerCase();
    const matches = terms
      .map((term) => {
        const start = folded.indexOf(term);
        return start < 0 ? null : { start, end: start + term.length };
      })
      .filter(
        (match): match is { start: number; end: number } => match !== null,
      )
      .sort((left, right) => left.start - right.start);
    if (matches.length !== terms.length) {
      continue;
    }
    const firstPosition = matches[0]?.start ?? Number.MAX_SAFE_INTEGER;
    results.push({
      path,
      title: path.split("/").at(-1)?.replace(/\.md$/i, "") ?? path,
      ...snippetFor(text, matches),
      score: 1 / (1 + firstPosition),
      firstPosition,
    });
  }

  return results
    .sort(
      (left, right) =>
        left.firstPosition - right.firstPosition ||
        left.path.localeCompare(right.path),
    )
    .slice(0, limit)
    .map(({ firstPosition: _firstPosition, ...result }) => result);
}

function integerInRange(
  value: unknown,
  [minimum, maximum]: readonly [number, number],
): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function normalizeSettings(value: unknown): SettingsDocument {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as Partial<SettingsDocument>)
      : {};
  return {
    schema_version: integerInRange(candidate.schema_version, [0, 0xffffffff])
      ? candidate.schema_version
      : DEFAULT_SETTINGS.schema_version,
    theme:
      typeof candidate.theme === "string" && THEMES.has(candidate.theme)
        ? candidate.theme
        : DEFAULT_SETTINGS.theme,
    editor_font_size: integerInRange(
      candidate.editor_font_size,
      FONT_SIZE_RANGE,
    )
      ? candidate.editor_font_size
      : DEFAULT_SETTINGS.editor_font_size,
    editor_reading_measure: integerInRange(
      candidate.editor_reading_measure,
      READING_MEASURE_RANGE,
    )
      ? candidate.editor_reading_measure
      : DEFAULT_SETTINGS.editor_reading_measure,
    search_result_limit: integerInRange(
      candidate.search_result_limit,
      RESULT_LIMIT_RANGE,
    )
      ? candidate.search_result_limit
      : DEFAULT_SETTINGS.search_result_limit,
  };
}

function validateSettings(doc: SettingsDocument): void {
  if (!THEMES.has(doc.theme)) {
    throw new Error("settings value out of range: theme");
  }
  if (!integerInRange(doc.editor_font_size, FONT_SIZE_RANGE)) {
    throw new Error("settings value out of range: editor_font_size");
  }
  if (!integerInRange(doc.editor_reading_measure, READING_MEASURE_RANGE)) {
    throw new Error("settings value out of range: editor_reading_measure");
  }
  if (!integerInRange(doc.search_result_limit, RESULT_LIMIT_RANGE)) {
    throw new Error("settings value out of range: search_result_limit");
  }
}

export async function settingsRead(): Promise<SettingsDocument> {
  const stored = globalThis.localStorage?.getItem(SETTINGS_KEY);
  if (stored === null || stored === undefined) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    return normalizeSettings(parsed);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function settingsWrite(doc: SettingsDocument): Promise<void> {
  validateSettings(doc);
  globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(doc));
}

export async function vaultTreeRefresh(
  handle: VaultHandle,
): Promise<TreeEntry[]> {
  return vaultTree(handle);
}

export function byteRangesToCharRanges(
  text: string,
  byteRanges: readonly [number, number][],
): [number, number][] {
  const byteToChar = new Map<number, number>();
  let bytes = 0;
  byteToChar.set(0, 0);
  for (let character = 0; character < text.length; ) {
    const codePoint = text.codePointAt(character) ?? 0;
    const width = codePoint > 0xffff ? 2 : 1;
    bytes += encoder.encode(text.slice(character, character + width)).length;
    character += width;
    byteToChar.set(bytes, character);
  }
  const clamp = (offset: number): number => {
    for (
      let candidate = Math.max(0, Math.min(offset, bytes));
      candidate >= 0;
      candidate -= 1
    ) {
      const character = byteToChar.get(candidate);
      if (character !== undefined) {
        return character;
      }
    }
    return 0;
  };
  return byteRanges.map(([start, end]) => [clamp(start), clamp(end)]);
}
