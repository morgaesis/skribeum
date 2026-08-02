import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";
import { languages } from "@codemirror/language-data";

const fencedCodeLanguages: readonly LanguageDescription[] = [
  LanguageDescription.of({
    name: "TypeScript",
    alias: ["ts"],
    load: () => Promise.resolve(javascript({ typescript: true })),
  }),
  LanguageDescription.of({
    name: "JavaScript",
    alias: ["js"],
    load: () => Promise.resolve(javascript()),
  }),
  LanguageDescription.of({
    name: "JSX",
    alias: ["jsx"],
    load: () => Promise.resolve(javascript({ jsx: true })),
  }),
  LanguageDescription.of({
    name: "Rust",
    alias: ["rs"],
    load: () => import("@codemirror/lang-rust").then(({ rust }) => rust()),
  }),
  LanguageDescription.of({
    name: "Python",
    alias: ["py"],
    load: () =>
      import("@codemirror/lang-python").then(({ python }) => python()),
  }),
  LanguageDescription.of({
    name: "Shell",
    alias: ["sh", "bash", "zsh"],
    load: () =>
      import("@codemirror/legacy-modes/mode/shell").then(
        ({ shell }) => new LanguageSupport(StreamLanguage.define(shell)),
      ),
  }),
  LanguageDescription.of({
    name: "JSON",
    load: () => import("@codemirror/lang-json").then(({ json }) => json()),
  }),
  LanguageDescription.of({
    name: "YAML",
    alias: ["yml"],
    load: () => import("@codemirror/lang-yaml").then(({ yaml }) => yaml()),
  }),
  LanguageDescription.of({
    name: "HTML",
    load: () => Promise.resolve(html()),
  }),
  LanguageDescription.of({
    name: "CSS",
    load: () => Promise.resolve(css()),
  }),
  LanguageDescription.of({
    name: "Markdown",
    alias: ["md"],
    load: () => Promise.resolve(markdown()),
  }),
];

export function codeLanguage(info: string): LanguageDescription | null {
  const normalized = info.trim().toLowerCase();
  if (normalized.length === 0) return null;
  const firstToken = normalized.split(/\s+/u, 1)[0] ?? normalized;
  for (const name of new Set([normalized, firstToken])) {
    const match =
      LanguageDescription.matchLanguageName(fencedCodeLanguages, name, false) ??
      LanguageDescription.matchLanguageName(languages, name, false) ??
      languages.find((description) =>
        description.extensions.some(
          (extension) => extension.toLowerCase() === name,
        ),
      );
    if (match !== null && match !== undefined) return match;
  }
  return null;
}
