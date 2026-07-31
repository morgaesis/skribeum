// Byte-to-buffer line-ending mapping on the editor side. CodeMirror
// normalizes line separators, so a mixed-ending file cannot be represented
// in the buffer natively. The Rust implementation in
// `crates/skribeum-core/src/line_endings.rs` owns the semantics of
// terminator re-emission; this module is its TypeScript mirror, needed
// because buffer edits originate in the webview and must reach `note_write`
// already converted into the byte space of the current on-disk projection.
// The web test suite replicates the Rust unit cases one for one, so a
// semantic drift between the two implementations fails the build.
//
// The map records each line's original terminator at open time; converting
// buffer-space edits re-emits untouched lines' terminators unchanged (their
// bytes never enter any replaced range), and only lines an edit actually
// touched may carry a new terminator.

import type { ByteChange } from "./byteChangeSet";

/** A line's original terminator as found in the on-disk bytes. */
export type Terminator = "lf" | "crlf" | "cr" | "none";

const TERMINATOR_BYTES: Record<Terminator, readonly number[]> = {
  lf: [0x0a],
  crlf: [0x0d, 0x0a],
  cr: [0x0d],
  none: [],
};

/** Byte length of a terminator on disk. */
function terminatorByteLength(terminator: Terminator): number {
  return TERMINATOR_BYTES[terminator].length;
}

/**
 * Length in the buffer projection, where every terminator is a single
 * `\n` and a missing terminator contributes nothing.
 */
function terminatorBufferLength(terminator: Terminator): number {
  return terminator === "none" ? 0 : 1;
}

/**
 * One recorded line: where its content starts in the original bytes, how
 * long the content is, and which terminator followed it.
 */
type Line = {
  byteStart: number;
  contentLength: number;
  terminator: Terminator;
};

/**
 * The per-line terminator record taken at open time. All offsets are byte
 * offsets: original-byte offsets on the disk side and buffer-byte offsets
 * (UTF-8, `\n`-separated) on the buffer side.
 */
export type LineEndingMap = {
  lines: readonly Line[];
  byteLength: number;
  bufferLength: number;
};

/**
 * One buffer-space edit: replace buffer bytes `start..end` with `insert`,
 * where `insert` uses `\n` separators (the only separator a normalized
 * buffer can contain).
 */
export type BufferEdit = {
  /** Inclusive start buffer-byte offset. */
  start: number;
  /** Exclusive end buffer-byte offset. */
  end: number;
  /** Replacement buffer bytes, `\n`-separated. */
  insert: Uint8Array;
};

/** Records each line's terminator from the exact on-disk bytes. */
export function buildLineEndingMap(bytes: Uint8Array): LineEndingMap {
  const lines: Line[] = [];
  let bufferLength = 0;
  let start = 0;
  let index = 0;
  while (index < bytes.length) {
    let terminator: Terminator | null = null;
    if (bytes[index] === 0x0a) {
      terminator = "lf";
    } else if (bytes[index] === 0x0d) {
      terminator = bytes[index + 1] === 0x0a ? "crlf" : "cr";
    }
    if (terminator !== null) {
      const contentLength = index - start;
      lines.push({ byteStart: start, contentLength, terminator });
      bufferLength += contentLength + terminatorBufferLength(terminator);
      start = index + terminatorByteLength(terminator);
      index = start;
    } else {
      index += 1;
    }
  }
  if (start < bytes.length) {
    const contentLength = bytes.length - start;
    lines.push({ byteStart: start, contentLength, terminator: "none" });
    bufferLength += contentLength;
  }
  return { lines, byteLength: bytes.length, bufferLength };
}

/**
 * The terminator style most frequent in the file, used for line breaks
 * created inside an edit. Ties resolve in the order LF, CRLF, CR; a file
 * with no terminator at all defaults to LF.
 */
export function dominantTerminator(map: LineEndingMap): Terminator {
  let lf = 0;
  let crlf = 0;
  let cr = 0;
  for (const line of map.lines) {
    if (line.terminator === "lf") {
      lf += 1;
    } else if (line.terminator === "crlf") {
      crlf += 1;
    } else if (line.terminator === "cr") {
      cr += 1;
    }
  }
  const best = Math.max(lf, crlf, cr);
  if (best === 0 || lf === best) {
    return "lf";
  }
  return crlf === best ? "crlf" : "cr";
}

/**
 * Converts a buffer-byte offset into an original-byte offset. Offsets on a
 * line map within that line's content; the offset just past a line's
 * content maps to the start of its terminator bytes.
 */
function bufferOffsetToByte(map: LineEndingMap, offset: number): number {
  let bufferPosition = 0;
  for (const line of map.lines) {
    const contentEnd = bufferPosition + line.contentLength;
    if (offset <= contentEnd) {
      return line.byteStart + (offset - bufferPosition);
    }
    bufferPosition = contentEnd + terminatorBufferLength(line.terminator);
  }
  return map.byteLength;
}

/**
 * The terminator of the line whose buffer range contains `offset`, falling
 * back through the dominant terminator to LF. Used to pick the style for
 * line breaks the edit itself creates.
 */
function terminatorAtBufferOffset(
  map: LineEndingMap,
  offset: number,
): Terminator {
  let bufferPosition = 0;
  for (const line of map.lines) {
    const lineEnd =
      bufferPosition +
      line.contentLength +
      terminatorBufferLength(line.terminator);
    if (offset < lineEnd || lineEnd === map.bufferLength) {
      return line.terminator === "none"
        ? dominantTerminator(map)
        : line.terminator;
    }
    bufferPosition = lineEnd;
  }
  return dominantTerminator(map);
}

/** Whether a lone-CR terminator occupies exactly the byte before `byteOffset`. */
function crTerminatorEndsAt(map: LineEndingMap, byteOffset: number): boolean {
  return map.lines.some(
    (line) =>
      line.terminator === "cr" &&
      line.byteStart + line.contentLength + 1 === byteOffset,
  );
}

/** Whether a lone-LF terminator starts exactly at `byteOffset`. */
function lfTerminatorStartsAt(map: LineEndingMap, byteOffset: number): boolean {
  return map.lines.some(
    (line) =>
      line.terminator === "lf" &&
      line.byteStart + line.contentLength === byteOffset,
  );
}

/**
 * Converts buffer-space edits into a byte-space change set against the
 * original bytes. Untouched lines keep their original terminators because
 * their terminator bytes never enter any replaced range; line breaks
 * inside an edit's inserted text are emitted in the style of the first
 * line the edit touches. Throws when edits are out of bounds, inverted,
 * overlapping or unsorted, matching the Rust validation.
 */
export function bufferEditsToChangeSet(
  map: LineEndingMap,
  edits: readonly BufferEdit[],
): ByteChange[] {
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start > edit.end) {
      throw new Error("buffer edit start exceeds end");
    }
    if (edit.end > map.bufferLength) {
      throw new Error("buffer edit exceeds the buffer length");
    }
    if (edit.start < cursor) {
      throw new Error("buffer edits overlap or are unsorted");
    }
    cursor = edit.end;
  }

  const changes: ByteChange[] = [];
  for (const edit of edits) {
    const start = bufferOffsetToByte(map, edit.start);
    const end = bufferOffsetToByte(map, edit.end);
    const style = TERMINATOR_BYTES[terminatorAtBufferOffset(map, edit.start)];
    const bytes: number[] = [];
    for (const byte of edit.insert) {
      if (byte === 0x0a) {
        bytes.push(...style);
      } else {
        bytes.push(byte);
      }
    }
    // A CR immediately followed by an LF reads back as one CRLF, so a
    // replacement boundary must never create that adjacency: it would
    // silently merge two line breaks into one. Both repairs restyle only a
    // break the edit itself touches. The trailing repair runs first so a
    // boundary hit on both sides is repaired once, not twice.
    if (bytes[bytes.length - 1] === 0x0d && lfTerminatorStartsAt(map, end)) {
      bytes.push(0x0a);
    }
    const firstEffective =
      bytes.length > 0
        ? bytes[0]
        : lfTerminatorStartsAt(map, end)
          ? 0x0a
          : null;
    if (crTerminatorEndsAt(map, start) && firstEffective === 0x0a) {
      bytes.unshift(0x0d);
    }
    changes.push({ start, end, bytes: Uint8Array.from(bytes) });
  }
  return changes;
}

/**
 * The buffer projection of on-disk bytes: every terminator (`\n`, `\r\n`,
 * lone `\r`) becomes a single `\n`, and content bytes pass through
 * untouched. This is the byte string whose offsets the buffer side of the
 * mapping uses.
 */
export function bufferFromBytes(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let index = 0;
  while (index < bytes.length) {
    if (bytes[index] === 0x0d) {
      out.push(0x0a);
      index += bytes[index + 1] === 0x0a ? 2 : 1;
    } else {
      out.push(bytes[index] as number);
      index += 1;
    }
  }
  return Uint8Array.from(out);
}
