import { parseFrontmatter } from "../../../src/lib/editor/frontmatter";
import { noteFileName } from "../../../src/lib/noteTitles";
import { STRINGS } from "../../../src/lib/strings";
import {
  defaultTaskStatuses,
  normalizeTaskStatuses,
  validateTaskStatusDocuments,
} from "../../../src/lib/taskStatuses";
import type {
  MaximizeButtonRect,
  OpenFileTarget,
  SearchHit,
  SettingsDoc,
  TagFrequency,
  TreeEntry,
  VaultHandle,
} from "./bindings";
import {
  readNote,
  treeEntryDelete,
  treeEntryMove,
  treeEntryReveal,
  treeFolderCreate,
  vaultTree,
} from "./vault";

export type SearchResult = SearchHit;
export type TagCatalogEntry = TagFrequency;
export type SettingsDocument = SettingsDoc;

const SETTINGS_KEY = "skribeum.demo.settings";
const DEFAULT_SETTINGS: SettingsDocument = {
  schema_version: 2,
  theme: "system",
  light_palette: "manuscript",
  dark_palette: "nightroom",
  prose_font: "serif",
  code_font: "modern",
  editor_font_size: 16,
  editor_line_height: 170,
  editor_line_width: 72,
  zoom_percent: 100,
  show_line_numbers: false,
  animations: true,
  autosave_delay_ms: 400,
  spell_check: true,
  indent_style: "spaces",
  indent_width: 2,
  wrap_long_lines: true,
  show_invisible_characters: false,
  reveal_markdown_syntax: true,
  default_note_folder: "",
  attachment_folder_mode: "vault",
  attachment_folder_path: "attachments",
  honor_obsidian_config: true,
  search_result_limit: 50,
  link_previews: true,
  search_note_bodies: true,
  search_case_sensitive: false,
  update_channel: "stable",
  check_updates_on_startup: true,
  task_statuses: defaultTaskStatuses(),
};
const THEMES = new Set(["system", "light", "dark"]);
const LIGHT_PALETTES = new Set(["manuscript", "studio", "gazette"]);
const DARK_PALETTES = new Set(["nightroom", "graphite", "signal"]);
const PROSE_FONTS = new Set(["serif", "sans"]);
const CODE_FONTS = new Set(["modern", "classic"]);
const FONT_SIZE_RANGE = [8, 40] as const;
const LINE_HEIGHT_RANGE = [120, 220] as const;
const LINE_WIDTH_RANGE = [45, 120] as const;
const AUTOSAVE_DELAY_RANGE = [100, 10_000] as const;
const INDENT_STYLES = new Set(["spaces", "tabs"]);
const INDENT_WIDTH_RANGE = [1, 8] as const;
const ATTACHMENT_FOLDER_MODES = new Set(["vault", "note", "folder"]);
const RESULT_LIMIT_RANGE = [1, 1000] as const;
const UPDATE_CHANNELS = new Set(["stable", "beta"]);
const EXCLUDED_VAULT_DIRECTORIES = new Set([
  ".git",
  ".obsidian",
  ".skribeum",
  ".stfolder",
  ".stversions",
  ".tmp.drivedownload",
]);
const encoder = new TextEncoder();

function queryTerms(query: string, caseSensitive: boolean): string[] {
  const source = caseSensitive ? query : query.toLocaleLowerCase();
  return [...new Set(source.match(/[\p{L}\p{N}_-]+/gu) ?? [])];
}

type TagUse = { tag: string; start: number; end: number };

function tagUses(text: string): TagUse[] {
  const frontmatter = parseFrontmatter(text);
  const uses: TagUse[] = [];
  const tagEntry = frontmatter?.entries.find((entry) => entry.key === "tags");
  const values =
    tagEntry?.items ??
    (tagEntry === undefined
      ? []
      : [
          { from: tagEntry.valueFrom, to: tagEntry.valueTo, raw: tagEntry.raw },
        ]);
  for (const value of values) {
    const tag = value.raw.trim().replace(/^#/, "");
    if (tag.length > 0) {
      uses.push({ tag, start: value.from, end: value.to });
    }
  }
  const bodyStart = frontmatter?.to ?? 0;
  const body = text.slice(bodyStart);
  for (const match of body.matchAll(/(^|\s)#([\p{L}\p{N}\p{M}_/-]+)/gu)) {
    const raw = match[2]?.replace(/\/+$/, "") ?? "";
    if (raw.length === 0 || /^\p{N}+$/u.test(raw)) {
      continue;
    }
    const start = bodyStart + (match.index ?? 0) + (match[1]?.length ?? 0);
    uses.push({ tag: raw, start, end: start + raw.length + 1 });
  }
  return uses;
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
  searchNoteBodies = true,
  caseSensitive = false,
): Promise<SearchResult[]> {
  const taggedWith = query.match(/^#([^\s#]+)$/u)?.[1];
  if (taggedWith !== undefined && limit > 0) {
    const normalized = taggedWith.toLocaleLowerCase();
    const results: SearchResult[] = [];
    for (const entry of await vaultTree(handle)) {
      if (entry.kind !== "note") {
        continue;
      }
      const text = (await readNote(handle, entry.path)).text;
      // A tag is a path and a query for it includes everything below it,
      // anchored at a segment boundary.
      const matches = tagUses(text).filter((use) => {
        const tag = use.tag.toLocaleLowerCase();
        return tag === normalized || tag.startsWith(`${normalized}/`);
      });
      if (matches.length === 0) {
        continue;
      }
      const title = noteFileName(entry.path);
      results.push({
        path: entry.path,
        title,
        ...snippetFor(text, [matches[0] as TagUse]),
        score: matches.length,
      });
    }
    return results
      .sort(
        (left, right) =>
          (right.score ?? 0) - (left.score ?? 0) ||
          left.path.localeCompare(right.path),
      )
      .slice(0, limit);
  }
  const terms = queryTerms(query, caseSensitive);
  if (terms.length === 0 || limit <= 0) {
    return [];
  }

  const results: Array<SearchResult & { firstPosition: number }> = [];
  for (const entry of await vaultTree(handle)) {
    if (entry.kind !== "note") {
      continue;
    }
    const path = entry.path;
    const text = (await readNote(handle, path)).text;
    const title = noteFileName(path);
    const source = searchNoteBodies ? `${title}\n${text}` : title;
    const searchable = caseSensitive ? source : source.toLocaleLowerCase();
    const matches = terms
      .map((term) => {
        const start = searchable.indexOf(term);
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
      title,
      ...snippetFor(source, matches),
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

/** The first `depth` `/`-separated segments of a tag path. */
function leadingSegments(tag: string, depth: number): string {
  let seen = 0;
  for (let index = 0; index < tag.length; index += 1) {
    if (tag[index] === "/") {
      seen += 1;
      if (seen === depth) {
        return tag.slice(0, index);
      }
    }
  }
  return tag;
}

/**
 * The vault's tags with the counts they answer with: a tag is a path and a
 * query for it includes everything below it, so `work` counts the notes
 * tagged `work` together with those tagged `work/meetings`, each note once.
 * A parent no note writes on its own is not listed; it answers by being
 * derived from its children's paths at match time.
 */
export async function tagCatalog(
  handle: VaultHandle,
): Promise<TagCatalogEntry[]> {
  const totals = new Map<
    string,
    {
      tag: string;
      written: boolean;
      notes: Set<string>;
      occurrence_count: number;
    }
  >();
  for (const entry of await vaultTree(handle)) {
    if (entry.kind !== "note") {
      continue;
    }
    for (const use of tagUses((await readNote(handle, entry.path)).text)) {
      const normalized = use.tag.toLocaleLowerCase();
      const segments = normalized.split("/").length;
      for (let depth = 1; depth <= segments; depth += 1) {
        const ancestor = leadingSegments(normalized, depth);
        const total = totals.get(ancestor) ?? {
          tag: leadingSegments(use.tag, depth),
          written: false,
          notes: new Set<string>(),
          occurrence_count: 0,
        };
        total.written ||= depth === segments;
        total.notes.add(entry.path);
        total.occurrence_count += 1;
        totals.set(ancestor, total);
      }
    }
  }
  return [...totals.values()]
    .filter((total) => total.written)
    .map((total) => ({
      tag: total.tag,
      note_count: total.notes.size,
      occurrence_count: total.occurrence_count,
    }))
    .sort(
      (left, right) =>
        right.occurrence_count - left.occurrence_count ||
        left.tag.localeCompare(right.tag),
    );
}

export async function updateCheck(
  _channel: string,
): Promise<{ kind: "current" }> {
  return { kind: "current" };
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

function choice(
  value: unknown,
  choices: ReadonlySet<string>,
  fallback: string,
): string {
  return typeof value === "string" && choices.has(value) ? value : fallback;
}

function folder(value: unknown, allowEmpty: boolean, fallback: string): string {
  if (typeof value !== "string" || !isSafeVaultFolder(value, allowEmpty)) {
    return fallback;
  }
  return value;
}

function isSafeVaultFolder(value: string, allowEmpty: boolean): boolean {
  if (value === "") {
    return allowEmpty;
  }
  const segments = value.split("/");
  return (
    !value.startsWith("/") &&
    !value.includes(":") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    segments.every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !EXCLUDED_VAULT_DIRECTORIES.has(segment),
    )
  );
}

function normalizeSettings(value: unknown): SettingsDocument {
  const candidate =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  return {
    schema_version: integerInRange(candidate.schema_version, [0, 0xffffffff])
      ? candidate.schema_version
      : DEFAULT_SETTINGS.schema_version,
    theme: choice(candidate.theme, THEMES, DEFAULT_SETTINGS.theme),
    light_palette: choice(
      candidate.light_palette,
      LIGHT_PALETTES,
      DEFAULT_SETTINGS.light_palette,
    ),
    dark_palette: choice(
      candidate.dark_palette,
      DARK_PALETTES,
      DEFAULT_SETTINGS.dark_palette,
    ),
    prose_font: choice(
      candidate.prose_font,
      PROSE_FONTS,
      DEFAULT_SETTINGS.prose_font,
    ),
    code_font: choice(
      candidate.code_font,
      CODE_FONTS,
      DEFAULT_SETTINGS.code_font,
    ),
    editor_font_size: integerInRange(
      candidate.editor_font_size,
      FONT_SIZE_RANGE,
    )
      ? candidate.editor_font_size
      : DEFAULT_SETTINGS.editor_font_size,
    editor_line_height: integerInRange(
      candidate.editor_line_height,
      LINE_HEIGHT_RANGE,
    )
      ? candidate.editor_line_height
      : DEFAULT_SETTINGS.editor_line_height,
    editor_line_width: integerInRange(
      candidate.editor_line_width,
      LINE_WIDTH_RANGE,
    )
      ? candidate.editor_line_width
      : integerInRange(candidate.editor_reading_measure, LINE_WIDTH_RANGE)
        ? candidate.editor_reading_measure
        : DEFAULT_SETTINGS.editor_line_width,
    zoom_percent:
      integerInRange(candidate.zoom_percent, [50, 200]) &&
      candidate.zoom_percent % 10 === 0
        ? candidate.zoom_percent
        : DEFAULT_SETTINGS.zoom_percent,
    show_line_numbers:
      typeof candidate.show_line_numbers === "boolean"
        ? candidate.show_line_numbers
        : DEFAULT_SETTINGS.show_line_numbers,
    animations:
      typeof candidate.animations === "boolean"
        ? candidate.animations
        : DEFAULT_SETTINGS.animations,
    autosave_delay_ms: integerInRange(
      candidate.autosave_delay_ms,
      AUTOSAVE_DELAY_RANGE,
    )
      ? candidate.autosave_delay_ms
      : DEFAULT_SETTINGS.autosave_delay_ms,
    spell_check:
      typeof candidate.spell_check === "boolean"
        ? candidate.spell_check
        : DEFAULT_SETTINGS.spell_check,
    indent_style: choice(
      candidate.indent_style,
      INDENT_STYLES,
      DEFAULT_SETTINGS.indent_style,
    ),
    indent_width: integerInRange(candidate.indent_width, INDENT_WIDTH_RANGE)
      ? candidate.indent_width
      : DEFAULT_SETTINGS.indent_width,
    wrap_long_lines:
      typeof candidate.wrap_long_lines === "boolean"
        ? candidate.wrap_long_lines
        : DEFAULT_SETTINGS.wrap_long_lines,
    show_invisible_characters:
      typeof candidate.show_invisible_characters === "boolean"
        ? candidate.show_invisible_characters
        : DEFAULT_SETTINGS.show_invisible_characters,
    reveal_markdown_syntax:
      typeof candidate.reveal_markdown_syntax === "boolean"
        ? candidate.reveal_markdown_syntax
        : DEFAULT_SETTINGS.reveal_markdown_syntax,
    default_note_folder: folder(
      candidate.default_note_folder,
      true,
      DEFAULT_SETTINGS.default_note_folder,
    ),
    attachment_folder_mode: choice(
      candidate.attachment_folder_mode,
      ATTACHMENT_FOLDER_MODES,
      DEFAULT_SETTINGS.attachment_folder_mode,
    ),
    attachment_folder_path: folder(
      candidate.attachment_folder_path,
      false,
      DEFAULT_SETTINGS.attachment_folder_path,
    ),
    honor_obsidian_config:
      typeof candidate.honor_obsidian_config === "boolean"
        ? candidate.honor_obsidian_config
        : DEFAULT_SETTINGS.honor_obsidian_config,
    search_result_limit: integerInRange(
      candidate.search_result_limit,
      RESULT_LIMIT_RANGE,
    )
      ? candidate.search_result_limit
      : DEFAULT_SETTINGS.search_result_limit,
    link_previews:
      typeof candidate.link_previews === "boolean"
        ? candidate.link_previews
        : DEFAULT_SETTINGS.link_previews,
    search_note_bodies:
      typeof candidate.search_note_bodies === "boolean"
        ? candidate.search_note_bodies
        : DEFAULT_SETTINGS.search_note_bodies,
    search_case_sensitive:
      typeof candidate.search_case_sensitive === "boolean"
        ? candidate.search_case_sensitive
        : DEFAULT_SETTINGS.search_case_sensitive,
    update_channel: choice(
      candidate.update_channel,
      UPDATE_CHANNELS,
      DEFAULT_SETTINGS.update_channel,
    ),
    check_updates_on_startup:
      typeof candidate.check_updates_on_startup === "boolean"
        ? candidate.check_updates_on_startup
        : DEFAULT_SETTINGS.check_updates_on_startup,
    task_statuses: normalizeTaskStatuses(candidate.task_statuses),
  };
}

function validateSettings(doc: SettingsDocument): void {
  validateRange("schema_version", doc.schema_version, [0, 0xffffffff]);
  validateChoice("theme", doc.theme, THEMES);
  validateChoice("light_palette", doc.light_palette, LIGHT_PALETTES);
  validateChoice("dark_palette", doc.dark_palette, DARK_PALETTES);
  validateChoice("prose_font", doc.prose_font, PROSE_FONTS);
  validateChoice("code_font", doc.code_font, CODE_FONTS);
  validateRange("editor_font_size", doc.editor_font_size, FONT_SIZE_RANGE);
  validateRange(
    "editor_line_height",
    doc.editor_line_height,
    LINE_HEIGHT_RANGE,
  );
  validateRange("editor_line_width", doc.editor_line_width, LINE_WIDTH_RANGE);
  validateRange("zoom_percent", doc.zoom_percent, [50, 200]);
  if (doc.zoom_percent % 10 !== 0) throw new Error("zoom_percent");
  validateBoolean("show_line_numbers", doc.show_line_numbers);
  validateBoolean("animations", doc.animations);
  validateRange(
    "autosave_delay_ms",
    doc.autosave_delay_ms,
    AUTOSAVE_DELAY_RANGE,
  );
  validateBoolean("spell_check", doc.spell_check);
  validateChoice("indent_style", doc.indent_style, INDENT_STYLES);
  validateRange("indent_width", doc.indent_width, INDENT_WIDTH_RANGE);
  validateBoolean("wrap_long_lines", doc.wrap_long_lines);
  validateBoolean("show_invisible_characters", doc.show_invisible_characters);
  validateBoolean("reveal_markdown_syntax", doc.reveal_markdown_syntax);
  if (!isSafeVaultFolder(doc.default_note_folder, true)) {
    throw new Error("settings value out of range: default_note_folder");
  }
  validateChoice(
    "attachment_folder_mode",
    doc.attachment_folder_mode,
    ATTACHMENT_FOLDER_MODES,
  );
  if (!isSafeVaultFolder(doc.attachment_folder_path, false)) {
    throw new Error("settings value out of range: attachment_folder_path");
  }
  validateBoolean("honor_obsidian_config", doc.honor_obsidian_config);
  validateRange(
    "search_result_limit",
    doc.search_result_limit,
    RESULT_LIMIT_RANGE,
  );
  validateBoolean("search_note_bodies", doc.search_note_bodies);
  validateBoolean("search_case_sensitive", doc.search_case_sensitive);
  validateChoice("update_channel", doc.update_channel, UPDATE_CHANNELS);
  validateBoolean("check_updates_on_startup", doc.check_updates_on_startup);
  validateBoolean("link_previews", doc.link_previews);
  if (
    JSON.stringify(validateTaskStatusDocuments(doc.task_statuses)) !==
    JSON.stringify(doc.task_statuses)
  ) {
    throw new Error("settings value out of range: task_statuses");
  }
}

function validateBoolean(name: string, value: boolean): void {
  if (typeof value !== "boolean") {
    throw new Error(`settings value out of range: ${name}`);
  }
}

function validateChoice(
  name: string,
  value: string,
  choices: ReadonlySet<string>,
): void {
  if (!choices.has(value)) {
    throw new Error(`settings value out of range: ${name}`);
  }
}

function validateRange(
  name: string,
  value: number,
  range: readonly [number, number],
): void {
  if (!integerInRange(value, range)) {
    throw new Error(`settings value out of range: ${name}`);
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

export async function settingsPath(): Promise<string> {
  throw new Error(STRINGS.settingsDesktopUnavailableShort);
}

export async function settingsWrite(doc: SettingsDocument): Promise<void> {
  validateSettings(doc);
  const stored = globalThis.localStorage?.getItem(SETTINGS_KEY);
  let preserved: Record<string, unknown> = {};
  if (stored !== null && stored !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stored);
    } catch {
      throw new Error("settings document is not valid JSON");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("settings document is not a JSON object");
    }
    preserved = parsed as Record<string, unknown>;
  }
  globalThis.localStorage?.setItem(
    SETTINGS_KEY,
    JSON.stringify({ ...preserved, ...doc }),
  );
}

export async function zoomSet(_zoomPercent: number): Promise<number> {
  throw new Error(STRINGS.desktopWindowRequired);
}

export async function windowReady(_webviewMilliseconds: number): Promise<void> {
  throw new Error(STRINGS.desktopWindowRequired);
}

export async function windowShowSystemMenu(): Promise<void> {
  throw new Error(STRINGS.desktopWindowRequired);
}

export async function windowSetMaximizeButtonRect(
  _rect: MaximizeButtonRect | null,
): Promise<void> {
  throw new Error(STRINGS.desktopWindowRequired);
}

export async function openFilesTake(): Promise<string[]> {
  return [];
}

/** The browser demo has no device-local vault session. */
export async function vaultSessionRead(): Promise<never> {
  throw new Error(STRINGS.nativeFileHandlingDesktopRequired);
}

/** The browser demo never mutates a device-local vault session. */
export async function vaultSessionForget(_path: string): Promise<never> {
  throw new Error(STRINGS.nativeFileHandlingDesktopRequired);
}

export async function fileOpenResolve(_path: string): Promise<OpenFileTarget> {
  throw new Error(STRINGS.nativeFileHandlingDesktopRequired);
}

export async function vaultTreeRefresh(
  handle: VaultHandle,
): Promise<TreeEntry[]> {
  return vaultTree(handle);
}

export async function openSystemUrl(url: string): Promise<void> {
  globalThis.open(url, "_blank", "noopener");
}

export { treeEntryDelete, treeEntryMove, treeEntryReveal, treeFolderCreate };

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
