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
import { reactiveProps } from "./helpers/reactiveProps.svelte";

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

function loadedDeclarations(selector: string, property: string): string[] {
  const values: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (
        rule instanceof CSSStyleRule &&
        rule.selectorText
          .split(",")
          .map((value) => value.trim())
          .includes(selector)
      ) {
        const value = rule.style.getPropertyValue(property).trim();
        if (value !== "") values.push(value);
      }
      if ("cssRules" in rule) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of document.styleSheets) visit(sheet.cssRules);
  return values;
}

function loadedMediaDeclarations(
  mediaQuery: string,
  selector: string,
  property: string,
): string[] {
  const values: string[] = [];
  const visit = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (
        rule instanceof CSSStyleRule &&
        rule.selectorText
          .split(",")
          .map((value) => value.trim())
          .includes(selector)
      ) {
        const value = rule.style.getPropertyValue(property).trim();
        if (value !== "") values.push(value);
      }
      if ("cssRules" in rule) {
        visit((rule as CSSGroupingRule).cssRules);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule instanceof CSSMediaRule && rule.conditionText === mediaQuery) {
        visit(rule.cssRules);
      }
    }
  }
  return values;
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

describe("reveal marker glyph motion", () => {
  function markerProbe(): HTMLElement {
    const probe = document.createElement("span");
    probe.className = "cm-skr-reveal-marker";
    probe.textContent = "# ";
    document.body.append(probe);
    return probe;
  }

  it("rests hidden with an opacity and reading-direction translate ready to animate", () => {
    const marker = markerProbe();
    const style = getComputedStyle(marker);
    expect(style.opacity).toBe("0");
    expect(style.transform).toBe("translateX(var(--skr-motion-distance))");
    expect(transitionOf(marker)).toContain(
      "opacity var(--skr-motion-state-duration) var(--skr-motion-state-easing)",
    );
    expect(transitionOf(marker)).toContain(
      "transform var(--skr-motion-state-duration) var(--skr-motion-state-easing)",
    );
  });

  it("enters on the surface clock and leaves on the state clock, mirroring the entrance transform", () => {
    const marker = markerProbe();

    // The already-reserved space (the marker's max-width) never carries a
    // transition of its own; only opacity and the compositor translate do.
    marker.classList.add("cm-skr-reveal-marker-active");
    const active = getComputedStyle(marker);
    expect(active.opacity).toBe("1");
    expect(active.transform).toBe("translateX(0)");
    const enterTransition = transitionOf(marker);
    expect(enterTransition).toContain(
      "opacity var(--skr-motion-surface-duration) var(--skr-motion-surface-easing)",
    );
    expect(enterTransition).toContain(
      "transform var(--skr-motion-surface-duration) var(--skr-motion-surface-easing)",
    );
    expect(enterTransition).not.toContain("max-width");

    marker.classList.remove("cm-skr-reveal-marker-active");
    const exiting = getComputedStyle(marker);
    expect(exiting.opacity).toBe("0");
    expect(exiting.transform).toBe("translateX(var(--skr-motion-distance))");
    const exitTransition = transitionOf(marker);
    expect(exitTransition).toContain(
      "opacity var(--skr-motion-state-duration) var(--skr-motion-state-easing)",
    );
    expect(exitTransition).toContain(
      "transform var(--skr-motion-state-duration) var(--skr-motion-state-easing)",
    );
    expect(exitTransition).not.toContain("--skr-motion-surface-duration");
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

  it("animates auto-expanded folders closed with inert leaving ghosts", async () => {
    const props = reactiveProps({
      entries: treeEntries,
      selectedPath: "Folder/one.md" as string | null,
      onOpenPath: () => {},
    });
    const component = mount(FileTree, { target: document.body, props });
    flushSync();
    await tick();
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 220));

    expect(treeRow("Folder/one.md")).not.toBeNull();
    props.selectedPath = "plain.md";
    flushSync();
    await tick();
    await tick();

    expect(treeRow("Folder/one.md")).toBeNull();
    const ghosts = [
      ...document.querySelectorAll<HTMLElement>(".skr-tree-ghost"),
    ];
    expect(ghosts).toHaveLength(2);
    for (const ghost of ghosts) {
      expect(ghost.hasAttribute("inert")).toBe(true);
      expect(ghost.getAttribute("aria-hidden")).toBe("true");
      expect(getComputedStyle(ghost).pointerEvents).toBe("none");
    }

    await nextFrame();
    expect(ghosts.every((ghost) => ghost.style.opacity === "0")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(document.querySelector(".skr-tree-ghost")).toBeNull();

    await unmount(component);
  });

  it("reverses an interrupted folder reveal from current row and ghost positions", async () => {
    const component = mount(FileTree, {
      target: document.body,
      props: { entries: treeEntries, onOpenPath: () => {} },
    });
    flushSync();

    const folder = treeRow("Folder");
    folder?.click();
    await tick();
    await tick();

    const plain = treeRow("plain.md");
    const revealed = treeRow("Folder/one.md");
    expect(plain).not.toBeNull();
    expect(revealed).not.toBeNull();
    if (plain === null || revealed === null) return;

    plain.style.transform = "translateY(-28px)";
    revealed.style.transform = "translateY(7px)";
    revealed.style.opacity = "0.5";
    folder?.click();
    await tick();
    await tick();

    expect(folder?.getAttribute("aria-expanded")).toBe("false");
    expect(plain.style.transform).toBe("translateY(28px)");
    const ghost = document.querySelector<HTMLElement>(
      '[data-ghost-path="Folder/one.md"]',
    );
    expect(ghost).not.toBeNull();
    expect(ghost?.style.top).toBe("39px");
    expect(ghost?.style.opacity).toBe("0.5");

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

const highlightEntries: TreeEntry[] = [
  { path: "alpha.md", kind: "note", hidden: false },
  { path: "beta.md", kind: "note", hidden: false },
  { path: "gamma.md", kind: "note", hidden: false },
];

type HighlightProps = {
  entries: TreeEntry[];
  selectedPath: string | null;
  onOpenPath: (path: string) => void;
};

describe("file tree active-note highlight", () => {
  it("enters in place on first selection, then travels between rows on the panel clock", async () => {
    const props = reactiveProps<HighlightProps>({
      entries: highlightEntries,
      selectedPath: "alpha.md",
      onOpenPath: () => {},
    });
    const component = mount(FileTree, { target: document.body, props });
    flushSync();

    const highlight = document.querySelector<HTMLElement>(
      ".skr-tree-active-highlight",
    );
    expect(highlight).not.toBeNull();
    if (highlight === null) return;

    // First selection: no previous position is on screen, so the highlight
    // enters in place with the surface class rather than traveling.
    expect(highlight.dataset.motionSurface).toBe("fade");
    expect(highlight.dataset.motionEntered).toBe("true");
    expect(getComputedStyle(highlight).opacity).toBe("1");
    const alphaTop = Number.parseFloat(highlight.style.top);
    expect(Number.isNaN(alphaTop)).toBe(false);

    // Selecting the second row travels: geometry (top) applies instantly,
    // and the transform starts at the previous row's offset with no
    // transition attached yet.
    props.selectedPath = "beta.md";
    flushSync();

    const betaTop = Number.parseFloat(highlight.style.top);
    expect(betaTop).toBe(alphaTop + ROW_HEIGHT);
    expect(highlight.style.transform).toBe(
      `translateY(${alphaTop - betaTop}px)`,
    );
    expect(highlight.dataset.motionSurface).toBeUndefined();

    // One frame later the highlight settles toward zero transform through a
    // transition on the panel duration and easing.
    await nextFrame();
    expect(highlight.style.transform).toBe("");
    expect(transitionOf(highlight)).toContain(
      "transform var(--skr-motion-panel-duration) var(--skr-motion-panel-easing)",
    );

    // After the panel duration the inline transition is released.
    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(highlight.style.transition).toBe("");

    await unmount(component);
  });

  it("snaps the highlight instantly with no choreography when motion is off", async () => {
    document.documentElement.dataset.animations = "false";
    const props = reactiveProps<HighlightProps>({
      entries: highlightEntries,
      selectedPath: "alpha.md",
      onOpenPath: () => {},
    });
    const component = mount(FileTree, { target: document.body, props });
    flushSync();
    const highlight = document.querySelector<HTMLElement>(
      ".skr-tree-active-highlight",
    );
    expect(highlight).not.toBeNull();
    if (highlight === null) return;
    expect(highlight.dataset.motionSurface).toBeUndefined();
    expect(highlight.style.transform).toBe("");
    expect(getComputedStyle(highlight).opacity).toBe("1");

    props.selectedPath = "beta.md";
    flushSync();
    expect(highlight.dataset.motionSurface).toBeUndefined();
    expect(highlight.style.transform).toBe("");
    expect(highlight.style.transition).toBe("");

    // Settle the row-focus microtask the selection effect schedules before
    // tearing the tree down, so it never runs against a torn-down instance.
    await tick();
    await tick();
    await unmount(component);
  });
  it("retargets from the highlight's current rendered position", async () => {
    const props = reactiveProps<HighlightProps>({
      entries: highlightEntries,
      selectedPath: "alpha.md",
      onOpenPath: () => {},
    });
    const component = mount(FileTree, { target: document.body, props });
    flushSync();

    const highlight = document.querySelector<HTMLElement>(
      ".skr-tree-active-highlight",
    );
    expect(highlight).not.toBeNull();
    if (highlight === null) return;

    props.selectedPath = "beta.md";
    flushSync();
    await nextFrame();

    // Stand in for the browser's in-flight interpolated transform at the
    // instant a second retarget arrives: beta's top is 32px and its rendered
    // highlight is currently 14px above that slot.
    highlight.style.transform = "translateY(-14px)";
    props.selectedPath = "gamma.md";
    flushSync();

    // Gamma's final slot is 60px. The new travel must start at the rendered
    // 18px position, not at beta's 32px rest position.
    expect(highlight.style.transform).toBe("translateY(-42px)");

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

type TabStripProps = {
  tabs: WorkspaceTab[];
  activePath: string | null;
  titleSources: Record<string, string>;
  focused: boolean;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (from: number, to: number) => void;
};

function tabStripProps(overrides: Partial<TabStripProps> = {}): TabStripProps {
  return reactiveProps<TabStripProps>({
    tabs: stripTabs(3),
    activePath: "note-1.md",
    titleSources: {},
    focused: true,
    onActivate: () => {},
    onClose: () => {},
    onReorder: () => {},
    ...overrides,
  });
}

/** jsdom never lays anything out, so `offsetLeft`/`offsetWidth` default to
 * zero for every element; this stubs them to a plausible equal-width strip,
 * matching the drag tests' own `offsetWidth` override above. */
function stubTabGeometry(width: number): void {
  const shells = [...document.querySelectorAll<HTMLElement>(".skr-tab-shell")];
  shells.forEach((shell, index) => {
    Object.defineProperty(shell, "offsetLeft", {
      configurable: true,
      value: index * width,
    });
    Object.defineProperty(shell, "offsetWidth", {
      configurable: true,
      value: width,
    });
  });
}

describe("tab strip active-tab indicator", () => {
  it("enters in place on first activation, then travels between tabs on the panel clock", async () => {
    const props = tabStripProps();
    const component = mount(TabStrip, { target: document.body, props });
    flushSync();

    const indicator = document.querySelector<HTMLElement>(
      ".skr-tab-active-indicator",
    );
    expect(indicator).not.toBeNull();
    if (indicator === null) return;

    // First activation: no previous position is on screen, so the
    // indicator enters in place with the surface class.
    expect(indicator.dataset.motionSurface).toBe("fade");
    expect(indicator.dataset.motionEntered).toBe("true");
    expect(getComputedStyle(indicator).opacity).toBe("1");
    expect(
      indicator.classList.contains("skr-tab-active-indicator-focused"),
    ).toBe(true);

    // Give the tabs real (stubbed) geometry now that the elements exist, so
    // the next activation travels across a meaningful pixel delta.
    stubTabGeometry(100);

    props.activePath = "note-2.md";
    flushSync();

    expect(indicator.style.left).toBe("100px");
    expect(indicator.style.width).toBe("100px");
    expect(indicator.style.transform).toBe("translateX(-100px)");
    expect(indicator.dataset.motionSurface).toBeUndefined();

    await nextFrame();
    expect(indicator.style.transform).toBe("");
    expect(transitionOf(indicator)).toContain(
      "transform var(--skr-motion-panel-duration) var(--skr-motion-panel-easing)",
    );

    await new Promise((resolve) => setTimeout(resolve, 220));
    expect(indicator.style.transition).toBe("");

    await unmount(component);
  });

  it("enters in place instead of traveling once the previously active tab has closed", () => {
    const props = tabStripProps();
    const component = mount(TabStrip, { target: document.body, props });
    flushSync();
    const indicator = document.querySelector<HTMLElement>(
      ".skr-tab-active-indicator",
    );
    expect(indicator).not.toBeNull();
    if (indicator === null) return;
    expect(indicator.dataset.motionSurface).toBe("fade");

    // Close the active tab and activate a different one in the same
    // update, as the app does: "note-1.md" drops out of `tabs` entirely, so
    // there is nothing left to travel from.
    props.tabs = props.tabs.filter((tab) => tab.path !== "note-1.md");
    props.activePath = "note-2.md";
    flushSync();

    expect(indicator.dataset.motionSurface).toBe("fade");
    expect(getComputedStyle(indicator).opacity).toBe("1");

    void unmount(component);
  });

  it("colors the indicator by pane focus rather than by selection", () => {
    const props = tabStripProps({ focused: false });
    const component = mount(TabStrip, { target: document.body, props });
    flushSync();
    const indicator = document.querySelector<HTMLElement>(
      ".skr-tab-active-indicator",
    );
    expect(indicator).not.toBeNull();
    if (indicator === null) return;
    expect(
      indicator.classList.contains("skr-tab-active-indicator-focused"),
    ).toBe(false);
    expect(getComputedStyle(indicator).background).toContain(
      "var(--skr-border-strong)",
    );

    void unmount(component);
  });

  it("snaps the indicator instantly with no choreography when motion is off", () => {
    document.documentElement.dataset.animations = "false";
    const props = tabStripProps();
    const component = mount(TabStrip, { target: document.body, props });
    flushSync();
    const indicator = document.querySelector<HTMLElement>(
      ".skr-tab-active-indicator",
    );
    expect(indicator).not.toBeNull();
    if (indicator === null) return;
    expect(indicator.dataset.motionSurface).toBeUndefined();
    expect(indicator.style.transform).toBe("");

    stubTabGeometry(100);
    props.activePath = "note-2.md";
    flushSync();
    expect(indicator.dataset.motionSurface).toBeUndefined();
    expect(indicator.style.transform).toBe("");
    expect(indicator.style.transition).toBe("");

    void unmount(component);
  });

  it("retargets from the indicator's current rendered position", async () => {
    const props = tabStripProps();
    const component = mount(TabStrip, { target: document.body, props });
    flushSync();

    const indicator = document.querySelector<HTMLElement>(
      ".skr-tab-active-indicator",
    );
    expect(indicator).not.toBeNull();
    if (indicator === null) return;
    stubTabGeometry(100);

    props.activePath = "note-2.md";
    flushSync();
    await nextFrame();

    // The browser has rendered 40px of the 100px travel when a new target
    // arrives, so the indicator is currently at x=60px.
    indicator.style.transform = "translateX(-40px)";
    props.activePath = "note-3.md";
    flushSync();

    // Note three starts at x=200px. Continuity requires 60-200=-140px.
    expect(indicator.style.transform).toBe("translateX(-140px)");

    await unmount(component);
  });

  it("rebases in-flight indicator travel when the tab strip resizes", async () => {
    const props = tabStripProps();
    const component = mount(TabStrip, { target: document.body, props });
    flushSync();

    const indicator = document.querySelector<HTMLElement>(
      ".skr-tab-active-indicator",
    );
    expect(indicator).not.toBeNull();
    if (indicator === null) return;
    const shells = [
      ...document.querySelectorAll<HTMLElement>(".skr-tab-shell"),
    ];
    stubTabGeometry(100);

    props.activePath = "note-2.md";
    flushSync();
    await nextFrame();
    indicator.style.transform = "translateX(-40px)";

    const activeShell = shells[1];
    expect(activeShell).not.toBeUndefined();
    if (activeShell === undefined) return;
    Object.defineProperty(activeShell, "offsetLeft", {
      configurable: true,
      value: 150,
    });
    Object.defineProperty(activeShell, "offsetWidth", {
      configurable: true,
      value: 120,
    });
    window.dispatchEvent(new Event("resize"));

    // The indicator was at x=60px before the resize. Its new target is
    // x=150px, so its rebased transform is -90px and its width follows the
    // active tab immediately.
    expect(indicator.style.left).toBe("150px");
    expect(indicator.style.width).toBe("120px");
    expect(indicator.style.transform).toBe("translateX(-90px)");

    await unmount(component);
  });

  it("crossfades a dirty dot into the close affordance in a fixed hit box", () => {
    const closed = vi.fn();
    const props = tabStripProps({
      tabs: [
        { path: "note-1.md", viewState: null, dirty: true },
        { path: "note-2.md", viewState: null },
      ],
      onClose: closed,
    });
    const component = mount(TabStrip, { target: document.body, props });
    flushSync();

    const shell = document.querySelector<HTMLElement>(".skr-tab-shell");
    const status = shell?.querySelector<HTMLElement>(".skr-tab-status");
    const dot = shell?.querySelector<HTMLElement>(".skr-tab-unsaved");
    const close = shell?.querySelector<HTMLElement>(".skr-tab-close");
    expect(status).not.toBeNull();
    expect(dot).not.toBeNull();
    expect(close).not.toBeNull();
    if (status === null || dot === null || close === null || shell === null)
      return;

    expect(getComputedStyle(status).width).toBe("16px");
    expect(getComputedStyle(status).minWidth).toBe("16px");
    expect(getComputedStyle(dot).display).toBe("grid");
    expect(getComputedStyle(dot).opacity).toBe("1");
    expect(getComputedStyle(close).display).toBe("grid");
    expect(getComputedStyle(close).opacity).toBe("0");
    expect(getComputedStyle(close).pointerEvents).toBe("none");
    expect(getComputedStyle(dot).transition).toContain(
      "opacity var(--skr-motion-state-duration)",
    );

    // Focus supplies the same reveal state as hover while keeping the probe
    // in the keyboard path that must retain its existing semantics.
    shell.focus();
    expect(document.activeElement).toBe(shell);
    // jsdom does not recompute descendant pseudo-class selectors in computed
    // style, so read the exact declarations from the loaded production sheet.
    expect(
      loadedDeclarations(".skr-tab-shell:focus .skr-tab-unsaved", "opacity"),
    ).toContain("0");
    expect(
      loadedDeclarations(
        ".skr-tab-shell:focus .skr-tab-close-dirty",
        "opacity",
      ),
    ).toContain("1");
    expect(
      loadedDeclarations(
        ".skr-tab-shell:focus .skr-tab-close-dirty",
        "pointer-events",
      ),
    ).toContain("auto");

    close
      .querySelector("svg")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(closed).toHaveBeenCalledWith("note-1.md");

    void unmount(component);
  });

  it("keeps dirty and clean closes visible and hit-testable for coarse pointers", () => {
    const closed = vi.fn();
    const props = tabStripProps({
      tabs: [
        { path: "note-1.md", viewState: null, dirty: true },
        { path: "note-2.md", viewState: null },
      ],
      onClose: closed,
    });
    const component = mount(TabStrip, { target: document.body, props });
    flushSync();

    const dirtyShell = document.querySelector<HTMLElement>(
      ".skr-tab-shell.skr-tab-dirty",
    );
    const dirtyDot = dirtyShell?.querySelector<HTMLElement>(".skr-tab-unsaved");
    const dirtyClose = dirtyShell?.querySelector<HTMLElement>(".skr-tab-close");
    const cleanShell = document.querySelector<HTMLElement>(
      ".skr-tab-shell:not(.skr-tab-dirty)",
    );
    const cleanClose = cleanShell?.querySelector<HTMLElement>(".skr-tab-close");
    expect(dirtyShell?.getAttribute("aria-label")).toMatch(/unsaved/iu);
    expect(dirtyDot).not.toBeNull();
    expect(dirtyClose).not.toBeNull();
    expect(cleanClose).not.toBeNull();
    if (dirtyDot === null || dirtyClose === null || cleanClose === null) return;

    expect(getComputedStyle(dirtyDot).opacity).toBe("1");
    expect(getComputedStyle(dirtyDot).pointerEvents).toBe("none");
    expect(
      loadedMediaDeclarations(
        "(pointer: coarse)",
        ".skr-tab-shell .skr-tab-close",
        "opacity",
      ),
    ).toContain("1");
    expect(
      loadedMediaDeclarations(
        "(pointer: coarse)",
        ".skr-tab-shell .skr-tab-close",
        "pointer-events",
      ),
    ).toContain("auto");
    expect(
      loadedMediaDeclarations(
        "(pointer: coarse)",
        ".skr-tab-shell.skr-tab-dirty .skr-tab-unsaved",
        "opacity",
      ),
    ).toContain("1");

    dirtyClose.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 1 }),
    );
    cleanClose.dispatchEvent(
      new MouseEvent("click", { bubbles: true, detail: 1 }),
    );
    expect(closed).toHaveBeenNthCalledWith(1, "note-1.md");
    expect(closed).toHaveBeenNthCalledWith(2, "note-2.md");

    void unmount(component);
  });
});

describe("motion lifecycle", () => {
  it("cancels scheduled tree and tab callbacks when they unmount", async () => {
    const cancelFrame = vi.spyOn(globalThis, "cancelAnimationFrame");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    const treeProps = reactiveProps<HighlightProps>({
      entries: highlightEntries,
      selectedPath: "alpha.md",
      onOpenPath: () => {},
    });
    const tree = mount(FileTree, { target: document.body, props: treeProps });
    flushSync();
    treeProps.selectedPath = "beta.md";
    flushSync();
    await unmount(tree);

    const tabProps = tabStripProps();
    const tabs = mount(TabStrip, { target: document.body, props: tabProps });
    flushSync();
    stubTabGeometry(100);
    tabProps.activePath = "note-2.md";
    flushSync();
    await nextFrame();
    await unmount(tabs);

    expect(cancelFrame).toHaveBeenCalled();
    expect(clearTimer).toHaveBeenCalled();
  });
});
