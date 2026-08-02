<script lang="ts">
import { history } from "@codemirror/commands";
import { indentUnit, syntaxTree } from "@codemirror/language";
import {
  Annotation,
  type ChangeSet,
  Compartment,
  EditorState,
  type Extension,
  Transaction,
} from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { onMount } from "svelte";
import { bulkTextInput } from "./editor/bulkInput";
import type { ByteChange } from "./editor/byteChangeSet";
import { assertDecorationsInert } from "./editor/decorationGuard";
import {
  dispatchWikilinkContext,
  sourceRevealMode,
} from "./editor/decorations/engine";
import {
  type WikilinkResolutionContext,
  wikilinkPointerNavigation,
} from "./editor/decorations/wikilinks";
import {
  applyTypeOverrides,
  type Frontmatter,
  type FrontmatterValueType,
  parseFrontmatter,
} from "./editor/frontmatter";
import { showInvisibleCharacters } from "./editor/invisibles";
import { NoteSession } from "./editor/noteSession";
import {
  noteRenderingExtensions,
  noteSourceExtensions,
} from "./editor/syntaxPolicy";
import { findExtension } from "./features/findPanel";
import type {
  FollowWikilinkOptions,
  NoteViewState,
} from "./features/navigation";
import { selectionToolbar } from "./features/selectionToolbar";
import {
  DEFAULT_SETTINGS,
  type SettingsDocument,
} from "./features/settingsStore";
import { slashMenu } from "./features/slashMenu";
import { tableEditingExtension } from "./features/tableEditing";
import { type TagAffordanceOptions, tagAffordances } from "./features/tags";
import type { ByteRangeReplace, VaultHandle } from "./ipc/bindings";
import { IpcError, type LoadedNote, noteWrite, readNote } from "./ipc/vault";
import PropertiesPanel from "./PropertiesPanel.svelte";
import { type CommandContext, CommandRegistry, editorKeymap } from "./registry";
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
  onTitleVisibilityChange,
  onSaved,
  wikilinkNavigationOptions,
  tagAffordanceOptions,
}: {
  /** Fallback document when no note is open (the scaffold fixture). */
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
  /** Notified after any document-changing transaction (outline refresh). */
  onDocChanged?: (source: string, path: string | null) => void;
  /** Reports whether the shell title should be visible for this document. */
  onTitleVisibilityChange?: (visible: boolean) => void;
  /** Notified after pending edits are written and indexed. */
  onSaved?: () => void;
  /** Supplies the shared navigator capabilities for pointer activation. */
  wikilinkNavigationOptions?: () => FollowWikilinkOptions;
  /** Supplies vault tags and the existing search callback. */
  tagAffordanceOptions?: () => TagAffordanceOptions;
} = $props();

let host: HTMLDivElement;
let view: EditorView | undefined;
let session: NoteSession | null = null;
/** Set when the open note disappeared from disk; saving pauses. */
let removed = false;
let idleSaveTimer: ReturnType<typeof setTimeout> | undefined;
let titleVisibilityFrame: number | undefined;
/** Serializes saves so change sets always apply to the base they expect. */
let saveChain: Promise<boolean> = Promise.resolve(true);

const historyCompartment = new Compartment();
const renderingCompartment = new Compartment();
const settingsCompartment = new Compartment();

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

function renderingExtensions(
  content: string | Parameters<typeof noteRenderingExtensions>[0],
  statuses: readonly TaskStatus[],
): Extension[] {
  return sourceMode
    ? noteSourceExtensions(content, statuses)
    : noteRenderingExtensions(content, undefined, statuses);
}

function refreshFrontmatter() {
  if (view === undefined || session === null) {
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
      editorKeymap(emptyRegistry, provider),
      tableEditingExtension(emptyRegistry, provider),
      ...(tagAffordanceOptions === undefined
        ? []
        : [tagAffordances(tagAffordanceOptions)]),
    ];
  }
  return [
    editorKeymap(activeRegistry, provider),
    tableEditingExtension(activeRegistry, provider),
    ...(tagAffordanceOptions === undefined
      ? []
      : [tagAffordances(tagAffordanceOptions)]),
    slashMenu(activeRegistry, provider),
    selectionToolbar(activeRegistry, provider),
    findExtension(),
  ];
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
  const initialFrontmatter = parseFrontmatter(content);
  const initialCursor =
    initialFrontmatter === null
      ? 0
      : Math.min(initialFrontmatter.to + 1, content.length);
  const anchor =
    restoration === null
      ? initialCursor
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
      ...(wikilinkNavigationOptions === undefined
        ? []
        : [wikilinkPointerNavigation(wikilinkNavigationOptions)]),
      editorAppearance,
      settingsCompartment.of(settingsExtensions(settings, sourceMode)),
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
        blur: () => {
          requestSave();
          return false;
        },
      }),
    ],
  });
}

function replaceEditorState(content: string, locked: boolean): void {
  const target = view;
  if (target === undefined) return;
  target.setState(stateFor(content, locked));
  const scrollTop = historyViewState?.scrollTop ?? 0;
  target.scrollDOM.style.scrollBehavior = "auto";
  target.scrollDOM.scrollTop = scrollTop;
  requestAnimationFrame(() => {
    if (view === target) target.scrollDOM.scrollTop = scrollTop;
    target.scrollDOM.style.removeProperty("scroll-behavior");
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
    session?.recordLocalChanges(transaction.changes);
    scheduleIdleSave();
  }
  if (transactions.some((transaction) => transaction.docChanged)) {
    refreshFrontmatter();
    scheduleTitleVisibilityRefresh();
    onDocChanged?.(target.state.doc.toString(), path);
  } else if (treeGrewInBackground(target)) {
    // Background parsing advanced without a document change. Consumers of
    // the syntax tree (the outline) recompute, or a large note's outline
    // stays truncated at the initial parse slice until the first edit.
    onDocChanged?.(target.state.doc.toString(), path);
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
function dispatchSessionChanges(changes: ChangeSet) {
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
    clearUndoHistory(view);
  }
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
  } catch (error) {
    // A conversion failure means the session state diverged from the
    // document; recover by re-reading the note.
    onWriteError?.(String(error));
    await rereadAndReconcile();
    return false;
  }
  if (request === null) {
    return true;
  }
  try {
    const result = await noteWrite(
      vault,
      path,
      toIpcChanges(request.changeSet),
      request.expectedProjectionHash,
    );
    if (result.result === "written") {
      try {
        session.commitSave(result.projection_hash);
        onSaved?.();
      } catch {
        await rereadAndReconcile();
        return false;
      }
    } else {
      // The on-disk projection moved: never overwrite. Roll the save
      // back, surface the reconciliation state and re-read.
      session.rollbackSave();
      onConflict?.();
      await rereadAndReconcile();
      return false;
    }
  } catch (error) {
    session.rollbackSave();
    onWriteError?.(
      error instanceof IpcError ? error.app.message : String(error),
    );
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
export function flush(): Promise<boolean> {
  clearTimeout(idleSaveTimer);
  return requestSave();
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
  projectionHash: string,
): Promise<void> {
  if (session === null) {
    return;
  }
  removed = false;
  try {
    dispatchSessionChanges(
      session.ingestDelta(fromIpcChanges(changeSet), projectionHash),
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
  );
}

/** Marks the open note as removed from disk: the buffer stays, saving pauses. */
export function markRemoved(): void {
  removed = true;
}

/** The live CodeMirror view, for command contexts and the outline. */
export function getView(): EditorView | undefined {
  return view;
}

/** Captures byte-exact selection offsets and the current reading position. */
export function captureHistoryState(): NoteViewState | null {
  if (view === undefined) return null;
  const content = view.state.doc.toString();
  const selection = view.state.selection.main;
  return {
    anchor: byteOffsetForCharacter(content, selection.anchor),
    head: byteOffsetForCharacter(content, selection.head),
    scrollTop: view.scrollDOM.scrollTop,
  };
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

function initializeForNote(current: LoadedNote | null) {
  clearTimeout(idleSaveTimer);
  removed = false;
  if (current === null) {
    session = null;
    replaceEditorState(doc, false);
    applyLinkContext();
    refreshFrontmatter();
    scheduleTitleVisibilityRefresh();
    onDocChanged?.(view?.state.doc.toString() ?? doc, path);
    return;
  }
  if (current.readOnly) {
    session = null;
    replaceEditorState(current.text, true);
    applyLinkContext();
    refreshFrontmatter();
    scheduleTitleVisibilityRefresh();
    onDocChanged?.(view?.state.doc.toString() ?? current.text, path);
    return;
  }
  session = new NoteSession(current.bytes, current.meta.projection_hash);
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
  replaceEditorState(text, false);
  applyLinkContext();
  refreshFrontmatter();
  scheduleTitleVisibilityRefresh();
  onDocChanged?.(view?.state.doc.toString() ?? text, path);
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
    if (titleVisibilityFrame !== undefined) {
      cancelAnimationFrame(titleVisibilityFrame);
    }
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

<div class="skr-editor-shell flex h-full min-h-0 flex-col">
  {#if !sourceMode && frontmatter !== null && frontmatter.entries.length > 0}
    <PropertiesPanel
      {frontmatter}
      onEditValue={editFrontmatterValue}
      noteIdentity={path}
    />
  {/if}
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
  .editor :global(.cm-line.cm-skr-rich-callout) {
    padding-inline: 1rem;
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
