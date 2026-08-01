// The decoration engine interprets the mapping table in `table.ts` over
// the Lezer syntax tree, windowed to the visible ranges. Bulk input remaps
// existing decorations for the initial paint and rebuilds them after three
// animation frames. Decoration lifecycle dispatches never touch the document
// and carry `decorationOrigin`; explicit controls such as task checkboxes
// dispatch user edits through the editor's normal local-change path.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import {
  EditorState,
  type Extension,
  Facet,
  StateEffect,
  StateField,
  type Text,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { tags } from "@lezer/highlight";
import { renderMath } from "../../rendering/math";
import { renderMermaid } from "../../rendering/mermaid";
import { STRINGS } from "../../strings";
import {
  DEFAULT_TASK_STATUSES,
  normalizeTaskStatuses,
  type TaskStatus,
  taskStatusBySymbol,
} from "../../taskStatuses";
import { bulkTextInputAnnotation } from "../bulkInput";
import { decorationOrigin } from "../decorationGuard";
import { codeLanguage } from "../markdown/codeLanguages";
import {
  obsidianMarkdownExtensionsFor,
  skribeumMarkdownParser,
} from "../markdown/obsidian";
import { calloutIconSvg, parseCallout } from "./callouts";
import {
  DECORATION_TABLE,
  type DecorationRule,
  type Presentation,
} from "./table";
import {
  EMPTY_WIKILINK_CONTEXT,
  resolveMarkdownLinkTarget,
  resolveWikilinkTarget,
  type WikilinkResolutionContext,
} from "./wikilinks";

/** Syntax colors shared by editable notes and nested read-only notes. */
export const tokenHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.modifier],
    color: "var(--skr-syntax-keyword)",
  },
  {
    tag: [tags.string, tags.regexp],
    color: "var(--skr-syntax-string)",
  },
  {
    tag: [tags.number, tags.bool, tags.atom],
    color: "var(--skr-syntax-number)",
  },
  {
    tag: [tags.comment, tags.meta],
    color: "var(--skr-syntax-comment)",
  },
  {
    tag: [tags.function(tags.variableName), tags.definition(tags.variableName)],
    color: "var(--skr-syntax-function)",
  },
  {
    tag: [tags.typeName, tags.className, tags.namespace],
    color: "var(--skr-syntax-type)",
  },
  {
    tag: [tags.propertyName, tags.attributeName, tags.tagName],
    color: "var(--skr-syntax-property)",
  },
  {
    tag: [tags.operator, tags.punctuation, tags.bracket],
    color: "var(--skr-syntax-operator)",
  },
]);

/**
 * Long-line safeguard: no decoration is computed for content on a line
 * longer than this many characters, so a pathological line (the 2MB
 * single-line corpus file) stays editable plain text instead of feeding
 * the decorator.
 */
export const LONG_LINE_DECORATION_LIMIT = 10_000;
export const EMBED_DEPTH_LIMIT = 4;
export const LINK_PREVIEW_DELAY = 450;

/**
 * The decoration table as an editor facet. With no provider the committed
 * Tier 1 table applies; providing values replaces it, which is what the
 * data-driven proof test uses to add a rule at runtime.
 */
export const decorationTable = Facet.define<
  readonly DecorationRule[],
  readonly DecorationRule[]
>({
  combine: (values) => (values.length === 0 ? DECORATION_TABLE : values.flat()),
});

const sourceRevealEnabled = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? true,
});

/** Keeps cursor-sensitive source markers hidden on non-editable surfaces. */
export const readOnlyDecorationMode = sourceRevealEnabled.of(false);

/** Ordered task statuses used by parsing, rendering and task commands. */
export const taskStatusConfiguration = Facet.define<
  readonly TaskStatus[],
  readonly TaskStatus[]
>({
  combine: (values) =>
    normalizeTaskStatuses(values.at(-1) ?? DEFAULT_TASK_STATUSES),
});

/** Replaces the wikilink resolution context (vault tree and app.json knobs). */
export const setWikilinkContext =
  StateEffect.define<WikilinkResolutionContext>();

export const wikilinkContext = StateField.define<WikilinkResolutionContext>({
  create: () => EMPTY_WIKILINK_CONTEXT,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setWikilinkContext)) {
        return effect.value;
      }
    }
    return value;
  },
});

/**
 * Dispatches a wikilink context update through the decoration-origin
 * annotation, keeping every engine-caused transaction under the inertness
 * guard.
 */
export function dispatchWikilinkContext(
  view: EditorView,
  context: WikilinkResolutionContext,
): void {
  view.dispatch({
    effects: setWikilinkContext.of(context),
    annotations: decorationOrigin.of(true),
  });
}

let nextTaskPaletteId = 0;

function taskAriaChecked(status: TaskStatus): "true" | "false" | "mixed" {
  if (status.category === "DONE") {
    return "true";
  }
  if (status.category === "TODO") {
    return "false";
  }
  return "mixed";
}

function applyTaskStatus(
  view: EditorView,
  from: number,
  to: number,
  currentSymbol: string,
  symbol: string,
): void {
  if (
    view.state.readOnly ||
    view.state.doc.sliceString(from, to) !== currentSymbol
  ) {
    return;
  }
  view.dispatch({
    changes: { from, to, insert: symbol },
    userEvent: "input.task-status",
  });
}

class TaskCheckboxWidget extends WidgetType {
  constructor(
    readonly status: TaskStatus,
    readonly statuses: readonly TaskStatus[],
    readonly markerFrom: number,
    readonly markerTo: number,
  ) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return (
      other.status.symbol === this.status.symbol &&
      other.markerFrom === this.markerFrom &&
      other.markerTo === this.markerTo &&
      JSON.stringify(other.statuses) === JSON.stringify(this.statuses)
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    nextTaskPaletteId += 1;
    const paletteId = `cm-skr-task-palette-${nextTaskPaletteId}`;
    const host = document.createElement("span");
    host.className = "cm-skr-task-control";
    host.style.setProperty(
      "--skr-task-color",
      `var(${this.status.color_token})`,
    );

    const box = document.createElement("span");
    box.className = "cm-skr-task-checkbox";
    box.tabIndex = 0;
    box.setAttribute("contenteditable", "false");
    box.setAttribute("aria-haspopup", "listbox");
    box.setAttribute("aria-expanded", "false");
    box.setAttribute("aria-controls", paletteId);
    for (const [name, value] of taskCheckboxAttributes(this.status)) {
      box.setAttribute(name, value);
    }

    const glyph = document.createElement("span");
    glyph.className = "cm-skr-task-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = this.status.glyph;
    box.append(glyph);

    const palette = document.createElement("span");
    palette.id = paletteId;
    palette.className = "cm-skr-task-palette";
    palette.setAttribute("role", "listbox");
    palette.setAttribute("aria-label", STRINGS.taskStatusPaletteLabel);
    palette.tabIndex = -1;
    palette.hidden = true;

    let activeIndex = Math.max(
      0,
      this.statuses.findIndex((entry) => entry.symbol === this.status.symbol),
    );
    let options: HTMLElement[] = [];

    const updateActiveOption = () => {
      for (const [index, option] of options.entries()) {
        option.classList.toggle(
          "cm-skr-task-option-active",
          index === activeIndex,
        );
      }
      const active = options[activeIndex];
      if (active !== undefined) {
        palette.setAttribute("aria-activedescendant", active.id);
        active.scrollIntoView?.({ block: "nearest" });
      }
    };
    const buildOptions = () => {
      if (options.length > 0) {
        return;
      }
      options = this.statuses.map((entry, index) => {
        const option = document.createElement("span");
        option.id = `${paletteId}-option-${index}`;
        option.className = "cm-skr-task-option";
        option.setAttribute("role", "option");
        option.setAttribute(
          "aria-selected",
          entry.symbol === this.status.symbol ? "true" : "false",
        );
        option.style.setProperty(
          "--skr-task-option-color",
          `var(${entry.color_token})`,
        );

        const optionGlyph = document.createElement("span");
        optionGlyph.className = "cm-skr-task-option-glyph";
        optionGlyph.setAttribute("aria-hidden", "true");
        optionGlyph.textContent = entry.glyph;
        const optionName = document.createElement("span");
        optionName.className = "cm-skr-task-option-name";
        optionName.textContent = entry.name;
        option.append(optionGlyph, optionName);
        option.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        option.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          applyTaskStatus(
            view,
            this.markerFrom,
            this.markerTo,
            this.status.symbol,
            entry.symbol,
          );
        });
        option.addEventListener("pointerenter", () => {
          activeIndex = index;
          updateActiveOption();
        });
        palette.append(option);
        return option;
      });
    };
    const openPalette = (keyboard: boolean) => {
      buildOptions();
      palette.hidden = false;
      box.setAttribute("aria-expanded", "true");
      updateActiveOption();
      if (keyboard) {
        queueMicrotask(() => palette.focus());
      }
    };
    const closePalette = (returnFocus: boolean) => {
      palette.hidden = true;
      palette.replaceChildren();
      palette.removeAttribute("aria-activedescendant");
      options = [];
      box.setAttribute("aria-expanded", "false");
      if (returnFocus) {
        box.focus();
      }
    };

    box.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      applyTaskStatus(
        view,
        this.markerFrom,
        this.markerTo,
        this.status.symbol,
        this.status.next_status,
      );
    });
    // registry-exempt keydown: ARIA checkbox and listbox internal navigation.
    box.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        openPalette(true);
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        applyTaskStatus(
          view,
          this.markerFrom,
          this.markerTo,
          this.status.symbol,
          this.status.next_status,
        );
      }
    });
    palette.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        activeIndex = (activeIndex + 1) % options.length;
        updateActiveOption();
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        activeIndex = (activeIndex - 1 + options.length) % options.length;
        updateActiveOption();
      } else if (event.key === "Home") {
        event.preventDefault();
        activeIndex = 0;
        updateActiveOption();
      } else if (event.key === "End") {
        event.preventDefault();
        activeIndex = options.length - 1;
        updateActiveOption();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const selected = this.statuses[activeIndex];
        if (selected !== undefined) {
          applyTaskStatus(
            view,
            this.markerFrom,
            this.markerTo,
            this.status.symbol,
            selected.symbol,
          );
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePalette(true);
      }
    });
    host.addEventListener("pointerenter", () => openPalette(false));
    host.addEventListener("pointerleave", () => {
      if (!host.contains(document.activeElement)) {
        closePalette(false);
      }
    });
    host.addEventListener("focusout", () => {
      queueMicrotask(() => {
        if (!host.contains(document.activeElement)) {
          closePalette(false);
        }
      });
    });
    host.append(box, palette);
    return host;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly displayMode: boolean,
  ) {
    super();
  }

  override eq(other: MathWidget): boolean {
    return (
      other.source === this.source && other.displayMode === this.displayMode
    );
  }

  override toDOM(): HTMLElement {
    const host = document.createElement(this.displayMode ? "div" : "span");
    host.className = this.displayMode
      ? "cm-skr-math cm-skr-math-block"
      : "cm-skr-math cm-skr-math-inline";
    host.setAttribute("role", "img");
    host.setAttribute(
      "aria-label",
      this.displayMode ? STRINGS.mathBlockLabel : STRINGS.mathInlineLabel,
    );
    renderMath(host, this.source, this.displayMode);
    return host;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

let nextMermaidId = 0;

class MermaidWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }

  override eq(other: MermaidWidget): boolean {
    return other.source === this.source;
  }

  override toDOM(view: EditorView): HTMLElement {
    nextMermaidId += 1;
    const host = document.createElement("div");
    host.className = "cm-skr-mermaid";
    host.setAttribute("role", "img");
    host.setAttribute("aria-label", STRINGS.mermaidDiagramLabel);
    host.textContent = STRINGS.mermaidLoading;
    void renderMermaid(
      host,
      this.source,
      `skribeum-mermaid-${nextMermaidId}`,
      STRINGS.mermaidError,
    ).finally(() => {
      if (host.isConnected) {
        view.requestMeasure();
      }
    });
    return host;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

type TableLayout = {
  cells: string[];
  columns: string;
  alignments: ("left" | "center" | "right")[];
  header: boolean;
  first: boolean;
  last: boolean;
};

function directChildren(node: SyntaxNode, name: string): SyntaxNode[] {
  const children: SyntaxNode[] = [];
  for (let child = node.firstChild; child !== null; child = child.nextSibling) {
    if (child.name === name) {
      children.push(child);
    }
  }
  return children;
}

function delimiterAlignments(text: string, count: number) {
  const cells = text
    .replace(/^\s*\|/u, "")
    .replace(/\|\s*$/u, "")
    .split("|")
    .map((cell) => cell.trim());
  return Array.from({ length: count }, (_, index) => {
    const cell = cells[index] ?? "";
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : "left";
  });
}

function tableLayout(node: SyntaxNode, doc: Text): TableLayout {
  const table = node.parent;
  const rows: SyntaxNode[] = [];
  let delimiter = "";
  if (table !== null) {
    for (
      let child = table.firstChild;
      child !== null;
      child = child.nextSibling
    ) {
      if (child.name === "TableHeader" || child.name === "TableRow") {
        rows.push(child);
      } else if (child.name === "TableDelimiter") {
        delimiter = doc.sliceString(child.from, child.to);
      }
    }
  }
  const rowCells = rows.map((row) =>
    directChildren(row, "TableCell").map((cell) =>
      doc.sliceString(cell.from, cell.to).trim(),
    ),
  );
  const columnCount = Math.max(1, ...rowCells.map((cells) => cells.length));
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(3, ...rowCells.map((cells) => cells[index]?.length ?? 0)),
  );
  const rowIndex = rows.findIndex(
    (row) => row.from === node.from && row.to === node.to,
  );
  return {
    cells: rowCells[rowIndex] ?? [],
    columns: widths.map((width) => `minmax(${width}ch, 1fr)`).join(" "),
    alignments: delimiterAlignments(delimiter, columnCount),
    header: node.name === "TableHeader",
    first: rowIndex === 0,
    last: rowIndex === rows.length - 1,
  };
}

class TableRowWidget extends WidgetType {
  constructor(readonly layout: TableLayout) {
    super();
  }

  override eq(other: TableRowWidget): boolean {
    return JSON.stringify(other.layout) === JSON.stringify(this.layout);
  }

  override toDOM(): HTMLElement {
    const row = document.createElement("div");
    row.className = [
      "cm-skr-table-row",
      this.layout.header ? "cm-skr-table-header" : "",
      this.layout.first ? "cm-skr-table-first" : "",
      this.layout.last ? "cm-skr-table-last" : "",
    ]
      .filter(Boolean)
      .join(" ");
    row.setAttribute("role", "row");
    row.style.gridTemplateColumns = this.layout.columns;
    for (const [index, text] of this.layout.cells.entries()) {
      const cell = document.createElement(
        this.layout.header ? "strong" : "span",
      );
      cell.className = "cm-skr-table-cell";
      cell.setAttribute("role", this.layout.header ? "columnheader" : "cell");
      cell.style.textAlign = this.layout.alignments[index] ?? "left";
      cell.textContent = text;
      row.append(cell);
    }
    return row;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class TableSeparatorWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const separator = document.createElement("div");
    separator.className = "cm-skr-table-separator";
    separator.setAttribute("aria-hidden", "true");
    return separator;
  }
}

function fencedCodeSource(node: SyntaxNode, doc: Text): string {
  const openingLine = doc.lineAt(node.from);
  const marks = node.getChildren("CodeMark");
  const closing = marks.at(-1);
  const bodyFrom = Math.min(openingLine.to + 1, doc.length);
  const bodyTo =
    closing !== undefined && closing.from > openingLine.to
      ? doc.lineAt(closing.from).from
      : node.to;
  return doc.sliceString(bodyFrom, Math.max(bodyFrom, bodyTo));
}

class CodeCopyWidget extends WidgetType {
  private resetTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly source: string) {
    super();
  }

  override eq(other: CodeCopyWidget): boolean {
    return other.source === this.source;
  }

  override toDOM(): HTMLElement {
    const button = document.createElement("button");
    button.className = "cm-skr-code-copy";
    button.type = "button";
    button.textContent = STRINGS.copyCode;
    button.setAttribute("aria-label", STRINGS.copyCode);
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await navigator.clipboard.writeText(this.source);
        button.textContent = STRINGS.codeCopied;
        button.setAttribute("aria-label", STRINGS.codeCopied);
        clearTimeout(this.resetTimer);
        this.resetTimer = setTimeout(() => {
          button.textContent = STRINGS.copyCode;
          button.setAttribute("aria-label", STRINGS.copyCode);
        }, 1_200);
      } catch {
        button.textContent = STRINGS.codeCopyFailed;
      }
    });
    return button;
  }

  override destroy(): void {
    clearTimeout(this.resetTimer);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const nestedViews = new WeakMap<HTMLElement, EditorView>();

function headingLevel(name: string): number | null {
  const atx = /^ATXHeading([1-6])$/u.exec(name);
  if (atx !== null) {
    return Number(atx[1]);
  }
  return name === "SetextHeading1" ? 1 : name === "SetextHeading2" ? 2 : null;
}

function headingTitle(source: string, node: SyntaxNode): string {
  const text = source.slice(node.from, node.to);
  if (node.name.startsWith("ATXHeading")) {
    return text
      .replace(/^#{1,6}[ \t]*/u, "")
      .replace(/[ \t]+#+[ \t]*$/u, "")
      .trim();
  }
  return (text.split("\n", 1)[0] ?? "").trim();
}

function embeddedSection(source: string, fragment: string): string | null {
  if (fragment.length === 0) {
    return source;
  }
  const wanted = fragment.trim().toLocaleLowerCase();
  const tree = skribeumMarkdownParser.parse(source);
  let match: SyntaxNode | null = null;
  tree.iterate({
    enter(ref) {
      if (
        match === null &&
        headingLevel(ref.name) !== null &&
        headingTitle(source, ref.node).toLocaleLowerCase() === wanted
      ) {
        match = ref.node;
      }
      return match === null ? undefined : false;
    },
  });
  if (match === null) {
    return null;
  }
  const heading = match as SyntaxNode;
  const level = headingLevel(heading.name) ?? 6;
  let end = source.length;
  tree.iterate({
    from: heading.to,
    enter(ref) {
      const candidate = headingLevel(ref.name);
      if (candidate !== null && candidate <= level) {
        end = ref.from;
        return false;
      }
      return undefined;
    },
  });
  return source.slice(heading.from, end).replace(/\n+$/u, "");
}

function nestedMarkdownView(
  host: HTMLElement,
  source: string,
  context: WikilinkResolutionContext,
  label: string,
  taskStatuses: readonly TaskStatus[],
): EditorView {
  const nested = new EditorView({
    state: EditorState.create({
      doc: source,
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: obsidianMarkdownExtensionsFor(taskStatuses),
          codeLanguages: codeLanguage,
        }),
        syntaxHighlighting(tokenHighlightStyle, { fallback: true }),
        taskStatusConfiguration.of(taskStatuses),
        decorationEngine(context),
        readOnlyDecorationMode,
        EditorView.lineWrapping,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorView.contentAttributes.of({
          "aria-label": label,
          tabindex: "-1",
        }),
      ],
    }),
    parent: host,
  });
  nestedViews.set(host, nested);
  return nested;
}

function renderLinkedNote(
  host: HTMLElement,
  target: string,
  rootSource: string,
  context: WikilinkResolutionContext,
  label: string,
  taskStatuses: readonly TaskStatus[],
  onRendered: () => void,
): () => void {
  const [, fragment = ""] = target.split("#", 2);
  const resolution = resolveWikilinkTarget(target, context);
  const resolvedPath =
    resolution.kind === "note"
      ? resolution.path
      : resolution.kind === "self"
        ? (context.currentPath ?? "")
        : "";
  const notice = (message: string) => {
    host.classList.add("cm-skr-embed-notice");
    host.setAttribute("role", "status");
    host.textContent = message;
  };
  if (resolution.kind === "unresolved") {
    notice(STRINGS.embedUnavailable);
    return () => {};
  }
  const depth = context.embedDepth ?? 0;
  if (depth >= EMBED_DEPTH_LIMIT) {
    notice(STRINGS.embedDepthLimit);
    return () => {};
  }
  const ancestry = context.embedAncestry ?? [];
  const directSelfEmbed = resolution.kind === "self" && depth === 0;
  if (
    resolvedPath.length > 0 &&
    ancestry.includes(resolvedPath) &&
    !directSelfEmbed
  ) {
    notice(STRINGS.embedCycle);
    return () => {};
  }
  const load =
    resolution.kind === "self"
      ? Promise.resolve(rootSource)
      : (context.loadNote?.(resolvedPath) ?? Promise.resolve(null));
  let destroyed = false;
  host.textContent = STRINGS.embedLoading;
  void load.then((source) => {
    if (destroyed || (!host.isConnected && !document.body.contains(host))) {
      return;
    }
    if (source === null) {
      notice(STRINGS.embedUnavailable);
      return;
    }
    const selected = embeddedSection(source, fragment);
    if (selected === null) {
      notice(STRINGS.embedSectionUnavailable);
      return;
    }
    host.textContent = "";
    nestedMarkdownView(
      host,
      selected,
      {
        ...context,
        currentPath: resolvedPath,
        embedDepth: depth + 1,
        embedAncestry:
          resolvedPath.length === 0 ? ancestry : [...ancestry, resolvedPath],
      },
      label,
      taskStatuses,
    );
    onRendered();
  });
  return () => {
    destroyed = true;
    nestedViews.get(host)?.destroy();
  };
}

class EmbedWidget extends WidgetType {
  private readonly cleanups = new WeakMap<HTMLElement, () => void>();

  constructor(
    readonly target: string,
    readonly rootSource: string,
    readonly context: WikilinkResolutionContext,
    readonly taskStatuses: readonly TaskStatus[],
  ) {
    super();
  }

  override eq(other: EmbedWidget): boolean {
    return (
      other.target === this.target &&
      other.rootSource === this.rootSource &&
      other.context === this.context &&
      JSON.stringify(other.taskStatuses) === JSON.stringify(this.taskStatuses)
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("span");
    host.className = "cm-skr-embed cm-skr-reveal-motion cm-skr-reveal-rendered";
    host.setAttribute("role", "group");
    const [pathTarget = "", fragment = ""] = this.target.split("#", 2);
    const resolution = resolveWikilinkTarget(this.target, this.context);
    const resolvedPath =
      resolution.kind === "note"
        ? resolution.path
        : resolution.kind === "self"
          ? (this.context.currentPath ?? "")
          : "";
    const sourceName = resolvedPath || pathTarget || STRINGS.currentNote;
    host.setAttribute("aria-label", `${STRINGS.embedLabel}: ${sourceName}`);

    const header = document.createElement("span");
    header.className = "cm-skr-embed-header";
    header.textContent =
      fragment.length > 0 ? `${sourceName} · ${fragment}` : sourceName;
    host.append(header);
    const body = document.createElement("span");
    body.className = "cm-skr-embed-body";
    host.append(body);

    this.cleanups.set(
      host,
      renderLinkedNote(
        body,
        this.target,
        this.rootSource,
        this.context,
        `${STRINGS.embedLabel}: ${sourceName}`,
        this.taskStatuses,
        () => view.requestMeasure(),
      ),
    );
    return host;
  }

  override destroy(dom: HTMLElement): void {
    this.cleanups.get(dom)?.();
    this.cleanups.delete(dom);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

class CalloutIconWidget extends WidgetType {
  constructor(readonly type: string) {
    super();
  }

  override eq(other: CalloutIconWidget): boolean {
    return other.type === this.type;
  }

  override toDOM(): HTMLElement {
    const host = document.createElement("span");
    host.className = "cm-skr-callout-icon-host";
    host.setAttribute("aria-hidden", "true");
    host.innerHTML = calloutIconSvg(this.type);
    return host;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

function isBlockWidgetRule(rule: DecorationRule): boolean {
  return (
    rule.presentation.present === "widget" &&
    rule.presentation.place !== "before" &&
    (rule.presentation.widget === "math-block" ||
      rule.presentation.widget === "mermaid-diagram" ||
      rule.presentation.widget === "table-row" ||
      rule.presentation.widget === "table-separator")
  );
}

const splitTableCache = new WeakMap<
  readonly DecorationRule[],
  { inline: readonly DecorationRule[]; block: readonly DecorationRule[] }
>();

function splitTable(table: readonly DecorationRule[]) {
  const cached = splitTableCache.get(table);
  if (cached !== undefined) {
    return cached;
  }
  const split = {
    inline: table.filter((rule) => !isBlockWidgetRule(rule)),
    block: table.filter(isBlockWidgetRule),
  };
  splitTableCache.set(table, split);
  return split;
}

/** The marker character between the task brackets, e.g. `x` for `[x]`. */
function taskMarkerCharacter(markerText: string): string {
  return markerText.startsWith("[") && markerText.endsWith("]")
    ? markerText.slice(1, -1)
    : "";
}

function taskCheckboxAttributes(status: TaskStatus): [string, string][] {
  return [
    ["role", "checkbox"],
    ["aria-checked", taskAriaChecked(status)],
    ["aria-label", status.name],
    ["data-task", status.symbol],
    ["data-category", status.category],
    ["data-color-token", status.color_token],
  ];
}

function serializeAttributes(
  attributes: Readonly<Record<string, string>>,
): string {
  return Object.keys(attributes)
    .sort()
    .map((key) => ` ${key}=${JSON.stringify(attributes[key])}`)
    .join("");
}

type ComputeOptions = {
  doc: Text;
  tree: Tree;
  table: readonly DecorationRule[];
  /** Selection ranges driving cursor reveal; empty means no reveal. */
  selection?: readonly { from: number; to: number }[];
  /** Windows to decorate; the whole document when omitted. */
  ranges?: readonly { from: number; to: number }[];
  wikilinks?: WikilinkResolutionContext;
  taskStatuses?: readonly TaskStatus[];
  /** Preselected across the full table when decorations are split. */
  activeReveal?: RevealRegion | null;
};

type RevealRegion = {
  from: number;
  to: number;
  descendants: boolean;
};

type RuleIndex = Map<string, DecorationRule[]>;

const ruleIndexCache = new WeakMap<readonly DecorationRule[], RuleIndex>();

function ruleIndex(table: readonly DecorationRule[]): RuleIndex {
  const cached = ruleIndexCache.get(table);
  if (cached !== undefined) {
    return cached;
  }
  const index: RuleIndex = new Map();
  for (const rule of table) {
    const rules = index.get(rule.node);
    if (rules === undefined) {
      index.set(rule.node, [rule]);
    } else {
      rules.push(rule);
    }
  }
  ruleIndexCache.set(table, index);
  return index;
}

function hasSibling(node: SyntaxNode, name: string): boolean {
  const parent = node.parent;
  if (parent === null) {
    return false;
  }
  for (
    let child = parent.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (
      child.name === name &&
      (child.from !== node.from || child.to !== node.to)
    ) {
      return true;
    }
  }
  return false;
}

function hasAncestor(node: SyntaxNode, name: string): boolean {
  for (let parent = node.parent; parent !== null; parent = parent.parent) {
    if (parent.name === name) {
      return true;
    }
  }
  return false;
}

/** Whether a table row applies to a node; exported for the rules tests. */
export function ruleMatches(
  rule: DecorationRule,
  node: SyntaxNode,
  doc?: Text,
): boolean {
  const parentName = node.parent?.name;
  if (rule.parent !== undefined) {
    if (parentName === undefined || !rule.parent.includes(parentName)) {
      return false;
    }
  }
  if (rule.notParent !== undefined && parentName !== undefined) {
    if (rule.notParent.includes(parentName)) {
      return false;
    }
  }
  if (rule.ancestor !== undefined && !hasAncestor(node, rule.ancestor)) {
    return false;
  }
  if (rule.withSibling !== undefined && !hasSibling(node, rule.withSibling)) {
    return false;
  }
  if (
    rule.withoutSibling !== undefined &&
    hasSibling(node, rule.withoutSibling)
  ) {
    return false;
  }
  if (rule.codeInfo !== undefined) {
    const info = node.getChild("CodeInfo");
    const firstToken =
      info === null || doc === undefined
        ? ""
        : (doc.sliceString(info.from, info.to).trim().split(/\s+/u)[0] ?? "");
    if (firstToken.toLowerCase() !== rule.codeInfo.toLowerCase()) {
      return false;
    }
  }
  return true;
}

/** The paragraph heading a callout blockquote, or null when not a callout. */
function calloutHead(blockquote: SyntaxNode): SyntaxNode | null {
  for (
    let child = blockquote.firstChild;
    child !== null;
    child = child.nextSibling
  ) {
    if (child.name === "QuoteMark") {
      continue;
    }
    if (child.name !== "Paragraph") {
      return null;
    }
    const mark = child.firstChild;
    return mark !== null &&
      mark.name === "CalloutMark" &&
      mark.from === child.from
      ? mark
      : null;
  }
  return null;
}

function calloutTypeOf(mark: SyntaxNode, doc: Text): string | null {
  const type = mark.getChild("CalloutType");
  return type === null
    ? null
    : doc.sliceString(type.from, type.to).toLowerCase();
}

/**
 * Resolves a row's dynamic attributes. Returns null when the dynamic
 * behavior decides the row does not apply at all (a callout row outside a
 * callout-headed blockquote).
 */
function dynamicAttributes(
  rule: DecorationRule,
  node: SyntaxNode,
  doc: Text,
  wikilinks: WikilinkResolutionContext,
  taskStatuses: readonly TaskStatus[],
): Record<string, string> | null {
  switch (rule.dynamic) {
    case "markdown-link-preview": {
      if (wikilinks.linkPreviews === false) {
        return {};
      }
      const url = node.getChild("URL");
      const target =
        url === null
          ? null
          : resolveMarkdownLinkTarget(
              doc.sliceString(url.from, url.to),
              wikilinks,
            );
      return target === null
        ? {}
        : {
            "data-preview-target": target,
            role: "link",
            tabindex: "0",
            "aria-haspopup": "dialog",
            "aria-keyshortcuts": "P",
          };
    }
    case "wikilink-resolution": {
      const target = node.getChild("WikilinkTarget");
      if (target === null) {
        return {};
      }
      const resolution = resolveWikilinkTarget(
        doc.sliceString(target.from, target.to),
        wikilinks,
      );
      const attributes: Record<string, string> = {
        "data-resolved": resolution.kind === "unresolved" ? "false" : "true",
      };
      if (
        resolution.kind !== "unresolved" &&
        wikilinks.linkPreviews !== false
      ) {
        attributes["data-preview-target"] = doc.sliceString(
          target.from,
          target.to,
        );
        attributes.role = "link";
        attributes.tabindex = "0";
        attributes["aria-haspopup"] = "dialog";
        attributes["aria-keyshortcuts"] = "P";
      }
      return attributes;
    }
    case "callout-type": {
      let blockquote: SyntaxNode | null = node;
      while (blockquote !== null && blockquote.name !== "Blockquote") {
        blockquote = blockquote.parent;
      }
      if (blockquote === null || blockquote.name !== "Blockquote") {
        return node.name === "Blockquote" ? {} : null;
      }
      const head = calloutHead(blockquote);
      if (
        head === null ||
        (node.name === "CalloutMark" && head.from !== node.from)
      ) {
        return node.name === "Blockquote" ? {} : null;
      }
      const type = calloutTypeOf(head, doc);
      return type === null ? {} : { "data-callout": type };
    }
    case "plain-blockquote": {
      let blockquote: SyntaxNode | null = node;
      while (blockquote !== null && blockquote.name !== "Blockquote") {
        blockquote = blockquote.parent;
      }
      return blockquote !== null && calloutHead(blockquote) === null
        ? {}
        : null;
    }
    case "rich-callout": {
      if (node.name !== "Blockquote") {
        return null;
      }
      const callout = parseCallout(doc.sliceString(node.from, node.to));
      return callout === null
        ? null
        : {
            "data-callout": callout.originalType.toLowerCase(),
            "data-callout-canonical": callout.canonicalType,
            "data-accent": callout.accentGroup,
            "data-foldable": callout.foldable ? "true" : "false",
          };
    }
    case "code-language":
      return { "data-language": doc.sliceString(node.from, node.to) };
    case "mermaid-block": {
      const info = node.getChild("CodeInfo");
      const firstToken =
        info === null
          ? ""
          : (doc.sliceString(info.from, info.to).trim().split(/\s+/u)[0] ?? "");
      if (firstToken.toLowerCase() !== "mermaid") {
        return null;
      }
      return { "data-language": "mermaid" };
    }
    case "task-status": {
      const marker = node.getChild("TaskMarker");
      if (marker === null) {
        return null;
      }
      const symbol = taskMarkerCharacter(
        doc.sliceString(marker.from, marker.to),
      );
      const status = taskStatusBySymbol(taskStatuses, symbol);
      return status === undefined
        ? null
        : {
            "data-task": status.symbol,
            "data-category": status.category,
            "data-color-token": status.color_token,
          };
    }
    default:
      return {};
  }
}

function revealRange(
  rule: DecorationRule,
  node: SyntaxNode,
  doc: Text,
): { from: number; to: number } {
  const useNode =
    rule.revealScope === "node" ||
    (rule.revealScope === undefined &&
      rule.reveal === "cursor-inside" &&
      rule.presentation.present === "widget");
  const scope = useNode ? node : (node.parent ?? node);
  if (rule.reveal !== "cursor-line") {
    return { from: scope.from, to: scope.to };
  }
  return {
    from: doc.lineAt(scope.from).from,
    to: doc.lineAt(Math.min(scope.to, doc.length)).to,
  };
}

function selectsDescendants(rule: DecorationRule): boolean {
  return (
    rule.revealDescendants === true ||
    (rule.presentation.present === "widget" &&
      rule.presentation.place !== "before")
  );
}

function findActiveReveal(
  doc: Text,
  tree: Tree,
  table: readonly DecorationRule[],
  selection: readonly { from: number; to: number }[],
  wikilinks: WikilinkResolutionContext,
  taskStatuses: readonly TaskStatus[],
): RevealRegion | null {
  const cursor = selection[0]?.to;
  if (cursor === undefined) {
    return null;
  }
  const rules = ruleIndex(table);
  let active: RevealRegion | null = null;
  const relevant = new Map<string, SyntaxNode>();
  for (const bias of [-1, 1] as const) {
    for (
      let node: SyntaxNode | null = tree.resolveInner(cursor, bias);
      node !== null;
      node = node.parent
    ) {
      relevant.set(`${node.name}:${node.from}:${node.to}`, node);
      if (node.name === "Document") {
        continue;
      }
      for (
        let child = node.firstChild;
        child !== null;
        child = child.nextSibling
      ) {
        relevant.set(`${child.name}:${child.from}:${child.to}`, child);
      }
    }
  }
  for (const node of relevant.values()) {
    const nodeRules = rules.get(node.name);
    if (nodeRules === undefined) {
      continue;
    }
    for (const rule of nodeRules) {
      if (
        rule.reveal === "never" ||
        !ruleMatches(rule, node, doc) ||
        dynamicAttributes(rule, node, doc, wikilinks, taskStatuses) === null
      ) {
        continue;
      }
      const range = revealRange(rule, node, doc);
      if (cursor < range.from || cursor > range.to) {
        continue;
      }
      const candidate: RevealRegion = {
        ...range,
        descendants: selectsDescendants(rule),
      };
      if (
        active === null ||
        (candidate.descendants && !active.descendants) ||
        (candidate.descendants === active.descendants &&
          candidate.to - candidate.from < active.to - active.from)
      ) {
        active = candidate;
      }
    }
  }
  return active;
}

type BuiltDecoration = {
  from: number;
  to: number;
  decoration: Decoration;
};

function markDecoration(
  presentation: Extract<Presentation, { present: "mark" }>,
  dynamic: Record<string, string>,
  motionClass = "",
): Decoration {
  const attributes = { ...(presentation.attributes ?? {}), ...dynamic };
  const className = `${presentation.class} ${motionClass}`.trim();
  const spec: Parameters<typeof Decoration.mark>[0] = {
    class: className,
    skr: `mark class=${JSON.stringify(presentation.class)}${serializeAttributes(attributes)}`,
  };
  if (Object.keys(attributes).length > 0) {
    spec.attributes = attributes;
  }
  return Decoration.mark(spec);
}

function mathSource(node: SyntaxNode, doc: Text): string {
  const content = node.getChild("MathContent");
  return content === null
    ? ""
    : doc.sliceString(content.from, content.to).trim();
}

function mermaidSource(node: SyntaxNode, doc: Text): string {
  const lines = doc.sliceString(node.from, node.to).split("\n");
  lines.shift();
  if (/^[ \t]*(?:`{3,}|~{3,})[ \t]*$/.test(lines.at(-1) ?? "")) {
    lines.pop();
  }
  return lines.join("\n").trim();
}

function widgetFor(
  widget: Extract<Presentation, { present: "widget" }>["widget"],
  node: SyntaxNode,
  doc: Text,
  wikilinks: WikilinkResolutionContext,
  taskStatuses: readonly TaskStatus[],
): { widget: WidgetType; block: boolean; attributes: Record<string, string> } {
  switch (widget) {
    case "task-checkbox": {
      const marker = taskMarkerCharacter(doc.sliceString(node.from, node.to));
      const status = taskStatusBySymbol(taskStatuses, marker);
      if (status === undefined) {
        throw new Error("task checkbox requires a configured marker");
      }
      return {
        widget: new TaskCheckboxWidget(
          status,
          taskStatuses,
          node.from + 1,
          node.to - 1,
        ),
        block: false,
        attributes: Object.fromEntries(taskCheckboxAttributes(status)),
      };
    }
    case "math-inline":
      return {
        widget: new MathWidget(mathSource(node, doc), false),
        block: false,
        attributes: { role: "img", "aria-label": STRINGS.mathInlineLabel },
      };
    case "math-block":
      return {
        widget: new MathWidget(mathSource(node, doc), true),
        block: true,
        attributes: { role: "img", "aria-label": STRINGS.mathBlockLabel },
      };
    case "mermaid-diagram":
      return {
        widget: new MermaidWidget(mermaidSource(node, doc)),
        block: true,
        attributes: {
          role: "img",
          "aria-label": STRINGS.mermaidDiagramLabel,
          "data-language": "mermaid",
        },
      };
    case "table-row": {
      const layout = tableLayout(node, doc);
      return {
        widget: new TableRowWidget(layout),
        block: true,
        attributes: {
          role: "row",
          "data-header": layout.header ? "true" : "false",
        },
      };
    }
    case "table-separator":
      return {
        widget: new TableSeparatorWidget(),
        block: true,
        attributes: { "aria-hidden": "true" },
      };
    case "embed": {
      const target = node.getChild("Wikilink")?.getChild("WikilinkTarget");
      const targetText =
        target === null || target === undefined
          ? ""
          : doc.sliceString(target.from, target.to);
      return {
        widget: new EmbedWidget(
          targetText,
          doc.toString(),
          wikilinks,
          taskStatuses,
        ),
        block: false,
        attributes: { role: "group", "data-target": targetText },
      };
    }
    case "code-copy":
      return {
        widget: new CodeCopyWidget(fencedCodeSource(node, doc)),
        block: false,
        attributes: { role: "button", "aria-label": STRINGS.copyCode },
      };
    case "callout-icon": {
      const type = calloutTypeOf(node, doc);
      return {
        widget: new CalloutIconWidget(type ?? "note"),
        block: false,
        attributes: { "aria-hidden": "true", "data-callout": type ?? "note" },
      };
    }
  }
}

/**
 * Computes the decoration set for `ranges` of `doc` under `table`. Pure:
 * the same document, tree, table, selection and context produce the same
 * set, which is what the snapshot goldens serialize.
 */
export function computeDecorations(options: ComputeOptions): DecorationSet {
  const { doc, tree } = options;
  const table = options.table;
  const rules = ruleIndex(table);
  const selection = options.selection ?? [];
  const ranges = options.ranges ?? [{ from: 0, to: doc.length }];
  const wikilinks = options.wikilinks ?? EMPTY_WIKILINK_CONTEXT;
  const taskStatuses = normalizeTaskStatuses(
    options.taskStatuses ?? DEFAULT_TASK_STATUSES,
  );
  const activeReveal =
    options.activeReveal === undefined
      ? findActiveReveal(doc, tree, table, selection, wikilinks, taskStatuses)
      : options.activeReveal;
  const built: BuiltDecoration[] = [];
  const seenLines = new Set<string>();
  const seenMotionRanges = new Set<string>();

  const activeRevealOwns = (node: SyntaxNode): boolean =>
    activeReveal !== null &&
    node.from === activeReveal.from &&
    node.to === activeReveal.to;

  const revealed = (rule: DecorationRule, node: SyntaxNode): boolean => {
    if (rule.reveal === "never" || activeReveal === null) {
      return false;
    }
    const range = revealRange(rule, node, doc);
    return range.from === activeReveal.from && range.to === activeReveal.to;
  };

  for (const window of ranges) {
    tree.iterate({
      from: window.from,
      to: window.to,
      enter: (ref) => {
        // Long-line safeguard: prune every node that lives entirely on an
        // over-limit line; decorations on such lines are disabled.
        if (ref.to > ref.from) {
          const startLine = doc.lineAt(ref.from);
          if (
            startLine.length > LONG_LINE_DECORATION_LIMIT &&
            ref.to <= startLine.to
          ) {
            return false;
          }
        }
        const nodeRules = rules.get(ref.name);
        if (nodeRules === undefined) {
          return undefined;
        }
        const node = ref.node;
        for (const rule of nodeRules) {
          if (!ruleMatches(rule, node, doc)) {
            continue;
          }
          const dynamic = dynamicAttributes(
            rule,
            node,
            doc,
            wikilinks,
            taskStatuses,
          );
          if (dynamic === null) {
            continue;
          }
          const revealedNow = revealed(rule, node);
          if (
            activeReveal?.descendants === true &&
            ref.from >= activeReveal.from &&
            ref.to <= activeReveal.to &&
            !revealedNow
          ) {
            continue;
          }
          const presentation = rule.presentation;
          if (presentation.present === "line") {
            const lineClass = presentation.class;
            let position = Math.max(ref.from, window.from);
            const end = Math.min(ref.to, window.to);
            while (position <= end) {
              const line = doc.lineAt(position);
              const firstRichLine = line.from === doc.lineAt(ref.from).from;
              const lastRichLine =
                line.from === doc.lineAt(Math.min(ref.to, doc.length)).from;
              const lineDynamic =
                rule.dynamic === "rich-callout"
                  ? {
                      ...dynamic,
                      ...(revealedNow ? { "data-revealed": "true" } : {}),
                      ...(firstRichLine ? { role: "note" } : {}),
                      "data-callout-line":
                        firstRichLine && lastRichLine
                          ? "only"
                          : firstRichLine
                            ? "first"
                            : lastRichLine
                              ? "last"
                              : "middle",
                    }
                  : dynamic;
              const nestedActiveLine =
                rule.dynamic === "rich-callout" &&
                activeReveal !== null &&
                !revealedNow &&
                activeReveal.from >= ref.from &&
                activeReveal.to <= ref.to &&
                line.from >= activeReveal.from &&
                line.to <= activeReveal.to;
              if (
                rule.dynamic === "rich-callout" &&
                line.to > line.from &&
                !nestedActiveLine
              ) {
                const motionClass = `cm-skr-reveal-motion ${
                  revealedNow
                    ? "cm-skr-reveal-source"
                    : "cm-skr-reveal-rendered"
                }`;
                const motionKey = `${line.from} ${line.to} ${motionClass}`;
                if (!seenMotionRanges.has(motionKey)) {
                  seenMotionRanges.add(motionKey);
                  built.push({
                    from: line.from,
                    to: line.to,
                    decoration: Decoration.mark({
                      class: motionClass,
                      skr: `motion ${revealedNow ? "source" : "rendered"}=callout`,
                    }),
                  });
                }
              }
              const key = `${line.from} ${lineClass}${serializeAttributes(lineDynamic)}`;
              if (
                line.length <= LONG_LINE_DECORATION_LIMIT &&
                !seenLines.has(key)
              ) {
                seenLines.add(key);
                const spec: Parameters<typeof Decoration.line>[0] = {
                  class: lineClass,
                  skr: `line class=${JSON.stringify(lineClass)}${serializeAttributes(lineDynamic)}`,
                };
                if (Object.keys(lineDynamic).length > 0) {
                  spec.attributes = lineDynamic;
                }
                built.push({
                  from: line.from,
                  to: line.from,
                  decoration: Decoration.line(spec),
                });
              }
              if (line.to >= end) {
                break;
              }
              position = line.to + 1;
            }
            continue;
          }
          if (doc.lineAt(ref.from).length > LONG_LINE_DECORATION_LIMIT) {
            continue;
          }
          if (
            revealedNow &&
            presentation.present === "widget" &&
            presentation.widget === "embed"
          ) {
            built.push({
              from: ref.from,
              to: ref.to,
              decoration: Decoration.mark({
                class:
                  "cm-skr-reveal-motion cm-skr-reveal-source cm-skr-reveal-embed-source",
                skr: "motion source=embed",
              }),
            });
            continue;
          }
          // A revealed rule emits nothing, so the source shows through. The
          // exception is a cursor-line reveal, which still emits a marker
          // carrying its active state so the transition has something to
          // animate between.
          if (revealedNow && rule.reveal !== "cursor-line") {
            continue;
          }
          if (presentation.present === "hide") {
            let hideFrom = ref.from;
            let hideTo = ref.to;
            if (rule.extendThroughSpace === true) {
              if (doc.sliceString(hideTo, hideTo + 1) === " ") {
                hideTo += 1;
              } else if (doc.sliceString(hideFrom - 1, hideFrom) === " ") {
                hideFrom -= 1;
              }
            }
            if (rule.reveal === "cursor-line") {
              const className = revealedNow
                ? "cm-skr-reveal-marker cm-skr-reveal-marker-active"
                : "cm-skr-reveal-marker";
              built.push({
                from: hideFrom,
                to: hideTo,
                decoration: Decoration.mark({
                  class: className,
                  skr: `${revealedNow ? "reveal" : "hide"} node=${rule.node}`,
                }),
              });
              continue;
            }
            if (revealedNow) {
              continue;
            }
            built.push({
              from: hideFrom,
              to: hideTo,
              decoration: Decoration.replace({
                atomic: true,
                skr: `hide node=${rule.node}`,
              }),
            });
          } else if (presentation.present === "widget") {
            const builtWidget = widgetFor(
              presentation.widget,
              node,
              doc,
              wikilinks,
              taskStatuses,
            );
            const skr = `widget ${presentation.widget}${serializeAttributes(builtWidget.attributes)}`;
            if (presentation.place === "before") {
              built.push({
                from: ref.from,
                to: ref.from,
                decoration: Decoration.widget({
                  widget: builtWidget.widget,
                  side: -1,
                  skr,
                }),
              });
            } else {
              built.push({
                from: ref.from,
                to: ref.to,
                decoration: Decoration.replace({
                  atomic: true,
                  widget: builtWidget.widget,
                  block: builtWidget.block,
                  skr,
                }),
              });
            }
          } else {
            const motionClass = ["Link", "Image", "Wikilink"].includes(
              rule.node,
            )
              ? `cm-skr-reveal-motion ${
                  activeRevealOwns(node)
                    ? "cm-skr-reveal-source"
                    : "cm-skr-reveal-rendered"
                }`
              : "";
            built.push({
              from: ref.from,
              to: ref.to,
              decoration: markDecoration(presentation, dynamic, motionClass),
            });
          }
        }
        return undefined;
      },
    });
  }

  return Decoration.set(
    built.map((item) => item.decoration.range(item.from, item.to)),
    true,
  );
}

/**
 * Serializes a decoration set as stable review-diff text, one decoration
 * per line: `from..to kind attrs`. The `skr` spec field is written at
 * build time by `computeDecorations`, so serialization is a plain read.
 */
export function serializeDecorationSet(set: DecorationSet): string {
  const lines: string[] = [];
  const cursor = set.iter();
  while (cursor.value !== null) {
    const spec = cursor.value.spec as { skr?: string };
    lines.push(`${cursor.from}..${cursor.to} ${spec.skr ?? "unknown"}`);
    cursor.next();
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function buildViewDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const table = state.facet(decorationTable);
  const cursor = state.selection.main.head;
  const selection = state.facet(sourceRevealEnabled)
    ? [{ from: cursor, to: cursor }]
    : [];
  const wikilinks =
    state.field(wikilinkContext, false) ?? EMPTY_WIKILINK_CONTEXT;
  const taskStatuses = state.facet(taskStatusConfiguration);
  const activeReveal = findActiveReveal(
    state.doc,
    syntaxTree(state),
    table,
    selection,
    wikilinks,
    taskStatuses,
  );
  const ranges =
    view.visibleRanges.length > 0
      ? view.visibleRanges.map((range) => ({ from: range.from, to: range.to }))
      : [{ from: view.viewport.from, to: view.viewport.to }];
  return computeDecorations({
    doc: state.doc,
    tree: syntaxTree(state),
    table: splitTable(table).inline,
    selection,
    ranges,
    wikilinks,
    taskStatuses,
    activeReveal,
  });
}

function buildBlockDecorations(state: EditorState): DecorationSet {
  const table = state.facet(decorationTable);
  const cursor = state.selection.main.head;
  const selection = state.facet(sourceRevealEnabled)
    ? [{ from: cursor, to: cursor }]
    : [];
  const wikilinks =
    state.field(wikilinkContext, false) ?? EMPTY_WIKILINK_CONTEXT;
  const taskStatuses = state.facet(taskStatusConfiguration);
  return computeDecorations({
    doc: state.doc,
    tree: syntaxTree(state),
    table: splitTable(table).block,
    selection,
    wikilinks,
    taskStatuses,
    activeReveal: findActiveReveal(
      state.doc,
      syntaxTree(state),
      table,
      selection,
      wikilinks,
      taskStatuses,
    ),
  });
}

type BlockEngineState = {
  decorations: DecorationSet;
  deferred: boolean;
};

const refreshDeferredDecorations = StateEffect.define<null>();

function refreshRequested(transaction: Transaction) {
  return transaction.effects.some((effect) =>
    effect.is(refreshDeferredDecorations),
  );
}

const blockEngineField = StateField.define<BlockEngineState>({
  create: (state) => ({
    decorations: buildBlockDecorations(state),
    deferred: false,
  }),
  update(value, transaction) {
    if (refreshRequested(transaction)) {
      return {
        decorations: buildBlockDecorations(transaction.state),
        deferred: false,
      };
    }
    if (
      value.deferred ||
      transaction.annotation(bulkTextInputAnnotation) === true
    ) {
      return {
        decorations: transaction.docChanged
          ? value.decorations.map(transaction.changes)
          : value.decorations,
        deferred: true,
      };
    }
    if (
      transaction.docChanged ||
      transaction.selection !== transaction.startState.selection ||
      syntaxTree(transaction.state) !== syntaxTree(transaction.startState) ||
      transaction.state.facet(decorationTable) !==
        transaction.startState.facet(decorationTable) ||
      transaction.state.facet(taskStatusConfiguration) !==
        transaction.startState.facet(taskStatusConfiguration) ||
      transaction.state.field(wikilinkContext, false) !==
        transaction.startState.field(wikilinkContext, false)
    ) {
      return {
        decorations: buildBlockDecorations(transaction.state),
        deferred: false,
      };
    }
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value) => value.decorations),
});

function needsRebuild(update: ViewUpdate): boolean {
  return (
    update.docChanged ||
    update.viewportChanged ||
    update.selectionSet ||
    syntaxTree(update.state) !== syntaxTree(update.startState) ||
    update.state.facet(decorationTable) !==
      update.startState.facet(decorationTable) ||
    update.state.facet(taskStatusConfiguration) !==
      update.startState.facet(taskStatusConfiguration) ||
    update.state.field(wikilinkContext, false) !==
      update.startState.field(wikilinkContext, false)
  );
}

const enginePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    private deferred = false;
    private refreshFrame: number | null = null;
    private destroyed = false;

    constructor(view: EditorView) {
      this.decorations = buildViewDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (update.transactions.some(refreshRequested)) {
        this.deferred = false;
        this.decorations = buildViewDecorations(update.view);
        return;
      }
      const bulkInput = update.transactions.some(
        (transaction) =>
          transaction.annotation(bulkTextInputAnnotation) === true,
      );
      if (this.deferred || bulkInput) {
        if (update.docChanged) {
          this.decorations = this.decorations.map(update.changes);
        }
        this.deferred = true;
        this.scheduleRefresh(update.view);
        return;
      }
      if (needsRebuild(update)) {
        this.decorations = buildViewDecorations(update.view);
      }
    }

    private scheduleRefresh(view: EditorView): void {
      if (this.refreshFrame !== null) {
        return;
      }
      const afterPaint = (frames: number) => {
        this.refreshFrame = requestAnimationFrame(() => {
          if (this.destroyed) {
            return;
          }
          if (frames > 1) {
            afterPaint(frames - 1);
            return;
          }
          this.refreshFrame = null;
          view.dispatch({
            effects: refreshDeferredDecorations.of(null),
            annotations: decorationOrigin.of(true),
          });
        });
      };
      afterPaint(3);
    }

    destroy(): void {
      this.destroyed = true;
      if (this.refreshFrame !== null) {
        cancelAnimationFrame(this.refreshFrame);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

let nextPreviewId = 0;

class LinkPreviewController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private scheduledLink: HTMLElement | null = null;
  private activeLink: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private cleanupRender: (() => void) | null = null;
  private previousDescription: string | null = null;
  private previousControls: string | null = null;
  private previousExpanded: string | null = null;
  private focusedTarget: string | null = null;

  constructor(readonly view: EditorView) {
    view.dom.addEventListener("pointerover", this.onPointerOver);
    view.dom.addEventListener("pointerout", this.onPointerOut);
    view.dom.addEventListener("focusin", this.onFocusIn);
    view.dom.addEventListener("focusout", this.onFocusOut);
    window.addEventListener("resize", this.onGeometryChanged);
    window.addEventListener("scroll", this.onScroll, true);
  }

  private previewLink(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element)) {
      return null;
    }
    const link = target.closest<HTMLElement>("[data-preview-target]");
    return link?.closest(".cm-editor") === this.view.dom ? link : null;
  }

  private panelContains(target: EventTarget | null): boolean {
    return target instanceof Node && this.panel?.contains(target) === true;
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduledLink = null;
  }

  private schedule(link: HTMLElement): void {
    if (link === this.activeLink || link === this.scheduledLink) {
      return;
    }
    this.dismiss();
    this.scheduledLink = link;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduledLink = null;
      this.show(link);
    }, LINK_PREVIEW_DELAY);
  }

  private show(link: HTMLElement): void {
    const context = currentWikilinkContext(this.view.state);
    const target = link.dataset.previewTarget;
    if (context.linkPreviews === false || target === undefined) {
      return;
    }
    this.dismiss();
    const resolution = resolveWikilinkTarget(target, context);
    if (resolution.kind === "unresolved") {
      return;
    }
    const pathTarget = target.split("#", 1)[0] ?? "";
    const sourceName =
      resolution.kind === "note"
        ? resolution.path
        : context.currentPath || pathTarget || STRINGS.currentNote;
    const panel = document.createElement("aside");
    panel.className = "cm-skr-link-preview";
    panel.setAttribute("role", "dialog");
    panel.setAttribute(
      "aria-label",
      `${STRINGS.linkPreviewLabel}: ${sourceName}`,
    );
    panel.setAttribute("data-testid", "link-preview");
    nextPreviewId += 1;
    panel.id = `skr-link-preview-${nextPreviewId}`;

    const header = document.createElement("div");
    header.className = "cm-skr-link-preview-header";
    header.textContent = sourceName;
    const body = document.createElement("div");
    body.className = "cm-skr-link-preview-body cm-skr-embed-body";
    panel.append(header, body);
    this.view.dom.append(panel);

    const bounds = link.getBoundingClientRect();
    const left = Math.max(12, Math.min(bounds.left, window.innerWidth - 372));
    panel.style.left = `${left}px`;
    const maximumTop = Math.max(12, window.innerHeight - 280);
    const below = bounds.bottom + 8;
    const above = bounds.top - 264;
    panel.style.top = `${below <= maximumTop ? Math.max(12, below) : Math.max(12, above)}px`;
    panel.style.maxHeight = `${Math.min(256, Math.max(0, window.innerHeight - 24))}px`;

    this.activeLink = link;
    this.panel = panel;
    this.previousDescription = link.getAttribute("aria-describedby");
    this.previousControls = link.getAttribute("aria-controls");
    this.previousExpanded = link.getAttribute("aria-expanded");
    link.setAttribute("aria-describedby", panel.id);
    link.setAttribute("aria-controls", panel.id);
    link.setAttribute("aria-expanded", "true");
    this.cleanupRender = renderLinkedNote(
      body,
      target,
      this.view.state.doc.toString(),
      context,
      `${STRINGS.linkPreviewLabel}: ${sourceName}`,
      this.view.state.facet(taskStatusConfiguration),
      () => this.view.requestMeasure(),
    );
  }

  private dismiss(): void {
    this.cancelTimer();
    this.cleanupRender?.();
    this.cleanupRender = null;
    this.panel?.remove();
    this.panel = null;
    if (this.activeLink !== null) {
      this.restoreAttribute(
        this.activeLink,
        "aria-describedby",
        this.previousDescription,
      );
      this.restoreAttribute(
        this.activeLink,
        "aria-controls",
        this.previousControls,
      );
      this.restoreAttribute(
        this.activeLink,
        "aria-expanded",
        this.previousExpanded,
      );
    }
    this.activeLink = null;
    this.previousDescription = null;
    this.previousControls = null;
    this.previousExpanded = null;
  }

  private restoreAttribute(
    element: HTMLElement,
    name: string,
    value: string | null,
  ): void {
    if (value === null) {
      element.removeAttribute(name);
    } else {
      element.setAttribute(name, value);
    }
  }

  private readonly onPointerOver = (event: PointerEvent) => {
    const link = this.previewLink(event.target);
    if (link !== null) {
      this.schedule(link);
    }
  };

  private readonly onPointerOut = (event: PointerEvent) => {
    const link = this.previewLink(event.target);
    const next = this.previewLink(event.relatedTarget);
    if (
      (link !== null &&
        next !== link &&
        !this.panelContains(event.relatedTarget)) ||
      (this.panelContains(event.target) &&
        next !== this.activeLink &&
        !this.panelContains(event.relatedTarget))
    ) {
      this.dismiss();
    }
  };

  private readonly onFocusIn = (event: FocusEvent) => {
    const link = this.previewLink(event.target);
    if (link?.dataset.previewTarget !== undefined) {
      this.focusedTarget = link.dataset.previewTarget;
    }
  };

  private readonly onFocusOut = (event: FocusEvent) => {
    const link = this.previewLink(event.target);
    if (
      (link !== null && !this.panelContains(event.relatedTarget)) ||
      (this.panelContains(event.target) &&
        this.previewLink(event.relatedTarget) !== this.activeLink &&
        !this.panelContains(event.relatedTarget))
    ) {
      this.dismiss();
      this.focusedTarget = null;
    }
  };

  private readonly onGeometryChanged = () => this.dismiss();

  private readonly onScroll = (event: Event) => {
    if (!this.panelContains(event.target)) {
      this.dismiss();
    }
  };

  handleKeydown(event: KeyboardEvent): boolean {
    if (
      event.key === "Escape" &&
      (this.panel !== null || this.timer !== null)
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.dismiss();
      return true;
    }
    const link =
      this.previewLink(event.target) ??
      [
        ...this.view.dom.querySelectorAll<HTMLElement>("[data-preview-target]"),
      ].find(
        (candidate) => candidate.dataset.previewTarget === this.focusedTarget,
      ) ??
      null;
    if (
      link !== null &&
      event.key.toLocaleLowerCase() === "p" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      this.show(link);
      return true;
    }
    return false;
  }

  update(update: ViewUpdate): void {
    if (
      update.docChanged ||
      update.geometryChanged ||
      update.viewportChanged ||
      update.state.facet(taskStatusConfiguration) !==
        update.startState.facet(taskStatusConfiguration) ||
      update.state.field(wikilinkContext, false) !==
        update.startState.field(wikilinkContext, false)
    ) {
      this.dismiss();
    }
  }

  destroy(): void {
    this.dismiss();
    this.focusedTarget = null;
    this.view.dom.removeEventListener("pointerover", this.onPointerOver);
    this.view.dom.removeEventListener("pointerout", this.onPointerOut);
    this.view.dom.removeEventListener("focusin", this.onFocusIn);
    this.view.dom.removeEventListener("focusout", this.onFocusOut);
    window.removeEventListener("resize", this.onGeometryChanged);
    window.removeEventListener("scroll", this.onScroll, true);
  }
}

const linkPreviewPlugin = ViewPlugin.fromClass(LinkPreviewController);

// registry-exempt keydown: P and Escape operate only on a focused
// rendered link preview and do not define application commands.
const linkPreviewKeys = EditorView.domEventHandlers({
  keydown(event, view) {
    return view.plugin(linkPreviewPlugin)?.handleKeydown(event) ?? false;
  },
});

function atomicDecorations(view: EditorView): DecorationSet {
  const ranges: ReturnType<Decoration["range"]>[] = [];
  const inline = view.plugin(enginePlugin)?.decorations;
  const block = view.state.field(blockEngineField, false)?.decorations;
  for (const set of [inline, block]) {
    if (set === undefined) {
      continue;
    }
    const cursor = set.iter();
    while (cursor.value !== null) {
      if ((cursor.value.spec as { atomic?: boolean }).atomic === true) {
        ranges.push(cursor.value.range(cursor.from, cursor.to));
      }
      cursor.next();
    }
  }
  return Decoration.set(ranges, true);
}

const calloutPointerMapping = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (event.button !== 0 || !(event.target instanceof Element)) {
      return false;
    }
    const directLine = event.target.closest<HTMLElement>(
      ".cm-line.cm-skr-rich-callout",
    );
    const lineElement =
      directLine ??
      [
        ...view.contentDOM.querySelectorAll<HTMLElement>(
          ".cm-line.cm-skr-rich-callout",
        ),
      ].find((line) => {
        const rect = line.getBoundingClientRect();
        return (
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom
        );
      }) ??
      null;
    if (lineElement === null || !view.dom.contains(lineElement)) {
      return false;
    }
    const sourceLine = view.state.doc.lineAt(view.posAtDOM(lineElement, 0));
    const lineRect = lineElement.getBoundingClientRect();
    const coordinatePosition = view.posAtCoords({
      x: event.clientX,
      y: lineRect.top + lineRect.height / 2,
    });
    const anchor = Math.min(
      sourceLine.to,
      Math.max(sourceLine.from, coordinatePosition ?? sourceLine.from),
    );
    event.preventDefault();
    view.focus();
    view.dispatch({ selection: { anchor }, scrollIntoView: true });
    return true;
  },
});

const engineTheme = EditorView.baseTheme({
  ".cm-skr-heading": {
    fontFamily: "var(--skr-font-prose)",
    textWrap: "balance",
  },
  ".cm-skr-heading-1": {
    color: "var(--skr-heading)",
    fontSize: "1.75em",
    fontWeight: "700",
    lineHeight: "1.25",
    letterSpacing: "-0.015em",
    paddingTop: "1.5rem",
    paddingBottom: "0.5rem",
    borderBottom: "1px solid var(--skr-border)",
  },
  ".cm-skr-heading-2": {
    color: "var(--skr-heading)",
    fontSize: "1.5em",
    fontWeight: "700",
    lineHeight: "1.3",
    letterSpacing: "-0.01em",
    paddingTop: "1.25rem",
    paddingBottom: "0.375rem",
  },
  ".cm-skr-heading-3": {
    color: "var(--skr-heading)",
    fontSize: "1.25em",
    fontWeight: "700",
    lineHeight: "1.35",
    letterSpacing: "-0.005em",
    paddingTop: "1rem",
    paddingBottom: "0.25rem",
  },
  ".cm-skr-heading-4": {
    color: "var(--skr-heading)",
    fontSize: "1.125em",
    fontWeight: "700",
    lineHeight: "1.4",
    letterSpacing: "0",
    paddingTop: "1rem",
    paddingBottom: "0.125rem",
  },
  ".cm-skr-heading-5": {
    color: "var(--skr-heading-subtle)",
    fontSize: "1em",
    fontWeight: "700",
    lineHeight: "1.5",
    letterSpacing: "0",
    paddingTop: "1rem",
    paddingBottom: "0.125rem",
  },
  ".cm-skr-heading-6": {
    color: "var(--skr-heading-subtle)",
    fontSize: "0.875em",
    fontWeight: "700",
    lineHeight: "1.5",
    letterSpacing: "0.06em",
    paddingTop: "1rem",
    paddingBottom: "0.125rem",
    textTransform: "uppercase",
  },
  ".cm-skr-setext-underline": { color: "var(--skr-text-muted)" },
  ".cm-skr-reveal-marker": {
    display: "inline-block",
    maxWidth: "0",
    overflow: "visible",
    color: "var(--skr-text-muted)",
    opacity: "0",
    verticalAlign: "bottom",
    whiteSpace: "pre",
  },
  ".cm-skr-reveal-marker-active": {
    maxWidth: "7ch",
    opacity: "1",
  },
  ".cm-skr-emphasis": { fontStyle: "italic" },
  ".cm-skr-strong": { fontWeight: "700" },
  ".cm-skr-strikethrough": {
    color: "var(--skr-text-muted)",
    textDecoration: "line-through",
  },
  ".cm-skr-link, .cm-skr-url": {
    color: "var(--skr-link)",
    textDecoration: "underline",
    textUnderlineOffset: "0.15em",
  },
  ".cm-skr-link-label": { color: "var(--skr-link)" },
  ".cm-skr-wikilink": { color: "var(--skr-link)" },
  ".cm-skr-wikilink-target, .cm-skr-wikilink-alias": {
    textDecoration: "underline",
  },
  '.cm-skr-wikilink[data-resolved="false"]': {
    color: "var(--skr-text-muted)",
    textDecorationStyle: "dashed",
  },
  '.cm-skr-wikilink[data-resolved="false"] .cm-skr-wikilink-target': {
    textDecorationStyle: "dashed",
  },
  ".cm-skr-embed": {
    boxSizing: "border-box",
    display: "inline-flex",
    flexDirection: "column",
    width: "100%",
    margin: "0.35rem 0",
    paddingLeft: "0.75rem",
    borderLeft: "3px solid var(--skr-accent)",
    backgroundColor: "var(--skr-surface-subtle)",
    verticalAlign: "top",
  },
  ".cm-skr-embed-header": {
    display: "block",
    padding: "0.35rem 0.6rem",
    color: "var(--skr-text-muted)",
    fontFamily: "var(--skr-font-interface)",
    fontSize: "0.8125em",
    fontWeight: "400",
  },
  ".cm-skr-embed-body": { display: "block" },
  ".cm-skr-embed-body > .cm-editor": { backgroundColor: "transparent" },
  ".cm-skr-embed-notice": {
    padding: "0.5rem 0.6rem",
    color: "var(--skr-text-muted)",
    fontStyle: "italic",
  },
  ".cm-skr-link-preview": {
    position: "fixed",
    zIndex: "40",
    boxSizing: "border-box",
    width: "min(22rem, calc(100vw - 1.5rem))",
    maxHeight: "16rem",
    overflow: "auto",
    border: "1px solid var(--skr-border)",
    borderTop: "3px solid var(--skr-accent)",
    borderRadius: "0.65rem",
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface-raised)",
    boxShadow: "var(--skr-shadow)",
  },
  ".cm-skr-link-preview-header": {
    position: "sticky",
    top: "0",
    zIndex: "1",
    padding: "0.45rem 0.65rem",
    borderBottom: "1px solid var(--skr-border)",
    color: "var(--skr-accent)",
    backgroundColor: "var(--skr-accent-subtle)",
    fontSize: "0.8125em",
    fontWeight: "600",
  },
  ".cm-skr-link-preview-body": { padding: "0.35rem 0.55rem" },
  ".cm-skr-list-mark": { color: "var(--skr-accent)" },
  ".cm-skr-task-control": {
    position: "relative",
    display: "inline-flex",
    verticalAlign: "text-bottom",
    margin: "0 0.15em",
    color: "var(--skr-task-color, var(--skr-accent))",
  },
  ".cm-skr-task-checkbox": {
    boxSizing: "border-box",
    display: "inline-grid",
    placeItems: "center",
    width: "1em",
    height: "1em",
    padding: "0",
    color: "inherit",
    backgroundColor: "transparent",
    border: "1.5px solid var(--skr-border-strong)",
    borderRadius: "3px",
    cursor: "pointer",
    userSelect: "none",
  },
  ".cm-skr-task-checkbox:focus-visible, .cm-skr-task-palette:focus-visible": {
    outline: "2px solid var(--skr-focus)",
    outlineOffset: "2px",
  },
  ".cm-skr-task-glyph": {
    fontSize: "0.78em",
    fontWeight: "800",
    lineHeight: "1",
  },
  '.cm-skr-task-checkbox[data-category="IN_PROGRESS"]': {
    borderColor: "currentColor",
    backgroundColor: "color-mix(in srgb, currentColor 18%, var(--skr-surface))",
  },
  '.cm-skr-task-checkbox[data-category="ON_HOLD"]': {
    borderColor: "currentColor",
    borderStyle: "dashed",
    backgroundColor: "color-mix(in srgb, currentColor 12%, var(--skr-surface))",
  },
  '.cm-skr-task-checkbox[data-category="DONE"]': {
    color: "var(--skr-surface)",
    backgroundColor: "var(--skr-task-color, var(--skr-success))",
    borderColor: "var(--skr-task-color, var(--skr-success))",
  },
  '.cm-skr-task-checkbox[data-category="CANCELLED"]': {
    borderColor: "currentColor",
    opacity: "0.72",
  },
  '.cm-skr-task-checkbox[data-category="NON_TASK"]': {
    borderColor: "transparent",
    borderRadius: "0",
  },
  '.cm-skr-task[data-category="DONE"]': {
    color: "var(--skr-text-muted)",
    textDecoration: "line-through",
    textDecorationThickness: "1px",
  },
  '.cm-skr-task[data-category="CANCELLED"]': {
    color: "var(--skr-text-muted)",
    textDecoration: "line-through",
    opacity: "0.68",
  },
  ".cm-skr-task-palette": {
    position: "absolute",
    zIndex: "20",
    top: "calc(100% + 0.35rem)",
    left: "-0.4rem",
    boxSizing: "border-box",
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(7.5rem, 1fr))",
    gap: "0.15rem",
    width: "max-content",
    maxWidth: "min(22rem, calc(100vw - 2rem))",
    maxHeight: "15rem",
    padding: "0.35rem",
    overflow: "auto",
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface-raised)",
    border: "1px solid var(--skr-border)",
    borderRadius: "0.5rem",
    boxShadow: "var(--skr-shadow)",
  },
  ".cm-skr-task-palette[hidden]": { display: "none" },
  ".cm-skr-task-option": {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    minWidth: "0",
    padding: "0.28rem 0.42rem",
    borderRadius: "0.3rem",
    cursor: "pointer",
    transition: "background-color 50ms linear, color 50ms linear",
  },
  ".cm-skr-task-option:hover, .cm-skr-task-option-active": {
    backgroundColor: "var(--skr-accent-subtle)",
  },
  ".cm-skr-task-option-glyph": {
    display: "inline-grid",
    placeItems: "center",
    flex: "0 0 1.1rem",
    color: "var(--skr-task-option-color, var(--skr-accent))",
    fontWeight: "800",
  },
  ".cm-skr-task-option-name": {
    overflow: "hidden",
    fontSize: "0.82em",
    lineHeight: "1.3",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  ".cm-skr-inline-code": {
    fontFamily: "var(--skr-font-mono)",
    fontSize: "0.9em",
    fontWeight: "400",
    backgroundColor: "var(--skr-code-surface)",
    borderRadius: "3px",
    padding: "0 2px",
  },
  ".cm-skr-table-row": {
    boxSizing: "border-box",
    display: "grid",
    width: "100%",
    overflowX: "auto",
    borderLeft: "1px solid var(--skr-border)",
    borderRight: "1px solid var(--skr-border)",
    backgroundColor: "var(--skr-surface)",
  },
  ".cm-skr-table-first": {
    borderTop: "1px solid var(--skr-border)",
    borderTopLeftRadius: "0.375rem",
    borderTopRightRadius: "0.375rem",
  },
  ".cm-skr-table-last": {
    borderBottom: "1px solid var(--skr-border)",
    borderBottomLeftRadius: "0.375rem",
    borderBottomRightRadius: "0.375rem",
  },
  ".cm-skr-table-header": {
    borderBottom: "1px solid var(--skr-border)",
    backgroundColor: "var(--skr-surface-subtle)",
    fontFamily: "var(--skr-font-interface)",
    fontSize: "0.875em",
    fontWeight: "600",
  },
  ".cm-skr-table-cell": {
    boxSizing: "border-box",
    minWidth: "0",
    padding: "0.375rem 0.625rem",
    overflowWrap: "anywhere",
    borderRight: "1px solid var(--skr-border)",
  },
  ".cm-skr-table-cell:last-child": { borderRight: "0" },
  ".cm-skr-table-separator": { display: "none" },
  ".cm-skr-code-block": {
    boxSizing: "border-box",
    position: "relative",
    overflowX: "auto",
    backgroundColor: "var(--skr-code-surface)",
    boxShadow:
      "-1rem 0 0 var(--skr-code-surface), 1rem 0 0 var(--skr-code-surface)",
  },
  ".cm-line:not(.cm-skr-code-block) + .cm-skr-code-block, .cm-skr-code-block:first-child":
    {
      paddingTop: "0.75rem",
      overflow: "visible",
      borderTopLeftRadius: "0.375rem",
      borderTopRightRadius: "0.375rem",
    },
  ".cm-skr-code-block:has(+ .cm-line:not(.cm-skr-code-block)), .cm-skr-code-block:last-child":
    {
      paddingBottom: "0.75rem",
      borderBottomLeftRadius: "0.375rem",
      borderBottomRightRadius: "0.375rem",
    },
  ".cm-skr-code-fence, .cm-skr-code-info": {
    color: "var(--skr-text-muted)",
    opacity: "1",
  },
  ".cm-skr-code-info": { fontStyle: "italic" },
  ".cm-skr-code-copy": {
    position: "absolute",
    zIndex: "2",
    top: "0.5rem",
    right: "-0.5rem",
    minWidth: "4.5rem",
    padding: "0.2rem 0.45rem",
    color: "var(--skr-text)",
    backgroundColor:
      "color-mix(in srgb, var(--skr-surface-raised) 78%, transparent)",
    border: "1px solid var(--skr-border)",
    borderRadius: "0.3rem",
    opacity: "0",
    pointerEvents: "none",
  },
  ".cm-skr-code-block:hover .cm-skr-code-copy, .cm-skr-code-copy:focus-visible":
    {
      opacity: "1",
      pointerEvents: "auto",
    },
  ".cm-skr-blockquote": {
    color: "var(--skr-text-muted)",
    borderLeft: "3px solid var(--skr-border-strong)",
    paddingLeft: "1rem",
  },
  ".cm-skr-quote-mark": { color: "var(--skr-text-muted)" },
  ".cm-skr-callout-mark": { fontWeight: "700", color: "var(--skr-accent)" },
  '.cm-skr-callout-mark[data-callout="warning"]': {
    color: "var(--skr-warning)",
  },
  '.cm-skr-callout-mark[data-callout="danger"], .cm-skr-callout-mark[data-callout="error"]':
    { color: "var(--skr-danger)" },
  '.cm-skr-callout-mark[data-callout="tip"], .cm-skr-callout-mark[data-callout="success"]':
    { color: "var(--skr-success)" },
  ".cm-line.cm-skr-rich-callout": {
    "--skr-callout-color": "var(--skr-callout-blue)",
    boxSizing: "border-box",
    width: "calc(100% + 2rem + 3px)",
    marginLeft: "calc(-1rem - 3px)",
    marginRight: "-1rem",
    paddingInline: "1rem",
    overflow: "hidden",
    color: "var(--skr-text)",
    backgroundColor:
      "color-mix(in srgb, var(--skr-callout-color) var(--skr-callout-tint), var(--skr-surface))",
    borderLeft: "3px solid var(--skr-callout-color)",
  },
  '.cm-skr-rich-callout[data-accent="cyan"]': {
    "--skr-callout-color": "var(--skr-callout-cyan)",
  },
  '.cm-skr-rich-callout[data-accent="green"]': {
    "--skr-callout-color": "var(--skr-callout-green)",
  },
  '.cm-skr-rich-callout[data-accent="yellow"]': {
    "--skr-callout-color": "var(--skr-callout-yellow)",
  },
  '.cm-skr-rich-callout[data-accent="orange"]': {
    "--skr-callout-color": "var(--skr-callout-orange)",
  },
  '.cm-skr-rich-callout[data-accent="red"]': {
    "--skr-callout-color": "var(--skr-callout-red)",
  },
  '.cm-skr-rich-callout[data-accent="purple"]': {
    "--skr-callout-color": "var(--skr-callout-purple)",
  },
  '.cm-skr-rich-callout[data-accent="gray"]': {
    "--skr-callout-color": "var(--skr-callout-gray)",
  },
  '.cm-skr-rich-callout[data-callout-line="first"], .cm-skr-rich-callout[data-callout-line="only"]':
    {
      paddingTop: "0.75rem",
      color: "var(--skr-callout-color)",
      fontWeight: "700",
      borderTopRightRadius: "0.375rem",
    },
  '.cm-skr-rich-callout[data-callout-line="last"], .cm-skr-rich-callout[data-callout-line="only"]':
    {
      paddingBottom: "0.75rem",
      borderBottomRightRadius: "0.375rem",
    },
  ".cm-skr-callout-icon-host, .cm-skr-callout-icon": {
    display: "inline-flex",
    flex: "0 0 auto",
    color: "var(--skr-callout-color)",
  },
  ".cm-skr-callout-icon-host": { marginRight: "0.4rem" },
  ".cm-skr-tag": {
    color: "var(--skr-accent)",
    backgroundColor: "var(--skr-accent-subtle)",
    borderRadius: "8px",
    padding: "0 4px",
  },
  ".cm-skr-block-id": { color: "var(--skr-text-muted)" },
  ".cm-skr-frontmatter": {
    color: "var(--skr-text-muted)",
    fontFamily: "var(--skr-font-mono)",
    fontSize: "0.8125em",
    lineHeight: "1.5",
  },
  ".cm-skr-math-inline": { display: "inline-block", maxWidth: "100%" },
  ".cm-skr-math-block, .cm-skr-mermaid": {
    boxSizing: "border-box",
    width: "100%",
    overflow: "auto",
    padding: "0.75rem 1rem",
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface-subtle)",
    border: "1px solid var(--skr-border)",
    borderRadius: "0.5rem",
  },
  ".cm-skr-mermaid svg": { display: "block", maxWidth: "100%", margin: "auto" },
  ".cm-skr-render-error": {
    color: "var(--skr-danger)",
    backgroundColor: "var(--skr-danger-surface)",
    borderColor: "var(--skr-danger)",
    fontFamily: "var(--skr-font-mono)",
    whiteSpace: "pre-wrap",
  },
});

/**
 * The full decoration engine extension: the wikilink context field, the
 * view plugin interpreting the decoration table over visible ranges, and
 * the base theme for the table's classes.
 */
export function decorationEngine(
  initialContext?: WikilinkResolutionContext,
): Extension {
  return [
    initialContext === undefined
      ? wikilinkContext
      : wikilinkContext.init(() => initialContext),
    blockEngineField,
    enginePlugin,
    linkPreviewPlugin,
    linkPreviewKeys,
    EditorView.atomicRanges.of(atomicDecorations),
    calloutPointerMapping,
    engineTheme,
  ];
}

/** The live decoration set of a view running the engine; null without it. */
export function engineDecorations(view: EditorView): DecorationSet | null {
  const inline = view.plugin(enginePlugin)?.decorations;
  const block = view.state.field(blockEngineField, false)?.decorations;
  if (inline === undefined) {
    return block ?? null;
  }
  if (block === undefined || block.size === 0) {
    return inline;
  }
  const ranges: ReturnType<Decoration["range"]>[] = [];
  for (const set of [inline, block]) {
    const cursor = set.iter();
    while (cursor.value !== null) {
      ranges.push(cursor.value.range(cursor.from, cursor.to));
      cursor.next();
    }
  }
  return Decoration.set(ranges, true);
}

/** The state's current wikilink context, for callers outside the engine. */
export function currentWikilinkContext(
  state: EditorState,
): WikilinkResolutionContext {
  return state.field(wikilinkContext, false) ?? EMPTY_WIKILINK_CONTEXT;
}
