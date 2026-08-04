// Design system sections 3.2, 3.3, and 5.12: the retuned Manuscript and
// Nightroom default palettes, and the labelled-button role system. These
// assertions read computed style from the built, rendered browser demo
// rather than re-parsing the theme stylesheet, so they exercise the same
// cascade a user's screen resolves.

import { $, browser, expect } from "@wdio/globals";
import { Key } from "webdriverio";

let testRun = 0;

const MANUSCRIPT_TOKENS = {
  canvas: "#f5f2e9",
  surface: "#fffdf8",
  "surface-subtle": "#efe9dd",
  "surface-raised": "#ffffff",
  "code-surface": "#f1ece1",
  text: "#24352b",
  "text-muted": "#5c6b60",
  heading: "#14251d",
  "heading-subtle": "#3a4a3f",
  accent: "#1e4d3b",
  "accent-subtle": "#e3ebe6",
  link: "#1e4d3b",
  border: "#d6cdbb",
  "border-strong": "#7c8c81",
  "selection-surface": "#dce7e0",
  "selection-text": "#24352b",
  caret: "#2e6b4f",
  focus: "#1e4d3b",
  danger: "#9c2b23",
  "danger-surface": "#f8e6e2",
  warning: "#7a5410",
  "warning-surface": "#f6ecd4",
  success: "#3d6b34",
  "success-surface": "#e7efdd",
} as const;

const NIGHTROOM_TOKENS = {
  canvas: "#14251d",
  surface: "#182b21",
  "surface-subtle": "#213a2c",
  "surface-raised": "#1e3527",
  "code-surface": "#1b3024",
  text: "#dfe8de",
  "text-muted": "#9fb0a2",
  heading: "#f3f0e6",
  "heading-subtle": "#c3d1c5",
  accent: "#7fbf9e",
  "accent-subtle": "#24402f",
  link: "#7fbf9e",
  border: "#24392c",
  "border-strong": "#628070",
  "selection-surface": "#2c4a3a",
  "selection-text": "#f3f0e6",
  caret: "#7fbf9e",
  focus: "#7fbf9e",
  danger: "#f0968c",
  "danger-surface": "#3a221f",
  warning: "#e5c063",
  "warning-surface": "#362c14",
  success: "#8fd0a0",
  "success-surface": "#1d3327",
} as const;

// Fixed, mode-independent brand glow reserved for a future feature; it
// belongs to neither palette's rotating set but must resolve everywhere.
const LAMPLIGHT_TOKEN = "#f6e7a8";

// Syntax and callout roles are shared across every palette in a mode
// (design system sections 3.4 and 3.5); rendered markup marks, code tokens,
// and callout accents legitimately draw from these rather than the
// per-palette neutral and accent set above.
const SYNTAX_LIGHT = [
  "#7526a8",
  "#2e6e33",
  "#8f4700",
  "#6e6558",
  "#1d4fd8",
  "#0d6e7e",
  "#8c3a2b",
  "#565664",
];
const SYNTAX_DARK = [
  "#c9a1ee",
  "#9ecf87",
  "#f0a86a",
  "#94958f",
  "#82b4ff",
  "#6fd0d8",
  "#e8b366",
  "#a5a5b5",
];
const CALLOUT_LIGHT = [
  "#245ec2",
  "#0d6e7e",
  "#2e7040",
  "#7d5a08",
  "#9a4a1a",
  "#b02a37",
  "#6d3ab0",
  "#5b6069",
];
const CALLOUT_DARK = [
  "#82b4ff",
  "#67d3e0",
  "#8fd0a0",
  "#e0c25c",
  "#f0a86a",
  "#f2958f",
  "#c4a5f5",
  "#a8adb8",
];

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(
    (index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255,
  );
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return (
    0.2126 * (linear[0] ?? 0) +
    0.7152 * (linear[1] ?? 0) +
    0.0722 * (linear[2] ?? 0)
  );
}

// WebKitGTK's CSSOM serializes an all-repeated-pair hex literal like
// "#ffffff" back to its three-digit shorthand "#fff" when a custom
// property's computed value is read; normalizing both sides keeps the
// comparison exact regardless of that serialization choice.
function normalizeHex(value: string): string {
  const shorthand = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/iu.exec(value);
  if (shorthand === null) return value.toLowerCase();
  const [, r, g, b] = shorthand;
  return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
}

function contrastRatio(foreground: string, background: string): number {
  const [bright, dark] = [luminance(foreground), luminance(background)].sort(
    (a, b) => b - a,
  );
  return ((bright ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

async function setDesktopViewport(): Promise<void> {
  let outerWidth = 1280;
  let outerHeight = 800;
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
    if (actual.width === 1280 && actual.height === 800) return;
    outerWidth += 1280 - actual.width;
    outerHeight += 800 - actual.height;
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

before(async () => {
  await browser.tauri.switchWindow("main");
});

beforeEach(async () => {
  await setDesktopViewport();
});

/** Reads every named token's resolved custom-property value from the root. */
async function readTokens(
  theme: "light" | "dark",
  lightPalette: string,
  darkPalette: string,
  names: readonly string[],
) {
  return browser.execute(
    (t, lp, dp, tokenNames) => {
      document.documentElement.dataset.theme = t;
      document.documentElement.dataset.lightPalette = lp;
      document.documentElement.dataset.darkPalette = dp;
      const style = getComputedStyle(document.documentElement);
      const result: Record<string, string> = {};
      for (const name of tokenNames) {
        result[name] = style.getPropertyValue(`--skr-${name}`).trim();
      }
      return result;
    },
    theme,
    lightPalette,
    darkPalette,
    names,
  );
}

describe("brand palette retune", () => {
  it("resolves every Manuscript token to the specification's exact value", async () => {
    await openDemo({ note: "quickstart.md" });
    const names = Object.keys(MANUSCRIPT_TOKENS);
    const resolved = await readTokens(
      "light",
      "manuscript",
      "nightroom",
      names,
    );
    for (const [token, expected] of Object.entries(MANUSCRIPT_TOKENS)) {
      expect(normalizeHex(resolved[token])).toBe(expected);
    }
  });

  it("resolves every Nightroom token to the specification's exact value", async () => {
    await openDemo({ note: "quickstart.md" });
    const names = Object.keys(NIGHTROOM_TOKENS);
    const resolved = await readTokens("dark", "manuscript", "nightroom", names);
    for (const [token, expected] of Object.entries(NIGHTROOM_TOKENS)) {
      expect(normalizeHex(resolved[token])).toBe(expected);
    }
  });

  it("resolves the fixed Lamplight token identically in both modes and consumes it nowhere", async () => {
    await openDemo({ note: "quickstart.md" });
    const [light, dark] = await Promise.all([
      readTokens("light", "manuscript", "nightroom", ["lamplight"]),
      readTokens("dark", "manuscript", "nightroom", ["lamplight"]),
    ]);
    expect(light.lamplight).toBe(LAMPLIGHT_TOKEN);
    expect(dark.lamplight).toBe(LAMPLIGHT_TOKEN);

    const lamplightRgb = await browser.execute((hex) => {
      const probe = document.createElement("div");
      probe.style.color = hex;
      document.body.append(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    }, LAMPLIGHT_TOKEN);

    const usage = await browser.execute((needle) => {
      const elements = [...document.querySelectorAll<HTMLElement>("body *")];
      return elements.some((element) => {
        const style = getComputedStyle(element);
        return (
          style.color === needle ||
          style.backgroundColor === needle ||
          style.borderColor === needle
        );
      });
    }, lamplightRgb);
    expect(usage).toBe(false);
  });

  for (const [paletteName, theme, tokens, extras] of [
    [
      "manuscript",
      "light",
      MANUSCRIPT_TOKENS,
      [...SYNTAX_LIGHT, ...CALLOUT_LIGHT],
    ],
    ["nightroom", "dark", NIGHTROOM_TOKENS, [...SYNTAX_DARK, ...CALLOUT_DARK]],
  ] as const) {
    it(`renders no colour outside ${paletteName}'s token set on the quickstart note`, async () => {
      await openDemo({ note: "quickstart.md" });
      await browser.execute((t) => {
        document.documentElement.dataset.theme = t;
        document.documentElement.dataset.lightPalette = "manuscript";
        document.documentElement.dataset.darkPalette = "nightroom";
      }, theme);
      await $(".cm-content").waitForExist({ timeout: 10000 });

      const allValues = [...Object.values(tokens), ...extras];
      const offenders = await browser.execute((hexValues) => {
        const allowed = new Set<string>();
        for (const hex of hexValues) {
          const probe = document.createElement("div");
          probe.style.color = hex;
          document.body.append(probe);
          allowed.add(getComputedStyle(probe).color);
          probe.remove();
        }
        const shell = document.querySelector(".skr-shell");
        if (shell === null) return ["missing shell"];
        const candidates = [...shell.querySelectorAll<HTMLElement>("*")].filter(
          (element) => {
            if (element.tagName === "SVG" || element.closest("svg") !== null) {
              return false;
            }
            if (element.children.length > 0) return false;
            const text = element.textContent?.trim() ?? "";
            if (text.length === 0) return false;
            const box = element.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          },
        );
        const bad = new Set<string>();
        for (const element of candidates) {
          const color = getComputedStyle(element).color;
          if (!allowed.has(color)) {
            bad.add(
              `${element.tagName.toLowerCase()}:${color}:${(element.textContent ?? "").slice(0, 40)}`,
            );
          }
        }
        return [...bad];
      }, allValues);

      expect(offenders).toEqual([]);
    });
  }

  it("switches the resolved dark palette instantly, with no transition window", async () => {
    await openDemo({ note: "quickstart.md" });
    const instant = await browser.execute(() => {
      document.documentElement.dataset.theme = "dark";
      document.documentElement.dataset.lightPalette = "manuscript";
      document.documentElement.dataset.darkPalette = "nightroom";
      const before = getComputedStyle(document.documentElement)
        .getPropertyValue("--skr-surface")
        .trim();
      document.documentElement.dataset.themeSwitching = "true";
      document.documentElement.dataset.darkPalette = "graphite";
      const afterDuration = getComputedStyle(document.body).transitionDuration;
      const after = getComputedStyle(document.documentElement)
        .getPropertyValue("--skr-surface")
        .trim();
      delete document.documentElement.dataset.themeSwitching;
      return { before, after, afterDuration };
    });
    expect(instant.before).toBe("#182b21");
    expect(instant.after).toBe("#141b26");
    expect(instant.afterDuration).toBe("0s");
  });

  it("meets the specification's contrast floor for named token pairs in both default palettes", async () => {
    await openDemo({ note: "quickstart.md" });
    const pairs: readonly [
      keyof typeof MANUSCRIPT_TOKENS,
      keyof typeof MANUSCRIPT_TOKENS,
      number,
    ][] = [
      ["text", "surface", 4.5],
      ["heading", "surface", 4.5],
      ["accent", "surface", 4.5],
      ["link", "surface", 4.5],
      ["border-strong", "surface", 3.0],
      ["caret", "surface", 3.0],
    ];
    for (const [, tokens] of [
      ["manuscript", MANUSCRIPT_TOKENS],
      ["nightroom", NIGHTROOM_TOKENS],
    ] as const) {
      for (const [fg, bg, minimum] of pairs) {
        const ratio = contrastRatio(tokens[fg], tokens[bg]);
        expect(ratio).toBeGreaterThanOrEqual(minimum);
      }
    }
  });
});

describe("labelled-button role system", () => {
  it("renders the empty-vault Open vault action with the primary role and no border", async () => {
    await openDemo();
    await browser.execute(() =>
      (
        window as Window & {
          __SKRIBEUM_E2E_SHOW_EMPTY_VAULT__?: () => void;
        }
      ).__SKRIBEUM_E2E_SHOW_EMPTY_VAULT__?.(),
    );
    const openVault = $(
      '[data-command-id="vault.open"][data-btn-role="primary"]',
    );
    await openVault.waitForDisplayed({ timeout: 15000 });

    const style = await browser.execute(() => {
      const button = document.querySelector<HTMLElement>(
        '[data-command-id="vault.open"][data-btn-role="primary"]',
      );
      if (button === null) return null;
      const computed = getComputedStyle(button);
      return {
        backgroundColor: computed.backgroundColor,
        color: computed.color,
        borderWidth: computed.borderWidth,
        fontWeight: computed.fontWeight,
      };
    });
    const tokenColor = await browser.execute(() => {
      const probe = document.createElement("div");
      probe.style.color = getComputedStyle(document.documentElement)
        .getPropertyValue("--skr-accent")
        .trim();
      document.body.append(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    });
    const surfaceColor = await browser.execute(() => {
      const probe = document.createElement("div");
      probe.style.color = getComputedStyle(document.documentElement)
        .getPropertyValue("--skr-surface")
        .trim();
      document.body.append(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return rgb;
    });
    expect(style?.backgroundColor).toBe(tokenColor);
    expect(style?.color).toBe(surfaceColor);
    expect(style?.borderWidth).toBe("0px");
    expect(style?.fontWeight).toBe("600");

    const primaryCount = await browser.execute(() => {
      return [...document.querySelectorAll('[data-btn-role="primary"]')].filter(
        (element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        },
      ).length;
    });
    expect(primaryCount).toBe(1);
  });

  it("renders the settings dialog's Restore defaults as flat secondary text with no border and no primary button", async () => {
    await openDemo({ note: "quickstart.md" });
    await $(".cm-content").waitForExist({ timeout: 10000 });
    await $(".cm-content").click();
    await browser.keys([Key.Ctrl, ","]);
    const dialog = $('[data-testid="settings-view"]');
    await dialog.waitForExist({ timeout: 10000 });

    const restore = await browser.execute(() => {
      const button = document.querySelector<HTMLElement>(
        '.settings-footer [data-btn-role="secondary"]',
      );
      if (button === null) return null;
      const computed = getComputedStyle(button);
      return {
        backgroundColor: computed.backgroundColor,
        borderColor: computed.borderColor,
        fontWeight: computed.fontWeight,
        text: button.textContent?.trim(),
      };
    });
    expect(restore?.text).toBe("Restore defaults");
    // A transparent border keeps the box model stable across states without
    // drawing a visible edge; a solid, coloured border at rest is the defect
    // this role system forbids, not the presence of a zero-opacity one.
    expect(restore?.borderColor).toBe("rgba(0, 0, 0, 0)");
    expect(restore?.fontWeight).toBe("600");
    expect(restore?.backgroundColor).toBe("rgba(0, 0, 0, 0)");

    const primaryCount = await browser.execute(
      () =>
        document.querySelectorAll(
          '[data-testid="settings-view"] [data-btn-role="primary"]',
        ).length,
    );
    expect(primaryCount).toBe(0);

    const secondaryCount = await browser.execute(
      () =>
        document.querySelectorAll(
          '[data-testid="settings-view"] [data-btn-role="secondary"]',
        ).length,
    );
    expect(secondaryCount).toBeGreaterThan(0);
  });
});
