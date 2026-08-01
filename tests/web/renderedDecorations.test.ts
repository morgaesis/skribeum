import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  defaultHighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changedTextSpan } from "../../src/lib/editor/byteChangeSet";
import {
  decorationEngine,
  taskStatusConfiguration,
} from "../../src/lib/editor/decorations/engine";
import type { WikilinkResolutionContext } from "../../src/lib/editor/decorations/wikilinks";
import { codeLanguage } from "../../src/lib/editor/markdown/codeLanguages";
import { obsidianMarkdownExtensionsFor } from "../../src/lib/editor/markdown/obsidian";
import {
  DEFAULT_TASK_STATUSES,
  type TaskStatus,
} from "../../src/lib/taskStatuses";

const views: EditorView[] = [];

function mountedView(
  doc: string,
  cursor = doc.length,
  context?: WikilinkResolutionContext,
  taskStatuses: readonly TaskStatus[] = DEFAULT_TASK_STATUSES,
): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: obsidianMarkdownExtensionsFor(taskStatuses),
          codeLanguages: codeLanguage,
        }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        taskStatusConfiguration.of(taskStatuses),
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
  it("renders every configured status with its glyph and accessible name", () => {
    for (const status of DEFAULT_TASK_STATUSES) {
      const view = mountedView(
        `- [${status.symbol}] ${status.name}\n\noutside`,
      );
      const checkbox = view.dom.querySelector<HTMLElement>(
        ".cm-skr-task-checkbox",
      );
      expect(checkbox?.getAttribute("aria-label")).toBe(status.name);
      expect(checkbox?.getAttribute("data-category")).toBe(status.category);
      expect(checkbox?.querySelector(".cm-skr-task-glyph")?.textContent).toBe(
        status.glyph,
      );
      view.destroy();
      views.pop();
    }
  }, 15_000);

  it("cycles by replacing only the configured source character", () => {
    const source = "- [ ] task\n\noutside";
    const view = mountedView(source);
    view.dom.querySelector<HTMLElement>(".cm-skr-task-checkbox")?.click();
    expect(view.state.doc.toString()).toBe("- [/] task\n\noutside");
    expect(changedTextSpan(source, view.state.doc.toString())).toEqual({
      from: 3,
      to: 4,
      insert: "/",
    });
    view.dom.querySelector<HTMLElement>(".cm-skr-task-checkbox")?.click();
    expect(view.state.doc.toString()).toBe("- [x] task\n\noutside");
    view.dom.querySelector<HTMLElement>(".cm-skr-task-checkbox")?.click();
    expect(view.state.doc.toString()).toBe(source);
  });

  it("renders and cycles a custom status while leaving unknown markers alone", () => {
    const taskStatuses: TaskStatus[] = [
      {
        symbol: " ",
        name: "Ready",
        category: "TODO",
        glyph: "○",
        color_token: "--skr-accent",
        next_status: "~",
      },
      {
        symbol: "~",
        name: "Paused",
        category: "ON_HOLD",
        glyph: "Ⅱ",
        color_token: "--skr-callout-purple",
        next_status: "x",
      },
      {
        symbol: "x",
        name: "Finished",
        category: "DONE",
        glyph: "✓",
        color_token: "--skr-success",
        next_status: " ",
      },
    ];
    const source = "- [~] custom\n- [?] unknown\n\noutside";
    const view = mountedView(source, source.length, undefined, taskStatuses);
    const checkbox = view.dom.querySelector<HTMLElement>(
      ".cm-skr-task-checkbox",
    );
    expect(checkbox?.getAttribute("aria-label")).toBe("Paused");
    expect(checkbox?.textContent).toBe("Ⅱ");
    expect(view.dom.querySelectorAll(".cm-skr-task-checkbox")).toHaveLength(1);
    checkbox?.click();
    expect(view.state.doc.toString()).toBe(
      "- [x] custom\n- [?] unknown\n\noutside",
    );
    const updatedControl = view.dom.querySelector<HTMLElement>(
      ".cm-skr-task-control",
    );
    updatedControl?.dispatchEvent(new Event("pointerenter"));
    const readyOption = [
      ...(updatedControl?.querySelectorAll<HTMLElement>('[role="option"]') ??
        []),
    ].find((option) => option.textContent?.includes("Ready"));
    readyOption?.click();
    expect(view.state.doc.toString()).toBe(
      "- [ ] custom\n- [?] unknown\n\noutside",
    );
    view.dom.querySelector<HTMLElement>(".cm-skr-task-checkbox")?.click();
    expect(view.state.doc.toString()).toBe(source);
  });

  it("opens the listbox by pointer and keyboard and selects with arrows", async () => {
    const source = "- [ ] task\n\noutside";
    const view = mountedView(source);
    const control = view.dom.querySelector<HTMLElement>(".cm-skr-task-control");
    const checkbox = control?.querySelector<HTMLElement>(
      ".cm-skr-task-checkbox",
    );
    const listbox = control?.querySelector<HTMLElement>('[role="listbox"]');
    expect(listbox?.hidden).toBe(true);
    control?.dispatchEvent(new Event("pointerenter"));
    expect(listbox?.hidden).toBe(false);
    expect(listbox?.querySelectorAll('[role="option"]')).toHaveLength(
      DEFAULT_TASK_STATUSES.length,
    );

    control?.dispatchEvent(new Event("pointerleave"));
    checkbox?.focus();
    checkbox?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await Promise.resolve();
    expect(document.activeElement).toBe(listbox);
    listbox?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    listbox?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(view.state.doc.toString()).toBe("- [x] task\n\noutside");
  });

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

  it("renders a themed callout with an icon, title, and collapsible rich body", () => {
    const source =
      "> [!faq]- Need help\n> **Rendered answer**\n> - first\n\noutside";
    const view = mountedView(source);
    const callout = view.dom.querySelector<HTMLElement>(
      '[role="note"][data-callout="faq"]',
    );
    expect(callout).not.toBeNull();
    expect(callout?.getAttribute("data-callout-canonical")).toBe("question");
    expect(callout?.getAttribute("data-accent")).toBe("yellow");
    expect(callout?.querySelector("svg.cm-skr-callout-icon")).not.toBeNull();
    const button = callout?.querySelector<HTMLButtonElement>(
      'button[aria-expanded="false"]',
    );
    expect(button?.textContent).toContain("Need help");
    const body = callout?.querySelector<HTMLElement>(".cm-skr-callout-body");
    expect(body?.hidden).toBe(true);
    button?.click();
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(body?.hidden).toBe(false);
    expect(body?.querySelector(".cm-skr-strong")?.textContent).toContain(
      "Rendered answer",
    );
    expect(body?.textContent).toContain("first");
  });
});
