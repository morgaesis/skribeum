// Which palette a surface actually paints is decided by the CSS cascade, not
// by the settings state, and the two disagree the moment a palette rule names
// a mode without carrying that mode's `prefers-color-scheme` guard: the extra
// attribute outranks the opposite mode's base rule and pins the application to
// one appearance. jsdom resolves neither `var()` nor media queries, so the
// cascade is evaluated here against the shipped stylesheet and the resolved
// value is compared to the palette's published color, never to another value
// read out of the same file.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APPEARANCE_MIRROR,
  CODE_FONT_NAMES,
  DARK_PALETTE_NAMES,
  LIGHT_PALETTE_NAMES,
  PROSE_FONT_NAMES,
  THEME_NAMES,
} from "../../src/lib/themes/theme";

type Rule = {
  readonly media: string | null;
  readonly selectors: readonly string[];
  readonly declarations: ReadonlyMap<string, string>;
  readonly order: number;
};

type RootState = {
  readonly theme: string;
  readonly lightPalette: string;
  readonly darkPalette: string;
};

function parseDeclarations(body: string): Map<string, string> {
  return new Map(
    [...body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/gu)].map((match) => [
      match[1] ?? "",
      (match[2] ?? "").trim(),
    ]),
  );
}

/** Parses the flat rule list of a stylesheet nested at most one level deep. */
function parseRules(css: string): Rule[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: Rule[] = [];
  let index = 0;
  let media: string | null = null;
  while (index < source.length) {
    const opening = source.indexOf("{", index);
    if (opening < 0) break;
    const prelude = source.slice(index, opening).trim();
    if (prelude.startsWith("@media")) {
      expect(media, "nested media blocks are not supported").toBeNull();
      media = prelude.slice("@media".length).trim();
      index = opening + 1;
      continue;
    }
    const closing = source.indexOf("}", opening);
    expect(closing, `unterminated rule for ${prelude}`).toBeGreaterThan(
      opening,
    );
    rules.push({
      media,
      selectors: prelude.split(",").map((selector) => selector.trim()),
      declarations: parseDeclarations(source.slice(opening + 1, closing)),
      order: rules.length,
    });
    index = closing + 1;
    const offset = source.slice(index).search(/\S/u);
    if (offset >= 0 && source[index + offset] === "}") {
      media = null;
      index += offset + 1;
    }
  }
  expect(media, "unterminated media block").toBeNull();
  return rules;
}

function mediaApplies(media: string | null, prefersDark: boolean): boolean {
  if (media === null) return true;
  if (media === "(prefers-color-scheme: dark)") return prefersDark;
  if (media === "(prefers-color-scheme: light)") return !prefersDark;
  throw new Error(`unhandled media condition: ${media}`);
}

/**
 * Matches a selector against the root element and returns its specificity, or
 * null when it does not match. Only the selector vocabulary theme.css uses is
 * understood; anything else throws rather than being silently skipped.
 */
function rootSpecificity(selector: string, state: RootState): number | null {
  if (selector.startsWith(".skr-palette-swatch")) return null;
  if (!selector.startsWith(":root")) {
    throw new Error(`unhandled selector: ${selector}`);
  }
  const attributes: Record<string, string | undefined> = {
    "data-theme": state.theme,
    "data-light-palette": state.lightPalette,
    "data-dark-palette": state.darkPalette,
  };
  let rest = selector.slice(":root".length);
  let specificity = 1;
  let matches = true;
  while (rest.length > 0) {
    const present = /^\[([\w-]+)="([^"]+)"\]/u.exec(rest);
    if (present !== null) {
      specificity += 1;
      if (attributes[present[1] ?? ""] !== present[2]) matches = false;
      rest = rest.slice(present[0].length);
      continue;
    }
    const absent = /^:not\(\[([\w-]+)\]\)/u.exec(rest);
    if (absent !== null) {
      specificity += 1;
      if (attributes[absent[1] ?? ""] !== undefined) matches = false;
      rest = rest.slice(absent[0].length);
      continue;
    }
    throw new Error(`unhandled selector fragment: ${rest} in ${selector}`);
  }
  return matches ? specificity : null;
}

function resolveRoot(
  rules: readonly Rule[],
  state: RootState,
  prefersDark: boolean,
): Map<string, string> {
  const winners = new Map<string, { specificity: number; order: number }>();
  const resolved = new Map<string, string>();
  for (const rule of rules) {
    if (!mediaApplies(rule.media, prefersDark)) continue;
    let specificity: number | null = null;
    for (const selector of rule.selectors) {
      const candidate = rootSpecificity(selector, state);
      if (
        candidate !== null &&
        (specificity === null || candidate > specificity)
      ) {
        specificity = candidate;
      }
    }
    if (specificity === null) continue;
    for (const [property, value] of rule.declarations) {
      const winner = winners.get(property);
      if (winner !== undefined && winner.specificity > specificity) continue;
      winners.set(property, { specificity, order: rule.order });
      resolved.set(property, value);
    }
  }
  return resolved;
}

/** The published values of each palette, transcribed from the color system. */
const PALETTES = {
  manuscript: {
    mode: "light",
    canvas: "#f5f2e9",
    surfaceRaised: "#ffffff",
    accent: "#1e4d3b",
  },
  studio: {
    mode: "light",
    canvas: "#f2f5f9",
    surfaceRaised: "#ffffff",
    accent: "#1d4fd8",
  },
  gazette: {
    mode: "light",
    canvas: "#ffffff",
    surfaceRaised: "#ffffff",
    accent: "#5f24c4",
  },
  nightroom: {
    mode: "dark",
    canvas: "#14251d",
    surfaceRaised: "#1e3527",
    accent: "#7fbf9e",
  },
  graphite: {
    mode: "dark",
    canvas: "#0e131c",
    surfaceRaised: "#1a2230",
    accent: "#7fb0ff",
  },
  signal: {
    mode: "dark",
    canvas: "#0a0a0f",
    surfaceRaised: "#17171f",
    accent: "#b79cff",
  },
} as const;

const LIGHT_PALETTES = ["manuscript", "studio", "gazette"] as const;
const DARK_PALETTES = ["nightroom", "graphite", "signal"] as const;

type Case = {
  readonly label: string;
  readonly state: RootState;
  readonly prefersDark: boolean;
  readonly expected: keyof typeof PALETTES;
};

function cases(): Case[] {
  const rows: Case[] = [];
  for (const lightPalette of LIGHT_PALETTES) {
    for (const darkPalette of DARK_PALETTES) {
      for (const prefersDark of [false, true]) {
        const scheme = prefersDark ? "dark" : "light";
        const state = { theme: "system", lightPalette, darkPalette };
        rows.push({
          label: `follow on, ${lightPalette}/${darkPalette}, system ${scheme}`,
          state,
          prefersDark,
          expected: prefersDark ? darkPalette : lightPalette,
        });
        rows.push({
          label: `follow off light, ${lightPalette}/${darkPalette}, system ${scheme}`,
          state: { ...state, theme: "light" },
          prefersDark,
          expected: lightPalette,
        });
        rows.push({
          label: `follow off dark, ${lightPalette}/${darkPalette}, system ${scheme}`,
          state: { ...state, theme: "dark" },
          prefersDark,
          expected: darkPalette,
        });
      }
    }
  }
  return rows;
}

describe("appearance resolution", () => {
  const root = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const themeCss = readFileSync(
    path.join(root, "src", "lib", "themes", "theme.css"),
    "utf8",
  );
  const appCss = readFileSync(path.join(root, "src", "app.css"), "utf8");
  const rules = parseRules(themeCss);

  it("paints the body canvas and raised surfaces from the palette tokens", () => {
    expect(appCss).toMatch(/body\s*\{[^}]*background:\s*var\(--skr-canvas\)/u);
    expect(appCss).toMatch(
      /\[role="dialog"\]\s*\{[^}]*background:\s*var\(--skr-surface-raised\)/u,
    );
  });

  it.each(cases())("$label renders $expected", (row) => {
    const resolved = resolveRoot(rules, row.state, row.prefersDark);
    const palette = PALETTES[row.expected];
    expect(resolved.get("skr-canvas"), "body canvas").toBe(palette.canvas);
    expect(resolved.get("skr-surface-raised"), "raised surface").toBe(
      palette.surfaceRaised,
    );
    expect(resolved.get("skr-accent"), "accent").toBe(palette.accent);
  });

  it("bootstraps the persisted appearance from a render-blocking script", () => {
    for (const page of ["index.html", path.join("demo", "index.html")]) {
      const html = readFileSync(path.join(root, page), "utf8");
      const script = /<script([^>]*)src="\/appearance-bootstrap\.js"/u.exec(
        html,
      );
      expect(script, `${page} does not load the appearance bootstrap`).not.toBe(
        null,
      );
      // A module or deferred script runs after the first frame, which is the
      // frame this exists to paint correctly.
      expect(script?.[1] ?? "").not.toMatch(/type="module"|defer|async/u);
      expect(
        html.indexOf("appearance-bootstrap.js"),
        `${page} bootstraps after the application entry`,
      ).toBeLessThan(html.indexOf("main.ts"));
    }
  });

  it("keeps the bootstrap and the runtime on the same vocabulary", () => {
    const bootstrap = readFileSync(
      path.join(root, "public", "appearance-bootstrap.js"),
      "utf8",
    );
    expect(bootstrap).toContain(`"${APPEARANCE_MIRROR}"`);
    const listed = (name: string): string[] => {
      const match = new RegExp(`const ${name} = \\[([^\\]]*)\\];`, "u").exec(
        bootstrap,
      );
      expect(match, `${name} is missing from the bootstrap`).not.toBe(null);
      return (match?.[1] ?? "")
        .split(",")
        .map((entry) => entry.trim().replaceAll('"', ""))
        .filter((entry) => entry.length > 0);
    };
    expect(listed("THEMES")).toEqual([...THEME_NAMES]);
    expect(listed("LIGHT_PALETTES")).toEqual([...LIGHT_PALETTE_NAMES]);
    expect(listed("DARK_PALETTES")).toEqual([...DARK_PALETTE_NAMES]);
    expect(listed("PROSE_FONTS")).toEqual([...PROSE_FONT_NAMES]);
    expect(listed("CODE_FONTS")).toEqual([...CODE_FONT_NAMES]);
  });

  it("keeps every mode-specific palette rule behind its own scheme guard", () => {
    for (const rule of rules) {
      for (const selector of rule.selectors) {
        if (!selector.includes('data-theme="system"')) continue;
        const paletteAttribute = /data-(light|dark)-palette="/u.exec(selector);
        if (paletteAttribute === null) continue;
        expect(rule.media, `${selector} is not scheme-guarded`).toBe(
          `(prefers-color-scheme: ${paletteAttribute[1] === "light" ? "light" : "dark"})`,
        );
      }
    }
  });
});
