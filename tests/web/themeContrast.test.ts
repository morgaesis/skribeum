import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function declarations(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/giu)].map((match) => [
      match[1] ?? "",
      match[2] ?? "",
    ]),
  );
}

function selectorBlock(css: string, selector: string): Map<string, string> {
  const start = css.indexOf(selector);
  expect(start, `missing selector ${selector}`).toBeGreaterThanOrEqual(0);
  const opening = css.indexOf("{", start);
  return declarations(css.slice(opening + 1, css.indexOf("}", opening)));
}

function luminance(color: string): number {
  const channels = [1, 3, 5].map(
    (index) => Number.parseInt(color.slice(index, index + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return (
    0.2126 * (linear[0] ?? 0) +
    0.7152 * (linear[1] ?? 0) +
    0.0722 * (linear[2] ?? 0)
  );
}

function contrast(foreground: string, background: string): number {
  const [bright, dark] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return ((bright ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

function mix(foreground: string, background: string, weight: number): string {
  const channels = (color: string) =>
    [1, 3, 5].map((index) =>
      Number.parseInt(color.slice(index, index + 2), 16),
    );
  const foregroundChannels = channels(foreground);
  const backgroundChannels = channels(background);
  return `#${foregroundChannels
    .map((channel, index) =>
      Math.round(
        channel * weight + (backgroundChannels[index] ?? 0) * (1 - weight),
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const SPECIFIED_VARIANTS = {
  manuscript: {
    surface: "#fffdf8",
    "code-surface": "#f1ece1",
    text: "#24352b",
    "text-muted": "#5c6b60",
    heading: "#14251d",
    accent: "#1e4d3b",
    link: "#1e4d3b",
    border: "#d6cdbb",
    "border-strong": "#7c8c81",
  },
  nightroom: {
    surface: "#182b21",
    "code-surface": "#1b3024",
    text: "#dfe8de",
    "text-muted": "#9fb0a2",
    heading: "#f3f0e6",
    accent: "#7fbf9e",
    link: "#7fbf9e",
    border: "#24392c",
    "border-strong": "#628070",
  },
  studio: {
    canvas: "#f2f5f9",
    surface: "#ffffff",
    "surface-subtle": "#e7ecf3",
    "surface-raised": "#ffffff",
    "code-surface": "#edf1f7",
    text: "#182230",
    "text-muted": "#51617a",
    heading: "#101a28",
    "heading-subtle": "#3d4e66",
    accent: "#1d4fd8",
    "accent-subtle": "#dfe9fc",
    link: "#1d4fd8",
    border: "#c9d3e0",
    "border-strong": "#8595ac",
    "selection-surface": "#cfe0f7",
    "selection-text": "#182230",
    caret: "#c81e5b",
    focus: "#1d4fd8",
    danger: "#b02a37",
    "danger-surface": "#fbe7e9",
    warning: "#805206",
    "warning-surface": "#faf0d7",
    success: "#20713d",
    "success-surface": "#e2f2e6",
  },
  gazette: {
    canvas: "#ffffff",
    surface: "#ffffff",
    "surface-subtle": "#f1f1f4",
    "surface-raised": "#ffffff",
    "code-surface": "#f4f3f7",
    text: "#131316",
    "text-muted": "#565664",
    heading: "#000000",
    "heading-subtle": "#454553",
    accent: "#5f24c4",
    "accent-subtle": "#ebe2fb",
    link: "#5f24c4",
    border: "#d9d9e0",
    "border-strong": "#8c8c9d",
    "selection-surface": "#e3d7fa",
    "selection-text": "#131316",
    caret: "#d10f56",
    focus: "#5f24c4",
    danger: "#c41f30",
    "danger-surface": "#fce5e8",
    warning: "#7d5605",
    "warning-surface": "#f9efd2",
    success: "#1d7a3e",
    "success-surface": "#e0f3e5",
  },
  graphite: {
    canvas: "#0e131c",
    surface: "#141b26",
    "surface-subtle": "#1e2836",
    "surface-raised": "#1a2230",
    "code-surface": "#1a2330",
    text: "#e6ecf5",
    "text-muted": "#96a7bf",
    heading: "#f4f7fb",
    "heading-subtle": "#b6c5d9",
    accent: "#7fb0ff",
    "accent-subtle": "#20334f",
    link: "#7fb0ff",
    border: "#2c394c",
    "border-strong": "#556a85",
    "selection-surface": "#2c4468",
    "selection-text": "#f4f7fb",
    caret: "#ffd43b",
    focus: "#7fb0ff",
    danger: "#f2958f",
    "danger-surface": "#3f2226",
    warning: "#e3c35d",
    "warning-surface": "#3a2f10",
    success: "#8fd0a0",
    "success-surface": "#1d3325",
  },
  signal: {
    canvas: "#0a0a0f",
    surface: "#101017",
    "surface-subtle": "#1b1b25",
    "surface-raised": "#17171f",
    "code-surface": "#171720",
    text: "#ededf4",
    "text-muted": "#9d9db2",
    heading: "#ffffff",
    "heading-subtle": "#bdbdd0",
    accent: "#b79cff",
    "accent-subtle": "#2b2347",
    link: "#b79cff",
    border: "#2b2b3a",
    "border-strong": "#61617c",
    "selection-surface": "#3a3163",
    "selection-text": "#ffffff",
    caret: "#ff5c8a",
    focus: "#b79cff",
    danger: "#ff8f8f",
    "danger-surface": "#3c1d22",
    warning: "#e0c25c",
    "warning-surface": "#37300f",
    success: "#7fd49b",
    "success-surface": "#173327",
  },
} as const;

describe("theme contrast", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(
    path.join(directory, "..", "..", "src", "lib", "themes", "theme.css"),
    "utf8",
  );
  const lightBase = selectorBlock(css, ':root[data-theme="light"]');
  const darkBase = selectorBlock(css, ':root[data-theme="dark"]');
  const palettes = [
    { name: "manuscript", mode: "light", variables: lightBase },
    {
      name: "studio",
      mode: "light",
      variables: new Map([
        ...lightBase,
        ...selectorBlock(css, 'data-light-palette="studio"'),
      ]),
    },
    {
      name: "gazette",
      mode: "light",
      variables: new Map([
        ...lightBase,
        ...selectorBlock(css, 'data-light-palette="gazette"'),
      ]),
    },
    { name: "nightroom", mode: "dark", variables: darkBase },
    {
      name: "graphite",
      mode: "dark",
      variables: new Map([
        ...darkBase,
        ...selectorBlock(css, 'data-dark-palette="graphite"'),
      ]),
    },
    {
      name: "signal",
      mode: "dark",
      variables: new Map([
        ...darkBase,
        ...selectorBlock(css, 'data-dark-palette="signal"'),
      ]),
    },
  ] as const;
  const pairs = [
    ["text", "canvas", 4.5],
    ["text", "surface", 4.5],
    ["text-muted", "surface", 4.5],
    ["heading", "surface", 4.5],
    ["heading-subtle", "surface", 4.5],
    ["accent", "surface", 4.9],
    ["link", "surface", 4.5],
    ["danger", "surface", 4.5],
    ["warning", "surface", 4.5],
    ["success", "surface", 4.5],
    ["selection-text", "selection-surface", 4.5],
    ["caret", "surface", 3],
    ["focus", "canvas", 3],
    ["border-strong", "surface", 3],
  ] as const;
  const syntaxTokens = [
    "syntax-keyword",
    "syntax-string",
    "syntax-number",
    "syntax-comment",
    "syntax-function",
    "syntax-type",
    "syntax-property",
    "syntax-operator",
  ] as const;
  const calloutTokens = [
    "callout-blue",
    "callout-cyan",
    "callout-green",
    "callout-yellow",
    "callout-orange",
    "callout-red",
    "callout-purple",
    "callout-gray",
  ] as const;

  it.each(Object.entries(SPECIFIED_VARIANTS))(
    "%s uses the specified token values",
    (name, expected) => {
      const variables = selectorBlock(css, `data-palette="${name}"`);
      for (const [token, value] of Object.entries(expected)) {
        expect(variables.get(`skr-${token}`), `${name} --skr-${token}`).toBe(
          value,
        );
      }
    },
  );

  it.each(palettes)("$name meets every contrast floor", (palette) => {
    const measured = pairs.map(([foreground, background, minimum]) => {
      const foregroundColor = palette.variables.get(`skr-${foreground}`);
      const backgroundColor = palette.variables.get(`skr-${background}`);
      expect(foregroundColor, `missing --skr-${foreground}`).toBeDefined();
      expect(backgroundColor, `missing --skr-${background}`).toBeDefined();
      return {
        pair: `${foreground}/${background}`,
        minimum,
        ratio: contrast(
          foregroundColor ?? "#000000",
          backgroundColor ?? "#ffffff",
        ),
      };
    });
    console.info(
      `${palette.name} contrast: ${measured
        .map(({ pair, ratio }) => `${pair}=${ratio.toFixed(2)}`)
        .join(", ")}`,
    );
    for (const { pair, ratio, minimum } of measured) {
      expect(ratio, `${palette.name} ${pair}`).toBeGreaterThanOrEqual(minimum);
    }

    const codeSurface = palette.variables.get("skr-code-surface") ?? "#ffffff";
    for (const token of syntaxTokens) {
      const color = palette.variables.get(`skr-${token}`);
      expect(color, `missing --skr-${token}`).toBeDefined();
      expect(
        contrast(color ?? "#000000", codeSurface),
        `${palette.name} ${token}/code-surface`,
      ).toBeGreaterThanOrEqual(4.5);
    }

    const surface = palette.variables.get("skr-surface") ?? "#ffffff";
    const text = palette.variables.get("skr-text") ?? "#000000";
    const tintWeight = palette.mode === "light" ? 0.08 : 0.12;
    for (const token of calloutTokens) {
      const color = palette.variables.get(`skr-${token}`);
      expect(color, `missing --skr-${token}`).toBeDefined();
      const tint = mix(color ?? "#000000", surface, tintWeight);
      expect(
        contrast(color ?? "#000000", tint),
        `${palette.name} ${token}/tint`,
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(text, tint),
        `${palette.name} text/${token}-tint`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
