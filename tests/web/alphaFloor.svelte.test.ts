// Criterion 4 (M3a): the alpha floor is complete and registered.
// The unified command surface, in-note find, heading outline, and settings
// each exist as a registered view or command with a keybinding. The surface
// renders registry commands with combobox semantics and keyboard operation.

import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import { createAppRegistry } from "../../src/lib/features";
import { commandItems, type PickerItem } from "../../src/lib/features/pickers";
import {
  VIEW_COMMAND_SURFACE,
  VIEW_OUTLINE,
  VIEW_SETTINGS,
} from "../../src/lib/features/surfaces";
import UnifiedCommandSurface from "../../src/lib/UnifiedCommandSurface.svelte";

describe("alpha floor registration (criterion 4)", () => {
  const registry = createAppRegistry();

  it("registers every alpha-floor surface as a view", () => {
    const views = new Set(registry.views().map((view) => view.id));
    for (const id of [VIEW_COMMAND_SURFACE, VIEW_SETTINGS, VIEW_OUTLINE]) {
      expect(views.has(id), `view ${id} is not registered`).toBe(true);
    }
  });

  it("registers every alpha-floor command with a keybinding", () => {
    const required: readonly [string, string][] = [
      ["palette.open", "Mod-p"],
      ["quick-switcher.open", "Mod-k"],
      ["quick-switcher.open", "Mod-o"],
      ["find.open", "Mod-f"],
      ["outline.toggle", "Mod-Shift-o"],
      ["vault-search.open", "Mod-Shift-f"],
      ["settings.open", "Mod-,"],
      ["note.save", "Mod-s"],
    ];
    for (const [id, binding] of required) {
      const command = registry.command(id);
      expect(command, `command ${id} is not registered`).toBeDefined();
      expect(command?.keybindings ?? []).toContain(binding);
    }
  });

  it("also lists the palette under its shifted chord", () => {
    expect(registry.command("palette.open")?.keybindings).toContain(
      "Mod-Shift-p",
    );
  });

  it("gives every selection-toolbar command a displayed binding", () => {
    for (const command of registry.pointerCommands("selection-toolbar")) {
      expect(command.keybindings?.[0], command.id).toBeDefined();
    }
    expect(registry.command("format.wikilink")?.keybindings).toContain(
      "Mod-Shift-k",
    );
  });
});

describe("unified command surface component", () => {
  it("seeds a prefiltered surface with its initial query", () => {
    const props = $state({
      items: [] as PickerItem[],
      mode: "tag" as const,
      initialQuery: "#shared",
      onQueryChange: () => {},
      onPick: () => {},
      onClose: () => {},
    });
    const component = mount(UnifiedCommandSurface, {
      target: document.body,
      props,
    });
    flushSync();

    expect(
      document.body.querySelector<HTMLInputElement>('[role="combobox"]')?.value,
    ).toBe("#shared");

    props.initialQuery = "?cedar";
    flushSync();
    expect(
      document.body.querySelector<HTMLInputElement>('[role="combobox"]')?.value,
    ).toBe("?cedar");

    unmount(component);
  });

  it("renders the registry listing with combobox semantics and keyboard operation", () => {
    const registry = createAppRegistry();
    const items = commandItems(registry, "", false);
    const picked: string[] = [];
    let closed = 0;
    const props = $state({
      items,
      mode: "command" as const,
      onQueryChange: (query: string) => {
        props.items = commandItems(registry, query, false);
      },
      onPick: (item: PickerItem) => {
        picked.push(item.id);
      },
      onClose: () => {
        closed += 1;
      },
    });
    const component = mount(UnifiedCommandSurface, {
      target: document.body,
      props,
    });
    flushSync();

    const input =
      document.body.querySelector<HTMLInputElement>('[role="combobox"]');
    const listbox = document.body.querySelector('[role="listbox"]');
    expect(input).not.toBeNull();
    expect(listbox).not.toBeNull();
    expect(input?.getAttribute("aria-expanded")).toBe("true");
    expect(input?.getAttribute("aria-controls")).toBe(listbox?.id);

    // The listbox lists exactly the registry's palette commands.
    const optionCount =
      listbox?.querySelectorAll('[role="option"]').length ?? 0;
    expect(optionCount).toBe(registry.paletteCommands().length);

    // Arrow movement updates the active descendant.
    const firstDescendant = input?.getAttribute("aria-activedescendant");
    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    flushSync();
    expect(input?.getAttribute("aria-activedescendant")).not.toBe(
      firstDescendant,
    );

    // Enter picks the active item.
    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    flushSync();
    expect(picked).toHaveLength(1);
    expect(picked[0]).toBe(items[1]?.id);

    // Escape closes.
    input?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    flushSync();
    expect(closed).toBe(1);

    void unmount(component);
  });

  it("filters through the query callback and highlights matches", () => {
    const registry = createAppRegistry();
    const props = $state({
      items: commandItems(registry, "", false),
      mode: "command" as const,
      onQueryChange: (query: string) => {
        props.items = commandItems(registry, query, false);
      },
      onPick: () => {},
      onClose: () => {},
    });
    const component = mount(UnifiedCommandSurface, {
      target: document.body,
      props,
    });
    flushSync();

    const input =
      document.body.querySelector<HTMLInputElement>('[role="combobox"]');
    if (input !== null) {
      input.value = "outline";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    flushSync();

    const options = [...document.body.querySelectorAll('[role="option"]')];
    expect(options.length).toBeGreaterThan(0);
    expect(options.length).toBeLessThan(registry.paletteCommands().length);
    expect(options[0]?.textContent ?? "").toContain("outline");
    // Highlighting is real elements over text nodes, never injected HTML.
    expect(options[0]?.querySelector("mark")).not.toBeNull();

    void unmount(component);
  });
});
