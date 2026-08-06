import { cursorCharForward, deleteCharBackward } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { changedTextSpan } from "../../src/lib/editor/byteChangeSet";
import {
  closeRenderedTableSource,
  decorationEngine,
  dispatchWikilinkContext,
  editRenderedTableSource,
  explicitTableSource,
  focusedRenderedTableCell,
  focusRenderedTableCell,
  pointInPreviewCone,
  sourceRevealFocusMode,
  taskStatusConfiguration,
  tokenHighlightStyle,
} from "../../src/lib/editor/decorations/engine";
import type { WikilinkResolutionContext } from "../../src/lib/editor/decorations/wikilinks";
import { codeLanguage } from "../../src/lib/editor/markdown/codeLanguages";
import { obsidianMarkdownExtensionsFor } from "../../src/lib/editor/markdown/obsidian";
import { createAppRegistry } from "../../src/lib/features";
import { TASK_STATUS_MENU_COMMAND } from "../../src/lib/features/taskCommands";
import type { CommandContext } from "../../src/lib/registry";
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
        syntaxHighlighting(tokenHighlightStyle, { fallback: true }),
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
  vi.useRealTimers();
  document.body.textContent = "";
});

describe("rendered decoration DOM", () => {
  it("keeps an unfocused parked caret from revealing frontmatter", async () => {
    const source = "---\ntitle: Parked\n---\n\nBody\n";
    const focusMode = new Compartment();
    const view = new EditorView({
      state: EditorState.create({
        doc: source,
        selection: { anchor: 0 },
        extensions: [
          markdown({
            base: markdownLanguage,
            extensions: obsidianMarkdownExtensionsFor(DEFAULT_TASK_STATUSES),
            codeLanguages: codeLanguage,
          }),
          taskStatusConfiguration.of(DEFAULT_TASK_STATUSES),
          decorationEngine(),
          focusMode.of(sourceRevealFocusMode(false)),
        ],
      }),
      parent: document.body,
    });
    views.push(view);

    expect(
      view.dom.querySelector('.cm-skr-frontmatter[data-revealed="true"]'),
    ).toBeNull();
    view.dispatch({
      effects: focusMode.reconfigure(sourceRevealFocusMode(true)),
      selection: { anchor: source.indexOf("Parked") },
    });
    await expect(
      waitForElement(view.dom, '.cm-skr-frontmatter[data-revealed="true"]'),
    ).resolves.toBeTruthy();
  });

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

  it("cycles the task marker by keyboard with exact source bytes", () => {
    const view = mountedView("- [ ] task");
    view.dom.querySelector<HTMLElement>(".cm-skr-task-checkbox")?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(view.state.doc.toString()).toBe("- [/] task");
  });

  it("groups the default menu into at most ten selectable rows", () => {
    const view = mountedView("- [ ] task");
    const control = view.dom.querySelector<HTMLElement>(".cm-skr-task-control");
    control?.dispatchEvent(new Event("pointerenter"));
    expect(
      [...(control?.querySelectorAll("[data-task-track-heading]") ?? [])].map(
        (heading) => heading.textContent,
      ),
    ).toEqual(["Task", "Time", "Importance", "Reference"]);
    expect(control?.querySelectorAll('[role="option"]')).toHaveLength(10);
    expect(control?.textContent).toContain("More statuses (29)");
    [...(control?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
      .find((option) => option.textContent?.includes("More statuses"))
      ?.click();
    expect(control?.querySelectorAll('[role="option"]')).toHaveLength(38);
    expect(control?.textContent).not.toContain("More statuses (29)");
  });

  it("writes a menu date as plain text and renders its token as a chip", () => {
    const view = mountedView("- [ ] task");
    const control = view.dom.querySelector<HTMLElement>(".cm-skr-task-control");
    control?.dispatchEvent(new Event("pointerenter"));
    const due = [
      ...(control?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
    ].find((option) => option.textContent?.includes("Due"));
    due?.click();
    const date = control?.querySelector<HTMLInputElement>(
      '[data-testid="task-date-payload"]',
    );
    expect(date).not.toBeNull();
    if (date === null) return;
    date.value = "2030-01-02";
    date.dispatchEvent(new Event("input", { bubbles: true }));
    date.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(view.state.doc.toString()).toBe("- [D] task 📅 2030-01-02");
    expect(view.dom.querySelector(".cm-skr-task-payload")?.textContent).toBe(
      "📅 2030-01-02",
    );
  });

  it("cycles importance levels as source payloads", () => {
    const expected = [
      "- [!] important ⏫",
      "- [!] important 🔼",
      "- [!] important 🔽",
      "- [!] important",
    ];
    const view = mountedView("- [!] important");
    for (const document of expected) {
      view.dom.querySelector<HTMLElement>(".cm-skr-task-checkbox")?.click();
      expect(view.state.doc.toString()).toBe(document);
    }
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
    expect(listbox?.querySelectorAll('[role="option"]')).toHaveLength(10);

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
    expect(view.state.doc.toString()).toBe("- [/] task\n\noutside");
  });

  it("opens the grouped menu in unheld tap mode through the registered command", async () => {
    const source = "- [ ] task\n\noutside";
    const view = mountedView(source, source.indexOf("outside"));
    const context: CommandContext = {
      view,
      openNote: () => Promise.resolve(),
      openView: () => {},
      openCommandSurface: () => {},
      toggleView: () => {},
      closeSurfaces: () => {},
      requestSave: () => {},
      notePaths: () => [],
      recentNotePaths: () => [],
      navigateBack: () => false,
      navigateForward: () => false,
      followLink: () => false,
    };
    const registry = createAppRegistry();
    const checkbox = view.dom.querySelector<HTMLElement>(
      ".cm-skr-task-checkbox",
    );
    checkbox?.focus();

    expect(registry.run(TASK_STATUS_MENU_COMMAND, context)).toBe(true);
    await Promise.resolve();
    const listbox = view.dom.querySelector<HTMLElement>(".cm-skr-task-palette");
    expect(listbox?.hidden).toBe(false);
    expect(document.activeElement).toBe(listbox);
    expect(listbox?.getAttribute("aria-activedescendant")).not.toBeNull();
    expect(view.state.doc.toString()).toBe(source);

    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    expect(listbox?.hidden).toBe(true);
    expect(document.activeElement).toBe(checkbox);
    expect(view.state.doc.toString()).toBe(source);

    expect(registry.run(TASK_STATUS_MENU_COMMAND, context)).toBe(true);
    await Promise.resolve();

    const cancelled = [
      ...(listbox?.querySelectorAll<HTMLElement>("[role=option]") ?? []),
    ].find((option) => option.textContent?.includes("Cancelled"));
    cancelled?.click();
    await Promise.resolve();
    expect(view.state.doc.toString()).toBe("- [-] task\n\noutside");
    expect(document.activeElement?.classList).toContain("cm-skr-task-checkbox");
  });

  it("re-anchors the tap-opened task menu when the editor scrolls under it", async () => {
    const source = "- [ ] task\n\noutside";
    const view = mountedView(source, source.indexOf("outside"));
    const context: CommandContext = {
      view,
      openNote: () => Promise.resolve(),
      openView: () => {},
      openCommandSurface: () => {},
      toggleView: () => {},
      closeSurfaces: () => {},
      requestSave: () => {},
      notePaths: () => [],
      recentNotePaths: () => [],
      navigateBack: () => false,
      navigateForward: () => false,
      followLink: () => false,
    };
    const registry = createAppRegistry();
    const checkbox = view.dom.querySelector<HTMLElement>(
      ".cm-skr-task-checkbox",
    );
    checkbox?.focus();

    const rectAt = (bottom: number): DOMRect =>
      ({
        left: 20,
        right: 40,
        top: bottom - 20,
        bottom,
        width: 20,
        height: 20,
        x: 20,
        y: bottom - 20,
        toJSON: () => ({}),
      }) as DOMRect;
    // Before the menu opens, the checkbox sits low on screen.
    Object.defineProperty(checkbox as HTMLElement, "getBoundingClientRect", {
      configurable: true,
      value: () => rectAt(120),
    });

    expect(registry.run(TASK_STATUS_MENU_COMMAND, context)).toBe(true);
    await Promise.resolve();
    const palette = view.dom.querySelector<HTMLElement>(".cm-skr-task-palette");
    expect(palette?.hidden).toBe(false);
    const topAfterOpen = palette?.style.top;
    expect(topAfterOpen).not.toBe("");

    // The note scrolls while the menu stays open: the checkbox is now much
    // further up the screen. Without live re-anchoring the menu would stay
    // glued to its first position, floating over whatever is now under it.
    Object.defineProperty(checkbox as HTMLElement, "getBoundingClientRect", {
      configurable: true,
      value: () => rectAt(500),
    });
    view.scrollDOM.dispatchEvent(new Event("scroll"));

    expect(palette?.style.top).not.toBe(topAfterOpen);
    const numericTop = Number.parseFloat(palette?.style.top ?? "0");
    // The menu tracks the checkbox's new bottom edge (minus the fixed
    // finger gap the placement math reserves), not its stale first spot.
    expect(numericTop).toBeGreaterThan(400);
  });

  it("keeps heading marker geometry stable while cursor visibility changes", async () => {
    const source = "# Heading\n\nfollowing line";
    const view = mountedView(source, source.indexOf("following"));
    const marker = () =>
      view.dom.querySelector<HTMLElement>(".cm-skr-reveal-marker");
    expect(marker()?.textContent).toBe("# ");
    await vi.waitFor(() => {
      expect(marker()?.classList.contains("cm-skr-reveal-marker-active")).toBe(
        false,
      );
    });

    view.dispatch({ selection: { anchor: source.indexOf("Heading") } });
    await vi.waitFor(() => {
      expect(marker()?.classList.contains("cm-skr-reveal-marker-active")).toBe(
        true,
      );
    });

    view.dispatch({ selection: { anchor: source.indexOf("following") } });
    await vi.waitFor(() => {
      expect(marker()?.classList.contains("cm-skr-reveal-marker-active")).toBe(
        false,
      );
    });
  });

  it("labels both directions of link, embed, and callout source swaps", () => {
    const source =
      "[label](https://example.com)\n\n![[missing]]\n\n> [!note] Title\n> body\n\noutside";
    const view = mountedView(source);
    expect(
      view.dom
        .querySelector(".cm-skr-link")
        ?.classList.contains("cm-skr-reveal-rendered"),
    ).toBe(true);
    expect(
      view.dom
        .querySelector(".cm-skr-embed")
        ?.classList.contains("cm-skr-reveal-rendered"),
    ).toBe(true);
    expect(
      view.dom
        .querySelector(".cm-skr-rich-callout .cm-skr-reveal-motion")
        ?.classList.contains("cm-skr-reveal-rendered"),
    ).toBe(true);

    view.dispatch({ selection: { anchor: source.indexOf("example.com") } });
    expect(
      view.dom
        .querySelector(".cm-skr-link")
        ?.classList.contains("cm-skr-reveal-source"),
    ).toBe(true);

    view.dispatch({ selection: { anchor: source.indexOf("missing") } });
    expect(view.dom.querySelector(".cm-skr-embed")).toBeNull();
    expect(
      view.dom.querySelector(".cm-skr-reveal-embed-source"),
    ).not.toBeNull();

    view.dispatch({ selection: { anchor: source.indexOf("Title") } });
    expect(
      view.dom
        .querySelector(".cm-skr-rich-callout .cm-skr-reveal-motion")
        ?.classList.contains("cm-skr-reveal-source"),
    ).toBe(true);
    expect(
      view.dom
        .querySelector(".cm-skr-rich-callout")
        ?.getAttribute("data-revealed"),
    ).toBe("true");

    view.dispatch({ selection: { anchor: source.indexOf("outside") } });
    expect(
      view.dom
        .querySelector(".cm-skr-link")
        ?.classList.contains("cm-skr-reveal-rendered"),
    ).toBe(true);
    expect(
      view.dom
        .querySelector(".cm-skr-embed")
        ?.classList.contains("cm-skr-reveal-rendered"),
    ).toBe(true);
    expect(
      view.dom
        .querySelector(".cm-skr-rich-callout .cm-skr-reveal-motion")
        ?.classList.contains("cm-skr-reveal-rendered"),
    ).toBe(true);
  });

  it("renders one ARIA grid and never reveals pipe source on cursor travel", () => {
    const source =
      "| Name | Score |\n| :--- | ---: |\n| Ada | 10 |\n| Grace | 9 |\n\noutside";
    const view = mountedView(source);
    const grid = view.dom.querySelector('[role="grid"]');
    expect(grid).not.toBeNull();
    const rows = view.dom.querySelectorAll<HTMLElement>('[role="row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('[role="columnheader"]')?.textContent).toBe(
      "Name",
    );
    expect(rows[1]?.querySelectorAll('[role="gridcell"]')[1]?.textContent).toBe(
      "10",
    );
    expect(
      (rows[1]?.querySelectorAll<HTMLElement>('[role="gridcell"]')[1] ?? null)
        ?.style.textAlign,
    ).toBe("right");
    expect(rows[0]?.style.gridTemplateColumns).toBe(
      rows[1]?.style.gridTemplateColumns,
    );

    view.dispatch({ selection: { anchor: source.indexOf("Name") } });
    expect(view.dom.querySelectorAll('[role="row"]')).toHaveLength(3);
    expect(view.contentDOM.textContent).not.toContain("| Name | Score |");
    expect(view.dom.querySelector('[role="gridcell"]')?.textContent).toBe(
      "Ada",
    );
  });

  it("parks the host selection while a nested cell writes one exact span", async () => {
    const source =
      "before\n| Name  | Score |\n| :--- | ---: |\n| café   | keep  |\n\nafter";
    const tableFrom = source.indexOf("| Name");
    const view = mountedView(source, source.length);
    const rows = [...view.dom.querySelectorAll<HTMLElement>('[role="row"]')];
    const beforeTemplate = rows[0]?.style.gridTemplateColumns;
    const tableShell = view.dom.querySelector(".cm-skr-table-shell");

    expect(focusRenderedTableCell(view, tableFrom, 1, 0, "end")).toBe(true);
    const activeCell = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"]',
    );
    const nestedEditor = activeCell?.querySelector<HTMLElement>(".cm-editor");
    const nested =
      nestedEditor === null || nestedEditor === undefined
        ? null
        : EditorView.findFromDOM(nestedEditor);
    expect(nested).not.toBeNull();
    expect(view.state.selection.main.head).toBe(tableFrom);
    expect(view.dom.dataset.tableCellActive).toBe("true");
    expect(activeCell?.getAttribute("role")).toBe("gridcell");
    expect(activeCell?.getAttribute("aria-selected")).toBe("true");
    expect(
      activeCell?.querySelector<HTMLElement>(".cm-content")?.tabIndex,
    ).toBe(0);
    expect(
      [
        ...view.dom.querySelectorAll<HTMLElement>(
          ".cm-skr-table-cell .cm-content",
        ),
      ]
        .filter(
          (element) => element !== activeCell?.querySelector(".cm-content"),
        )
        .every((element) => element.tabIndex === -1),
    ).toBe(true);

    const insertion = "naïve|🙂 and a much longer value";
    nested?.dispatch({
      changes: {
        from: 0,
        to: nested.state.doc.length,
        insert: insertion,
      },
      selection: { anchor: insertion.length },
      userEvent: "input.type",
    });
    await Promise.resolve();

    expect(view.state.doc.toString()).toBe(
      "before\n| Name  | Score |\n| :--- | ---: |\n| naïve\\|🙂 and a much longer value   | keep  |\n\nafter",
    );
    expect(view.dom.querySelector(".cm-skr-table-shell")).toBe(tableShell);
    expect(
      EditorView.findFromDOM(
        view.dom.querySelector<HTMLElement>(
          '.cm-skr-table-cell[data-editing="true"] .cm-editor',
        ) as HTMLElement,
      ),
    ).toBe(nested);
    expect(view.state.selection.main.head).toBe(tableFrom);
    const updatedRows = [
      ...view.dom.querySelectorAll<HTMLElement>('[role="row"]'),
    ];
    expect(updatedRows[0]?.style.gridTemplateColumns).not.toBe(beforeTemplate);
    expect(
      updatedRows.every(
        (row) =>
          row.style.gridTemplateColumns ===
          updatedRows[0]?.style.gridTemplateColumns,
      ),
    ).toBe(true);
  });

  it("reveals table pipes only through the deliberate table source command", async () => {
    const source = "before\n| a | b |\n| --- | --- |\n| c | d |\n\nafter";
    const tableFrom = source.indexOf("| a");
    const view = mountedView(source, source.length);
    expect(focusRenderedTableCell(view, tableFrom, 1, 1, 1)).toBe(true);
    expect(view.contentDOM.textContent).not.toContain("| --- | --- |");

    expect(editRenderedTableSource(view)).toBe(true);
    await Promise.resolve();
    expect(explicitTableSource(view.state)).toMatchObject({
      from: tableFrom,
      row: 1,
      column: 1,
    });
    expect(view.state.selection.main.head).toBe(source.indexOf("d") + 1);
    expect(view.dom.querySelector('[role="grid"]')).toBeNull();
    expect(view.contentDOM.textContent).toContain("| --- | --- |");

    const outside = source.indexOf("after");
    view.dispatch({ selection: { anchor: outside } });
    await Promise.resolve();
    expect(explicitTableSource(view.state)).toBeNull();
    expect(view.state.selection.main.head).toBe(outside);
    expect(view.dom.querySelector('[role="grid"]')).not.toBeNull();
  });

  it("tracks explicit source edits at both table boundaries", async () => {
    const source = "before\n| a | b |\n| --- | --- |\n| c | d |\n\nafter";
    const tableFrom = source.indexOf("| a");
    const view = mountedView(source, source.length);
    expect(focusRenderedTableCell(view, tableFrom, 1, 1, "end")).toBe(true);
    expect(editRenderedTableSource(view)).toBe(true);
    let range = explicitTableSource(view.state);
    expect(range).not.toBeNull();
    if (range === null) return;

    view.dispatch({
      changes: { from: range.from, to: range.from, insert: " " },
      selection: { anchor: range.from + 1 },
      userEvent: "input.type",
    });
    range = explicitTableSource(view.state);
    expect(range?.from).toBe(tableFrom);
    expect(view.dom.querySelector('[role="grid"]')).toBeNull();
    if (range === null) return;

    view.dispatch({
      changes: { from: range.to, to: range.to, insert: " " },
      selection: { anchor: range.to + 1 },
      userEvent: "input.type",
    });
    await Promise.resolve();
    range = explicitTableSource(view.state);
    expect(range?.to).toBe(source.indexOf("\n\nafter") + 2);
    expect(view.dom.querySelector('[role="grid"]')).toBeNull();
  });

  it("restores the exact cell after a deliberate source round trip", async () => {
    const source = "| a | b |\n| --- | --- |\n| c | d |\n| e | f |";
    const view = mountedView(source, 0);
    expect(focusRenderedTableCell(view, 0, 1, 1, "end")).toBe(true);
    expect(editRenderedTableSource(view)).toBe(true);
    expect(view.state.selection.main.head).toBe(source.indexOf("d") + 1);
    expect(closeRenderedTableSource(view, true)).toBe(true);
    await Promise.resolve();

    expect(focusedRenderedTableCell(view)).toMatchObject({
      row: 1,
      column: 1,
      anchor: 1,
      head: 1,
    });
  });

  it("maps the cell caret through external edits within its source", () => {
    const source = "| ab | b |\n| --- | --- |\n| c | d |";
    const view = mountedView(source, 0);
    expect(focusRenderedTableCell(view, 0, 0, 0, "end")).toBe(true);

    view.dispatch({
      changes: { from: source.indexOf("b"), insert: "X" },
      userEvent: "input.external",
    });

    const nested = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"] .cm-editor',
    );
    const nestedView = nested === null ? null : EditorView.findFromDOM(nested);
    expect(nestedView?.state.doc.toString()).toBe("aXb");
    expect(nestedView?.state.selection.main.head).toBe(3);
  });

  it("drops cell ownership when its rendered widget is evicted", () => {
    const source = "| a | b |\n| --- | --- |\n| c | d |";
    const view = mountedView(source, 0);
    expect(focusRenderedTableCell(view, 0, 1, 0, "end")).toBe(true);
    view.dom
      .querySelector<HTMLElement>('.cm-skr-table-cell[data-editing="true"]')
      ?.remove();

    expect(focusedRenderedTableCell(view)).toBeNull();
    expect(view.dom.dataset.tableCellActive).toBeUndefined();
  });

  it("promotes a pointer drag when the browser omits move button state", () => {
    const source = "| a | b |\n| --- | --- |\n| c | d |";
    const view = mountedView(source, 0);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-row="1"][data-column="0"]',
    );
    expect(cell).not.toBeNull();
    cell?.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        pointerId: 7,
        buttons: 1,
      }),
    );
    document.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        pointerId: 7,
        buttons: 0,
      }),
    );

    expect(view.dom.querySelector(".cm-skr-table-selected")).not.toBeNull();
    expect(focusedRenderedTableCell(view)).toBeNull();
  });

  it("promotes a mouse drag when pointer events are unavailable", () => {
    const source = "| a | b |\n| --- | --- |\n| c | d |";
    const view = mountedView(source, 0);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-row="1"][data-column="0"]',
    );
    expect(cell).not.toBeNull();
    const pointerEventDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      "PointerEvent",
    );
    Object.defineProperty(globalThis, "PointerEvent", {
      configurable: true,
      value: undefined,
      writable: true,
    });
    try {
      cell?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    } finally {
      if (pointerEventDescriptor === undefined) {
        Reflect.deleteProperty(globalThis, "PointerEvent");
      } else {
        Object.defineProperty(
          globalThis,
          "PointerEvent",
          pointerEventDescriptor,
        );
      }
    }

    expect(view.dom.querySelector(".cm-skr-table-selected")).not.toBeNull();
    expect(focusedRenderedTableCell(view)).toBeNull();
  });

  it("closes explicit source when Enter leaves the recognized table", async () => {
    const source = "| a | b |\n| --- | --- |\n| c | d |\n\nafter";
    const view = mountedView(source, 0);
    expect(focusRenderedTableCell(view, 0, 1, 1, "end")).toBe(true);
    expect(editRenderedTableSource(view)).toBe(true);
    const range = explicitTableSource(view.state);
    expect(range).not.toBeNull();
    if (range === null) return;

    view.dispatch({
      changes: { from: range.to, to: range.to, insert: "\n" },
      selection: { anchor: range.to + 1 },
      userEvent: "input.type",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(explicitTableSource(view.state)).toBeNull();
    expect(view.dom.querySelector('[role="grid"]')).not.toBeNull();
    expect(view.state.selection.main.head).toBe(range.to + 1);
  });

  it("rederives the table start after a leading source newline", async () => {
    const source = "| a | b |\n| --- | --- |\n| c | d |";
    const view = mountedView(source, 0);
    expect(focusRenderedTableCell(view, 0, 1, 0, "end")).toBe(true);
    expect(editRenderedTableSource(view)).toBe(true);
    const range = explicitTableSource(view.state);
    expect(range).not.toBeNull();
    if (range === null) return;

    view.dispatch({
      changes: { from: range.from, to: range.from, insert: "\n" },
      selection: { anchor: range.from + 1 },
      userEvent: "input.type",
    });
    await Promise.resolve();
    expect(explicitTableSource(view.state)?.from).toBe(1);
    expect(closeRenderedTableSource(view, true)).toBe(true);
    await Promise.resolve();
    expect(focusedRenderedTableCell(view)).toMatchObject({
      tableFrom: 1,
      row: 0,
      column: 0,
    });
  });

  it("preserves the vertical text goal through shorter cells", () => {
    const source =
      "| 123456789 | x |\n| --- | --- |\n| z | y |\n| abcdefghi | q |";
    const view = mountedView(source, 0);
    expect(focusRenderedTableCell(view, 0, 0, 0, 8)).toBe(true);
    const activeNested = (): EditorView | null => {
      const editor = view.dom.querySelector<HTMLElement>(
        '.cm-skr-table-cell[data-editing="true"] .cm-editor',
      );
      return editor === null ? null : EditorView.findFromDOM(editor);
    };
    const down = () =>
      activeNested()?.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
          cancelable: true,
        }),
      );
    down();
    expect(activeNested()?.state.selection.main.head).toBe(1);
    down();
    expect(activeNested()?.state.selection.main.head).toBe(8);
  });

  it("keeps inactive inline cells quiet and exposes one grid tab stop", () => {
    const source = "| **bold** | `code` |\n| --- | --- |\n| [[Note]] | #tag |";
    const view = mountedView(source, 0);
    expect(view.contentDOM.textContent).not.toContain("**bold**");
    expect(view.contentDOM.textContent).not.toContain("`code`");
    expect(focusRenderedTableCell(view, 0, 0, 0, 2)).toBe(true);
    expect(
      view.dom.querySelectorAll('.cm-skr-table-grid [tabindex="0"]'),
    ).toHaveLength(1);
    expect(
      [
        ...view.dom.querySelectorAll<HTMLButtonElement>(".cm-skr-table-insert"),
      ].every((button) => button.tabIndex === -1),
    ).toBe(true);
    expect(focusRenderedTableCell(view, 0, 0, 1, "end")).toBe(true);
    const first = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-row="0"][data-column="0"]',
    );
    expect(first?.textContent).toBe("bold");
  });

  it("rejects stale cross-table writes and normalizes pasted newlines", async () => {
    const source =
      "| a | b |\n| --- | --- |\n| c | d |\n\n| e | f |\n| --- | --- |\n| g | h |";
    const secondTable = source.indexOf("| e");
    const view = mountedView(source, 0);
    expect(focusRenderedTableCell(view, 0, 1, 0, "end")).toBe(true);
    const firstEditorElement = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"] .cm-editor',
    );
    const first =
      firstEditorElement === null
        ? null
        : EditorView.findFromDOM(firstEditorElement);
    expect(focusRenderedTableCell(view, secondTable, 1, 0, "end")).toBe(true);
    const before = view.state.doc.toString();
    first?.dispatch({ changes: { from: 0, to: 1, insert: "stale" } });
    expect(view.state.doc.toString()).toBe(before);
    expect(first?.state.doc.toString()).toBe("c");

    const activeElement = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"] .cm-editor',
    );
    const active =
      activeElement === null ? null : EditorView.findFromDOM(activeElement);
    active?.dispatch({ changes: { from: 0, to: 1, insert: "two\nlines" } });
    await Promise.resolve();
    expect(view.state.doc.toString()).toContain("| two lines | h |");
    expect(view.dom.querySelectorAll('[role="grid"]')).toHaveLength(2);
  });

  it("keeps outer-pipe-free boundary edits owned by the same cell", async () => {
    const source = "a | b\n--- | ---\nc | d\n\nafter";
    const view = mountedView(source, 0);
    const activeNested = (): EditorView | null => {
      const editor = view.dom.querySelector<HTMLElement>(
        '.cm-skr-table-cell[data-editing="true"] .cm-editor',
      );
      return editor === null ? null : EditorView.findFromDOM(editor);
    };

    expect(focusRenderedTableCell(view, 0, 0, 0, "start")).toBe(true);
    activeNested()?.dispatch({ changes: { from: 0, to: 0, insert: "Z" } });
    await Promise.resolve();
    expect(focusedRenderedTableCell(view)).toMatchObject({
      tableFrom: 0,
      row: 0,
      column: 0,
    });
    expect(view.state.doc.toString()).toContain("Za | b");

    expect(focusRenderedTableCell(view, 0, 1, 1, "end")).toBe(true);
    const last = activeNested();
    last?.dispatch({
      changes: {
        from: last.state.doc.length,
        to: last.state.doc.length,
        insert: "!",
      },
    });
    await Promise.resolve();
    expect(focusedRenderedTableCell(view)).toMatchObject({
      tableFrom: 0,
      row: 1,
      column: 1,
    });
    expect(view.state.doc.toString()).toContain("c | d!");
  });

  it("drops cell ownership when the active table is replaced", () => {
    const first = "| a | b |\n| --- | --- |\n| c | d |";
    const second = "| e | f |\n| --- | --- |\n| g | h |";
    const source = `${first}\n\n${second}`;
    const view = mountedView(source, 0);
    expect(focusRenderedTableCell(view, 0, 1, 0, "end")).toBe(true);
    view.dispatch({ changes: { from: 0, to: first.length + 2, insert: "" } });
    expect(focusedRenderedTableCell(view)).toBeNull();
    expect(view.dom.querySelectorAll('[role="grid"]')).toHaveLength(1);
  });

  it("releases nested DOM focus when the host selection leaves the table", () => {
    const source = "| a | b |\n| --- | --- |\n| c | d |\n\nafter";
    const view = mountedView(source, 0);
    expect(focusRenderedTableCell(view, 0, 1, 0, "end")).toBe(true);
    const nestedContent = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"] .cm-content',
    );
    expect(document.activeElement).toBe(nestedContent);

    view.dispatch({ selection: { anchor: source.indexOf("after") } });

    expect(focusedRenderedTableCell(view)).toBeNull();
    expect(document.activeElement).not.toBe(nestedContent);
    expect(view.dom.querySelector('[data-editing="true"]')).toBeNull();
  });

  it("moves the one cell caret across boundaries and promotes outward selection", () => {
    const source = "before\n| a | b |\n| --- | --- |\n| c | d |\n\nafter";
    const tableFrom = source.indexOf("| a");
    const tableTo = source.indexOf("\n\nafter");
    const view = mountedView(source, 0);
    const activeNested = (): EditorView | null => {
      const editor = view.dom.querySelector<HTMLElement>(
        '.cm-skr-table-cell[data-editing="true"] .cm-editor',
      );
      return editor === null ? null : EditorView.findFromDOM(editor);
    };
    const press = (key: string, shiftKey = false) => {
      activeNested()?.contentDOM.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          shiftKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    expect(focusRenderedTableCell(view, tableFrom, 1, 0, "end")).toBe(true);
    expect(activeNested()?.state.selection.main.head).toBe(1);
    press("ArrowRight");
    expect(
      view.dom
        .querySelector('[data-editing="true"]')
        ?.getAttribute("data-column"),
    ).toBe("1");
    expect(activeNested()?.state.selection.main.head).toBe(0);

    press("Tab", true);
    expect(
      view.dom
        .querySelector('[data-editing="true"]')
        ?.getAttribute("data-column"),
    ).toBe("0");
    expect(activeNested()?.state.selection.main).toMatchObject({
      from: 0,
      to: 1,
    });

    expect(focusRenderedTableCell(view, tableFrom, 0, 1, "end")).toBe(true);
    press("ArrowRight");
    expect(
      view.dom.querySelector('[data-editing="true"]')?.getAttribute("data-row"),
    ).toBe("1");
    expect(
      view.dom
        .querySelector('[data-editing="true"]')
        ?.getAttribute("data-column"),
    ).toBe("0");
    expect(activeNested()?.state.selection.main.head).toBe(0);

    press("ArrowLeft");
    expect(
      view.dom.querySelector('[data-editing="true"]')?.getAttribute("data-row"),
    ).toBe("0");
    expect(
      view.dom
        .querySelector('[data-editing="true"]')
        ?.getAttribute("data-column"),
    ).toBe("1");

    expect(focusRenderedTableCell(view, tableFrom, 1, 1, "end")).toBe(true);
    press("ArrowRight", true);
    expect(view.state.selection.main.from).toBe(tableFrom);
    expect(view.state.selection.main.to).toBe(tableTo);
    expect(view.dom.querySelector('[data-editing="true"]')).toBeNull();
    expect(view.dom.querySelector(".cm-skr-table-selected")).not.toBeNull();

    expect(focusRenderedTableCell(view, tableFrom, 1, 0, "end")).toBe(true);
    activeNested()?.dispatch({ selection: { anchor: 1, head: 0 } });
    press("ArrowLeft", true);
    expect(view.state.selection.main.from).toBe(tableFrom);
    expect(view.state.selection.main.to).toBe(tableTo);

    expect(focusRenderedTableCell(view, tableFrom, 0, 0, "start")).toBe(true);
    press("ArrowUp", true);
    expect(view.state.selection.main.from).toBe(tableFrom);
    expect(view.state.selection.main.to).toBe(tableTo);

    expect(focusRenderedTableCell(view, tableFrom, 0, 0, "start")).toBe(true);
    press("ArrowUp");
    expect(view.state.selection.main.head).toBe(source.indexOf("before") + 6);
    expect(view.dom.querySelector('[data-editing="true"]')).toBeNull();

    expect(focusRenderedTableCell(view, tableFrom, 1, 0, "start")).toBe(true);
    const beforeBackspace = view.state.doc.toString();
    press("Backspace");
    expect(view.state.doc.toString()).toBe(beforeBackspace);

    expect(focusRenderedTableCell(view, tableFrom, 1, 1, "end")).toBe(true);
    press("Delete");
    expect(view.state.doc.toString()).toBe(beforeBackspace);

    expect(focusRenderedTableCell(view, tableFrom, 1, 0, "start")).toBe(true);
    press("Escape");
    expect(view.state.selection.main.head).toBe(tableTo + 1);
  });

  it("copies and deletes an outward-promoted table as exact source", () => {
    const table = "| a | b |\n| --- | --- |\n| c | d |";
    const source = `before\n${table}\n\nafter`;
    const tableFrom = source.indexOf("| a");
    const view = mountedView(source, 0);
    expect(focusRenderedTableCell(view, tableFrom, 1, 1, "end")).toBe(true);
    const nestedEditor = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"] .cm-editor',
    );
    const nested =
      nestedEditor === null ? null : EditorView.findFromDOM(nestedEditor);
    nested?.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    const selection = view.state.selection.main;
    expect(view.state.sliceDoc(selection.from, selection.to)).toBe(table);
    expect(deleteCharBackward(view)).toBe(true);
    expect(view.state.doc.toString()).toBe("before\n\n\nafter");
    expect(view.dom.querySelector('[role="grid"]')).toBeNull();
  });

  it("keeps a thirty-row table rendered during host cursor travel", () => {
    const body = Array.from(
      { length: 30 },
      (_, index) => `| row ${index + 1} | value ${index + 1} |`,
    );
    const source = [
      "before",
      "| Name | Value |",
      "| --- | --- |",
      ...body,
      "",
      "after",
    ].join("\n");
    const view = mountedView(source, 0);
    for (const marker of ["Name", "row 1", "row 15", "row 30", "after"]) {
      view.dispatch({ selection: { anchor: source.indexOf(marker) } });
      expect(view.dom.querySelectorAll('[role="row"]')).toHaveLength(31);
      expect(view.dom.querySelector('[data-editing="true"]')).toBeNull();
      expect(view.contentDOM.textContent).not.toContain("| --- | --- |");
    }
  }, 10000);

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
        "# Before\nnot selected\n\n## Details\n**Rendered body**",
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

  it("keeps embed widgets mounted while link context and content resolve", async () => {
    let resolveNote: ((source: string) => void) | undefined;
    const loaded = new Promise<string>((resolve) => {
      resolveNote = resolve;
    });
    const view = mountedView("![[Other]]\n\noutside");
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
      loadNote: () => loaded,
    };

    dispatchWikilinkContext(view, context);
    const loading = await waitForElement(
      view.dom,
      '.skr-loading-embed[data-loading-state="skeleton"]',
    );
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.getAttribute("aria-label")).toBe("Loading content");
    expect(loading.querySelectorAll(".skr-skeleton-bar")).toHaveLength(2);

    resolveNote?.("# Other\n\n**Resolved content**");
    const rendered = await waitForElement(
      view.dom,
      ".cm-skr-embed-body .cm-editor",
    );
    expect(rendered.textContent).toContain("Resolved content");
    expect(
      view.dom.querySelector('[data-loading-state="skeleton"]'),
    ).toBeNull();
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

  it("renders the embed path after the link hover delay and dismisses on pointer out", async () => {
    vi.useFakeTimers();
    const context: WikilinkResolutionContext = {
      paths: ["Root.md", "Other.md"],
      config: {
        newLinkFormat: "shortest",
        useMarkdownLinks: false,
        attachmentFolderPath: "attachments",
      },
      currentPath: "Root.md",
      embedAncestry: ["Root.md"],
      embedDepth: 0,
      linkPreviews: true,
      loadNote: async () => "# Other\n\n**Rendered preview**",
    };
    const view = mountedView("See [[Other]].", undefined, context);
    const link = view.dom.querySelector<HTMLElement>(
      '[data-preview-target="Other"]',
    );
    expect(link?.getAttribute("tabindex")).toBe("0");

    link?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(449);
    expect(view.dom.querySelector('[data-testid="link-preview"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);

    const preview = view.dom.querySelector('[data-testid="link-preview"]');
    expect(preview?.getAttribute("role")).toBe("region");
    expect(preview?.textContent).toContain("Rendered preview");
    expect(preview?.querySelector(".cm-skr-strong")).not.toBeNull();
    link?.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: preview }),
    );
    expect(view.dom.querySelector('[data-testid="link-preview"]')).toBe(
      preview,
    );
    preview?.dispatchEvent(
      new MouseEvent("pointerout", { bubbles: true, relatedTarget: view.dom }),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(view.dom.querySelector('[data-testid="link-preview"]')).toBeNull();
  });

  it("keeps the preview open along the intent cone and closes outside it after grace", async () => {
    vi.useFakeTimers();
    const context: WikilinkResolutionContext = {
      paths: ["Root.md", "Other.md"],
      config: {
        newLinkFormat: "shortest",
        useMarkdownLinks: false,
        attachmentFolderPath: null,
      },
      currentPath: "Root.md",
      linkPreviews: true,
      loadNote: async () => "Preview body",
    };
    const view = mountedView("See [[Other]].", undefined, context);
    const link = view.dom.querySelector<HTMLElement>("[data-preview-target]");
    link?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(450);
    const preview = view.dom.querySelector<HTMLElement>(
      '[data-testid="link-preview"]',
    );
    expect(preview).not.toBeNull();
    if (preview === null) return;
    preview.getBoundingClientRect = () =>
      ({ left: 100, right: 300, top: 80, bottom: 200 }) as DOMRect;
    expect(
      pointInPreviewCone(
        { x: 75, y: 100 },
        { x: 50, y: 50 },
        preview.getBoundingClientRect(),
      ),
    ).toBe(true);

    link?.dispatchEvent(
      new MouseEvent("pointerout", {
        bubbles: true,
        clientX: 50,
        clientY: 50,
        relatedTarget: view.dom,
      }),
    );
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 75, clientY: 100 }),
    );
    await vi.advanceTimersByTimeAsync(299);
    expect(preview.isConnected).toBe(true);
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 75, clientY: 110 }),
    );
    await vi.advanceTimersByTimeAsync(299);
    expect(preview.isConnected).toBe(true);
    window.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 20, clientY: 220 }),
    );
    await vi.advanceTimersByTimeAsync(99);
    expect(preview.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(preview.isConnected).toBe(false);
  });

  it("opens a delayed preview with the shared three-bar skeleton", async () => {
    vi.useFakeTimers();
    let resolveNote: ((source: string) => void) | undefined;
    const source = new Promise<string>((resolve) => {
      resolveNote = resolve;
    });
    const context: WikilinkResolutionContext = {
      paths: ["Root.md", "Other.md"],
      config: {
        newLinkFormat: "shortest",
        useMarkdownLinks: false,
        attachmentFolderPath: null,
      },
      currentPath: "Root.md",
      linkPreviews: true,
      loadNote: () => source,
    };
    const view = mountedView("See [[Other]].", undefined, context);
    const link = view.dom.querySelector<HTMLElement>("[data-preview-target]");
    link?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(449);
    expect(view.dom.querySelector('[data-testid="link-preview"]')).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    const preview = view.dom.querySelector('[data-testid="link-preview"]');
    expect(preview?.querySelectorAll(".skr-skeleton-bar")).toHaveLength(3);
    expect(
      preview?.querySelector('[data-loading-state="skeleton"]'),
    ).not.toBeNull();

    resolveNote?.("**Resolved preview**");
    await vi.advanceTimersByTimeAsync(0);
    expect(preview?.querySelector(".cm-skr-strong")).not.toBeNull();
    expect(preview?.querySelector(".skr-skeleton-bar")).toBeNull();
  });

  it("renders preview content with the embed reading pipeline structure", async () => {
    vi.useFakeTimers();
    const linkedSource =
      "# Shared heading\n\n**Decorated content** and `code`.";
    const context: WikilinkResolutionContext = {
      paths: ["Root.md", "Other.md"],
      config: {
        newLinkFormat: "shortest",
        useMarkdownLinks: false,
        attachmentFolderPath: null,
      },
      currentPath: "Root.md",
      linkPreviews: true,
      loadNote: async () => linkedSource,
    };
    const view = mountedView(
      "![[Other]]\n\nPreview [[Other]].",
      undefined,
      context,
    );
    await vi.advanceTimersByTimeAsync(0);
    const embedContent = view.dom.querySelector(
      '.cm-skr-embed .cm-content[aria-label^="Embedded note"]',
    );
    const link = view.dom.querySelector<HTMLElement>("[data-preview-target]");
    link?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(450);
    const previewContent = view.dom.querySelector(
      '[data-testid="link-preview"] .cm-content',
    );
    expect(embedContent).not.toBeNull();
    expect(previewContent).not.toBeNull();
    expect(previewContent?.innerHTML).toBe(embedContent?.innerHTML);
  });

  it("elides frontmatter and nested embed bodies from previews", async () => {
    vi.useFakeTimers();
    const context: WikilinkResolutionContext = {
      paths: ["Root.md", "Other.md", "Nested.md"],
      config: {
        newLinkFormat: "shortest",
        useMarkdownLinks: false,
        attachmentFolderPath: null,
      },
      currentPath: "Root.md",
      linkPreviews: true,
      loadNote: async (path) =>
        path === "Other.md"
          ? "---\ntitle: Hidden metadata\n---\n# Visible heading\n\n![[Nested]]"
          : "Nested body must stay hidden.",
    };
    const view = mountedView("Preview [[Other]].", undefined, context);
    const link = view.dom.querySelector<HTMLElement>("[data-preview-target]");
    link?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(450);
    const preview = view.dom.querySelector('[data-testid="link-preview"]');
    expect(preview?.textContent).toContain("Visible heading");
    expect(preview?.textContent).not.toContain("Hidden metadata");
    expect(preview?.textContent).not.toContain("Nested body must stay hidden");
    expect(preview?.querySelector(".cm-skr-embed-header")).not.toBeNull();
    expect(
      preview?.querySelector(".cm-skr-embed .cm-skr-embed-body"),
    ).toBeNull();
  });

  it("opens a focused Markdown note link with P and Escape cancels pending or visible previews", async () => {
    vi.useFakeTimers();
    const context: WikilinkResolutionContext = {
      paths: ["Root.md", "Other.md"],
      config: {
        newLinkFormat: "shortest",
        useMarkdownLinks: true,
        attachmentFolderPath: "attachments",
      },
      currentPath: "Root.md",
      linkPreviews: true,
      loadNote: async () => "# Other\n\nPreview body",
    };
    const view = mountedView("See [Other](Other.md).", undefined, context);
    const link = view.dom.querySelector<HTMLElement>(
      '[data-preview-target="Other.md"]',
    );
    expect(link?.getAttribute("role")).toBe("link");
    link?.focus();
    expect(view.dom.querySelector('[data-testid="link-preview"]')).toBeNull();
    link?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    link?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(450);
    expect(view.dom.querySelector('[data-testid="link-preview"]')).toBeNull();

    link?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "p", bubbles: true }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(
      view.dom.querySelector('[data-testid="link-preview"]'),
    ).not.toBeNull();
    link?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(view.dom.querySelector('[data-testid="link-preview"]')).toBeNull();
  });

  it("removes preview affordances and closes the panel when disabled", async () => {
    const enabled: WikilinkResolutionContext = {
      paths: ["Root.md", "Other.md"],
      config: {
        newLinkFormat: "shortest",
        useMarkdownLinks: false,
        attachmentFolderPath: "attachments",
      },
      currentPath: "Root.md",
      linkPreviews: true,
      loadNote: async () => "# Other\n\nPreview body",
    };
    const view = mountedView("See [[Other]].", undefined, enabled);
    const link = view.dom.querySelector<HTMLElement>(
      '[data-preview-target="Other"]',
    );
    link?.focus();
    link?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "p", bubbles: true }),
    );
    await Promise.resolve();
    expect(
      view.dom.querySelector('[data-testid="link-preview"]'),
    ).not.toBeNull();

    dispatchWikilinkContext(view, { ...enabled, linkPreviews: false });
    expect(view.dom.querySelector('[data-testid="link-preview"]')).toBeNull();
    expect(view.dom.querySelector("[data-preview-target]")).toBeNull();
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
    expect(getComputedStyle(receded as HTMLElement).opacity).toBe("1");
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
    expect(titleLine?.textContent).toContain("Need help");
    expect(titleLine?.textContent).not.toContain("[!faq]");
    expect(view.dom.querySelector(".cm-skr-strong")?.textContent).toContain(
      "Rendered answer",
    );

    view.dispatch({ selection: { anchor: source.indexOf("Rendered answer") } });
    const revealedLine = view.dom.querySelector<HTMLElement>(
      '.cm-line.cm-skr-rich-callout[data-revealed="true"]',
    );
    expect(revealedLine).not.toBeNull();
    expect(revealedLine?.getAttribute("data-accent")).toBe("yellow");
    expect(view.dom.querySelector(".cm-skr-callout-icon-host")).toBeNull();
    expect(view.dom.querySelector(".cm-skr-strong")).toBeNull();
    expect(view.contentDOM.textContent).toContain(
      "> [!faq]- Need help> **Rendered answer**> - first",
    );

    view.dispatch({ selection: { anchor: source.indexOf("outside") } });
    expect(view.dom.querySelector(".cm-skr-rich-callout")).not.toBeNull();
    expect(view.dom.querySelector(".cm-skr-strong")).not.toBeNull();
  });

  it("keeps the callout accent colour while its source is revealed", () => {
    const source = "> [!tip] Typed identity\n> Source body\n\noutside";
    const view = mountedView(source);
    const rendered = view.dom.querySelector<HTMLElement>(
      '.cm-line.cm-skr-rich-callout[data-accent="cyan"]',
    );
    expect(rendered).not.toBeNull();
    const renderedAccent = getComputedStyle(
      rendered as HTMLElement,
    ).getPropertyValue("--skr-callout-color");

    view.dispatch({ selection: { anchor: source.indexOf("Source body") } });
    const revealed = view.dom.querySelector<HTMLElement>(
      '.cm-line.cm-skr-rich-callout[data-revealed="true"]',
    );
    expect(revealed).not.toBeNull();
    expect(revealed?.getAttribute("data-accent")).toBe("cyan");
    expect(
      getComputedStyle(revealed as HTMLElement).getPropertyValue(
        "--skr-callout-color",
      ),
    ).toBe(renderedAccent);
  });

  it("moves the cursor into and out of callout source by keyboard", () => {
    const source = "before\n> [!tip] Typed identity\n> Source body\n\nafter";
    const calloutFrom = source.indexOf("> [!tip]");
    const calloutTo = source.indexOf("\nafter");
    const view = mountedView(source, calloutFrom - 1);

    expect(cursorCharForward(view)).toBe(true);
    expect(view.state.selection.main.head).toBeGreaterThanOrEqual(calloutFrom);
    expect(view.state.selection.main.head).toBeLessThanOrEqual(calloutTo);
    expect(
      view.dom.querySelector(
        '.cm-line.cm-skr-rich-callout[data-revealed="true"]',
      ),
    ).not.toBeNull();

    let movements = 0;
    while (
      view.dom.querySelector(
        '.cm-line.cm-skr-rich-callout[data-revealed="true"]',
      ) !== null &&
      movements < 100
    ) {
      expect(cursorCharForward(view)).toBe(true);
      movements += 1;
    }
    expect(movements).toBeLessThan(100);
    expect(view.state.selection.main.head).toBeGreaterThanOrEqual(calloutTo);
    expect(
      view.dom.querySelector(
        '.cm-line.cm-skr-rich-callout[data-revealed="true"]',
      ),
    ).toBeNull();
    expect(view.dom.querySelector(".cm-skr-rich-callout")).not.toBeNull();
  });
});
