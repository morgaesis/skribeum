import { forceParsing } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import Editor from "../../src/lib/Editor.svelte";

const CASES = [
  ["typescript", "const typescriptValue: number = 1;"],
  ["ts", "const tsValue: number = 1;"],
  ["javascript", "const javascriptValue = 1;"],
  ["js", "const jsValue = 1;"],
  ["jsx", "const jsxValue = <Panel />;"],
  ["rust", "fn rust_value() {}"],
  ["rs", "fn rs_value() {}"],
  ["python", "def python_value(): pass"],
  ["py", "def py_value(): pass"],
  ["shell", "if true; then echo shell-value; fi"],
  ["sh", "if true; then echo sh-value; fi"],
  ["bash", "if true; then echo bash-value; fi"],
  ["zsh", "if true; then echo zsh-value; fi"],
  ["json", '{"jsonValue": true}'],
  ["yaml", "yamlValue: true"],
  ["yml", "ymlValue: true"],
  ["html", "<main>html value</main>"],
  ["css", ".css-value { color: red; }"],
  ["markdown", "# Markdown value"],
  ["md", "# MD value"],
] as const;

function codeDocument(language: string, source: string): string {
  return `\`\`\`${language}\n${source}\n\`\`\``;
}

function lineFor(view: EditorView, text: string): HTMLElement | undefined {
  return [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")].find(
    (line) => line.textContent === text,
  );
}

function hasSyntaxHighlight(line: HTMLElement): boolean {
  return [...line.querySelectorAll<HTMLElement>("span[class]")].some((span) =>
    [...span.classList].some((className) => !className.startsWith("cm-")),
  );
}

async function waitForLanguage(
  view: EditorView,
  source: string,
): Promise<HTMLElement> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    forceParsing(view, view.state.doc.length, 1_000);
    const line = lineFor(view, source);
    if (line !== undefined && hasSyntaxHighlight(line)) {
      return line;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fenced code language did not load for ${source}`);
}

describe("fenced code syntax highlighting", () => {
  it.each(CASES)(
    "renders %s fences with syntax highlighting",
    async (language, source) => {
      const host = document.createElement("div");
      document.body.append(host);
      const component = mount(Editor, {
        target: host,
        props: { doc: codeDocument(language, source) },
      });
      flushSync();

      try {
        const view = component.getView();
        expect(view).toBeDefined();
        if (view === undefined) return;

        const line = await waitForLanguage(view, source);
        expect(line.textContent).toBe(source);
        expect(hasSyntaxHighlight(line)).toBe(true);
      } finally {
        await unmount(component);
        host.remove();
      }
    },
  );

  it("renders an unknown language as plain code", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const component = mount(Editor, {
      target: host,
      props: { doc: codeDocument("notjavascript", "unknownValue ???") },
    });
    flushSync();

    try {
      const view = component.getView();
      expect(view).toBeDefined();
      if (view === undefined) return;

      forceParsing(view, view.state.doc.length, 1_000);
      await new Promise((resolve) => setTimeout(resolve, 25));
      forceParsing(view, view.state.doc.length, 1_000);
      const line = lineFor(view, "unknownValue ???");
      expect(line).toBeDefined();
      expect(line === undefined ? true : hasSyntaxHighlight(line)).toBe(false);
    } finally {
      await unmount(component);
      host.remove();
    }
  });
});
