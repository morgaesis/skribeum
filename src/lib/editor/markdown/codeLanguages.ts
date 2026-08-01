import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import {
  LanguageDescription,
  LanguageSupport,
  StreamLanguage,
} from "@codemirror/language";

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
  const name = info.toLowerCase();
  return (
    fencedCodeLanguages.find((description) =>
      description.alias.includes(name),
    ) ?? null
  );
}
