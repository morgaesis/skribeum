// The motion contract on rendered output: these tests inject the real
// stylesheets and read computed style, so a dead rule or a wrong duration
// fails here instead of passing as markup that merely looks right.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, tick, unmount } from "svelte";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import Dialog from "../../src/lib/Dialog.svelte";
import FileTree from "../../src/lib/FileTree.svelte";
import type { TreeEntry } from "../../src/lib/ipc/bindings";
import TabStrip from "../../src/lib/TabStrip.svelte";
import type { WorkspaceTab } from "../../src/lib/workspaceState";

const directory = path.dirname(fileURLToPath(import.meta.url));

function stylesheetText(relative: string): string {
  return readFileSync(path.join(directory, "..", "..", relative), "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("@import"))
    .join("\n");
}

let injectedStyles: HTMLStyleElement;

beforeAll(() => {
  injectedStyles = document.createElement("style");
  injectedStyles.textContent =
    stylesheetText("src/lib/themes/theme.css") + stylesheetText("src/app.css");
  document.head.append(injectedStyles);
});

afterAll(() => {
  injectedStyles.remove();
});

afterEach(() => {
  delete document.documentElement.dataset.animations;
  document.body.replaceChildren();
});

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** The computed transition with source line breaks collapsed. */
function transitionOf(element: Element): string {
  return getComputedStyle(element).transition.replace(/\s+/g, " ");
}

function surfaceProbe(variant: string): HTMLElement {
  const probe = document.createElement("div");
  probe.dataset.motionSurface = variant;
  document.body.append(probe);
  return probe;
}

describe("transient surface exits", () => {
  it("resolves the three motion class durations from the theme", () => {
    const probe = surfaceProbe("centered");
    const style = getComputedStyle(probe);
    expect(style.getPropertyValue("--skr-motion-state-duration").trim()).toBe(
      "50ms",
    );
    expect(style.getPropertyValue("--skr-motion-surface-duration").trim()).toBe(
      "120ms",
    );
    expect(style.getPropertyValue("--skr-motion-panel-duration").trim()).toBe(
      "160ms",
    );
    expect(style.getPropertyValue("--skr-motion-distance").trim()).toBe(
      "0.25rem",
    );
  });

  it("mirrors each entrance transform during an exit on the 50ms state clock", () => {
    const mirrors: Array<[string, string]> = [
      ["centered", "scale(0.98)"],
      ["anchored-top", "translateY(calc(-1 * var(--skr-motion-distance)))"],
      ["anchored-bottom", "translateY(var(--skr-motion-distance))"],
    ];
    for (const [variant, mirroredTransform] of mirrors) {
      const probe = surfaceProbe(variant);
      // Entrance start state and settled state first.
      expect(getComputedStyle(probe).transform, variant).toBe(
        mirroredTransform,
      );
      probe.dataset.motionEntered = "true";
      expect(getComputedStyle(probe).transform, variant).toBe("none");
      // The exit reverses the entrance transform alongside the fade.
      probe.dataset.motionExiting = "true";
      const exiting = getComputedStyle(probe);
      expect(exiting.transform, variant).toBe(mirroredTransform);
      expect(exiting.opacity, variant).toBe("0");
      expect(exiting.transition, variant).toContain(
        "opacity var(--skr-motion-state-duration)",
      );
      expect(exiting.transition, variant).toContain(
        "transform var(--skr-motion-state-duration)",
      );
      expect(exiting.transition, variant).not.toContain(
        "--skr-motion-surface-duration",
      );
    }
  });

  it("keeps scrim and fade exits opacity-only", () => {
    for (const variant of ["scrim", "fade"]) {
      const probe = surfaceProbe(variant);
      probe.dataset.motionEntered = "true";
      probe.dataset.motionExiting = "true";
      const exiting = getComputedStyle(probe);
      expect(exiting.transform, variant).toBe("none");
      expect(exiting.transition, variant).toContain(
        "opacity var(--skr-motion-state-duration)",
      );
      expect(exiting.transition, variant).not.toContain("transform");
    }
  });

  it("zeroes every motion class when the animations toggle is off", () => {
    document.documentElement.dataset.animations = "false";
    const probe = surfaceProbe("centered");
    const style = getComputedStyle(probe);
    expect(style.getPropertyValue("--skr-motion-state-duration").trim()).toBe(
      "0ms",
    );
    expect(style.getPropertyValue("--skr-motion-surface-duration").trim()).toBe(
      "0ms",
    );
    expect(style.getPropertyValue("--skr-motion-panel-duration").trim()).toBe(
      "0ms",
    );
  });

  it("keeps a dialog rendered through its exit with the mirrored transform live", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const component = mount(Dialog, {
      target: document.body,
      props: {
        kind: "confirm" as const,
        title: "Delete this vault entry?",
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        onConfirm,
        onCancel,
      },
    });
    flushSync();
    await tick();
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="dialog"]',
    );
    const backdrop = document.querySelector<HTMLElement>(
      '[data-testid="dialog-backdrop"]',
    );
    expect(dialog).not.toBeNull();
    expect(backdrop).not.toBeNull();
    if (dialog === null || backdrop === null) return;
    expect(dialog.dataset.motionEntered).toBe("true");
    // Give the dialog a resolvable duration: the environment cannot resolve
    // the var()-based shorthand, which would otherwise finish the exit
    // synchronously and hide the mid-exit state this test observes.
    dialog.style.transitionDuration = "50ms";

    dialog.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    // Mid-exit: still rendered, marked exiting, transform mirrored, and the
    // dismissal callback not yet delivered.
    expect(onCancel).not.toHaveBeenCalled();
    expect(dialog.dataset.motionExiting).toBe("true");
    expect(backdrop.dataset.motionExiting).toBe("true");
    expect(getComputedStyle(dialog).transform).toBe("scale(0.98)");
    expect(getComputedStyle(backdrop).transform).toBe("none");
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    await unmount(component);
  });

  it("dismisses a dialog synchronously when motion is zero", async () => {
    document.documentElement.dataset.animations = "false";
    const onCancel = vi.fn();
    const component = mount(Dialog, {
      target: document.body,
      props: {
        kind: "confirm" as const,
        title: "Delete this vault entry?",
        confirmLabel: "Delete",
        cancelLabel: "Cancel",
        onConfirm: () => {},
        onCancel,
      },
    });
    flushSync();
    await tick();
    document
      .querySelector<HTMLElement>('[data-testid="dialog"]')
      ?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    expect(onCancel).toHaveBeenCalledTimes(1);
    await unmount(component);
  });
});

const treeEntries: TreeEntry[] = [
  { path: "Folder", kind: "directory", hidden: false },
  { path: "Folder/one.md", kind: "note", hidden: false },
  { path: "Folder/two.md", kind: "note", hidden: false },
  { path: "manual.pdf", kind: "file", hidden: false },
  { path: "plain.md", kind: "note", hidden: false },
];

const ROW_HEIGHT = 28;

function treeRow(pathName: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-path="${pathName}"]`);
}

describe("file tree folder reveal", () => {
  it("fades revealed rows in and slides displaced rows from their old slot on the panel clock", async () => {
    const component = mount(FileTree, {
      target: document.body,
      props: { entries: treeEntries, onOpenPath: () => {} },
    });
    flushSync();

    const folder = treeRow("Folder");
    expect(folder).not.toBeNull();
    expect(treeRow("Folder/one.md")).toBeNull();
    folder?.click();
    await tick();
    await tick();

    // The chevron flips in the same flush: its glyph swap is a state, not a
    // surface, and carries no transition at all.
    const chevron = folder?.querySelector<SVGElement>(".skr-tree-leading svg");
    expect(chevron?.classList.contains("skr-tree-chevron-open")).toBe(true);
    expect(
      Number.parseFloat(
        getComputedStyle(chevron as Element).transitionDuration,
      ) || 0,
    ).toBe(0);

    // Start state: revealed children are transparent at their final slot,
    // displaced rows are translated back to their previous slot. Geometry
    // (top) is already final, so nothing layout-bound ever animates.
    const revealed = treeRow("Folder/one.md");
    const displaced = treeRow("plain.md");
    expect(revealed).not.toBeNull();
    expect(displaced).not.toBeNull();
    if (revealed === null || displaced === null) return;
    expect(revealed.style.opacity).toBe("0");
    expect(displaced.style.transform).toBe(`translateY(${-2 * ROW_HEIGHT}px)`);
    expect(revealed.getAttribute("role")).toBe("treeitem");
    expect(revealed.getAttribute("aria-level")).toBe("2");

    // One frame later the rows settle toward their final state through a
    // transform-and-opacity transition on the panel duration and easing.
    await nextFrame();
    expect(revealed.style.opacity).toBe("");
    expect(displaced.style.transform).toBe("");
    for (const element of [revealed, displaced]) {
      const transition = transitionOf(element);
      expect(transition).toContain(
        "transform var(--skr-motion-panel-duration) var(--skr-motion-panel-easing)",
      );
      expect(transition).toContain(
        "opacity var(--skr-motion-panel-duration) var(--skr-motion-panel-easing)",
      );
    }

    // After the panel duration the inline choreography is fully released.
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(displaced.style.transition).toBe("");
    expect(revealed.style.transition).toBe("");

    await unmount(component);
  });

  it("keeps collapsed rows as inert fading ghosts the ARIA tree and keyboard never see", async () => {
    const component = mount(FileTree, {
      target: document.body,
      props: {
        entries: treeEntries,
        expandedPaths: ["Folder"],
        onOpenPath: () => {},
      },
    });
    flushSync();
    expect(treeRow("Folder/one.md")).not.toBeNull();

    const folder = treeRow("Folder");
    folder?.click();
    await tick();
    await tick();

    // The real tree updates instantly: the hidden rows leave the ARIA tree
    // in the same flush and only presentation ghosts remain to fade.
    expect(folder?.getAttribute("aria-expanded")).toBe("false");
    expect(treeRow("Folder/one.md")).toBeNull();
    const ghosts = [
      ...document.querySelectorAll<HTMLElement>(".skr-tree-ghost"),
    ];
    expect(ghosts).toHaveLength(2);
    for (const ghost of ghosts) {
      expect(ghost.getAttribute("role")).toBe("presentation");
      expect(ghost.getAttribute("aria-hidden")).toBe("true");
      expect(ghost.hasAttribute("inert")).toBe(true);
      expect(getComputedStyle(ghost).pointerEvents).toBe("none");
    }
    const displaced = treeRow("plain.md");
    expect(displaced?.style.transform).toBe(`translateY(${2 * ROW_HEIGHT}px)`);

    // Keyboard travel walks the real rows, never a ghost.
    folder?.focus();
    folder?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await tick();
    expect((document.activeElement as HTMLElement | null)?.dataset.path).toBe(
      "manual.pdf",
    );

    // The ghosts fade on the panel clock, then leave the DOM entirely.
    await nextFrame();
    for (const ghost of ghosts) {
      expect(ghost.style.opacity).toBe("0");
      expect(transitionOf(ghost)).toContain(
        "opacity var(--skr-motion-panel-duration) var(--skr-motion-panel-easing)",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(document.querySelector(".skr-tree-ghost")).toBeNull();

    await unmount(component);
  });

  it("lands a toggle in its final state with no choreography when motion is zero", async () => {
    document.documentElement.dataset.animations = "false";
    const component = mount(FileTree, {
      target: document.body,
      props: {
        entries: treeEntries,
        expandedPaths: ["Folder"],
        onOpenPath: () => {},
      },
    });
    flushSync();

    treeRow("Folder")?.click();
    await tick();
    await tick();
    expect(treeRow("Folder/one.md")).toBeNull();
    expect(document.querySelector(".skr-tree-ghost")).toBeNull();
    expect(treeRow("plain.md")?.style.transform ?? "").toBe("");

    await unmount(component);
  });
});

function stripTabs(count: number): WorkspaceTab[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `note-${index + 1}.md`,
    viewState: null,
  }));
}

describe("tab strip reorder", () => {
  it("opens the landing gap with panel-clock translates while the dragged tab stays unanimated", async () => {
    const reordered: Array<[number, number]> = [];
    const component = mount(TabStrip, {
      target: document.body,
      props: {
        tabs: stripTabs(5),
        activePath: "note-1.md",
        titleSources: {},
        focused: true,
        onActivate: () => {},
        onClose: () => {},
        onReorder: (from: number, to: number) => reordered.push([from, to]),
      },
    });
    flushSync();

    const shells = [
      ...document.querySelectorAll<HTMLElement>(".skr-tab-shell"),
    ];
    expect(shells).toHaveLength(5);
    const dragged = shells[0];
    if (dragged === undefined) return;
    Object.defineProperty(dragged, "offsetWidth", {
      configurable: true,
      value: 120,
    });
    const start = new Event("dragstart", { bubbles: true });
    Object.defineProperty(start, "dataTransfer", {
      value: { setData: () => {}, effectAllowed: "none" },
    });
    dragged.dispatchEvent(start);
    if (shells[2] !== undefined) {
      shells[2].getBoundingClientRect = () =>
        ({ left: 0, width: 50 }) as DOMRect;
    }
    shells[2]?.dispatchEvent(
      new MouseEvent("dragover", { bubbles: true, clientX: 100 }),
    );
    flushSync();

    // Passed-over tabs translate to open the dragged tab's slot; tabs beyond
    // the insertion point hold still.
    expect(getComputedStyle(shells[1] as Element).transform).toBe(
      "translateX(-120px)",
    );
    expect(getComputedStyle(shells[2] as Element).transform).toBe(
      "translateX(-120px)",
    );
    expect((shells[3] as HTMLElement).style.transform).toBe("translateX(0px)");
    expect((shells[4] as HTMLElement).style.transform).toBe("translateX(0px)");

    // The reflow rides the panel clock as a compositor-only transform; the
    // dragged tab itself carries no transition, so it can only ever follow
    // the pointer 1:1.
    const items = document.querySelector<HTMLElement>(".skr-tab-items");
    expect(items?.classList.contains("skr-tab-items-reordering")).toBe(true);
    expect(transitionOf(shells[1] as Element)).toContain(
      "transform var(--skr-motion-panel-duration) var(--skr-motion-panel-easing)",
    );
    expect(dragged.classList.contains("skr-tab-dragging")).toBe(true);
    expect(transitionOf(dragged)).not.toContain("--skr-motion-panel-duration");
    expect(dragged.style.transform).toBe("");

    // Dropping commits the order and releases every offset instantly.
    shells[2]?.dispatchEvent(new Event("drop", { bubbles: true }));
    flushSync();
    expect(reordered).toEqual([[0, 3]]);
    expect(items?.classList.contains("skr-tab-items-reordering")).toBe(false);
    for (const shell of shells) {
      expect(shell.style.transform).toBe("");
    }

    await unmount(component);
  });

  it("shifts tabs toward a leftward landing gap when dragging backwards", () => {
    const component = mount(TabStrip, {
      target: document.body,
      props: {
        tabs: stripTabs(5),
        activePath: "note-1.md",
        titleSources: {},
        focused: true,
        onActivate: () => {},
        onClose: () => {},
        onReorder: () => {},
      },
    });
    flushSync();

    const shells = [
      ...document.querySelectorAll<HTMLElement>(".skr-tab-shell"),
    ];
    const dragged = shells[3];
    if (dragged === undefined) return;
    Object.defineProperty(dragged, "offsetWidth", {
      configurable: true,
      value: 96,
    });
    const start = new Event("dragstart", { bubbles: true });
    Object.defineProperty(start, "dataTransfer", {
      value: { setData: () => {}, effectAllowed: "none" },
    });
    dragged.dispatchEvent(start);
    if (shells[1] !== undefined) {
      shells[1].getBoundingClientRect = () =>
        ({ left: 0, width: 50 }) as DOMRect;
    }
    shells[1]?.dispatchEvent(
      new MouseEvent("dragover", { bubbles: true, clientX: 10 }),
    );
    flushSync();

    expect(getComputedStyle(shells[1] as Element).transform).toBe(
      "translateX(96px)",
    );
    expect(getComputedStyle(shells[2] as Element).transform).toBe(
      "translateX(96px)",
    );
    expect((shells[4] as HTMLElement).style.transform).toBe("translateX(0px)");
    expect(dragged.style.transform).toBe("");

    dragged.dispatchEvent(new Event("dragend", { bubbles: true }));
    flushSync();
    for (const shell of shells) {
      expect(shell.style.transform).toBe("");
    }

    void unmount(component);
  });
});
