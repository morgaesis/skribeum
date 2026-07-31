// Frontmatter parsing for the properties panel: a positional read of the
// leading YAML block that records the exact character range of every value
// so panel edits replace precisely the value's bytes and nothing else.
// This is deliberately not a YAML loader: key order is positional,
// duplicate keys stay duplicated, unrecognized shapes fall back to plain
// text editing of the raw value, and untouched lines are never rewritten.

/** How a value renders and edits in the properties panel. */
export type FrontmatterValueType =
  | "text"
  | "number"
  | "boolean"
  | "date"
  | "list";

export type FrontmatterListItem = {
  /** Character range of the item's raw text within the document. */
  from: number;
  to: number;
  raw: string;
};

export type FrontmatterEntry = {
  key: string;
  /** Character range of the key text within the document. */
  keyFrom: number;
  keyTo: number;
  /**
   * Character range of the raw scalar value within the document. For list
   * entries this covers nothing editable directly; the items carry the
   * editable ranges.
   */
  valueFrom: number;
  valueTo: number;
  raw: string;
  type: FrontmatterValueType;
  items?: FrontmatterListItem[];
};

export type Frontmatter = {
  /** Character range of the whole block, fences included. */
  from: number;
  to: number;
  entries: FrontmatterEntry[];
};

/**
 * Obsidian `.obsidian/types.json` property types mapped onto the panel's
 * value types (decision 101). Unknown declared types fall back to text.
 */
export function panelTypeForObsidianType(
  declared: string,
): FrontmatterValueType | null {
  switch (declared) {
    case "checkbox":
      return "boolean";
    case "number":
      return "number";
    case "date":
    case "datetime":
      return "date";
    case "multitext":
    case "tags":
    case "aliases":
      return "list";
    case "text":
      return "text";
    default:
      return null;
  }
}

/** Parses the text of `.obsidian/types.json` into key-to-type overrides. */
export function parseObsidianTypes(
  jsonText: string,
): Record<string, FrontmatterValueType> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  const types = (parsed as { types?: unknown }).types;
  if (typeof types !== "object" || types === null) {
    return {};
  }
  const overrides: Record<string, FrontmatterValueType> = {};
  for (const [key, declared] of Object.entries(types)) {
    if (typeof declared === "string") {
      const mapped = panelTypeForObsidianType(declared);
      if (mapped !== null) {
        overrides[key] = mapped;
      }
    }
  }
  return overrides;
}

const NUMBER_VALUE = /^-?\d+(\.\d+)?$/;
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}([T ][0-9:.+Z-]+)?$/;

function inferScalarType(raw: string): FrontmatterValueType {
  if (raw === "true" || raw === "false") {
    return "boolean";
  }
  if (NUMBER_VALUE.test(raw)) {
    return "number";
  }
  if (DATE_VALUE.test(raw)) {
    return "date";
  }
  return "text";
}

type DocumentLine = { from: number; to: number; text: string };

function documentLines(text: string): DocumentLine[] {
  const lines: DocumentLine[] = [];
  let from = 0;
  for (;;) {
    const newline = text.indexOf("\n", from);
    const to = newline === -1 ? text.length : newline;
    lines.push({ from, to, text: text.slice(from, to) });
    if (newline === -1) {
      break;
    }
    from = newline + 1;
  }
  return lines;
}

/** Splits a flow list `[a, b, c]` into item ranges relative to `valueFrom`. */
function flowListItems(
  raw: string,
  valueFrom: number,
): FrontmatterListItem[] | null {
  const inner = raw.slice(1, -1);
  if (inner.includes('"') || inner.includes("'") || inner.includes("[")) {
    // Quoting and nesting are beyond the positional parser; the entry
    // falls back to editing the raw text.
    return null;
  }
  const items: FrontmatterListItem[] = [];
  let offset = 0;
  for (const part of inner.split(",")) {
    const leading = part.length - part.trimStart().length;
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      const start = valueFrom + 1 + offset + leading;
      items.push({ from: start, to: start + trimmed.length, raw: trimmed });
    }
    offset += part.length + 1;
  }
  return items;
}

/**
 * Parses the leading frontmatter block of a document, if any. `text` is
 * the editor document (byte-order mark already stripped). Ranges are
 * character offsets into that document. Returns null when the document
 * does not open with a `---` fence closed by another `---` line.
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  const lines = documentLines(text);
  const first = lines[0];
  if (first === undefined || first.text !== "---") {
    return null;
  }
  let closeIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && (line.text === "---" || line.text === "...")) {
      closeIndex = index;
      break;
    }
  }
  if (closeIndex === -1) {
    return null;
  }
  const entries: FrontmatterEntry[] = [];
  for (let index = 1; index < closeIndex; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    const match = /^(\S[^:]*):(.*)$/.exec(line.text);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      continue;
    }
    const key = match[1];
    const keyFrom = line.from;
    const keyTo = keyFrom + key.length;
    const afterColon = match[2];
    const leadingSpace = afterColon.length - afterColon.trimStart().length;
    const raw = afterColon.trim();
    const valueFrom = keyTo + 1 + leadingSpace;
    const valueTo = valueFrom + raw.length;

    if (raw.length === 0) {
      // A block list: consecutive `- item` lines under the key.
      const items: FrontmatterListItem[] = [];
      let itemIndex = index + 1;
      while (itemIndex < closeIndex) {
        const itemLine = lines[itemIndex];
        if (itemLine === undefined) {
          break;
        }
        const itemMatch = /^(\s*-\s+)(.*)$/.exec(itemLine.text);
        if (itemMatch === null || itemMatch[1] === undefined) {
          break;
        }
        const itemRaw = (itemMatch[2] ?? "").trimEnd();
        const itemFrom = itemLine.from + itemMatch[1].length;
        items.push({
          from: itemFrom,
          to: itemFrom + itemRaw.length,
          raw: itemRaw,
        });
        itemIndex += 1;
      }
      if (items.length > 0) {
        entries.push({
          key,
          keyFrom,
          keyTo,
          valueFrom,
          valueTo,
          raw,
          type: "list",
          items,
        });
        index = itemIndex - 1;
        continue;
      }
      entries.push({
        key,
        keyFrom,
        keyTo,
        valueFrom,
        valueTo,
        raw,
        type: "text",
      });
      continue;
    }

    if (raw.startsWith("[") && raw.endsWith("]")) {
      const items = flowListItems(raw, valueFrom);
      if (items !== null) {
        entries.push({
          key,
          keyFrom,
          keyTo,
          valueFrom,
          valueTo,
          raw,
          type: "list",
          items,
        });
        continue;
      }
    }

    entries.push({
      key,
      keyFrom,
      keyTo,
      valueFrom,
      valueTo,
      raw,
      type: inferScalarType(raw),
    });
  }
  const close = lines[closeIndex];
  return {
    from: 0,
    to: close === undefined ? text.length : close.to,
    entries,
  };
}

/**
 * Applies declared Obsidian property types over the inferred ones. The
 * declared type wins only when the raw value can actually edit as that
 * type; otherwise the inferred type stays, so a mistyped value never gets
 * an input it cannot round-trip through.
 */
export function applyTypeOverrides(
  frontmatter: Frontmatter,
  overrides: Readonly<Record<string, FrontmatterValueType>>,
): Frontmatter {
  const entries = frontmatter.entries.map((entry) => {
    const declared = overrides[entry.key];
    if (declared === undefined || declared === entry.type) {
      return entry;
    }
    const compatible =
      (declared === "boolean" &&
        (entry.raw === "true" || entry.raw === "false")) ||
      (declared === "number" && NUMBER_VALUE.test(entry.raw)) ||
      (declared === "date" && DATE_VALUE.test(entry.raw)) ||
      (declared === "list" && entry.items !== undefined) ||
      declared === "text";
    return compatible && !(declared === "text" && entry.type === "list")
      ? { ...entry, type: declared }
      : entry;
  });
  return { ...frontmatter, entries };
}
