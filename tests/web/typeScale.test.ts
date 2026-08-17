// The interface type scale is four named sizes and nothing else, the same way
// the radius scale is three. Chrome that names a raw size instead of a token
// is how a shell ends up with 11, 12, 13, 14 and 16 pixel text side by side
// with no relationship between the values, so this sweeps every style block in
// the product and holds each declared size to the scale it belongs to: a token
// for chrome, the published em steps for the reading surface, and a short list
// of glyph and specimen sizes that are geometry rather than a text tier.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const TYPE_SCALE = {
  "--skr-type-chip": "11px",
  "--skr-type-label": "12px",
  "--skr-type-control": "13px",
  "--skr-type-title": "16px",
} as const;

/**
 * Sizes inside the reading surface, expressed against the reader's own
 * adjustable base: the six heading steps, body, the code and table-header
 * step, the caption step, and the task glyph that is drawn to fit its box.
 */
const PROSE_STEPS = new Set([
  "1.75em",
  "1.5em",
  "1.25em",
  "1.125em",
  "1em",
  "0.875em",
  "0.8125em",
  "0.78em",
  "var(--skr-editor-font-size, 1rem)",
]);

/** Sizes that are icon geometry or a palette specimen, not a text tier. */
const GEOMETRY = new Map([
  ["1rem", "icon glyphs are one rem across the shell"],
  ["0.7rem", "the check glyph drawn inside the specimen checkbox"],
  ["0.875rem", "the palette card sets the palette's own name specimen"],
  ["1.25rem", "the palette preview's own heading specimen"],
  ["0.8125rem", "the palette preview's own body specimen"],
  ["14px", "the diagram renderer bakes one size into its emitted SVG"],
  ["inherit", "explicitly deferring to the surrounding tier"],
]);

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const candidate = path.join(directory, entry);
    if (statSync(candidate).isDirectory()) {
      found.push(...sources(candidate));
      continue;
    }
    if (/\.(svelte|css|ts)$/u.test(entry)) found.push(candidate);
  }
  return found;
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1");
}

function declaredSizes(source: string): string[] {
  const stripped = withoutComments(source);
  return [
    ...[...stripped.matchAll(/font-size:\s*([^;}]+)[;}]/gu)],
    ...[...stripped.matchAll(/fontSize:\s*"([^"]+)"/gu)],
  ].map((match) => (match[1] ?? "").trim());
}

describe("interface type scale", () => {
  const themeCss = readFileSync(
    path.join(root, "src", "lib", "themes", "theme.css"),
    "utf8",
  );

  it.each(Object.entries(TYPE_SCALE))("declares %s as %s", (token, value) => {
    expect(themeCss).toContain(`${token}: ${value};`);
  });

  it("declares no chrome size the scale does not name", () => {
    const extra = [...themeCss.matchAll(/--skr-type-([\w-]+):/gu)].map(
      (match) => `--skr-type-${match[1]}`,
    );
    expect(new Set(extra)).toEqual(new Set(Object.keys(TYPE_SCALE)));
  });

  it("never sizes markup with a utility class outside the scale", () => {
    const offenders: string[] = [];
    for (const directory of ["src", "demo"]) {
      for (const file of sources(path.join(root, directory))) {
        if (!file.endsWith(".svelte")) continue;
        const source = readFileSync(file, "utf8");
        for (const match of source.matchAll(
          /\btext-(xs|sm|base|lg|xl|\d?xl|\[[^\]]+\])\b/gu,
        )) {
          offenders.push(`${path.relative(root, file)}: ${match[0]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("sizes every surface from the scale, the prose steps, or named geometry", () => {
    const offenders: string[] = [];
    for (const directory of ["src", "demo"]) {
      for (const file of sources(path.join(root, directory))) {
        for (const size of declaredSizes(readFileSync(file, "utf8"))) {
          if (size.startsWith("var(--skr-type-")) continue;
          if (PROSE_STEPS.has(size)) continue;
          if (GEOMETRY.has(size)) continue;
          offenders.push(`${path.relative(root, file)}: ${size}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
