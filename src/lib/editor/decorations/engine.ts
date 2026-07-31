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
import { STRINGS } from "../../strings";
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
export function ruleMatches(rule: DecorationRule, node: SyntaxNode): boolean {
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
      rule.reveal === "cursor-inside" && rule.node === "TaskMarker"
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
          if (!ruleMatches(rule, node)) {
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
            const marker = taskMarkerCharacter(
              doc.sliceString(ref.from, ref.to),
            );
            const attributes = Object.fromEntries(
              taskCheckboxAttributes(marker),
            );
            built.push({
              from: ref.from,
              to: ref.to,
              decoration: Decoration.replace({
                widget: new TaskCheckboxWidget(marker),
                skr: `widget ${presentation.widget}${serializeAttributes(attributes)}`,
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
    table: state.facet(decorationTable),
    selection: state.selection.ranges.map((range) => ({
      from: range.from,
      to: range.to,
    })),
    ranges,
    wikilinks: state.field(wikilinkContext, false) ?? EMPTY_WIKILINK_CONTEXT,
  });
}

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

    constructor(view: EditorView) {
      this.decorations = buildViewDecorations(view);
    }

    update(update: ViewUpdate): void {
      if (needsRebuild(update)) {
        this.decorations = buildViewDecorations(update.view);
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
    color: "#2563eb",
    textDecoration: "underline",
  },
  ".cm-skr-link-label": { color: "#2563eb" },
  ".cm-skr-wikilink": { color: "#2563eb" },
  ".cm-skr-wikilink-target, .cm-skr-wikilink-alias": {
    textDecoration: "underline",
  },
  '.cm-skr-wikilink[data-resolved="false"]': {
    color: "#6b7280",
    textDecorationStyle: "dashed",
  },
  '.cm-skr-wikilink[data-resolved="false"] .cm-skr-wikilink-target': {
    textDecorationStyle: "dashed",
  },
  ".cm-skr-embed": { backgroundColor: "rgba(37, 99, 235, 0.08)" },
  ".cm-skr-list-mark": { color: "#9333ea" },
  ".cm-skr-task-checkbox": {
    display: "inline-block",
    width: "0.9em",
    height: "0.9em",
    verticalAlign: "text-bottom",
    border: "1.5px solid #6b7280",
    borderRadius: "3px",
    margin: "0 0.15em",
  },
  '.cm-skr-task-checkbox[aria-checked="true"]': {
    backgroundColor: "#2563eb",
    borderColor: "#2563eb",
  },
  '.cm-skr-task-checkbox[aria-checked="mixed"]': {
    backgroundColor: "#9ca3af",
    borderColor: "#6b7280",
  },
  ".cm-skr-inline-code": {
    fontFamily: "inherit",
    backgroundColor: "rgba(0, 0, 0, 0.06)",
    borderRadius: "3px",
    padding: "0 2px",
  },
  ".cm-skr-code-block": { backgroundColor: "rgba(0, 0, 0, 0.04)" },
  ".cm-skr-code-fence": { opacity: "0.5" },
  ".cm-skr-code-info": { opacity: "0.7", fontStyle: "italic" },
  ".cm-skr-blockquote": {
    borderLeft: "3px solid #d1d5db",
    paddingLeft: "0.5em",
  },
  ".cm-skr-quote-mark": { color: "#9ca3af" },
  ".cm-skr-callout": { backgroundColor: "rgba(37, 99, 235, 0.05)" },
  '.cm-skr-callout[data-callout="warning"]': {
    backgroundColor: "rgba(217, 119, 6, 0.08)",
    borderLeftColor: "#d97706",
  },
  '.cm-skr-callout[data-callout="danger"], .cm-skr-callout[data-callout="error"]':
    {
      backgroundColor: "rgba(220, 38, 38, 0.08)",
      borderLeftColor: "#dc2626",
    },
  '.cm-skr-callout[data-callout="tip"], .cm-skr-callout[data-callout="success"]':
    {
      backgroundColor: "rgba(22, 163, 74, 0.08)",
      borderLeftColor: "#16a34a",
    },
  ".cm-skr-callout-mark": { fontWeight: "700", color: "#2563eb" },
  '.cm-skr-callout-mark[data-callout="warning"]': { color: "#d97706" },
  '.cm-skr-callout-mark[data-callout="danger"], .cm-skr-callout-mark[data-callout="error"]':
    { color: "#dc2626" },
  '.cm-skr-callout-mark[data-callout="tip"], .cm-skr-callout-mark[data-callout="success"]':
    { color: "#16a34a" },
  ".cm-skr-tag": {
    color: "#7c3aed",
    backgroundColor: "rgba(124, 58, 237, 0.08)",
    borderRadius: "8px",
    padding: "0 4px",
  },
  ".cm-skr-block-id": { opacity: "0.5" },
  ".cm-skr-frontmatter": { opacity: "0.6" },
});

/**
 * The full decoration engine extension: the wikilink context field, the
 * view plugin interpreting the decoration table over visible ranges, and
 * the base theme for the table's classes.
 */
export function decorationEngine(): Extension {
  return [wikilinkContext, enginePlugin, engineTheme];
}

/** The live decoration set of a view running the engine; null without it. */
export function engineDecorations(view: EditorView): DecorationSet | null {
  return view.plugin(enginePlugin)?.decorations ?? null;
}

/** The state's current wikilink context, for callers outside the engine. */
export function currentWikilinkContext(
  state: EditorState,
): WikilinkResolutionContext {
  return state.field(wikilinkContext, false) ?? EMPTY_WIKILINK_CONTEXT;
}
