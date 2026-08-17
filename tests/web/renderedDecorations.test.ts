import { cursorCharForward, deleteCharBackward } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pointInMenuCone } from "../../src/lib/anchoredMenu";
import { changedTextSpan } from "../../src/lib/editor/byteChangeSet";
import {
  closeRenderedTableSource,
  decorationEngine,
  dispatchWikilinkContext,
  editRenderedTableSource,
  explicitTableSource,
  focusedRenderedTableCell,
  focusRenderedTableCell,
  sourceRevealFocusMode,
  taskStatusConfiguration,
  tokenHighlightStyle,
} from "../../src/lib/editor/decorations/engine";
import type { WikilinkResolutionContext } from "../../src/lib/editor/decorations/wikilinks";
import { codeLanguage } from "../../src/lib/editor/markdown/codeLanguages";
import { obsidianMarkdownExtensionsFor } from "../../src/lib/editor/markdown/obsidian";
import { createAppRegistry } from "../../src/lib/features";
import { TASK_STATUS_MENU_COMMAND } from "../../src/lib/features/taskCommands";
import { hoverIntentDelay } from "../../src/lib/motion";
import {
  type CommandContext,
  editorKeymap,
  globalKeydownHandler,
} from "../../src/lib/registry";
import {
  DEFAULT_TASK_STATUSES,
  type TaskStatus,
} from "../../src/lib/taskStatuses";

const views: EditorView[] = [];
const cleanups: (() => void)[] = [];

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

/**
 * Summons a task menu the way a pointer does: rest on the checkbox itself,
 * then wait out the shared intent delay before the surface appears.
 */
async function hoverTaskCheckbox(control: HTMLElement | null): Promise<void> {
  control
    ?.querySelector<HTMLElement>(".cm-skr-task-checkbox")
    ?.dispatchEvent(new Event("pointerenter"));
  await new Promise((resolve) =>
    setTimeout(resolve, hoverIntentDelay(document.documentElement) + 20),
  );
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
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

  it("groups the default menu into at most ten selectable rows", async () => {
    const view = mountedView("- [ ] task");
    const control = view.dom.querySelector<HTMLElement>(".cm-skr-task-control");
    await hoverTaskCheckbox(control);
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

  it("writes a menu date as plain text and renders its token as a chip", async () => {
    const view = mountedView("- [ ] task");
    const control = view.dom.querySelector<HTMLElement>(".cm-skr-task-control");
    await hoverTaskCheckbox(control);
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

  it("renders and cycles a custom status while leaving unknown markers alone", async () => {
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
    await hoverTaskCheckbox(updatedControl);
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
    await hoverTaskCheckbox(control);
    expect(listbox?.hidden).toBe(false);
    expect(listbox?.querySelectorAll('[role="option"]')).toHaveLength(10);

    control
      ?.querySelector<HTMLElement>(".cm-skr-task-checkbox")
      ?.dispatchEvent(new Event("pointerleave"));
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

  // A rendered cell's editable surface is nested inside the note's. Every
  // caret key the cell declines is resolved by the engine against the host
  // document, which walks its own line boxes: `End` stops at a wrap point
  // in a cell wide enough to wrap, and `Control-End` leaves the cell for
  // the end of the note while the cell still holds the editing session,
  // so the next thing typed lands outside the table. Engines disagree on
  // all of it, so the cell has to claim these keys and answer them
  // against its own bounds. Claiming is the property under test: an
  // unclaimed key is one the engine decides.
  describe("rendered cell caret keys", () => {
    const source = "| ab | b |\n| --- | --- |\n| cdef | d |";
    const pressInCell = (view: EditorView, key: string, init = {}) => {
      const nested = view.dom.querySelector<HTMLElement>(
        '.cm-skr-table-cell[data-editing="true"] .cm-editor',
      );
      const nestedView =
        nested === null ? null : EditorView.findFromDOM(nested);
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      nestedView?.contentDOM.dispatchEvent(event);
      return { nestedView, claimed: event.defaultPrevented };
    };

    for (const [key, offset] of [
      ["Home", 0],
      ["End", 4],
      ["PageUp", 0],
      ["PageDown", 4],
    ] as const) {
      it(`answers ${key} against the cell's own bounds`, () => {
        const view = mountedView(source, 0);
        expect(focusRenderedTableCell(view, 0, 1, 0, 2)).toBe(true);
        const { nestedView, claimed } = pressInCell(view, key);
        expect(claimed).toBe(true);
        expect(nestedView?.state.doc.toString()).toBe("cdef");
        expect(nestedView?.state.selection.main.head).toBe(offset);
        expect(view.state.doc.toString()).toBe(source);
      });
    }

    it("keeps a document-edge key inside the cell", () => {
      const view = mountedView(source, 0);
      expect(focusRenderedTableCell(view, 0, 1, 0, 2)).toBe(true);
      const { nestedView, claimed } = pressInCell(view, "End", {
        ctrlKey: true,
      });
      expect(claimed).toBe(true);
      expect(nestedView?.state.selection.main.head).toBe(4);
      expect(focusedRenderedTableCell(view)).toMatchObject({
        row: 1,
        column: 0,
        head: 4,
      });
      expect(view.state.doc.toString()).toBe(source);
    });

    it("extends the cell selection when shift holds", () => {
      const view = mountedView(source, 0);
      expect(focusRenderedTableCell(view, 0, 1, 0, 1)).toBe(true);
      const { nestedView, claimed } = pressInCell(view, "End", {
        shiftKey: true,
      });
      expect(claimed).toBe(true);
      expect(nestedView?.state.selection.main.anchor).toBe(1);
      expect(nestedView?.state.selection.main.head).toBe(4);
      expect(view.dom.querySelector(".cm-skr-table-selected")).toBeNull();
    });
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

  it("holds embed skeleton geometry through the content replacement frame", async () => {
    vi.useFakeTimers();
    let resolveNote: ((source: string) => void) | undefined;
    const loaded = new Promise<string>((resolve) => {
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
      embedAncestry: ["Root.md"],
      embedDepth: 0,
      loadNote: () => loaded,
    };
    const view = mountedView("![[Other]]\n\noutside", undefined, context);
    await vi.advanceTimersByTimeAsync(150);
    const loading = view.dom.querySelector<HTMLElement>(
      '.skr-loading-embed[data-loading-state="skeleton"]',
    );
    expect(loading).not.toBeNull();
    if (loading === null) return;
    vi.spyOn(loading, "getBoundingClientRect").mockReturnValue({
      width: 320,
      height: 72,
      top: 0,
      right: 320,
      bottom: 72,
      left: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);

    resolveNote?.("**Resolved content**");
    await vi.advanceTimersByTimeAsync(0);
    expect(loading.style.minHeight).toBe("72px");

    await vi.advanceTimersByTimeAsync(20);
    expect(loading.style.minHeight).toBe("");
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
      pointInMenuCone(
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

  it("loads each preview target once while the pointer moves", () => {
    vi.useFakeTimers();
    const loadNote = vi.fn(async (path: string) => `# ${path}`);
    const context: WikilinkResolutionContext = {
      paths: ["Root.md", "First.md", "Second.md"],
      config: {
        newLinkFormat: "shortest",
        useMarkdownLinks: false,
        attachmentFolderPath: null,
      },
      currentPath: "Root.md",
      linkPreviews: true,
      loadNote,
    };
    const view = mountedView("[[First]] [[Second]]", undefined, context);
    const [first, second] = [
      ...view.dom.querySelectorAll<HTMLElement>("[data-preview-target]"),
    ];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    first.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    for (let movement = 0; movement < 100; movement += 1) {
      first.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    }
    expect(loadNote).toHaveBeenCalledTimes(1);
    expect(loadNote).toHaveBeenLastCalledWith("First.md");

    second.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    expect(loadNote).toHaveBeenCalledTimes(2);
    expect(loadNote).toHaveBeenLastCalledWith("Second.md");
  });

  it("keeps an obsolete preview resolution out of the active panel", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((source: string) => void) | undefined;
    let resolveSecond: ((source: string) => void) | undefined;
    const context: WikilinkResolutionContext = {
      paths: ["Root.md", "First.md", "Second.md"],
      config: {
        newLinkFormat: "shortest",
        useMarkdownLinks: false,
        attachmentFolderPath: null,
      },
      currentPath: "Root.md",
      linkPreviews: true,
      loadNote: (path) =>
        new Promise<string>((resolve) => {
          if (path === "First.md") {
            resolveFirst = resolve;
          } else {
            resolveSecond = resolve;
          }
        }),
    };
    const view = mountedView("[[First]] [[Second]]", undefined, context);
    const [first, second] = [
      ...view.dom.querySelectorAll<HTMLElement>("[data-preview-target]"),
    ];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    first.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(450);
    second.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(450);

    const preview = view.dom.querySelector<HTMLElement>(
      '[data-testid="link-preview"]',
    );
    expect(preview?.textContent).toContain("Second.md");
    resolveFirst?.("# First result");
    await vi.advanceTimersByTimeAsync(0);
    expect(preview?.textContent).not.toContain("First result");

    resolveSecond?.("# Second result");
    await vi.advanceTimersByTimeAsync(0);
    expect(preview?.textContent).toContain("Second result");
    expect(preview?.textContent).not.toContain("First result");
  });

  it("repositions a preview after async content grows below its link", async () => {
    vi.useFakeTimers();
    const originalHeight = window.innerHeight;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 300,
    });
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
    expect(link).not.toBeNull();
    if (link === null) return;
    vi.spyOn(link, "getBoundingClientRect").mockReturnValue({
      width: 100,
      height: 20,
      top: 140,
      right: 200,
      bottom: 160,
      left: 100,
      x: 100,
      y: 140,
      toJSON: () => ({}),
    } as DOMRect);
    const panelRect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement): DOMRect {
        if (this.dataset.testid === "link-preview") {
          const expanded = this.querySelector(".cm-content") !== null;
          const height = expanded ? 180 : 80;
          return {
            width: 240,
            height,
            top: 0,
            right: 240,
            bottom: height,
            left: 0,
            x: 0,
            y: 0,
            toJSON: () => ({}),
          } as DOMRect;
        }
        return {
          width: 0,
          height: 0,
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      });
    try {
      link.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(450);
      const preview = view.dom.querySelector<HTMLElement>(
        '[data-testid="link-preview"]',
      );
      expect(preview?.style.top).toBe("168px");

      resolveNote?.("**Expanded preview**");
      await vi.advanceTimersByTimeAsync(20);
      expect(preview?.style.top).toBe("12px");
      expect(preview?.dataset.motionSurface).toBe("anchored-bottom");
    } finally {
      panelRect.mockRestore();
      Object.defineProperty(window, "innerHeight", {
        configurable: true,
        value: originalHeight,
      });
    }
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

// The reveal audit: one row per construct the engine hides or renders, each
// asserting the node the motion driver animates actually exists when the
// caret is inside it. A construct missing from this table is a construct that
// pops into place with no motion at all, which is what this replaced.
describe("reveal motion coverage", () => {
  const revealCases: {
    construct: string;
    doc: string;
    /** A caret offset inside the construct. */
    cursor: number;
    /** Marker glyphs expected to carry the animated marker class. */
    markers?: string[];
    /** Whether the construct's source form carries the swap class. */
    source?: boolean;
  }[] = [
    {
      construct: "ATX heading mark",
      doc: "# Heading",
      cursor: 5,
      markers: ["# "],
    },
    {
      construct: "emphasis",
      doc: "a *word* b",
      cursor: 5,
      markers: ["*", "*"],
    },
    {
      construct: "strong emphasis",
      doc: "a **word** b",
      cursor: 6,
      markers: ["**", "**"],
    },
    {
      construct: "strikethrough",
      doc: "a ~~word~~ b",
      cursor: 6,
      markers: ["~~", "~~"],
    },
    {
      construct: "inline code",
      doc: "a `code` b",
      cursor: 5,
      markers: ["`", "`"],
    },
    {
      construct: "link",
      doc: "a [label](https://example.com) b",
      cursor: 5,
      markers: ["[", "]", "(", "https://example.com", ")"],
      source: true,
    },
    {
      construct: "image",
      doc: "a ![alt](picture.png) b",
      cursor: 6,
      markers: ["![", "]", "(", "picture.png", ")"],
      source: true,
    },
    {
      construct: "wikilink",
      doc: "a [[Target]] b",
      cursor: 6,
      markers: ["[[", "]]"],
      source: true,
    },
    {
      construct: "aliased wikilink",
      doc: "a [[Target|Alias]] b",
      cursor: 14,
      markers: ["[[", "Target", "|", "]]"],
      source: true,
    },
    { construct: "task marker", doc: "- [ ] task", cursor: 3, source: true },
    { construct: "inline math", doc: "a $x^2$ b", cursor: 4, source: true },
    {
      construct: "code fence marks",
      doc: "```js\nx\n```\n",
      cursor: 4,
      source: true,
    },
    {
      construct: "frontmatter",
      doc: "---\nkey: value\n---\n\nbody\n",
      cursor: 6,
      source: true,
    },
    { construct: "callout", doc: "> [!note] Body\n", cursor: 4, source: true },
  ];

  for (const testCase of revealCases) {
    it(`animates the revealed ${testCase.construct}`, async () => {
      const view = mountedView(testCase.doc, testCase.cursor);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const markers = [
        ...view.dom.querySelectorAll(".cm-skr-reveal-marker-active"),
      ].map((element) => element.textContent);
      if (testCase.markers !== undefined) {
        expect(markers).toEqual(testCase.markers);
      }
      if (testCase.source === true) {
        expect(
          view.dom.querySelectorAll(".cm-skr-reveal-source").length,
        ).toBeGreaterThan(0);
      }
      // Whatever the construct, something the driver can animate exists.
      expect(
        markers.length +
          view.dom.querySelectorAll(".cm-skr-reveal-source").length,
      ).toBeGreaterThan(0);
    });
  }

  it("keeps the rendered form of every revealable construct animatable", async () => {
    const view = mountedView(
      "# Heading\n\na [label](https://example.com) and [[Target]] and `code`\n\n- [ ] task with $x^2$\n\n> [!note] callout\n",
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The caret sits on the heading, so every other construct is rendered and
    // carries the class the driver animates when the caret leaves it.
    expect(
      view.dom.querySelectorAll(".cm-skr-reveal-rendered").length,
    ).toBeGreaterThan(3);
  });

  it("hides a marker with no reserved width and reveals it at its natural width", async () => {
    const hidden = mountedView("## Heading\n\nbody", 12);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const hiddenMarker = hidden.dom.querySelector(".cm-skr-reveal-marker");
    expect(
      hiddenMarker?.classList.contains("cm-skr-reveal-marker-active"),
    ).toBe(false);

    const revealed = mountedView("## Heading\n\nbody", 4);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const revealedMarker = revealed.dom.querySelector(
      ".cm-skr-reveal-marker-active",
    );
    expect(revealedMarker?.textContent).toBe("## ");
  });
});

// The hover contract on the task status control: a menu that appears on a
// pass of the pointer, or dies in the gap between the checkbox and itself,
// is a menu the reader has to race.
describe("task status menu hover intent", () => {
  function parts(view: EditorView): {
    checkbox: HTMLElement;
    palette: HTMLElement;
  } {
    const checkbox = view.dom.querySelector<HTMLElement>(
      ".cm-skr-task-checkbox",
    );
    const palette = view.dom.querySelector<HTMLElement>('[role="listbox"]');
    if (checkbox === null || palette === null) {
      throw new Error("task control did not render");
    }
    return { checkbox, palette };
  }

  it("waits out the shared pointer-rest delay before it appears", async () => {
    const view = mountedView("- [ ] task\n\noutside");
    const { checkbox, palette } = parts(view);
    const delay = hoverIntentDelay(document.documentElement);
    expect(delay).toBe(450);

    checkbox.dispatchEvent(new Event("pointerenter"));
    await new Promise((resolve) => setTimeout(resolve, delay - 100));
    expect(palette.hidden).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(palette.hidden).toBe(false);
  });

  it("shows nothing for a pointer that only passes across the checkbox", async () => {
    const view = mountedView("- [ ] task\n\noutside");
    const { checkbox, palette } = parts(view);
    checkbox.dispatchEvent(new Event("pointerenter"));
    await new Promise((resolve) => setTimeout(resolve, 120));
    checkbox.dispatchEvent(new Event("pointerleave"));
    await new Promise((resolve) =>
      setTimeout(resolve, hoverIntentDelay(document.documentElement) + 80),
    );
    expect(palette.hidden).toBe(true);
  });

  it("survives the travel from the checkbox into the menu", async () => {
    const view = mountedView("- [ ] task\n\noutside");
    const { checkbox, palette } = parts(view);
    await hoverTaskCheckbox(
      view.dom.querySelector<HTMLElement>(".cm-skr-task-control"),
    );
    expect(palette.hidden).toBe(false);

    palette.getBoundingClientRect = () =>
      ({ left: 100, right: 300, top: 80, bottom: 200 }) as DOMRect;
    checkbox.dispatchEvent(
      Object.assign(new Event("pointerleave"), { clientX: 50, clientY: 50 }),
    );
    // Two hundred milliseconds of travel inside the corridor: far past the
    // instant close this replaced, and each move renews the corridor.
    for (const step of [
      { x: 60, y: 60 },
      { x: 75, y: 70 },
      { x: 90, y: 78 },
    ]) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      document.dispatchEvent(
        Object.assign(new Event("pointermove"), {
          clientX: step.x,
          clientY: step.y,
        }),
      );
      expect(palette.hidden).toBe(false);
    }

    // A pointer that leaves the corridor closes it on the leave grace.
    document.dispatchEvent(
      Object.assign(new Event("pointermove"), { clientX: 20, clientY: 400 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(palette.hidden).toBe(true);
  });

  it("dismisses a hover-opened menu when the window loses focus", async () => {
    const view = mountedView("- [ ] task\n\noutside");
    const { palette } = parts(view);
    await hoverTaskCheckbox(
      view.dom.querySelector<HTMLElement>(".cm-skr-task-control"),
    );
    expect(palette.hidden).toBe(false);
    window.dispatchEvent(new Event("blur"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(palette.hidden).toBe(true);
  });

  it("returns focus to the checkbox when Tab leaves the menu", async () => {
    const view = mountedView("- [ ] task\n\noutside");
    const { checkbox, palette } = parts(view);
    checkbox.focus();
    checkbox.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await Promise.resolve();
    expect(document.activeElement).toBe(palette);
    palette.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true }),
    );
    expect(palette.hidden).toBe(true);
    expect(document.activeElement).toBe(checkbox);
  });
});

// A rendered cell is a field whose editable surface is nested inside the
// note's own. Every key that reaches it therefore has to be decided: acted
// on within the cell, left to the browser to run against the cell it is
// focused in, handed to the note by name, or refused. A key decided by
// nobody is decided by the browser against the note's editable surface, and
// each round of that has cost the note text. The enumeration below is the
// contract in `docs/decoration-rules.md`, driven key by key.
describe("the rendered table cell key contract", () => {
  const source =
    "# Heading\n\n| a1 | b1 | c1 |\n| --- | --- | --- |\n| a2 | b2 | c2 |\n| a3 | b3 | c3 |\n\nprose after the table\n\n#tag\n";
  const tableFrom = source.indexOf("| a1");

  const PRINTABLE = ["a", "Z", "1", "!", " ", "é", "-", "|"];
  const NAVIGATION = [
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Tab",
    "Enter",
  ];
  const EDITING = ["Backspace", "Delete", "Insert"];
  const OTHER = [
    "F1",
    "F5",
    "F12",
    "CapsLock",
    "ContextMenu",
    "PrintScreen",
    "ScrollLock",
    "Pause",
    "NumLock",
    "Clear",
    "Help",
    "Escape",
  ];
  const KEYS = [...PRINTABLE, ...NAVIGATION, ...EDITING, ...OTHER];
  const MODIFIERS: { name: string; init: KeyboardEventInit }[] = [
    { name: "", init: {} },
    { name: "Control+", init: { ctrlKey: true } },
    { name: "Alt+", init: { altKey: true } },
    { name: "Shift+", init: { shiftKey: true } },
    { name: "Meta+", init: { metaKey: true } },
    { name: "Control+Shift+", init: { ctrlKey: true, shiftKey: true } },
    { name: "Control+Alt+", init: { ctrlKey: true, altKey: true } },
    { name: "Alt+Shift+", init: { altKey: true, shiftKey: true } },
    { name: "Meta+Shift+", init: { metaKey: true, shiftKey: true } },
    {
      name: "Control+Alt+Shift+",
      init: { ctrlKey: true, altKey: true, shiftKey: true },
    },
  ];

  /**
   * The browser's default is allowed to run for these, because its target
   * is the element with focus and that element is the cell. Restated from
   * the contract, not read from the engine.
   */
  function leftToTheBrowser(key: string, init: KeyboardEventInit): boolean {
    const primary = init.ctrlKey === true || init.metaKey === true;
    if (key.length === 1) {
      return !primary;
    }
    if (key === "Backspace" || key === "Delete") {
      return true;
    }
    if (primary && init.altKey !== true) {
      return ["c", "x", "v", "insert"].includes(key.toLowerCase());
    }
    return init.shiftKey === true && key === "Insert";
  }

  /** Keys that take focus out of the table, by the contract's own list. */
  function leavesTheTable(key: string): boolean {
    return key === "Escape";
  }

  function activeCellEditor(view: EditorView): EditorView | null {
    const editor = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"] .cm-editor',
    );
    return editor === null ? null : EditorView.findFromDOM(editor);
  }

  it.each(
    MODIFIERS.flatMap((modifier) =>
      KEYS.map(
        (key) => [`${modifier.name}${key}`, key, modifier.init] as const,
      ),
    ),
  )("answers %s without touching the note", (_name, key, init) => {
    const view = mountedView(source, 0);
    // The middle cell of the middle row: no edge behaviour, so no key in
    // this sweep has any business changing the note's text.
    expect(focusRenderedTableCell(view, tableFrom, 1, 1, 1)).toBe(true);
    const before = view.state.doc.toString();
    const nested = activeCellEditor(view);
    expect(nested).not.toBeNull();

    const event = new KeyboardEvent("keydown", {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    nested?.contentDOM.dispatchEvent(event);

    expect(view.state.doc.toString(), "the note's text").toBe(before);
    if (leftToTheBrowser(key, init)) {
      // Not consumed, so the browser acts — on the cell, which still holds
      // focus, and not on the note's editable surface around it.
      expect(event.defaultPrevented, "left to the browser").toBe(false);
    } else {
      expect(event.defaultPrevented, "refused or answered").toBe(true);
    }
    const active = document.activeElement;
    const caret = view.state.selection.main;
    if (leavesTheTable(key)) {
      // The one deliberate exit: focus is the note's, and its caret is at a
      // position outside the table rather than parked inside it.
      expect(active?.closest(".cm-skr-table-cell")).toBeNull();
      expect(active).toBe(view.contentDOM);
      expect(caret.empty).toBe(true);
      expect(caret.head).toBeGreaterThan(source.indexOf("| a3 | b3 | c3 |"));
    } else {
      expect(
        active?.closest(".cm-skr-table-cell"),
        "focus stayed in a cell",
      ).not.toBeNull();
      // The note's caret stays parked at the table, which is the only
      // position it may hold while a cell is being edited.
      expect(caret.empty).toBe(true);
      expect(caret.head, "the note's caret").toBe(tableFrom);
    }
  });

  it("selects the cell's own text on the select-all chord", () => {
    const view = mountedView(source, 0);
    expect(focusRenderedTableCell(view, tableFrom, 1, 1, 1)).toBe(true);
    const nested = activeCellEditor(view);
    const before = view.state.doc.toString();
    nested?.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "a",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(nested?.state.selection.main.from).toBe(0);
    expect(nested?.state.selection.main.to).toBe(nested?.state.doc.length);
    expect(view.state.doc.toString()).toBe(before);
    expect(document.activeElement).toBe(nested?.contentDOM);
  });

  // The ring says "your keystrokes go here". The editing session outlives a
  // focus move it did not ask for, so a ring drawn from the session alone
  // points at a cell the caret has already left. jsdom performs no cascade,
  // so the assertion is on the selector state the ring is painted from,
  // evaluated by the DOM rather than by the engine.
  it("carries the focus ring's selector state only while focus is in the cell", () => {
    const view = mountedView(source, 0);
    expect(focusRenderedTableCell(view, tableFrom, 1, 1, 1)).toBe(true);
    const cell = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"]',
    );
    expect(cell).not.toBeNull();
    const ringed = () =>
      cell?.matches('.cm-skr-table-cell[data-editing="true"]:focus-within') ===
      true;
    expect(document.activeElement?.closest(".cm-skr-table-cell")).toBe(cell);
    expect(ringed()).toBe(true);

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement?.closest(".cm-skr-table-cell")).not.toBe(
      cell,
    );
    // The session is still on this cell; the ring is not.
    expect(cell?.dataset.editing).toBe("true");
    expect(ringed()).toBe(false);
  });
});

// Saving is an act on the whole note, so it has to work from wherever the
// person's attention is. A rendered cell's editable surface is a nested one
// the note's editor does not answer for, so a chord the note claims only
// while its own surface holds focus is a chord that silently does nothing
// while a cell is being edited.
describe("the note's own chords from a rendered cell", () => {
  const source = "# Heading\n\n| a1 | b1 |\n| --- | --- |\n| a2 | b2 |\n";
  const tableFrom = source.indexOf("| a1");

  function harness(): { view: EditorView; saves: number[] } {
    const saves: number[] = [];
    const registry = createAppRegistry();
    const context = (view: EditorView): CommandContext => ({
      view,
      openNote: () => Promise.resolve(),
      openView: () => {},
      openCommandSurface: () => {},
      toggleView: () => {},
      closeSurfaces: () => {},
      requestSave: () => {
        saves.push(saves.length + 1);
      },
      notePaths: () => [],
      recentNotePaths: () => [],
      navigateBack: () => false,
      navigateForward: () => false,
      followLink: () => false,
    });
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
          editorKeymap(registry, () => context(view)),
        ],
      }),
      parent: document.body,
    });
    views.push(view);
    if (!forceParsing(view, view.state.doc.length, 5_000)) {
      throw new Error("fixture syntax tree did not finish parsing");
    }
    view.dispatch({ selection: { anchor: 0 } });
    const onKeydown = globalKeydownHandler(registry, () => context(view));
    window.addEventListener("keydown", onKeydown);
    cleanups.push(() => window.removeEventListener("keydown", onKeydown));
    return { view, saves };
  }

  it("saves the note while a cell holds the caret", () => {
    const { view, saves } = harness();
    expect(focusRenderedTableCell(view, tableFrom, 1, 0, "end")).toBe(true);
    const editor = view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"] .cm-editor',
    );
    const nested = editor === null ? null : EditorView.findFromDOM(editor);
    expect(document.activeElement).toBe(nested?.contentDOM);

    nested?.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );

    expect(saves).toHaveLength(1);
    // The cell keeps the caret, and the note is untouched by the chord.
    expect(document.activeElement).toBe(nested?.contentDOM);
    expect(view.state.doc.toString()).toBe(source);
  });

  it("saves the note from the note's own surface too", () => {
    const { view, saves } = harness();
    view.focus();
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(saves).toHaveLength(1);
  });
});

// A structure command changes the table under the person editing it, so it
// has to hand them back a place to keep typing. The note's own caret is
// parked at the table's start while a cell is being edited, and that is not
// a position the note's caret can be used from: it draws as a bar down the
// whole table and the next character lands outside it. Each command is
// asserted on where the caret ends and on where the next character goes.
describe("table structure commands", () => {
  const source =
    "# Heading\n\n| a1 | b1 |\n| --- | --- |\n| a2 | b2 |\n| a3 | b3 |\n\nprose\n";
  const tableFrom = source.indexOf("| a1");

  function harness(): { view: EditorView; run: (id: string) => boolean } {
    const registry = createAppRegistry();
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
        ],
      }),
      parent: document.body,
    });
    views.push(view);
    if (!forceParsing(view, view.state.doc.length, 5_000)) {
      throw new Error("fixture syntax tree did not finish parsing");
    }
    view.dispatch({ selection: { anchor: 0 } });
    return {
      view,
      run: (id: string) =>
        registry.run(id, {
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
        }),
    };
  }

  const activeCell = (view: EditorView) =>
    view.dom.querySelector<HTMLElement>(
      '.cm-skr-table-cell[data-editing="true"]',
    );

  const nestedOf = (cell: HTMLElement | null) => {
    const editor = cell?.querySelector<HTMLElement>(".cm-editor") ?? null;
    return editor === null ? null : EditorView.findFromDOM(editor);
  };

  // The cell each command hands back: the same column of the row or column
  // it just made, or the cell that took the place of what it removed. The
  // column carries over because filling a table by keyboard walks down one
  // column at a time, which `Enter` on the last row relies on.
  for (const [id, table, landing] of [
    [
      "table.row.insert-above",
      "| a1 | b1 |\n| --- | --- |\n| | |\n| a2 | b2 |\n| a3 | b3 |",
      { row: 1, column: 1 },
    ],
    [
      "table.row.insert-below",
      "| a1 | b1 |\n| --- | --- |\n| a2 | b2 |\n| | |\n| a3 | b3 |",
      { row: 2, column: 1 },
    ],
    [
      "table.column.insert-before",
      "| a1 | | b1 |\n| --- | --- | --- |\n| a2 | | b2 |\n| a3 | | b3 |",
      { row: 1, column: 1 },
    ],
    [
      "table.column.insert-after",
      "| a1 | b1 | |\n| --- | --- | --- |\n| a2 | b2 | |\n| a3 | b3 | |",
      { row: 1, column: 2 },
    ],
    [
      "table.row.delete",
      "| a1 | b1 |\n| --- | --- |\n| a3 | b3 |",
      { row: 1, column: 1 },
    ],
    [
      "table.column.delete",
      "| a1 |\n| --- |\n| a2 |\n| a3 |",
      { row: 1, column: 0 },
    ],
  ] as const) {
    it(`${id} keeps the caret in the table it changed`, {
      timeout: 30000,
    }, async () => {
      const { view, run } = harness();
      // The second column of the first body row, so the cell a command
      // hands back is never the one that happened to be focused.
      expect(focusRenderedTableCell(view, tableFrom, 1, 1, "end")).toBe(true);
      expect(run(id)).toBe(true);
      await Promise.resolve();
      await Promise.resolve();

      expect(view.state.doc.toString()).toBe(
        source.replace(
          "| a1 | b1 |\n| --- | --- |\n| a2 | b2 |\n| a3 | b3 |",
          table,
        ),
      );
      const cell = activeCell(view);
      expect(cell, "a cell holds the editing session").not.toBeNull();
      expect(document.activeElement?.closest(".cm-skr-table-cell")).toBe(cell);
      expect({
        row: Number(cell?.dataset.row),
        column: Number(cell?.dataset.column),
      }).toEqual(landing);

      // The next character goes into that cell, not into the note.
      const nested = nestedOf(cell);
      nested?.dispatch({
        changes: { from: 0, to: nested.state.doc.length, insert: "F" },
      });
      await Promise.resolve();
      const row = view.state.doc
        .toString()
        .split("\n")
        .find((line) => line.includes("F"));
      expect(row, "the typed character landed in a table row").toMatch(
        /^\|.*\|$/u,
      );
    });
  }

  it("hands focus back to the cell when the note takes it without asking", {
    timeout: 30000,
  }, async () => {
    const { view, run } = harness();
    expect(focusRenderedTableCell(view, tableFrom, 1, 0, "end")).toBe(true);
    expect(run("table.row.insert-below")).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    const cell = activeCell(view);
    expect(document.activeElement?.closest(".cm-skr-table-cell")).toBe(cell);

    // A surface closing behind the command restores focus to the note. Its
    // caret is parked inside the rendered table, so the focus belongs to the
    // cell that holds the session.
    view.focus();
    view.contentDOM.dispatchEvent(new FocusEvent("focus"));
    await Promise.resolve();
    await Promise.resolve();
    expect(
      document.activeElement?.closest(".cm-skr-table-cell"),
    ).not.toBeNull();
  });
});
