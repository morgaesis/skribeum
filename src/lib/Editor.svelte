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
import { noteRenderingExtensions } from "./editor/syntaxPolicy";
import { findExtension } from "./features/findPanel";
import type { FollowWikilinkOptions } from "./features/navigation";
import { selectionToolbar } from "./features/selectionToolbar";
import {
  DEFAULT_SETTINGS,
  type SettingsDocument,
} from "./features/settingsStore";
import { slashMenu } from "./features/slashMenu";
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
  onConflict,
  onWriteError,
  onDocChanged,
  wikilinkNavigationOptions,
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
  onConflict?: () => void;
  onWriteError?: (message: string) => void;
  /** Notified after any document-changing transaction (outline refresh). */
  onDocChanged?: () => void;
  /** Supplies the shared navigator capabilities for pointer activation. */
  wikilinkNavigationOptions?: () => FollowWikilinkOptions;
} = $props();

let host: HTMLDivElement;
let view: EditorView | undefined;
let session: NoteSession | null = null;
/** Set when the open note disappeared from disk; saving pauses. */
let removed = false;
let idleSaveTimer: ReturnType<typeof setTimeout> | undefined;
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
let showRawFrontmatter = $state(false);
let frontmatterNoteIdentity = $state<string | null>(null);

$effect(() => {
  if (path !== frontmatterNoteIdentity) {
    frontmatterNoteIdentity = path;
    showRawFrontmatter = false;
  }
});

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
    return [editorKeymap(new CommandRegistry(), provider)];
  }
  return [
    editorKeymap(activeRegistry, provider),
    slashMenu(activeRegistry, provider),
    selectionToolbar(activeRegistry, provider),
    findExtension(),
  ];
}

function stateFor(content: string, locked: boolean): EditorState {
  const normalizedTaskStatuses = normalizeTaskStatuses(taskStatuses);
  return EditorState.create({
    doc: content,
    extensions: [
      renderingCompartment.of(
        noteRenderingExtensions(content, undefined, normalizedTaskStatuses),
      ),
      ...(wikilinkNavigationOptions === undefined
        ? []
        : [wikilinkPointerNavigation(wikilinkNavigationOptions)]),
      editorAppearance,
      settingsCompartment.of(settingsExtensions(settings)),
      bulkTextInput(),
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

function settingsExtensions(document: SettingsDocument): Extension[] {
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
    ...(document.show_invisible_characters ? [showInvisibleCharacters()] : []),
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
    onDocChanged?.();
  } else if (treeGrewInBackground(target)) {
    // Background parsing advanced without a document change. Consumers of
    // the syntax tree (the outline) recompute, or a large note's outline
    // stays truncated at the initial parse slice until the first edit.
    onDocChanged?.();
  }
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
  showRawFrontmatter = false;
  if (current === null) {
    session = null;
    view?.setState(stateFor(doc, false));
    applyLinkContext();
    refreshFrontmatter();
    return;
  }
  if (current.readOnly) {
    session = null;
    view?.setState(stateFor(current.text, true));
    applyLinkContext();
    refreshFrontmatter();
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
  view?.setState(stateFor(text, false));
  applyLinkContext();
  refreshFrontmatter();
}

onMount(() => {
  view = new EditorView({
    state: stateFor(doc, false),
    parent: host,
    dispatchTransactions,
  });
  initializeForNote(note);
  return () => {
    clearTimeout(idleSaveTimer);
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

// Status settings apply without rebuilding the editor or touching the source.
$effect(() => {
  const normalizedTaskStatuses = normalizeTaskStatuses(taskStatuses);
  if (view !== undefined) {
    view.dispatch({
      effects: renderingCompartment.reconfigure(
        noteRenderingExtensions(
          view.state.doc,
          undefined,
          normalizedTaskStatuses,
        ),
      ),
    });
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
  if (view !== undefined) {
    view.dispatch({
      effects: settingsCompartment.reconfigure(
        settingsExtensions(nextSettings),
      ),
    });
  }
});
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if frontmatter !== null && frontmatter.entries.length > 0}
    <PropertiesPanel
      {frontmatter}
      rawSourceVisible={showRawFrontmatter}
      onRawSourceVisibleChange={(visible) => (showRawFrontmatter = visible)}
      onEditValue={editFrontmatterValue}
      noteIdentity={path}
    />
  {/if}
  <div
    class:skr-show-raw-frontmatter={showRawFrontmatter}
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
  .editor:not(.skr-show-raw-frontmatter)
    :global(.cm-line.cm-skr-frontmatter) {
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
