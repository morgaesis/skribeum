import { applyByteChangeSet } from "../../../src/lib/editor/byteChangeSet";
import { DEMO_FILES } from "../vault/seed";
import type {
  AppError,
  ByteRangeReplace,
  NoteContent,
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
};

const LOCAL_FOLDER_VAULT = "skribeum-local-folder";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function seededFiles(): Map<string, Uint8Array> {
  return new Map(
    Object.entries(DEMO_FILES).map(([path, content]) => [
      path,
      encoder.encode(content),
    ]),
  );
}

type DemoVault = {
  files: Map<string, Uint8Array>;
  fileHandles: Map<string, BrowserFileHandle>;
  readOnlyPaths: Set<string>;
  directoryHandle: BrowserDirectoryHandle | null;
  folderWrites: boolean;
  skippedFiles: number;
};

function seededVault(): DemoVault {
  return {
    files: seededFiles(),
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
    const markdown = path.toLocaleLowerCase().endsWith(".md");
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
      kind: path.toLowerCase().endsWith(".md") ? "note" : "file",
      hidden: false,
    });
  }
  return [...entries.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

export async function openVault(path: string): Promise<VaultHandle> {
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
  return { id: nextVaultId };
}

export async function vaultTree(handle: VaultHandle): Promise<TreeEntry[]> {
  return indexedTree(vaultFor(handle));
}

export async function watchSubscribe(handle: VaultHandle): Promise<void> {
  vaultFor(handle);
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
  if (!relPath.toLowerCase().endsWith(".md")) {
    return fail(
      "note/not-markdown",
      "The requested demo file is not a note.",
      relPath,
    );
  }
  const bytes = cachedFileBytes(vault, relPath).slice();
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
  return cachedFileBytes(vaultFor(handle), relPath).slice();
}
