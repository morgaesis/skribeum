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

/**
 * jsdom lays nothing out, so the strip's own measurements are answered here
 * by the one layout rule the strip depends on: a tab renders at the width it
 * is pinned to, and at the width the open set gives it otherwise, with each
 * tab starting where the tabs and gaps before it end. A stub that ignored
 * the pinned width would let a settle that never left its starting geometry
 * pass, which is the failure these tests exist to catch.
 */
function stubStripLayout(naturalWidth: () => number): void {
  for (const shell of document.querySelectorAll<HTMLElement>(
    ".skr-tab-shell",
  )) {
    if (Object.getOwnPropertyDescriptor(shell, "offsetWidth") !== undefined) {
      continue;
    }
    Object.defineProperty(shell, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        const pinned = /0 0 (\d+(?:\.\d+)?)px/.exec(this.style.flex);
        return pinned === null
          ? naturalWidth()
          : Number.parseFloat(pinned[1] ?? "0");
      },
    });
    Object.defineProperty(shell, "offsetLeft", {
      configurable: true,
      get(this: HTMLElement) {
        let left = 0;
        for (const other of document.querySelectorAll<HTMLElement>(
          ".skr-tab-shell",
        )) {
          if (other === this) break;
          left +=
            other.offsetWidth +
            Number.parseFloat(other.style.marginInlineStart || "0") +
            Number.parseFloat(other.style.marginInlineEnd || "0");
        }
        return left + Number.parseFloat(this.style.marginInlineStart || "0");
      },
    });
  }
}

/** The distinct inline widths a tab renders at, in the order they arrive. */
async function pinnedWidthSequence(
  shell: HTMLElement,
  steps = 12,
): Promise<string[]> {
  const seen: string[] = [];
  for (let step = 0; step < steps; step += 1) {
    if (seen.at(-1) !== shell.style.flex) seen.push(shell.style.flex);
    await tick();
  }
  return seen;
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

  it("draws one note's strip and exposes activation and close routes", async () => {
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
    // A single open note still has a strip: its tab, its close control and
    // the new-tab control are all reachable without opening a second note.
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(document.querySelector(".skr-tab-close")).not.toBeNull();
    const newTab = document.querySelector<HTMLElement>(".skr-tab-new");
    expect(newTab).not.toBeNull();
    // The new-tab control sits in the scrolling run of tabs, immediately
    // after the last one, rather than at the strip's far edge.
    const runChildren = [...(newTab?.parentElement?.children ?? [])];
    const lastShell = [
      ...document.querySelectorAll<HTMLElement>(".skr-tab-shell"),
    ].at(-1);
    expect(newTab?.parentElement?.classList.contains("skr-tab-items")).toBe(
      true,
    );
    expect(lastShell === undefined ? -1 : runChildren.indexOf(lastShell)).toBe(
      runChildren.indexOf(newTab as HTMLElement) - 1,
    );
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
      // Nothing travels under a resting pointer: the gap closes in the same
      // frame, so the next tab's close control lands under the pointer
      // instead of arriving under it at the end of an animation.
      expect(shell.style.marginInlineStart).toBe("");
    }
    expect(
      document
        .querySelector(".skr-tab-items")
        ?.classList.contains("skr-tab-items-settling"),
    ).toBe(false);

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
      "--skr-motion-panel-duration",
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
    // Its slot is the one the closed tab held, and it leaves that slot the
    // way a tab arrives in one, reversed: the ghost collapses to nothing
    // instead of blinking out of a slot that stays its full width.
    expect(ghost?.style.left).toBe("120px");
    expect(ghost?.dataset.dismissing).toBe("true");
    expect(ghost?.style.width).toBe("0px");
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
      "--skr-motion-panel-duration",
    );
    await unmount(component);
  });

  it("settles a close from the widths the strip had to the ones it gains", async () => {
    document.documentElement.style.setProperty(
      "--skr-motion-panel-duration",
      "80ms",
    );
    // The strip is 480px wide and its tabs share it equally, so closing one
    // of four widens the other three from 120px to 160px.
    const natural = () =>
      480 / document.querySelectorAll(".skr-tab-shell").length;
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
    stubStripLayout(natural);
    // One settled render, so the strip has geometry to travel from.
    props.activePath = "note-2.md";
    flushSync();
    await tick();

    // The pointer is nowhere near the strip, so the close relayouts: the
    // three survivors go from the 120px each they render at to the 160px
    // each the strip's width now gives them.
    props.tabs = tabs(4).slice(1);
    flushSync();
    const survivor = document.querySelector<HTMLElement>(".skr-tab-shell");
    expect(survivor).not.toBeNull();
    if (survivor === null) return;
    const widths = await pinnedWidthSequence(survivor);
    const items = document.querySelector<HTMLElement>(".skr-tab-items");
    // It starts where the user last saw it and travels to the new width,
    // rather than arriving at the new width in one frame.
    expect(widths).toContain("0 0 120px");
    expect(widths).toContain("0 0 160px");
    expect(widths.indexOf("0 0 120px")).toBeLessThan(
      widths.indexOf("0 0 160px"),
    );
    expect(items?.classList.contains("skr-tab-items-settling")).toBe(true);
    // The gap the closed tab left is carried by the tab that followed it,
    // so the travel starts from the layout the strip actually had.
    expect(survivor.offsetLeft).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(survivor.style.flex).toBe("");
    expect(items?.classList.contains("skr-tab-items-settling")).toBe(false);
    document.documentElement.style.removeProperty(
      "--skr-motion-panel-duration",
    );
    await unmount(component);
  });

  it("collapses the gap a closed tab leaves over the same settle", async () => {
    document.documentElement.style.setProperty(
      "--skr-motion-panel-duration",
      "80ms",
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
    stubStripLayout(() => 120);
    props.activePath = "note-1.md";
    flushSync();
    await tick();

    // Close the middle tab: the tab that followed it starts the settle
    // where it was, one closed tab's width to the right of its new slot.
    props.tabs = [tabs(3)[0], tabs(3)[2]].filter(
      (tab): tab is WorkspaceTab => tab !== undefined,
    );
    flushSync();
    const follower = [
      ...document.querySelectorAll<HTMLElement>(".skr-tab-shell"),
    ][1];
    expect(follower).not.toBeUndefined();
    if (follower === undefined) return;
    const gaps: string[] = [];
    for (let step = 0; step < 12; step += 1) {
      if (gaps.at(-1) !== follower.style.marginInlineStart) {
        gaps.push(follower.style.marginInlineStart);
      }
      await tick();
    }
    expect(gaps).toContain("120px");
    expect(gaps.at(-1)).toBe("");
    expect(gaps.indexOf("120px")).toBeLessThan(gaps.length - 1);

    await new Promise((resolve) => setTimeout(resolve, 140));
    expect(follower.offsetLeft).toBe(120);
    document.documentElement.style.removeProperty(
      "--skr-motion-panel-duration",
    );
    await unmount(component);
  });

  it("lands the indicator on its tab even when the settle renders nothing", async () => {
    document.documentElement.style.setProperty(
      "--skr-motion-panel-duration",
      "60ms",
    );
    const natural = () =>
      360 / document.querySelectorAll(".skr-tab-shell").length;
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
    stubStripLayout(natural);
    props.activePath = "note-3.md";
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const indicator = document.querySelector<HTMLElement>(
      ".skr-tab-active-indicator",
    );
    expect(indicator).not.toBeNull();
    if (indicator === null) return;

    // A main thread busy enough to eat the whole settle renders none of it,
    // which is what dropping every frame stands in for here. The strip
    // still has one resting invariant, and this is it.
    const frames = window.requestAnimationFrame;
    window.requestAnimationFrame = (() => 0) as typeof frames;
    try {
      props.tabs = tabs(3).slice(1);
      flushSync();
      // Where a rendered settle would have put the bar mid-travel, a
      // dropped one leaves it wherever the strip last wrote it, which is
      // not on any tab.
      indicator.style.left = "999px";
      indicator.style.width = "9px";
      await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      window.requestAnimationFrame = frames;
    }
    const active = [
      ...document.querySelectorAll<HTMLElement>(".skr-tab-shell"),
    ].at(-1);
    expect(active?.offsetLeft).toBe(180);
    expect(indicator.style.left).toBe(`${active?.offsetLeft}px`);
    expect(indicator.style.width).toBe(`${active?.offsetWidth}px`);

    document.documentElement.style.removeProperty(
      "--skr-motion-panel-duration",
    );
    await unmount(component);
  });

  it("keeps the active indicator on its own tab through a settle", async () => {
    document.documentElement.style.setProperty(
      "--skr-motion-panel-duration",
      "120ms",
    );
    const natural = () =>
      360 / document.querySelectorAll(".skr-tab-shell").length;
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
    stubStripLayout(natural);
    // A settled render on the stubbed layout, with the indicator's own
    // travel to the last tab finished before the close is measured.
    props.activePath = "note-3.md";
    flushSync();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const indicator = document.querySelector<HTMLElement>(
      ".skr-tab-active-indicator",
    );
    expect(indicator).not.toBeNull();
    if (indicator === null) return;
    expect(indicator.style.left).toBe("240px");

    // Close the first tab: the active tab both travels left and widens.
    props.tabs = tabs(3).slice(1);
    flushSync();
    await tick();
    await tick();
    const active = [
      ...document.querySelectorAll<HTMLElement>(".skr-tab-shell"),
    ].at(-1);
    expect(active).not.toBeUndefined();
    if (active === undefined) return;

    // A settled strip is laid out by the browser frame by frame, so the
    // only way the bar can be on its tab in every one of them is to read
    // the tab's rendered geometry each frame. Standing in for the frames
    // the browser would paint, the tab is moved mid-settle: the bar has to
    // follow it there, not sit at the destination it was told about once.
    const frame = () =>
      new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    for (const [left, width] of [
      [150, 150],
      [110, 165],
    ]) {
      Object.defineProperty(active, "offsetLeft", {
        configurable: true,
        value: left,
      });
      Object.defineProperty(active, "offsetWidth", {
        configurable: true,
        value: width,
      });
      await frame();
      expect(indicator.style.left).toBe(`${left}px`);
      expect(indicator.style.width).toBe(`${width}px`);
    }

    // The tracking is bounded by the settle: once it is over, the bar is
    // left where the strip put it rather than following forever.
    await new Promise((resolve) => setTimeout(resolve, 180));
    Object.defineProperty(active, "offsetLeft", {
      configurable: true,
      value: 999,
    });
    await frame();
    await frame();
    expect(indicator.style.left).toBe("110px");

    document.documentElement.style.removeProperty(
      "--skr-motion-panel-duration",
    );
    await unmount(component);
  });
});
