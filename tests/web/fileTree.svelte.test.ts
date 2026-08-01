import { flushSync, mount, tick, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import FileTree from "../../src/lib/FileTree.svelte";
import type { TreeEntry } from "../../src/lib/ipc/bindings";

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
    expect(tree.textContent).toContain("Note 0000.md");
    expect(tree.textContent).not.toContain("Note 1000.md");

    setViewport(tree, ROW_HEIGHT * 12, ROW_HEIGHT * 1_000);
    expect(tree.textContent).toContain("Note 1000.md");
    expect(tree.textContent).not.toContain("Note 0500.md");

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
    expect(last?.textContent).toContain("Note 1999.md");
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
    ).toContain("Note 0000.md");
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
