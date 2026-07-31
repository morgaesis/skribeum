// The application's registered feature set. `createAppRegistry` builds
// the one registry every user-invocable surface reads from; a feature
// lands by adding its `register*` call here and nowhere else.

import { CommandRegistry } from "../registry";
import { registerFind } from "./findPanel";
import { registerFormatting } from "./formattingCommands";
import { registerInsertions } from "./insertions";
import { registerSlashMenu } from "./slashMenu";
import { registerSurfaces } from "./surfaces";
import { registerTableEditing } from "./tableEditing";

/** Builds the registry with every built-in feature registered. */
export function createAppRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registerSurfaces(registry);
  registerFind(registry);
  registerFormatting(registry);
  registerInsertions(registry);
  registerSlashMenu(registry);
  registerTableEditing(registry);
  return registry;
}
