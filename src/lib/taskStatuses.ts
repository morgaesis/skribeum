// Task status configuration shared by settings, markdown parsing, editor
// decorations and registry commands. The ordered list is the complete source
// of truth: symbols outside it remain ordinary markdown text.

import type {
  TaskStatusCategory,
  TaskStatusDoc,
  TaskStatusPayload,
  TaskStatusTrack,
} from "./ipc/bindings";
import { STRINGS } from "./strings";

export type TaskTrack = TaskStatusTrack;
export type TaskPayloadKind = TaskStatusPayload;
export type TaskStatus = Omit<TaskStatusDoc, "track" | "payload"> & {
  track?: TaskTrack | null;
  payload?: TaskPayloadKind | null;
};
export type { TaskStatusCategory };

export const TASK_TRACKS = [
  "task",
  "time",
  "importance",
  "reference",
] as const satisfies readonly TaskTrack[];
export const TASK_PAYLOAD_KINDS = [
  "date",
  "level",
] as const satisfies readonly TaskPayloadKind[];

const TODO_COLOR = "--skr-accent";
const IN_PROGRESS_COLOR = "--skr-warning";
const DONE_COLOR = "--skr-success";
const CANCELLED_COLOR = "--skr-danger";

export const TASK_COLOR_TOKENS = [
  "--skr-accent",
  "--skr-text-muted",
  "--skr-warning",
  "--skr-success",
  "--skr-danger",
  "--skr-callout-blue",
  "--skr-callout-cyan",
  "--skr-callout-green",
  "--skr-callout-yellow",
  "--skr-callout-orange",
  "--skr-callout-red",
  "--skr-callout-purple",
  "--skr-callout-gray",
] as const;
const TASK_COLOR_TOKEN_SET: ReadonlySet<string> = new Set(TASK_COLOR_TOKENS);

function status(
  symbol: string,
  category: TaskStatusCategory,
  glyph: string,
  color_token: string,
  next_status: string,
  track: TaskTrack,
  payload?: TaskPayloadKind,
): TaskStatusDoc {
  return {
    symbol,
    name:
      STRINGS.taskStatusDefaultNames[
        symbol as keyof typeof STRINGS.taskStatusDefaultNames
      ] ?? symbol,
    category,
    glyph,
    color_token,
    next_status,
    track,
    payload: payload ?? null,
  };
}

/** Default track vocabulary with the compact Todo, Doing, Done cycle. */
export const DEFAULT_TASK_STATUSES: readonly TaskStatusDoc[] = [
  // Todo, the default cycle's entry state, is the empty checkbox (design
  // system section 3.6): the checkbox box itself, drawn from
  // `--skr-border-strong` by `.cm-skr-task-checkbox`'s base style, with no
  // glyph layered inside it. A circled or filled default glyph is the
  // defect that section corrects.
  status(" ", "TODO", "", TODO_COLOR, "/", "task"),
  status("/", "IN_PROGRESS", "◐", IN_PROGRESS_COLOR, "x", "task"),
  status("x", "DONE", "✓", DONE_COLOR, " ", "task"),
  status("-", "CANCELLED", "✕", CANCELLED_COLOR, " ", "task"),
  status("X", "DONE", "✔", DONE_COLOR, " ", "task"),
  status("D", "TODO", "◷", TODO_COLOR, "x", "time", "date"),
  status("<", "TODO", "←", TODO_COLOR, "x", "time", "date"),
  status(">", "TODO", "→", TODO_COLOR, "x", "time", "date"),
  status("!", "TODO", "!", TODO_COLOR, "!", "importance", "level"),
  status("?", "TODO", "?", TODO_COLOR, "/", "reference"),
  status("+", "TODO", "+", TODO_COLOR, "/", "reference"),
  status("R", "TODO", "⌕", TODO_COLOR, "/", "reference"),
  status("i", "TODO", "◇", TODO_COLOR, "/", "reference"),
  status("B", "TODO", "◎", TODO_COLOR, "/", "reference"),
  status("P", "TODO", "+", TODO_COLOR, "/", "reference"),
  status("C", "TODO", "−", TODO_COLOR, "/", "reference"),
  status("Q", "TODO", "❝", TODO_COLOR, "/", "reference"),
  status("N", "TODO", "▤", TODO_COLOR, "/", "reference"),
  status("b", "TODO", "◆", TODO_COLOR, "/", "reference"),
  status("I", "TODO", "ⓘ", TODO_COLOR, "/", "reference"),
  status("p", "TODO", "¶", TODO_COLOR, "/", "reference"),
  status("L", "TODO", "⌖", TODO_COLOR, "/", "reference"),
  status("E", "TODO", "◇", TODO_COLOR, "/", "reference"),
  status("A", "TODO", "↳", TODO_COLOR, "/", "reference"),
  status("r", "TODO", "★", TODO_COLOR, "/", "reference"),
  status("c", "TODO", "◆", TODO_COLOR, "/", "reference"),
  status("d", "IN_PROGRESS", "◒", IN_PROGRESS_COLOR, "x", "reference"),
  status("T", "TODO", "◷", TODO_COLOR, "/", "reference"),
  status("@", "TODO", "@", TODO_COLOR, "/", "reference"),
  status("t", "TODO", "◖", TODO_COLOR, "/", "reference"),
  status("O", "TODO", "☰", TODO_COLOR, "/", "reference"),
  status("~", "TODO", "≈", TODO_COLOR, "/", "reference"),
  status("W", "TODO", "◉", TODO_COLOR, "/", "reference"),
  status("f", "TODO", "?", TODO_COLOR, "/", "reference"),
  status("F", "TODO", "⋙", TODO_COLOR, "/", "reference"),
  status("H", "TODO", "♥", TODO_COLOR, "/", "reference"),
  status("&", "TODO", "§", TODO_COLOR, "/", "reference"),
  status("s", "TODO", "◆", TODO_COLOR, "/", "reference"),
];

const CATEGORIES: ReadonlySet<string> = new Set<TaskStatusCategory>([
  "TODO",
  "IN_PROGRESS",
  "ON_HOLD",
  "DONE",
  "CANCELLED",
  "NON_TASK",
]);
const TRACK_SET: ReadonlySet<string> = new Set(TASK_TRACKS);
const PAYLOAD_SET: ReadonlySet<string> = new Set(TASK_PAYLOAD_KINDS);
const MAX_STATUS_COUNT = 128;
const MAX_NAME_LENGTH = 80;
const MAX_GLYPH_LENGTH = 8;

function oneSourceCharacter(value: string): boolean {
  return (
    [...value].length === 1 &&
    value !== "[" &&
    value !== "]" &&
    (value === " " || !/[\p{Cc}]/u.test(value))
  );
}

function validStatus(value: unknown): value is TaskStatus {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof TaskStatus, unknown>>;
  return (
    typeof candidate.symbol === "string" &&
    oneSourceCharacter(candidate.symbol) &&
    typeof candidate.name === "string" &&
    (candidate.name.trim().length > 0 ||
      (candidate.name.length === 0 &&
        candidate.symbol in STRINGS.taskStatusDefaultNames)) &&
    [...candidate.name].length <= MAX_NAME_LENGTH &&
    typeof candidate.category === "string" &&
    CATEGORIES.has(candidate.category) &&
    typeof candidate.glyph === "string" &&
    // Empty is valid: it is how the default Todo state asks the checkbox
    // to render as its bare box, with no glyph layered inside it.
    [...candidate.glyph].length <= MAX_GLYPH_LENGTH &&
    !/[\p{Cc}]/u.test(candidate.glyph) &&
    typeof candidate.color_token === "string" &&
    TASK_COLOR_TOKEN_SET.has(candidate.color_token) &&
    typeof candidate.next_status === "string" &&
    oneSourceCharacter(candidate.next_status) &&
    (candidate.track === undefined ||
      candidate.track === null ||
      (typeof candidate.track === "string" &&
        TRACK_SET.has(candidate.track))) &&
    (candidate.payload === undefined ||
      candidate.payload === null ||
      (typeof candidate.payload === "string" &&
        PAYLOAD_SET.has(candidate.payload)))
  );
}

export function defaultTaskStatuses(): TaskStatusDoc[] {
  return DEFAULT_TASK_STATUSES.map((entry) => ({ ...entry }));
}

export function taskStatusDocument(status: TaskStatus): TaskStatusDoc {
  return {
    ...status,
    track: status.track ?? null,
    payload: status.payload ?? null,
  };
}

export function defaultTaskStatusDocuments(): TaskStatusDoc[] {
  return DEFAULT_TASK_STATUSES.map((entry) =>
    taskStatusDocument({ ...entry, name: "" }),
  );
}

/** Validates persisted status data without replacing stable default names. */
export function validateTaskStatusDocuments(value: unknown): TaskStatusDoc[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_STATUS_COUNT ||
    !value.every(validStatus)
  ) {
    return defaultTaskStatusDocuments();
  }
  const statuses = value.map((entry) => taskStatusDocument({ ...entry }));
  const symbols = new Set(statuses.map((entry) => entry.symbol));
  if (
    symbols.size !== statuses.length ||
    statuses.some((entry) => !symbols.has(entry.next_status))
  ) {
    return defaultTaskStatusDocuments();
  }
  return statuses;
}

/**
 * Validates an untrusted status list as one graph. A malformed entry,
 * duplicate symbol or dangling transition falls back to the complete default
 * list, so parsing and rendering always agree.
 */
export function normalizeTaskStatuses(value: unknown): TaskStatusDoc[] {
  const statuses = validateTaskStatusDocuments(value).map((entry) => {
    const localizedName =
      entry.name.length === 0
        ? (STRINGS.taskStatusDefaultNames[
            entry.symbol as keyof typeof STRINGS.taskStatusDefaultNames
          ] ?? entry.symbol)
        : entry.name;
    const payload = taskStatusPayload(entry);
    return taskStatusDocument({
      ...entry,
      name: localizedName,
      track: taskStatusTrack(entry),
      payload: payload ?? null,
    });
  });
  const symbols = new Set(statuses.map((entry) => entry.symbol));
  if (
    symbols.size !== statuses.length ||
    statuses.some((entry) => !symbols.has(entry.next_status))
  ) {
    return defaultTaskStatuses();
  }
  return statuses;
}

export function taskStatusDisplayName(status: TaskStatus): string {
  return status.name.length === 0
    ? (STRINGS.taskStatusDefaultNames[
        status.symbol as keyof typeof STRINGS.taskStatusDefaultNames
      ] ?? status.symbol)
    : status.name;
}

export function taskStatusBySymbol(
  statuses: readonly TaskStatus[],
  symbol: string,
): TaskStatus | undefined {
  return statuses.find((entry) => entry.symbol === symbol);
}

/** Effective track for a configured status, including legacy documents. */
export function taskStatusTrack(status: TaskStatus): TaskTrack {
  if (status.track !== undefined && status.track !== null) {
    return status.track;
  }
  if ([" ", "/", "x", "-", "X"].includes(status.symbol)) {
    return "task";
  }
  if (["D", "<", ">"].includes(status.symbol)) {
    return "time";
  }
  return status.symbol === "!" ? "importance" : "reference";
}

/** Effective payload kind for a configured status, including legacy rows. */
export function taskStatusPayload(
  status: TaskStatus,
): TaskPayloadKind | undefined {
  if (status.payload !== undefined && status.payload !== null) {
    return status.payload;
  }
  if (["D", "<", ">"].includes(status.symbol)) {
    return "date";
  }
  return status.symbol === "!" ? "level" : undefined;
}

export function taskTrackLabel(track: TaskTrack): string {
  switch (track) {
    case "task":
      return STRINGS.taskTrackTask;
    case "time":
      return STRINGS.taskTrackTime;
    case "importance":
      return STRINGS.taskTrackImportance;
    case "reference":
      return STRINGS.taskTrackReference;
  }
}

/** Entry marker inherited by a new sibling task line. */
export function taskTrackEntrySymbol(
  status: TaskStatus,
  statuses: readonly TaskStatus[],
): string {
  const track = taskStatusTrack(status);
  if (track === "reference") {
    return status.symbol;
  }
  const preferred = track === "task" ? " " : track === "time" ? "D" : "!";
  return (
    (
      statuses.find(
        (candidate) =>
          candidate.symbol === preferred &&
          taskStatusTrack(candidate) === track,
      ) ?? statuses.find((candidate) => taskStatusTrack(candidate) === track)
    )?.symbol ?? status.symbol
  );
}

/** Marker written by direct activation of a configured status. */
export function taskStatusAdvanceSymbol(
  status: TaskStatus,
  statuses: readonly TaskStatus[],
): string {
  const track = taskStatusTrack(status);
  if (track === "importance") {
    return status.symbol;
  }
  if (track === "time") {
    return statuses.some((candidate) => candidate.symbol === "x")
      ? "x"
      : status.next_status;
  }
  return status.next_status;
}

export function taskStatusCommandId(symbol: string): string {
  return `task.status.u${[...symbol]
    .map((character) => character.codePointAt(0)?.toString(16) ?? "0")
    .join("-")}`;
}
