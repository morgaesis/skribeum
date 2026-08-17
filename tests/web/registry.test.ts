// The registration API: id discipline, listing surfaces, dispatch
// semantics, and the keybinding interpreters commands are wired through.

import { afterEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../../src/lib/registry";
import {
  CommandRegistry,
  formatKeybinding,
  globalKeydownHandler,
  keybindingMatches,
  parseKeybinding,
} from "../../src/lib/registry";

function contextStub(): CommandContext {
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
  };
}

describe("command registry", () => {
  it("rejects duplicate and malformed ids", () => {
    const registry = new CommandRegistry();
    registry.register({
      id: "test.command",
      title: "Test",
      pointer: ["command-palette"],
      run: () => {},
    });
    expect(() =>
      registry.register({
        id: "test.command",
        title: "Test",
        pointer: ["command-palette"],
        run: () => {},
      }),
    ).toThrow(/already registered/);
    for (const bad of ["single", "Upper.case", "test..gap", "test.", ""]) {
      expect(() =>
        registry.register({
          id: bad,
          title: "Bad",
          pointer: ["command-palette"],
          run: () => {},
        }),
      ).toThrow(/dot-namespaced/);
    }
  });

  it("lists palette commands sorted by title and honors opt-out", () => {
    const registry = new CommandRegistry();
    registry.register({
      id: "b.two",
      title: "Zeta",
      pointer: ["command-palette"],
      run: () => {},
    });
    registry.register({
      id: "a.one",
      title: "Alpha",
      pointer: ["command-palette"],
      run: () => {},
    });
    registry.register({
      id: "c.hidden",
      title: "Hidden",
      palette: false,
      audience: "widget",
      run: () => {},
    });
    expect(registry.paletteCommands().map((command) => command.id)).toEqual([
      "a.one",
      "b.two",
    ]);
  });

  it("lists slash commands exactly when slash metadata exists", () => {
    const registry = new CommandRegistry();
    registry.register({
      id: "a.plain",
      title: "Plain",
      pointer: ["command-palette"],
      run: () => {},
    });
    registry.register({
      id: "a.slash",
      title: "Slash",
      slash: { keywords: ["s"] },
      pointer: ["command-palette", "slash-menu"],
      run: () => {},
    });
    expect(registry.slashCommands().map((command) => command.id)).toEqual([
      "a.slash",
    ]);
  });

  it("dispatches by id and reports declined and unknown commands", () => {
    const registry = new CommandRegistry();
    const runs: string[] = [];
    registry.register({
      id: "test.handled",
      title: "Handled",
      pointer: ["command-palette"],
      run: () => {
        runs.push("handled");
      },
    });
    registry.register({
      id: "test.declined",
      title: "Declined",
      pointer: ["command-palette"],
      run: () => false,
    });
    expect(registry.run("test.handled", contextStub())).toBe(true);
    expect(registry.run("test.declined", contextStub())).toBe(false);
    expect(registry.run("test.unknown", contextStub())).toBe(false);
    expect(runs).toEqual(["handled"]);
  });

  it("registers views by id with duplicate rejection", () => {
    const registry = new CommandRegistry();
    registry.registerView({ id: "view.test", title: "Test", kind: "panel" });
    expect(registry.view("view.test")?.kind).toBe("panel");
    expect(() =>
      registry.registerView({ id: "view.test", title: "Test", kind: "panel" }),
    ).toThrow(/already registered/);
  });
});

describe("keybinding interpretation", () => {
  it("parses modifiers and keys", () => {
    expect(parseKeybinding("Mod-Shift-p")).toEqual({
      key: "p",
      mod: true,
      ctrl: false,
      shift: true,
      alt: false,
    });
    expect(parseKeybinding("Tab")).toEqual({
      key: "Tab",
      mod: false,
      ctrl: false,
      shift: false,
      alt: false,
    });
    expect(parseKeybinding("Mod-,").key).toBe(",");
    expect(parseKeybinding("Mod--")).toEqual({
      key: "-",
      mod: true,
      ctrl: false,
      shift: false,
      alt: false,
    });
    expect(parseKeybinding("Ctrl-Enter").ctrl).toBe(true);
    expect(() => parseKeybinding("Hyper-x")).toThrow(/unknown modifier/);
  });

  it("matches the platform primary modifier and rejects the other", () => {
    const binding = parseKeybinding("Mod-p");
    const event = {
      key: "p",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      altKey: false,
    };
    expect(keybindingMatches(binding, event, false)).toBe(true);
    expect(keybindingMatches(binding, event, true)).toBe(false);
    expect(
      keybindingMatches(binding, { ...event, shiftKey: true }, false),
    ).toBe(false);
    expect(
      keybindingMatches(
        binding,
        { ...event, ctrlKey: false, metaKey: true },
        true,
      ),
    ).toBe(true);
  });

  it("matches shifted letter chords by key identity", () => {
    // A physical Mod+Shift+P arrives with `key: "P"`.
    const binding = parseKeybinding("Mod-Shift-p");
    expect(
      keybindingMatches(
        binding,
        {
          key: "P",
          ctrlKey: true,
          metaKey: false,
          shiftKey: true,
          altKey: false,
        },
        false,
      ),
    ).toBe(true);
  });

  it("formats bindings for display per platform", () => {
    expect(formatKeybinding("Mod-Shift-p", false)).toBe("Ctrl+Shift+P");
    expect(formatKeybinding("Mod-Shift-p", true)).toBe("⌘⇧P");
    expect(formatKeybinding("Ctrl-Enter", true)).toBe("⌃Enter");
  });
});

// The global handler resolves the primary modifier from the running
// platform rather than taking it as an argument, so a suite that only ever
// runs on the platform it was written for exercises one branch of that
// resolution. Overriding `navigator.platform` runs both branches anywhere,
// which is what keeps the macOS chord answerable from a Linux machine.
describe("global keybinding dispatch across platforms", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    "platform",
  );

  afterEach(() => {
    if (originalPlatform === undefined) {
      Reflect.deleteProperty(globalThis.navigator, "platform");
    } else {
      Object.defineProperty(globalThis.navigator, "platform", originalPlatform);
    }
  });

  function setPlatform(platform: string): void {
    Object.defineProperty(globalThis.navigator, "platform", {
      configurable: true,
      value: platform,
    });
  }

  /** Registers one `Mod-p` command and returns the handler plus its log. */
  function handlerForPlatform(platform: string): {
    handle: (event: KeyboardEvent) => void;
    runs: string[];
  } {
    setPlatform(platform);
    const registry = new CommandRegistry();
    const runs: string[] = [];
    registry.register({
      id: "test.primary",
      title: "Primary",
      pointer: ["command-palette"],
      keybindings: ["Mod-p"],
      run: () => {
        runs.push("test.primary");
      },
    });
    return { handle: globalKeydownHandler(registry, contextStub), runs };
  }

  function chord(modifier: "ctrlKey" | "metaKey"): KeyboardEvent {
    return new KeyboardEvent("keydown", {
      key: "p",
      [modifier]: true,
      cancelable: true,
    });
  }

  it("answers Command and refuses Control on a macOS platform string", () => {
    const { handle, runs } = handlerForPlatform("MacIntel");

    const command = chord("metaKey");
    handle(command);
    expect(runs).toEqual(["test.primary"]);
    expect(command.defaultPrevented).toBe(true);

    const control = chord("ctrlKey");
    handle(control);
    expect(runs).toEqual(["test.primary"]);
    expect(control.defaultPrevented).toBe(false);
  });

  it("answers Control and refuses Command on Windows and Linux platform strings", () => {
    for (const platform of ["Win32", "Linux x86_64", "Linux aarch64"]) {
      const { handle, runs } = handlerForPlatform(platform);

      const control = chord("ctrlKey");
      handle(control);
      expect(runs).toEqual(["test.primary"]);
      expect(control.defaultPrevented).toBe(true);

      const command = chord("metaKey");
      handle(command);
      expect(runs).toEqual(["test.primary"]);
      expect(command.defaultPrevented).toBe(false);
    }
  });
});
