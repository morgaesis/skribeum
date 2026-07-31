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
    ["text", "canvas"],
    ["text", "surface"],
    ["text-muted", "surface"],
    ["link", "surface"],
    ["danger", "danger-surface"],
    ["warning", "warning-surface"],
    ["text", "accent-soft"],
    ["heading-1", "surface"],
    ["heading-2", "surface"],
    ["heading-3", "surface"],
    ["heading-4", "surface"],
    ["heading-5", "surface"],
    ["heading-6", "surface"],
    ["selection-text", "selection-surface"],
    ["toolbar-text", "toolbar-surface"],
    ["toolbar-hover-text", "toolbar-hover-surface"],
    ["toolbar-focus", "toolbar-surface"],
    ["caret", "surface"],
    ["caret", "code-surface"],
    ["caret", "accent-soft"],
    ["caret", "warning-surface"],
    ["caret", "danger-surface"],
    ["caret", "success-surface"],
  ] as const;

  it.each(["light", "dark"] as const)("%s variables meet WCAG AA", (theme) => {
    const variables = themeBlock(css, theme);
    const measured = pairs.map(([foreground, background]) => {
      const foregroundColor = variables.get(`skr-${foreground}`);
      const backgroundColor = variables.get(`skr-${background}`);
      expect(foregroundColor, `missing --skr-${foreground}`).toBeDefined();
      expect(backgroundColor, `missing --skr-${background}`).toBeDefined();
      return {
        pair: `${foreground}/${background}`,
        ratio: contrast(
          foregroundColor ?? "#000000",
          backgroundColor ?? "#ffffff",
        ),
      };
    });
    console.info(
      `${theme} contrast: ${measured.map(({ pair, ratio }) => `${pair}=${ratio.toFixed(2)}`).join(", ")}`,
    );
    for (const { pair, ratio } of measured) {
      expect(ratio, `${theme} ${pair}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
