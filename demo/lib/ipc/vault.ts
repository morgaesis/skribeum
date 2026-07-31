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

const DEMO_VAULT_ID = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const files = new Map<string, Uint8Array>(
  Object.entries(DEMO_FILES).map(([path, content]) => [
    path,
    encoder.encode(content),
  ]),
);

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

function assertHandle(handle: VaultHandle): void {
  if (handle.id !== DEMO_VAULT_ID) {
    fail("vault/not-open", "The demo vault is not open.", null);
  }
}

function fileBytes(path: string): Uint8Array {
  const bytes = files.get(path);
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

function indexedTree(): TreeEntry[] {
  const entries = new Map<string, TreeEntry>();
  for (const path of files.keys()) {
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

export async function openVault(_path: string): Promise<VaultHandle> {
  return { id: DEMO_VAULT_ID };
}

export async function vaultTree(handle: VaultHandle): Promise<TreeEntry[]> {
  assertHandle(handle);
  return indexedTree();
}

export async function watchSubscribe(handle: VaultHandle): Promise<void> {
  assertHandle(handle);
}

export async function noteWrite(
  handle: VaultHandle,
  relPath: string,
  changeSet: ByteRangeReplace[],
  expectedProjectionHash: string,
): Promise<WriteResult> {
  assertHandle(handle);
  const current = fileBytes(relPath);
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
  files.set(relPath, next);
  return {
    result: "written",
    projection_hash: await projectionHash(next),
  };
}

export async function readVaultConfigFile(
  handle: VaultHandle,
  name: string,
): Promise<string | null> {
  assertHandle(handle);
  if (name !== "app.json" && name !== "types.json") {
    return null;
  }
  const bytes = files.get(`.obsidian/${name}`);
  return bytes === undefined ? null : decoder.decode(bytes);
}

export async function readNote(
  handle: VaultHandle,
  relPath: string,
): Promise<LoadedNote> {
  assertHandle(handle);
  if (!relPath.toLowerCase().endsWith(".md")) {
    return fail(
      "note/not-markdown",
      "The requested demo file is not a note.",
      relPath,
    );
  }
  const bytes = fileBytes(relPath).slice();
  return {
    meta: {
      encoding: "utf8",
      projection_hash: await projectionHash(bytes),
      byte_length: bytes.byteLength,
    },
    bytes,
    text: decoder.decode(bytes),
    readOnly: false,
  };
}

export async function readVaultFile(
  handle: VaultHandle,
  relPath: string,
): Promise<Uint8Array> {
  assertHandle(handle);
  return fileBytes(relPath).slice();
}
