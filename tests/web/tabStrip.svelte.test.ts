import { flushSync, mount, tick, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import TabStrip from "../../src/lib/TabStrip.svelte";
import type { WorkspaceTab } from "../../src/lib/workspaceState";

function tabs(count: number): WorkspaceTab[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `note-${index + 1}.md`,
    viewState: null,
  }));
}

describe("tab strip", () => {
  it("keeps keyboard close controls focusable without pointer focus theft", async () => {
    const origin = document.createElement("button");
    origin.type = "button";
    document.body.append(origin);
    const component = mount(TabStrip, {
      target: document.body,
      props: {
        tabs: tabs(2),
        activePath: "note-1.md",
        titleSources: {},
        focused: true,
        onActivate: () => {},
        onClose: () => {},
        onReorder: () => {},
      },
    });
    flushSync();

    const close = document.querySelector<HTMLButtonElement>(
      '.skr-tab-active [data-command-id="tab.close"]',
    );
    expect(close).not.toBeNull();
    close?.focus();
    expect(document.activeElement).toBe(close);

    origin.focus();
    close?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, button: 0 }),
    );
    expect(document.activeElement).toBe(origin);
    await unmount(component);
  });

  it("stays absent for one note and exposes activation and close routes", async () => {
    const closed: string[] = [];
    const activated: string[] = [];
    const single = mount(TabStrip, {
      target: document.body,
      props: {
        tabs: tabs(1),
        activePath: "note-1.md",
        titleSources: {},
        focused: true,
        onActivate: (path: string) => activated.push(path),
        onClose: (path: string) => closed.push(path),
        onReorder: () => {},
      },
    });
    flushSync();
    expect(document.querySelector('[role="tablist"]')).toBeNull();
    await unmount(single);

    const component = mount(TabStrip, {
      target: document.body,
      props: {
        tabs: tabs(3),
        activePath: "note-1.md",
        titleSources: { "note-2.md": "# Authored title\n" },
        focused: true,
        onActivate: (path: string) => activated.push(path),
        onClose: (path: string) => closed.push(path),
        onReorder: () => {},
      },
    });
    flushSync();
    const tabButtons =
      document.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabButtons[1]?.textContent).toContain("Authored title");
    tabButtons[1]?.click();
    tabButtons[2]?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 1 }),
    );
    document.querySelector<HTMLButtonElement>(".skr-tab-close")?.click();
    expect(activated).toEqual(["note-2.md"]);
    expect(closed).toEqual(["note-3.md", "note-1.md"]);
    await unmount(component);
  });

  it("reports drag reorder positions and lists every overflowed tab", async () => {
    const reordered: Array<[number, number]> = [];
    const activated: string[] = [];
    const component = mount(TabStrip, {
      target: document.body,
      props: {
        tabs: tabs(8),
        activePath: "note-1.md",
        titleSources: {},
        focused: true,
        onActivate: (path: string) => activated.push(path),
        onClose: () => {},
        onReorder: (from: number, to: number) => reordered.push([from, to]),
      },
    });
    flushSync();
    const itemsElement = document.querySelector<HTMLElement>(".skr-tab-items");
    expect(itemsElement).not.toBeNull();
    if (itemsElement === null) return;
    Object.defineProperties(itemsElement, {
      clientWidth: { configurable: true, value: 640 },
      scrollWidth: { configurable: true, value: 832 },
    });
    window.dispatchEvent(new Event("resize"));
    await tick();
    const shells = document.querySelectorAll<HTMLElement>(".skr-tab-shell");
    const transfer = { setData: () => {}, effectAllowed: "none" };
    const start = new Event("dragstart", { bubbles: true });
    Object.defineProperty(start, "dataTransfer", { value: transfer });
    shells[0]?.dispatchEvent(start);
    if (shells[7] !== undefined) {
      shells[7].getBoundingClientRect = () =>
        ({ left: 0, width: 50 }) as DOMRect;
    }
    const over = new MouseEvent("dragover", { bubbles: true, clientX: 100 });
    shells[7]?.dispatchEvent(over);
    shells[7]?.dispatchEvent(new Event("drop", { bubbles: true }));
    expect(reordered).toEqual([[0, 8]]);

    itemsElement.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 48 }),
    );
    expect(itemsElement.scrollLeft).toBe(48);

    document.querySelector<HTMLButtonElement>(".skr-tab-list")?.click();
    await tick();
    const items = document.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]',
    );
    expect(items).toHaveLength(8);
    items[5]?.click();
    expect(activated).toEqual(["note-6.md"]);
    await unmount(component);
  });

  it("dismisses the all-tabs menu on a click away from it", async () => {
    const component = mount(TabStrip, {
      target: document.body,
      props: {
        tabs: tabs(8),
        activePath: "note-1.md",
        titleSources: {},
        focused: true,
        onActivate: () => {},
        onClose: () => {},
        onReorder: () => {},
      },
    });
    flushSync();
    const itemsElement = document.querySelector<HTMLElement>(".skr-tab-items");
    if (itemsElement === null) return;
    Object.defineProperties(itemsElement, {
      clientWidth: { configurable: true, value: 640 },
      scrollWidth: { configurable: true, value: 832 },
    });
    window.dispatchEvent(new Event("resize"));
    await tick();

    document.querySelector<HTMLButtonElement>(".skr-tab-list")?.click();
    await tick();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    // A press anywhere outside the menu (and outside the button that
    // opened it) dismisses it, the founder's reported defect: the menu
    // used to have no outside-press handling at all and stayed open.
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    await tick();
    await tick();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await unmount(component);
  });
});
