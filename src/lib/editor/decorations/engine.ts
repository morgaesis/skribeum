// The decoration engine interprets the mapping table in `table.ts` over
// the Lezer syntax tree, windowed to the visible ranges. Bulk input remaps
// existing decorations for the initial paint and rebuilds them after three
// animation frames. The engine never touches the document; its dispatches
// are annotated with `decorationOrigin` so the inertness guard in
// `decorationGuard.ts` asserts `docChanged === false` over everything the
// engine causes.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  defaultHighlightStyle,
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
import { renderMath } from "../../rendering/math";
import { renderMermaid } from "../../rendering/mermaid";
import { STRINGS } from "../../strings";
import { bulkTextInputAnnotation } from "../bulkInput";
import { decorationOrigin } from "../decorationGuard";
import { codeLanguage } from "../markdown/codeLanguages";
import {
  obsidianMarkdownExtensions,
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
  resolveWikilinkTarget,
  type WikilinkResolutionContext,
} from "./wikilinks";

/**
 * Long-line safeguard: no decoration is computed for content on a line
 * longer than this many characters, so a pathological line (the 2MB
 * single-line corpus file) stays editable plain text instead of feeding
 * the decorator.
 */
export const LONG_LINE_DECORATION_LIMIT = 10_000;
export const EMBED_DEPTH_LIMIT = 4;

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

class TaskCheckboxWidget extends WidgetType {
  constructor(readonly marker: string) {
    super();
  }

  override eq(other: TaskCheckboxWidget): boolean {
    return other.marker === this.marker;
  }

  override toDOM(): HTMLElement {
    const box = document.createElement("span");
    box.className = "cm-skr-task-checkbox";
    for (const [name, value] of taskCheckboxAttributes(this.marker)) {
      box.setAttribute(name, value);
    }
    return box;
  }

  override ignoreEvent(): boolean {
    // The checkbox looks interactive but is text-inert at M2: events fall
    // through to the editor so clicking places the cursor.
    return false;
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
): EditorView {
  const nested = new EditorView({
    state: EditorState.create({
      doc: source,
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: obsidianMarkdownExtensions,
          codeLanguages: codeLanguage,
        }),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
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

class EmbedWidget extends WidgetType {
  constructor(
    readonly target: string,
    readonly rootSource: string,
    readonly context: WikilinkResolutionContext,
  ) {
    super();
  }

  override eq(other: EmbedWidget): boolean {
    return (
      other.target === this.target &&
      other.rootSource === this.rootSource &&
      other.context === this.context
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("span");
    host.className = "cm-skr-embed";
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

    const notice = (message: string) => {
      body.className = "cm-skr-embed-body cm-skr-embed-notice";
      body.setAttribute("role", "status");
      body.textContent = message;
    };
    if (resolution.kind === "unresolved") {
      notice(STRINGS.embedUnavailable);
      return host;
    }
    const depth = this.context.embedDepth ?? 0;
    if (depth >= EMBED_DEPTH_LIMIT) {
      notice(STRINGS.embedDepthLimit);
      return host;
    }
    const ancestry = this.context.embedAncestry ?? [];
    const directSelfEmbed = resolution.kind === "self" && depth === 0;
    if (
      resolvedPath.length > 0 &&
      ancestry.includes(resolvedPath) &&
      !directSelfEmbed
    ) {
      notice(STRINGS.embedCycle);
      return host;
    }
    const load =
      resolution.kind === "self"
        ? Promise.resolve(this.rootSource)
        : (this.context.loadNote?.(resolvedPath) ?? Promise.resolve(null));
    body.textContent = STRINGS.embedLoading;
    void load.then((source) => {
      if (!host.isConnected && !document.body.contains(host)) {
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
      body.textContent = "";
      nestedMarkdownView(
        body,
        selected,
        {
          ...this.context,
          currentPath: resolvedPath,
          embedDepth: depth + 1,
          embedAncestry:
            resolvedPath.length === 0 ? ancestry : [...ancestry, resolvedPath],
        },
        `${STRINGS.embedLabel}: ${sourceName}`,
      );
      view.requestMeasure();
    });
    return host;
  }

  override destroy(dom: HTMLElement): void {
    const body = dom.querySelector<HTMLElement>(".cm-skr-embed-body");
    if (body !== null) {
      nestedViews.get(body)?.destroy();
    }
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
  return markerText.length >= 3 ? (markerText[1] ?? " ") : " ";
}

function taskCheckboxAttributes(marker: string): [string, string][] {
  const checked = marker === "x" || marker === "X";
  const custom = !checked && marker !== " ";
  const label = checked
    ? STRINGS.taskCheckboxCheckedLabel
    : custom
      ? STRINGS.taskCheckboxOtherLabel
      : STRINGS.taskCheckboxUncheckedLabel;
  const attributes: [string, string][] = [
    ["role", "checkbox"],
    ["aria-checked", checked ? "true" : custom ? "mixed" : "false"],
    ["aria-disabled", "true"],
    ["aria-label", label],
  ];
  if (custom) {
    attributes.push(["data-task", marker]);
  }
  return attributes;
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
): Record<string, string> | null {
  switch (rule.dynamic) {
    case "wikilink-resolution": {
      const target = node.getChild("WikilinkTarget");
      if (target === null) {
        return {};
      }
      const resolution = resolveWikilinkTarget(
        doc.sliceString(target.from, target.to),
        wikilinks,
      );
      return {
        "data-resolved": resolution.kind === "unresolved" ? "false" : "true",
      };
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
        dynamicAttributes(rule, node, doc, wikilinks) === null
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
): Decoration {
  const attributes = { ...(presentation.attributes ?? {}), ...dynamic };
  const spec: Parameters<typeof Decoration.mark>[0] = {
    class: presentation.class,
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
): { widget: WidgetType; block: boolean; attributes: Record<string, string> } {
  switch (widget) {
    case "task-checkbox": {
      const marker = taskMarkerCharacter(doc.sliceString(node.from, node.to));
      return {
        widget: new TaskCheckboxWidget(marker),
        block: false,
        attributes: Object.fromEntries(taskCheckboxAttributes(marker)),
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
        widget: new EmbedWidget(targetText, doc.toString(), wikilinks),
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
  const activeReveal =
    options.activeReveal === undefined
      ? findActiveReveal(doc, tree, table, selection, wikilinks)
      : options.activeReveal;
  const built: BuiltDecoration[] = [];
  const seenLines = new Set<string>();

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
          const dynamic = dynamicAttributes(rule, node, doc, wikilinks);
          if (dynamic === null) {
            continue;
          }
          if (
            activeReveal?.descendants === true &&
            ref.from >= activeReveal.from &&
            ref.to <= activeReveal.to
          ) {
            continue;
          }
          const presentation = rule.presentation;
          if (presentation.present === "line") {
            const extraClass =
              "data-callout" in dynamic ? " cm-skr-callout" : "";
            const lineClass = presentation.class + extraClass;
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
          const revealedNow = revealed(rule, node);
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
            built.push({
              from: ref.from,
              to: ref.to,
              decoration: markDecoration(presentation, dynamic),
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
  const selection = state.facet(sourceRevealEnabled)
    ? [{ from: state.selection.main.from, to: state.selection.main.to }]
    : [];
  const wikilinks =
    state.field(wikilinkContext, false) ?? EMPTY_WIKILINK_CONTEXT;
  const activeReveal = findActiveReveal(
    state.doc,
    syntaxTree(state),
    table,
    selection,
    wikilinks,
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
    activeReveal,
  });
}

function buildBlockDecorations(state: EditorState): DecorationSet {
  const table = state.facet(decorationTable);
  const selection = state.facet(sourceRevealEnabled)
    ? [{ from: state.selection.main.from, to: state.selection.main.to }]
    : [];
  const wikilinks =
    state.field(wikilinkContext, false) ?? EMPTY_WIKILINK_CONTEXT;
  return computeDecorations({
    doc: state.doc,
    tree: syntaxTree(state),
    table: splitTable(table).block,
    selection,
    wikilinks,
    activeReveal: findActiveReveal(
      state.doc,
      syntaxTree(state),
      table,
      selection,
      wikilinks,
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
    const lineElement = event.target.closest<HTMLElement>(
      ".cm-line.cm-skr-rich-callout",
    );
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
    lineHeight: "1.22",
    textWrap: "balance",
  },
  ".cm-skr-heading-1": {
    color: "var(--skr-heading-1)",
    fontSize: "2.05em",
    fontWeight: "720",
    letterSpacing: "-0.028em",
    paddingTop: "0.6em",
    paddingBottom: "0.32em",
    borderBottom: "1px solid var(--skr-border)",
  },
  ".cm-skr-heading-2": {
    color: "var(--skr-heading-2)",
    fontSize: "1.7em",
    fontWeight: "690",
    letterSpacing: "-0.02em",
    paddingTop: "0.68em",
    paddingBottom: "0.2em",
  },
  ".cm-skr-heading-3": {
    color: "var(--skr-heading-3)",
    fontSize: "1.4em",
    fontWeight: "660",
    letterSpacing: "-0.012em",
    paddingTop: "0.62em",
    paddingBottom: "0.14em",
  },
  ".cm-skr-heading-4": {
    color: "var(--skr-heading-4)",
    fontSize: "1.18em",
    fontWeight: "630",
    letterSpacing: "0.005em",
    paddingTop: "0.54em",
  },
  ".cm-skr-heading-5": {
    color: "var(--skr-heading-5)",
    fontSize: "1.02em",
    fontWeight: "600",
    letterSpacing: "0.055em",
    paddingTop: "0.48em",
    textTransform: "uppercase",
  },
  ".cm-skr-heading-6": {
    color: "var(--skr-heading-6)",
    fontSize: "0.92em",
    fontWeight: "570",
    letterSpacing: "0.075em",
    paddingTop: "0.42em",
    textTransform: "uppercase",
  },
  ".cm-skr-setext-underline": { color: "var(--skr-text-muted)" },
  ".cm-skr-reveal-marker": {
    display: "inline-block",
    maxWidth: "0",
    overflow: "hidden",
    color: "var(--skr-text-muted)",
    opacity: "0",
    verticalAlign: "bottom",
    whiteSpace: "pre",
    transition: "max-width 120ms ease-out, opacity 90ms ease-out",
  },
  ".cm-skr-reveal-marker-active": {
    maxWidth: "7ch",
    opacity: "1",
  },
  ".cm-skr-emphasis": { fontStyle: "italic" },
  ".cm-skr-strong": { fontWeight: "700" },
  ".cm-skr-strikethrough": { textDecoration: "line-through" },
  ".cm-skr-link, .cm-skr-url": {
    color: "var(--skr-link)",
    textDecoration: "underline",
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
    fontSize: "0.8em",
    fontWeight: "700",
  },
  ".cm-skr-embed-body": { display: "block" },
  ".cm-skr-embed-body > .cm-editor": { backgroundColor: "transparent" },
  ".cm-skr-embed-notice": {
    padding: "0.5rem 0.6rem",
    color: "var(--skr-text-muted)",
    fontStyle: "italic",
  },
  ".cm-skr-list-mark": { color: "var(--skr-accent)" },
  ".cm-skr-task-checkbox": {
    display: "inline-block",
    width: "0.9em",
    height: "0.9em",
    verticalAlign: "text-bottom",
    border: "1.5px solid var(--skr-text-muted)",
    borderRadius: "3px",
    margin: "0 0.15em",
  },
  '.cm-skr-task-checkbox[aria-checked="true"]': {
    backgroundColor: "var(--skr-accent)",
    borderColor: "var(--skr-accent)",
  },
  '.cm-skr-task-checkbox[aria-checked="mixed"]': {
    backgroundColor: "var(--skr-text-muted)",
    borderColor: "var(--skr-text-muted)",
  },
  ".cm-skr-inline-code": {
    fontFamily: "var(--skr-font-mono)",
    backgroundColor: "var(--skr-code-surface)",
    borderRadius: "3px",
    padding: "0 2px",
  },
  ".cm-skr-table-row": {
    boxSizing: "border-box",
    display: "grid",
    width: "100%",
    overflow: "hidden",
    borderLeft: "1px solid var(--skr-border)",
    borderRight: "1px solid var(--skr-border)",
    backgroundColor: "var(--skr-surface)",
  },
  ".cm-skr-table-first": {
    borderTop: "1px solid var(--skr-border)",
    borderTopLeftRadius: "0.35rem",
    borderTopRightRadius: "0.35rem",
  },
  ".cm-skr-table-last": {
    borderBottom: "1px solid var(--skr-border)",
    borderBottomLeftRadius: "0.35rem",
    borderBottomRightRadius: "0.35rem",
  },
  ".cm-skr-table-header": {
    borderBottom: "2px solid var(--skr-border)",
    backgroundColor: "var(--skr-surface-subtle)",
  },
  ".cm-skr-table-cell": {
    boxSizing: "border-box",
    minWidth: "0",
    padding: "0.35rem 0.55rem",
    overflowWrap: "anywhere",
    borderRight: "1px solid var(--skr-border)",
  },
  ".cm-skr-table-cell:last-child": { borderRight: "0" },
  ".cm-skr-table-separator": { display: "none" },
  ".cm-skr-code-block": {
    position: "relative",
    backgroundColor: "var(--skr-code-surface)",
  },
  ".cm-skr-code-fence": { opacity: "0.28" },
  ".cm-skr-code-info": { opacity: "0.38", fontStyle: "italic" },
  ".cm-skr-code-copy": {
    position: "absolute",
    zIndex: "2",
    top: "0.2rem",
    right: "0.35rem",
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
    borderLeft: "3px solid var(--skr-border)",
    paddingLeft: "0.5em",
  },
  ".cm-skr-quote-mark": { color: "var(--skr-text-muted)" },
  ".cm-skr-callout": { backgroundColor: "var(--skr-accent-soft)" },
  '.cm-skr-callout[data-callout="warning"]': {
    backgroundColor: "var(--skr-warning-surface)",
    borderLeftColor: "var(--skr-warning)",
  },
  '.cm-skr-callout[data-callout="danger"], .cm-skr-callout[data-callout="error"]':
    {
      backgroundColor: "var(--skr-danger-surface)",
      borderLeftColor: "var(--skr-danger)",
    },
  '.cm-skr-callout[data-callout="tip"], .cm-skr-callout[data-callout="success"]':
    {
      backgroundColor: "var(--skr-success-surface)",
      borderLeftColor: "var(--skr-success)",
    },
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
    paddingLeft: "0.7rem",
    paddingRight: "0.7rem",
    color: "var(--skr-text)",
    backgroundColor:
      "color-mix(in srgb, var(--skr-callout-color) 10%, var(--skr-surface))",
    borderLeft: "4px solid var(--skr-callout-color)",
    borderRight:
      "1px solid color-mix(in srgb, var(--skr-callout-color) 45%, var(--skr-border))",
  },
  '.cm-skr-rich-callout[data-accent="cyan"]': {
    "--skr-callout-color": "var(--skr-callout-cyan)",
  },
  '.cm-skr-rich-callout[data-accent="green"]': {
    "--skr-callout-color": "var(--skr-success)",
  },
  '.cm-skr-rich-callout[data-accent="yellow"]': {
    "--skr-callout-color": "var(--skr-callout-yellow)",
  },
  '.cm-skr-rich-callout[data-accent="orange"]': {
    "--skr-callout-color": "var(--skr-callout-orange)",
  },
  '.cm-skr-rich-callout[data-accent="red"]': {
    "--skr-callout-color": "var(--skr-danger)",
  },
  '.cm-skr-rich-callout[data-accent="purple"]': {
    "--skr-callout-color": "var(--skr-callout-purple)",
  },
  '.cm-skr-rich-callout[data-accent="gray"]': {
    "--skr-callout-color": "var(--skr-text-muted)",
  },
  '.cm-skr-rich-callout[data-callout-line="first"], .cm-skr-rich-callout[data-callout-line="only"]':
    {
      paddingTop: "0.5rem",
      color: "var(--skr-callout-color)",
      fontWeight: "700",
      borderTop:
        "1px solid color-mix(in srgb, var(--skr-callout-color) 45%, var(--skr-border))",
      borderTopLeftRadius: "0.45rem",
      borderTopRightRadius: "0.45rem",
    },
  '.cm-skr-rich-callout[data-callout-line="last"], .cm-skr-rich-callout[data-callout-line="only"]':
    {
      paddingBottom: "0.65rem",
      borderBottom:
        "1px solid color-mix(in srgb, var(--skr-callout-color) 45%, var(--skr-border))",
      borderBottomLeftRadius: "0.45rem",
      borderBottomRightRadius: "0.45rem",
    },
  ".cm-skr-callout-icon-host, .cm-skr-callout-icon": {
    display: "inline-flex",
    color: "var(--skr-callout-color)",
  },
  ".cm-skr-callout-icon-host": { marginRight: "0.4rem" },
  ".cm-skr-tag": {
    color: "var(--skr-accent)",
    backgroundColor: "var(--skr-accent-soft)",
    borderRadius: "8px",
    padding: "0 4px",
  },
  ".cm-skr-block-id": { color: "var(--skr-text-muted)" },
  ".cm-skr-frontmatter": {
    color: "var(--skr-text-muted)",
    fontFamily: "var(--skr-font-mono)",
    fontSize: "0.88em",
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
