// The registration API: id discipline, listing surfaces, dispatch
// semantics, and the keybinding interpreters commands are wired through.

import { history, redo, undo } from "@codemirror/commands";
import { EditorState, type Extension, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandContext } from "../../src/lib/registry";
import {
  CommandRegistry,
  editorKeymap,
  formatKeybinding,
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

// A chord that adds Shift to another chord's key has to reach its own
// command. The keys are driven as events and the result is read from the
// document, because that is the whole observation: which way through the
// history the note moved.
describe("chords that differ only by Shift", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const view of views.splice(0)) {
      view.destroy();
    }
  });

  function mountedEditor(extra: Extension = []): EditorView {
    const registry = new CommandRegistry();
    const view = new EditorView({
      state: EditorState.create({
        doc: "note",
        selection: { anchor: 4 },
        extensions: [
          history(),
          editorKeymap(registry, contextStub, { undo: runUndo, redo: runRedo }),
          extra,
        ],
      }),
      parent: document.body,
    });
    views.push(view);
    return view;
  }

  // The note's own history commands, as the editor supplies them: they
  // report the key handled whether or not there was a step to take, which
  // is what makes a shorter chord able to swallow a longer one.
  const runUndo = (view: EditorView): boolean => {
    undo(view);
    return true;
  };
  const runRedo = (view: EditorView): boolean => {
    redo(view);
    return true;
  };

  function press(view: EditorView, key: string, init: KeyboardEventInit): void {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      }),
    );
  }

  // Two edits far enough apart in time to be two history steps.
  function typeGroups(view: EditorView): void {
    for (const [index, character] of ["1", "2"].entries()) {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: character },
        selection: { anchor: view.state.doc.length + 1 },
        userEvent: "input.type",
        annotations: Transaction.time.of(Date.now() + index * 5000),
      });
    }
  }

  // A US keyboard reports "Z" for Shift+z; with Caps Lock on it reports
  // "z", and so does every synthetic event. The chord is the same chord.
  for (const [name, key] of [
    ["the shifted letter", "Z"],
    ["the unshifted letter", "z"],
  ] as const) {
    it(`redoes when the platform reports ${name}`, () => {
      const view = mountedEditor();
      typeGroups(view);
      expect(view.state.doc.toString()).toBe("note12");

      press(view, "z", { ctrlKey: true });
      press(view, "z", { ctrlKey: true });
      expect(view.state.doc.toString()).toBe("note");

      press(view, key, { ctrlKey: true, shiftKey: true });
      expect(view.state.doc.toString()).toBe("note1");
      press(view, key, { ctrlKey: true, shiftKey: true });
      expect(view.state.doc.toString()).toBe("note12");
    });
  }

  it("reaches a registry command whose chord adds Shift", () => {
    const registry = new CommandRegistry();
    const ran: string[] = [];
    for (const [id, binding] of [
      ["test.plain", "Mod-g"],
      ["test.shifted", "Mod-Shift-g"],
    ] as const) {
      registry.register({
        id,
        title: id,
        keybindings: [binding],
        scope: "editor",
        pointer: ["command-palette"],
        // Reports the key handled either way, as a command that acted does.
        run: () => {
          ran.push(id);
        },
      });
    }
    const view = new EditorView({
      state: EditorState.create({
        doc: "note",
        extensions: [editorKeymap(registry, contextStub)],
      }),
      parent: document.body,
    });
    views.push(view);

    press(view, "g", { ctrlKey: true });
    press(view, "G", { ctrlKey: true, shiftKey: true });
    press(view, "g", { ctrlKey: true, shiftKey: true });
    expect(ran).toEqual(["test.plain", "test.shifted", "test.shifted"]);
  });
});
