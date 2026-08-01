// Criterion 4 (M3a): the alpha floor is complete and registered.
// Command palette, quick switcher, in-note find, heading outline and
// ranked vault search each exist as a registered view or command with a
// keybinding, and the palette overlay renders the registry listing with
// combobox semantics under full keyboard operation.

import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import { createAppRegistry } from "../../src/lib/features";
import { paletteItems } from "../../src/lib/features/pickers";
import {
  VIEW_COMMAND_PALETTE,
  VIEW_OUTLINE,
  VIEW_QUICK_SWITCHER,
  VIEW_SETTINGS,
  VIEW_VAULT_SEARCH,
} from "../../src/lib/features/surfaces";
import PaletteOverlay from "../../src/lib/PaletteOverlay.svelte";

describe("alpha floor registration (criterion 4)", () => {
  const registry = createAppRegistry();

  it("registers every alpha-floor surface as a view", () => {
    const views = new Set(registry.views().map((view) => view.id));
    for (const id of [
      VIEW_COMMAND_PALETTE,
      VIEW_QUICK_SWITCHER,
      VIEW_VAULT_SEARCH,
      VIEW_SETTINGS,
      VIEW_OUTLINE,
    ]) {
      expect(views.has(id), `view ${id} is not registered`).toBe(true);
    }
  });

  it("registers every alpha-floor command with a keybinding", () => {
    const required: readonly [string, string][] = [
      ["palette.open", "Mod-p"],
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
});

describe("palette overlay component", () => {
  it("seeds a prefiltered surface with its initial query", () => {
    const component = mount(PaletteOverlay, {
      target: document.body,
      props: {
        label: "Vault search",
        placeholder: "Search",
        items: [],
        initialQuery: "#shared",
        onQueryChange: () => {},
        onPick: () => {},
        onClose: () => {},
      },
    });
    flushSync();

    expect(
      document.body.querySelector<HTMLInputElement>('[role="combobox"]')?.value,
    ).toBe("#shared");

    unmount(component);
  });

  it("renders the registry listing with combobox semantics and keyboard operation", () => {
    const registry = createAppRegistry();
    const items = paletteItems(registry, "", false);
    const picked: string[] = [];
    let closed = 0;
    const props = $state({
      label: "Command palette",
      placeholder: "Type a command name",
      items,
      onQueryChange: (query: string) => {
        props.items = paletteItems(registry, query, false);
      },
      onPick: (id: string) => {
        picked.push(id);
      },
      onClose: () => {
        closed += 1;
      },
    });
    const component = mount(PaletteOverlay, {
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
      label: "Command palette",
      placeholder: "Type a command name",
      items: paletteItems(registry, "", false),
      onQueryChange: (query: string) => {
        props.items = paletteItems(registry, query, false);
      },
      onPick: () => {},
      onClose: () => {},
    });
    const component = mount(PaletteOverlay, {
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
