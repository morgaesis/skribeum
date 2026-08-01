// Criterion 1 (M3a): every command, palette entry, view and keybinding
// registers through the registration API, asserted by a check that
// nothing is wired outside it. Two halves:
//
// **Static sweep.** Key-wiring constructs in `src/` are found by
// heuristic: `keymap.of(` (CodeMirror keymap construction),
// `addEventListener("key…")`, and `onkey…=` template handlers. An
// occurrence is legitimate only when it is (a) inside
// `src/lib/registry/`, the one module that translates keys into command
// invocations, or (b) in the committed allowlist below AND its file
// annotated with a `registry-exempt keydown` comment naming the
// ARIA-pattern-internal reason (widget-internal navigation such as a
// combobox's arrow keys is part of the widget per the ARIA authoring
// practices, not a user-invocable command). A new hand-wired key surface
// therefore fails this test twice: no allowlist row and no annotation.
//
// Known limits of the heuristic: it cannot see a handler attached under
// an aliased method name or an exotic event registration; it also cannot
// prove App-level item derivation feeds the palette. The runtime half
// closes the second gap: the palette item builder and the slash menu are
// asserted to list exactly the registry's commands.
//
// **Runtime.** The palette listing equals `registry.paletteCommands()`,
// the slash listing equals `registry.slashCommands()`, and every
// registered keybinding parses.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAppRegistry } from "../../src/lib/features";
import { paletteItems } from "../../src/lib/features/pickers";
import { filteredSlashCommands } from "../../src/lib/features/slashMenu";
import { parseKeybinding } from "../../src/lib/registry";

const sourceDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "src",
);

/**
 * Files allowed to carry widget-internal key handling, with the ARIA
 * pattern that owns those keys. Adding a row here is a reviewed decision.
 */
const WIDGET_INTERNAL_ALLOWLIST = new Map<string, string>([
  ["App.svelte", "window-level delegation to the registry's global handler"],
  ["lib/FileTree.svelte", "ARIA tree pattern internal navigation"],
  ["lib/OutlinePanel.svelte", "ARIA tree pattern internal navigation"],
  ["lib/PaletteOverlay.svelte", "ARIA combobox pattern internal navigation"],
  ["lib/SettingsView.svelte", "ARIA dialog pattern internal dismissal"],
  ["lib/Sheet.svelte", "ARIA modal dialog focus trapping and dismissal"],
  [
    "lib/editor/decorations/engine.ts",
    "task checkbox and listbox internal navigation",
  ],
  ["lib/rendering/CanvasView.svelte", "canvas camera internal navigation"],
  ["lib/features/findPanel.ts", "find widget internal keys"],
]);

const KEY_WIRING = [
  /keymap\.of\(/,
  /addEventListener\(\s*["']key(?:down|press|up)["']/,
  /onkey(?:down|press|up)\s*=/,
];

const EXEMPTION_MARK = "registry-exempt keydown";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(full);
    }
    return entry.name.endsWith(".ts") || entry.name.endsWith(".svelte")
      ? [full]
      : [];
  });
}

type Occurrence = { file: string; line: number; text: string };

function keyWiringOccurrences(): Occurrence[] {
  const occurrences: Occurrence[] = [];
  for (const file of sourceFiles(sourceDirectory)) {
    // Normalized to forward slashes so allowlist rows match on Windows.
    const relative = path.relative(sourceDirectory, file).replaceAll("\\", "/");
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [index, text] of lines.entries()) {
      if (KEY_WIRING.some((pattern) => pattern.test(text))) {
        occurrences.push({
          file: relative,
          line: index + 1,
          text: text.trim(),
        });
      }
    }
  }
  return occurrences;
}

function hasExemptionComment(file: string): boolean {
  return readFileSync(path.join(sourceDirectory, file), "utf8").includes(
    EXEMPTION_MARK,
  );
}

describe("registration coverage (criterion 1)", () => {
  it("finds no key wiring outside the registry and the allowlist", () => {
    const offenders = keyWiringOccurrences().filter((occurrence) => {
      // Occurrence paths are normalized to forward slashes; a literal
      // prefix keeps this exclusion correct on Windows.
      if (occurrence.file.startsWith("lib/registry/")) {
        return false;
      }
      return !(
        WIDGET_INTERNAL_ALLOWLIST.has(occurrence.file) &&
        hasExemptionComment(occurrence.file)
      );
    });
    expect(
      offenders,
      "key wiring outside the registry: register the command through " +
        "src/lib/registry, or (for ARIA-widget-internal keys) add a " +
        "registry-exempt comment and an allowlist row here",
    ).toEqual([]);
  });

  it("keeps the allowlist minimal: every row still has an occurrence", () => {
    const occurrences = keyWiringOccurrences();
    for (const file of WIDGET_INTERNAL_ALLOWLIST.keys()) {
      expect(
        occurrences.some((occurrence) => occurrence.file === file),
        `allowlist row ${file} matches no occurrence; remove it`,
      ).toBe(true);
    }
  });

  it("palette items are exactly the registry's palette commands", () => {
    const registry = createAppRegistry();
    const listed = paletteItems(registry, "", false).map((item) => item.id);
    const registered = registry.paletteCommands().map((command) => command.id);
    expect(listed).toEqual(registered);
  });

  it("slash menu items are exactly the registry's slash commands", () => {
    const registry = createAppRegistry();
    const listed = filteredSlashCommands(registry, "").map(
      (command) => command.id,
    );
    const registered = new Set(
      registry.slashCommands().map((command) => command.id),
    );
    expect(new Set(listed)).toEqual(registered);
    expect(listed.length).toBe(registered.size);
  });

  it("every registered keybinding parses", () => {
    const registry = createAppRegistry();
    for (const command of registry.commands()) {
      for (const binding of command.keybindings ?? []) {
        expect(() => parseKeybinding(binding)).not.toThrow();
      }
    }
  });

  it("every user command reaches a visible pointer surface", () => {
    const registry = createAppRegistry();
    const visibleCommands = new Set([
      ...registry.paletteCommands().map((command) => command.id),
      ...registry.pointerCommands("action-menu").map((command) => command.id),
      "palette.open",
      "file-tree.open",
      "quick-switcher.open",
      "vault-search.open",
      "navigation.back",
      "navigation.forward",
      "find.close",
    ]);
    const unreachable = registry
      .commands()
      .filter((command) => (command.audience ?? "user") === "user")
      .filter((command) => !visibleCommands.has(command.id))
      .map((command) => command.id);
    expect(unreachable).toEqual([]);

    expect(
      registry
        .commands()
        .filter((command) => command.audience === "widget")
        .map((command) => command.id),
    ).toEqual([
      "slash.next",
      "slash.previous",
      "slash.accept",
      "slash.close",
      "table.cell.next",
      "table.cell.previous",
    ]);
    expect(
      registry.commands().filter((command) => command.audience === "developer"),
    ).toEqual([]);
  });
});
