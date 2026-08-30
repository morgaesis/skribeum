import axe from "axe-core";
import { flushSync, mount, tick, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import TabStrip, {
  currentTabDrag,
  setTabDrag,
} from "../../src/lib/TabStrip.svelte";
import type { WorkspaceTab } from "../../src/lib/workspaceState";
import { reactiveState } from "./helpers/reactiveState.svelte";

function tabs(count: number): WorkspaceTab[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `note-${index + 1}.md`,
    viewState: null,
  }));
}

describe("tab strip", () => {
  it("exposes its nested tabs as tablist children without hiding close controls", async () => {
    const component = mount(TabStrip, {
      target: document.body,
      props: {
        tabs: tabs(2),
        activePath: "note-1.md",
        titleSources: {},
        focused: true,
        visible: true,
        paneId: "pane-1",
        onActivate: () => {},
        onClose: () => {},
        onReorder: () => {},
        onNewTab: () => {},
        onAdopt: () => {},
      },
    });
    flushSync();

    const tablist = document.querySelector<HTMLElement>('[role="tablist"]');
    const tabButtons = [
      ...document.querySelectorAll<HTMLElement>('[role="tab"]'),
    ];
    expect(tablist?.getAttribute("aria-owns")?.split(" ")).toEqual(
      tabButtons.map((tab) => tab.id),
    );
    expect(
      document.querySelectorAll<HTMLButtonElement>(".skr-tab-close"),
    ).toHaveLength(2);
    const results = await axe.run(document.body, {
      runOnly: { type: "rule", values: ["aria-required-children"] },
    });
    expect(results.violations).toEqual([]);

    await unmount(component);
  });

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
        visible: true,
        paneId: "pane-1",
        onActivate: () => {},
        onClose: () => {},
        onReorder: () => {},
        onNewTab: () => {},
        onAdopt: () => {},
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

  it("renders one note and exposes activation and close routes", async () => {
    const closed: string[] = [];
    const activated: string[] = [];
    const single = mount(TabStrip, {
      target: document.body,
      props: {
        tabs: tabs(1),
        activePath: "note-1.md",
        titleSources: {},
        focused: true,
        visible: true,
        paneId: "pane-1",
        onActivate: (path: string | null) => activated.push(path ?? ""),
        onClose: (path: string | null) => closed.push(path ?? ""),
        onReorder: () => {},
        onNewTab: () => {},
        onAdopt: () => {},
      },
    });
    flushSync();
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(document.querySelector(".skr-tab-new")).not.toBeNull();
    await unmount(single);

    const component = mount(TabStrip, {
      target: document.body,
      props: {
        tabs: tabs(3),
        activePath: "note-1.md",
        titleSources: { "note-2.md": "# Authored title\n" },
        focused: true,
        visible: true,
        paneId: "pane-1",
        onActivate: (path: string | null) => activated.push(path ?? ""),
        onClose: (path: string | null) => closed.push(path ?? ""),
        onReorder: () => {},
        onNewTab: () => {},
        onAdopt: () => {},
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
        visible: true,
        paneId: "pane-1",
        onActivate: (path: string | null) => activated.push(path ?? ""),
        onClose: () => {},
        onReorder: (from: number, to: number) => reordered.push([from, to]),
        onNewTab: () => {},
        onAdopt: () => {},
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
        visible: true,
        paneId: "pane-1",
        onActivate: () => {},
        onClose: () => {},
        onReorder: () => {},
        onNewTab: () => {},
        onAdopt: () => {},
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

describe("tab strip teardown and pointer-held geometry", () => {
  it("survives the strip disappearing while its geometry effect is queued", async () => {
    const errors: string[] = [];
    const onError = (event: ErrorEvent) => errors.push(event.message);
    window.addEventListener("error", onError);
    const props = reactiveState({
      paneId: "pane-1",
      tabs: tabs(2) as WorkspaceTab[],
      activePath: "note-1.md" as string | null,
      titleSources: {} as Record<string, string>,
      focused: true,
      visible: true,
      onActivate: () => {},
      onClose: () => {},
      onReorder: () => {},
      onNewTab: () => {},
      onAdopt: () => {},
    });
    const component = mount(TabStrip, { target: document.body, props });
    flushSync();

    // The shell drops to one tab and hides the strip in the same update, the
    // sequence that used to dereference a `bind:this` reset to null.
    props.tabs = tabs(1);
    props.activePath = "note-1.md";
    props.visible = false;
    flushSync();
    await tick();
    await tick();

    expect(errors).toEqual([]);
    expect(document.querySelector(".skr-tab-strip")).toBeNull();
    window.removeEventListener("error", onError);
    await unmount(component);
  });

  it("holds tab widths after a close while the pointer stays over the strip", async () => {
    const props = reactiveState({
      paneId: "pane-1",
      tabs: tabs(4) as WorkspaceTab[],
      activePath: "note-1.md" as string | null,
      titleSources: {} as Record<string, string>,
      focused: true,
      visible: true,
      onActivate: () => {},
      onClose: () => {},
      onReorder: () => {},
      onNewTab: () => {},
      onAdopt: () => {},
    });
    const component = mount(TabStrip, { target: document.body, props });
    flushSync();
    for (const [index, shell] of [
      ...document.querySelectorAll<HTMLElement>(".skr-tab-shell"),
    ].entries()) {
      Object.defineProperty(shell, "offsetWidth", {
        configurable: true,
        value: 132,
      });
      Object.defineProperty(shell, "offsetLeft", {
        configurable: true,
        value: index * 132,
      });
    }
    // The strip records geometry on each settled render, so the stubbed
    // layout has to be observed by one before the close is measured.
    props.activePath = "note-2.md";
    flushSync();
    await tick();
    document
      .querySelector<HTMLElement>(".skr-tab-strip")
      ?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));

    props.tabs = tabs(4).slice(1);
    flushSync();
    await tick();

    const held = [...document.querySelectorAll<HTMLElement>(".skr-tab-shell")];
    expect(held).toHaveLength(3);
    for (const shell of held) {
      expect(shell.style.flex).toBe("0 0 132px");
    }

    document
      .querySelector<HTMLElement>(".skr-tab-strip")
      ?.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
    await tick();
    await tick();
    for (const shell of document.querySelectorAll<HTMLElement>(
      ".skr-tab-shell",
    )) {
      expect(shell.style.flex).toBe("");
    }
    await unmount(component);
  });

  it("rotates the roving tabindex with the arrow keys", async () => {
    const component = mount(TabStrip, {
      target: document.body,
      props: {
        paneId: "pane-1",
        tabs: tabs(3),
        activePath: "note-1.md",
        titleSources: {},
        focused: true,
        visible: true,
        onActivate: () => {},
        onClose: () => {},
        onReorder: () => {},
        onNewTab: () => {},
        onAdopt: () => {},
      },
    });
    flushSync();
    const items = document.querySelector<HTMLElement>(".skr-tab-items");
    const stops = () =>
      [...document.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) =>
        tab.getAttribute("tabindex"),
      );
    expect(stops()).toEqual(["0", "-1", "-1"]);

    items?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await tick();
    expect(stops()).toEqual(["-1", "0", "-1"]);

    items?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    await tick();
    expect(stops()).toEqual(["-1", "-1", "0"]);

    items?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    await tick();
    expect(stops()).toEqual(["0", "-1", "-1"]);
    await unmount(component);
  });

  it("renders the empty tab, the new-tab control, and cross-pane adoption", async () => {
    const adopted: Array<[string, string, number]> = [];
    let created = 0;
    const component = mount(TabStrip, {
      target: document.body,
      props: {
        paneId: "pane-2",
        tabs: tabs(2),
        activePath: null,
        emptyTab: true,
        titleSources: {},
        focused: true,
        visible: true,
        onActivate: () => {},
        onClose: () => {},
        onReorder: () => {},
        onNewTab: () => {
          created += 1;
        },
        onAdopt: (origin: { path: string; paneId: string }, index: number) =>
          adopted.push([origin.path, origin.paneId, index]),
      },
    });
    flushSync();

    const stripTabs = [
      ...document.querySelectorAll<HTMLElement>('[role="tab"]'),
    ];
    expect(stripTabs).toHaveLength(3);
    expect(stripTabs[2]?.dataset.emptyTab).toBe("true");
    expect(stripTabs[2]?.getAttribute("aria-selected")).toBe("true");

    document.querySelector<HTMLButtonElement>(".skr-tab-new")?.click();
    expect(created).toBe(1);

    setTabDrag({ path: "moved.md", paneId: "pane-1" });
    const target = document.querySelectorAll<HTMLElement>(".skr-tab-shell")[0];
    if (target !== undefined) {
      target.getBoundingClientRect = () => ({ left: 0, width: 120 }) as DOMRect;
    }
    // Left of the target tab's midpoint, so the tab lands before it.
    target?.dispatchEvent(
      new MouseEvent("dragover", { bubbles: true, clientX: 20 }),
    );
    target?.dispatchEvent(new Event("drop", { bubbles: true }));
    expect(adopted).toEqual([["moved.md", "pane-1", 0]]);
    expect(currentTabDrag()).toBeNull();
    await unmount(component);
  });

  it("leaves a ghost of a closed tab that no count or index can see", async () => {
    document.documentElement.style.setProperty(
      "--skr-motion-state-duration",
      "50ms",
    );
    const props = reactiveState({
      paneId: "pane-1",
      tabs: tabs(3) as WorkspaceTab[],
      activePath: "note-1.md" as string | null,
      titleSources: {} as Record<string, string>,
      focused: true,
      visible: true,
      onActivate: () => {},
      onClose: () => {},
      onReorder: () => {},
      onNewTab: () => {},
      onAdopt: () => {},
    });
    const component = mount(TabStrip, { target: document.body, props });
    flushSync();
    // jsdom lays nothing out, so the slot the ghost inherits is stubbed.
    for (const [index, shell] of [
      ...document.querySelectorAll<HTMLElement>(".skr-tab-shell"),
    ].entries()) {
      Object.defineProperty(shell, "offsetWidth", {
        configurable: true,
        value: 120,
      });
      Object.defineProperty(shell, "offsetLeft", {
        configurable: true,
        value: index * 120,
      });
    }
    props.activePath = "note-1.md";
    flushSync();
    await tick();

    props.tabs = [tabs(3)[0], tabs(3)[2]].filter(
      (tab): tab is WorkspaceTab => tab !== undefined,
    );
    flushSync();
    await tick();

    const ghost = document.querySelector<HTMLElement>(".skr-tab-exiting");
    expect(ghost).not.toBeNull();
    expect(ghost?.textContent).toContain("note-2");
    // Its slot is the one the closed tab held.
    expect(ghost?.style.left).toBe("120px");
    expect(ghost?.style.width).toBe("120px");
    // It is not a tab: no role, no tab stop, and no place in the tablist.
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
    expect(ghost?.getAttribute("role")).toBeNull();
    expect(ghost?.getAttribute("aria-hidden")).toBe("true");
    expect(
      document
        .querySelector('[role="tablist"]')
        ?.getAttribute("aria-owns")
        ?.split(" "),
    ).toHaveLength(2);
    expect(ghost?.closest("[role=tab]")).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(document.querySelector(".skr-tab-exiting")).toBeNull();
    document.documentElement.style.removeProperty(
      "--skr-motion-state-duration",
    );
    await unmount(component);
  });
});
