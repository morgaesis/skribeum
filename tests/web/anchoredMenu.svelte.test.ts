// The shared anchored-menu primitive: positioning math, the three
// dismissal guarantees (capture-phase outside press, Escape, window
// blur), and row hover. The hover assertion reads the real, loaded
// stylesheets (theme.css and app.css verbatim, plus AnchoredMenu's own
// compiled <style>) and resolves the CSS cascade itself, because jsdom
// does not recompute a descendant-combinator `:hover`/`:focus-visible`
// rule through `getComputedStyle` even though `Element.matches` reports
// it correctly (verified against this exact repository's stylesheets: a
// `.outer button:focus-visible` rule never wins in jsdom's computed
// style, only a bare `.outer button` selector does). Resolving the
// cascade from the real parsed selectors and declaration order is the
// closest this environment gets to "does the browser actually show the
// hover fill", and it is exactly the property the reported bug broke: a
// later, equal-specificity `background-color: transparent` rule was
// silently winning over the hover rule.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, unmount } from "svelte";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import AnchoredMenu from "../../src/lib/AnchoredMenu.svelte";
import {
  attachMenuDismissal,
  computeAnchoredPosition,
} from "../../src/lib/anchoredMenu";

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
  document.body.replaceChildren();
});

// -- CSS cascade resolution over the real, loaded stylesheets --------

type Specificity = readonly [ids: number, classes: number, types: number];

function specificityOf(selector: string): Specificity {
  const ids = (selector.match(/#[\w-]+/g) ?? []).length;
  let classes = (selector.match(/\.[\w-]+/g) ?? []).length;
  classes += (selector.match(/\[[^\]]*\]/g) ?? []).length;
  classes += (selector.match(/:{1,2}[a-zA-Z-]+(\([^)]*\))?/g) ?? []).filter(
    (token) => !token.startsWith("::"),
  ).length;
  const types = (selector.match(/(^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length;
  return [ids, classes, types];
}

function compareSpecificity(a: Specificity, b: Specificity): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

type ParsedRule = {
  selector: string;
  declarations: CSSStyleDeclaration;
  order: number;
};

function parsedRules(): ParsedRule[] {
  const rules: ParsedRule[] = [];
  let order = 0;
  for (const sheet of document.styleSheets) {
    let cssRules: CSSRuleList;
    try {
      cssRules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of cssRules) {
      if (!(rule instanceof CSSStyleRule)) continue;
      for (const selector of rule.selectorText.split(",")) {
        rules.push({
          selector: selector.trim(),
          declarations: rule.style,
          order,
        });
        order += 1;
      }
    }
  }
  return rules;
}

/**
 * The value that wins the CSS cascade for `property`, among every real,
 * currently loaded rule whose selector satisfies `matches` (both `theme.css`
 * / `app.css` and any mounted Svelte component's own compiled styles),
 * ranked the way a browser ranks them: highest specificity first, then
 * latest declaration order.
 */
function cascadeWinner(
  property: string,
  matches: (selector: string) => boolean,
): { selector: string; value: string } | null {
  let winner: {
    selector: string;
    value: string;
    order: number;
    specificity: Specificity;
  } | null = null;
  for (const rule of parsedRules()) {
    if (!matches(rule.selector)) continue;
    const value = rule.declarations.getPropertyValue(property);
    if (value === "") continue;
    const specificity = specificityOf(rule.selector);
    if (
      winner === null ||
      compareSpecificity(specificity, winner.specificity) > 0 ||
      (compareSpecificity(specificity, winner.specificity) === 0 &&
        rule.order > winner.order)
    ) {
      winner = {
        selector: rule.selector,
        value,
        order: rule.order,
        specificity,
      };
    }
  }
  return winner === null
    ? null
    : { selector: winner.selector, value: winner.value };
}

const HOVERLIKE = /:hover|:focus-visible/;

describe("every menu row wins the hover fill over its own rest-state rule", () => {
  beforeAll(() => {
    // Mount once so AnchoredMenu's own compiled <style> is registered in
    // document.styleSheets alongside the injected theme.css and app.css.
    const anchor = document.createElement("button");
    document.body.append(anchor);
    const component = mount(AnchoredMenu, {
      target: document.body,
      props: { anchor, label: "warm-up", onClose: () => {} },
    });
    flushSync();
    void unmount(component);
    anchor.remove();
  });

  it.each([
    ["AnchoredMenu (tab strip, overflow menu)", ".skr-anchored-menu"],
    ["overflow menu rows", ".skr-action-menu"],
    ["file tree row-action menu", ".skr-tree-menu"],
  ])(
    "%s: the button a pointer is over resolves to the subtle surface fill",
    (_label, token) => {
      const targets = (selector: string) =>
        selector.includes(token) &&
        selector.includes("button") &&
        // The checked-row accent fill is a different state (a selected tab
        // or the active source-mode toggle), guarded by its own attribute;
        // excluding it isolates the plain hover/rest comparison this test
        // makes, which is unaffected by whether a row happens to also be
        // checked.
        !selector.includes("aria-checked");
      // The cascade winner considering every applicable rule together, the
      // way a browser resolves it for an element currently matched by
      // :hover or :focus-visible, must be the hover-scoped declaration, not
      // whichever unconditional rest-state rule happens to load last.
      const winner = cascadeWinner("background-color", targets);
      expect(winner).not.toBeNull();
      expect(winner?.value.trim()).toBe("var(--skr-surface-subtle)");
      expect(HOVERLIKE.test(winner?.selector ?? "")).toBe(true);

      // And the rest-state rule (excluding the hover-scoped ones) is a
      // genuinely different, transparent value, so the two states are
      // visually distinguishable at all.
      const rest = cascadeWinner(
        "background-color",
        (selector) => targets(selector) && !HOVERLIKE.test(selector),
      );
      expect(rest?.value.trim()).toBe("transparent");
    },
  );
});

const VIEWPORT = {
  top: 0,
  left: 0,
  right: 1024,
  bottom: 768,
  width: 1024,
  height: 768,
};

describe("computeAnchoredPosition", () => {
  const anchor = {
    left: 100,
    top: 200,
    right: 140,
    bottom: 220,
    width: 40,
    height: 20,
  };

  it("opens below and left-aligned by default when there is room", () => {
    const position = computeAnchoredPosition(
      anchor,
      { width: 160, height: 120 },
      VIEWPORT,
    );
    expect(position).toEqual({
      left: 100,
      top: 224,
      placement: "below",
      maxHeight: 536,
    });
  });

  it("right-aligns the menu's edge to the anchor's when asked", () => {
    // A trailing-edge anchor with enough clearance from the viewport's own
    // left edge that the clamp below never has to intervene.
    const trailingAnchor = {
      left: 300,
      top: 200,
      right: 340,
      bottom: 220,
      width: 40,
      height: 20,
    };
    const position = computeAnchoredPosition(
      trailingAnchor,
      { width: 160, height: 120 },
      VIEWPORT,
      { align: "end" },
    );
    expect(position.left).toBe(trailingAnchor.right - 160);
  });

  it("flips above the anchor when the space below cannot hold the menu", () => {
    const lowAnchor = {
      left: 100,
      top: 700,
      right: 140,
      bottom: 720,
      width: 40,
      height: 20,
    };
    const position = computeAnchoredPosition(
      lowAnchor,
      { width: 160, height: 200 },
      VIEWPORT,
    );
    expect(position.placement).toBe("above");
    expect(position.top).toBe(lowAnchor.top - 4 - 200);
  });

  it("clamps horizontally so the menu never renders past either viewport edge", () => {
    const rightAnchor = {
      left: 1000,
      top: 200,
      right: 1020,
      bottom: 220,
      width: 20,
      height: 20,
    };
    const position = computeAnchoredPosition(
      rightAnchor,
      { width: 160, height: 120 },
      VIEWPORT,
    );
    expect(position.left).toBe(VIEWPORT.right - 160 - 8);

    const leftAnchor = {
      left: -50,
      top: 200,
      right: -10,
      bottom: 220,
      width: 40,
      height: 20,
    };
    const clampedLeft = computeAnchoredPosition(
      leftAnchor,
      { width: 160, height: 120 },
      VIEWPORT,
    );
    expect(clampedLeft.left).toBe(VIEWPORT.left + 8);
  });
});

describe("attachMenuDismissal", () => {
  it("dismisses on a capture-phase pointerdown outside the surface, Escape, and window blur", () => {
    const surface = document.createElement("div");
    const ignored = document.createElement("button");
    document.body.append(surface, ignored);
    let dismissals = 0;
    const stop = attachMenuDismissal(surface, {
      onDismiss: () => {
        dismissals += 1;
      },
      ignore: [ignored],
    });

    // Inside the surface: no dismissal.
    surface.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(dismissals).toBe(0);

    // The ignored (invoking) control: no dismissal either.
    ignored.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(dismissals).toBe(0);

    // Anywhere else: dismisses.
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    expect(dismissals).toBe(1);

    surface.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(dismissals).toBe(2);

    window.dispatchEvent(new Event("blur"));
    expect(dismissals).toBe(3);

    stop();
    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    expect(dismissals).toBe(3);
    surface.remove();
    ignored.remove();
  });
});

function anchorButton(rect: Partial<DOMRect>): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "open menu";
  Object.defineProperty(button, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({
        left: 300,
        top: 400,
        right: 340,
        bottom: 420,
        width: 40,
        height: 20,
        x: 300,
        y: 400,
        toJSON: () => ({}),
        ...rect,
      }) as DOMRect,
  });
  document.body.append(button);
  return button;
}

describe("AnchoredMenu.svelte", () => {
  it("positions itself against its anchor and closes on an outside press", async () => {
    const anchor = anchorButton({});
    let closed = false;
    const component = mount(AnchoredMenu, {
      target: document.body,
      props: {
        anchor,
        label: "Test menu",
        onClose: () => {
          closed = true;
        },
      },
    });
    flushSync();
    const surface = document.querySelector<HTMLElement>(
      '.skr-anchored-menu, [role="menu"]',
    );
    expect(surface).not.toBeNull();
    if (surface === null) return;
    // Left-aligned to the anchor's own left edge, below it by the default gap.
    expect(surface.style.left).toBe("300px");
    expect(surface.style.top).toBe("424px");

    document.body.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );
    // The exit motion runs before onClose fires; zero-duration transitions
    // in this environment resolve it on the next microtask.
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(true);
    await unmount(component);
    anchor.remove();
  });

  it("does not close when the press lands on its own anchor", async () => {
    const anchor = anchorButton({});
    let closed = false;
    const component = mount(AnchoredMenu, {
      target: document.body,
      props: {
        anchor,
        label: "Test menu",
        onClose: () => {
          closed = true;
        },
      },
    });
    flushSync();
    anchor.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await Promise.resolve();
    expect(closed).toBe(false);
    await unmount(component);
    anchor.remove();
  });

  it("closes on Escape and restores focus to the anchor", async () => {
    const anchor = anchorButton({});
    anchor.focus();
    let closed = false;
    const component = mount(AnchoredMenu, {
      target: document.body,
      props: {
        anchor,
        label: "Test menu",
        onClose: () => {
          closed = true;
        },
      },
    });
    flushSync();
    document
      .querySelector<HTMLElement>('[role="menu"]')
      ?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(true);
    await unmount(component);
    expect(document.activeElement).toBe(anchor);
    anchor.remove();
  });
});
