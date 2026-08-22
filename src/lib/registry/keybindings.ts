// Keybinding interpretation for the registry: one parser for the
// CodeMirror-style binding syntax commands declare, a window-level handler
// for global-scope commands, and the editor keymap builder for
// editor-scope commands. These are the only places key events translate
// into command invocations; the registry-coverage check pins every other
// key wiring in the tree to a documented widget-internal allowlist.

import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import type { Extension } from "@codemirror/state";
import { type EditorView, type KeyBinding, keymap } from "@codemirror/view";
import { noteHistoryChord } from "../editor/decorations/engine";
import { quoteEditing } from "../editor/quoteEditing";
import { taskEditing } from "../editor/taskEditing";
import { listTabIndent } from "../features/insertions";
import type { CommandRegistry } from "./registry";
import type { CommandContext } from "./types";

export type HistoryCommands = {
  undo(view: EditorView): boolean;
  redo(view: EditorView): boolean;
};

/** One history chord and the step it takes. */
type HistoryChord = {
  binding: string;
  run: (view: EditorView) => boolean;
};

/** A parsed binding: one key plus modifier requirements. */
export type ParsedKeybinding = {
  /** The `KeyboardEvent.key` value, lowercased for letters. */
  key: string;
  /** The platform primary modifier (Control, or Command on macOS). */
  mod: boolean;
  /** The physical Control key, independent of the platform primary key. */
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
};

/** Parses `"Mod-Shift-p"` syntax. The last segment is the key itself. */
export function parseKeybinding(binding: string): ParsedKeybinding {
  const segments = binding.split("-");
  const terminalHyphen = binding.endsWith("--");
  const key = terminalHyphen ? "-" : (segments[segments.length - 1] ?? "");
  if (key === "") {
    throw new Error(`empty keybinding ${JSON.stringify(binding)}`);
  }
  const modifiers = terminalHyphen
    ? binding.slice(0, -2).split("-")
    : segments.slice(0, -1);
  for (const modifier of modifiers) {
    if (
      modifier !== "Mod" &&
      modifier !== "Ctrl" &&
      modifier !== "Shift" &&
      modifier !== "Alt"
    ) {
      throw new Error(
        `unknown modifier ${JSON.stringify(modifier)} in ${JSON.stringify(binding)}`,
      );
    }
  }
  return {
    key: key.length === 1 ? key.toLowerCase() : key,
    mod: modifiers.includes("Mod"),
    ctrl: modifiers.includes("Ctrl"),
    shift: modifiers.includes("Shift"),
    alt: modifiers.includes("Alt"),
  };
}

/** Whether a keyboard event satisfies a parsed binding on this platform. */
export function keybindingMatches(
  binding: ParsedKeybinding,
  event: Pick<
    KeyboardEvent,
    "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey"
  >,
  macPlatform: boolean,
): boolean {
  const expectedControl = binding.ctrl || (binding.mod && !macPlatform);
  const expectedMeta = binding.mod && macPlatform;
  const eventKey = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return (
    eventKey === binding.key &&
    event.ctrlKey === expectedControl &&
    event.metaKey === expectedMeta &&
    event.shiftKey === binding.shift &&
    event.altKey === binding.alt
  );
}

/** A chord whose key is a letter, which Shift does not change. */
const LETTER_KEY = /^[a-z]$/u;

/**
 * Builds one editor binding.
 *
 * A chord on a letter is matched against the event's modifiers exactly.
 * CodeMirror resolves a character key by first looking it up with Shift
 * dropped, so a `Mod-x` binding answers `Mod-Shift-x` on any platform that
 * reports the unshifted letter with Shift held — with Caps Lock on, and on
 * layouts that do not case-shift — and the more specific chord becomes
 * unreachable, all the more so where the shorter chord's command always
 * reports the key handled. A letter's identity does not depend on Shift, so
 * matching it exactly costs nothing. Every other key does depend on Shift,
 * and keeps CodeMirror's lookup, which resolves `Mod-Shift-\` and `Mod-+`
 * through the physical key rather than the character it produces.
 */
function editorBinding(
  binding: string,
  run: (view: EditorView) => boolean,
  macPlatform: boolean,
  claimAlways = false,
): KeyBinding {
  const parsed = parseKeybinding(binding);
  if (!LETTER_KEY.test(parsed.key)) {
    return { key: binding, run, preventDefault: claimAlways };
  }
  return {
    any: (view, event) => {
      if (!keybindingMatches(parsed, event, macPlatform)) {
        return false;
      }
      return run(view) || claimAlways;
    },
  };
}

/** Renders a binding for display (`"Ctrl+Shift+P"`, `"⌘⇧P"` on macOS). */
export function formatKeybinding(
  binding: string,
  macPlatform: boolean,
): string {
  const parsed = parseKeybinding(binding);
  const key = parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key;
  if (macPlatform) {
    return `${parsed.ctrl ? "⌃" : ""}${parsed.mod ? "⌘" : ""}${parsed.alt ? "⌥" : ""}${parsed.shift ? "⇧" : ""}${key}`;
  }
  const parts: string[] = [];
  if (parsed.mod || parsed.ctrl) {
    parts.push("Ctrl");
  }
  if (parsed.alt) {
    parts.push("Alt");
  }
  if (parsed.shift) {
    parts.push("Shift");
  }
  parts.push(key);
  return parts.join("+");
}

function isMacPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    /Mac|iP[ao]d|iPhone/.test(navigator.platform)
  );
}

/**
 * Builds the window-level keydown handler dispatching global-scope
 * registry commands. Bindings all carry the primary modifier, so plain
 * typing anywhere (inputs included) never reaches a command.
 */
export function globalKeydownHandler(
  registry: CommandRegistry,
  contextProvider: () => CommandContext,
): (event: KeyboardEvent) => void {
  const mac = isMacPlatform();
  return (event) => {
    for (const command of registry.boundCommands("global")) {
      for (const binding of command.keybindings ?? []) {
        if (
          keybindingMatches(parseKeybinding(binding), event, mac) &&
          registry.run(command.id, contextProvider())
        ) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }
    }
  };
}

/**
 * The editor keymap: every editor-scope registry command's bindings, in
 * registration order and ahead of CodeMirror's stock editing keymaps so a
 * registry command can claim a chord and still fall through (by returning
 * false) when its condition does not hold.
 */
export function editorKeymap(
  registry: CommandRegistry,
  contextProvider: () => CommandContext,
  historyCommands?: HistoryCommands,
): Extension {
  const mac = isMacPlatform();
  const bindings: KeyBinding[] = registry
    .boundCommands("editor")
    .flatMap((command) =>
      (command.keybindings ?? []).map((key) =>
        editorBinding(
          key,
          (view: EditorView) =>
            registry.run(command.id, { ...contextProvider(), view }),
          mac,
        ),
      ),
    );
  // The note owns undo and redo: whether or not there is a step to take,
  // the chord is claimed, so the browser never runs its own undo over an
  // editable surface the note is the only writer of.
  const historyChords: HistoryChord[] =
    historyCommands === undefined
      ? []
      : [
          { binding: "Mod-Shift-z", run: historyCommands.redo },
          ...(mac ? [] : [{ binding: "Mod-y", run: historyCommands.redo }]),
          { binding: "Mod-z", run: historyCommands.undo },
        ];
  const parsedHistoryChords = historyChords.map((chord) => ({
    parsed: parseKeybinding(chord.binding),
    run: chord.run,
  }));
  return [
    taskEditing,
    quoteEditing,
    // Registry-exempt keydown, like task continuation above: nesting on Tab
    // at a list item's text start is text-editing semantics. Both keys fall
    // through to the browser's focus order everywhere else, so the editor
    // stays escapable by keyboard.
    keymap.of([
      { key: "Tab", run: listTabIndent(1) },
      { key: "Shift-Tab", run: listTabIndent(-1) },
    ]),
    // A rendered table cell is an editable surface of its own inside the
    // note's, and its key contract hands the history chords back to the
    // note rather than letting the browser undo the cell in isolation.
    noteHistoryChord.of((view, event) => {
      const chord = parsedHistoryChords.find((candidate) =>
        keybindingMatches(candidate.parsed, event, mac),
      );
      if (chord === undefined) {
        return false;
      }
      chord.run(view);
      return true;
    }),
    keymap.of([
      ...bindings,
      ...historyChords.map((chord) =>
        editorBinding(chord.binding, chord.run, mac, true),
      ),
      ...defaultKeymap,
      ...historyKeymap,
    ]),
  ];
}
