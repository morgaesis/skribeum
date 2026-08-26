<script lang="ts">
import { history, redo, undo } from "@codemirror/commands";
import { indentUnit, syntaxTree } from "@codemirror/language";
import {
  Annotation,
  type ChangeSet,
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
  Transaction,
} from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { onMount } from "svelte";
import { bulkTextInput } from "./editor/bulkInput";
import type { ByteChange } from "./editor/byteChangeSet";
import { assertDecorationsInert } from "./editor/decorationGuard";
import {
  dispatchWikilinkContext,
  focusedRenderedTableCell,
  sourceRevealFocusMode,
  sourceRevealMode,
} from "./editor/decorations/engine";
import {
  type WikilinkResolutionContext,
  wikilinkPointerNavigation,
} from "./editor/decorations/wikilinks";
import { isMarkdownDocument } from "./editor/documentKinds";
import { DurableEditHistory } from "./editor/durableHistory";
import {
  applyTypeOverrides,
  type Frontmatter,
  type FrontmatterValueType,
  parseFrontmatter,
  propertyInsertion,
} from "./editor/frontmatter";
import { showInvisibleCharacters } from "./editor/invisibles";
import { caretMotion } from "./editor/motion";
import { NoteSession } from "./editor/noteSession";
import { PostPaintScheduler } from "./editor/postPaintScheduler";
import {
  fileSyntaxExtensions,
  noteRenderingExtensions,
  noteSourceExtensions,
} from "./editor/syntaxPolicy";
import { findExtension } from "./features/findPanel";
import {
  type FollowWikilinkOptions,
  followWikilinkTarget,
  type NoteViewState,
  readingViewportTop,
  scrollAnchorForViewport,
} from "./features/navigation";
import {
  countCharacters,
  countWords,
  type EditorStatistics,
  type PersistenceState,
} from "./features/noteStatistics";
import { generateNoteId, normalizeNoteIdScalar } from "./features/permalink";
import { selectionToolbar } from "./features/selectionToolbar";
import {
  DEFAULT_SETTINGS,
  type SettingsDocument,
} from "./features/settingsStore";
import { slashMenu } from "./features/slashMenu";
import { tableEditingExtension } from "./features/tableEditing";
import { tableCellRanges } from "./features/tableOperations";
import {
  refreshTagCompletionAfterCatalogChange,
  type TagAffordanceOptions,
  tagAffordances,
} from "./features/tags";
import type { ByteRangeReplace, VaultHandle } from "./ipc/bindings";
import {
  editHistoryAppend,
  editHistoryClear,
  editHistoryFence,
  editHistoryRead,
  IpcError,
  type LoadedNote,
  noteWrite,
  readNote,
} from "./ipc/vault";
import { ASYNC_SKELETON_DELAY_MS } from "./loadingStates";
import type { PaneSwitchKind } from "./motion";
import PropertiesPanel from "./PropertiesPanel.svelte";
import { type CommandContext, CommandRegistry, editorKeymap } from "./registry";
import { NARROW_BREAKPOINT_REM } from "./responsive";
import { STRINGS } from "./strings";
import {
  DEFAULT_TASK_STATUSES,
  normalizeTaskStatuses,
  type TaskStatus,
} from "./taskStatuses";
import { visualViewportTooltips } from "./visualViewport";

// registry-exempt keydown: indentation is editor input behavior controlled
// by the current indentation settings, not an application command.

let {
  doc = "",
  note = null,
  vault = null,
  path = null,
  linkContext = null,
  propertyTypes = null,
  taskStatuses = DEFAULT_TASK_STATUSES,
  registry = null,
  commandContext = null,
  settings = DEFAULT_SETTINGS,
  sourceMode = false,
  historyViewState = null,
  onConflict,
  onWriteError,
  onDocChanged,
  onOutlineChanged,
  onDirtyChanged,
  onTitleVisibilityChange,
  onSaved,
  onStatisticsChanged,
  onPersistenceChanged,
  wikilinkNavigationOptions,
  tagAffordanceOptions,
}: {
  /**
   * Fallback document when no note is open. The shell never mounts this
   * component without a note (the pane shows the empty-pane surface
   * instead); a bare `<Editor>` mounted directly by a test uses this.
   */
  doc?: string;
  note?: LoadedNote | null;
  vault?: VaultHandle | null;
  path?: string | null;
  /** Vault tree and `.obsidian/app.json` knobs for wikilink resolution. */
  linkContext?: WikilinkResolutionContext | null;
  /** Declared Obsidian property types for the properties panel. */
  propertyTypes?: Readonly<Record<string, FrontmatterValueType>> | null;
  /** Ordered task marker vocabulary from application settings. */
  taskStatuses?: readonly TaskStatus[];
  /** The registration API; keybindings, slash menu and toolbar read it. */
  registry?: CommandRegistry | null;
  /** Capability provider for commands fired inside the editor. */
  commandContext?: (() => CommandContext) | null;
  /** Live editor preferences from the persisted settings document. */
  settings?: SettingsDocument;
  /** Transient whole-note raw Markdown presentation. */
  sourceMode?: boolean;
  /** Reading state restored for a history traversal, in UTF-8 byte offsets. */
  historyViewState?: NoteViewState | null;
  onConflict?: () => void;
  onWriteError?: (message: string) => void;
  /** Reports the latest source after document-changing transactions settle. */
  onDocChanged?: (source: string, path: string | null) => void;
  /** Notified when document or background parsing changes the outline. */
  onOutlineChanged?: () => void;
  /** Reports whether the note has pending or in-flight local edits. */
  onDirtyChanged?: (dirty: boolean) => void;
  /** Reports whether the shell title should be visible for this document. */
  onTitleVisibilityChange?: (visible: boolean) => void;
  /** Notified after pending edits are written and indexed. */
  onSaved?: () => void;
  /** Reports document, selection, and caret facts for the statusline. */
  onStatisticsChanged?: (statistics: EditorStatistics) => void;
  /** Reports the persistence-slot state of the section 4.16 statusline. */
  onPersistenceChanged?: (state: PersistenceState) => void;
  /** Supplies the shared navigator capabilities for pointer activation. */
  wikilinkNavigationOptions?: () => FollowWikilinkOptions;
  /** Supplies vault tags and the existing search callback. */
  tagAffordanceOptions?: () => TagAffordanceOptions;
} = $props();

let host: HTMLDivElement;
// A deferred arrival can land after this pane unmounts, at which point
// `bind:this` has written `null` back into the reference.
let shell: HTMLDivElement | null = null;
let view: EditorView | undefined;
let session: NoteSession | null = null;
let durableEditHistory: DurableEditHistory | null = null;
/** Set when the open note disappeared from disk; saving pauses. */
let removed = false;
let idleSaveTimer: ReturnType<typeof setTimeout> | undefined;
let titleVisibilityFrame: number | undefined;
let restorationGeneration = 0;
let arrivalPrepared = false;
let renderedPath = $state<string | null>(null);
/** Serializes saves so change sets always apply to the base they expect. */
let saveChain: Promise<boolean> = Promise.resolve(true);

/** The switch kind supplied by the most recent `preparePaneSwitch` call. */
let lastSwitchKind: PaneSwitchKind = "note";

/**
 * Live per-tab state, keyed by note path. Populated with the outgoing tab's
 * exact CodeMirror state (undo history included) every time a different
 * note initializes, and consumed only when switching back to an already
 * open tab: the tab strip's own tabs, per section 6.4, keep their own live
 * view state rather than replaying the history restoration used for fresh
 * opens and history travel. The reading position is kept as a content
 * anchor (a line and its offset from the viewport top), not a raw scrollTop:
 * `setState` forces CodeMirror to remeasure, and a pixel value captured
 * against the old measurement can land on the wrong line once the new one
 * settles.
 */
type TabSnapshot = {
  state: EditorState;
  scrollAnchor: number;
  scrollOffset: number;
  propertiesExpanded: boolean;
};
const tabSnapshots = new Map<string, TabSnapshot>();

/**
 * Snapshots are captured for every outgoing note, not only ones that stay
 * open as tabs, so single-tab browsing across a large vault would otherwise
 * retain a full document and undo history per visited path. The cap evicts
 * the least recently captured entries; anything evicted simply falls back
 * to the composed-arrival rebuild a fresh open uses.
 */
const TAB_SNAPSHOT_LIMIT = 32;

const historyCompartment = new Compartment();
const renderingCompartment = new Compartment();
/**
 * The language services of a document that is not a note. Loading a grammar
 * is asynchronous, so the compartment opens empty (fully editable plain
 * text) and is reconfigured once the language for the open path resolves.
 */
const fileLanguageCompartment = new Compartment();
const settingsCompartment = new Compartment();
const sourceRevealFocusCompartment = new Compartment();

const editorAppearance = EditorView.theme({
  ".cm-content": {
    caretColor: "var(--skr-caret)",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeft: "2px solid var(--skr-caret)",
    marginLeft: "-1px",
  },
  ".cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
    {
      backgroundColor: "var(--skr-selection-surface)",
    },
  ".cm-content::selection, .cm-content ::selection": {
    color: "var(--skr-selection-text)",
    backgroundColor: "var(--skr-selection-surface)",
  },
});

/**
 * Frontmatter is panel-edited only within this many leading characters; a
 * block whose closing fence sits beyond it stays plain buffer text.
 */
const FRONTMATTER_SCAN_LIMIT = 16384;
let frontmatter = $state<Frontmatter | null>(null);
let propertiesExpanded = $state(defaultPropertiesExpanded());
let addingProperty = $state(false);
/**
 * Bumped by a composed-arrival note initialization (a fresh open, a history
 * return, or a tab switch whose cache missed) so the properties panel
 * remounts: an arrival paints its recorded or default state in the first
 * frame with no expand or collapse motion (section 6.4). A tab switch that
 * restores its own cached live state does not bump this: per section 5.1,
 * switching between already open tabs never remounts.
 */
let noteArrivalGeneration = $state(0);

/** Word and character totals for the whole document, cached per change. */
let documentWords = 0;
let documentCharacters = 0;
const deferredConsumers = new PostPaintScheduler();
let sourceNotificationPending = false;
let statisticsPublishPending = false;
let statisticsRecountPending = false;

function recomputeDocumentStatistics(text: string): void {
  documentWords = countWords(text);
  documentCharacters = countCharacters(text);
}

function publishStatistics(): void {
  const target = view;
  if (target === undefined || onStatisticsChanged === undefined) return;
  const selection = target.state.selection.main;
  const selectionWords = selection.empty
    ? 0
    : countWords(target.state.sliceDoc(selection.from, selection.to));
  const line = target.state.doc.lineAt(selection.head);
  onStatisticsChanged({
    words: documentWords,
    characters: documentCharacters,
    selectionWords,
    line: line.number,
    column:
      countCharacters(target.state.sliceDoc(line.from, selection.head)) + 1,
  });
}

function runDeferredConsumers(
  target: EditorView,
  targetPath: string | null,
): void {
  const notifySource = sourceNotificationPending;
  const publish = statisticsPublishPending;
  const recount = statisticsRecountPending;
  sourceNotificationPending = false;
  statisticsPublishPending = false;
  statisticsRecountPending = false;
  if (view !== target || path !== targetPath || renderedPath !== targetPath) {
    return;
  }
  const source = notifySource || recount ? target.state.doc.toString() : null;
  if (recount && source !== null) recomputeDocumentStatistics(source);
  if (notifySource && source !== null) onDocChanged?.(source, targetPath);
  if (publish) publishStatistics();
}

function scheduleDeferredConsumers({
  source = false,
  statistics = false,
  recount = false,
}: {
  source?: boolean;
  statistics?: boolean;
  recount?: boolean;
}): void {
  sourceNotificationPending =
    sourceNotificationPending || (source && onDocChanged !== undefined);
  statisticsPublishPending =
    statisticsPublishPending ||
    ((statistics || recount) && onStatisticsChanged !== undefined);
  statisticsRecountPending =
    statisticsRecountPending || (recount && onStatisticsChanged !== undefined);
  if (!sourceNotificationPending && !statisticsPublishPending) return;
  const target = view;
  if (target === undefined) return;
  const targetPath = path;
  deferredConsumers.schedule(() => runDeferredConsumers(target, targetPath));
}

function fenceDeferredConsumers(): void {
  deferredConsumers.fence();
  sourceNotificationPending = false;
  statisticsPublishPending = false;
  statisticsRecountPending = false;
}

function defaultPropertiesExpanded(): boolean {
  return (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function" ||
    !window.matchMedia(`(max-width: ${NARROW_BREAKPOINT_REM}rem)`).matches
  );
}

/**
 * Whether the open document is parsed and presented as Markdown. Every
 * Markdown service downstream of this reads it, so a `.yml` file's leading
 * `---` is never mistaken for a frontmatter fence and a shell script's
 * leading `#` is never mistaken for a heading.
 */
function markdownDocument(): boolean {
  return note === null || isMarkdownDocument(path);
}

/** The language services loaded for the currently open non-note path. */
let fileLanguage: Extension[] = [];
let fileLanguagePath: string | null = null;
let fileLanguageGeneration = 0;

/**
 * Loads the language the open path names and reconfigures the running
 * editor with it. A path naming no known language keeps plain text, which
 * stays fully editable either way.
 */
async function refreshFileLanguage(): Promise<void> {
  const generation = ++fileLanguageGeneration;
  const targetPath = path;
  if (targetPath === null || markdownDocument()) {
    fileLanguage = [];
    fileLanguagePath = null;
    view?.dispatch({ effects: fileLanguageCompartment.reconfigure([]) });
    return;
  }
  if (fileLanguagePath === targetPath) {
    view?.dispatch({
      effects: fileLanguageCompartment.reconfigure(fileLanguage),
    });
    return;
  }
  fileLanguage = [];
  fileLanguagePath = targetPath;
  view?.dispatch({ effects: fileLanguageCompartment.reconfigure([]) });
  const target = view;
  const resolved = await fileSyntaxExtensions(
    targetPath,
    target?.state.doc ?? "",
  );
  if (generation !== fileLanguageGeneration || view !== target) {
    return;
  }
  fileLanguage = resolved;
  view?.dispatch({
    effects: fileLanguageCompartment.reconfigure(resolved),
  });
}

function renderingExtensions(
  content: string | Parameters<typeof noteRenderingExtensions>[0],
  statuses: readonly TaskStatus[],
): Extension[] {
  if (!markdownDocument()) {
    // A non-note document carries no Markdown parse and no reading
    // decorations; its language arrives through its own compartment.
    return [];
  }
  const presentation = sourceMode
    ? noteSourceExtensions(content, statuses)
    : noteRenderingExtensions(content, undefined, statuses);
  // A drawn caret measures its own position on every selection change, and a
  // pathological line makes that measurement cost more than the keystroke
  // that caused it. Presentation is already all-or-nothing for such a
  // document, and the caret belongs on the same side of that line: a
  // document that renders as plain text keeps the platform's own caret.
  return presentation.length === 0
    ? presentation
    : [...presentation, caretMotion()];
}

function refreshFrontmatter() {
  if (view === undefined || session === null || !markdownDocument()) {
    frontmatter = null;
    return;
  }
  const head = view.state.doc.sliceString(
    0,
    Math.min(view.state.doc.length, FRONTMATTER_SCAN_LIMIT),
  );
  const parsed = parseFrontmatter(head);
  frontmatter =
    parsed === null
      ? null
      : propertyTypes === null
        ? parsed
        : applyTypeOverrides(parsed, propertyTypes);
}

/**
 * Panel edits are app mutations declaring their exact range: the change
 * replaces precisely the value's characters and flows through the normal
 * local-edit save path.
 */
function editFrontmatterValue(from: number, to: number, insert: string) {
  view?.dispatch({ changes: { from, to, insert } });
}

/** Appends one property line before the closing frontmatter fence. */
function addFrontmatterProperty(key: string, value: string) {
  if (view === undefined || frontmatter === null) return;
  const insertion = propertyInsertion(frontmatter, key, value);
  if (insertion !== null) {
    view.dispatch({
      changes: {
        from: insertion.from,
        to: insertion.from,
        insert: insertion.insert,
      },
    });
  }
}

/**
 * Starts the add-property flow: the registered "Note: add property"
 * command's route into the panel (section 4.15). A note without
 * frontmatter gains an empty block first.
 */
export function startAddProperty(): void {
  if (view === undefined || sourceMode || note?.readOnly === true) return;
  if (!markdownDocument()) return;
  if (frontmatter === null) {
    view.dispatch({ changes: { from: 0, to: 0, insert: "---\n---\n" } });
  }
  propertiesExpanded = true;
  addingProperty = true;
}

/**
 * Ensures the open note carries a stable permalink id, allocating one
 * through the same frontmatter-editing path `startAddProperty` uses (a
 * note without frontmatter gains an empty block first) so undo and
 * serialization stay correct. Returns the existing or newly written id,
 * or null when there is no editor to write into or the note is read-only.
 */
export function ensurePermalinkId(): string | null {
  if (view === undefined || note?.readOnly === true) return null;
  if (!markdownDocument()) return null;
  let current = frontmatter;
  if (current === null) {
    view.dispatch({ changes: { from: 0, to: 0, insert: "---\n---\n" } });
    const head = view.state.doc.sliceString(
      0,
      Math.min(view.state.doc.length, FRONTMATTER_SCAN_LIMIT),
    );
    current = parseFrontmatter(head);
  }
  if (current === null) return null;
  const existing = current.entries.find((entry) => entry.key === "id");
  if (existing !== undefined) {
    return normalizeNoteIdScalar(existing.raw);
  }
  const id = generateNoteId();
  const insertion = propertyInsertion(current, "id", id);
  if (insertion === null) return null;
  view.dispatch({
    changes: {
      from: insertion.from,
      to: insertion.from,
      insert: insertion.insert,
    },
  });
  return id;
}

/** Follows a wikilink-shaped property value from the properties panel. */
function followPanelWikilink(target: string) {
  if (wikilinkNavigationOptions !== undefined) {
    followWikilinkTarget(target, wikilinkNavigationOptions());
  }
}

function applyLinkContext() {
  if (view !== undefined && linkContext !== null) {
    dispatchWikilinkContext(view, linkContext);
  }
}

// Marks transactions whose changes the session has already accounted for
// (external ingests, recoveries, reconciles), so the dispatcher does not
// fold them into the pending set a second time.
const externalIngest = Annotation.define<boolean>();

/**
 * The registry-driven extensions: the editor keymap (every editor-scope
 * keybinding, followed by CodeMirror's stock editing keymaps), the slash
 * menu, the selection toolbar and the find panel. Without a registry
 * (the bare fixture in tests) the editor still carries the stock keymap
 * through `editorKeymap` on an empty registry.
 */
function registryExtensions(): Extension[] {
  const activeRegistry = registry;
  const provider =
    commandContext ??
    ((): CommandContext => ({
      view: view ?? null,
      openNote: () => Promise.resolve(),
      createNote: () => Promise.resolve(),
      openView: () => {},
      openCommandSurface: () => {},
      toggleView: () => {},
      closeSurfaces: () => {},
      requestSave: () => {
        requestSave();
      },
      notePaths: () => [],
      recentNotePaths: () => [],
      navigateBack: () => false,
      navigateForward: () => false,
      followLink: () => false,
    }));
  if (activeRegistry === null) {
    const emptyRegistry = new CommandRegistry();
    return [
      editorKeymap(emptyRegistry, provider, durableHistoryCommands()),
      tableEditingExtension(emptyRegistry, provider),
      ...(tagAffordanceOptions === undefined
        ? []
        : [tagAffordances(tagAffordanceOptions)]),
    ];
  }
  return [
    editorKeymap(activeRegistry, provider, durableHistoryCommands()),
    tableEditingExtension(activeRegistry, provider),
    ...(tagAffordanceOptions === undefined
      ? []
      : [tagAffordances(tagAffordanceOptions)]),
    slashMenu(activeRegistry, provider),
    selectionToolbar(activeRegistry, provider),
    findExtension(),
  ];
}

function durableHistoryCommands() {
  const runUndo = (target: EditorView): boolean => {
    if (undo(target)) return true;
    if (durableEditHistory === null) return false;
    durableEditHistory.undo(target);
    return true;
  };
  const runRedo = (target: EditorView): boolean => {
    if (redo(target)) return true;
    if (durableEditHistory === null) return false;
    durableEditHistory.redo(target);
    return true;
  };
  return { undo: runUndo, redo: runRedo };
}

function characterOffsetForByte(content: string, byteOffset: number): number {
  const target = Math.max(0, Math.floor(byteOffset));
  let bytes = 0;
  let characters = 0;
  for (const character of content) {
    const nextBytes = bytes + new TextEncoder().encode(character).length;
    if (nextBytes > target) break;
    bytes = nextBytes;
    characters += character.length;
  }
  return characters;
}

function byteOffsetForCharacter(
  content: string,
  characterOffset: number,
): number {
  return new TextEncoder().encode(content.slice(0, characterOffset)).length;
}

function stateFor(
  content: string,
  locked: boolean,
  restoration: NoteViewState | null = historyViewState,
): EditorState {
  const normalizedTaskStatuses = normalizeTaskStatuses(taskStatuses);
  const anchor =
    restoration === null
      ? 0
      : characterOffsetForByte(content, restoration.anchor);
  const head =
    restoration === null
      ? anchor
      : characterOffsetForByte(content, restoration.head);
  return EditorState.create({
    doc: content,
    selection: { anchor, head },
    extensions: [
      renderingCompartment.of(
        renderingExtensions(content, normalizedTaskStatuses),
      ),
      fileLanguageCompartment.of(fileLanguage),
      ...(wikilinkNavigationOptions === undefined
        ? []
        : [wikilinkPointerNavigation(wikilinkNavigationOptions)]),
      editorAppearance,
      settingsCompartment.of(settingsExtensions(settings, sourceMode)),
      sourceRevealFocusCompartment.of(
        sourceRevealFocusMode(view?.hasFocus ?? false),
      ),
      bulkTextInput(),
      ...visualViewportTooltips,
      historyCompartment.of(history()),
      ...registryExtensions(),
      EditorState.readOnly.of(locked),
      EditorView.editable.of(!locked),
      // The explicit tabindex changes nothing for editable content (already
      // in the tab order) and keeps read-only content keyboard-reachable;
      // it also makes the scrollable region's focusability visible to
      // accessibility checkers whose focusable-descendant selectors do not
      // recognize contenteditable.
      EditorView.domEventHandlers({
        focus: (_event, target) => {
          target.dispatch({
            effects: sourceRevealFocusCompartment.reconfigure(
              sourceRevealFocusMode(true),
            ),
          });
          return false;
        },
        blur: (_event, target) => {
          target.dispatch({
            effects: sourceRevealFocusCompartment.reconfigure(
              sourceRevealFocusMode(false),
            ),
          });
          requestSave();
          return false;
        },
      }),
    ],
  });
}

/**
 * Reveals the composed frame the swap prepared under cover.
 *
 * The hide is what keeps a half-built note off the screen; the reveal is not
 * an arrival and does not fade. A pane switch replaces the contents of a
 * surface the reader is already looking at, so there is no frame underneath
 * for an incoming one to fade in over: fading from zero shows the pane's
 * bare background for the length of the transition, which reads as the note
 * blinking out and back on every switch. The surface returns to full opacity
 * in the same frame its content became complete.
 */
function finishPreparedArrival(): void {
  if (!arrivalPrepared) return;
  arrivalPrepared = false;
  if (!(shell instanceof HTMLElement)) return;
  shell.dataset.motionInstant = "true";
  delete shell.dataset.motionPreparing;
  shell.dataset.motionEntered = "true";
  requestAnimationFrame(() => {
    if (shell instanceof HTMLElement) delete shell.dataset.motionInstant;
  });
}

function replaceEditorState(content: string, locked: boolean): void {
  const target = view;
  if (target === undefined) return;
  const generation = ++restorationGeneration;
  const restoration = historyViewState;
  if (restoration !== null) target.dom.style.visibility = "hidden";
  target.setState(stateFor(content, locked));
  target.scrollDOM.style.scrollBehavior = "auto";
  if (restoration === null) {
    target.dom.style.removeProperty("visibility");
    target.scrollDOM.scrollTop = 0;
    queueMicrotask(finishPreparedArrival);
    return;
  }
  const scrollAnchor = characterOffsetForByte(
    content,
    restoration.scrollAnchor,
  );
  target.dispatch({
    effects: EditorView.scrollIntoView(scrollAnchor, {
      y: "start",
      yMargin: Math.max(0, restoration.scrollOffset),
    }),
  });
  const correctScrollOffset = () => {
    if (view !== target || restorationGeneration !== generation) return;
    const line = target.lineBlockAt(scrollAnchor);
    const viewportTop = Math.max(
      0,
      target.scrollDOM.scrollTop - target.documentPadding.top,
    );
    const actualOffset = line.top - viewportTop;
    target.scrollDOM.scrollTop += actualOffset - restoration.scrollOffset;
  };
  requestAnimationFrame(() => {
    correctScrollOffset();
    requestAnimationFrame(() => {
      correctScrollOffset();
      if (view === target && restorationGeneration === generation) {
        target.dom.style.removeProperty("visibility");
        finishPreparedArrival();
      }
    });
  });
}

function settingsExtensions(
  document: SettingsDocument,
  wholeNoteSourceMode: boolean,
): Extension[] {
  return [
    ...(document.show_line_numbers ? [lineNumbers()] : []),
    ...(document.wrap_long_lines ? [EditorView.lineWrapping] : []),
    EditorState.tabSize.of(document.indent_width),
    indentUnit.of(
      document.indent_style === "tabs"
        ? "\t"
        : " ".repeat(document.indent_width),
    ),
    sourceRevealMode(document.reveal_markdown_syntax),
    ...(document.show_invisible_characters && !wholeNoteSourceMode
      ? [showInvisibleCharacters()]
      : []),
    EditorView.contentAttributes.of({
      "aria-label": STRINGS.editorLabel,
      spellcheck: document.spell_check ? "true" : "false",
      tabindex: "0",
    }),
  ];
}

function scheduleIdleSave() {
  clearTimeout(idleSaveTimer);
  idleSaveTimer = setTimeout(() => {
    requestSave();
  }, settings.autosave_delay_ms);
}

function notifyDirty() {
  onDirtyChanged?.(session?.dirty === true || session?.saving === true);
}

function dispatchTransactions(
  transactions: readonly Transaction[],
  target: EditorView,
) {
  assertDecorationsInert(transactions);
  target.update(transactions);
  for (const transaction of transactions) {
    if (
      transaction.changes.empty ||
      transaction.annotation(externalIngest) === true
    ) {
      continue;
    }
    durableEditHistory?.record(transaction);
    session?.recordLocalChanges(transaction.changes);
    notifyDirty();
    scheduleIdleSave();
  }
  const docChanged = transactions.some((transaction) => transaction.docChanged);
  const selectionChanged = transactions.some(
    (transaction) => transaction.selection !== undefined,
  );
  if (docChanged || selectionChanged) {
    scheduleDeferredConsumers({
      source: docChanged,
      statistics: true,
      recount: docChanged,
    });
  }
  if (docChanged) {
    refreshFrontmatter();
    scheduleTitleVisibilityRefresh();
    onOutlineChanged?.();
  } else if (treeGrewInBackground(target)) {
    // Background parsing advanced without a document change. Consumers of
    // the syntax tree (the outline) recompute, or a large note's outline
    // stays truncated at the initial parse slice until the first edit.
    onOutlineChanged?.();
  }
}

const HEADING_NODE = /^(?:ATXHeading[1-6]|SetextHeading[12])$/u;

function leadingHeadingEnd(target: EditorView): number | null {
  let end: number | null = null;
  syntaxTree(target.state).iterate({
    from: 0,
    to: Math.min(target.state.doc.length, 4096),
    enter: (node) => {
      if (node.from === 0 && HEADING_NODE.test(node.name)) {
        end = node.to;
        return false;
      }
      return end === null;
    },
  });
  return end;
}

function refreshTitleVisibility(): void {
  const target = view;
  if (target === undefined || onTitleVisibilityChange === undefined) {
    return;
  }
  const headingEnd = leadingHeadingEnd(target);
  if (headingEnd === null) {
    onTitleVisibilityChange(true);
    return;
  }
  const header = document.querySelector<HTMLElement>(".skr-app-header");
  const headingBounds = target.coordsAtPos(headingEnd, -1);
  if (header === null) {
    onTitleVisibilityChange(false);
  } else if (headingBounds === null) {
    onTitleVisibilityChange(target.scrollDOM.scrollTop > 0);
  } else {
    onTitleVisibilityChange(
      headingBounds.bottom <= header.getBoundingClientRect().bottom,
    );
  }
}

function scheduleTitleVisibilityRefresh(): void {
  if (titleVisibilityFrame !== undefined) {
    cancelAnimationFrame(titleVisibilityFrame);
  }
  titleVisibilityFrame = requestAnimationFrame(() => {
    titleVisibilityFrame = undefined;
    refreshTitleVisibility();
  });
}

let lastSeenTreeLength = 0;

function treeGrewInBackground(target: EditorView): boolean {
  const length = syntaxTree(target.state).length;
  if (length === lastSeenTreeLength) {
    return false;
  }
  lastSeenTreeLength = length;
  return true;
}

/**
 * Undo discipline across external ingests. The history extension in
 * `@codemirror/commands` keeps its undo log in a private state field and
 * exposes no API to truncate or clear it: `isolateHistory` only prevents
 * adjacent events from merging, and transactions with `addToHistory:
 * false` are still mapped through the stored steps, so a retained
 * pre-ingest undo step replayed after an ingest rebuilds a document that
 * combines the local rollback with the external edit in an order neither
 * device ever produced. The one supported way to drop stored steps is to
 * remove the extension from the configuration (which destroys its state
 * field) and add it back (which starts an empty one); the compartment
 * swap below does exactly that at every external ingest point. Post-ingest
 * edits accumulate fresh undo steps that stop exactly at the ingest state,
 * which satisfies the invariant: undo after an ingest never reproduces a
 * pre-ingest text that does not incorporate the ingest.
 */
function clearUndoHistory(target: EditorView) {
  target.dispatch({ effects: historyCompartment.reconfigure([]) });
  target.dispatch({ effects: historyCompartment.reconfigure(history()) });
}

/**
 * Dispatches session-produced changes (external ingest, recovery,
 * reconcile) onto the live document: never undoable, never recorded as
 * local edits, and the selection maps through the changes rather than
 * resetting.
 */
function dispatchSessionChanges(changes: ChangeSet, fenceHistory = false) {
  if (view === undefined) {
    return;
  }
  if (!changes.empty) {
    view.dispatch({
      changes,
      annotations: [
        externalIngest.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
  }
  if (!changes.empty || fenceHistory) clearUndoHistory(view);
  if (fenceHistory) durableEditHistory?.fence();
}

/**
 * The statusline persistence contract of section 4.16: silence while
 * saved, "Saving…" only when a write outlives the section 5.10 grace, a
 * persisting failure state until a later write succeeds.
 */
let persistenceGraceTimer: ReturnType<typeof setTimeout> | undefined;

function reportPersistence(state: PersistenceState): void {
  clearTimeout(persistenceGraceTimer);
  persistenceGraceTimer = undefined;
  onPersistenceChanged?.(state);
}

function beginPersistenceGrace(): void {
  clearTimeout(persistenceGraceTimer);
  persistenceGraceTimer = setTimeout(() => {
    persistenceGraceTimer = undefined;
    onPersistenceChanged?.({ kind: "saving" });
  }, ASYNC_SKELETON_DELAY_MS);
}

async function performSave(): Promise<boolean> {
  if (
    view === undefined ||
    session === null ||
    vault === null ||
    path === null ||
    removed
  ) {
    return session?.dirty !== true;
  }
  let request: ReturnType<NoteSession["beginSave"]>;
  try {
    request = session.beginSave();
    notifyDirty();
  } catch (error) {
    // A conversion failure means the session state diverged from the
    // document; recover by re-reading the note.
    onWriteError?.(String(error));
    reportPersistence({ kind: "failed", message: String(error) });
    await rereadAndReconcile();
    return false;
  }
  if (request !== null) {
    beginPersistenceGrace();
  }
  try {
    await durableEditHistory?.flush();
    if (request === null) {
      reportPersistence({ kind: "saved" });
      return true;
    }
    const result = await noteWrite(
      vault,
      path,
      toIpcChanges(request.changeSet),
      request.expectedProjectionHash,
    );
    if (result.result === "written") {
      try {
        session.commitSave(result.projection_hash);
        notifyDirty();
        reportPersistence({ kind: "saved" });
        onSaved?.();
      } catch {
        reportPersistence({ kind: "saved" });
        await rereadAndReconcile();
        return false;
      }
    } else {
      // The on-disk projection moved: never overwrite. Roll the save
      // back, surface the reconciliation state and re-read.
      session.rollbackSave();
      notifyDirty();
      reportPersistence({ kind: "failed", message: STRINGS.conflictBanner });
      onConflict?.();
      await rereadAndReconcile();
      return false;
    }
  } catch (error) {
    session.rollbackSave();
    notifyDirty();
    const message =
      error instanceof IpcError ? error.app.message : String(error);
    reportPersistence({ kind: "failed", message });
    onWriteError?.(message);
    return false;
  }
  return true;
}

/** Queues a save; consecutive requests coalesce onto one serialized chain. */
export function requestSave(): Promise<boolean> {
  saveChain = saveChain.then(performSave);
  return saveChain;
}

/** Saves pending edits and reports whether the buffer is safe to replace. */
export async function flush(): Promise<boolean> {
  clearTimeout(idleSaveTimer);
  const saved = await requestSave();
  await deferredConsumers.settled();
  return saved;
}

function toIpcChanges(changes: readonly ByteChange[]): ByteRangeReplace[] {
  return changes.map((change) => ({
    start: change.start,
    end: change.end,
    bytes: Array.from(change.bytes),
  }));
}

function fromIpcChanges(changes: readonly ByteRangeReplace[]): ByteChange[] {
  return changes.map((change) => ({
    start: change.start,
    end: change.end,
    bytes: Uint8Array.from(change.bytes),
  }));
}

/**
 * Ingests a stable external change to the open note, delivered as a byte
 * change set against the session's base projection. Falls back to a full
 * re-read when the delta does not fit the tracked base.
 */
export async function ingestExternal(
  changeSet: readonly ByteRangeReplace[],
  baseProjectionHash: string,
  projectionHash: string,
): Promise<void> {
  if (session === null) {
    return;
  }
  removed = false;
  try {
    dispatchSessionChanges(
      session.ingestDelta(
        fromIpcChanges(changeSet),
        baseProjectionHash,
        projectionHash,
      ),
      true,
    );
  } catch {
    await rereadAndReconcile();
  }
}

/** Applies a journal-recovered delta as pending (unsaved) buffer edits. */
export function ingestRecovered(changeSet: readonly ByteRangeReplace[]): void {
  if (session === null) {
    return;
  }
  try {
    dispatchSessionChanges(session.recoverDelta(fromIpcChanges(changeSet)));
  } catch (error) {
    onWriteError?.(String(error));
  }
}

/** Rebases the session onto a re-read of the note. */
export function reconcileWith(loaded: LoadedNote): void {
  if (session === null) {
    return;
  }
  removed = false;
  dispatchSessionChanges(
    session.reconcile(loaded.bytes, loaded.meta.projection_hash),
    true,
  );
}

/** Removes the open note's persisted edit-history journal. */
export async function clearEditHistory(): Promise<void> {
  if (!(await flush())) {
    throw new Error(STRINGS.clearEditHistorySaveFailed);
  }
  await durableEditHistory?.clear();
}

/** Marks the open note as removed from disk: the buffer stays, saving pauses. */
export function markRemoved(): void {
  removed = true;
}

/** The live CodeMirror view, for command contexts and the outline. */
export function getView(): EditorView | undefined {
  return view;
}

/** Rechecks an empty tag menu after the vault catalog publishes new rows. */
export function refreshTagCompletion(): void {
  if (view !== undefined) {
    refreshTagCompletionAfterCatalogChange(view);
  }
}

/**
 * Records the switch kind and hides the outgoing frame so the incoming
 * content's arrival fades in over an already-composed frame (section 5.1):
 * every pane switch fades, tab activation included, and `initializeForNote`
 * reads the recorded kind to decide whether it can restore a tab's live
 * state instead of rebuilding one.
 */
export function preparePaneSwitch(kind: PaneSwitchKind): void {
  lastSwitchKind = kind;
  arrivalPrepared = true;
  if (!(shell instanceof HTMLElement)) return;
  shell.dataset.motionPreparing = "true";
  delete shell.dataset.motionExiting;
}

/** Discards a closed tab's cached live state so it cannot be restored stale. */
export function forgetTab(path: string): void {
  tabSnapshots.delete(path);
}

/**
 * The line the viewport shows whole and how far below the viewport's top
 * edge it starts, as a character offset into `target.state.doc`. Shared by
 * history capture, which converts the position to bytes for persistence,
 * and tab-cache capture, which keeps it as characters because the cached
 * state's own document never changes underneath it.
 */
function readingAnchor(target: EditorView): {
  position: number;
  offset: number;
} {
  const viewportTop = Math.max(
    0,
    target.scrollDOM.scrollTop - target.documentPadding.top,
  );
  const reading = scrollAnchorForViewport({
    viewportTop,
    documentLength: target.state.doc.length,
    devicePixelRatio: window.devicePixelRatio,
    lineBlockAtHeight: (height) => target.lineBlockAtHeight(height),
    lineBlockAt: (position) => target.lineBlockAt(position),
  });
  return { position: reading.line.from, offset: reading.offset };
}

/** Captures byte-exact selection offsets and the current reading position. */
export function captureHistoryState(): NoteViewState | null {
  const target = view;
  if (target === undefined) return null;
  const content = target.state.doc.toString();
  let selection = target.state.selection.main;
  const tableCell = focusedRenderedTableCell(target);
  if (tableCell !== null) {
    const table = target.state.sliceDoc(tableCell.tableFrom, tableCell.tableTo);
    const cell = tableCellRanges(table).find(
      (candidate) =>
        candidate.row === tableCell.row &&
        candidate.column === tableCell.column,
    );
    if (cell !== undefined) {
      const cellEnd = tableCell.tableFrom + cell.to;
      selection = EditorSelection.range(
        Math.min(cellEnd, tableCell.tableFrom + cell.from + tableCell.anchor),
        Math.min(cellEnd, tableCell.tableFrom + cell.from + tableCell.head),
      );
    }
  }
  const reading = readingAnchor(target);
  return {
    anchor: byteOffsetForCharacter(content, selection.anchor),
    head: byteOffsetForCharacter(content, selection.head),
    scrollAnchor: byteOffsetForCharacter(content, reading.position),
    scrollOffset: reading.offset,
    propertiesExpanded,
  };
}

/**
 * How far the viewport sits, in CSS pixels, from where a stored reading
 * position puts it. A scroller holds a position only to whole device pixels,
 * so a restored position is checked as a distance from the stored one rather
 * than as an equal encoding of it.
 */
export function readingPositionDrift(state: NoteViewState): number | null {
  const target = view;
  if (target === undefined) return null;
  const content = target.state.doc.toString();
  const anchor = characterOffsetForByte(content, state.scrollAnchor);
  if (anchor > target.state.doc.length) return null;
  const viewportTop = Math.max(
    0,
    target.scrollDOM.scrollTop - target.documentPadding.top,
  );
  return (
    viewportTop -
    readingViewportTop(target.lineBlockAt(anchor).top, state.scrollOffset)
  );
}

async function rereadAndReconcile(): Promise<void> {
  if (vault === null || path === null) {
    return;
  }
  try {
    reconcileWith(await readNote(vault, path));
  } catch (error) {
    onWriteError?.(
      error instanceof IpcError ? error.app.message : String(error),
    );
  }
}

/** Snapshots the outgoing tab's live state before its note is replaced. */
function captureOutgoingTabState(): void {
  if (view === undefined || renderedPath === null) return;
  const reading = readingAnchor(view);
  tabSnapshots.delete(renderedPath);
  tabSnapshots.set(renderedPath, {
    state: view.state,
    scrollAnchor: reading.position,
    scrollOffset: reading.offset,
    propertiesExpanded,
  });
  while (tabSnapshots.size > TAB_SNAPSHOT_LIMIT) {
    const oldest = tabSnapshots.keys().next().value;
    if (oldest === undefined) break;
    tabSnapshots.delete(oldest);
  }
}

/**
 * Returns the incoming path's cached live state when this initialization is
 * a tab-strip activation of an already open tab and its cached document
 * still matches the freshly read disk content; `undefined` otherwise (a
 * fresh open, a history return, or a tab whose content changed underneath
 * it), in which case the caller falls back to the composed-arrival rebuild.
 */
function consumeCachedTabState(
  targetPath: string | null,
  text: string,
): TabSnapshot | undefined {
  if (lastSwitchKind !== "tab" || targetPath === null) return undefined;
  const cached = tabSnapshots.get(targetPath);
  if (cached === undefined || cached.state.doc.toString() !== text) {
    return undefined;
  }
  return cached;
}

/**
 * Swaps a tab's own live `EditorState` back in, undo history and all: the
 * same `EditorView`, no rebuilt document, no visibility hide-and-correct
 * dance, since the cached content anchor is already exact. `setState`
 * still forces CodeMirror to remeasure the document, the same as a fresh
 * open, so the position is applied by scrolling the anchor into view and
 * then re-anchoring across the same bounded settle window `replaceEditorState`
 * uses for a restored history entry, rather than by assigning a scrollTop
 * that was only ever correct for the measurement in effect when it was
 * captured.
 */
function restoreCachedState(cached: TabSnapshot): void {
  const target = view;
  if (target === undefined) return;
  const generation = ++restorationGeneration;
  target.setState(cached.state);
  target.scrollDOM.style.scrollBehavior = "auto";
  target.dispatch({
    effects: EditorView.scrollIntoView(cached.scrollAnchor, {
      y: "start",
      yMargin: Math.max(0, cached.scrollOffset),
    }),
  });
  queueMicrotask(finishPreparedArrival);
  const correctScrollOffset = () => {
    if (view !== target || restorationGeneration !== generation) return;
    const line = target.lineBlockAt(cached.scrollAnchor);
    const viewportTop = Math.max(
      0,
      target.scrollDOM.scrollTop - target.documentPadding.top,
    );
    const actualOffset = line.top - viewportTop;
    target.scrollDOM.scrollTop += actualOffset - cached.scrollOffset;
  };
  requestAnimationFrame(() => {
    correctScrollOffset();
    requestAnimationFrame(correctScrollOffset);
  });
}

function initializeForNote(current: LoadedNote | null) {
  initializeDocument(current);
  void refreshFileLanguage();
}

function initializeDocument(current: LoadedNote | null) {
  clearTimeout(idleSaveTimer);
  fenceDeferredConsumers();
  captureOutgoingTabState();
  removed = false;
  addingProperty = false;
  reportPersistence({ kind: "saved" });
  if (current === null) {
    noteArrivalGeneration += 1;
    propertiesExpanded =
      historyViewState?.propertiesExpanded ?? defaultPropertiesExpanded();
    session = null;
    durableEditHistory = null;
    notifyDirty();
    replaceEditorState(doc, false);
    applyLinkContext();
    refreshFrontmatter();
    scheduleTitleVisibilityRefresh();
    renderedPath = path;
    scheduleDeferredConsumers({
      source: true,
      statistics: true,
      recount: true,
    });
    return;
  }
  if (current.readOnly) {
    noteArrivalGeneration += 1;
    propertiesExpanded =
      historyViewState?.propertiesExpanded ?? defaultPropertiesExpanded();
    session = null;
    durableEditHistory = null;
    notifyDirty();
    replaceEditorState(current.text, true);
    applyLinkContext();
    refreshFrontmatter();
    scheduleTitleVisibilityRefresh();
    renderedPath = path;
    scheduleDeferredConsumers({
      source: true,
      statistics: true,
      recount: true,
    });
    return;
  }
  session = new NoteSession(current.bytes, current.meta.projection_hash);
  const currentVault = vault;
  const currentPath = path;
  durableEditHistory =
    currentVault === null || currentPath === null
      ? null
      : new DurableEditHistory({
          read: () => editHistoryRead(currentVault, currentPath),
          append: (batch, actions) =>
            editHistoryAppend(currentVault, currentPath, batch, actions),
          fence: (batch) => editHistoryFence(currentVault, currentPath, batch),
          clear: () => editHistoryClear(currentVault, currentPath),
        });
  let text = session.base.text;
  if (current.recoveredChangeSet !== undefined) {
    // Journal recovery delivered before the note was opened: the delta
    // becomes pending edits of the fresh session, so the initial document
    // already shows the recovered buffer and the next save persists it.
    try {
      session.recoverDelta(fromIpcChanges(current.recoveredChangeSet));
      const changes = session.pending;
      text = changes.empty
        ? text
        : EditorState.create({ doc: text })
            .update({ changes })
            .state.doc.toString();
    } catch (error) {
      onWriteError?.(String(error));
    }
  }
  const cached =
    current.recoveredChangeSet === undefined
      ? consumeCachedTabState(currentPath, text)
      : undefined;
  if (cached !== undefined) {
    propertiesExpanded = cached.propertiesExpanded;
    restoreCachedState(cached);
  } else {
    noteArrivalGeneration += 1;
    propertiesExpanded =
      historyViewState?.propertiesExpanded ?? defaultPropertiesExpanded();
    replaceEditorState(text, false);
  }
  notifyDirty();
  applyLinkContext();
  refreshFrontmatter();
  scheduleTitleVisibilityRefresh();
  renderedPath = path;
  scheduleDeferredConsumers({ source: true, statistics: true, recount: true });
}

onMount(() => {
  view = new EditorView({
    state: stateFor(doc, false),
    parent: host,
    dispatchTransactions,
  });
  view.scrollDOM.addEventListener("scroll", scheduleTitleVisibilityRefresh);
  window.addEventListener("resize", scheduleTitleVisibilityRefresh);
  initializeForNote(note);
  return () => {
    clearTimeout(idleSaveTimer);
    clearTimeout(persistenceGraceTimer);
    if (titleVisibilityFrame !== undefined) {
      cancelAnimationFrame(titleVisibilityFrame);
    }
    fenceDeferredConsumers();
    view?.scrollDOM.removeEventListener(
      "scroll",
      scheduleTitleVisibilityRefresh,
    );
    window.removeEventListener("resize", scheduleTitleVisibilityRefresh);
    view?.destroy();
  };
});

// Re-initialize when another document is opened or closed. Re-reads of the
// same note go through `reconcileWith`, which preserves cursor and pending
// edits; this effect only runs when the note identity changes.
let initializedNote: LoadedNote | null = null;
$effect(() => {
  if (view !== undefined && note !== initializedNote) {
    initializedNote = note;
    initializeForNote(note);
  }
});

// Status and source presentation changes reconfigure rendering without
// rebuilding the editor or touching its document.
$effect(() => {
  const normalizedTaskStatuses = normalizeTaskStatuses(taskStatuses);
  void sourceMode;
  if (view !== undefined) {
    view.dispatch({
      effects: renderingCompartment.reconfigure(
        renderingExtensions(view.state.doc, normalizedTaskStatuses),
      ),
    });
    scheduleTitleVisibilityRefresh();
  }
});

// Push wikilink context updates (tree refreshes, config reads) into the
// live editor state; the dispatch is decoration-annotated and inert.
$effect(() => {
  if (view !== undefined && linkContext !== null) {
    dispatchWikilinkContext(view, linkContext);
  }
});

// Declared property types can arrive after the note opened.
$effect(() => {
  void propertyTypes;
  refreshFrontmatter();
});

$effect(() => {
  const nextSettings = settings;
  const nextSourceMode = sourceMode;
  if (view !== undefined) {
    view.dispatch({
      effects: settingsCompartment.reconfigure(
        settingsExtensions(nextSettings, nextSourceMode),
      ),
    });
  }
});
</script>

<div
  bind:this={shell}
  class="skr-editor-shell flex h-full min-h-0 flex-col"
  data-motion-surface="fade"
  data-motion-entered="true"
  data-note-path={renderedPath}
>
  {#key noteArrivalGeneration}
    {#if !sourceMode && frontmatter !== null && (frontmatter.entries.length > 0 || addingProperty)}
      <PropertiesPanel
        {frontmatter}
        onEditValue={editFrontmatterValue}
        onAddProperty={addFrontmatterProperty}
        onFollowWikilink={followPanelWikilink}
        bind:expanded={propertiesExpanded}
        bind:adding={addingProperty}
      />
    {/if}
  {/key}
  <div
    class:skr-source-mode={sourceMode}
    class="editor min-h-0 flex-1"
    bind:this={host}
  ></div>
</div>

<style>
  .editor :global(.cm-editor) {
    height: 100%;
    /* The settings view drives the variable; the fallback is the default. */
    font-size: var(--skr-editor-font-size, 1rem);
  }
  .editor :global(.cm-editor.cm-focused) {
    outline: 2px solid var(--skr-focus);
    outline-offset: -2px;
  }
  .editor
    > :global(.cm-editor)
    > :global(.cm-scroller)
    > :global(.cm-content) {
    box-sizing: border-box;
    width: 100%;
    max-width: calc(
      var(--skr-editor-measure, 72) * 1ch + 2 * var(--skr-gutter)
    );
    margin-inline: auto;
    padding-block: clamp(2rem, 5vh, 4rem);
    padding-inline: var(--skr-gutter);
    font-family: var(--skr-font-prose);
    line-height: var(--skr-editor-line-height, 1.7);
  }
  .editor :global(.cm-line) {
    padding-inline: 0;
  }
  .editor :global(.cm-line.cm-skr-code-block) {
    font-family: var(--skr-font-mono);
    font-size: 0.875em;
    font-weight: 400;
    line-height: 1.6;
  }
  .editor:not(.skr-source-mode)
    :global(.cm-line.cm-skr-frontmatter:not([data-revealed="true"])) {
    display: none;
  }
  /* The properties panel already closes the note's top edge with its own
     hairline, so the editor's own first-block breathing room (meant for a
     note that opens directly on its first line) would otherwise stack a
     second gap beneath it. Zeroing it here leaves only the heading's own
     top spacing, matching the gap between any two ordinary blocks. Source
     mode and a revealed (in-place-edited) frontmatter block restore it,
     since the raw fence lines become the note's true first visible line.
     `!important` reliably overrides CodeMirror's own `.cm-content` base
     theme padding regardless of the relative order the two stylesheets
     mount in, rather than depending on this selector always outranking
     CodeMirror's by specificity alone. */
  .skr-editor-shell:has(
      :global(.cm-line.cm-skr-frontmatter:not([data-revealed="true"]))
    )
    .editor
    > :global(.cm-editor)
    > :global(.cm-scroller)
    > :global(.cm-content) {
    padding-top: 0 !important;
  }
  .editor.skr-source-mode
    > :global(.cm-editor)
    > :global(.cm-scroller)
    > :global(.cm-content) {
    font-family: var(--skr-font-mono);
    font-size: 0.875em;
    line-height: 1.6;
  }
  .skr-editor-shell:has(
      :global(.cm-line.cm-skr-frontmatter[data-revealed="true"])
    )
    :global(.skr-properties) {
    display: none;
  }

  @media (max-width: 60rem) {
    .editor
      > :global(.cm-editor)
      > :global(.cm-scroller)
      > :global(.cm-content) {
      padding-block: 1.5rem;
    }
  }
</style>
