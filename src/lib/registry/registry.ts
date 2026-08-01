// The registration API (the decision that everything user-invocable is
// wired through one surface from the first editor commit). Commands,
// palette entries, views, keybindings and slash items register here; the
// palette, the keymap builders and the slash menu read exclusively from
// this registry, and a CI check sweeps the source tree for wiring that
// bypasses it.

import type { Command, CommandContext, ViewDescriptor } from "./types";

const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

export class CommandRegistry {
  private readonly commandsById = new Map<string, Command>();
  private readonly viewsById = new Map<string, ViewDescriptor>();

  /**
   * Registers a command. Ids must be dot-namespaced lowercase and unique.
   * Several commands may share a keybinding: they chain in registration
   * order, each declining by returning `false` until one handles the key.
   */
  register(command: Command): void {
    if (!ID_PATTERN.test(command.id)) {
      throw new Error(
        `command id ${JSON.stringify(command.id)} is not a dot-namespaced lowercase identifier`,
      );
    }
    if (this.commandsById.has(command.id)) {
      throw new Error(
        `command id ${JSON.stringify(command.id)} is already registered`,
      );
    }
    this.commandsById.set(command.id, command);
  }

  /** Removes one command. Returns false when the id was not registered. */
  unregister(id: string): boolean {
    return this.commandsById.delete(id);
  }

  /** Registers a view id. The host maps ids to concrete surfaces. */
  registerView(view: ViewDescriptor): void {
    if (!ID_PATTERN.test(view.id)) {
      throw new Error(
        `view id ${JSON.stringify(view.id)} is not a dot-namespaced lowercase identifier`,
      );
    }
    if (this.viewsById.has(view.id)) {
      throw new Error(
        `view id ${JSON.stringify(view.id)} is already registered`,
      );
    }
    this.viewsById.set(view.id, view);
  }

  command(id: string): Command | undefined {
    return this.commandsById.get(id);
  }

  /** Every registered command, in registration order. */
  commands(): readonly Command[] {
    return [...this.commandsById.values()];
  }

  /** The palette listing: every command not opted out, sorted by title. */
  paletteCommands(): readonly Command[] {
    return this.commands()
      .filter((command) => command.palette !== false)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /** The slash-menu listing, in registration order. */
  slashCommands(): readonly Command[] {
    return this.commands().filter((command) => command.slash !== undefined);
  }

  /** Commands whose keybindings bind in the given scope. */
  boundCommands(scope: "global" | "editor"): readonly Command[] {
    return this.commands().filter(
      (command) =>
        (command.scope ?? "global") === scope &&
        (command.keybindings?.length ?? 0) > 0,
    );
  }

  views(): readonly ViewDescriptor[] {
    return [...this.viewsById.values()];
  }

  view(id: string): ViewDescriptor | undefined {
    return this.viewsById.get(id);
  }

  /**
   * Runs a command by id. Returns false when the command is unknown or
   * declined (returned `false`); true otherwise. Async results count as
   * handled immediately; rejections surface on the console rather than
   * unwinding into the key handler that triggered them.
   */
  run(id: string, context: CommandContext): boolean {
    const command = this.commandsById.get(id);
    if (command === undefined) {
      return false;
    }
    const outcome = command.run(context);
    if (outcome === false) {
      return false;
    }
    if (outcome instanceof Promise) {
      outcome.catch((error) => {
        console.error(`command ${command.id} failed`, error);
      });
    }
    return true;
  }
}
