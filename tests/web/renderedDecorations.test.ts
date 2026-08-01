import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decorationEngine } from "../../src/lib/editor/decorations/engine";
import type { WikilinkResolutionContext } from "../../src/lib/editor/decorations/wikilinks";
import { codeLanguage } from "../../src/lib/editor/markdown/codeLanguages";
import { obsidianMarkdownExtensions } from "../../src/lib/editor/markdown/obsidian";

const views: EditorView[] = [];

function mountedView(
  doc: string,
  cursor = doc.length,
  context?: WikilinkResolutionContext,
): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: obsidianMarkdownExtensions,
          codeLanguages: codeLanguage,
        }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        decorationEngine(context),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

async function waitForElement(
  root: ParentNode,
  selector: string,
): Promise<Element> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const element = root.querySelector(selector);
    if (element !== null) {
      return element;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`element did not render: ${selector}`);
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  vi.restoreAllMocks();
  document.body.textContent = "";
});

describe("rendered decoration DOM", () => {
  it("renders an aligned bordered table and reveals only the cursor row", () => {
    const source =
      "| Name | Score |\n| :--- | ---: |\n| Ada | 10 |\n| Grace | 9 |\n\noutside";
    const view = mountedView(source);
    const rows = view.dom.querySelectorAll<HTMLElement>('[role="row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('[role="columnheader"]')?.textContent).toBe(
      "Name",
    );
    expect(rows[1]?.querySelectorAll('[role="cell"]')[1]?.textContent).toBe(
      "10",
    );
    expect(
      (rows[1]?.querySelectorAll<HTMLElement>('[role="cell"]')[1] ?? null)
        ?.style.textAlign,
    ).toBe("right");
    expect(rows[0]?.style.gridTemplateColumns).toBe(
      rows[1]?.style.gridTemplateColumns,
    );

    view.dispatch({ selection: { anchor: source.indexOf("Name") } });
    expect(view.dom.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(view.contentDOM.textContent).toContain("| Name | Score |");
    expect(view.dom.querySelector('[role="cell"]')?.textContent).toBe("Ada");
  });

  it("renders a section embed as nested read-only markdown", async () => {
    const context: WikilinkResolutionContext = {
      paths: ["Root.md", "Other.md"],
      config: {
        newLinkFormat: "shortest",
        useMarkdownLinks: false,
        attachmentFolderPath: null,
      },
      currentPath: "Root.md",
      embedAncestry: ["Root.md"],
      embedDepth: 0,
      loadNote: async () =>
        "# Before\nnot selected\n\n## Details\n**Rendered body**\n\n## Later\nnot selected",
    };
    const view = mountedView(
      "![[Other#Details]]\n\noutside",
      undefined,
      context,
    );
    const embed = await waitForElement(view.dom, '[role="group"]');
    expect(embed.getAttribute("aria-label")).toContain("Other.md");
    await waitForElement(embed, ".cm-skr-strong");
    expect(embed.textContent).toContain("Details");
    expect(embed.textContent).toContain("Rendered body");
    expect(embed.textContent).not.toContain("not selected");
    expect(embed.querySelector('[contenteditable="false"]')).not.toBeNull();
  });

  it("shows a visible notice for an embed cycle", () => {
    const context: WikilinkResolutionContext = {
      paths: ["Root.md"],
      config: {
        newLinkFormat: "shortest",
        useMarkdownLinks: false,
        attachmentFolderPath: null,
      },
      currentPath: "Root.md",
      embedAncestry: ["Root.md"],
      embedDepth: 0,
      loadNote: async () => "cycle",
    };
    const view = mountedView("![[Root]]\n\noutside", undefined, context);
    const notice = view.dom.querySelector('[role="status"]');
    expect(notice?.textContent).toBe("Embed cycle detected");
  });

  it("copies exact fenced source without changing layout", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const source = "```ts\nconst value = 1;\n  \n```\n\noutside";
    const view = mountedView(source);
    const button = view.dom.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy code"]',
    );
    expect(button).not.toBeNull();
    expect(getComputedStyle(button as HTMLButtonElement).position).toBe(
      "absolute",
    );
    button?.click();
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("const value = 1;\n  \n");
    });
    expect(button?.textContent).toBe("Code copied");
  });

  it("recedes fence markers away from the block and restores plain source inside", () => {
    const source = "```rust\nfn main() {}\n```\n\noutside";
    const view = mountedView(source);
    const receded = view.dom.querySelector<HTMLElement>(".cm-skr-code-fence");
    expect(receded).not.toBeNull();
    expect(getComputedStyle(receded as HTMLElement).opacity).toBe("0.28");
    view.dispatch({ selection: { anchor: source.indexOf("main") } });
    expect(view.dom.querySelector(".cm-skr-code-fence")).toBeNull();
    expect(view.contentDOM.textContent).toContain("```rust");
  });

  it("renders a source-backed themed callout and reveals its whole source", () => {
    const source =
      "> [!faq]- Need help\n> **Rendered answer**\n> - first\n\noutside";
    const view = mountedView(source);
    const titleLine = view.dom.querySelector<HTMLElement>(
      '.cm-line.cm-skr-rich-callout[data-callout="faq"][data-callout-line="first"]',
    );
    expect(titleLine).not.toBeNull();
    expect(titleLine?.getAttribute("data-callout-canonical")).toBe("question");
    expect(titleLine?.getAttribute("data-accent")).toBe("yellow");
    expect(titleLine?.querySelector("svg.cm-skr-callout-icon")).not.toBeNull();
    expect(titleLine?.textContent).toContain("[!faq]- Need help");
    expect(view.dom.querySelector(".cm-skr-strong")?.textContent).toContain(
      "Rendered answer",
    );

    view.dispatch({ selection: { anchor: source.indexOf("Rendered answer") } });
    expect(view.dom.querySelector(".cm-skr-rich-callout")).toBeNull();
    expect(view.dom.querySelector(".cm-skr-callout-icon-host")).toBeNull();
    expect(view.dom.querySelector(".cm-skr-strong")).toBeNull();
    expect(view.contentDOM.textContent).toContain(
      "> [!faq]- Need help> **Rendered answer**> - first",
    );

    view.dispatch({ selection: { anchor: source.indexOf("outside") } });
    expect(view.dom.querySelector(".cm-skr-rich-callout")).not.toBeNull();
    expect(view.dom.querySelector(".cm-skr-strong")).not.toBeNull();
  });
});
