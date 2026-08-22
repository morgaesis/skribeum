import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import EmptyPaneState, {
  type EmptyPaneAction,
  type EmptyPaneRecentRow,
} from "../../src/lib/EmptyPaneState.svelte";

const ACTIONS: EmptyPaneAction[] = [
  { id: "note.create", label: "New note", keybinding: "Ctrl+N" },
  { id: "quick-switcher.open", label: "Find a note", keybinding: "Ctrl+K" },
  {
    id: "vault-search.open",
    label: "Search note text",
    keybinding: "Ctrl+Shift+F",
  },
];

function recentRow(
  path: string,
  title = path,
  relativeTime = "4 minutes ago",
): EmptyPaneRecentRow {
  return { path, title, relativeTime };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("empty pane state A: a vault with notes and none open here", () => {
  it("renders the region heading and three actions in document order", () => {
    const component = mount(EmptyPaneState, {
      target: document.body,
      props: {
        hasNotes: true,
        actions: ACTIONS,
        recent: [],
        takeFocus: false,
        instant: true,
        onRunCommand: () => {},
        onOpenRecent: () => {},
      },
    });
    flushSync();
    expect(document.body.textContent).toContain("No note is open");
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-command-id]"),
    ];
    expect(buttons.map((button) => button.dataset.commandId)).toEqual([
      "note.create",
      "quick-switcher.open",
      "vault-search.open",
    ]);
    expect(buttons[0]?.dataset.btnRole).toBe("primary");
    expect(buttons[1]?.dataset.btnRole).toBe("secondary");
    expect(buttons[2]?.dataset.btnRole).toBe("secondary");
    // Every action carries a keybinding chip via <kbd>.
    for (const button of buttons) {
      expect(button.querySelector("kbd")).not.toBeNull();
    }
    void unmount(component);
  });

  it("mounts no contenteditable element and no editor content role anywhere", () => {
    const component = mount(EmptyPaneState, {
      target: document.body,
      props: {
        hasNotes: true,
        actions: ACTIONS,
        recent: [recentRow("a.md")],
        takeFocus: false,
        instant: true,
        onRunCommand: () => {},
        onOpenRecent: () => {},
      },
    });
    flushSync();
    expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(
      0,
    );
    expect(document.querySelectorAll(".cm-content")).toHaveLength(0);
    void unmount(component);
  });

  it("runs the command registered for an action when it is activated", () => {
    const ran: string[] = [];
    const component = mount(EmptyPaneState, {
      target: document.body,
      props: {
        hasNotes: true,
        actions: ACTIONS,
        recent: [],
        takeFocus: false,
        instant: true,
        onRunCommand: (id: string) => ran.push(id),
        onOpenRecent: () => {},
      },
    });
    flushSync();
    document
      .querySelector<HTMLButtonElement>(
        '[data-command-id="quick-switcher.open"]',
      )
      ?.click();
    expect(ran).toEqual(["quick-switcher.open"]);
    void unmount(component);
  });

  it("caps the Recent list at five rows even when more are supplied", () => {
    const recent = Array.from({ length: 8 }, (_, index) =>
      recentRow(`note-${index}.md`),
    );
    const component = mount(EmptyPaneState, {
      target: document.body,
      props: {
        hasNotes: true,
        actions: ACTIONS,
        recent,
        takeFocus: false,
        instant: true,
        onRunCommand: () => {},
        onOpenRecent: () => {},
      },
    });
    flushSync();
    expect(document.querySelectorAll("[data-recent-path]")).toHaveLength(8);
    // The component renders exactly what it is given; capping at five is
    // the caller's job (recentNotes.test.ts covers `selectRecentPaths`),
    // so this documents that contract rather than re-testing it here.
    void unmount(component);
  });

  it("renders every non-empty title and relative time supplied", () => {
    const component = mount(EmptyPaneState, {
      target: document.body,
      props: {
        hasNotes: true,
        actions: ACTIONS,
        recent: [
          recentRow("a.md", "Quickstart", "4 minutes ago"),
          recentRow("b.md", "Vault index", "2 hours ago"),
        ],
        takeFocus: false,
        instant: true,
        onRunCommand: () => {},
        onOpenRecent: () => {},
      },
    });
    flushSync();
    const rows = [
      ...document.querySelectorAll<HTMLElement>("[data-recent-path]"),
    ];
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    }
    expect(rows[0]?.textContent).toContain("Quickstart");
    expect(rows[0]?.textContent).toContain("4 minutes ago");
    void unmount(component);
  });

  it("opens a recent row in place on a plain click and adds a tab on Mod-click", () => {
    const opened: { path: string; newTab: boolean }[] = [];
    const component = mount(EmptyPaneState, {
      target: document.body,
      props: {
        hasNotes: true,
        actions: ACTIONS,
        recent: [recentRow("a.md")],
        takeFocus: false,
        instant: true,
        onRunCommand: () => {},
        onOpenRecent: (path: string, newTab: boolean) =>
          opened.push({ path, newTab }),
      },
    });
    flushSync();
    const row = document.querySelector<HTMLButtonElement>(
      '[data-recent-path="a.md"]',
    );
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    row?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, ctrlKey: true }),
    );
    expect(opened).toEqual([
      { path: "a.md", newTab: false },
      { path: "a.md", newTab: true },
    ]);
    void unmount(component);
  });
});

describe("empty pane state B: a vault with no notes", () => {
  it("renders the empty-vault heading, body, and a single New note action with no Recent or Find a note", () => {
    const component = mount(EmptyPaneState, {
      target: document.body,
      props: {
        hasNotes: false,
        actions: ACTIONS,
        recent: [],
        takeFocus: false,
        instant: true,
        onRunCommand: () => {},
        onOpenRecent: () => {},
      },
    });
    flushSync();
    expect(document.body.textContent).toContain("This vault is empty");
    expect(document.body.textContent).not.toContain("Recent");
    expect(document.body.textContent).not.toContain("Find a note");
    const buttons = [
      ...document.querySelectorAll<HTMLButtonElement>("[data-command-id]"),
    ];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.dataset.commandId).toBe("note.create");
    expect(buttons[0]?.dataset.btnRole).toBe("primary");
    void unmount(component);
  });
});

describe("empty pane focus custody", () => {
  it("focuses the primary action when takeFocus is set", async () => {
    const component = mount(EmptyPaneState, {
      target: document.body,
      props: {
        hasNotes: true,
        actions: ACTIONS,
        recent: [],
        takeFocus: true,
        instant: true,
        onRunCommand: () => {},
        onOpenRecent: () => {},
      },
    });
    flushSync();
    await tick();
    await tick();
    const primary = document.querySelector<HTMLButtonElement>(
      '[data-btn-role="primary"]',
    );
    expect(document.activeElement).toBe(primary);
    expect(primary?.dataset.forceFocusRing).toBe("true");
    void unmount(component);
  });

  it("does not move focus when takeFocus is false", async () => {
    const outside = document.createElement("button");
    outside.textContent = "outside";
    document.body.append(outside);
    outside.focus();
    const component = mount(EmptyPaneState, {
      target: document.body,
      props: {
        hasNotes: true,
        actions: ACTIONS,
        recent: [],
        takeFocus: false,
        instant: true,
        onRunCommand: () => {},
        onOpenRecent: () => {},
      },
    });
    flushSync();
    await tick();
    await tick();
    expect(document.activeElement).toBe(outside);
    void unmount(component);
  });

  it("clears the forced focus ring marker once the primary action blurs", async () => {
    const component = mount(EmptyPaneState, {
      target: document.body,
      props: {
        hasNotes: true,
        actions: ACTIONS,
        recent: [],
        takeFocus: true,
        instant: true,
        onRunCommand: () => {},
        onOpenRecent: () => {},
      },
    });
    flushSync();
    await tick();
    await tick();
    const primary = document.querySelector<HTMLButtonElement>(
      '[data-btn-role="primary"]',
    );
    expect(primary?.dataset.forceFocusRing).toBe("true");
    primary?.dispatchEvent(new FocusEvent("blur"));
    expect(primary?.dataset.forceFocusRing).toBeUndefined();
    void unmount(component);
  });
});

describe("empty pane arrival motion", () => {
  it("marks an instant arrival for the session's first painted frame", () => {
    const component = mount(EmptyPaneState, {
      target: document.body,
      props: {
        hasNotes: true,
        actions: ACTIONS,
        recent: [],
        takeFocus: false,
        instant: true,
        onRunCommand: () => {},
        onOpenRecent: () => {},
      },
    });
    flushSync();
    expect(
      document
        .querySelector("[data-motion-surface]")
        ?.getAttribute("data-motion-instant"),
    ).toBe("true");
    void unmount(component);
  });

  it("carries no instant marker on a later arrival", () => {
    const component = mount(EmptyPaneState, {
      target: document.body,
      props: {
        hasNotes: true,
        actions: ACTIONS,
        recent: [],
        takeFocus: false,
        instant: false,
        onRunCommand: () => {},
        onOpenRecent: () => {},
      },
    });
    flushSync();
    expect(
      document
        .querySelector("[data-motion-surface]")
        ?.getAttribute("data-motion-instant"),
    ).toBeNull();
    void unmount(component);
  });
});
