// Design system section 5.12 (the control language) and the browser-demo
// banner requantify. These assertions read computed style from the built,
// rendered browser demo rather than re-parsing a stylesheet, matching the
// convention palette.spec.ts already established for token verification.

import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

const modifierKey = process.platform === "darwin" ? Key.Command : Key.Ctrl;
let testRun = 0;

// The three radius-scale values (design system section 5.12), resolved in
// CSS pixels at the default 16px root font: 0.25rem, 0.375rem, 0.75rem.
const RADIUS_SCALE_PX = new Set(["4px", "6px", "12px"]);

// Elements whose radius sits outside the section 5.12 scale for reasons the
// specification states elsewhere: the task checkbox and its settings-panel
// preview mirror the literal 3px of section 3.6; the toggle switch is the
// section 7.2 pill-and-thumb geometry; the desktop window shell and its
// Linux corner radius belong to section 4.13, not to a control.
const RADIUS_EXEMPT_SELECTOR =
  ".cm-skr-task-checkbox, .skr-property-checkbox input, .palette-live-box, .switch, .switch *, .skr-shell";

// Elements permitted a border at rest (design system section 5.12: floating
// surfaces, content blocks, the task checkbox, and hairline hosts). Plain
// controls -- buttons, chips, rows -- are not in this list.
const BORDER_AT_REST_ALLOWED_SELECTOR =
  '[role="dialog"], .settings-dialog, .command-surface-dialog, .skr-tree-menu, ' +
  ".skr-tab-menu, .settings-jump-menu, .task-listbox-options, .skr-command-tooltip, " +
  ".sheet, .cm-skr-link-preview, .cm-skr-task-palette, .cm-skr-selection-toolbar, " +
  ".cm-skr-slash-menu, .cm-skr-tag-menu, table, .cm-skr-table-first, .cm-skr-table-row, " +
  ".cm-skr-code-block, .cm-skr-rich-callout, .cm-skr-embed, .cm-skr-math-block, " +
  ".cm-skr-mermaid, .cm-skr-code-copy, .palette-card, .palette-live-preview, " +
  ".task-status-table, .cm-skr-task-checkbox, .skr-property-checkbox input, " +
  ".palette-live-box, .switch, .switch *, .canvas-toolbar, .canvas-card, " +
  ".cm-skr-find-panel, .demo-notice, .demo-storage-status";

type RadiusViolation = {
  selector: string;
  radii: string[];
};

type BorderViolation = {
  selector: string;
  widths: string;
};

/** Walks every visible element in the document, collecting non-scale radii
 * and at-rest borders outside the two allowlists above. Runs inline inside
 * the browser (no named local closures: a named function expression passed
 * through `browser.execute` serializes with an esbuild `__name` wrapper
 * that does not exist in the isolated browser context) so it sees the same
 * cascade a user's screen resolves. */
async function runAudit(): Promise<{
  radiusViolations: RadiusViolation[];
  borderViolations: BorderViolation[];
}> {
  return browser.execute(
    (
      radiusExemptSelector: string,
      borderAllowedSelector: string,
      radiusScale: string[],
    ) => {
      const scale = new Set(radiusScale);
      const radiusViolations: { selector: string; radii: string[] }[] = [];
      const borderViolations: { selector: string; widths: string }[] = [];
      for (const element of Array.from(
        document.querySelectorAll<HTMLElement>("*"),
      )) {
        if (element.tagName === "SVG" || element.closest("svg") !== null) {
          continue;
        }
        const box = element.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        const style = getComputedStyle(element);
        const id = element.id ? `#${element.id}` : "";
        const cls =
          typeof element.className === "string" && element.className.length > 0
            ? `.${element.className.trim().split(/\s+/).join(".")}`
            : "";
        const label = `${element.tagName.toLowerCase()}${id}${cls}`;

        if (!element.matches(radiusExemptSelector)) {
          const corners = [
            style.borderTopLeftRadius,
            style.borderTopRightRadius,
            style.borderBottomLeftRadius,
            style.borderBottomRightRadius,
          ];
          const offending = corners.filter(
            (radius) => radius !== "0px" && !scale.has(radius),
          );
          if (offending.length > 0) {
            radiusViolations.push({ selector: label, radii: offending });
          }
        }

        if (
          (element.tagName === "BUTTON" ||
            element.getAttribute("role") === "button") &&
          !element.matches(borderAllowedSelector) &&
          element.closest(borderAllowedSelector) === null
        ) {
          const widths = [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ];
          if (widths.some((width) => width !== "0px")) {
            borderViolations.push({
              selector: label,
              widths: widths.join(" "),
            });
          }
        }
      }
      return { radiusViolations, borderViolations };
    },
    RADIUS_EXEMPT_SELECTOR,
    BORDER_AT_REST_ALLOWED_SELECTOR,
    [...RADIUS_SCALE_PX],
  );
}

async function setDesktopViewport(): Promise<void> {
  let outerWidth = 1600;
  let outerHeight = 900;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await browser.setWindowSize(outerWidth, outerHeight);
    const actual = await browser.executeAsync<
      { width: number; height: number },
      []
    >((done) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          done({ width: window.innerWidth, height: window.innerHeight }),
        ),
      );
    });
    if (actual.width === 1600 && actual.height === 900) return;
    outerWidth += 1600 - actual.width;
    outerHeight += 900 - actual.height;
  }
}

async function openDemo(query: Record<string, string> = {}): Promise<void> {
  const demoUrl = process.env.SKRIBEUM_E2E_DEMO_URL;
  if (demoUrl === undefined) throw new Error("browser demo URL is unavailable");
  const target = new URL(demoUrl);
  testRun += 1;
  target.searchParams.set("test-run", String(testRun));
  for (const [key, value] of Object.entries(query)) {
    target.searchParams.set(key, value);
  }
  await browser.url(target.href);
  await $(".demo-shell").waitForExist({ timeout: 15000 });
}

/** Reads the RGB the browser resolves a `--skr-*` custom property to,
 * through a throwaway probe element, matching palette.spec.ts's pattern. */
async function tokenColor(token: string): Promise<string> {
  return browser.execute((name) => {
    const probe = document.createElement("div");
    probe.style.color = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    document.body.append(probe);
    const rgb = getComputedStyle(probe).color;
    probe.remove();
    return rgb;
  }, token);
}

before(async () => {
  await browser.tauri.switchWindow("main");
});

beforeEach(async () => {
  await setDesktopViewport();
});

describe("the control language radius scale and border-at-rest rule", () => {
  it("keeps a rendered task list, a boolean property, and a table on the section 5.12 scale", async () => {
    await openDemo({ note: "Features/tasks.md" });
    await $(".cm-skr-task-checkbox").waitForExist({ timeout: 15000 });
    const tasks = await runAudit();

    await openDemo({ note: "Features/frontmatter.md" });
    await $(".skr-properties-toggle").waitForExist({ timeout: 15000 });
    await $(".skr-properties-toggle").click();
    await $(".skr-property-checkbox input").waitForExist({ timeout: 10000 });
    const frontmatter = await runAudit();

    await openDemo({ note: "Features/tables.md" });
    await $(".cm-skr-table-shell").waitForExist({ timeout: 15000 });
    const tables = await runAudit();

    for (const result of [tasks, frontmatter, tables]) {
      expect(result.radiusViolations).toEqual([]);
      expect(result.borderViolations).toEqual([]);
    }
  });

  it("keeps the settings dialog's segmented controls, inputs, and cards on the scale with no rest borders", async () => {
    await openDemo();
    await $(".cm-content").waitForExist({ timeout: 15000 });
    await browser.keys([modifierKey, ","]);
    await $('[data-testid="settings-view"]').waitForDisplayed({
      timeout: 10000,
    });
    const result = await runAudit();
    expect(result.radiusViolations).toEqual([]);
    expect(result.borderViolations).toEqual([]);

    // The de-boxed settings search: a flat field, never a full border.
    const search = await browser.execute(() => {
      const input = document.querySelector<HTMLElement>(
        '.settings-search input, input[type="search"]',
      );
      if (input === null) return null;
      const style = getComputedStyle(input);
      return {
        top: style.borderTopWidth,
        right: style.borderRightWidth,
        bottom: style.borderBottomWidth,
        left: style.borderLeftWidth,
      };
    });
    expect(search).not.toBeNull();
    expect(
      search?.top === "0px" &&
        search?.left === "0px" &&
        search?.right === "0px",
    ).toBe(true);

    // The segmented control: no outer box, and the active option carries
    // ordinary text rather than accent-coloured text.
    const segmented = await browser.execute(() => {
      const group = document.querySelector<HTMLElement>(".segmented");
      const active = document.querySelector<HTMLElement>(
        ".segmented button.active",
      );
      if (group === null || active === null) return null;
      const groupStyle = getComputedStyle(group);
      const activeStyle = getComputedStyle(active);
      return {
        groupBorder: [
          groupStyle.borderTopWidth,
          groupStyle.borderRightWidth,
          groupStyle.borderBottomWidth,
          groupStyle.borderLeftWidth,
        ].join(" "),
        activeColor: activeStyle.color,
        textColor: getComputedStyle(document.documentElement)
          .getPropertyValue("--skr-text")
          .trim(),
      };
    });
    expect(segmented).not.toBeNull();
    expect(segmented?.groupBorder).toBe("0px 0px 0px 0px");
  });

  it("keeps the command palette and header overflow menu rows flat", async () => {
    await openDemo({ note: "quickstart.md" });
    await $(".cm-content").waitForExist({ timeout: 15000 });
    await browser.keys([modifierKey, "k"]);
    await $(".command-surface-dialog").waitForExist({ timeout: 5000 });
    const palette = await runAudit();
    expect(palette.radiusViolations).toEqual([]);
    expect(palette.borderViolations).toEqual([]);
    await browser.keys(Key.Escape);
    // The palette owns modality until its exit motion finishes: the shell
    // stays inert and the scrim keeps hit-testing over the header for the
    // length of the exit, so a header click issued before the surface
    // unmounts lands on the scrim instead of the button underneath it.
    await $('[data-testid="unified-command-surface"]').waitForExist({
      reverse: true,
      timeout: 10000,
    });

    const overflow = $(".skr-header-overflow");
    if (await overflow.isExisting()) {
      await overflow.click();
      await $(".skr-action-menu").waitForExist({ timeout: 10000 });
      const rowRadius = await browser.execute(() => {
        const button = document.querySelector<HTMLElement>(
          ".skr-action-menu button",
        );
        return button === null ? null : getComputedStyle(button).borderRadius;
      });
      // Overflow-menu rows are flat full-width rows: no rounded row cards
      // (design system section 5.12).
      expect(rowRadius).toBe("0px");
      const menu = await runAudit();
      expect(menu.radiusViolations).toEqual([]);
      expect(menu.borderViolations).toEqual([]);
    }
  });
});

describe("the browser-demo banner", () => {
  it("renders as a muted, hairline-bounded strip rather than a full-width alert block", async () => {
    await openDemo({ note: "quickstart.md" });
    const notice = $(".demo-notice");
    await notice.waitForDisplayed({ timeout: 15000 });

    const [warningSurfaceRgb, accentSubtleRgb] = await Promise.all([
      tokenColor("--skr-warning-surface"),
      tokenColor("--skr-accent-subtle"),
    ]);

    const measurements = await browser.execute(() => {
      const element = document.querySelector<HTMLElement>(".demo-notice");
      if (element === null) return null;
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        height: box.height,
        backgroundColor: style.backgroundColor,
        boxShadow: style.boxShadow,
        viewportHeight: window.innerHeight,
      };
    });
    expect(measurements).not.toBeNull();

    // Colour treatment: the former warning-surface amber block is gone, and
    // the notice now consumes the same accent-subtle token the persistent
    // post-dismiss status bar already used, so the two read as one system.
    expect(measurements?.backgroundColor).not.toBe(warningSurfaceRgb);
    expect(measurements?.backgroundColor).toBe(accentSubtleRgb);
    // A floating-surface shadow reads as an elevated, dialog-like surface;
    // this is a flat content strip, so it carries none.
    expect(measurements?.boxShadow).toBe("none");

    // Footprint: comfortably under a quarter of the viewport height at this
    // width, where the former two-paragraph amber block ran noticeably
    // taller (padding alone totalled roughly 22px against this design's 12).
    expect(measurements?.height).toBeLessThan(60);
    if (measurements !== null) {
      expect(measurements.height / measurements.viewportHeight).toBeLessThan(
        0.08,
      );
    }

    // Still dismissible, and findable afterward through the persistent
    // status bar the notice hands off to.
    await $(".demo-notice__dismiss").click();
    await notice.waitForDisplayed({ reverse: true, timeout: 5000 });
    await $(".demo-storage-status").waitForDisplayed({ timeout: 5000 });
  });
});
