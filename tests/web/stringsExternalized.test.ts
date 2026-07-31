// Criterion 9 (M2): UI strings are externalized. Every user-facing
// literal in the shell lives in src/lib/strings.ts; components reference
// STRINGS exports instead of embedding text. This check is a pragmatic
// static heuristic over the Svelte templates:
//
// - template text nodes (text between tags, after removing every `{...}`
//   expression and Svelte control block) must not contain letters;
// - the naming attributes `title`, `aria-label`, `placeholder` and `alt`
//   must be expression-valued, never string literals with letters;
// - `<script>` sections are not scanned: string literals there are code
//   (annotations, node names, CSS classes), and user-facing strings that
//   reach the DOM from code do so through STRINGS by construction of the
//   components (spot-verified by the aria-label sweep below).
//
// Known limits of the heuristic: it cannot see strings composed inside
// expressions (a template literal embedding an English word would pass),
// it does not evaluate imports (an expression referencing a non-STRINGS
// constant would pass), and punctuation-only text nodes are allowed. It
// still catches the regression that matters: typing prose directly into a
// template.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
);

function svelteFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return svelteFiles(full);
    }
    return entry.name.endsWith(".svelte") ? [full] : [];
  });
}

/** The template part of a component: everything outside script and style. */
function templateOf(source: string): string {
  return source
    .replace(/<script[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

/** Removes `{...}` expressions and control blocks, innermost first. */
function withoutExpressions(template: string): string {
  let text = template;
  for (let pass = 0; pass < 20; pass += 1) {
    const next = text.replace(/\{[^{}]*\}/g, "");
    if (next === text) {
      break;
    }
    text = next;
  }
  return text;
}

const LETTERS = /\p{L}{2,}/u;

describe("UI string externalization", () => {
  const files = svelteFiles(sourceDirectory);
  expect(files.length).toBeGreaterThan(0);

  it.each(files.map((file) => [path.relative(sourceDirectory, file), file]))(
    "%s has no literal template prose",
    (_name, file) => {
      const template = withoutExpressions(
        templateOf(readFileSync(file, "utf8")),
      );
      const offenders: string[] = [];
      for (const match of template.matchAll(/>([^<>]+)</g)) {
        const text = (match[1] ?? "").trim();
        if (text.length > 0 && LETTERS.test(text)) {
          offenders.push(text);
        }
      }
      for (const match of template.matchAll(
        /(title|aria-label|placeholder|alt)\s*=\s*"([^"]*)"/g,
      )) {
        const value = match[2] ?? "";
        if (LETTERS.test(value)) {
          offenders.push(`${match[1]}="${value}"`);
        }
      }
      expect(
        offenders,
        `literal user-facing text found; move it into src/lib/strings.ts`,
      ).toEqual([]);
    },
  );

  it("strings.ts exists and exports the catalog components consume", () => {
    const catalog = readFileSync(
      path.join(sourceDirectory, "lib", "strings.ts"),
      "utf8",
    );
    expect(catalog).toContain("export const STRINGS");
  });
});
