// Note navigation has one address model and one controller on every surface.
// The browser adapter projects addresses onto the History API; the desktop
// adapter keeps the same addresses in memory. Wikilink parsing, resolution,
// follow behavior, and command registration also live here so pointer,
// keyboard, browser, and desktop entry points cannot drift apart.

import { syntaxTree } from "@codemirror/language";
import { type EditorState, Facet } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { openSystemUrl } from "../ipc/services";
import { isNotePath, withoutNoteExtension } from "../noteTitles";
import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

export type ObsidianAppConfig = {
  /** Link format the vault is configured to emit. */
  newLinkFormat: "shortest" | "relative" | "absolute";
  /** Whether the vault prefers markdown links over wikilinks. */
  useMarkdownLinks: boolean;
  /** Configured attachment folder mode, null when none is configured. */
  attachmentFolderPath: string | null;
};

export const DEFAULT_OBSIDIAN_APP_CONFIG: ObsidianAppConfig = {
  newLinkFormat: "shortest",
  useMarkdownLinks: false,
  attachmentFolderPath: null,
};

/** Parses the supported `.obsidian/app.json` link settings tolerantly. */
export function parseObsidianAppConfig(jsonText: string): ObsidianAppConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return DEFAULT_OBSIDIAN_APP_CONFIG;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return DEFAULT_OBSIDIAN_APP_CONFIG;
  }
  const record = parsed as Record<string, unknown>;
  const format = record.newLinkFormat;
  const useMarkdown = record.useMarkdownLinks;
  const attachments = record.attachmentFolderPath;
  return {
    newLinkFormat:
      format === "relative" || format === "absolute" ? format : "shortest",
    useMarkdownLinks: useMarkdown === true,
    attachmentFolderPath:
      typeof attachments === "string" && attachments.length > 0
        ? attachments
        : null,
  };
}

export type WikilinkResolutionContext = {
  /** Every note and file path in the open vault, vault-root-relative. */
  paths: readonly string[];
  config: ObsidianAppConfig;
  /** The note whose editor owns this context. */
  currentPath?: string | null;
  /** Read-only note loader used by rendered embeds and link previews. */
  loadNote?: (path: string) => Promise<string | null>;
  /** Read-only byte loader for vault files rendered images read. */
  loadAsset?: (path: string) => Promise<Uint8Array | null>;
  /** Resolved note paths enclosing a nested embed. */
  embedAncestry?: readonly string[];
  /** Current rendered-embed nesting depth. */
  embedDepth?: number;
  /** Whether note links expose delayed rendered previews. */
  linkPreviews?: boolean;
  /** Nested embeds render as headers only inside a transient link preview. */
  previewMode?: boolean;
};

export const EMPTY_WIKILINK_CONTEXT: WikilinkResolutionContext = {
  paths: [],
  config: DEFAULT_OBSIDIAN_APP_CONFIG,
};

export type NoteAddress = {
  /** NFC, slash-separated, vault-root-relative note path including `.md`. */
  path: string;
  /** Obsidian heading or block suffix without the leading `#`. */
  fragment?: string;
};

function sameAddress(left: NoteAddress | null, right: NoteAddress): boolean {
  return left?.path === right.path && left.fragment === right.fragment;
}

export type WikilinkResolution =
  | { kind: "self"; fragment?: string }
  | { kind: "note"; path: string; fragment?: string }
  | { kind: "unresolved"; candidate: NoteAddress | null };

type SplitTarget = { path: string; fragment?: string };

function splitWikilinkTarget(target: string): SplitTarget {
  const hash = target.indexOf("#");
  const path = (hash === -1 ? target : target.slice(0, hash)).trim();
  const fragment = hash === -1 ? "" : target.slice(hash + 1).trim();
  return fragment.length === 0 ? { path } : { path, fragment };
}

function joinVaultPath(baseDirectory: string, target: string): string | null {
  const segments = `${baseDirectory}/${target}`.split("/");
  const normalized: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (normalized.length === 0) {
        return null;
      }
      normalized.pop();
      continue;
    }
    normalized.push(segment);
  }
  return normalized.join("/").normalize("NFC");
}

function sourceDirectory(sourcePath: string | null | undefined): string {
  if (sourcePath === null || sourcePath === undefined) {
    return "";
  }
  const slash = sourcePath.lastIndexOf("/");
  return slash === -1 ? "" : sourcePath.slice(0, slash);
}

function resolutionTarget(
  path: string,
  context: WikilinkResolutionContext,
): string | null {
  const rootPath = path.startsWith("/") ? path.slice(1) : path;
  if (path.startsWith("./") || path.startsWith("../")) {
    return joinVaultPath(sourceDirectory(context.currentPath), rootPath);
  }
  return rootPath.normalize("NFC");
}

function targetHasExtension(target: string): boolean {
  const name = target.slice(target.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (
    dot > 0 &&
    dot < name.length - 1 &&
    [...name.slice(dot + 1)].every((character) => /[A-Za-z0-9]/.test(character))
  );
}

function exactWikilinkMatch(path: string, target: string): boolean {
  return (
    path === target ||
    (!targetHasExtension(target) &&
      isNotePath(path) &&
      withoutNoteExtension(path) === target)
  );
}

function suffixWikilinkMatch(path: string, target: string): boolean {
  const tailMatches = (candidate: string) => {
    const prefix = candidate.slice(0, -target.length);
    return candidate.endsWith(target) && prefix.endsWith("/");
  };
  return (
    tailMatches(path) ||
    (!targetHasExtension(target) &&
      isNotePath(path) &&
      tailMatches(withoutNoteExtension(path)))
  );
}

function deterministicPathOrder(left: string, right: string): number {
  const segmentDifference = left.split("/").length - right.split("/").length;
  if (segmentDifference !== 0) {
    return segmentDifference;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function attachmentCandidate(
  target: string,
  context: WikilinkResolutionContext,
): string | null {
  const configured = context.config.attachmentFolderPath;
  if (configured === null || target.includes("/")) {
    return null;
  }
  if (configured === "/") {
    return target;
  }
  if (configured === "./") {
    return joinVaultPath(sourceDirectory(context.currentPath), target);
  }
  return joinVaultPath(configured, target);
}

/** Mirrors the Rust index's exact, suffix, then case-folded match tiers. */
function resolvePath(target: string, paths: readonly string[]): string | null {
  const foldedTarget = target.toLowerCase();
  const tiers = [
    (path: string) => exactWikilinkMatch(path, target),
    (path: string) => suffixWikilinkMatch(path, target),
    (path: string) => exactWikilinkMatch(path.toLowerCase(), foldedTarget),
    (path: string) => suffixWikilinkMatch(path.toLowerCase(), foldedTarget),
  ];
  for (const matches of tiers) {
    const candidates = paths.filter(matches).sort(deterministicPathOrder);
    if (candidates.length > 0) {
      return candidates[0] ?? null;
    }
  }
  return null;
}

/** Resolves a target with Obsidian-compatible path, suffix, and fragment rules. */
export function resolveWikilinkTarget(
  target: string,
  context: WikilinkResolutionContext,
): WikilinkResolution {
  const split = splitWikilinkTarget(target);
  if (split.path.length === 0) {
    return split.fragment === undefined
      ? { kind: "self" }
      : { kind: "self", fragment: split.fragment };
  }

  const targetPath = resolutionTarget(split.path, context);
  const attachment = attachmentCandidate(split.path, context);
  const resolved =
    (attachment === null ? null : resolvePath(attachment, context.paths)) ??
    (targetPath === null ? null : resolvePath(targetPath, context.paths));
  if (resolved !== null) {
    return split.fragment === undefined
      ? { kind: "note", path: resolved }
      : { kind: "note", path: resolved, fragment: split.fragment };
  }
  return {
    kind: "unresolved",
    candidate: candidateAddressForTarget(target, context),
  };
}

/** Produces the deterministic note path shown by the not-found surface. */
export function candidateAddressForTarget(
  target: string,
  context: WikilinkResolutionContext,
): NoteAddress | null {
  const split = splitWikilinkTarget(target);
  if (split.path.length === 0) {
    const source = context.currentPath;
    if (source === null || source === undefined) {
      return null;
    }
    return split.fragment === undefined
      ? { path: source }
      : { path: source, fragment: split.fragment };
  }
  const candidate = resolutionTarget(split.path, context);
  if (candidate === null || candidate.length === 0) {
    return null;
  }
  const path = /\.[^/]+$/.test(candidate) ? candidate : `${candidate}.md`;
  const normalized = normalizeNotePath(path);
  if (normalized === null) {
    return null;
  }
  return split.fragment === undefined
    ? { path: normalized }
    : { path: normalized, fragment: split.fragment };
}

/** Validates and normalizes a permalink path without allowing vault escape. */
export function normalizeNotePath(path: string): string | null {
  const slashPath = path.replaceAll("\\", "/").normalize("NFC");
  if (slashPath.startsWith("/") || slashPath.length === 0) {
    return null;
  }
  const segments = slashPath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    return null;
  }
  return slashPath;
}

export const NOTE_ADDRESS_PARAMETER = "note";

/** Decodes the browser demo's `?note=<vault path>#<note fragment>` form. */
export function noteAddressFromUrl(url: URL): NoteAddress | null {
  const rawPath = url.searchParams.get(NOTE_ADDRESS_PARAMETER);
  if (rawPath === null) {
    return null;
  }
  // An address naming an extension addresses that file whatever its kind, so a
  // link to `deploy.yml`, `.gitignore` or an image resolves to itself. Only a
  // bare name takes the Markdown shorthand, matching wikilink resolution.
  const notePath = /\.[^/]+$/.test(rawPath) ? rawPath : `${rawPath}.md`;
  const path = normalizeNotePath(notePath);
  if (path === null) {
    return null;
  }
  let fragment: string;
  try {
    fragment = decodeURIComponent(url.hash.slice(1));
  } catch {
    fragment = url.hash.slice(1);
  }
  return fragment.length === 0 ? { path } : { path, fragment };
}

/** Encodes a note address while preserving unrelated demo query parameters. */
export function urlForNoteAddress(address: NoteAddress, current: URL): URL {
  const url = new URL(current);
  url.searchParams.set(NOTE_ADDRESS_PARAMETER, address.path);
  url.hash =
    address.fragment === undefined ? "" : encodeURIComponent(address.fragment);
  return url;
}

/** Reading state stored with one navigation history entry. Document offsets are UTF-8 bytes. */
export type NoteViewState = {
  anchor: number;
  head: number;
  scrollAnchor: number;
  scrollOffset: number;
  propertiesExpanded: boolean;
};

/** The vertical extent of one editor line block, in editor coordinates. */
export type ScrollAnchorLine = {
  from: number;
  to: number;
  top: number;
};

/** The measurements the reading-position rule reads from a laid-out editor. */
export type ScrollAnchorGeometry = {
  /** Editor-coordinate height of the viewport's top edge. */
  viewportTop: number;
  /** Character length of the document, so the last line is never advanced past. */
  documentLength: number;
  /** Physical pixels per CSS pixel, which webview zoom also changes. */
  devicePixelRatio: number;
  lineBlockAtHeight(height: number): ScrollAnchorLine;
  lineBlockAt(position: number): ScrollAnchorLine;
};

/** The line a reading position is stored against, and its distance below the viewport edge. */
export type ScrollAnchorPosition = {
  line: ScrollAnchorLine;
  offset: number;
};

/**
 * Chooses the line a reading position is stored against: the first line the
 * reader sees whole, and how far below the viewport's top edge it starts.
 *
 * The encoding names a line, so it steps by a whole line where the reader's
 * position moves by a fraction of one: a viewport edge a hair above a line
 * start and a hair below it are stored against different lines. Restoring is
 * exact while the layout is unchanged, because the offset is the very
 * distance the restore reproduces; a layout that changed in between, from
 * webview zoom or from an image or font that finished loading, reproduces the
 * position only as closely as the scroller can hold it. Comparisons of two
 * stored positions therefore go through `readingViewportTop` rather than
 * comparing anchors and offsets field by field.
 */
export function scrollAnchorForViewport(
  geometry: ScrollAnchorGeometry,
): ScrollAnchorPosition {
  let line = geometry.lineBlockAtHeight(geometry.viewportTop);
  const offset = line.top - geometry.viewportTop;
  const halfPhysicalPixel = 0.5 / Math.max(1, geometry.devicePixelRatio);
  const crossesRoundedPixelBoundary =
    offset < 0 || (offset > 0 && offset < halfPhysicalPixel);
  if (crossesRoundedPixelBoundary && line.to < geometry.documentLength) {
    line = geometry.lineBlockAt(line.to + 1);
  }
  return { line, offset: line.top - geometry.viewportTop };
}

/**
 * The viewport edge a stored reading position denotes, in the editor
 * coordinates of the layout the anchor line was measured in. Two stored
 * positions describe the same reading position when this agrees, whichever
 * line each of them happens to be anchored to.
 */
export function readingViewportTop(
  anchorLineTop: number,
  scrollOffset: number,
): number {
  return anchorLineTop - scrollOffset;
}

export const NAVIGATION_HISTORY_LIMIT = 100;

type HistoryEntry = { address: NoteAddress; viewState: NoteViewState | null };
type HistoryListener = (entry: HistoryEntry, rollback: () => void) => void;

interface NavigationHistory {
  current(): NoteAddress | null;
  replace(address: NoteAddress, viewState?: NoteViewState | null): void;
  push(address: NoteAddress, viewState?: NoteViewState | null): void;
  updateViewState(viewState: NoteViewState | null): void;
  reset(address: NoteAddress): void;
  /**
   * Drops the current entry's address without touching the back/forward
   * stack: the pane it named has emptied, so nothing addresses it any more.
   */
  clear(): void;
  back(): boolean;
  forward(): boolean;
  canGoBack(): boolean;
  canGoForward(): boolean;
  subscribe(listener: HistoryListener): () => void;
}

class MemoryNavigationHistory implements NavigationHistory {
  private entries: HistoryEntry[] = [];
  private index = -1;
  private listener: HistoryListener | null = null;

  current(): NoteAddress | null {
    return this.entries[this.index]?.address ?? null;
  }

  replace(address: NoteAddress, viewState: NoteViewState | null = null): void {
    if (this.index < 0) {
      this.entries = [{ address, viewState }];
      this.index = 0;
    } else {
      this.entries[this.index] = { address, viewState };
    }
  }

  push(address: NoteAddress, viewState: NoteViewState | null = null): void {
    const entries = [
      ...this.entries.slice(0, this.index + 1),
      { address, viewState },
    ];
    this.entries = entries.slice(-NAVIGATION_HISTORY_LIMIT);
    this.index = this.entries.length - 1;
  }

  updateViewState(viewState: NoteViewState | null): void {
    const entry = this.entries[this.index];
    if (entry !== undefined) this.entries[this.index] = { ...entry, viewState };
  }

  reset(address: NoteAddress): void {
    this.entries = [{ address, viewState: null }];
    this.index = 0;
  }

  // No visible address bar in desktop mode: nothing to clear.
  clear(): void {}

  back(): boolean {
    if (this.index <= 0) {
      return false;
    }
    const previousIndex = this.index;
    this.index -= 1;
    const traversedIndex = this.index;
    this.listener?.(this.entries[this.index] as HistoryEntry, () => {
      if (this.index === traversedIndex) this.index = previousIndex;
    });
    return true;
  }

  forward(): boolean {
    if (this.index >= this.entries.length - 1) {
      return false;
    }
    const previousIndex = this.index;
    this.index += 1;
    const traversedIndex = this.index;
    this.listener?.(this.entries[this.index] as HistoryEntry, () => {
      if (this.index === traversedIndex) this.index = previousIndex;
    });
    return true;
  }

  canGoBack(): boolean {
    return this.index > 0;
  }

  canGoForward(): boolean {
    return this.index >= 0 && this.index < this.entries.length - 1;
  }

  subscribe(listener: HistoryListener): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) {
        this.listener = null;
      }
    };
  }
}

const BROWSER_HISTORY_KEY = "skribeumNavigationIndex";
const BROWSER_VIEW_STATE_KEY = "skribeumNoteViewState";

function storedViewState(value: unknown): NoteViewState | null {
  if (typeof value !== "object" || value === null) return null;
  const state = value as Record<string, unknown>;
  return typeof state.anchor === "number" &&
    typeof state.head === "number" &&
    typeof state.scrollAnchor === "number" &&
    typeof state.scrollOffset === "number" &&
    typeof state.propertiesExpanded === "boolean"
    ? {
        anchor: state.anchor,
        head: state.head,
        scrollAnchor: state.scrollAnchor,
        scrollOffset: state.scrollOffset,
        propertiesExpanded: state.propertiesExpanded,
      }
    : null;
}

class BrowserNavigationHistory implements NavigationHistory {
  private index = 0;
  private minimumIndex = 0;
  private maximumIndex = 0;
  private listener: HistoryListener | null = null;
  private rollbackTarget: number | null = null;

  constructor(private readonly browserWindow: Window) {
    const state = browserWindow.history.state as Record<string, unknown> | null;
    const stored = state?.[BROWSER_HISTORY_KEY];
    if (typeof stored === "number" && Number.isInteger(stored) && stored >= 0) {
      this.index = stored;
      this.minimumIndex = Math.max(0, stored - NAVIGATION_HISTORY_LIMIT + 1);
      this.maximumIndex = stored;
    } else {
      browserWindow.history.replaceState(
        { ...(state ?? {}), [BROWSER_HISTORY_KEY]: 0 },
        "",
        browserWindow.location.href,
      );
    }
  }

  current(): NoteAddress | null {
    return noteAddressFromUrl(new URL(this.browserWindow.location.href));
  }

  replace(address: NoteAddress, viewState: NoteViewState | null = null): void {
    const url = urlForNoteAddress(
      address,
      new URL(this.browserWindow.location.href),
    );
    this.browserWindow.history.replaceState(
      {
        ...(this.browserWindow.history.state ?? {}),
        [BROWSER_HISTORY_KEY]: this.index,
        [BROWSER_VIEW_STATE_KEY]: viewState,
      },
      "",
      url,
    );
  }

  push(address: NoteAddress, viewState: NoteViewState | null = null): void {
    this.index += 1;
    this.maximumIndex = this.index;
    this.minimumIndex = Math.max(0, this.index - NAVIGATION_HISTORY_LIMIT + 1);
    const url = urlForNoteAddress(
      address,
      new URL(this.browserWindow.location.href),
    );
    this.browserWindow.history.pushState(
      {
        ...(this.browserWindow.history.state ?? {}),
        [BROWSER_HISTORY_KEY]: this.index,
        [BROWSER_VIEW_STATE_KEY]: viewState,
      },
      "",
      url,
    );
  }

  updateViewState(viewState: NoteViewState | null): void {
    this.browserWindow.history.replaceState(
      {
        ...(this.browserWindow.history.state ?? {}),
        [BROWSER_HISTORY_KEY]: this.index,
        [BROWSER_VIEW_STATE_KEY]: viewState,
      },
      "",
      this.browserWindow.location.href,
    );
  }

  reset(address: NoteAddress): void {
    this.index = 0;
    this.minimumIndex = 0;
    this.maximumIndex = 0;
    this.replace(address);
  }

  // The pane this entry addressed emptied: the parameter it named is no
  // longer true of anything on screen, so it is dropped in place, the same
  // `replaceState` the rest of this adapter uses to keep the address bar
  // honest without minting a new history entry.
  clear(): void {
    if (this.current() === null) return;
    const url = new URL(this.browserWindow.location.href);
    url.searchParams.delete(NOTE_ADDRESS_PARAMETER);
    url.hash = "";
    this.browserWindow.history.replaceState(
      {
        ...(this.browserWindow.history.state ?? {}),
        [BROWSER_HISTORY_KEY]: this.index,
        [BROWSER_VIEW_STATE_KEY]: null,
      },
      "",
      url,
    );
  }

  back(): boolean {
    if (this.index <= this.minimumIndex) {
      return false;
    }
    this.browserWindow.history.back();
    return true;
  }

  forward(): boolean {
    if (this.index >= this.maximumIndex) {
      return false;
    }
    this.browserWindow.history.forward();
    return true;
  }

  canGoBack(): boolean {
    return this.index > this.minimumIndex;
  }

  canGoForward(): boolean {
    return this.index < this.maximumIndex;
  }

  subscribe(listener: HistoryListener): () => void {
    this.listener = listener;
    const onPopState = (event: PopStateEvent) => {
      const state = event.state as Record<string, unknown> | null;
      const stored = state?.[BROWSER_HISTORY_KEY];
      const previousIndex = this.index;
      if (typeof stored === "number" && Number.isInteger(stored)) {
        this.index = stored;
      }
      if (this.rollbackTarget === this.index) {
        this.rollbackTarget = null;
        return;
      }
      const address = this.current();
      if (address !== null) {
        const traversedIndex = this.index;
        this.listener?.(
          {
            address,
            viewState: storedViewState(state?.[BROWSER_VIEW_STATE_KEY]),
          },
          () => {
            if (this.index !== traversedIndex) return;
            this.rollbackTarget = previousIndex;
            this.browserWindow.history.go(previousIndex - traversedIndex);
          },
        );
      }
    };
    this.browserWindow.addEventListener("popstate", onPopState);
    return () => {
      this.browserWindow.removeEventListener("popstate", onPopState);
      if (this.listener === listener) {
        this.listener = null;
      }
    };
  }
}

export type NavigationMode = "browser" | "desktop";

export type NoteNavigator = {
  start(fallback: NoteAddress | null): Promise<void>;
  open(address: NoteAddress): Promise<void>;
  /**
   * Points the current history entry at an address the shell already shows,
   * without loading anything. Tab switches and renames change what the user
   * is looking at without being navigations, and the address has to follow.
   */
  syncAddress(address: NoteAddress | null): void;
  /** Drops the current address: the pane it named holds no note any more. */
  clearAddress(): void;
  reset(address: NoteAddress): Promise<void>;
  back(): boolean;
  forward(): boolean;
  state(): NavigationState;
  dispose(): void;
};

export type NavigationState = {
  address: NoteAddress | null;
  canGoBack: boolean;
  canGoForward: boolean;
};

/** Builds the shared navigation controller over the selected history adapter. */
export function createNoteNavigator(options: {
  mode: NavigationMode;
  load(
    address: NoteAddress,
    restoration: NoteViewState | null,
    source: "fresh" | "history",
  ): Promise<unknown>;
  capture?: () => NoteViewState | null;
  browserWindow?: Window;
  changed?: (state: NavigationState) => void;
}): NoteNavigator {
  const history: NavigationHistory =
    options.mode === "browser"
      ? new BrowserNavigationHistory(options.browserWindow ?? window)
      : new MemoryNavigationHistory();
  let queue = Promise.resolve(true);
  const state = (): NavigationState => ({
    address: history.current(),
    canGoBack: history.canGoBack(),
    canGoForward: history.canGoForward(),
  });
  const enqueue = (
    address: NoteAddress,
    restoration: NoteViewState | null,
    source: "fresh" | "history",
  ) => {
    queue = queue
      .catch(() => false)
      .then(
        async () =>
          (await options.load(address, restoration, source)) !== false,
      )
      .catch(() => false);
    return queue;
  };
  const unsubscribe = history.subscribe((entry, rollback) => {
    void enqueue(entry.address, entry.viewState, "history").then((loaded) => {
      if (!loaded) rollback();
      options.changed?.(state());
    });
  });
  return {
    async start(fallback) {
      const current = history.current();
      const address = current ?? fallback;
      if (address === null) {
        return;
      }
      history.replace(address);
      await enqueue(address, null, "fresh");
      options.changed?.(state());
    },
    async open(address) {
      history.updateViewState(options.capture?.() ?? null);
      // The history entry commits before the load, not after: the shell
      // reports the note it shows through `syncAddress` the moment the load
      // lands, so a push decided afterwards would find the address already
      // rewritten to its own destination and degrade into a replace,
      // leaving every navigation without a history entry. A load that then
      // fails walks the committed entry back.
      const revisit = sameAddress(history.current(), address);
      if (revisit) {
        history.replace(address, null);
      } else {
        history.push(address);
      }
      const loaded = await enqueue(address, null, "fresh");
      if (!loaded && !revisit) {
        history.back();
      }
      options.changed?.(state());
    },
    syncAddress(address) {
      if (address === null || sameAddress(history.current(), address)) return;
      history.replace(address, null);
      options.changed?.(state());
    },
    clearAddress() {
      history.clear();
      options.changed?.(state());
    },
    async reset(address) {
      history.reset(address);
      await enqueue(address, null, "fresh");
      options.changed?.(state());
    },
    back: () => {
      history.updateViewState(options.capture?.() ?? null);
      return history.back();
    },
    forward: () => {
      history.updateViewState(options.capture?.() ?? null);
      return history.forward();
    },
    state,
    dispose: unsubscribe,
  };
}

/** Locates an Obsidian heading or block fragment in the open note. */
export function noteFragmentPosition(
  state: EditorState,
  fragment: string | undefined,
): number | null {
  if (fragment === undefined || fragment.length === 0) {
    return null;
  }
  const wanted = fragment.normalize("NFC").toLocaleLowerCase();
  let found: number | null = null;
  syntaxTree(state).iterate({
    enter(node) {
      if (found !== null) {
        return false;
      }
      if (fragment.startsWith("^") && node.name === "BlockId") {
        const source = state.doc.sliceString(node.from, node.to);
        if (source.normalize("NFC").toLocaleLowerCase() === wanted) {
          found = node.from;
        }
        return undefined;
      }
      if (!/^ATXHeading[1-6]$|^SetextHeading[12]$/.test(node.name)) {
        return undefined;
      }
      const source = state.doc.sliceString(node.from, node.to);
      const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
      const heading = firstLine
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/\s+#+\s*$/, "")
        .trim()
        .normalize("NFC")
        .toLocaleLowerCase();
      if (heading === wanted) {
        found = node.from;
      }
      return undefined;
    },
  });
  return found;
}

export type WikilinkReference = {
  from: number;
  to: number;
  textFrom: number;
  textTo: number;
  target: string;
  embedded: boolean;
};

function wikilinkNodeAt(
  state: EditorState,
  position: number,
): SyntaxNode | null {
  const bounded = Math.max(0, Math.min(position, state.doc.length));
  for (const side of [1, -1] as const) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(bounded, side);
    while (node !== null && node.name !== "Wikilink") {
      node = node.parent;
    }
    if (node !== null) {
      return node;
    }
  }
  return null;
}

/** Returns the editable target range and navigation target at a document offset. */
export function wikilinkReferenceAt(
  state: EditorState,
  position: number,
): WikilinkReference | null {
  const node = wikilinkNodeAt(state, position);
  const target = node?.getChild("WikilinkTarget") ?? null;
  if (node === null || target === null) {
    return null;
  }
  const alias = node.getChild("WikilinkAlias");
  return {
    from: node.from,
    to: node.to,
    textFrom: target.from,
    textTo: alias?.to ?? target.to,
    target: state.doc.sliceString(target.from, target.to),
    embedded: node.parent?.name === "Embed",
  };
}

/** True when the active editor selection is editing this link's visible text. */
export function cursorInsideWikilinkText(
  state: EditorState,
  reference: WikilinkReference,
): boolean {
  const selection = state.selection.main;
  return (
    selection.empty &&
    selection.head >= reference.textFrom &&
    selection.head <= reference.textTo
  );
}

export type FollowWikilinkOptions = {
  context: WikilinkResolutionContext;
  currentPath: string | null;
  navigate(
    address: NoteAddress,
    intent?: { newTab?: boolean },
  ): Promise<void> | void;
  unresolved(reason: string): void;
  /** Opens an external HTTP or HTTPS URL outside the note navigator. */
  openExternal?: (url: string) => Promise<void> | void;
};

/** Returns a source URL only when it uses an explicitly supported scheme. */
export function externalHttpUrl(rawTarget: string): string | null {
  const unwrapped =
    rawTarget.startsWith("<") && rawTarget.endsWith(">")
      ? rawTarget.slice(1, -1)
      : rawTarget;
  let parsed: URL;
  try {
    parsed = new URL(unwrapped);
  } catch {
    return null;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:"
    ? unwrapped
    : null;
}

function externalLinkFromNode(
  state: EditorState,
  node: SyntaxNode | null,
): string | null {
  let current = node;
  while (current !== null) {
    if (current.name === "Image") {
      return null;
    }
    if (current.name === "Link") {
      const url = current.getChild("URL");
      return url === null
        ? null
        : externalHttpUrl(state.doc.sliceString(url.from, url.to));
    }
    if (current.name === "URL") {
      return externalHttpUrl(state.doc.sliceString(current.from, current.to));
    }
    current = current.parent;
  }
  return null;
}

/** Returns the external HTTP or HTTPS link at a document offset. */
export function externalLinkAt(
  state: EditorState,
  position: number,
): string | null {
  const bounded = Math.max(0, Math.min(position, state.doc.length));
  for (const side of [1, -1] as const) {
    const target = externalLinkFromNode(
      state,
      syntaxTree(state).resolveInner(bounded, side),
    );
    if (target !== null) {
      return target;
    }
  }
  return null;
}

/** Opens an external link through the platform-appropriate browser route. */
export async function openExternalLink(
  url: string,
  mode: NavigationMode,
  browserWindow: Window = window,
): Promise<void> {
  if (externalHttpUrl(url) === null) {
    return;
  }
  if (mode === "desktop") {
    await openSystemUrl(url);
    return;
  }
  browserWindow.open(url, "_blank", "noopener");
}

/** Navigation capabilities available to rendered editor widgets. */
export const wikilinkNavigationOptionsFacet = Facet.define<
  () => FollowWikilinkOptions,
  (() => FollowWikilinkOptions) | null
>({
  combine: (providers) => providers.at(-1) ?? null,
});

/**
 * Calls the navigator, naming the new-tab intent only when one exists so a
 * default follow stays the one-argument call every other route makes.
 */
function navigateWithIntent(
  options: FollowWikilinkOptions,
  address: NoteAddress,
  intent: { newTab?: boolean },
): void {
  if (intent.newTab === true) void options.navigate(address, { newTab: true });
  else void options.navigate(address);
}

/** Resolves and follows one wikilink target through the shared address model. */
export function followWikilinkTarget(
  target: string,
  options: FollowWikilinkOptions,
  intent: { newTab?: boolean } = {},
): boolean {
  const resolution = resolveWikilinkTarget(target, options.context);
  if (resolution.kind === "note") {
    if (!isNotePath(resolution.path)) {
      options.unresolved(STRINGS.wikilinkTargetNotNote);
      return true;
    }
    navigateWithIntent(
      options,
      resolution.fragment === undefined
        ? { path: resolution.path }
        : { path: resolution.path, fragment: resolution.fragment },
      intent,
    );
    return true;
  }
  if (resolution.kind === "self") {
    if (options.currentPath === null) {
      return false;
    }
    navigateWithIntent(
      options,
      resolution.fragment === undefined
        ? { path: options.currentPath }
        : { path: options.currentPath, fragment: resolution.fragment },
      intent,
    );
    return true;
  }
  options.unresolved(STRINGS.wikilinkUnresolvedReason);
  const candidate = resolution.candidate;
  if (
    candidate !== null &&
    candidate !== undefined &&
    isNotePath(candidate.path)
  ) {
    navigateWithIntent(options, candidate, intent);
  }
  return true;
}

/** Follows the wikilink at an offset, including unresolved not-found routing. */
export function followWikilinkAt(
  view: EditorView,
  position: number,
  options: FollowWikilinkOptions,
  intent: { newTab?: boolean } = {},
): boolean {
  const reference = wikilinkReferenceAt(view.state, position);
  if (reference === null) {
    return false;
  }
  const followed = followWikilinkTarget(reference.target, options, intent);
  if (followed) {
    view.contentDOM.blur();
  }
  return followed;
}

/** Follows an external URL or wikilink at an editor offset. */
export function followLinkAt(
  view: EditorView,
  position: number,
  options: FollowWikilinkOptions,
  intent: { newTab?: boolean } = {},
): boolean {
  const external = externalLinkAt(view.state, position);
  if (external !== null && options.openExternal !== undefined) {
    void options.openExternal(external);
    view.contentDOM.blur();
    return true;
  }
  return followWikilinkAt(view, position, options, intent);
}

/** Finds a wikilink position from a decorated DOM descendant. */
export function wikilinkPositionFromElement(
  view: EditorView,
  target: EventTarget | null,
): number | null {
  const element = target instanceof Element ? target : null;
  const link = element?.closest(".cm-skr-wikilink");
  if (link === null || link === undefined || !view.dom.contains(link)) {
    return null;
  }
  try {
    return view.posAtDOM(link, 0);
  } catch {
    return null;
  }
}

/** Finds an external or internal link position from a decorated descendant. */
export function linkPositionFromElement(
  view: EditorView,
  target: EventTarget | null,
): number | null {
  const element = target instanceof Element ? target : null;
  const link = element?.closest(".cm-skr-wikilink, [data-external-url]");
  if (link === null || link === undefined || !view.dom.contains(link)) {
    return null;
  }
  try {
    return view.posAtDOM(link, 0);
  } catch {
    return null;
  }
}

/** Follows the cursor link, or the decorated link that owns DOM focus. */
export function followWikilinkUnderCursor(
  view: EditorView,
  options: FollowWikilinkOptions,
): boolean {
  const focused = wikilinkPositionFromElement(view, document.activeElement);
  return followWikilinkAt(
    view,
    focused ?? view.state.selection.main.head,
    options,
  );
}

/** Follows the external URL or wikilink at the cursor or focused widget. */
export function followLinkUnderCursor(
  view: EditorView,
  options: FollowWikilinkOptions,
): boolean {
  const focused = linkPositionFromElement(view, document.activeElement);
  return followLinkAt(view, focused ?? view.state.selection.main.head, options);
}

/** Registers history movement and cursor-link following through the registry. */
export function registerNavigation(registry: CommandRegistry): void {
  registry.register({
    id: "navigation.back",
    title: STRINGS.commandNavigateBack,
    keybindings: ["Alt-ArrowLeft"],
    pointer: ["app-bar", "action-menu", "command-palette"],
    run: (context) => context.navigateBack?.() ?? false,
  });
  registry.register({
    id: "navigation.forward",
    title: STRINGS.commandNavigateForward,
    keybindings: ["Alt-ArrowRight"],
    pointer: ["app-bar", "action-menu", "command-palette"],
    run: (context) => context.navigateForward?.() ?? false,
  });
  registry.register({
    id: "navigation.follow-link",
    title: STRINGS.commandFollowLink,
    keybindings: ["Mod-Enter", "Enter"],
    scope: "editor",
    pointer: ["command-palette", "editor-link"],
    run: (context) => context.followLink?.(context.view) ?? false,
  });
}
