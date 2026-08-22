// Note statistics: the word, character, and caret facts the statusline
// segments consume, the last-edited time formatting of section 4.16, and
// the registered commands that keep the same facts and the add-property
// affordance reachable on every viewport.

import type { CommandRegistry } from "../registry";
import { formatString, STRINGS } from "../strings";

/** Live editor facts consumed by the statusline and note-info surfaces. */
export type EditorStatistics = {
  /** Word count of the whole document. */
  words: number;
  /** Character count of the whole document, in Unicode code points. */
  characters: number;
  /** Word count of the primary selection; zero when the selection is empty. */
  selectionWords: number;
  /** One-based caret line. */
  line: number;
  /** One-based caret column within its line, in Unicode code points. */
  column: number;
};

/**
 * The statusline persistence slot's state: silent while saved, "Saving…"
 * past the write grace, a persisting failure until a write succeeds.
 */
export type PersistenceState =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "failed"; message: string };

/** Counts whitespace-delimited words. */
export function countWords(text: string): number {
  let words = 0;
  let inWord = false;
  for (const character of text) {
    const whitespace = /\s/.test(character);
    if (!whitespace && !inWord) {
      words += 1;
    }
    inWord = !whitespace;
  }
  return words;
}

/** Counts Unicode code points. */
export function countCharacters(text: string): number {
  let characters = 0;
  for (const _ of text) {
    characters += 1;
  }
  return characters;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RELATIVE_WINDOW_MS = 7 * DAY_MS;

const relativeFormat = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const absoluteDateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
});
const timestampFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "short",
});

/**
 * Formats the statusline's last-edited segment: relative at minute
 * granularity within seven days, the absolute date past that.
 */
export function formatLastEdited(modifiedMs: number, nowMs: number): string {
  const age = nowMs - modifiedMs;
  if (age < MINUTE_MS) {
    return STRINGS.statuslineEditedJustNow;
  }
  if (age >= RELATIVE_WINDOW_MS) {
    return formatString(STRINGS.statuslineEdited, {
      time: absoluteDateFormat.format(modifiedMs),
    });
  }
  const time =
    age < HOUR_MS
      ? relativeFormat.format(-Math.floor(age / MINUTE_MS), "minute")
      : age < DAY_MS
        ? relativeFormat.format(-Math.floor(age / HOUR_MS), "hour")
        : relativeFormat.format(-Math.floor(age / DAY_MS), "day");
  return formatString(STRINGS.statuslineEdited, { time });
}

/**
 * The bare relative-edited text for the empty pane's Recent list (design
 * spec section 12.5): the statusline's own formatter, thresholds and
 * seven-day window, without the "Edited " wrapper, capitalized so it reads
 * as a standalone label ("Yesterday", not "yesterday").
 */
export function formatRelativeTimeBare(
  modifiedMs: number,
  nowMs: number,
): string {
  const age = nowMs - modifiedMs;
  if (age < MINUTE_MS) {
    return STRINGS.recentEditedJustNow;
  }
  if (age >= RELATIVE_WINDOW_MS) {
    return absoluteDateFormat.format(modifiedMs);
  }
  const time =
    age < HOUR_MS
      ? relativeFormat.format(-Math.floor(age / MINUTE_MS), "minute")
      : age < DAY_MS
        ? relativeFormat.format(-Math.floor(age / HOUR_MS), "hour")
        : relativeFormat.format(-Math.floor(age / DAY_MS), "day");
  return time.charAt(0).toUpperCase() + time.slice(1);
}

/** Formats an absolute timestamp for the note-info popover. */
export function formatTimestamp(ms: number): string {
  return timestampFormat.format(ms);
}

/** Formats the word-count segment, folding in a non-empty selection. */
export function formatWordCount(words: number, selectionWords: number): string {
  if (selectionWords > 0) {
    return formatString(STRINGS.statuslineSelectionWordCount, {
      selected: selectionWords.toLocaleString("en"),
      total: words.toLocaleString("en"),
    });
  }
  if (words === 1) {
    return STRINGS.statuslineWordCountOne;
  }
  return formatString(STRINGS.statuslineWordCount, {
    count: words.toLocaleString("en"),
  });
}

/** Formats the source-mode line and column segment. */
export function formatLineColumn(line: number, column: number): string {
  return formatString(STRINGS.statuslineLineColumn, { line, column });
}

export const NOTE_STATISTICS_COMMAND = "note.statistics";
export const ADD_PROPERTY_COMMAND = "note.add-property";

/** Registers the note-statistics and add-property commands. */
export function registerNoteStatistics(registry: CommandRegistry): void {
  registry.register({
    id: NOTE_STATISTICS_COMMAND,
    title: STRINGS.commandNoteStatistics,
    pointer: ["command-palette"],
    run: (context) => {
      if (context.openNoteStatistics === undefined) return false;
      context.openNoteStatistics();
      return true;
    },
  });
  registry.register({
    id: ADD_PROPERTY_COMMAND,
    title: STRINGS.commandAddProperty,
    pointer: ["command-palette"],
    run: (context) => {
      if (context.addProperty === undefined) return false;
      context.addProperty();
      return true;
    },
  });
}
