// Keybinding interpretation for the registry: one parser for the
// CodeMirror-style binding syntax commands declare, a window-level handler
// for global-scope commands, and the editor keymap builder for
// editor-scope commands. These are the only places key events translate
// into command invocations; the registry-coverage check pins every other
// key wiring in the tree to a documented widget-internal allowlist.

import { defaultKeymap, historyKeymap } from "@codemirror/commands";
import type { Extension } from "@codemirror/state";
import { type EditorView, type KeyBinding, keymap } from "@codemirror/view";
import { taskEditing } from "../editor/taskEditing";
import type { CommandRegistry } from "./registry";
import type { CommandContext } from "./types";

export type HistoryCommands = {
  undo(view: EditorView): boolean;
  redo(view: EditorView): boolean;
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
  const bindings: KeyBinding[] = registry
    .boundCommands("editor")
    .flatMap((command) =>
      (command.keybindings ?? []).map((key) => ({
        key,
        run: (view: EditorView) =>
          registry.run(command.id, { ...contextProvider(), view }),
      })),
    );
  const persistentHistoryBindings: KeyBinding[] =
    historyCommands === undefined
      ? []
      : [
          {
            key: "Mod-z",
            run: historyCommands.undo,
            preventDefault: true,
          },
          {
            key: "Mod-y",
            mac: "Mod-Shift-z",
            run: historyCommands.redo,
            preventDefault: true,
          },
          {
            linux: "Ctrl-Shift-z",
            run: historyCommands.redo,
            preventDefault: true,
          },
        ];
  return [
    taskEditing,
    keymap.of([
      ...bindings,
      ...persistentHistoryBindings,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
  ];
}
