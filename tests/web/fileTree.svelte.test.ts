import { flushSync, mount, tick, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import { showConfirmDialog, showPromptDialog } from "../../src/lib/dialogs";
import FileTree from "../../src/lib/FileTree.svelte";
import { createAppRegistry } from "../../src/lib/features";
import type { TreeEntry } from "../../src/lib/ipc/bindings";
import type { CommandContext } from "../../src/lib/registry";
import { reactiveState } from "./helpers/reactiveState.svelte";

const ROW_HEIGHT = 28;

function notes(count: number): TreeEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `Note ${String(index).padStart(4, "0")}.md`,
    kind: "note" as const,
    hidden: false,
  }));
}

function setViewport(tree: HTMLUListElement, height: number, top = 0): void {
  Object.defineProperty(tree, "clientHeight", {
    configurable: true,
    value: height,
  });
  tree.scrollTop = top;
  tree.dispatchEvent(new Event("scroll"));
  flushSync();
}

function treeItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];
}

describe("virtualized file tree", () => {
  it("slides the rendered window with scrolling", () => {
    const component = mount(FileTree, {
      target: document.body,
      props: { entries: notes(2_000), onOpenPath: () => {} },
    });
    flushSync();
    const tree = document.querySelector<HTMLUListElement>('[role="tree"]');
    expect(tree).not.toBeNull();
    if (tree === null) return;

    setViewport(tree, ROW_HEIGHT * 12);
    expect(tree.textContent).toContain("Note 0000");
    expect(tree.textContent).not.toContain("Note 1000");

    setViewport(tree, ROW_HEIGHT * 12, ROW_HEIGHT * 1_000);
    expect(tree.textContent).toContain("Note 1000");
    expect(tree.textContent).not.toContain("Note 0500");

    void unmount(component);
  });

  it("scrolls an off-window keyboard target into view before focusing it", async () => {
    const opened: string[] = [];
    const component = mount(FileTree, {
      target: document.body,
      props: {
        entries: notes(2_000),
        onOpenPath: (path: string) => opened.push(path),
      },
    });
    flushSync();
    const tree = document.querySelector<HTMLUListElement>('[role="tree"]');
    const first = document.querySelector<HTMLElement>(
      '[role="treeitem"][tabindex="0"]',
    );
    expect(tree).not.toBeNull();
    expect(first).not.toBeNull();
    if (tree === null || first === null) return;
    setViewport(tree, ROW_HEIGHT * 12);
    first.focus();

    first.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    await tick();
    const last = document.activeElement as HTMLElement | null;
    expect(last?.textContent).toContain("Note 1999");
    expect(tree.scrollTop).toBeGreaterThan(0);

    last?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(opened).toEqual(["Note 1999.md"]);

    last?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    await tick();
    expect(
      (document.activeElement as HTMLElement | null)?.textContent,
    ).toContain("Note 0000");
    expect(tree.scrollTop).toBeLessThanOrEqual(4);

    void unmount(component);
  });

  it("keeps a 2,000-entry tree bounded to a few dozen DOM rows", () => {
    const component = mount(FileTree, {
      target: document.body,
      props: { entries: notes(2_000), onOpenPath: () => {} },
    });
    flushSync();
    const tree = document.querySelector<HTMLUListElement>('[role="tree"]');
    expect(tree).not.toBeNull();
    if (tree === null) return;

    setViewport(tree, ROW_HEIGHT * 12, ROW_HEIGHT * 1_000);
    expect(treeItems()).toHaveLength(38);

    void unmount(component);
  });
});

function commandContext(
  overrides: Partial<CommandContext> = {},
): CommandContext {
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

describe("designed file tree", () => {
  const entries: TreeEntry[] = [
    { path: "Folder", kind: "directory", hidden: false },
    { path: "Folder/one.md", kind: "note", hidden: false },
    { path: "Folder/two.md", kind: "note", hidden: false },
    { path: "plain.md", kind: "note", hidden: false },
    { path: "manual.pdf", kind: "file", hidden: false },
  ];

  it("renders display titles, collision suffixes, authored icons, and folder-only chevrons", async () => {
    const component = mount(FileTree, {
      target: document.body,
      props: {
        entries,
        expandedPaths: ["Folder"],
        titleSources: {
          "Folder/one.md": "---\ntitle: Shared\nicon: 🧭\n---\n",
          "Folder/two.md": "# Shared\n",
          "plain.md": "# Reading title\n",
        },
        onOpenPath: () => {},
      },
    });
    flushSync();

    const folder = document.querySelector<HTMLElement>('[data-path="Folder"]');
    const first = document.querySelector<HTMLElement>(
      '[data-path="Folder/one.md"]',
    );
    const second = document.querySelector<HTMLElement>(
      '[data-path="Folder/two.md"]',
    );
    const plain = document.querySelector<HTMLElement>('[data-path="plain.md"]');
    const manual = document.querySelector<HTMLElement>(
      '[data-path="manual.pdf"]',
    );
    expect(folder?.querySelector(".skr-tree-leading svg")).not.toBeNull();
    expect(first?.querySelector(".skr-tree-leading svg")).toBeNull();
    expect(first?.querySelector(".skr-tree-note-icon")?.textContent).toBe("🧭");
    expect(first?.textContent).toContain("Shared");
    expect(first?.textContent).toContain("one");
    expect(second?.textContent).toContain("two");
    expect(plain?.textContent).toContain("Reading title");
    expect(plain?.textContent).not.toContain("plain.md");
    expect(manual?.textContent).toContain("manual.pdf");

    await unmount(component);
  });

  it("opens row actions by pointer and keyboard and dispatches through the registry", async () => {
    const renamed: string[] = [];
    const registry = createAppRegistry(undefined, true);
    const context = commandContext({
      renameTreeEntry: async (path) => {
        renamed.push(path);
      },
    });
    const component = mount(FileTree, {
      target: document.body,
      props: {
        entries,
        expandedPaths: ["Folder"],
        onOpenPath: () => {},
        registry,
        commandContext: () => context,
        desktop: true,
      },
    });
    flushSync();

    const row = document.querySelector<HTMLElement>('[data-path="plain.md"]');
    const actions = row?.querySelector<HTMLButtonElement>(".skr-tree-actions");
    actions?.click();
    await tick();
    document
      .querySelector<HTMLButtonElement>('[data-command-id="tree.entry.rename"]')
      ?.click();
    expect(renamed).toEqual(["plain.md"]);

    document
      .querySelector<HTMLElement>('[data-path="Folder"]')
      ?.querySelector<HTMLButtonElement>(".skr-tree-actions")
      ?.click();
    await tick();
    expect(
      document.querySelector('[data-command-id="tree.entry.reveal"]'),
    ).not.toBeNull();

    row?.focus();
    row?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
      }),
    );
    await tick();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");

    await unmount(component);
  });

  it("toggles the row overflow menu: a second click on the same trigger closes it", async () => {
    const registry = createAppRegistry(undefined, true);
    const context = commandContext();
    const component = mount(FileTree, {
      target: document.body,
      props: {
        entries,
        expandedPaths: ["Folder"],
        onOpenPath: () => {},
        registry,
        commandContext: () => context,
        desktop: true,
      },
    });
    flushSync();

    const row = document.querySelector<HTMLElement>('[data-path="plain.md"]');
    const actions = row?.querySelector<HTMLButtonElement>(".skr-tree-actions");
    expect(actions?.getAttribute("aria-expanded")).toBe("false");

    actions?.click();
    await tick();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(actions?.getAttribute("aria-expanded")).toBe("true");

    actions?.click();
    await tick();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(actions?.getAttribute("aria-expanded")).toBe("false");

    await unmount(component);
  });

  it("returns menu commands to their originating tree row for pointer and keyboard use", async () => {
    const copied: string[] = [];
    const registry = createAppRegistry(undefined, true);
    const context = commandContext({
      copyTreeNoteLink: async (path) => {
        copied.push(path);
      },
    });
    const component = mount(FileTree, {
      target: document.body,
      props: {
        entries,
        expandedPaths: ["Folder"],
        onOpenPath: () => {},
        registry,
        commandContext: () => context,
        desktop: true,
      },
    });
    flushSync();

    const row = document.querySelector<HTMLElement>('[data-path="plain.md"]');
    const actions = row?.querySelector<HTMLButtonElement>(".skr-tree-actions");
    actions?.click();
    await tick();
    document
      .querySelector<HTMLButtonElement>(
        '[data-command-id="tree.note.copy-link"]',
      )
      ?.click();
    await tick();
    expect(document.activeElement).toBe(row);

    row?.focus();
    row?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "F10",
        shiftKey: true,
        bubbles: true,
      }),
    );
    await tick();
    const menu = document.querySelector<HTMLElement>('[role="menu"]');
    menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    menu?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await tick();

    expect(copied).toEqual(["plain.md", "plain.md"]);
    expect(document.activeElement).toBe(row);

    await unmount(component);
  });

  it("returns a cancelled rename dialog to its tree row", async () => {
    const registry = createAppRegistry(undefined, true);
    const context = commandContext({
      renameTreeEntry: async () => {
        await showPromptDialog({
          title: "Rename",
          confirmLabel: "Rename",
        });
      },
    });
    const component = mount(FileTree, {
      target: document.body,
      props: {
        entries,
        expandedPaths: ["Folder"],
        onOpenPath: () => {},
        registry,
        commandContext: () => context,
        desktop: true,
      },
    });
    flushSync();

    const row = document.querySelector<HTMLElement>('[data-path="plain.md"]');
    row?.querySelector<HTMLButtonElement>(".skr-tree-actions")?.click();
    await tick();
    document
      .querySelector<HTMLButtonElement>('[data-command-id="tree.entry.rename"]')
      ?.click();
    await tick();
    document
      .querySelector<HTMLButtonElement>('[data-testid="dialog-cancel"]')
      ?.click();
    await tick();

    expect(document.activeElement).toBe(row);

    await unmount(component);
  });

  it("hands deletion focus to the next surviving tree row", async () => {
    const registry = createAppRegistry(undefined, true);
    const props = reactiveState({
      entries: [...entries],
      expandedPaths: ["Folder"],
      onOpenPath: () => {},
      desktop: true,
      registry,
      commandContext: undefined as (() => CommandContext) | undefined,
    });
    const context = commandContext({
      deleteTreeEntry: async (path, restoreFocus) => {
        const confirmed = await showConfirmDialog({
          title: "Delete",
          message: "Delete this entry?",
          confirmLabel: "Delete",
          destructive: true,
        });
        if (!confirmed) return;
        props.entries = props.entries.filter((entry) => entry.path !== path);
        await tick();
        restoreFocus?.();
      },
    });
    props.commandContext = () => context;
    const component = mount(FileTree, {
      target: document.body,
      props,
    });
    flushSync();

    const removed = document.querySelector<HTMLElement>(
      '[data-path="Folder/one.md"]',
    );
    removed?.querySelector<HTMLButtonElement>(".skr-tree-actions")?.click();
    await tick();
    document
      .querySelector<HTMLButtonElement>('[data-command-id="tree.entry.delete"]')
      ?.click();
    await tick();
    document
      .querySelector<HTMLButtonElement>('[data-testid="dialog-confirm"]')
      ?.click();
    await tick();
    await tick();
    await tick();

    expect(document.activeElement?.getAttribute("data-path")).toBe(
      "Folder/two.md",
    );
    expect(document.activeElement).not.toBe(document.body);

    await unmount(component);
  });
});
