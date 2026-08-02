import { parseFrontmatter } from "./editor/frontmatter";

export type ResolvedNoteTitle = {
  /** Authored title shown on reading surfaces. */
  displayTitle: string;
  /** File name without the final Markdown extension. */
  fileName: string;
  /** File name shown after a colliding display title. */
  collisionSuffix?: string;
};

export type NoteTitleSource = {
  path: string;
  source: string;
};

const NOTE_EXTENSION = /\.(?:md|markdown|txt)$/iu;

/** True when a path names an editable plain-text note. */
export function isNotePath(path: string): boolean {
  return NOTE_EXTENSION.test(path);
}

/** Returns a path without its editable-note extension. */
export function withoutNoteExtension(path: string): string {
  return path.replace(NOTE_EXTENSION, "");
}

/** Returns the final path segment without its Markdown extension. */
export function noteFileName(path: string): string {
  const name = path.split("/").at(-1) ?? path;
  return withoutNoteExtension(name);
}

function scalarTitle(raw: string): string {
  let trimmed = raw.trim();
  const stringTag = /^(?:!!str|!<tag:yaml\.org,2002:str>)(?:\s+|$)/u.exec(
    trimmed,
  );
  const explicitlyString = stringTag !== null;
  if (stringTag !== null) {
    trimmed = trimmed.slice(stringTag[0].length).trimStart();
  } else if (/^!(?:![^\s]+|<[^>]+>|[^\s]+)(?:\s+|$)/u.test(trimmed)) {
    return "";
  }
  if (trimmed.startsWith('"')) {
    const match = /^("(?:[^"\\]|\\.)*")(?:\s+#.*)?$/u.exec(trimmed);
    if (match?.[1] === undefined) return "";
    try {
      const parsed: unknown = JSON.parse(match[1]);
      return typeof parsed === "string" ? parsed.trim() : "";
    } catch {
      return match[1]
        .slice(1, -1)
        .replace(/\\x([0-9a-f]{2})/giu, (_, value: string) =>
          String.fromCodePoint(Number.parseInt(value, 16)),
        )
        .replace(/\\u([0-9a-f]{4})/giu, (_, value: string) =>
          String.fromCodePoint(Number.parseInt(value, 16)),
        )
        .replace(/\\U([0-9a-f]{8})/giu, (_, value: string) =>
          Number.parseInt(value, 16) <= 0x10ffff
            ? String.fromCodePoint(Number.parseInt(value, 16))
            : "",
        )
        .replace(/\\([0abtnvfre _NLP"\\/])/gu, (_, sequence: string) => {
          const values: Record<string, string> = {
            "0": "\0",
            a: "\u0007",
            b: "\b",
            t: "\t",
            n: "\n",
            v: "\u000b",
            f: "\f",
            r: "\r",
            e: "\u001b",
            " ": " ",
            _: "\u00a0",
            N: "\u0085",
            L: "\u2028",
            P: "\u2029",
            '"': '"',
            "\\": "\\",
            "/": "/",
          };
          return values[sequence] ?? "";
        })
        .trim();
    }
  }
  if (trimmed.startsWith("'")) {
    const match = /^('(?:[^']|'')*')(?:\s+#.*)?$/u.exec(trimmed);
    return match?.[1] === undefined
      ? ""
      : match[1].slice(1, -1).replaceAll("''", "'").trim();
  }
  const plain = trimmed.replace(/\s+#.*$/u, "").trim();
  if (explicitlyString) {
    return plain;
  }
  if (
    /^(?:|~|null|Null|NULL|true|True|TRUE|false|False|FALSE)$/u.test(plain) ||
    /^(?:[+-]?(?:\.\d+|\d+(?:\.\d*)?)(?:[eE][+-]?\d+)?|0o[0-7]+|0x[\dA-Fa-f]+|[+-]?(?:\.inf|\.Inf|\.INF)|(?:\.nan|\.NaN|\.NAN))$/u.test(
      plain,
    ) ||
    /^[>|[{!&*]/u.test(plain)
  ) {
    return "";
  }
  return plain;
}

function blockScalarTitle(source: string, style: "|" | ">") {
  const lines = source.split(/\r?\n/u);
  const titleLine = lines.findIndex((line) =>
    /^title:\s*(?:(?:!!str|!<tag:yaml\.org,2002:str>)\s+)?[>|](?:[+-][1-9]?|[1-9][+-]?)?\s*(?:#.*)?$/u.test(
      line,
    ),
  );
  if (titleLine === -1) return "";
  const block: string[] = [];
  for (const line of lines.slice(titleLine + 1)) {
    if (line === "---" || line === "...") break;
    if (line.length > 0 && !/^\s/u.test(line)) break;
    block.push(line);
  }
  const nonEmpty = block.filter((line) => line.trim().length > 0);
  const indent = Math.min(
    ...nonEmpty.map((line) => /^\s*/u.exec(line)?.[0].length ?? 0),
  );
  const content = block.map((line) => line.slice(indent));
  return (style === "|" ? content.join("\n") : content.join(" ")).trim();
}

function frontmatterTitle(source: string): string | null {
  const normalizedSource = source.replaceAll("\r\n", "\n");
  const entry = parseFrontmatter(normalizedSource)?.entries.find(
    (candidate) => candidate.key === "title",
  );
  if (entry === undefined) {
    return null;
  }
  const blockStyle = /^(?:(?:!!str|!<tag:yaml\.org,2002:str>)\s+)?([>|])/u.exec(
    entry.raw,
  )?.[1] as "|" | ">" | undefined;
  const title =
    blockStyle === undefined
      ? scalarTitle(entry.raw)
      : blockScalarTitle(normalizedSource, blockStyle);
  return title.length > 0 ? title : null;
}

function firstLineH1(source: string): string | null {
  const [first = "", second = ""] = source.split(/\r?\n/u, 2);
  const atx = /^ {0,3}#(?:[\t ]+|$)(.*)$/u.exec(first);
  if (atx !== null) {
    const title = (atx[1] ?? "").replace(/[\t ]+#+[\t ]*$/u, "").trim();
    return title.length > 0 ? title : null;
  }
  const setextTitle = /^ {0,3}(\S.*)$/u.exec(first)?.[1]?.trim();
  if (setextTitle && /^ {0,3}=+[\t ]*$/u.test(second)) {
    return setextTitle;
  }
  return null;
}

/** Resolves one note title by frontmatter, first-line H1, then file name. */
export function resolveNoteTitle({
  path,
  source,
}: NoteTitleSource): ResolvedNoteTitle {
  const fileName = noteFileName(path);
  return {
    displayTitle: frontmatterTitle(source) ?? firstLineH1(source) ?? fileName,
    fileName,
  };
}

/**
 * Marks duplicate display titles in one presented group. Surfaces render the
 * suffix in muted interface text rather than folding it into the title.
 */
export function resolveTitleCollisions(
  notes: readonly NoteTitleSource[],
): ResolvedNoteTitle[] {
  const resolved = notes.map(resolveNoteTitle);
  const counts = new Map<string, number>();
  for (const title of resolved) {
    counts.set(title.displayTitle, (counts.get(title.displayTitle) ?? 0) + 1);
  }
  return resolved.map((title) =>
    (counts.get(title.displayTitle) ?? 0) > 1
      ? { ...title, collisionSuffix: title.fileName }
      : title,
  );
}
