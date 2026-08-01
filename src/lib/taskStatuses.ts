// Task status configuration shared by settings, markdown parsing, editor
// decorations and registry commands. The ordered list is the complete source
// of truth: symbols outside it remain ordinary markdown text.

import type { TaskStatusCategory, TaskStatusDoc } from "./ipc/bindings";

export type TaskStatus = TaskStatusDoc;
export type { TaskStatusCategory };

const TODO_COLOR = "--skr-accent";
const IN_PROGRESS_COLOR = "--skr-warning";
const DONE_COLOR = "--skr-success";
const CANCELLED_COLOR = "--skr-danger";

function status(
  symbol: string,
  name: string,
  category: TaskStatusCategory,
  glyph: string,
  color_token: string,
  next_status: string,
): TaskStatus {
  return { symbol, name, category, glyph, color_token, next_status };
}

/** SlRvb's alternate checkbox vocabulary with a compact default cycle. */
export const DEFAULT_TASK_STATUSES: readonly TaskStatus[] = [
  status(" ", "Unchecked", "TODO", "○", TODO_COLOR, "/"),
  status("x", "Regular", "DONE", "✓", DONE_COLOR, " "),
  status("X", "Checked", "DONE", "✔", DONE_COLOR, " "),
  status("-", "Dropped", "CANCELLED", "✕", CANCELLED_COLOR, " "),
  status(">", "Forward", "TODO", "→", TODO_COLOR, "/"),
  status("<", "Migrated", "TODO", "←", TODO_COLOR, "/"),
  status("D", "Date", "TODO", "◷", TODO_COLOR, "/"),
  status("?", "Question", "TODO", "?", TODO_COLOR, "/"),
  status("/", "Half Done", "IN_PROGRESS", "◐", IN_PROGRESS_COLOR, "x"),
  status("+", "Add", "TODO", "+", TODO_COLOR, "/"),
  status("R", "Research", "TODO", "⌕", TODO_COLOR, "/"),
  status("!", "Important", "TODO", "!", TODO_COLOR, "/"),
  status("i", "Idea", "TODO", "◇", TODO_COLOR, "/"),
  status("B", "Brainstorm", "TODO", "◎", TODO_COLOR, "/"),
  status("P", "Pro", "TODO", "+", TODO_COLOR, "/"),
  status("C", "Con", "TODO", "−", TODO_COLOR, "/"),
  status("Q", "Quote", "TODO", "❝", TODO_COLOR, "/"),
  status("N", "Note", "TODO", "▤", TODO_COLOR, "/"),
  status("b", "Bookmark", "TODO", "◆", TODO_COLOR, "/"),
  status("I", "Information", "TODO", "ⓘ", TODO_COLOR, "/"),
  status("p", "Paraphrase", "TODO", "¶", TODO_COLOR, "/"),
  status("L", "Location", "TODO", "⌖", TODO_COLOR, "/"),
  status("E", "Example", "TODO", "◇", TODO_COLOR, "/"),
  status("A", "Answer", "TODO", "↳", TODO_COLOR, "/"),
  status("r", "Reward", "TODO", "★", TODO_COLOR, "/"),
  status("c", "Choice", "TODO", "◆", TODO_COLOR, "/"),
  status("d", "Doing", "IN_PROGRESS", "◒", IN_PROGRESS_COLOR, "x"),
  status("T", "Time", "TODO", "◷", TODO_COLOR, "/"),
  status("@", "Character", "TODO", "@", TODO_COLOR, "/"),
  status("t", "Talk", "TODO", "◖", TODO_COLOR, "/"),
  status("O", "Outline", "TODO", "☰", TODO_COLOR, "/"),
  status("~", "Conflict", "TODO", "≈", TODO_COLOR, "/"),
  status("W", "World", "TODO", "◉", TODO_COLOR, "/"),
  status("f", "Clue", "TODO", "?", TODO_COLOR, "/"),
  status("F", "Foreshadow", "TODO", "⋙", TODO_COLOR, "/"),
  status("H", "Favorite", "TODO", "♥", TODO_COLOR, "/"),
  status("&", "Symbolism", "TODO", "§", TODO_COLOR, "/"),
  status("s", "Secret", "TODO", "◆", TODO_COLOR, "/"),
];

const CATEGORIES: ReadonlySet<string> = new Set<TaskStatusCategory>([
  "TODO",
  "IN_PROGRESS",
  "ON_HOLD",
  "DONE",
  "CANCELLED",
  "NON_TASK",
]);
const COLOR_TOKEN = /^--skr-[a-z0-9]+(?:-[a-z0-9]+)*$/;
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
    candidate.name.trim().length > 0 &&
    [...candidate.name].length <= MAX_NAME_LENGTH &&
    typeof candidate.category === "string" &&
    CATEGORIES.has(candidate.category) &&
    typeof candidate.glyph === "string" &&
    [...candidate.glyph].length > 0 &&
    [...candidate.glyph].length <= MAX_GLYPH_LENGTH &&
    !/[\p{Cc}]/u.test(candidate.glyph) &&
    typeof candidate.color_token === "string" &&
    COLOR_TOKEN.test(candidate.color_token) &&
    typeof candidate.next_status === "string" &&
    oneSourceCharacter(candidate.next_status)
  );
}

export function defaultTaskStatuses(): TaskStatus[] {
  return DEFAULT_TASK_STATUSES.map((entry) => ({ ...entry }));
}

/**
 * Validates an untrusted status list as one graph. A malformed entry,
 * duplicate symbol or dangling transition falls back to the complete default
 * list, so parsing and rendering always agree.
 */
export function normalizeTaskStatuses(value: unknown): TaskStatus[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_STATUS_COUNT ||
    !value.every(validStatus)
  ) {
    return defaultTaskStatuses();
  }
  const statuses = value.map((entry) => ({ ...entry }));
  const symbols = new Set(statuses.map((entry) => entry.symbol));
  if (
    symbols.size !== statuses.length ||
    statuses.some((entry) => !symbols.has(entry.next_status))
  ) {
    return defaultTaskStatuses();
  }
  return statuses;
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
