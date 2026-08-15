import { applyByteChangeSet } from "../../../src/lib/editor/byteChangeSet";
import type {
  EditHistoryAction,
  EditHistorySnapshot,
} from "../../../src/lib/editor/durableHistory";
import { isNotePath } from "../../../src/lib/noteTitles";
import { STRINGS } from "../../../src/lib/strings";
import { DEMO_BINARY_FILES, DEMO_FILES } from "../vault/seed";
import type {
  AppError,
  ByteRangeReplace,
  NoteContent,
  NoteStat,
  TreeEntry,
  VaultHandle,
  WriteResult,
} from "./bindings";

export type LoadedNote = {
  meta: NoteContent;
  bytes: Uint8Array;
  text: string;
  readOnly: boolean;
  recoveredChangeSet?: ByteRangeReplace[];
};

/** Browser-equivalent vault identity for the frontend native-lifecycle seam. */
export type VaultOpenResult = {
  handle: VaultHandle;
  root: string;
};

type PermissionMode = "read" | "readwrite";
type PermissionDescriptor = { mode?: PermissionMode };
type WritableFile = {
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
};

export type BrowserFileHandle = {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable?: () => Promise<WritableFile>;
};

export type BrowserDirectoryHandle = {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterableIterator<BrowserFileHandle | BrowserDirectoryHandle>;
  queryPermission?: (
    descriptor?: PermissionDescriptor,
  ) => Promise<PermissionState>;
  requestPermission?: (
    descriptor?: PermissionDescriptor,
  ) => Promise<PermissionState>;
};

export type DemoVaultStatus =
  | { source: "seeded" }
  | {
      source: "folder";
      name: string;
      writes: "folder" | "memory";
      skipped: number;
    };

type DemoWindow = Window & {
  showDirectoryPicker?: (options?: {
    mode?: PermissionMode;
  }) => Promise<BrowserDirectoryHandle>;
  __SKRIBEUM_E2E_NOTE_GATES__?: Record<string, Promise<void>>;
};

const LOCAL_FOLDER_VAULT = "skribeum-local-folder";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function seededFiles(): Map<string, Uint8Array> {
  const files = new Map(
    Object.entries(DEMO_FILES).map(([path, content]) => [
      path,
      encoder.encode(content),
    ]),
  );
  for (const [path, bytes] of Object.entries(DEMO_BINARY_FILES)) {
    files.set(path, bytes);
  }
  return files;
}

type DemoVault = {
  files: Map<string, Uint8Array>;
  directories: Set<string>;
  fileHandles: Map<string, BrowserFileHandle>;
  readOnlyPaths: Set<string>;
  directoryHandle: BrowserDirectoryHandle | null;
  folderWrites: boolean;
  skippedFiles: number;
};

function seededVault(): DemoVault {
  return {
    files: seededFiles(),
    directories: new Set(),
    fileHandles: new Map(),
    readOnlyPaths: new Set(),
    directoryHandle: null,
    folderWrites: false,
    skippedFiles: 0,
  };
}

let nextVaultId = 0;
let nextFolderSelectionId = 0;
let activeVault: DemoVault | null = null;
const vaults = new Map<number, DemoVault>();
const folderSelections = new Map<string, DemoVault>();
let status: DemoVaultStatus = { source: "seeded" };
const statusListeners = new Set<(next: DemoVaultStatus) => void>();

async function waitForTestGate(relPath: string): Promise<void> {
  if (typeof window !== "undefined") {
    await (window as DemoWindow).__SKRIBEUM_E2E_NOTE_GATES__?.[relPath];
  }
}

/** Restores the seeded in-memory vault for isolated browser tests. */
export function resetDemoVault(): void {
  nextVaultId = 0;
  nextFolderSelectionId = 0;
  activeVault = null;
  vaults.clear();
  folderSelections.clear();
  publishStatus({ source: "seeded" });
}

export class IpcError extends Error {
  readonly app: AppError;

  constructor(app: AppError) {
    super(`${app.code}: ${app.message}`);
    this.app = app;
  }
}

function fail(code: string, message: string, path: string | null): never {
  throw new IpcError({ code, message, path });
}

function publishStatus(next: DemoVaultStatus): void {
  status = next;
  for (const listener of statusListeners) {
    listener(next);
  }
}

function publishFolderStatus(vault: DemoVault): void {
  if (vault === activeVault && vault.directoryHandle !== null) {
    publishStatus({
      source: "folder",
      name: vault.directoryHandle.name,
      writes: vault.folderWrites ? "folder" : "memory",
      skipped: vault.skippedFiles,
    });
  }
}

export function localFolderAccessSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window as DemoWindow).showDirectoryPicker === "function"
  );
}

export function demoVaultStatus(): DemoVaultStatus {
  return status;
}

export function subscribeDemoVaultStatus(
  listener: (next: DemoVaultStatus) => void,
): () => void {
  statusListeners.add(listener);
  listener(status);
  return () => statusListeners.delete(listener);
}

async function permission(
  handle: BrowserDirectoryHandle,
  request: boolean,
): Promise<PermissionState> {
  try {
    const descriptor = { mode: "readwrite" } as const;
    if (request && handle.requestPermission !== undefined) {
      return await handle.requestPermission(descriptor);
    }
    if (handle.queryPermission !== undefined) {
      return await handle.queryPermission(descriptor);
    }
  } catch {
    return "denied";
  }
  return "prompt";
}

async function fileBytes(handle: BrowserFileHandle): Promise<Uint8Array> {
  return new Uint8Array(await (await handle.getFile()).arrayBuffer());
}

async function abortWrite(writable: WritableFile): Promise<void> {
  try {
    await writable.abort?.();
  } catch {
    // The conflict remains authoritative even if the browser cannot clean up
    // its temporary writable stream.
  }
}

async function collectDirectory(
  directory: BrowserDirectoryHandle,
  prefix: string,
  nextFiles: Map<string, Uint8Array>,
  nextHandles: Map<string, BrowserFileHandle>,
  readOnlyPaths: Set<string>,
): Promise<number> {
  let skipped = 0;
  for await (const entry of directory.values()) {
    const path = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
    if (entry.kind === "directory") {
      if (entry.name.startsWith(".") && path !== ".obsidian") {
        continue;
      }
      skipped += await collectDirectory(
        entry,
        path,
        nextFiles,
        nextHandles,
        readOnlyPaths,
      );
      continue;
    }
    const markdown = isNotePath(path);
    const config =
      path === ".obsidian/app.json" || path === ".obsidian/types.json";
    if (!markdown && !config) {
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await fileBytes(entry);
    } catch {
      skipped += 1;
      continue;
    }
    if (markdown) {
      const hasBom =
        bytes.length >= 3 &&
        bytes[0] === 0xef &&
        bytes[1] === 0xbb &&
        bytes[2] === 0xbf;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(
          hasBom ? bytes.subarray(3) : bytes,
        );
      } catch {
        readOnlyPaths.add(path);
      }
    }
    nextFiles.set(path, bytes);
    nextHandles.set(path, entry);
  }
  return skipped;
}

export async function useLocalDirectory(
  handle: BrowserDirectoryHandle,
): Promise<string> {
  const writePermission = await permission(handle, true);
  const nextFiles = new Map<string, Uint8Array>();
  const nextHandles = new Map<string, BrowserFileHandle>();
  const readOnlyPaths = new Set<string>();
  const skippedFiles = await collectDirectory(
    handle,
    "",
    nextFiles,
    nextHandles,
    readOnlyPaths,
  );
  nextFolderSelectionId += 1;
  const selection = `${LOCAL_FOLDER_VAULT}:${nextFolderSelectionId}`;
  folderSelections.set(selection, {
    files: nextFiles,
    directories: new Set(),
    fileHandles: nextHandles,
    readOnlyPaths,
    directoryHandle: handle,
    folderWrites: writePermission === "granted",
    skippedFiles,
  });
  return selection;
}

export async function selectLocalDirectory(): Promise<string | null> {
  if (typeof window === "undefined") {
    return null;
  }
  const demoWindow = window as DemoWindow;
  if (demoWindow.showDirectoryPicker === undefined) {
    return null;
  }
  try {
    return await useLocalDirectory(
      await demoWindow.showDirectoryPicker({ mode: "read" }),
    );
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    throw error;
  }
}

function vaultFor(handle: VaultHandle): DemoVault {
  const vault = vaults.get(handle.id);
  return vault ?? fail("vault/not-open", "The demo vault is not open.", null);
}

function assertRelativePath(path: string): void {
  const segments = path.split("/");
  if (
    path.length === 0 ||
    path.startsWith("/") ||
    path.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "..")
  ) {
    fail(
      "vault/invalid-path",
      "The requested path is not vault-relative.",
      path,
    );
  }
}

function cachedFileBytes(vault: DemoVault, path: string): Uint8Array {
  assertRelativePath(path);
  const bytes = vault.files.get(path);
  if (bytes === undefined) {
    return fail(
      "vault/path-not-found",
      "The requested demo file does not exist.",
      path,
    );
  }
  return bytes;
}

async function projectionHash(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function indexedTree(vault: DemoVault): TreeEntry[] {
  const entries = new Map<string, TreeEntry>();
  for (const directory of vault.directories) {
    entries.set(directory, {
      path: directory,
      kind: "directory",
      hidden: directory.split("/").at(-1)?.startsWith(".") === true,
    });
  }
  for (const path of vault.files.keys()) {
    const segments = path.split("/");
    if (segments.some((segment) => segment.startsWith("."))) {
      continue;
    }
    for (let index = 1; index < segments.length; index += 1) {
      const directory = segments.slice(0, index).join("/");
      entries.set(directory, {
        path: directory,
        kind: "directory",
        hidden: false,
      });
    }
    entries.set(path, {
      path,
      kind: isNotePath(path) ? "note" : "file",
      hidden: false,
    });
  }
  return [...entries.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

export async function openVaultResult(path: string): Promise<VaultOpenResult> {
  const vault = folderSelections.get(path) ?? seededVault();
  folderSelections.delete(path);
  activeVault = vault;
  if (vault.directoryHandle === null) {
    publishStatus({ source: "seeded" });
  } else {
    publishFolderStatus(vault);
  }
  nextVaultId += 1;
  vaults.set(nextVaultId, vault);
  return { handle: { id: nextVaultId }, root: path };
}

/** Compatibility adapter for callers that only retain a browser handle. */
export async function openVault(path: string): Promise<VaultHandle> {
  return (await openVaultResult(path)).handle;
}

/** Mirrors native idempotent teardown without altering browser vault data. */
export async function closeVault(handle: VaultHandle): Promise<void> {
  vaults.delete(handle.id);
}

export async function vaultTree(handle: VaultHandle): Promise<TreeEntry[]> {
  return indexedTree(vaultFor(handle));
}

export async function watchSubscribe(handle: VaultHandle): Promise<void> {
  vaultFor(handle);
}

export async function noteCreate(
  handle: VaultHandle,
  relPath: string,
): Promise<void> {
  const vault = vaultFor(handle);
  assertRelativePath(relPath);
  if (!isNotePath(relPath)) {
    return fail("note/not-markdown", STRINGS.demoNoteNotMarkdown, relPath);
  }
  if (vault.files.has(relPath)) {
    return fail("note/already-exists", STRINGS.demoNoteAlreadyExists, relPath);
  }
  vault.files.set(relPath, new Uint8Array());
}

export async function treeFolderCreate(
  handle: VaultHandle,
  relPath: string,
): Promise<TreeEntry[]> {
  const vault = vaultFor(handle);
  assertRelativePath(relPath);
  if (vault.directories.has(relPath) || vault.files.has(relPath)) {
    return fail(
      "entry/already-exists",
      "The demo entry already exists.",
      relPath,
    );
  }
  vault.directories.add(relPath);
  return indexedTree(vault);
}

export async function treeEntryMove(
  handle: VaultHandle,
  fromPath: string,
  toPath: string,
): Promise<TreeEntry[]> {
  const vault = vaultFor(handle);
  assertRelativePath(fromPath);
  assertRelativePath(toPath);
  if (vault.files.has(toPath) || vault.directories.has(toPath)) {
    return fail(
      "entry/already-exists",
      "The demo entry already exists.",
      toPath,
    );
  }
  const fileMoves = [...vault.files.entries()].filter(
    ([path]) => path === fromPath || path.startsWith(`${fromPath}/`),
  );
  const directoryMoves = [...vault.directories].filter(
    (path) => path === fromPath || path.startsWith(`${fromPath}/`),
  );
  if (fileMoves.length === 0 && directoryMoves.length === 0) {
    return fail("entry/not-found", "The demo entry does not exist.", fromPath);
  }
  for (const [path, bytes] of fileMoves) {
    vault.files.delete(path);
    vault.files.set(`${toPath}${path.slice(fromPath.length)}`, bytes);
  }
  for (const path of directoryMoves) {
    vault.directories.delete(path);
    vault.directories.add(`${toPath}${path.slice(fromPath.length)}`);
  }
  return indexedTree(vault);
}

export async function treeEntryDelete(
  handle: VaultHandle,
  relPath: string,
): Promise<TreeEntry[]> {
  const vault = vaultFor(handle);
  assertRelativePath(relPath);
  let removed =
    vault.files.delete(relPath) || vault.directories.delete(relPath);
  for (const path of [...vault.files.keys()]) {
    if (path.startsWith(`${relPath}/`)) {
      vault.files.delete(path);
      removed = true;
    }
  }
  for (const path of [...vault.directories]) {
    if (path.startsWith(`${relPath}/`)) {
      vault.directories.delete(path);
      removed = true;
    }
  }
  if (!removed) {
    return fail("entry/not-found", "The demo entry does not exist.", relPath);
  }
  return indexedTree(vault);
}

export async function treeEntryReveal(
  handle: VaultHandle,
  relPath: string,
): Promise<void> {
  const vault = vaultFor(handle);
  if (!vault.files.has(relPath) && !vault.directories.has(relPath)) {
    return fail("entry/not-found", "The demo entry does not exist.", relPath);
  }
}

export async function noteWrite(
  handle: VaultHandle,
  relPath: string,
  changeSet: ByteRangeReplace[],
  expectedProjectionHash: string,
): Promise<WriteResult> {
  const vault = vaultFor(handle);
  if (vault.readOnlyPaths.has(relPath)) {
    return fail(
      "note/non-utf8-read-only",
      "This note is not valid UTF-8 and cannot be edited in the browser demo.",
      relPath,
    );
  }
  const current = cachedFileBytes(vault, relPath);
  const currentProjectionHash = await projectionHash(current);
  if (currentProjectionHash !== expectedProjectionHash) {
    return {
      result: "conflict",
      current_projection_hash: currentProjectionHash,
      reconciliation: 1,
    };
  }

  let next: Uint8Array;
  try {
    next = applyByteChangeSet(
      current,
      changeSet.map((change) => ({
        start: change.start,
        end: change.end,
        bytes: Uint8Array.from(change.bytes),
      })),
    );
  } catch {
    return fail(
      "note/invalid-change-set",
      "The demo edit does not apply to the current note.",
      relPath,
    );
  }

  const localHandle = vault.fileHandles.get(relPath);
  if (
    vault.directoryHandle !== null &&
    localHandle !== undefined &&
    vault.folderWrites
  ) {
    vault.folderWrites =
      (await permission(vault.directoryHandle, false)) === "granted";
    if (vault.folderWrites && localHandle.createWritable !== undefined) {
      let diskBytes: Uint8Array;
      try {
        diskBytes = await fileBytes(localHandle);
      } catch {
        return fail(
          "note/browser-file-unavailable",
          "The browser can no longer read this note. The edit remains pending in memory.",
          relPath,
        );
      }
      const diskHash = await projectionHash(diskBytes);
      if (diskHash !== currentProjectionHash) {
        vault.files.set(relPath, diskBytes);
        return {
          result: "conflict",
          current_projection_hash: diskHash,
          reconciliation: 1,
        };
      }
      let writable: WritableFile;
      try {
        writable = await localHandle.createWritable();
      } catch {
        try {
          diskBytes = await fileBytes(localHandle);
        } catch {
          return fail(
            "note/browser-file-unavailable",
            "The browser can no longer read this note. The edit remains pending in memory.",
            relPath,
          );
        }
        const latestHash = await projectionHash(diskBytes);
        if (latestHash !== currentProjectionHash) {
          vault.files.set(relPath, diskBytes);
          return {
            result: "conflict",
            current_projection_hash: latestHash,
            reconciliation: 1,
          };
        }
        vault.folderWrites = false;
        publishFolderStatus(vault);
        vault.files.set(relPath, next);
        return {
          result: "written",
          projection_hash: await projectionHash(next),
        };
      }
      try {
        await writable.write(next);
        await writable.close();
      } catch {
        await abortWrite(writable);
        vault.folderWrites = false;
        publishFolderStatus(vault);
        return fail(
          "note/browser-write-uncertain",
          "The browser could not finish writing this note. The edit remains pending in memory.",
          relPath,
        );
      }
    } else {
      vault.folderWrites = false;
    }
    publishFolderStatus(vault);
  }

  vault.files.set(relPath, next);
  return {
    result: "written",
    projection_hash: await projectionHash(next),
  };
}

/** The demo intentionally keeps edit history in the current session only. */
export async function editHistoryRead(
  _handle: VaultHandle,
  _relPath: string,
): Promise<EditHistorySnapshot> {
  return { undo: [], redo: [] };
}

/** The demo has no stable vault identity across page reloads. */
export async function editHistoryAppend(
  _handle: VaultHandle,
  _relPath: string,
  _batch: string,
  _actions: EditHistoryAction[],
): Promise<void> {}

/** External-ingest fencing is inert because the demo has no watcher. */
export async function editHistoryFence(
  _handle: VaultHandle,
  _relPath: string,
  _batch: string,
): Promise<void> {}

/** No persistent demo history exists to clear. */
export async function editHistoryClear(
  _handle: VaultHandle,
  _relPath: string,
): Promise<void> {}

export async function readVaultConfigFile(
  handle: VaultHandle,
  name: string,
): Promise<string | null> {
  const vault = vaultFor(handle);
  if (name !== "app.json" && name !== "types.json") {
    return null;
  }
  const bytes = vault.files.get(`.obsidian/${name}`);
  if (bytes === undefined) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export async function readNote(
  handle: VaultHandle,
  relPath: string,
): Promise<LoadedNote> {
  const vault = vaultFor(handle);
  if (!isNotePath(relPath)) {
    return fail("note/not-markdown", STRINGS.demoNoteNotMarkdown, relPath);
  }
  const bytes = cachedFileBytes(vault, relPath).slice();
  await waitForTestGate(relPath);
  const hasBom =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  const readOnly = vault.readOnlyPaths.has(relPath);
  return {
    meta: {
      encoding: readOnly ? "non-utf8" : hasBom ? "utf8-bom" : "utf8",
      projection_hash: await projectionHash(bytes),
      byte_length: bytes.byteLength,
    },
    bytes,
    text: decoder.decode(hasBom ? bytes.subarray(3) : bytes),
    readOnly,
  };
}

export async function readVaultFile(
  handle: VaultHandle,
  relPath: string,
): Promise<Uint8Array> {
  await waitForTestGate(relPath);
  return cachedFileBytes(vaultFor(handle), relPath).slice();
}

/**
 * Overwrites an indexed non-note file's full contents. Mirrors `noteWrite`'s
 * best-effort local-folder write-through, but as a whole-document replace
 * with no projection-hash conflict check: the canvas board is the only
 * editable consumer and is not a multi-writer document.
 */
export async function writeVaultFile(
  handle: VaultHandle,
  relPath: string,
  bytes: Uint8Array,
): Promise<void> {
  const vault = vaultFor(handle);
  assertRelativePath(relPath);
  const next = bytes.slice();
  const localHandle = vault.fileHandles.get(relPath);
  if (
    vault.directoryHandle !== null &&
    localHandle !== undefined &&
    vault.folderWrites &&
    localHandle.createWritable !== undefined
  ) {
    try {
      const writable = await localHandle.createWritable();
      await writable.write(next);
      await writable.close();
    } catch {
      vault.folderWrites = false;
      publishFolderStatus(vault);
    }
  }
  vault.files.set(relPath, next);
}

/**
 * The seeded browser vault has no filesystem timestamps; the statusline
 * degrades to save-time tracking in the shell.
 */
export async function readNoteStat(
  handle: VaultHandle,
  relPath: string,
): Promise<NoteStat> {
  cachedFileBytes(vaultFor(handle), relPath);
  return { modified_ms: null, created_ms: null };
}
