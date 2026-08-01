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

function themeBlock(css: string, theme: "light" | "dark"): Map<string, string> {
  const start = css.indexOf(`:root[data-theme="${theme}"]`);
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

describe("theme text contrast", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(
    path.join(directory, "..", "..", "src", "lib", "themes", "theme.css"),
    "utf8",
  );
  const pairs = [
    ["text", "canvas", 4.5],
    ["text", "surface", 4.5],
    ["text-muted", "surface", 4.5],
    ["heading", "surface", 4.5],
    ["heading-subtle", "surface", 4.5],
    ["accent", "surface", 4.5],
    ["link", "surface", 4.5],
    ["danger", "danger-surface", 4.5],
    ["warning", "warning-surface", 4.5],
    ["success", "success-surface", 4.5],
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

  it.each(["light", "dark"] as const)("%s variables meet WCAG AA", (theme) => {
    const variables = themeBlock(css, theme);
    const measured = pairs.map(([foreground, background, minimum]) => {
      const foregroundColor = variables.get(`skr-${foreground}`);
      const backgroundColor = variables.get(`skr-${background}`);
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
      `${theme} contrast: ${measured.map(({ pair, ratio }) => `${pair}=${ratio.toFixed(2)}`).join(", ")}`,
    );
    for (const { pair, ratio, minimum } of measured) {
      expect(ratio, `${theme} ${pair}`).toBeGreaterThanOrEqual(minimum);
    }
  });

  it.each(["light", "dark"] as const)(
    "%s syntax tokens meet the 4.5:1 contrast floor",
    (theme) => {
      const variables = themeBlock(css, theme);
      const codeSurface = variables.get("skr-code-surface");
      expect(codeSurface, "missing --skr-code-surface").toBeDefined();
      const measured = syntaxTokens.map((token) => {
        const color = variables.get(`skr-${token}`);
        expect(color, `missing --skr-${token}`).toBeDefined();
        return {
          token,
          ratio: contrast(color ?? "#000000", codeSurface ?? "#ffffff"),
        };
      });
      console.info(
        `${theme} syntax contrast: ${measured
          .map(({ token, ratio }) => `${token}=${ratio.toFixed(2)}`)
          .join(", ")}`,
      );
      for (const { token, ratio } of measured) {
        expect(ratio, `${theme} ${token}/code-surface`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
    },
  );
});
