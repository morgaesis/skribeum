// The decoration engine: interprets the mapping table in `table.ts` over
// the Lezer syntax tree, synchronously inside the view plugin's update
// (decision 11), windowed to the visible ranges. It never touches the
// document; its one dispatch site (wikilink context updates) is annotated
// with `decorationOrigin` so the inertness guard in `decorationGuard.ts`
// asserts `docChanged === false` over everything the engine causes.

import { syntaxTree } from "@codemirror/language";
import {
  type EditorState,
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

function isBlockWidgetRule(rule: DecorationRule): boolean {
  return (
    rule.presentation.present === "widget" &&
    (rule.presentation.widget === "math-block" ||
      rule.presentation.widget === "mermaid-diagram")
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
      const blockquote =
        node.name === "Blockquote"
          ? node
          : node.name === "CalloutMark"
            ? (node.parent?.parent ?? null)
            : null;
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
  const built: BuiltDecoration[] = [];
  const seenLines = new Set<string>();

  const revealed = (rule: DecorationRule, node: SyntaxNode): boolean => {
    if (rule.reveal === "never" || selection.length === 0) {
      return false;
    }
    const scope =
      rule.reveal === "cursor-inside" && rule.presentation.present === "widget"
        ? node
        : (node.parent ?? node);
    let from = scope.from;
    let to = scope.to;
    if (rule.reveal === "cursor-line") {
      from = doc.lineAt(scope.from).from;
      to = doc.lineAt(Math.min(scope.to, doc.length)).to;
    }
    return selection.some((range) => range.to >= from && range.from <= to);
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
          const presentation = rule.presentation;
          if (presentation.present === "line") {
            const extraClass =
              "data-callout" in dynamic ? " cm-skr-callout" : "";
            const lineClass = presentation.class + extraClass;
            let position = Math.max(ref.from, window.from);
            const end = Math.min(ref.to, window.to);
            while (position <= end) {
              const line = doc.lineAt(position);
              const key = `${line.from} ${lineClass}${serializeAttributes(dynamic)}`;
              if (
                line.length <= LONG_LINE_DECORATION_LIMIT &&
                !seenLines.has(key)
              ) {
                seenLines.add(key);
                const spec: Parameters<typeof Decoration.line>[0] = {
                  class: lineClass,
                  skr: `line class=${JSON.stringify(lineClass)}${serializeAttributes(dynamic)}`,
                };
                if (Object.keys(dynamic).length > 0) {
                  spec.attributes = dynamic;
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
            (presentation.present === "hide" ||
              presentation.present === "widget") &&
            revealed(rule, node)
          ) {
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
            built.push({
              from: hideFrom,
              to: hideTo,
              decoration: Decoration.replace({
                skr: `hide node=${rule.node}`,
              }),
            });
          } else if (presentation.present === "widget") {
            const builtWidget = widgetFor(presentation.widget, node, doc);
            built.push({
              from: ref.from,
              to: ref.to,
              decoration: Decoration.replace({
                widget: builtWidget.widget,
                block: builtWidget.block,
                skr: `widget ${presentation.widget}${serializeAttributes(builtWidget.attributes)}`,
              }),
            });
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
  const ranges =
    view.visibleRanges.length > 0
      ? view.visibleRanges.map((range) => ({ from: range.from, to: range.to }))
      : [{ from: view.viewport.from, to: view.viewport.to }];
  return computeDecorations({
    doc: state.doc,
    tree: syntaxTree(state),
    table: splitTable(state.facet(decorationTable)).inline,
    selection: state.selection.ranges.map((range) => ({
      from: range.from,
      to: range.to,
    })),
    ranges,
    wikilinks: state.field(wikilinkContext, false) ?? EMPTY_WIKILINK_CONTEXT,
  });
}

function buildBlockDecorations(state: EditorState): DecorationSet {
  return computeDecorations({
    doc: state.doc,
    tree: syntaxTree(state),
    table: splitTable(state.facet(decorationTable)).block,
    selection: state.selection.ranges.map((range) => ({
      from: range.from,
      to: range.to,
    })),
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
        transaction.startState.facet(decorationTable)
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

const engineTheme = EditorView.baseTheme({
  ".cm-skr-heading": { fontWeight: "700" },
  ".cm-skr-heading-1": { fontSize: "1.6em" },
  ".cm-skr-heading-2": { fontSize: "1.4em" },
  ".cm-skr-heading-3": { fontSize: "1.25em" },
  ".cm-skr-heading-4": { fontSize: "1.1em" },
  ".cm-skr-heading-5": { fontSize: "1em" },
  ".cm-skr-heading-6": { fontSize: "1em", opacity: "0.85" },
  ".cm-skr-setext-underline": { opacity: "0.5" },
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
  ".cm-skr-embed": { backgroundColor: "var(--skr-accent-soft)" },
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
    fontFamily: "inherit",
    backgroundColor: "var(--skr-code-surface)",
    borderRadius: "3px",
    padding: "0 2px",
  },
  ".cm-skr-code-block": { backgroundColor: "var(--skr-code-surface)" },
  ".cm-skr-code-fence": { opacity: "0.5" },
  ".cm-skr-code-info": { opacity: "0.7", fontStyle: "italic" },
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
  ".cm-skr-tag": {
    color: "var(--skr-accent)",
    backgroundColor: "var(--skr-accent-soft)",
    borderRadius: "8px",
    padding: "0 4px",
  },
  ".cm-skr-block-id": { opacity: "0.5" },
  ".cm-skr-frontmatter": { opacity: "0.6" },
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
    fontFamily: "monospace",
    whiteSpace: "pre-wrap",
  },
});

/**
 * The full decoration engine extension: the wikilink context field, the
 * view plugin interpreting the decoration table over visible ranges, and
 * the base theme for the table's classes.
 */
export function decorationEngine(): Extension {
  return [wikilinkContext, blockEngineField, enginePlugin, engineTheme];
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
