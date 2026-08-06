// "Copy permalink" as a registered command: it must be reachable from the
// command palette, fuzzy-matched by the word "permalink", and it must
// invoke the capability the shell supplies through `CommandContext`.

import { describe, expect, it, vi } from "vitest";
import { createAppRegistry } from "../../src/lib/features";
import { commandItems } from "../../src/lib/features/pickers";
import type { CommandContext } from "../../src/lib/registry";
import { STRINGS } from "../../src/lib/strings";

function baseContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    view: null,
    openNote: () => Promise.resolve(),
    openView: () => {},
    openCommandSurface: () => {},
    toggleView: () => {},
    closeSurfaces: () => {},
    requestSave: () => {},
    notePaths: () => [],
    recentNotePaths: () => [],
    navigateBack: () => false,
    navigateForward: () => false,
    followLink: () => false,
    ...overrides,
  };
}

describe("link.copy-permalink registration", () => {
  it("registers on the command palette and the note action menu", () => {
    const registry = createAppRegistry();
    const command = registry.command("link.copy-permalink");
    expect(command).toBeDefined();
    expect(command?.title).toBe(STRINGS.copyPermalink);
    expect(command?.pointer).toContain("command-palette");
    expect(command?.pointer).toContain("action-menu");
    expect(
      registry
        .paletteCommands()
        .some((entry) => entry.id === "link.copy-permalink"),
    ).toBe(true);
  });

  it("matches the palette fuzzy search for 'permalink'", () => {
    const registry = createAppRegistry();
    const matches = commandItems(registry, "permalink", false);
    expect(matches.some((item) => item.value === "link.copy-permalink")).toBe(
      true,
    );
  });

  it("invokes the active note's copyPermalink capability", () => {
    const registry = createAppRegistry();
    const copyPermalink = vi.fn(() => Promise.resolve());
    const context = baseContext({ copyPermalink });

    expect(registry.run("link.copy-permalink", context)).toBe(true);

    expect(copyPermalink).toHaveBeenCalledOnce();
  });

  it("declines without throwing when the host supplies no capability", () => {
    const registry = createAppRegistry();
    expect(() =>
      registry.run("link.copy-permalink", baseContext()),
    ).not.toThrow();
  });
});
