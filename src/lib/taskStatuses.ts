// Task status configuration shared by settings, markdown parsing, editor
// decorations and registry commands. The ordered list is the complete source
// of truth: symbols outside it remain ordinary markdown text.

import type { TaskStatusCategory, TaskStatusDoc } from "./ipc/bindings";
import { STRINGS } from "./strings";

export type TaskStatus = TaskStatusDoc;
export type { TaskStatusCategory };

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
): TaskStatus {
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
  };
}

/** SlRvb's alternate checkbox vocabulary with a compact default cycle. */
export const DEFAULT_TASK_STATUSES: readonly TaskStatus[] = [
  status(" ", "TODO", "○", TODO_COLOR, "/"),
  status("x", "DONE", "✓", DONE_COLOR, " "),
  status("X", "DONE", "✔", DONE_COLOR, " "),
  status("-", "CANCELLED", "✕", CANCELLED_COLOR, " "),
  status(">", "TODO", "→", TODO_COLOR, "/"),
  status("<", "TODO", "←", TODO_COLOR, "/"),
  status("D", "TODO", "◷", TODO_COLOR, "/"),
  status("?", "TODO", "?", TODO_COLOR, "/"),
  status("/", "IN_PROGRESS", "◐", IN_PROGRESS_COLOR, "x"),
  status("+", "TODO", "+", TODO_COLOR, "/"),
  status("R", "TODO", "⌕", TODO_COLOR, "/"),
  status("!", "TODO", "!", TODO_COLOR, "/"),
  status("i", "TODO", "◇", TODO_COLOR, "/"),
  status("B", "TODO", "◎", TODO_COLOR, "/"),
  status("P", "TODO", "+", TODO_COLOR, "/"),
  status("C", "TODO", "−", TODO_COLOR, "/"),
  status("Q", "TODO", "❝", TODO_COLOR, "/"),
  status("N", "TODO", "▤", TODO_COLOR, "/"),
  status("b", "TODO", "◆", TODO_COLOR, "/"),
  status("I", "TODO", "ⓘ", TODO_COLOR, "/"),
  status("p", "TODO", "¶", TODO_COLOR, "/"),
  status("L", "TODO", "⌖", TODO_COLOR, "/"),
  status("E", "TODO", "◇", TODO_COLOR, "/"),
  status("A", "TODO", "↳", TODO_COLOR, "/"),
  status("r", "TODO", "★", TODO_COLOR, "/"),
  status("c", "TODO", "◆", TODO_COLOR, "/"),
  status("d", "IN_PROGRESS", "◒", IN_PROGRESS_COLOR, "x"),
  status("T", "TODO", "◷", TODO_COLOR, "/"),
  status("@", "TODO", "@", TODO_COLOR, "/"),
  status("t", "TODO", "◖", TODO_COLOR, "/"),
  status("O", "TODO", "☰", TODO_COLOR, "/"),
  status("~", "TODO", "≈", TODO_COLOR, "/"),
  status("W", "TODO", "◉", TODO_COLOR, "/"),
  status("f", "TODO", "?", TODO_COLOR, "/"),
  status("F", "TODO", "⋙", TODO_COLOR, "/"),
  status("H", "TODO", "♥", TODO_COLOR, "/"),
  status("&", "TODO", "§", TODO_COLOR, "/"),
  status("s", "TODO", "◆", TODO_COLOR, "/"),
];

const CATEGORIES: ReadonlySet<string> = new Set<TaskStatusCategory>([
  "TODO",
  "IN_PROGRESS",
  "ON_HOLD",
  "DONE",
  "CANCELLED",
  "NON_TASK",
]);
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
    [...candidate.glyph].length > 0 &&
    [...candidate.glyph].length <= MAX_GLYPH_LENGTH &&
    !/[\p{Cc}]/u.test(candidate.glyph) &&
    typeof candidate.color_token === "string" &&
    TASK_COLOR_TOKEN_SET.has(candidate.color_token) &&
    typeof candidate.next_status === "string" &&
    oneSourceCharacter(candidate.next_status)
  );
}

export function defaultTaskStatuses(): TaskStatus[] {
  return DEFAULT_TASK_STATUSES.map((entry) => ({ ...entry }));
}

export function defaultTaskStatusDocuments(): TaskStatus[] {
  return DEFAULT_TASK_STATUSES.map((entry) => ({ ...entry, name: "" }));
}

/** Validates persisted status data without replacing stable default names. */
export function validateTaskStatusDocuments(value: unknown): TaskStatus[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_STATUS_COUNT ||
    !value.every(validStatus)
  ) {
    return defaultTaskStatusDocuments();
  }
  const statuses = value.map((entry) => ({ ...entry }));
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
export function normalizeTaskStatuses(value: unknown): TaskStatus[] {
  const statuses = validateTaskStatusDocuments(value).map((entry) => {
    const localizedName =
      entry.name.length === 0
        ? (STRINGS.taskStatusDefaultNames[
            entry.symbol as keyof typeof STRINGS.taskStatusDefaultNames
          ] ?? entry.symbol)
        : entry.name;
    return { ...entry, name: localizedName };
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

export function taskStatusCommandId(symbol: string): string {
  return `task.status.u${[...symbol]
    .map((character) => character.codePointAt(0)?.toString(16) ?? "0")
    .join("-")}`;
}
