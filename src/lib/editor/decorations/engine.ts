// The decoration engine interprets the mapping table in `table.ts` over
// the Lezer syntax tree, windowed to the visible ranges. Bulk input remaps
// existing decorations for the initial paint and rebuilds them after three
// animation frames. Decoration lifecycle dispatches never touch the document
// and carry `decorationOrigin`; explicit controls such as task checkboxes
// dispatch user edits through the editor's normal local-change path.

import { cursorLineUp } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type Extension,
  Facet,
  Prec,
  StateEffect,
  StateField,
  type Text,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode, Tree } from "@lezer/common";
import { tags } from "@lezer/highlight";
import { attachMenuDismissal } from "../../anchoredMenu";
import { externalHttpUrl } from "../../features/navigation";
import {
  editTableCell,
  escapeTableCellPipes,
  extendedTableDocumentEnd,
  type TableCell,
  tableCellRanges,
} from "../../features/tableOperations";
import { type AsyncContentKind, runAsyncContent } from "../../loadingStates";
import {
  enterMotionSurface,
  exitMotionSurface,
  hoverIntentDelay,
} from "../../motion";
import { renderMath } from "../../rendering/math";
import { renderMermaid } from "../../rendering/mermaid";
import { STRINGS } from "../../strings";
import {
  DEFAULT_TASK_STATUSES,
  normalizeTaskStatuses,
  TASK_TRACKS,
  type TaskPayloadKind,
  type TaskStatus,
  taskStatusAdvanceSymbol,
  taskStatusBySymbol,
  taskStatusPayload,
  taskStatusTrack,
  taskTrackLabel,
} from "../../taskStatuses";
import {
  observeVisualViewport,
  visualViewportRect,
} from "../../visualViewport";
import { bulkTextInputAnnotation } from "../bulkInput";
import { decorationOrigin } from "../decorationGuard";
import { parseFrontmatter } from "../frontmatter";
import { codeLanguage } from "../markdown/codeLanguages";
import {
  obsidianMarkdownExtensionsFor,
  skribeumMarkdownParser,
} from "../markdown/obsidian";
import { PostPaintScheduler } from "../postPaintScheduler";
import { calloutIconSvg, parseCallout } from "./callouts";
import {
  DECORATION_TABLE,
  type DecorationRule,
  type Presentation,
} from "./table";
import {
  EMPTY_WIKILINK_CONTEXT,
  followWikilinkTarget,
  resolveMarkdownLinkTarget,
  resolveWikilinkTarget,
  type WikilinkResolutionContext,
  wikilinkNavigationOptionsFacet,
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

const sourceRevealFocusEnabled = Facet.define<boolean, boolean>({
  combine: (values) => values.at(-1) ?? true,
});

const setTableCellReveal = StateEffect.define<boolean>();
const tableCellRevealField = StateField.define<boolean>({
  create: () => false,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setTableCellReveal)) {
        return effect.value;
      }
    }
    return value;
  },
});

type ExplicitTableSource = {
  from: number;
  to: number;
  row: number;
  column: number;
  cellOffset: number;
};

const setExplicitTableSource = StateEffect.define<ExplicitTableSource | null>();

const explicitTableSourceField = StateField.define<ExplicitTableSource | null>({
  create: () => null,
  update(value, transaction) {
    let next =
      value === null
        ? null
        : {
            ...value,
            from: transaction.changes.mapPos(value.from, -1),
            to: transaction.changes.mapPos(value.to, 1),
          };
    for (const effect of transaction.effects) {
      if (effect.is(setExplicitTableSource)) {
        next = effect.value;
      }
    }
    return next;
  },
});

/** The deliberately revealed table source range, if any. */
export function explicitTableSource(
  state: EditorState,
): Readonly<ExplicitTableSource> | null {
  return state.field(explicitTableSourceField, false) ?? null;
}

/** Reveals one complete table as source at the active cell's source offset. */
export function editRenderedTableSource(view: EditorView): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const session = tableCellSessions.get(view);
  if (session === undefined) {
    return false;
  }
  const table = view.state.sliceDoc(session.tableFrom, session.tableTo);
  const cell = tableCellRanges(table).find(
    (candidate) =>
      candidate.row === session.row && candidate.column === session.column,
  );
  if (cell === undefined) {
    return false;
  }
  const state: ExplicitTableSource = {
    from: session.tableFrom,
    to: session.tableTo,
    row: session.row,
    column: session.column,
    cellOffset: session.head,
  };
  blurRenderedTableCell(view);
  view.focus();
  view.dispatch({
    effects: setExplicitTableSource.of(state),
    selection: {
      anchor: Math.min(
        session.tableFrom + cell.to,
        session.tableFrom + cell.from + session.head,
      ),
    },
    scrollIntoView: true,
    userEvent: "select.table-source",
  });
  return true;
}

/** Restores the rendered table, optionally returning focus to its source cell. */
export function closeRenderedTableSource(
  view: EditorView,
  restoreCell: boolean,
): boolean {
  const openSource = explicitTableSource(view.state);
  if (openSource === null) {
    return false;
  }
  const caret = view.state.selection.main.head - openSource.from;
  const cells = tableCellRanges(
    view.state.sliceDoc(openSource.from, openSource.to),
  );
  const currentCell = cells.reduce<TableCell | undefined>((nearest, cell) => {
    if (cell.from <= caret && caret <= cell.to) {
      return cell;
    }
    if (nearest === undefined) {
      return cell;
    }
    const distance = Math.min(
      Math.abs(caret - cell.from),
      Math.abs(caret - cell.to),
    );
    const nearestDistance = Math.min(
      Math.abs(caret - nearest.from),
      Math.abs(caret - nearest.to),
    );
    return distance < nearestDistance ? cell : nearest;
  }, undefined);
  const source =
    currentCell === undefined
      ? openSource
      : {
          ...openSource,
          row: currentCell.row,
          column: currentCell.column,
          cellOffset: Math.max(
            0,
            Math.min(
              currentCell.to - currentCell.from,
              caret - currentCell.from,
            ),
          ),
        };
  view.dispatch({
    effects: setExplicitTableSource.of(null),
    ...(restoreCell
      ? { selection: { anchor: source.from }, scrollIntoView: true }
      : {}),
  });
  if (restoreCell) {
    tableCellSessions.set(view, {
      tableFrom: source.from,
      tableTo: source.to,
      row: source.row,
      column: source.column,
      anchor: source.cellOffset,
      head: source.cellOffset,
      verticalGoal: source.cellOffset,
    });
    updateTableCellStates(view);
    view.requestMeasure({
      read: () => null,
      write: () => {
        focusRenderedTableCell(
          view,
          source.from,
          source.row,
          source.column,
          source.cellOffset,
        );
      },
    });
  }
  return true;
}

/** Keeps cursor-sensitive source markers hidden on non-editable surfaces. */
export const readOnlyDecorationMode = sourceRevealEnabled.of(false);

/** Controls whether cursor-sensitive Markdown source markers reveal. */
export function sourceRevealMode(enabled: boolean): Extension {
  return sourceRevealEnabled.of(enabled);
}

/** Controls whether the current selection represents focused editing intent. */
export function sourceRevealFocusMode(enabled: boolean): Extension {
  return sourceRevealFocusEnabled.of(enabled);
}

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

const TASK_LEVELS = ["⏫", "🔼", "🔽"] as const;
const TASK_DATE_TOKEN = /[ \t]📅 \d{4}-\d{2}-\d{2}/u;
const TASK_LEVEL_TOKEN = /[ \t](?:⏫|🔼|🔽)/u;

function payloadChange(
  view: EditorView,
  markerFrom: number,
  kind: TaskPayloadKind,
  value: string | undefined,
): { from: number; to: number; insert: string } | null {
  const line = view.state.doc.lineAt(markerFrom);
  const source = view.state.doc.sliceString(line.from, line.to);
  const pattern = kind === "date" ? TASK_DATE_TOKEN : TASK_LEVEL_TOKEN;
  const match = pattern.exec(source);
  const token =
    value === undefined ? "" : kind === "date" ? ` 📅 ${value}` : ` ${value}`;
  if (match !== null) {
    const from = line.from + match.index;
    return { from, to: from + match[0].length, insert: token };
  }
  return token.length === 0
    ? null
    : { from: line.to, to: line.to, insert: token };
}

function applyTaskStatusWithPayload(
  view: EditorView,
  from: number,
  to: number,
  currentSymbol: string,
  symbol: string,
  payload?: { kind: TaskPayloadKind; value: string },
): void {
  if (
    view.state.readOnly ||
    view.state.doc.sliceString(from, to) !== currentSymbol
  ) {
    return;
  }
  const changes: { from: number; to: number; insert: string }[] = [];
  if (currentSymbol !== symbol) {
    changes.push({ from, to, insert: symbol });
  }
  if (payload !== undefined) {
    const change = payloadChange(view, from, payload.kind, payload.value);
    if (change !== null) {
      changes.push(change);
    }
  }
  if (changes.length > 0) {
    view.dispatch({ changes, userEvent: "input.task-status" });
  }
}

function cycleTaskLevel(
  view: EditorView,
  markerFrom: number,
  currentSymbol: string,
): void {
  if (
    view.state.doc.sliceString(markerFrom, markerFrom + 1) !== currentSymbol
  ) {
    return;
  }
  const line = view.state.doc.lineAt(markerFrom);
  const source = view.state.doc.sliceString(line.from, line.to);
  const current = TASK_LEVEL_TOKEN.exec(source)?.[0].trim();
  const currentIndex =
    current === undefined
      ? -1
      : TASK_LEVELS.indexOf(current as (typeof TASK_LEVELS)[number]);
  const next = TASK_LEVELS[currentIndex + 1];
  const change = payloadChange(view, markerFrom, "level", next);
  if (change !== null) {
    view.dispatch({ changes: change, userEvent: "input.task-payload" });
  }
}

function localIsoDate(): string {
  const today = new Date();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${today.getFullYear()}-${month}-${day}`;
}

type TaskMenuEntry =
  | { kind: "status"; status: TaskStatus }
  | { kind: "more"; count: number };

const OPEN_TASK_STATUS_MENU_EVENT = "skribeum:open-task-status-menu";

/** Opens the rendered task menu belonging to a source marker. */
export function openTaskStatusMenuAtMarker(
  view: EditorView,
  markerFrom: number,
): boolean {
  let checkbox = view.dom.querySelector<HTMLElement>(
    `.cm-skr-task-checkbox[data-marker-from="${markerFrom}"]`,
  );
  if (checkbox === null) {
    const statuses = view.state.facet(taskStatusConfiguration);
    const status = taskStatusBySymbol(
      statuses,
      view.state.doc.sliceString(markerFrom, markerFrom + 1),
    );
    const coordinates = view.coordsAtPos(markerFrom);
    if (status === undefined || coordinates === null) {
      return false;
    }
    const transient = new TaskCheckboxWidget(
      status,
      statuses,
      markerFrom,
      markerFrom + 1,
    ).toDOM(view);
    transient.style.position = "fixed";
    transient.style.left = `${coordinates.left}px`;
    transient.style.top = `${coordinates.top}px`;
    transient.style.width = "1px";
    transient.style.height = `${Math.max(1, coordinates.bottom - coordinates.top)}px`;
    transient.style.zIndex = "30";
    checkbox = transient.querySelector<HTMLElement>(".cm-skr-task-checkbox");
    const palette = transient.querySelector<HTMLElement>(
      ".cm-skr-task-palette",
    );
    if (checkbox === null || palette === null) {
      return false;
    }
    checkbox.style.width = "1px";
    checkbox.style.height = "100%";
    checkbox.style.opacity = "0";
    checkbox.style.pointerEvents = "none";
    view.dom.append(transient);
    let opened = false;
    const observer = new MutationObserver(() => {
      if (!palette.hidden) {
        opened = true;
        return;
      }
      if (opened) {
        observer.disconnect();
        const restoreEditorFocus = transient.contains(
          view.dom.ownerDocument.activeElement,
        );
        transient.remove();
        if (restoreEditorFocus) {
          queueMicrotask(() => view.focus());
        }
      }
    });
    observer.observe(palette, {
      attributes: true,
      attributeFilter: ["hidden"],
    });
  }
  checkbox.dispatchEvent(new CustomEvent(OPEN_TASK_STATUS_MENU_EVENT));
  return true;
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
    box.dataset.markerFrom = String(this.markerFrom);
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

    let activeIndex: number | null = null;
    let entries: TaskMenuEntry[] = [];
    let options: HTMLElement[] = [];
    let expandedReference = taskStatusTrack(this.status) === "reference";
    let pendingDateStatus: TaskStatus | null = null;
    let paletteAnchor: { x: number; y: number } | null = null;
    let openMode: "hold" | "hover" | "keyboard" | "tap" | null = null;
    let stopObservingViewport: (() => void) | null = null;
    let stopObservingScroll: (() => void) | null = null;
    let deliberateOpen = false;
    let removeOutsidePress: (() => void) | null = null;
    let press: {
      pointerId: number;
      startX: number;
      startY: number;
      holdTimer: ReturnType<typeof setTimeout>;
      cancelled: boolean;
      menuOpen: boolean;
    } | null = null;

    const updateActiveOption = (scroll = false) => {
      for (const [index, option] of options.entries()) {
        option.classList.toggle(
          "cm-skr-task-option-active",
          index === activeIndex,
        );
      }
      const active = activeIndex === null ? undefined : options[activeIndex];
      if (active === undefined) {
        palette.removeAttribute("aria-activedescendant");
        return;
      }
      palette.setAttribute("aria-activedescendant", active.id);
      if (scroll) {
        active.scrollIntoView?.({ block: "nearest" });
      }
    };

    const positionPalette = () => {
      if (palette.hidden || paletteAnchor === null) {
        return;
      }
      const targetWindow = view.dom.ownerDocument.defaultView ?? window;
      const viewport = visualViewportRect(targetWindow);
      const inset = 8;
      const fingerGap = 12;
      palette.style.maxHeight = `${Math.max(0, viewport.height - 2 * inset)}px`;
      const bounds = palette.getBoundingClientRect();
      const checkboxBounds = box.getBoundingClientRect();
      // A tap, keyboard, or hover open tracks the checkbox itself, so the
      // editor scrolling underneath an open menu (a wheel scroll, a
      // scroll-into-view after a command-palette invocation) cannot leave
      // it floating over its old position. Only the held-gesture anchor
      // stays pinned to the point the finger pressed, matching the
      // instant-open exception of design section 5.1.
      if (openMode !== "hold") {
        paletteAnchor = { x: paletteAnchor.x, y: checkboxBounds.bottom };
      }
      const maximumLeft = Math.max(
        viewport.left + inset,
        viewport.right - bounds.width - inset,
      );
      palette.style.left = `${Math.min(
        Math.max(checkboxBounds.left, viewport.left + inset),
        maximumLeft,
      )}px`;
      const spaceAbove = paletteAnchor.y - fingerGap - viewport.top;
      if (spaceAbove >= bounds.height) {
        palette.dataset.motionSurface = "anchored-bottom";
        palette.style.top = `${paletteAnchor.y - fingerGap - bounds.height}px`;
      } else {
        palette.dataset.motionSurface = "anchored-top";
        const top = paletteAnchor.y + fingerGap;
        palette.style.top = `${top}px`;
        palette.style.maxHeight = `${Math.max(
          0,
          viewport.bottom - top - inset,
        )}px`;
      }
    };

    let closeGeneration = 0;
    const closePalette = (returnFocus: boolean) => {
      if (palette.hidden) return;
      const generation = ++closeGeneration;
      palette.removeAttribute("aria-activedescendant");
      entries = [];
      options = [];
      pendingDateStatus = null;
      paletteAnchor = null;
      openMode = null;
      stopObservingViewport?.();
      stopObservingViewport = null;
      stopObservingScroll?.();
      stopObservingScroll = null;
      removeOutsidePress?.();
      removeOutsidePress = null;
      deliberateOpen = false;
      box.setAttribute("aria-expanded", "false");
      if (returnFocus) {
        box.focus();
      }
      if (palette.dataset.motionInstant === "true") {
        palette.hidden = true;
        palette.replaceChildren();
        return;
      }
      void exitMotionSurface(palette, () => {
        if (generation !== closeGeneration) return;
        palette.hidden = true;
        palette.replaceChildren();
      });
    };

    const focusReplacementCheckbox = () => {
      queueMicrotask(() => {
        view.dom
          .querySelector<HTMLElement>(
            `.cm-skr-task-checkbox[data-marker-from="${this.markerFrom}"]`,
          )
          ?.focus();
      });
    };

    const applyMenuStatus = (status: TaskStatus) => {
      closePalette(false);
      applyTaskStatus(
        view,
        this.markerFrom,
        this.markerTo,
        this.status.symbol,
        status.symbol,
      );
      focusReplacementCheckbox();
    };

    const applyPendingDate = (input: HTMLInputElement) => {
      const status = pendingDateStatus;
      if (status === null || input.value === "") {
        return;
      }
      const date = input.value;
      closePalette(false);
      applyTaskStatusWithPayload(
        view,
        this.markerFrom,
        this.markerTo,
        this.status.symbol,
        status.symbol,
        { kind: "date", value: date },
      );
      focusReplacementCheckbox();
    };

    const showDateFooter = (status: TaskStatus) => {
      pendingDateStatus = status;
      palette.querySelector(".cm-skr-task-payload-footer")?.remove();
      const footer = document.createElement("span");
      footer.className = "cm-skr-task-payload-footer";
      const label = document.createElement("span");
      label.className = "cm-skr-task-payload-label";
      label.textContent = STRINGS.taskDateLabel;
      const input = document.createElement("input");
      input.type = "date";
      input.value = localIsoDate();
      input.setAttribute("aria-label", STRINGS.taskDateLabel);
      input.setAttribute("data-testid", "task-date-payload");
      input.addEventListener("pointerdown", (event) => event.stopPropagation());
      input.addEventListener("change", () => applyPendingDate(input));
      input.addEventListener("keydown", (event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          applyPendingDate(input);
        } else if (event.key === "Escape") {
          event.preventDefault();
          applyMenuStatus(status);
        }
      });
      footer.append(label, input);
      palette.append(footer);
      positionPalette();
      queueMicrotask(() => input.focus());
    };

    const selectEntry = (index: number) => {
      const entry = entries[index];
      if (entry === undefined) {
        return;
      }
      if (entry.kind === "more") {
        expandedReference = true;
        pendingDateStatus = null;
        buildOptions();
        activeIndex = entries.findIndex(
          (candidate) =>
            candidate.kind === "status" &&
            taskStatusTrack(candidate.status) === "reference",
        );
        updateActiveOption(true);
        positionPalette();
        return;
      }
      if (taskStatusPayload(entry.status) === "date") {
        showDateFooter(entry.status);
        return;
      }
      applyMenuStatus(entry.status);
    };

    const appendOption = (
      group: HTMLElement,
      entry: TaskMenuEntry,
      status?: TaskStatus,
    ) => {
      const index = entries.length;
      entries.push(entry);
      const option = document.createElement("span");
      options.push(option);
      option.id = `${paletteId}-option-${index}`;
      option.className = "cm-skr-task-option";
      option.setAttribute("role", "option");
      option.setAttribute(
        "aria-selected",
        status?.symbol === this.status.symbol ? "true" : "false",
      );
      if (status !== undefined) {
        option.dataset.taskStatus = status.symbol;
        option.style.setProperty(
          "--skr-task-option-color",
          `var(${status.color_token})`,
        );
        const optionGlyph = document.createElement("span");
        optionGlyph.className = "cm-skr-task-option-glyph";
        optionGlyph.setAttribute("aria-hidden", "true");
        optionGlyph.textContent = status.glyph;
        option.append(optionGlyph);
      }
      const optionName = document.createElement("span");
      optionName.className = "cm-skr-task-option-name";
      optionName.textContent =
        entry.kind === "more"
          ? `${STRINGS.taskMoreStatuses} (${entry.count})`
          : entry.status.name;
      option.append(optionName);
      option.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      option.addEventListener("pointerenter", () => {
        activeIndex = index;
        updateActiveOption();
      });
      option.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectEntry(index);
      });
      group.append(option);
    };

    const buildOptions = () => {
      palette.replaceChildren();
      entries = [];
      options = [];
      for (const track of TASK_TRACKS) {
        const members = this.statuses.filter(
          (status) => taskStatusTrack(status) === track,
        );
        if (members.length === 0) {
          continue;
        }
        const group = document.createElement("span");
        group.className = "cm-skr-task-track";
        group.setAttribute("role", "group");
        const heading = document.createElement("span");
        heading.className = "cm-skr-task-track-heading";
        heading.setAttribute("data-task-track-heading", track);
        heading.textContent = taskTrackLabel(track);
        heading.id = `${paletteId}-${track}`;
        group.setAttribute("aria-labelledby", heading.id);
        group.append(heading);
        if (track === "reference" && !expandedReference) {
          appendOption(group, { kind: "more", count: members.length });
        } else {
          for (const status of members) {
            appendOption(group, { kind: "status", status }, status);
          }
        }
        palette.append(group);
      }
    };

    const openPalette = (
      mode: "hold" | "hover" | "keyboard" | "tap",
      anchor?: { x: number; y: number },
    ) => {
      closeGeneration += 1;
      openMode = mode;
      delete palette.dataset.motionExiting;
      if (mode === "hold") {
        palette.dataset.motionInstant = "true";
      } else {
        delete palette.dataset.motionInstant;
      }
      if (entries.length === 0) {
        buildOptions();
      }
      const keyboard = mode === "keyboard";
      deliberateOpen = mode === "tap";
      const keyboardOperable = keyboard || deliberateOpen;
      activeIndex = keyboardOperable
        ? Math.max(
            0,
            entries.findIndex(
              (entry) =>
                entry.kind === "status" &&
                entry.status.symbol === this.status.symbol,
            ),
          )
        : null;
      palette.hidden = false;
      box.setAttribute("aria-expanded", "true");
      const bounds = box.getBoundingClientRect();
      paletteAnchor = anchor ?? {
        x: bounds.left + bounds.width / 2,
        y: bounds.bottom,
      };
      positionPalette();
      if (mode === "hold") {
        palette.dataset.motionEntered = "true";
      } else {
        enterMotionSurface(palette);
      }
      updateActiveOption(keyboardOperable);
      stopObservingViewport?.();
      stopObservingViewport = observeVisualViewport(
        positionPalette,
        view.dom.ownerDocument.defaultView ?? window,
      );
      // The visual viewport only moves for the browser chrome and the
      // on-screen keyboard; the note's own scroll container is a second,
      // independent scroll that can carry the checkbox out from under a
      // menu positioned in viewport coordinates. Tracking it here is what
      // keeps the menu anchored to its checkbox instead of the last place
      // that checkbox happened to be when the menu opened.
      stopObservingScroll?.();
      const scroller = view.scrollDOM;
      scroller.addEventListener("scroll", positionPalette, { passive: true });
      stopObservingScroll = () =>
        scroller.removeEventListener("scroll", positionPalette);
      if (keyboard || deliberateOpen) {
        queueMicrotask(() => palette.focus());
      }
      if (deliberateOpen) {
        removeOutsidePress?.();
        removeOutsidePress = attachMenuDismissal(palette, {
          onDismiss: () => closePalette(true),
          ignore: [box],
          escape: false,
        });
      }
    };

    const advance = () => {
      if (taskStatusPayload(this.status) === "level") {
        cycleTaskLevel(view, this.markerFrom, this.status.symbol);
        return;
      }
      applyTaskStatus(
        view,
        this.markerFrom,
        this.markerTo,
        this.status.symbol,
        taskStatusAdvanceSymbol(this.status, this.statuses),
      );
    };

    const movementFromStart = (event: PointerEvent) =>
      Math.hypot(
        event.clientX - (press?.startX ?? event.clientX),
        event.clientY - (press?.startY ?? event.clientY),
      );
    const optionAt = (x: number, y: number): number | null => {
      const target = document.elementFromPoint(x, y);
      const option =
        target instanceof Element
          ? target.closest<HTMLElement>(".cm-skr-task-option")
          : null;
      if (option !== null && palette.contains(option)) {
        const index = options.indexOf(option);
        if (index >= 0) {
          return index;
        }
      }
      const index = options.findIndex((candidate) => {
        const bounds = candidate.getBoundingClientRect();
        return (
          x >= bounds.left &&
          x <= bounds.right &&
          y >= bounds.top &&
          y <= bounds.bottom
        );
      });
      return index < 0 ? null : index;
    };
    const finishPress = () => {
      if (press !== null) {
        clearTimeout(press.holdTimer);
      }
      press = null;
      host.classList.remove("cm-skr-task-control-pressing");
    };

    box.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || press !== null) {
        return;
      }
      event.stopPropagation();
      if (event.pointerType === "mouse") {
        event.preventDefault();
      }
      const state = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        holdTimer: 0 as unknown as ReturnType<typeof setTimeout>,
        cancelled: false,
        menuOpen: false,
      };
      press = state;
      host.classList.add("cm-skr-task-control-pressing");
      try {
        box.setPointerCapture(event.pointerId);
      } catch {
        // Synthesized browser input can lack pointer capture.
      }
      state.holdTimer = setTimeout(() => {
        if (press !== state || state.cancelled) {
          return;
        }
        state.menuOpen = true;
        openPalette("hold", { x: state.startX, y: state.startY });
      }, 500);
    });
    box.addEventListener("pointermove", (event) => {
      if (press === null || event.pointerId !== press.pointerId) {
        return;
      }
      if (!press.menuOpen && movementFromStart(event) > 8) {
        clearTimeout(press.holdTimer);
        press.cancelled = true;
        if (box.hasPointerCapture(event.pointerId)) {
          box.releasePointerCapture(event.pointerId);
        }
        finishPress();
        return;
      }
      if (press.menuOpen) {
        event.preventDefault();
        activeIndex = optionAt(event.clientX, event.clientY);
        updateActiveOption();
      }
    });
    box.addEventListener("pointerup", (event) => {
      const currentPress = press;
      if (currentPress === null || event.pointerId !== currentPress.pointerId) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const moved = movementFromStart(event);
      if (currentPress.menuOpen) {
        const selectedIndex = optionAt(event.clientX, event.clientY);
        finishPress();
        if (selectedIndex === null) {
          closePalette(false);
        } else {
          selectEntry(selectedIndex);
        }
      } else {
        const shouldAdvance = !currentPress.cancelled && moved <= 8;
        closePalette(false);
        finishPress();
        if (shouldAdvance) {
          advance();
        }
      }
    });
    box.addEventListener("pointercancel", (event) => {
      if (press === null || event.pointerId !== press.pointerId) {
        return;
      }
      closePalette(false);
      finishPress();
    });
    box.addEventListener("contextmenu", (event) => {
      if (press !== null || !palette.hidden) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
    box.addEventListener("click", (event) => {
      if (event.detail !== 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      advance();
    });
    // registry-exempt keydown: ARIA checkbox and listbox internal navigation.
    box.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        openPalette("keyboard");
      } else if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        advance();
      }
    });
    box.addEventListener(OPEN_TASK_STATUS_MENU_EVENT, () => {
      openPalette("tap");
    });
    palette.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLInputElement) {
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowRight") {
        event.preventDefault();
        activeIndex = ((activeIndex ?? -1) + 1) % options.length;
        updateActiveOption(true);
      } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
        event.preventDefault();
        activeIndex =
          ((activeIndex ?? 0) - 1 + options.length) % options.length;
        updateActiveOption(true);
      } else if (event.key === "Home") {
        event.preventDefault();
        activeIndex = 0;
        updateActiveOption(true);
      } else if (event.key === "End") {
        event.preventDefault();
        activeIndex = options.length - 1;
        updateActiveOption(true);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (activeIndex !== null) {
          selectEntry(activeIndex);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closePalette(true);
      }
    });
    host.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch" && (event.buttons ?? 0) === 0) {
        openPalette("hover", { x: event.clientX, y: event.clientY });
      }
    });
    host.addEventListener("pointerleave", () => {
      if (
        press === null &&
        !deliberateOpen &&
        pendingDateStatus === null &&
        !host.contains(document.activeElement)
      ) {
        closePalette(false);
      }
    });
    host.addEventListener("focusout", () => {
      queueMicrotask(() => {
        if (!deliberateOpen && !host.contains(document.activeElement)) {
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

type TableRenderedCell = {
  source: string;
  row: number;
  column: number;
};

type TableRenderedRow = {
  cells: TableRenderedCell[];
  header: boolean;
};

type TableLayout = {
  from: number;
  to: number;
  rows: TableRenderedRow[];
  columns: string;
  alignments: ("left" | "center" | "right")[];
};

type TableCellSession = {
  tableFrom: number;
  tableTo: number;
  row: number;
  column: number;
  anchor: number;
  head: number;
  verticalGoal: number;
};

const tableCellSessions = new WeakMap<EditorView, TableCellSession>();
const nestedTableCellViews = new WeakMap<HTMLElement, EditorView>();
const nestedTableCellParents = new WeakMap<
  EditorView,
  { parent: EditorView; tableFrom: number; row: number; column: number }
>();
const syncingTableCellViews = new WeakSet<EditorView>();
const tableCellRevealStates = new WeakMap<EditorView, boolean>();
const tablePointerCleanups = new WeakMap<HTMLElement, () => void>();

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

function extendedTableEnd(node: SyntaxNode, doc: Text): number {
  return extendedTableDocumentEnd(doc, node.from, node.to);
}

function tableLayout(node: SyntaxNode, doc: Text): TableLayout {
  const to = extendedTableEnd(node, doc);
  const source = doc.sliceString(node.from, to);
  const cells = tableCellRanges(source);
  const rowCount = Math.max(0, ...cells.map((cell) => cell.row)) + 1;
  const rows = Array.from({ length: rowCount }, (_, row) => ({
    header: row === 0,
    cells: cells
      .filter((cell) => cell.row === row)
      .map((cell) => ({
        source: source.slice(cell.from, cell.to),
        row,
        column: cell.column,
      })),
  }));
  const delimiter = source.split("\n")[1] ?? "";
  const columnCount = Math.max(1, ...rows.map((row) => row.cells.length));
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(
      8,
      Math.min(
        32,
        Math.max(...rows.map((row) => row.cells[index]?.source.length ?? 0)),
      ),
    ),
  );
  return {
    from: node.from,
    to,
    rows,
    columns: widths.map((width) => `minmax(0, ${width}fr)`).join(" "),
    alignments: delimiterAlignments(delimiter, columnCount),
  };
}

function tableLayoutAt(state: EditorState, from: number): TableLayout | null {
  if (from < 0 || from >= state.doc.length) {
    return null;
  }
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(
    Math.min(state.doc.length, from + 1),
    1,
  );
  while (node !== null && node.name !== "Table") {
    node = node.parent;
  }
  return node?.from === from ? tableLayout(node, state.doc) : null;
}

function tableLayoutWithin(
  state: EditorState,
  from: number,
  to: number,
): TableLayout | null {
  let found: TableLayout | null = null;
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (
        found === null &&
        node.name === "Table" &&
        node.from >= from &&
        node.to <= to
      ) {
        found = tableLayout(node.node, state.doc);
        return false;
      }
      return found === null;
    },
  });
  return found;
}

function tableCellHost(
  view: EditorView,
  tableFrom: number,
  row: number,
  column: number,
): HTMLElement | null {
  return view.dom.querySelector<HTMLElement>(
    `.cm-skr-table-cell[data-table-from="${tableFrom}"][data-row="${row}"][data-column="${column}"]`,
  );
}

function updateTableCellStates(view: EditorView): void {
  const session = tableCellSessions.get(view);
  if (session === undefined) {
    delete view.dom.dataset.tableCellActive;
  } else {
    view.dom.dataset.tableCellActive = "true";
  }
  for (const cell of view.dom.querySelectorAll<HTMLElement>(
    ".cm-skr-table-cell[data-table-from]",
  )) {
    const active =
      session !== undefined &&
      Number(cell.dataset.tableFrom) === session.tableFrom &&
      Number(cell.dataset.row) === session.row &&
      Number(cell.dataset.column) === session.column;
    cell.dataset.editing = active ? "true" : "false";
    cell.setAttribute("aria-selected", active ? "true" : "false");
    const editor = cell.querySelector<HTMLElement>(".cm-content");
    if (editor !== null) {
      editor.tabIndex = active ? 0 : -1;
    }
    for (const descendant of cell.querySelectorAll<HTMLElement>("[tabindex]")) {
      if (descendant !== editor) {
        descendant.tabIndex = -1;
      }
    }
    const nested = nestedTableCellViews.get(cell);
    if (nested !== undefined && tableCellRevealStates.get(nested) !== active) {
      tableCellRevealStates.set(nested, active);
      nested.dispatch({ effects: setTableCellReveal.of(active) });
    }
  }
}

function tableCellSelection(
  view: EditorView,
  selection: "start" | "end" | "all" | number,
): { anchor: number; head?: number } {
  if (selection === "all") {
    return { anchor: 0, head: view.state.doc.length };
  }
  if (selection === "end") {
    return { anchor: view.state.doc.length };
  }
  return {
    anchor:
      selection === "start"
        ? 0
        : Math.max(0, Math.min(selection, view.state.doc.length)),
  };
}

/** Focuses one rendered cell while parking the host selection at the table. */
export function focusRenderedTableCell(
  view: EditorView,
  tableFrom: number,
  row: number,
  column: number,
  selection: "start" | "end" | "all" | number = "end",
): boolean {
  if (view.state.readOnly) {
    return false;
  }
  const host = tableCellHost(view, tableFrom, row, column);
  const nested = host === null ? undefined : nestedTableCellViews.get(host);
  if (host === null || nested === undefined) {
    return false;
  }
  const range = tableCellSelection(nested, selection);
  const grid = host.closest<HTMLElement>(".cm-skr-table-grid");
  const tableTo = Number(grid?.dataset.tableTo ?? tableFrom);
  tableCellSessions.set(view, {
    tableFrom,
    tableTo,
    row,
    column,
    anchor: range.anchor,
    head: range.head ?? range.anchor,
    verticalGoal: range.head ?? range.anchor,
  });
  if (
    !view.state.selection.main.empty ||
    view.state.selection.main.head !== tableFrom
  ) {
    view.dispatch({ selection: { anchor: tableFrom }, scrollIntoView: true });
  }
  updateTableCellStates(view);
  nested.dispatch({ selection: range, scrollIntoView: true });
  nested.focus();
  return true;
}

/** The active rendered table cell, if the cell caret owns focus. */
export function focusedRenderedTableCell(
  view: EditorView,
): Readonly<TableCellSession> | null {
  const session = tableCellSessions.get(view);
  if (session === undefined) {
    return null;
  }
  const host = tableCellHost(
    view,
    session.tableFrom,
    session.row,
    session.column,
  );
  const nested = host === null ? undefined : nestedTableCellViews.get(host);
  if (host === null || nested === undefined || !nested.dom.isConnected) {
    tableCellSessions.delete(view);
    updateTableCellStates(view);
    return null;
  }
  return session;
}

/** Ends cell editing without revealing table source. */
export function blurRenderedTableCell(view: EditorView): void {
  const session = tableCellSessions.get(view);
  if (session !== undefined) {
    const host = tableCellHost(
      view,
      session.tableFrom,
      session.row,
      session.column,
    );
    const nested = host === null ? undefined : nestedTableCellViews.get(host);
    const active = document.activeElement;
    if (
      nested !== undefined &&
      active instanceof HTMLElement &&
      nested.dom.contains(active)
    ) {
      active.blur();
    }
  }
  tableCellSessions.delete(view);
  updateTableCellStates(view);
}

function tableExitPosition(
  view: EditorView,
  session: TableCellSession,
  direction: "before" | "after",
): number {
  if (direction === "before") {
    return view.state.doc.lineAt(Math.max(0, session.tableFrom - 1)).to;
  }
  if (session.tableTo >= view.state.doc.length) {
    return view.state.doc.length;
  }
  return view.state.doc.lineAt(
    Math.min(view.state.doc.length, session.tableTo + 1),
  ).from;
}

function focusHostOutsideTable(
  view: EditorView,
  session: TableCellSession,
  direction: "before" | "after",
): void {
  const anchor = tableExitPosition(view, session, direction);
  blurRenderedTableCell(view);
  view.focus();
  view.dispatch({ selection: { anchor }, scrollIntoView: true });
}

function promoteCellSelection(
  view: EditorView,
  session: TableCellSession,
): void {
  blurRenderedTableCell(view);
  view.focus();
  view.dispatch({
    selection: { anchor: session.tableFrom, head: session.tableTo },
    scrollIntoView: true,
    userEvent: "select.table",
  });
}

function tableCellsForSession(view: EditorView, session: TableCellSession) {
  return tableCellRanges(
    view.state.sliceDoc(session.tableFrom, session.tableTo),
  );
}

function moveCell(
  view: EditorView,
  session: TableCellSession,
  row: number,
  column: number,
  selection: "start" | "end" | "all" | number,
  preserveVerticalGoal = false,
): boolean {
  const cell = tableCellsForSession(view, session).find(
    (candidate) => candidate.row === row && candidate.column === column,
  );
  const verticalGoal = session.verticalGoal;
  const moved =
    cell !== undefined &&
    focusRenderedTableCell(view, session.tableFrom, row, column, selection);
  if (moved && preserveVerticalGoal) {
    const next = tableCellSessions.get(view);
    if (next !== undefined) {
      next.verticalGoal = verticalGoal;
    }
  }
  return moved;
}

function dispatchTableWidgetCommand(
  view: EditorView,
  id: string,
  tableFrom: number,
  row: number,
  column: number,
): void {
  focusRenderedTableCell(view, tableFrom, row, column, "end");
  view.dom.dispatchEvent(
    new CustomEvent("skribeum:table-command", {
      bubbles: true,
      detail: { id },
    }),
  );
}

function handleTableCellKey(event: KeyboardEvent, nested: EditorView): boolean {
  const owner = nestedTableCellParents.get(nested);
  if (owner === undefined) {
    return false;
  }
  const parent = owner.parent;
  const session = tableCellSessions.get(parent);
  if (session === undefined) {
    return false;
  }
  const selection = nested.state.selection.main;
  const headAtStart = selection.head === 0;
  const headAtEnd = selection.head === nested.state.doc.length;
  const atStart = selection.empty && headAtStart;
  const atEnd = selection.empty && headAtEnd;
  const cells = tableCellsForSession(parent, session);
  const firstRow = cells.reduce(
    (minimum, cell) => Math.min(minimum, cell.row),
    session.row,
  );
  const lastRow = cells.reduce(
    (maximum, cell) => Math.max(maximum, cell.row),
    session.row,
  );
  const stop = () => {
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
  if (
    event.shiftKey &&
    ((event.key === "ArrowLeft" && headAtStart) ||
      (event.key === "ArrowRight" && headAtEnd) ||
      (event.key === "ArrowUp" && session.row === firstRow) ||
      (event.key === "ArrowDown" && session.row === lastRow))
  ) {
    promoteCellSelection(parent, session);
    return stop();
  }
  if (event.key === "ArrowLeft" && atStart) {
    const index = cells.findIndex(
      (cell) => cell.row === session.row && cell.column === session.column,
    );
    const previous = cells[index - 1];
    if (previous !== undefined) {
      moveCell(parent, session, previous.row, previous.column, "end");
    }
    return stop();
  }
  if (event.key === "ArrowRight" && atEnd) {
    const index = cells.findIndex(
      (cell) => cell.row === session.row && cell.column === session.column,
    );
    const next = cells[index + 1];
    if (next === undefined) {
      focusHostOutsideTable(parent, session, "after");
    } else {
      moveCell(parent, session, next.row, next.column, "start");
    }
    return stop();
  }
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    const direction = event.key === "ArrowUp" ? -1 : 1;
    const targetRow = session.row + direction;
    if (
      !moveCell(
        parent,
        session,
        targetRow,
        session.column,
        session.verticalGoal,
        true,
      )
    ) {
      focusHostOutsideTable(
        parent,
        session,
        direction < 0 ? "before" : "after",
      );
    }
    return stop();
  }
  if (event.key === "Tab") {
    const index = cells.findIndex(
      (cell) => cell.row === session.row && cell.column === session.column,
    );
    const next = cells[index + (event.shiftKey ? -1 : 1)];
    if (next !== undefined) {
      moveCell(parent, session, next.row, next.column, "all");
    } else if (!event.shiftKey) {
      dispatchTableWidgetCommand(
        parent,
        "table.row.insert-below",
        session.tableFrom,
        session.row,
        0,
      );
    }
    return stop();
  }
  if (event.key === "Enter") {
    if (
      !moveCell(
        parent,
        session,
        session.row + 1,
        session.column,
        session.verticalGoal,
        true,
      )
    ) {
      dispatchTableWidgetCommand(
        parent,
        "table.row.insert-below",
        session.tableFrom,
        session.row,
        session.column,
      );
    }
    return stop();
  }
  if (event.key === "Escape") {
    focusHostOutsideTable(parent, session, "after");
    return stop();
  }
  if (
    (event.key === "Backspace" && atStart) ||
    (event.key === "Delete" && atEnd)
  ) {
    return stop();
  }
  return false;
}

// registry-exempt keydown: rendered table cells own editing and WAI-ARIA grid
// travel while application-level structure changes remain registry commands.
const tableCellKeys = EditorView.domEventHandlers({
  keydown: handleTableCellKey,
});

function escapedPrefixLength(source: string, offset: number): number {
  return escapeTableCellPipes(source.slice(0, offset)).length;
}

function writeTableCell(
  parent: EditorView,
  nested: EditorView,
  row: number,
  column: number,
  source: string,
  anchor: number,
  head: number,
): void {
  const session = tableCellSessions.get(parent);
  const owner = nestedTableCellParents.get(nested);
  const tableFrom = owner?.tableFrom;
  if (
    session === undefined ||
    parent.state.readOnly ||
    syncingTableCellViews.has(nested) ||
    owner?.parent !== parent ||
    tableFrom === undefined ||
    owner.row !== row ||
    owner.column !== column ||
    session.tableFrom !== tableFrom ||
    session.row !== row ||
    session.column !== column
  ) {
    return;
  }
  const table = parent.state.sliceDoc(session.tableFrom, session.tableTo);
  const change = editTableCell(table, row, column, source);
  if (change === null) {
    return;
  }
  session.anchor = escapedPrefixLength(source, anchor);
  session.head = escapedPrefixLength(source, head);
  session.verticalGoal = session.head;
  parent.dispatch({
    changes: {
      from: session.tableFrom + change.from,
      to: session.tableFrom + change.to,
      insert: change.insert,
    },
    selection: { anchor: session.tableFrom },
    userEvent: "input.table-cell",
  });
}

function nestedTableCellView(
  parent: EditorView,
  host: HTMLElement,
  layout: TableLayout,
  cell: TableRenderedCell,
  taskStatuses: readonly TaskStatus[],
  wikilinks: WikilinkResolutionContext,
): EditorView {
  const nested = new EditorView({
    state: EditorState.create({
      doc: cell.source,
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: obsidianMarkdownExtensionsFor(taskStatuses),
          codeLanguages: codeLanguage,
        }),
        syntaxHighlighting(tokenHighlightStyle, { fallback: true }),
        taskStatusConfiguration.of(taskStatuses),
        decorationEngine(wikilinks),
        tableCellRevealField,
        EditorState.transactionFilter.of((transaction) => {
          if (!transaction.docChanged) {
            return transaction;
          }
          const source = transaction.newDoc.toString();
          const normalized = source.replace(/\r?\n/gu, " ");
          if (source === normalized) {
            return transaction;
          }
          const normalizeOffset = (offset: number) =>
            source.slice(0, offset).replace(/\r?\n/gu, " ").length;
          return {
            changes: {
              from: 0,
              to: transaction.startState.doc.length,
              insert: normalized,
            },
            selection: {
              anchor: normalizeOffset(transaction.newSelection.main.anchor),
              head: normalizeOffset(transaction.newSelection.main.head),
            },
          };
        }),
        EditorView.lineWrapping,
        ...(parent.state.readOnly ? [] : [tableCellKeys]),
        EditorState.readOnly.of(parent.state.readOnly),
        EditorView.editable.of(!parent.state.readOnly),
        EditorView.contentAttributes.of({
          "aria-label": `${STRINGS.tableCellLabel} ${cell.row + 1}, ${cell.column + 1}`,
          "aria-multiline": "false",
          spellcheck: "true",
          tabindex: "-1",
        }),
      ],
    }),
    parent: host,
    dispatchTransactions(transactions, target) {
      const current = tableCellSessions.get(parent);
      const owner = nestedTableCellParents.get(target);
      const ownsCaret =
        owner?.parent === parent &&
        current?.tableFrom === owner.tableFrom &&
        current.row === owner.row &&
        current.column === owner.column;
      if (
        transactions.some((transaction) => transaction.docChanged) &&
        !syncingTableCellViews.has(target) &&
        !ownsCaret
      ) {
        return;
      }
      target.update(transactions);
      const selection = target.state.selection.main;
      const selectionChanged = transactions.some(
        (transaction) => transaction.selection !== undefined,
      );
      if (
        current !== undefined &&
        ownsCaret &&
        (selectionChanged ||
          transactions.some((transaction) => transaction.docChanged))
      ) {
        current.anchor = selection.anchor;
        current.head = selection.head;
        current.verticalGoal = selection.head;
      }
      if (transactions.some((transaction) => transaction.docChanged)) {
        writeTableCell(
          parent,
          target,
          cell.row,
          cell.column,
          target.state.doc.toString(),
          selection.anchor,
          selection.head,
        );
      }
    },
  });
  nestedTableCellViews.set(host.parentElement ?? host, nested);
  tableCellRevealStates.set(nested, false);
  nestedTableCellParents.set(nested, {
    parent,
    tableFrom: layout.from,
    row: cell.row,
    column: cell.column,
  });
  if (!parent.state.readOnly) {
    nested.dom.addEventListener("focusin", () => {
      const owner = nestedTableCellParents.get(nested);
      if (owner === undefined) {
        return;
      }
      const selection = nested.state.selection.main;
      const tableTo = Number(
        host.closest<HTMLElement>(".cm-skr-table-grid")?.dataset.tableTo ??
          owner.tableFrom,
      );
      tableCellSessions.set(parent, {
        tableFrom: owner.tableFrom,
        tableTo,
        row: owner.row,
        column: owner.column,
        anchor: selection.anchor,
        head: selection.head,
        verticalGoal: selection.head,
      });
      if (parent.state.selection.main.head !== owner.tableFrom) {
        parent.dispatch({ selection: { anchor: owner.tableFrom } });
      }
      updateTableCellStates(parent);
    });
  }
  return nested;
}

class TableWidget extends WidgetType {
  readonly contextKey: string;

  constructor(
    readonly layout: TableLayout,
    readonly taskStatuses: readonly TaskStatus[],
    readonly wikilinks: WikilinkResolutionContext,
  ) {
    super();
    this.contextKey = JSON.stringify({
      currentPath: wikilinks.currentPath,
      linkPreviews: wikilinks.linkPreviews,
      paths: wikilinks.paths,
      config: wikilinks.config,
      taskStatuses,
    });
  }

  override eq(other: TableWidget): boolean {
    return (
      JSON.stringify(other.layout) === JSON.stringify(this.layout) &&
      other.contextKey === this.contextKey
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const shell = document.createElement("div");
    shell.className = "cm-skr-table-shell";
    const grid = document.createElement("div");
    grid.className = "cm-skr-table-grid";
    grid.setAttribute("role", "grid");
    grid.setAttribute("aria-rowcount", String(this.layout.rows.length));
    grid.setAttribute(
      "aria-colcount",
      String(Math.max(0, ...this.layout.rows.map((row) => row.cells.length))),
    );
    grid.dataset.tableFrom = String(this.layout.from);
    grid.dataset.tableTo = String(this.layout.to);
    shell.dataset.tableContext = this.contextKey;
    for (const [rowIndex, layoutRow] of this.layout.rows.entries()) {
      const row = document.createElement("div");
      row.className = [
        "cm-skr-table-row",
        layoutRow.header ? "cm-skr-table-header" : "",
        rowIndex === 0 ? "cm-skr-table-first" : "",
        rowIndex === this.layout.rows.length - 1 ? "cm-skr-table-last" : "",
      ]
        .filter(Boolean)
        .join(" ");
      row.setAttribute("role", "row");
      row.setAttribute("aria-rowindex", String(rowIndex + 1));
      row.style.gridTemplateColumns = this.layout.columns;
      for (const cellLayout of layoutRow.cells) {
        const cell = document.createElement("div");
        cell.className = "cm-skr-table-cell";
        cell.setAttribute(
          "role",
          layoutRow.header ? "columnheader" : "gridcell",
        );
        cell.setAttribute("aria-colindex", String(cellLayout.column + 1));
        cell.setAttribute("aria-selected", "false");
        cell.dataset.tableFrom = String(this.layout.from);
        cell.dataset.row = String(cellLayout.row);
        cell.dataset.column = String(cellLayout.column);
        cell.dataset.editing = "false";
        cell.style.textAlign =
          this.layout.alignments[cellLayout.column] ?? "left";
        const editorHost = document.createElement("div");
        editorHost.className = "cm-skr-table-cell-editor";
        cell.append(editorHost);
        row.append(cell);
        nestedTableCellView(
          view,
          editorHost,
          this.layout,
          cellLayout,
          this.taskStatuses,
          this.wikilinks,
        );
        const focusAtPointer = (event: MouseEvent | PointerEvent) => {
          if (view.state.readOnly) {
            return;
          }
          const nested = nestedTableCellViews.get(cell);
          if (nested !== undefined) {
            const clicked = nested.posAtCoords({
              x: event.clientX,
              y: event.clientY,
            });
            const content = nested.contentDOM.getBoundingClientRect();
            const position =
              clicked ??
              (event.clientX <= content.left ? 0 : nested.state.doc.length);
            focusRenderedTableCell(
              view,
              Number(cell.dataset.tableFrom),
              Number(cell.dataset.row),
              Number(cell.dataset.column),
              position,
            );
            event.preventDefault();
          }
        };
        cell.addEventListener("click", focusAtPointer);
        const startSelectionDrag = (startEvent: MouseEvent | PointerEvent) => {
          if (view.state.readOnly) {
            return;
          }
          focusAtPointer(startEvent);
          tablePointerCleanups.get(grid)?.();
          const pointerId =
            typeof PointerEvent !== "undefined" &&
            startEvent instanceof PointerEvent
              ? startEvent.pointerId
              : null;
          const onMove = (event: MouseEvent | PointerEvent) => {
            if (
              pointerId !== null &&
              event instanceof PointerEvent &&
              event.pointerId !== pointerId
            ) {
              return;
            }
            const targetCell =
              event.target instanceof Element
                ? event.target.closest<HTMLElement>(".cm-skr-table-cell")
                : null;
            const bounds = cell.getBoundingClientRect();
            const outsideCell =
              event.clientX < bounds.left ||
              event.clientX > bounds.right ||
              event.clientY < bounds.top ||
              event.clientY > bounds.bottom;
            if (outsideCell || targetCell !== cell) {
              const session = tableCellSessions.get(view);
              if (session !== undefined) {
                promoteCellSelection(view, session);
              }
              cleanup();
            }
          };
          const onPointerMove = (event: PointerEvent) => onMove(event);
          const onMouseMove = (event: MouseEvent) => onMove(event);
          const cleanup = () => {
            document.removeEventListener("pointermove", onPointerMove, true);
            document.removeEventListener("pointerup", cleanup, true);
            document.removeEventListener("pointercancel", cleanup, true);
            document.removeEventListener("mousemove", onMouseMove, true);
            document.removeEventListener("mouseup", cleanup, true);
            tablePointerCleanups.delete(grid);
          };
          tablePointerCleanups.set(grid, cleanup);
          if (pointerId !== null) {
            document.addEventListener("pointermove", onPointerMove, true);
            document.addEventListener("pointerup", cleanup, true);
            document.addEventListener("pointercancel", cleanup, true);
          } else {
            document.addEventListener("mousemove", onMouseMove, true);
            document.addEventListener("mouseup", cleanup, true);
          }
        };
        let pointerDownHandled = false;
        cell.addEventListener("pointerdown", (event) => {
          pointerDownHandled = true;
          queueMicrotask(() => {
            pointerDownHandled = false;
          });
          startSelectionDrag(event);
        });
        cell.addEventListener("mousedown", (event) => {
          if (!pointerDownHandled) {
            startSelectionDrag(event);
          }
        });
      }
      grid.append(row);
    }

    if (view.state.readOnly) {
      shell.prepend(grid);
      return shell;
    }

    const lastRow = Math.max(0, this.layout.rows.length - 1);
    const lastRowColumn = Math.max(
      0,
      (this.layout.rows[lastRow]?.cells.length ?? 1) - 1,
    );
    const lastColumn = Math.max(
      0,
      ...this.layout.rows.map((row) => row.cells.length - 1),
    );
    const lastColumnRow = Math.max(
      0,
      this.layout.rows.findIndex((row) =>
        row.cells.some((cell) => cell.column === lastColumn),
      ),
    );
    const appendRow = document.createElement("button");
    appendRow.type = "button";
    appendRow.className = "cm-skr-table-insert cm-skr-table-insert-row";
    appendRow.textContent = "+";
    appendRow.tabIndex = -1;
    appendRow.setAttribute("aria-label", STRINGS.tableAppendRow);
    appendRow.addEventListener("click", () =>
      dispatchTableWidgetCommand(
        view,
        "table.row.insert-below",
        Number(grid.dataset.tableFrom),
        lastRow,
        lastRowColumn,
      ),
    );
    shell.append(appendRow);

    const appendColumn = document.createElement("button");
    appendColumn.type = "button";
    appendColumn.className = "cm-skr-table-insert cm-skr-table-insert-column";
    appendColumn.textContent = "+";
    appendColumn.tabIndex = -1;
    appendColumn.setAttribute("aria-label", STRINGS.tableAppendColumn);
    appendColumn.addEventListener("click", () =>
      dispatchTableWidgetCommand(
        view,
        "table.column.insert-after",
        Number(grid.dataset.tableFrom),
        lastColumnRow,
        lastColumn,
      ),
    );
    shell.append(appendColumn);

    shell.prepend(grid);

    queueMicrotask(() => {
      updateTableCellStates(view);
      const session = tableCellSessions.get(view);
      if (session?.tableFrom === this.layout.from) {
        focusRenderedTableCell(
          view,
          session.tableFrom,
          session.row,
          session.column,
          session.anchor === session.head ? session.head : "all",
        );
      }
    });
    return shell;
  }

  override updateDOM(dom: HTMLElement, view: EditorView): boolean {
    if (dom.dataset.tableContext !== this.contextKey) {
      return false;
    }
    const grid = dom.querySelector<HTMLElement>(":scope > .cm-skr-table-grid");
    if (grid === null) {
      return false;
    }
    const rows = [
      ...grid.querySelectorAll<HTMLElement>(":scope > .cm-skr-table-row"),
    ];
    const expectedCells = this.layout.rows.flatMap((row) => row.cells);
    const cells = [
      ...grid.querySelectorAll<HTMLElement>(
        ":scope > .cm-skr-table-row > .cm-skr-table-cell",
      ),
    ];
    if (
      rows.length !== this.layout.rows.length ||
      cells.length !== expectedCells.length ||
      expectedCells.some(
        (cell, index) =>
          Number(cells[index]?.dataset.row) !== cell.row ||
          Number(cells[index]?.dataset.column) !== cell.column,
      )
    ) {
      return false;
    }

    grid.setAttribute("aria-rowcount", String(this.layout.rows.length));
    grid.setAttribute(
      "aria-colcount",
      String(Math.max(0, ...this.layout.rows.map((row) => row.cells.length))),
    );
    grid.dataset.tableFrom = String(this.layout.from);
    grid.dataset.tableTo = String(this.layout.to);
    for (const row of rows) {
      row.style.gridTemplateColumns = this.layout.columns;
      for (const cell of row.querySelectorAll<HTMLElement>(
        ":scope > .cm-skr-table-cell",
      )) {
        const column = Number(cell.dataset.column);
        cell.dataset.tableFrom = String(this.layout.from);
        cell.style.textAlign = this.layout.alignments[column] ?? "left";
      }
    }

    for (const [index, cell] of cells.entries()) {
      const layoutCell = expectedCells[index];
      const nested = nestedTableCellViews.get(cell);
      if (layoutCell === undefined || nested === undefined) {
        return false;
      }
      nestedTableCellParents.set(nested, {
        parent: view,
        tableFrom: this.layout.from,
        row: layoutCell.row,
        column: layoutCell.column,
      });
      if (nested.state.doc.toString() !== layoutCell.source) {
        const session = tableCellSessions.get(view);
        const active =
          session?.tableFrom === this.layout.from &&
          session.row === layoutCell.row &&
          session.column === layoutCell.column;
        // Edge whitespace the user is mid-typing exists in the nested view
        // but parses as column padding in the document, so the document
        // round trip reads back without it. While this cell owns the
        // caret, a trim-equal difference must not rebuild the nested doc
        // out from under the typed spaces; the next cell write re-emits
        // the full typed content anyway.
        if (
          active &&
          nested.state.doc.toString().trim() === layoutCell.source
        ) {
          continue;
        }
        const anchor = Math.min(
          layoutCell.source.length,
          active ? session.anchor : nested.state.selection.main.anchor,
        );
        const head = Math.min(
          layoutCell.source.length,
          active ? session.head : nested.state.selection.main.head,
        );
        syncingTableCellViews.add(nested);
        nested.dispatch({
          changes: {
            from: 0,
            to: nested.state.doc.length,
            insert: layoutCell.source,
          },
          selection: { anchor, head },
        });
        syncingTableCellViews.delete(nested);
      }
    }
    updateTableCellStates(view);
    return true;
  }

  override destroy(dom: HTMLElement): void {
    const grid = dom.querySelector<HTMLElement>(":scope > .cm-skr-table-grid");
    if (grid !== null) {
      tablePointerCleanups.get(grid)?.();
      tablePointerCleanups.delete(grid);
    }
    const parents = new Set<EditorView>();
    for (const host of dom.querySelectorAll<HTMLElement>(
      ".cm-skr-table-cell",
    )) {
      const nested = nestedTableCellViews.get(host);
      const owner =
        nested === undefined ? undefined : nestedTableCellParents.get(nested);
      if (owner !== undefined) {
        parents.add(owner.parent);
      }
      nested?.destroy();
      if (nested !== undefined) {
        nestedTableCellParents.delete(nested);
      }
      nestedTableCellViews.delete(host);
    }
    for (const parent of parents) {
      queueMicrotask(() => {
        const session = tableCellSessions.get(parent);
        if (
          session !== undefined &&
          tableCellHost(
            parent,
            session.tableFrom,
            session.row,
            session.column,
          ) === null
        ) {
          blurRenderedTableCell(parent);
        }
      });
    }
  }

  override ignoreEvent(): boolean {
    return true;
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

type ParsedEmbedSource = {
  source: string;
  headings: Array<{ from: number; to: number; level: number; title: string }>;
};

function parseEmbedSource(source: string): ParsedEmbedSource {
  const tree = skribeumMarkdownParser.parse(source);
  const headings: ParsedEmbedSource["headings"] = [];
  tree.iterate({
    enter(ref) {
      const level = headingLevel(ref.name);
      if (level !== null) {
        headings.push({
          from: ref.from,
          to: ref.to,
          level,
          title: headingTitle(source, ref.node).toLocaleLowerCase(),
        });
      }
      return undefined;
    },
  });
  return { source, headings };
}

function extractedEmbedSection(
  parsed: ParsedEmbedSource,
  fragment: string,
): string | null {
  if (fragment.length === 0) return parsed.source;
  const wanted = fragment.trim().toLocaleLowerCase();
  const index = parsed.headings.findIndex(
    (heading) => heading.title === wanted,
  );
  if (index === -1) {
    return null;
  }
  const heading = parsed.headings[index];
  if (heading === undefined) return null;
  const next = parsed.headings
    .slice(index + 1)
    .find((candidate) => candidate.level <= heading.level);
  const end = next?.from ?? parsed.source.length;
  return parsed.source.slice(heading.from, end).replace(/\n+$/u, "");
}

function embeddedSection(source: string, fragment: string): string | null {
  return fragment.length === 0
    ? source
    : extractedEmbedSection(parseEmbedSource(source), fragment);
}

function selfEmbedSectionKey(fragment: string): string {
  return `embed\u0000${fragment.trim().toLocaleLowerCase()}`;
}

function selectedSelfEmbed(
  parsed: ParsedEmbedSource,
  fragment: string,
): string | null {
  return extractedEmbedSection(parsed, fragment);
}

function previewSource(source: string): string {
  const frontmatter = parseFrontmatter(source);
  return frontmatter === null
    ? source
    : source.slice(frontmatter.to).replace(/^\r?\n+/u, "");
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
  rootSource: string | (() => Promise<string>),
  context: WikilinkResolutionContext,
  label: string,
  taskStatuses: readonly TaskStatus[],
  onRendered: () => void,
  kind: AsyncContentKind = "embed",
  preload?: PreloadedNote,
  selectedSelfEmbedSource?: () => Promise<string | null>,
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
    host.className = "cm-skr-embed-body cm-skr-embed-notice";
    host.setAttribute("role", "status");
    host.removeAttribute("aria-label");
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
  let destroyed = false;
  let visibilityObserver: IntersectionObserver | null = null;
  let stopRequest = () => {};
  const begin = () => {
    stopRequest();
    host.className = `cm-skr-embed-body skr-loading-region skr-loading-${kind}`;
    stopRequest = runAsyncContent({
      host,
      kind,
      load: () =>
        preload?.source ??
        (selectedSelfEmbedSource === undefined
          ? resolution.kind === "self"
            ? typeof rootSource === "string"
              ? Promise.resolve(rootSource)
              : rootSource()
            : (context.loadNote?.(resolvedPath) ?? Promise.resolve(null))
          : selectedSelfEmbedSource()),
      ...(kind === "preview" && preload?.status === "pending"
        ? { skeletonDelayMs: 0 }
        : {}),
      unavailable: (source) =>
        source === null && selectedSelfEmbedSource === undefined,
      ...(kind === "embed" ? { onRetry: begin } : {}),
      render: (source) => {
        if (destroyed || (!host.isConnected && !document.body.contains(host))) {
          return;
        }
        if (source === null) {
          notice(STRINGS.embedSectionUnavailable);
          return;
        }
        const selected =
          selectedSelfEmbedSource === undefined
            ? embeddedSection(
                kind === "preview" ? previewSource(source) : source,
                fragment,
              )
            : source;
        if (selected === null) {
          notice(STRINGS.embedSectionUnavailable);
          return;
        }
        host.className = "cm-skr-embed-body";
        const nested = nestedMarkdownView(
          host,
          selected,
          {
            ...context,
            currentPath: resolvedPath,
            embedDepth: depth + 1,
            embedAncestry:
              resolvedPath.length === 0
                ? ancestry
                : [...ancestry, resolvedPath],
            previewMode: kind === "preview",
          },
          label,
          taskStatuses,
        );
        if (typeof IntersectionObserver !== "undefined") {
          visibilityObserver = new IntersectionObserver((entries) => {
            if (entries.some((entry) => entry.isIntersecting)) {
              nested.requestMeasure();
              onRendered();
            }
          });
          visibilityObserver.observe(host);
        }
        onRendered();
      },
    });
  };
  begin();
  return () => {
    destroyed = true;
    stopRequest();
    visibilityObserver?.disconnect();
    nestedViews.get(host)?.destroy();
  };
}

type DeferredRootSourceLease = {
  select: (target: string) => Promise<string | null>;
  release: () => void;
};

/**
 * One editor-document generation may mount several self-embed widgets. They
 * all read the same root `Text`, so defer and materialize it once for that
 * generation. A different `Text` is a different CodeMirror document
 * generation; releasing its last widget fences any unpainted stale work.
 */
class DeferredRootSource {
  private references = 0;
  private pending: Promise<string> | null = null;
  private parsed: Promise<ParsedEmbedSource> | null = null;
  private readonly sections = new Map<string, Promise<string | null>>();
  private readonly scheduler = new PostPaintScheduler();

  constructor(private readonly document: Text) {}

  acquire(): DeferredRootSourceLease {
    this.references += 1;
    let released = false;
    return {
      select: (target) => this.select(target),
      release: () => {
        if (released) return;
        released = true;
        this.references -= 1;
        if (this.references === 0) {
          this.scheduler.fence();
          this.pending = null;
          this.parsed = null;
          this.sections.clear();
        }
      },
    };
  }

  private load(): Promise<string> {
    if (this.pending === null) {
      this.pending = new Promise<string>((resolve) => {
        this.scheduler.schedule(() => resolve(this.document.toString()));
      });
    }
    return this.pending;
  }

  private select(target: string): Promise<string | null> {
    const [, fragment = ""] = target.split("#", 2);
    if (fragment.length === 0) return this.load();
    const key = selfEmbedSectionKey(fragment);
    let selected = this.sections.get(key);
    if (selected === undefined) {
      if (this.parsed === null) {
        this.parsed = this.load().then(parseEmbedSource);
      }
      selected = this.parsed.then((parsed) =>
        selectedSelfEmbed(parsed, fragment),
      );
      this.sections.set(key, selected);
    }
    return selected;
  }
}

const deferredRootSources = new WeakMap<Text, DeferredRootSource>();

function deferredRootSource(document: Text): DeferredRootSourceLease {
  let source = deferredRootSources.get(document);
  if (source === undefined) {
    source = new DeferredRootSource(document);
    deferredRootSources.set(document, source);
  }
  return source.acquire();
}

class EmbedWidget extends WidgetType {
  private readonly cleanups = new WeakMap<HTMLElement, () => void>();
  private readonly rootSources = new WeakMap<
    HTMLElement,
    DeferredRootSourceLease
  >();

  constructor(
    readonly target: string,
    readonly rootDocument: Text | null,
    readonly context: WikilinkResolutionContext,
    readonly taskStatuses: readonly TaskStatus[],
  ) {
    super();
  }

  override eq(other: EmbedWidget): boolean {
    return (
      other.target === this.target &&
      other.rootDocument === this.rootDocument &&
      other.context === this.context &&
      JSON.stringify(other.taskStatuses) === JSON.stringify(this.taskStatuses)
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const host = document.createElement("span");
    host.className = "cm-skr-embed cm-skr-reveal-motion cm-skr-reveal-rendered";
    host.setAttribute("role", "group");
    host.dataset.target = this.target;
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
    header.setAttribute("role", "link");
    header.tabIndex = 0;
    header.textContent =
      fragment.length > 0 ? `${sourceName} · ${fragment}` : sourceName;
    let pointerHandled = false;
    const activate = () => {
      const provider = view.state.facet(wikilinkNavigationOptionsFacet);
      return provider === null
        ? false
        : followWikilinkTarget(this.target, provider());
    };
    header.addEventListener("mousedown", (event) => {
      pointerHandled = false;
      if (
        event.button !== 0 ||
        event.altKey ||
        event.shiftKey ||
        view.state.facet(wikilinkNavigationOptionsFacet) === null
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      pointerHandled = activate();
    });
    header.addEventListener("click", (event) => {
      if (
        event.button !== 0 ||
        event.altKey ||
        event.shiftKey ||
        view.state.facet(wikilinkNavigationOptionsFacet) === null
      ) {
        pointerHandled = false;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (!pointerHandled) {
        activate();
      }
      pointerHandled = false;
    });
    header.addEventListener("keydown", (event) => {
      if (
        event.key !== "Enter" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        view.state.facet(wikilinkNavigationOptionsFacet) === null
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      activate();
    });
    host.append(header);
    if (this.context.previewMode === true) {
      return host;
    }
    const body = document.createElement("span");
    body.className = "cm-skr-embed-body";
    host.append(body);
    const source =
      this.rootDocument === null ? null : deferredRootSource(this.rootDocument);
    if (source !== null) this.rootSources.set(host, source);
    const selectedSelfEmbedSource =
      source === null ? undefined : () => source.select(this.target);

    this.cleanups.set(
      host,
      renderLinkedNote(
        body,
        this.target,
        "",
        this.context,
        `${STRINGS.embedLabel}: ${sourceName}`,
        this.taskStatuses,
        () => view.requestMeasure(),
        "embed",
        undefined,
        selectedSelfEmbedSource,
      ),
    );
    return host;
  }

  override destroy(dom: HTMLElement): void {
    this.cleanups.get(dom)?.();
    this.cleanups.delete(dom);
    this.rootSources.get(dom)?.release();
    this.rootSources.delete(dom);
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
      rule.presentation.widget === "table")
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
  const attributes: [string, string][] = [
    ["role", "checkbox"],
    ["aria-checked", taskAriaChecked(status)],
    ["aria-label", status.name],
    ["data-task", status.symbol],
    ["data-track", taskStatusTrack(status)],
    ["data-category", status.category],
    ["data-color-token", status.color_token],
  ];
  const payload = taskStatusPayload(status);
  if (payload !== undefined) {
    attributes.push(["data-payload", payload]);
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
  taskStatuses?: readonly TaskStatus[];
  /** Preselected across the full table when decorations are split. */
  activeReveal?: RevealRegion | null;
  /** One table intentionally shown as source instead of its grid widget. */
  explicitTableSource?: { from: number; to: number } | null;
  /** Prevents parent-document inline decorations from overlapping table cells. */
  suppressRenderedTableDescendants?: boolean;
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
      const url = node.name === "URL" ? node : node.getChild("URL");
      const rawTarget = url === null ? null : doc.sliceString(url.from, url.to);
      const external = rawTarget === null ? null : externalHttpUrl(rawTarget);
      if (external !== null) {
        return {
          "data-external-url": external,
          role: "link",
          tabindex: "0",
        };
      }
      if (wikilinks.linkPreviews === false) {
        return {};
      }
      const target =
        rawTarget === null
          ? null
          : resolveMarkdownLinkTarget(rawTarget, wikilinks);
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
            "data-track": taskStatusTrack(status),
            "data-category": status.category,
            "data-color-token": status.color_token,
            ...(taskStatusPayload(status) === undefined
              ? {}
              : { "data-payload": taskStatusPayload(status) ?? "" }),
          };
    }
    case "task-date-payload": {
      const source = doc.sliceString(node.from, node.to);
      const date = source.slice(-10);
      return { "data-overdue": date < localIsoDate() ? "true" : "false" };
    }
    case "tag-search": {
      const tag = doc.sliceString(node.from + 1, node.to);
      return {
        "data-tag": tag,
        role: "link",
        tabindex: "0",
        "aria-label": `${STRINGS.tagSearchLabel}: #${tag}`,
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
  const primary = selection[0];
  if (
    primary === undefined ||
    selection.some((range) => range.from !== range.to)
  ) {
    return null;
  }
  const cursor = primary.to;
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
): {
  widget: WidgetType;
  block: boolean;
  attributes: Record<string, string>;
  to?: number;
} {
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
    case "table": {
      const layout = tableLayout(node, doc);
      return {
        widget: new TableWidget(layout, taskStatuses, wikilinks),
        block: true,
        to: layout.to,
        attributes: {
          role: "grid",
          "aria-rowcount": String(layout.rows.length),
        },
      };
    }
    case "embed": {
      const target = node.getChild("Wikilink")?.getChild("WikilinkTarget");
      const targetText =
        target === null || target === undefined
          ? ""
          : doc.sliceString(target.from, target.to);
      return {
        widget: new EmbedWidget(
          targetText,
          resolveWikilinkTarget(targetText, wikilinks).kind === "self"
            ? doc
            : null,
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
        if (
          ref.name === "Table" &&
          options.explicitTableSource !== null &&
          options.explicitTableSource !== undefined &&
          options.explicitTableSource.from <= ref.from &&
          options.explicitTableSource.to >= ref.to
        ) {
          return false;
        }
        if (
          ref.name === "Table" &&
          options.suppressRenderedTableDescendants === true
        ) {
          return false;
        }
        const nodeRules = rules.get(ref.name);
        if (nodeRules === undefined) {
          return undefined;
        }
        const node = ref.node;
        let embedOwnsDescendants = false;
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
              const lineDynamic = {
                ...dynamic,
                ...(revealedNow ? { "data-revealed": "true" } : {}),
                ...(rule.dynamic === "rich-callout"
                  ? {
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
                  : {}),
              };
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
                to: builtWidget.to ?? ref.to,
                decoration: Decoration.replace({
                  atomic: true,
                  widget: builtWidget.widget,
                  block: builtWidget.block,
                  skr,
                }),
              });
              if (
                presentation.widget === "embed" ||
                presentation.widget === "table"
              ) {
                // Complete replacements own their syntax subtrees. Descendant
                // decorations overlap the atomic range and can displace the
                // widget when another input to the engine refreshes.
                embedOwnsDescendants = true;
              }
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
        return embedOwnsDescendants ? false : undefined;
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

function revealSelection(state: EditorState): readonly {
  from: number;
  to: number;
}[] {
  const main = state.selection.main;
  return state.facet(sourceRevealEnabled) &&
    state.facet(sourceRevealFocusEnabled) &&
    state.field(tableCellRevealField, false) !== false &&
    main.empty &&
    state.selection.ranges.every((range) => range.empty)
    ? [{ from: main.head, to: main.head }]
    : [];
}

function buildViewDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const table = state.facet(decorationTable);
  const selection = revealSelection(state);
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
    explicitTableSource: state.field(explicitTableSourceField, false) ?? null,
    suppressRenderedTableDescendants:
      state.field(explicitTableSourceField, false) === null,
  });
}

function buildBlockDecorations(state: EditorState): DecorationSet {
  const table = state.facet(decorationTable);
  const selection = revealSelection(state);
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
    explicitTableSource: state.field(explicitTableSourceField, false) ?? null,
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

/**
 * Native deletion and history replay may change a very large document while
 * leaving the user waiting for the next paint. Existing decorations map
 * exactly through those changes, so defer their expensive syntax walk until
 * after the input transaction. Commands that deliberately change structure
 * retain the synchronous rebuild they need to update their rendered control.
 */
function changesTouchBlockDecoration(
  changes: Transaction["changes"],
  decorations: DecorationSet | undefined,
): boolean {
  if (decorations === undefined) return false;
  let touched = false;
  changes.iterChangedRanges((fromA, toA) => {
    decorations.between(fromA, toA, () => {
      touched = true;
    });
  });
  return touched;
}

function defersDecorationRebuild(
  transaction: Transaction,
  blockDecorations?: DecorationSet,
): boolean {
  return (
    transaction.docChanged &&
    !changesTouchBlockDecoration(transaction.changes, blockDecorations) &&
    (transaction.annotation(bulkTextInputAnnotation) === true ||
      transaction.isUserEvent("delete") ||
      transaction.isUserEvent("undo") ||
      transaction.isUserEvent("redo"))
  );
}

function activeRevealIn(state: EditorState): RevealRegion | null {
  const table = state.facet(decorationTable);
  return findActiveReveal(
    state.doc,
    syntaxTree(state),
    table,
    revealSelection(state),
    state.field(wikilinkContext, false) ?? EMPTY_WIKILINK_CONTEXT,
    state.facet(taskStatusConfiguration),
  );
}

function mappedReveal(
  reveal: RevealRegion | null,
  transaction: Transaction,
): RevealRegion | null {
  return reveal === null
    ? null
    : {
        ...reveal,
        from: transaction.changes.mapPos(reveal.from, -1),
        to: transaction.changes.mapPos(reveal.to, 1),
      };
}

function refreshRevealDecorations(
  decorations: DecorationSet,
  transaction: Transaction,
  kind: "inline" | "block",
): DecorationSet {
  const previous = mappedReveal(
    activeRevealIn(transaction.startState),
    transaction,
  );
  const active = activeRevealIn(transaction.state);
  const ranges = [previous, active].filter(
    (range): range is RevealRegion => range !== null,
  );
  if (ranges.length === 0) return decorations;

  const state = transaction.state;
  const table = splitTable(state.facet(decorationTable))[kind];
  const replacement = computeDecorations({
    doc: state.doc,
    tree: syntaxTree(state),
    table,
    selection: revealSelection(state),
    ranges,
    wikilinks: state.field(wikilinkContext, false) ?? EMPTY_WIKILINK_CONTEXT,
    taskStatuses: state.facet(taskStatusConfiguration),
    activeReveal: active,
    explicitTableSource: state.field(explicitTableSourceField, false) ?? null,
    ...(kind === "inline"
      ? {
          suppressRenderedTableDescendants:
            state.field(explicitTableSourceField, false) === null,
        }
      : {}),
  });
  const added: ReturnType<Decoration["range"]>[] = [];
  const cursor = replacement.iter();
  while (cursor.value !== null) {
    added.push(cursor.value.range(cursor.from, cursor.to));
    cursor.next();
  }
  return decorations.update({
    filter: (from, to) =>
      !ranges.some((range) => from <= range.to && to >= range.from),
    add: added,
    sort: true,
  });
}

function decorationInputsChanged(
  state: EditorState,
  startState: EditorState,
): boolean {
  return (
    state.facet(decorationTable) !== startState.facet(decorationTable) ||
    state.facet(sourceRevealEnabled) !==
      startState.facet(sourceRevealEnabled) ||
    state.facet(sourceRevealFocusEnabled) !==
      startState.facet(sourceRevealFocusEnabled) ||
    state.field(tableCellRevealField, false) !==
      startState.field(tableCellRevealField, false) ||
    state.facet(taskStatusConfiguration) !==
      startState.facet(taskStatusConfiguration) ||
    state.field(wikilinkContext, false) !==
      startState.field(wikilinkContext, false) ||
    state.field(explicitTableSourceField, false) !==
      startState.field(explicitTableSourceField, false)
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
    if (defersDecorationRebuild(transaction, value.decorations)) {
      const decorations = transaction.docChanged
        ? value.decorations.map(transaction.changes)
        : value.decorations;
      return {
        decorations:
          transaction.selection !== transaction.startState.selection
            ? refreshRevealDecorations(decorations, transaction, "block")
            : decorations,
        deferred: true,
      };
    }
    if (value.deferred && !transaction.docChanged) {
      if (transaction.selection !== transaction.startState.selection) {
        return {
          decorations: refreshRevealDecorations(
            value.decorations,
            transaction,
            "block",
          ),
          deferred: true,
        };
      }
      if (!decorationInputsChanged(transaction.state, transaction.startState)) {
        return { ...value, deferred: true };
      }
    }
    if (
      transaction.docChanged ||
      transaction.selection !== transaction.startState.selection ||
      syntaxTree(transaction.state) !== syntaxTree(transaction.startState) ||
      decorationInputsChanged(transaction.state, transaction.startState)
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
    decorationInputsChanged(update.state, update.startState)
  );
}

function deferredUpdateNeedsImmediateRebuild(update: ViewUpdate): boolean {
  return decorationInputsChanged(update.state, update.startState);
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
        this.decorations = this.build(update.view);
        return;
      }
      const blockDecorations = update.startState.field(
        blockEngineField,
        false,
      )?.decorations;
      const deferredInput = update.transactions.some((transaction) =>
        defersDecorationRebuild(transaction, blockDecorations),
      );
      if (deferredInput) {
        const decorations = update.docChanged
          ? this.decorations.map(update.changes)
          : this.decorations;
        const transaction = update.transactions.at(-1);
        this.decorations =
          update.selectionSet && transaction !== undefined
            ? refreshRevealDecorations(decorations, transaction, "inline")
            : decorations;
        this.deferred = true;
        this.scheduleRefresh(update.view);
        return;
      }
      if (this.deferred) {
        if (
          !update.docChanged &&
          !deferredUpdateNeedsImmediateRebuild(update)
        ) {
          const transaction = update.transactions.at(-1);
          if (update.selectionSet && transaction !== undefined) {
            this.decorations = refreshRevealDecorations(
              this.decorations,
              transaction,
              "inline",
            );
          }
          return;
        }
        this.cancelRefresh();
        this.deferred = false;
      }
      if (needsRebuild(update)) {
        this.decorations = this.build(update.view);
      }
    }

    private build(view: EditorView): DecorationSet {
      return buildViewDecorations(view);
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

    private cancelRefresh(): void {
      if (this.refreshFrame !== null) {
        cancelAnimationFrame(this.refreshFrame);
        this.refreshFrame = null;
      }
    }

    destroy(): void {
      this.destroyed = true;
      this.cancelRefresh();
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

let nextPreviewId = 0;

type PreviewPoint = { x: number; y: number };

type PreloadedNote = {
  target: string;
  status: "pending" | "settled";
  source: Promise<string | null>;
};

function triangleArea(
  a: PreviewPoint,
  b: PreviewPoint,
  c: PreviewPoint,
): number {
  return Math.abs(
    (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y)) / 2,
  );
}

/** Tests the safe-triangle corridor from a departed link to its preview. */
export function pointInPreviewCone(
  point: PreviewPoint,
  origin: PreviewPoint,
  panel: Pick<DOMRect, "left" | "right" | "top" | "bottom">,
): boolean {
  let first: PreviewPoint;
  let second: PreviewPoint;
  if (origin.x <= panel.left) {
    first = { x: panel.left, y: panel.top - 12 };
    second = { x: panel.left, y: panel.bottom + 12 };
  } else if (origin.x >= panel.right) {
    first = { x: panel.right, y: panel.top - 12 };
    second = { x: panel.right, y: panel.bottom + 12 };
  } else if (origin.y <= panel.top) {
    first = { x: panel.left - 12, y: panel.top };
    second = { x: panel.right + 12, y: panel.top };
  } else {
    first = { x: panel.left - 12, y: panel.bottom };
    second = { x: panel.right + 12, y: panel.bottom };
  }
  const whole = triangleArea(origin, first, second);
  const parts =
    triangleArea(point, first, second) +
    triangleArea(origin, point, second) +
    triangleArea(origin, first, point);
  return Math.abs(parts - whole) < 0.75;
}

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
  private leavePoint: PreviewPoint | null = null;
  private coneTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private preload: PreloadedNote | null = null;
  private placementFrame: number | null = null;
  private readonly stopObservingViewport: () => void;

  constructor(readonly view: EditorView) {
    view.dom.addEventListener("pointerover", this.onPointerOver);
    view.dom.addEventListener("pointerout", this.onPointerOut);
    view.dom.addEventListener("pointermove", this.onPointerMove);
    view.dom.addEventListener("focusin", this.onFocusIn);
    view.dom.addEventListener("focusout", this.onFocusOut);
    this.stopObservingViewport = observeVisualViewport(
      this.onGeometryChanged,
      view.dom.ownerDocument.defaultView ?? window,
    );
    window.addEventListener("scroll", this.onScroll, true);
    window.addEventListener("pointermove", this.onPointerMove, true);
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

  private cancelTravelTimers(): void {
    if (this.coneTimer !== null) clearTimeout(this.coneTimer);
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.coneTimer = null;
    this.closeTimer = null;
  }

  private scheduleClose(): void {
    if (this.coneTimer !== null) {
      clearTimeout(this.coneTimer);
      this.coneTimer = null;
    }
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.closeTimer = setTimeout(() => {
      this.closeTimer = null;
      this.dismiss();
    }, 100);
  }

  private keepConeAlive(): void {
    if (this.coneTimer !== null) clearTimeout(this.coneTimer);
    this.coneTimer = setTimeout(() => {
      this.coneTimer = null;
      this.dismiss();
    }, 300);
  }

  private schedule(link: HTMLElement): void {
    if (link === this.activeLink || link === this.scheduledLink) {
      return;
    }
    this.dismiss();
    this.preload = this.preloadNote(link);
    this.scheduledLink = link;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.scheduledLink = null;
      this.show(link);
    }, hoverIntentDelay(this.view.dom.ownerDocument.documentElement));
  }

  private preloadNote(link: HTMLElement): PreloadedNote | null {
    const context = currentWikilinkContext(this.view.state);
    const target = link.dataset.previewTarget;
    if (target === undefined) return null;
    const resolution = resolveWikilinkTarget(target, context);
    if (resolution.kind === "unresolved") return null;
    const record: PreloadedNote = {
      target,
      status: "pending",
      source: Promise.resolve(null),
    };
    const request =
      resolution.kind === "self"
        ? Promise.resolve(this.view.state.doc.toString())
        : (context.loadNote?.(resolution.path) ?? Promise.resolve(null));
    record.source = request.then(
      (source) => {
        record.status = "settled";
        return source;
      },
      () => {
        record.status = "settled";
        return null;
      },
    );
    return record;
  }

  private show(link: HTMLElement): void {
    const context = currentWikilinkContext(this.view.state);
    const target = link.dataset.previewTarget;
    if (context.linkPreviews === false || target === undefined) {
      return;
    }
    const preload = this.preload?.target === target ? this.preload : undefined;
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
    panel.setAttribute("role", "region");
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

    this.place(panel, link);
    enterMotionSurface(panel);

    this.activeLink = link;
    this.panel = panel;
    this.leavePoint = null;
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
      () => {
        this.view.requestMeasure();
        this.schedulePlacement(panel, link);
      },
      "preview",
      preload,
    );
  }

  private place(panel: HTMLElement, link: HTMLElement): void {
    const ownerWindow = this.view.dom.ownerDocument.defaultView ?? window;
    const viewport = visualViewportRect(ownerWindow);
    const bounds = link.getBoundingClientRect();
    const rootSize = Number.parseFloat(
      getComputedStyle(this.view.dom.ownerDocument.documentElement).fontSize,
    );
    panel.style.maxHeight = `${Math.min(
      18 * rootSize,
      Math.max(0, viewport.height - 24),
    )}px`;
    const panelBounds = panel.getBoundingClientRect();
    const left = Math.max(
      viewport.left + 12,
      Math.min(bounds.left, viewport.right - panelBounds.width - 12),
    );
    panel.style.left = `${left}px`;
    const below = bounds.bottom + 8;
    const above = bounds.top - panelBounds.height - 8;
    const placedBelow = below + panelBounds.height <= viewport.bottom - 12;
    panel.style.top = `${
      placedBelow
        ? Math.max(viewport.top + 12, below)
        : Math.max(viewport.top + 12, above)
    }px`;
    panel.dataset.motionSurface = placedBelow
      ? "anchored-top"
      : "anchored-bottom";
  }

  private schedulePlacement(panel: HTMLElement, link: HTMLElement): void {
    if (this.placementFrame !== null) {
      return;
    }
    this.placementFrame = requestAnimationFrame(() => {
      this.placementFrame = null;
      if (
        this.panel === panel &&
        this.activeLink === link &&
        panel.isConnected
      ) {
        this.place(panel, link);
      }
    });
  }

  private dismiss(): void {
    this.cancelTimer();
    this.cancelTravelTimers();
    if (this.placementFrame !== null) {
      cancelAnimationFrame(this.placementFrame);
      this.placementFrame = null;
    }
    const panel = this.panel;
    const cleanupRender = this.cleanupRender;
    this.cleanupRender = null;
    this.panel = null;
    if (panel !== null) {
      void exitMotionSurface(panel, () => {
        cleanupRender?.();
        panel.remove();
      });
    } else {
      cleanupRender?.();
    }
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
    this.preload = null;
    this.leavePoint = null;
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
      this.cancelTravelTimers();
      this.leavePoint = null;
      this.schedule(link);
    } else if (this.panelContains(event.target)) {
      this.cancelTravelTimers();
    }
  };

  private readonly onPointerOut = (event: PointerEvent) => {
    const link = this.previewLink(event.target);
    const next = this.previewLink(event.relatedTarget);
    if (
      link !== null &&
      next !== link &&
      !this.panelContains(event.relatedTarget)
    ) {
      if (this.panel === null) {
        this.cancelTimer();
        return;
      }
      this.leavePoint = { x: event.clientX, y: event.clientY };
      this.keepConeAlive();
    } else if (
      this.panelContains(event.target) &&
      next !== this.activeLink &&
      !this.panelContains(event.relatedTarget)
    ) {
      this.scheduleClose();
    }
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.panel === null || this.leavePoint === null) return;
    if (
      this.panelContains(event.target) ||
      this.previewLink(event.target) === this.activeLink
    ) {
      this.cancelTravelTimers();
      this.leavePoint = null;
      return;
    }
    if (
      pointInPreviewCone(
        { x: event.clientX, y: event.clientY },
        this.leavePoint,
        this.panel.getBoundingClientRect(),
      )
    ) {
      if (this.closeTimer !== null) {
        clearTimeout(this.closeTimer);
        this.closeTimer = null;
      }
      this.keepConeAlive();
    } else {
      this.scheduleClose();
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
    this.view.dom.removeEventListener("pointermove", this.onPointerMove);
    this.view.dom.removeEventListener("focusin", this.onFocusIn);
    this.view.dom.removeEventListener("focusout", this.onFocusOut);
    this.stopObservingViewport();
    window.removeEventListener("scroll", this.onScroll, true);
    window.removeEventListener("pointermove", this.onPointerMove, true);
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

/**
 * The frontmatter block hides through a per-line CSS rule (`cm-skr-frontmatter`
 * lines display:none unless revealed), not through a replacement decoration,
 * so it carries no `atomic` spec of its own and CodeMirror's own layout never
 * learns the block is collapsed. Scans one decoration set for hidden
 * frontmatter lines (class `cm-skr-frontmatter` without `data-revealed`) and
 * folds them into the block's full line range, or null when the block does
 * not exist or is currently revealed.
 */
function hiddenFrontmatterRangeIn(
  view: EditorView,
  set: DecorationSet,
): { from: number; to: number } | null {
  let from: number | null = null;
  let to: number | null = null;
  const cursor = set.iter();
  while (cursor.value !== null) {
    const spec = cursor.value.spec as {
      class?: string;
      attributes?: Record<string, string>;
    };
    if (
      spec.class === "cm-skr-frontmatter" &&
      spec.attributes?.["data-revealed"] !== "true"
    ) {
      const line = view.state.doc.lineAt(cursor.from);
      from = from === null ? line.from : Math.min(from, line.from);
      to = to === null ? line.to : Math.max(to, line.to);
    }
    cursor.next();
  }
  return from !== null && to !== null && from < to ? { from, to } : null;
}

/** The document range of the currently hidden (unrevealed) frontmatter block. */
function hiddenFrontmatterRange(
  view: EditorView,
): { from: number; to: number } | null {
  const inline = view.plugin(enginePlugin)?.decorations;
  const block = view.state.field(blockEngineField, false)?.decorations;
  for (const set of [inline, block]) {
    if (set === undefined) {
      continue;
    }
    const hidden = hiddenFrontmatterRangeIn(view, set);
    if (hidden !== null) {
      return hidden;
    }
  }
  return null;
}

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
  const hidden = hiddenFrontmatterRange(view);
  if (hidden !== null) {
    ranges.push(
      Decoration.mark({ atomic: true }).range(hidden.from, hidden.to),
    );
  }
  return Decoration.set(ranges, true);
}

/**
 * The frontmatter block always starts at document position 0, so CodeMirror's
 * generic atomic-range clamp (which pushes an upward move to the near edge of
 * the obstacle, i.e. its `from`) lands the caret at position 0: still inside
 * the hidden block, since there is nothing before it to land on instead. This
 * intercepts ArrowUp specifically at the boundary line right after the hidden
 * block (the only place upward motion can reach into it) and, if the default
 * command's own geometry still lands inside, restores the original position
 * rather than stranding the caret in text the DOM never displays.
 */
export function frontmatterAwareCursorUp(view: EditorView): boolean {
  const hidden = hiddenFrontmatterRange(view);
  if (hidden === null) {
    return false;
  }
  const before = view.state.selection.main;
  if (!before.empty) {
    return false;
  }
  const boundary = Math.min(hidden.to + 1, view.state.doc.length);
  if (view.state.doc.lineAt(before.head).from !== boundary) {
    return false;
  }
  cursorLineUp(view);
  const after = view.state.selection.main;
  if (after.empty && after.head >= hidden.from && after.head < hidden.to) {
    view.dispatch({
      selection: EditorSelection.cursor(before.head, before.assoc),
      userEvent: "select",
    });
  }
  return true;
}

const frontmatterCursorGuard = Prec.highest(
  keymap.of([{ key: "ArrowUp", run: frontmatterAwareCursorUp }]),
);

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

function syncTableSelection(view: EditorView): void {
  const selection = view.state.selection.main;
  for (const grid of view.dom.querySelectorAll<HTMLElement>(
    ".cm-skr-table-grid[data-table-from][data-table-to]",
  )) {
    const from = Number(grid.dataset.tableFrom);
    const to = Number(grid.dataset.tableTo);
    grid.classList.toggle(
      "cm-skr-table-selected",
      !selection.empty && selection.from <= from && selection.to >= to,
    );
  }
}

const tableSessionPlugin = ViewPlugin.fromClass(
  class {
    constructor(readonly view: EditorView) {
      syncTableSelection(view);
    }

    update(update: ViewUpdate): void {
      const source = update.state.field(explicitTableSourceField, false);
      const recognizedSource =
        source === null || source === undefined
          ? null
          : tableLayoutWithin(update.state, source.from, source.to);
      if (
        source !== null &&
        source !== undefined &&
        (recognizedSource === null ||
          (update.selectionSet &&
            (update.state.selection.main.head < recognizedSource.from ||
              update.state.selection.main.head > recognizedSource.to)))
      ) {
        queueMicrotask(() => closeRenderedTableSource(this.view, false));
      } else if (
        source !== null &&
        source !== undefined &&
        recognizedSource !== null &&
        (source.from !== recognizedSource.from ||
          source.to !== recognizedSource.to)
      ) {
        queueMicrotask(() => {
          this.view.dispatch({
            effects: setExplicitTableSource.of({
              ...source,
              from: recognizedSource.from,
              to: recognizedSource.to,
            }),
          });
        });
      }
      let session = tableCellSessions.get(this.view);
      if (session !== undefined && update.docChanged) {
        const previousFrom = session.tableFrom;
        const previousTo = session.tableTo;
        const activeRow = session.row;
        const activeColumn = session.column;
        const previousCell = tableCellRanges(
          update.startState.sliceDoc(previousFrom, previousTo),
        ).find(
          (cell) => cell.row === activeRow && cell.column === activeColumn,
        );
        const inputFromNestedCell = update.transactions.some((transaction) =>
          transaction.isUserEvent("input.table-cell"),
        );
        let replacedWholeTable = false;
        update.changes.iterChangedRanges((from, to) => {
          if (from <= previousFrom && to >= previousTo) {
            replacedWholeTable = true;
          }
        });
        session.tableFrom = update.changes.mapPos(previousFrom, -1);
        session.tableTo = update.changes.mapPos(previousTo, 1);
        const layout = replacedWholeTable
          ? null
          : tableLayoutAt(update.state, session.tableFrom);
        if (
          layout === null ||
          !layout.rows[activeRow]?.cells.some(
            (cell) => cell.column === activeColumn,
          )
        ) {
          blurRenderedTableCell(this.view);
          session = undefined;
        } else {
          session.tableFrom = layout.from;
          session.tableTo = layout.to;
          const currentCell = tableCellRanges(
            update.state.sliceDoc(layout.from, layout.to),
          ).find(
            (cell) => cell.row === activeRow && cell.column === activeColumn,
          );
          if (
            !inputFromNestedCell &&
            previousCell !== undefined &&
            currentCell !== undefined
          ) {
            const currentCellFrom = layout.from + currentCell.from;
            const currentCellLength = currentCell.to - currentCell.from;
            const mapSelection = (position: number): number =>
              Math.max(
                0,
                Math.min(
                  currentCellLength,
                  update.changes.mapPos(
                    previousFrom + previousCell.from + position,
                    1,
                  ) - currentCellFrom,
                ),
              );
            session.anchor = mapSelection(session.anchor);
            session.head = mapSelection(session.head);
            session.verticalGoal = mapSelection(session.verticalGoal);
          }
        }
      }
      if (
        session !== undefined &&
        update.selectionSet &&
        (!update.state.selection.main.empty ||
          update.state.selection.main.head !== session.tableFrom)
      ) {
        blurRenderedTableCell(this.view);
      }
      if (update.docChanged || update.selectionSet) {
        syncTableSelection(this.view);
        queueMicrotask(() => {
          syncTableSelection(this.view);
          updateTableCellStates(this.view);
        });
      }
    }

    destroy(): void {
      blurRenderedTableCell(this.view);
    }
  },
  {
    eventHandlers: {
      mousedown(event, view) {
        if (
          event.target instanceof Element &&
          event.target.closest(".cm-skr-table-grid") === null
        ) {
          blurRenderedTableCell(view);
        }
        return false;
      },
    },
  },
);

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
  // The reserved-width geometry lives here and applies with no transition,
  // so it always resolves in the same frame the caret enters the line. The
  // glyph's own opacity and compositor translate (entrance on the surface
  // clock, exit on the state clock, app.css) animate inside that already
  // -settled space.
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
  "[data-external-url]": { cursor: "pointer" },
  ".cm-skr-link-label": { color: "var(--skr-link)" },
  ".cm-skr-wikilink": {
    color: "var(--skr-link)",
    cursor: "pointer",
  },
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
    // Right corners only, matching the callout treatment: the accent bar
    // stays flush with the column edge (design system section 5.12,
    // embeds are a content block).
    borderTopRightRadius: "var(--skr-radius-surface)",
    borderBottomRightRadius: "var(--skr-radius-surface)",
    backgroundColor: "var(--skr-surface-subtle)",
    verticalAlign: "top",
  },
  ".cm-skr-embed.cm-skr-embed-failed": {
    borderLeftColor: "var(--skr-danger)",
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
    width: "min(24rem, calc(100vw - 1.5rem))",
    minHeight: "6rem",
    maxHeight: "18rem",
    overflow: "auto",
    border: "1px solid var(--skr-border)",
    borderRadius: "var(--skr-radius-surface)",
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface-raised)",
    boxShadow: "var(--skr-shadow)",
    fontFamily: "var(--skr-font-prose)",
  },
  ".cm-skr-link-preview-header": {
    position: "sticky",
    top: "0",
    zIndex: "1",
    padding: "0.5rem 1rem",
    borderBottom: "1px solid var(--skr-border)",
    color: "var(--skr-text-muted)",
    backgroundColor: "var(--skr-surface-raised)",
    fontFamily: "var(--skr-font-interface)",
    fontSize: "13px",
    fontWeight: "400",
  },
  ".cm-skr-link-preview-body": { padding: "0.75rem 1rem" },
  ".cm-skr-list-mark": { color: "var(--skr-accent)" },
  ".cm-skr-task-control": {
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
    transition:
      "color var(--skr-motion-state-duration) var(--skr-motion-state-easing), background-color var(--skr-motion-state-duration) var(--skr-motion-state-easing), border-color var(--skr-motion-state-duration) var(--skr-motion-state-easing), opacity var(--skr-motion-state-duration) var(--skr-motion-state-easing)",
  },
  ".cm-skr-task-control-pressing": {
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
    position: "fixed",
    zIndex: "20",
    top: "0",
    left: "0",
    boxSizing: "border-box",
    display: "grid",
    gridTemplateColumns: "minmax(12rem, 1fr)",
    width: "max-content",
    maxWidth: "calc(var(--skr-visual-viewport-width) - 1rem)",
    padding: "0.35rem",
    overflow: "auto",
    color: "var(--skr-text)",
    // The palette is interface chrome, not document prose; without this it
    // inherits `.cm-content`'s serif prose stack and its rows read in the
    // wrong face next to every other menu in the product (design system
    // section 2.3: interface controls and palette rows use the interface
    // face). Row-level font-size declarations stay relative to whatever
    // this resolves to, unchanged.
    fontFamily: "var(--skr-font-interface)",
    backgroundColor: "var(--skr-surface-raised)",
    border: "1px solid var(--skr-border)",
    borderRadius: "var(--skr-radius-surface)",
    boxShadow: "var(--skr-shadow)",
  },
  ".cm-skr-task-palette[hidden]": { display: "none" },
  ".cm-skr-task-track": {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr)",
  },
  ".cm-skr-task-track-heading": {
    padding: "0.35rem 0.5rem 0.15rem",
    color: "var(--skr-text-muted)",
    fontFamily: "var(--skr-font-interface)",
    fontSize: "12px",
    fontWeight: "700",
    letterSpacing: "0.08em",
    lineHeight: "1.2",
    textTransform: "uppercase",
  },
  ".cm-skr-task-option": {
    display: "flex",
    alignItems: "center",
    gap: "0.4rem",
    minWidth: "0",
    minHeight: "2.75rem",
    padding: "0.375rem 0.5rem",
    borderRadius: "var(--skr-radius-control)",
    cursor: "pointer",
    transition:
      "background-color var(--skr-motion-state-duration) var(--skr-motion-state-easing), color var(--skr-motion-state-duration) var(--skr-motion-state-easing)",
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
  ".cm-skr-task-payload-footer": {
    display: "grid",
    gridTemplateColumns: "auto minmax(8.5rem, 1fr)",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.5rem",
    borderTop: "1px solid var(--skr-border)",
  },
  ".cm-skr-task-payload-label": {
    color: "var(--skr-text-muted)",
    fontFamily: "var(--skr-font-interface)",
    fontSize: "0.8125em",
  },
  ".cm-skr-task-payload-footer input": {
    // De-boxed per design system section 5.12: a flat field with a bottom
    // rule only, never a boxed outline.
    boxSizing: "border-box",
    minHeight: "2.25rem",
    padding: "0.25rem 0.4rem",
    color: "var(--skr-text)",
    backgroundColor: "var(--skr-surface)",
    border: "0",
    borderBottom: "1px solid var(--skr-border-strong)",
    borderRadius: "0",
    fontFamily: "var(--skr-font-interface)",
  },
  ".cm-skr-task-payload": {
    padding: "0.08em 0.3em",
    color: "var(--skr-text-muted)",
    backgroundColor: "var(--skr-surface-subtle)",
    borderRadius: "var(--skr-radius-control)",
    fontFamily: "var(--skr-font-interface)",
    fontSize: "0.8125em",
  },
  '.cm-skr-task-payload[data-overdue="true"]': {
    color: "var(--skr-danger)",
  },
  ".cm-skr-inline-code": {
    fontFamily: "var(--skr-font-mono)",
    fontSize: "0.9em",
    fontWeight: "400",
    backgroundColor: "var(--skr-code-surface)",
    borderRadius: "var(--skr-radius-control)",
    padding: "0 2px",
  },
  ".cm-skr-table-shell": {
    position: "relative",
    boxSizing: "border-box",
    width: "100%",
    overflow: "visible",
  },
  ".cm-skr-table-grid": {
    boxSizing: "border-box",
    width: "100%",
  },
  ".cm-skr-table-row": {
    boxSizing: "border-box",
    display: "grid",
    width: "100%",
    borderLeft: "1px solid var(--skr-border)",
    borderRight: "1px solid var(--skr-border)",
    borderBottom: "1px solid var(--skr-border)",
    backgroundColor: "var(--skr-surface)",
  },
  ".cm-skr-table-first": {
    borderTop: "1px solid var(--skr-border)",
    borderTopLeftRadius: "0.375rem",
    borderTopRightRadius: "0.375rem",
  },
  ".cm-skr-table-last": {
    borderBottomLeftRadius: "0.375rem",
    borderBottomRightRadius: "0.375rem",
  },
  ".cm-skr-table-header": {
    backgroundColor: "var(--skr-surface-subtle)",
    fontFamily: "var(--skr-font-interface)",
    fontSize: "0.875em",
    fontWeight: "600",
  },
  ".cm-skr-table-cell": {
    boxSizing: "border-box",
    minWidth: "0",
    overflowWrap: "anywhere",
    borderRight: "1px solid var(--skr-border)",
  },
  ".cm-skr-table-cell:last-child": { borderRight: "0" },
  ".cm-skr-table-cell[data-editing=true]": {
    outline: "2px solid var(--skr-focus)",
    outlineOffset: "-2px",
  },
  ".cm-skr-table-selected .cm-skr-table-cell": {
    backgroundColor: "var(--skr-selection-surface)",
    color: "var(--skr-selection-text)",
  },
  ".cm-skr-table-cell-editor .cm-editor": {
    minHeight: "100%",
    color: "inherit",
    backgroundColor: "transparent",
  },
  ".cm-skr-table-cell-editor .cm-editor.cm-focused": { outline: "none" },
  ".cm-skr-table-cell-editor .cm-scroller": {
    overflow: "visible",
    fontFamily: "inherit",
    lineHeight: "inherit",
  },
  ".cm-skr-table-cell-editor .cm-content": {
    minHeight: "1.7em",
    padding: "0.375rem 0.625rem",
    caretColor: "var(--skr-caret)",
    fontFamily: "inherit",
    lineHeight: "inherit",
    textAlign: "inherit",
  },
  ".cm-skr-table-cell-editor .cm-line": {
    padding: "0",
    textAlign: "inherit",
  },
  ".cm-skr-table-cell-editor .cm-gutters, .cm-skr-table-cell-editor .cm-activeLine":
    { backgroundColor: "transparent" },
  ".cm-skr-table-insert": {
    position: "absolute",
    zIndex: "2",
    margin: "0",
    padding: "0",
    color: "var(--skr-text-muted)",
    backgroundColor: "transparent",
    border: "0",
    opacity: "0",
    cursor: "pointer",
    transition:
      "opacity var(--skr-motion-state-duration) var(--skr-motion-state-easing)",
  },
  ".cm-skr-table-insert:hover, .cm-skr-table-insert:focus-visible": {
    opacity: "1",
  },
  ".cm-skr-table-insert-row": {
    left: "0",
    bottom: "-1.25rem",
    width: "100%",
    height: "1.75rem",
    paddingTop: "0.5rem",
    backgroundImage:
      "linear-gradient(to bottom, transparent calc(0.5rem - 1px), var(--skr-border-strong) calc(0.5rem - 1px), var(--skr-border-strong) 0.5rem, transparent 0.5rem)",
  },
  ".cm-skr-table-insert-column": {
    top: "0",
    right: "-1.25rem",
    width: "1.75rem",
    height: "100%",
    paddingLeft: "0.5rem",
    backgroundImage:
      "linear-gradient(to right, transparent calc(0.5rem - 1px), var(--skr-border-strong) calc(0.5rem - 1px), var(--skr-border-strong) 0.5rem, transparent 0.5rem)",
  },
  '[data-table-cell-active="true"] > .cm-scroller > .cm-cursorLayer .cm-cursor':
    {
      display: "none",
    },
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
    borderRadius: "var(--skr-radius-control)",
    opacity: "0",
    pointerEvents: "none",
    transition:
      "opacity var(--skr-motion-state-duration) var(--skr-motion-state-easing)",
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
    borderRadius: "var(--skr-radius-control)",
    padding: "0 4px",
    cursor: "pointer",
  },
  '.cm-skr-tag[role="link"]:focus-visible': {
    outline: "2px solid var(--skr-focus)",
    outlineOffset: "2px",
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
    borderRadius: "var(--skr-radius-surface)",
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
    explicitTableSourceField,
    blockEngineField,
    enginePlugin,
    linkPreviewPlugin,
    linkPreviewKeys,
    EditorView.atomicRanges.of(atomicDecorations),
    frontmatterCursorGuard,
    calloutPointerMapping,
    tableSessionPlugin,
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
