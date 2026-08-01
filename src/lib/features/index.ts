// The application's registered feature set. `createAppRegistry` builds
// the one registry every user-invocable surface reads from; a feature
// lands by adding its `register*` call here and nowhere else.

import { CommandRegistry } from "../registry";
import { DEFAULT_TASK_STATUSES, type TaskStatus } from "../taskStatuses";
import { registerCopyLinks } from "./copyLinks";
import { registerFind } from "./findPanel";
import { registerFormatting } from "./formattingCommands";
import { registerInsertions } from "./insertions";
import { registerNavigation } from "./navigation";
import { registerSettingActions } from "./settingsCatalog";
import { registerSlashMenu } from "./slashMenu";
import { registerSurfaces } from "./surfaces";
import { registerTableEditing } from "./tableEditing";
import { registerTags } from "./tags";
import { registerTaskStatusCommands } from "./taskCommands";

/** Builds the registry with every built-in feature registered. */
export function createAppRegistry(
  taskStatuses: readonly TaskStatus[] = DEFAULT_TASK_STATUSES,
): CommandRegistry {
  const registry = new CommandRegistry();
  registerSurfaces(registry);
  registerSettingActions(registry);
  registerCopyLinks(registry);
  registerFind(registry);
  registerFormatting(registry);
  registerInsertions(registry);
  registerTags(registry);
  registerSlashMenu(registry);
  registerNavigation(registry);
  registerTableEditing(registry);
  registerTaskStatusCommands(registry, taskStatuses);
  return registry;
}
