// The registration API surface: the registry, its vocabulary and the
// keybinding interpreters. Features import from here; nothing else in the
// tree wires commands, palette entries, views, keybindings or slash items.

export {
  editorKeymap,
  formatKeybinding,
  globalKeydownHandler,
  keybindingMatches,
  type ParsedKeybinding,
  parseKeybinding,
} from "./keybindings";
export { CommandRegistry } from "./registry";
export type {
  Command,
  CommandContext,
  CommandScope,
  ViewDescriptor,
  ViewKind,
} from "./types";
