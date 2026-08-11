// Hand-written layer over the generated bindings. Note bytes travel as a
// single raw channel message (an ArrayBuffer), matching the Rust side's
// InvokeResponseBody::Raw send; the generated channel type says number[]
// because the specta signature borrows Channel<Vec<u8>>, so this wrapper
// accepts both shapes and reassembles a typed result.

import { Channel } from "@tauri-apps/api/core";
import type {
  EditHistoryAction as EditorHistoryAction,
  EditHistorySnapshot as EditorHistorySnapshot,
} from "../editor/durableHistory";
import {
  type AppError,
  type ByteRangeReplace,
  commands,
  type EditHistoryAction,
  type NoteContent,
  type NoteStat,
  type TreeEntry,
  type VaultHandle,
  type VaultOpenResult,
  type WriteResult,
} from "./bindings";

export type LoadedNote = {
  meta: NoteContent;
  bytes: Uint8Array;
  /** Decoded text for display: BOM stripped, unmappable bytes replaced. */
  text: string;
  /** True when the note must never be written (non-UTF-8). */
  readOnly: boolean;
  /**
   * A crash-journal delta recovered for this note before it was opened:
   * applying it to `bytes` reproduces the pre-crash buffer. The editor
   * applies it as pending (unsaved) edits when the note opens.
   */
  recoveredChangeSet?: ByteRangeReplace[];
};

export class IpcError extends Error {
  readonly app: AppError;
  constructor(app: AppError) {
    super(`${app.code}: ${app.message}`);
    this.app = app;
  }
}

/** Reads one note's durable undo and redo stacks. */
export async function editHistoryRead(
  handle: VaultHandle,
  relPath: string,
): Promise<EditorHistorySnapshot> {
  return unwrap(await commands.editHistoryRead(handle, relPath));
}

/** Appends and fsyncs a history batch before its note save begins. */
export async function editHistoryAppend(
  handle: VaultHandle,
  relPath: string,
  batch: string,
  actions: EditorHistoryAction[],
): Promise<void> {
  unwrap(
    await commands.editHistoryAppend(
      handle,
      relPath,
      batch,
      actions as EditHistoryAction[],
    ),
  );
}

/** Makes every older history entry unreachable after an external ingest. */
export async function editHistoryFence(
  handle: VaultHandle,
  relPath: string,
  batch: string,
): Promise<void> {
  unwrap(await commands.editHistoryFence(handle, relPath, batch));
}

/** Physically removes one note's durable edit history. */
export async function editHistoryClear(
  handle: VaultHandle,
  relPath: string,
): Promise<void> {
  unwrap(await commands.editHistoryClear(handle, relPath));
}

/** Unwraps a generated-binding result, normalizing errors to `IpcError`. */
export function unwrap<T>(
  result: { status: "ok"; data: T } | { status: "error"; error: AppError },
): T {
  if (result.status === "error") {
    throw new IpcError(result.error);
  }
  return result.data;
}

/** Opens a vault and returns its canonical native identity. */
export async function openVaultResult(path: string): Promise<VaultOpenResult> {
  return unwrap(await commands.vaultOpen(path));
}

/** Compatibility adapter for existing handle-scoped desktop calls. */
export async function openVault(path: string): Promise<VaultHandle> {
  return (await openVaultResult(path)).handle;
}

/** Releases a native vault handle; repeated cleanup is harmless. */
export async function closeVault(handle: VaultHandle): Promise<void> {
  unwrap(await commands.vaultClose(handle));
}

export async function vaultTree(handle: VaultHandle): Promise<TreeEntry[]> {
  return unwrap(await commands.vaultTree(handle));
}

export async function watchSubscribe(handle: VaultHandle): Promise<void> {
  unwrap(await commands.watchSubscribe(handle));
}

/** Creates an empty Markdown note without overwriting an existing path. */
export async function noteCreate(
  handle: VaultHandle,
  relPath: string,
): Promise<void> {
  unwrap(await commands.noteCreate(handle, relPath));
}

/**
 * Writes a note through the change-set path: byte-range replacements
 * against the last-read projection, verified against the expected
 * projection hash. The conflict variant returns as a value, never as an
 * exception; the caller owns the reconciliation flow.
 */
export async function noteWrite(
  handle: VaultHandle,
  relPath: string,
  changeSet: ByteRangeReplace[],
  expectedProjectionHash: string,
): Promise<WriteResult> {
  return unwrap(
    await commands.noteWrite(
      handle,
      relPath,
      changeSet,
      expectedProjectionHash,
    ),
  );
}

/**
 * Reads a recognized Obsidian configuration file (`app.json`,
 * `types.json`) through `vault_config_read`, the one sanctioned read
 * path into the otherwise excluded `.obsidian` directory. Returns null
 * when the file is absent or unreadable; configuration is optional and
 * its absence is never an error, so every consumer degrades to defaults.
 */
export async function readVaultConfigFile(
  handle: VaultHandle,
  name: string,
): Promise<string | null> {
  try {
    return unwrap(await commands.vaultConfigRead(handle, name));
  } catch {
    return null;
  }
}

export async function readNote(
  handle: VaultHandle,
  relPath: string,
): Promise<LoadedNote> {
  const channel = new Channel<number[]>();
  const firstMessage = new Promise<Uint8Array>((resolve) => {
    channel.onmessage = (payload) => {
      // Raw sends arrive as ArrayBuffer despite the generated number[] type.
      if (payload instanceof ArrayBuffer) {
        resolve(new Uint8Array(payload));
      } else if (ArrayBuffer.isView(payload)) {
        resolve(
          new Uint8Array(
            payload.buffer,
            payload.byteOffset,
            payload.byteLength,
          ),
        );
      } else {
        resolve(Uint8Array.from(payload));
      }
    };
  });

  const meta = unwrap(await commands.noteRead(handle, relPath, channel));
  const bytes = await firstMessage;

  const displayBytes = meta.encoding === "utf8-bom" ? bytes.subarray(3) : bytes;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(displayBytes);
  return {
    meta,
    bytes,
    text,
    readOnly: meta.encoding === "non-utf8",
  };
}

/** Reads one indexed note's filesystem creation and modification times. */
export async function readNoteStat(
  handle: VaultHandle,
  relPath: string,
): Promise<NoteStat> {
  return unwrap(await commands.noteStat(handle, relPath));
}

/**
 * Overwrites an indexed non-note file's full contents. The canvas board is
 * the only editable consumer today: a card move, add, or remove sends the
 * whole rewritten document here rather than a change-set, so there is no
 * projection-hash conflict check the way note writes have.
 */
export async function writeVaultFile(
  handle: VaultHandle,
  relPath: string,
  bytes: Uint8Array,
): Promise<void> {
  unwrap(await commands.vaultFileWrite(handle, relPath, Array.from(bytes)));
}

/** Reads an indexed regular file without opening an editable note session. */
export async function readVaultFile(
  handle: VaultHandle,
  relPath: string,
): Promise<Uint8Array> {
  const channel = new Channel<number[]>();
  const firstMessage = new Promise<Uint8Array>((resolve) => {
    channel.onmessage = (payload) => {
      if (payload instanceof ArrayBuffer) {
        resolve(new Uint8Array(payload));
      } else if (ArrayBuffer.isView(payload)) {
        resolve(
          new Uint8Array(
            payload.buffer,
            payload.byteOffset,
            payload.byteLength,
          ),
        );
      } else {
        resolve(Uint8Array.from(payload));
      }
    };
  });
  unwrap(await commands.vaultFileRead(handle, relPath, channel));
  return firstMessage;
}
