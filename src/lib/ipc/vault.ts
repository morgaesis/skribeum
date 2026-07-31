// Hand-written layer over the generated bindings. Note bytes travel as a
// single raw channel message (an ArrayBuffer), matching the Rust side's
// InvokeResponseBody::Raw send; the generated channel type says number[]
// because the specta signature borrows Channel<Vec<u8>>, so this wrapper
// accepts both shapes and reassembles a typed result.

import { Channel } from "@tauri-apps/api/core";
import {
  type AppError,
  type ByteRangeReplace,
  commands,
  type NoteContent,
  type TreeEntry,
  type VaultHandle,
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

function unwrap<T>(
  result: { status: "ok"; data: T } | { status: "error"; error: AppError },
): T {
  if (result.status === "error") {
    throw new IpcError(result.error);
  }
  return result.data;
}

export async function openVault(path: string): Promise<VaultHandle> {
  return unwrap(await commands.vaultOpen(path));
}

export async function vaultTree(handle: VaultHandle): Promise<TreeEntry[]> {
  return unwrap(await commands.vaultTree(handle));
}

export async function watchSubscribe(handle: VaultHandle): Promise<void> {
  unwrap(await commands.watchSubscribe(handle));
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
