// biome-ignore-all format: Keep the exploratory harness within its line budget.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { inflateSync } from "node:zlib";
import { $, browser } from "@wdio/globals";
import { Key } from "webdriverio";
import type { VisualCheck } from "./signals";
import { NOTES } from "./vault";

const modifier = process.platform === "darwin" ? Key.Command : Key.Ctrl;
const screenshots = path.join(import.meta.dirname, "screenshots");
const references = path.join(import.meta.dirname, "references");
const wide = { width: 1280, height: 800, name: "wide" } as const;
const narrow = { width: 720, height: 900, name: "narrow" } as const;
type Theme = "light" | "dark";
type Viewport = typeof wide | typeof narrow;

export type Construct = {
  id: string;
  name: string;
  note: string;
  anchor: string;
  park: string;
  selector: string;
  minimum?: number;
  expected: string[];
  raw: string[];
  openText?: string;
  mode?: "canvas" | "code" | "embed" | "frontmatter" | "table";
  path?: string;
  rendered?: string;
};

const callouts = ["note", "abstract", "info", "todo", "tip", "success", "question", "warning", "failure", "danger", "bug", "example", "quote"];

const definitions: Construct[] = [
  {
    id: "headings",
    name: "Headings",
    note: NOTES.rendering,
    anchor: "Rendered heading three",
    park: "Cursor parking area",
    selector: ".cm-skr-heading",
    minimum: 6,
    expected: ["Rendered heading one", "RENDERED HEADING SIX"],
    raw: ["# Rendered heading one", "###### Rendered heading six"],
  },
  {
    id: "emphasis",
    name: "Emphasis",
    note: NOTES.rendering,
    anchor: "Italic phrase",
    park: "Cursor parking area",
    selector: ".cm-skr-emphasis, .cm-skr-strong, .cm-skr-strikethrough",
    minimum: 3,
    expected: ["Italic phrase", "strong phrase", "struck phrase"],
    raw: ["*Italic phrase*", "**strong phrase**", "~~struck phrase~~"],
  },
  {
    id: "wikilinks",
    name: "Wikilinks",
    note: "Features/wikilinks.md",
    anchor: "return to the guided tour",
    park: "Wikilinks connect notes by name",
    selector: ".cm-skr-wikilink",
    expected: ["return to the guided tour"],
    raw: ["[[quickstart|return to the guided tour]]"],
  },
  {
    id: "embeds",
    name: "Embeds",
    note: "Features/embeds.md",
    anchor: "following source points",
    park: "An embed references another note",
    selector: ".cm-skr-embed",
    expected: ["D-01: Preserve a clear window-side route"],
    raw: ["![[Examples/Work/decision-log]]"],
    mode: "embed",
  },
  {
    id: "tags",
    name: "Tags",
    note: "Features/tags.md",
    anchor: "project/cedar-room",
    park: "Tags group notes by theme",
    selector: ".cm-skr-tag",
    expected: ["project/cedar-room"],
    raw: ["#project/cedar-room"],
  },
  ...callouts.map(
    (type): Construct => ({
      id: `callout-${type}`,
      name: `Callout: ${type}`,
      note: `Features/callout-${type}.md`,
      anchor: `${type[0]?.toUpperCase()}${type.slice(1)} title`,
      park: "Cursor parking area",
      selector: `.cm-skr-rich-callout[data-callout="${type}"]`,
      expected: [`${type[0]?.toUpperCase()}${type.slice(1)} title`, `Rendered ${type} body`],
      raw: [`[!${type}]`],
      openText: `${type[0]?.toUpperCase()}${type.slice(1)} callout`,
    }),
  ),
  {
    id: "tasks",
    name: "Tasks",
    note: "Features/tasks.md",
    anchor: "Compare the two table layouts",
    park: "Task lists keep actions",
    selector: ".cm-skr-task-checkbox",
    minimum: 2,
    expected: ["Compare the two table layouts"],
    raw: ["[ ]", "[x]"],
  },
  {
    id: "tables",
    name: "GFM tables",
    note: "Features/tables.md",
    anchor: "Cedar Room",
    park: "Tables are useful when each item",
    selector: '.cm-skr-table-row[role="row"]',
    minimum: 4,
    expected: ["Cedar Room", "Best fit for focused sessions"],
    raw: ["| Cedar Room | 18 | Yes | Yes | Best fit for focused sessions |"],
    mode: "table",
  },
  {
    id: "inline-code",
    name: "Inline code",
    note: "Features/code-blocks.md",
    anchor: "Inline code works",
    park: "Fenced code blocks preserve",
    selector: ".cm-skr-inline-code",
    expected: ["displayTitle"],
    raw: ["`displayTitle`"],
  },
  {
    id: "fenced-code",
    name: "Fenced code",
    note: "Features/code-blocks.md",
    anchor: "type NoteSummary",
    park: "Fenced code blocks preserve",
    selector: ".cm-skr-code-block",
    minimum: 4,
    expected: ["type NoteSummary", "displayTitle"],
    raw: ["```ts"],
    mode: "code",
  },
  {
    id: "inline-math",
    name: "Inline math",
    note: "Features/inline-math.md",
    anchor: "rectangular planting bed",
    park: "Inline math keeps",
    selector: ".cm-skr-math-inline .katex",
    expected: ["A", "w", "l"],
    raw: ["$A = w \\times l$"],
  },
  {
    id: "block-math",
    name: "Block math",
    note: "Features/block-math.md",
    anchor: "soil volume",
    park: "Block math gives",
    selector: ".cm-skr-math-block .katex",
    expected: ["V", "total"],
    raw: ["$$\nV_{total} = n \\times w \\times l \\times d\n$$"],
  },
  {
    id: "frontmatter",
    name: "Frontmatter properties",
    note: "Features/frontmatter.md",
    anchor: "Frontmatter stores",
    park: "Frontmatter stores structured properties",
    selector: '[aria-label="Note properties"]',
    expected: ["Frontmatter demonstration", "reference", "4"],
    raw: ["---", "title: Frontmatter demonstration"],
    mode: "frontmatter",
  },
];

const noteTitles: Record<string, string> = {
  [NOTES.rendering]: "Rendered heading one",
  "Features/wikilinks.md": "Wikilinks",
  "Features/embeds.md": "Embeds",
  "Features/tags.md": "Tags",
  "Features/tasks.md": "Tasks",
  "Features/tables.md": "Tables",
  "Features/code-blocks.md": "Code blocks",
  "Features/inline-math.md": "Inline math",
  "Features/block-math.md": "Block math",
  "Features/frontmatter.md": "Frontmatter",
};

export const CONSTRUCTS: ReadonlyArray<Construct & Required<Pick<Construct, "path" | "rendered">>> = [
  ...definitions.map((item) => ({
    ...item,
    path: item.note,
    rendered: item.openText ?? noteTitles[item.note] ?? item.name,
  })),
  {
    id: "canvas",
    name: "Canvas",
    note: NOTES.canvas,
    path: NOTES.canvas,
    anchor: "",
    park: "",
    selector: '[data-testid="canvas-view"]',
    expected: ["How can a shared room"],
    raw: ['"nodes"', "<!-- # Quickstart -->", "**Research question:**", "---\ntitle:"],
    rendered: "How can a shared room",
    mode: "canvas",
  },
];

function visual(id: string, construct: string, pass: boolean, expected: string, actual: string): VisualCheck {
  return { id, construct, pass, expected, actual };
}

async function settle(): Promise<void> {
  await browser.execute(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function locate(anchor: string): Promise<void> {
  await browser.keys([modifier, "f"]);
  const input = $(".cm-skr-find-input");
  await input.waitForExist({ timeout: 10_000 });
  await input.setValue(anchor);
  await browser.keys(Key.Enter);
  await browser.keys(Key.Escape);
  await settle();
}

async function parkCursor(text: string): Promise<void> {
  await browser.execute((lineText) => {
    const line = [...document.querySelectorAll<HTMLElement>(".cm-line")].find((candidate) => (candidate.textContent ?? "").includes(lineText));
    if (line === undefined) return;
    const range = document.createRange();
    range.selectNodeContents(line);
    range.collapse(false);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, text);
  await browser.pause(100);
}

export async function setTheme(value: Theme): Promise<void> {
  await browser.keys([modifier, ","]);
  await $('[data-testid="settings-view"]').waitForExist({ timeout: 10_000 });
  const palette = value === "light" ? "manuscript" : "graphite";
  await $(`[data-testid="settings-palette-${palette}"]`).click();
  await browser.waitUntil(() => browser.execute((next) => document.documentElement.dataset.theme === next, value));
  await browser.keys(Key.Escape);
  await settle();
}

async function capture(group: "constructs" | "personas", name: string, selectedTheme: Theme, viewport: Viewport): Promise<string> {
  const relative = `${group}/${name}--${selectedTheme}--${viewport.name}.png`;
  const destination = path.join(screenshots, relative);
  mkdirSync(path.dirname(destination), { recursive: true });
  await browser.saveScreenshot(destination);
  return relative;
}

export async function inspectConstruct(spec: Construct): Promise<VisualCheck[]> {
  if (spec.mode === "canvas") {
    const state = await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>('[data-testid="canvas-view"]');
      return { viewer: viewer !== null, cards: viewer?.querySelectorAll(".canvas-card").length ?? 0, text: viewer?.innerText ?? "" };
    });
    const visibleMarkers = spec.raw.filter((marker) => state.text.includes(marker));
    return [
      visual("canvas-element", "Canvas", state.viewer && state.cards >= 2, "canvas viewer with at least two cards", `${state.cards} cards`),
      visual("canvas-markers", "Canvas", visibleMarkers.length === 0, "raw canvas JSON and card Markdown hidden", visibleMarkers.length === 0 ? "source markers hidden" : `visible source: ${visibleMarkers.join(", ")}`),
      visual("canvas-text", "Canvas", state.text.includes("How can a shared room"), "rendered card text", state.text.includes("How can a shared room") ? "card text visible" : "card text missing"),
    ];
  }
  if (spec.mode !== "frontmatter") await locate(spec.anchor);
  await parkCursor(spec.park);
  await browser.pause(100);
  if (spec.mode === "code") await $(spec.selector).moveTo();
  const result = await browser.execute((item) => {
    const elements = [...document.querySelectorAll<HTMLElement>(item.selector)];
    const editor = document.querySelector<HTMLElement>(".cm-content");
    const panel = document.querySelector<HTMLElement>('[aria-label="Note properties"]');
    const panelValues = [...(panel?.querySelectorAll<HTMLInputElement>("input") ?? [])].map((input) => input.value).join(" ");
    const rendered = `${editor?.innerText ?? ""} ${panel?.innerText ?? ""} ${panelValues}`;
    const colors = new Set([...document.querySelectorAll<HTMLElement>(".cm-skr-code-block span")].map((node) => getComputedStyle(node).color));
    let special = true;
    if (item.mode === "code") special = colors.size >= 2;
    if (item.mode === "embed") special = rendered.includes("D-01: Preserve a clear window-side route");
    if (item.mode === "frontmatter") special = !(panel !== null && item.raw.some((source) => (editor?.innerText ?? "").includes(source)));
    if (item.mode === "table") special = elements.some((element) => element.getAttribute("role") === "row" && element.querySelector('[role="columnheader"]') !== null);
    return {
      count: elements.length,
      rendered,
      expectedText: item.expected.every((text) => rendered.includes(text)),
      markersHidden: item.raw.every((source) => !rendered.includes(source)),
      special,
      colors: [...colors].join(", "),
      copy: [...document.querySelectorAll<HTMLElement>("button")].some((button) => button.getClientRects().length > 0 && /copy/i.test(`${button.textContent} ${button.getAttribute("aria-label")}`)),
    };
  }, spec);
  const minimum = spec.minimum ?? 1;
  return [
    visual(`${spec.id}-element`, spec.name, result.count >= minimum, `at least ${minimum} ${spec.selector} element(s)`, `${result.count} found`),
    visual(`${spec.id}-markers`, spec.name, result.markersHidden, `raw markers hidden while the cursor is elsewhere`, result.markersHidden ? "markers hidden" : `visible source: ${spec.raw.join(", ")}`),
    visual(`${spec.id}-text`, spec.name, result.expectedText, `rendered text: ${spec.expected.join(", ")}`, result.expectedText ? "rendered text visible" : "rendered text missing or source-only"),
    ...(spec.mode === undefined
      ? []
      : [
          visual(
            `${spec.id}-${spec.mode}`,
            spec.name,
            result.special,
            spec.mode === "code" ? "at least two syntax token colors" : `semantic ${spec.mode} output`,
            spec.mode === "code"
              ? result.colors || "no token colors"
              : spec.mode === "frontmatter"
                ? result.special
                  ? "frontmatter is not duplicated"
                  : "properties panel and editor source are both visible"
                : result.special
                  ? `semantic ${spec.mode} output present`
                  : `semantic ${spec.mode} output absent`,
          ),
        ]),
    ...(spec.mode === "code" ? [visual("fenced-code-copy", spec.name, result.copy, "visible copy affordance on hover", result.copy ? "copy control visible" : "copy control absent")] : []),
  ];
}

function rgba(value: string): [number, number, number] | null {
  const match = value.match(/[\d.]+/g)?.map(Number);
  return match !== undefined && match.length >= 3 ? [match[0] ?? 0, match[1] ?? 0, match[2] ?? 0] : null;
}

function luminance(color: [number, number, number]): number {
  const channels = color.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

export async function inspectComputedVisibility(): Promise<VisualCheck[]> {
  const measured = await browser.execute(() => {
    const background = (node: Element | null): string => {
      let current = node;
      while (current !== null) {
        const value = getComputedStyle(current).backgroundColor;
        if (value !== "rgba(0, 0, 0, 0)" && value !== "transparent") return value;
        current = current.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const content = document.querySelector<HTMLElement>(".cm-content");
    const toolbar = document.querySelector<HTMLElement>(".cm-skr-selection-toolbar");
    const button = toolbar?.querySelector<HTMLElement>("button") ?? null;
    const chrome = [...document.querySelectorAll<HTMLElement>('button, input, select, [role="button"], [role="option"], [role="treeitem"]')]
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => ({
        label: element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 30) ?? element.tagName,
        color: getComputedStyle(element).color,
        background: background(element),
      }));
    return {
      caret:
        content === null
          ? null
          : {
              color: getComputedStyle(content).caretColor,
              background: background(content),
            },
      toolbar:
        button === null
          ? null
          : {
              color: getComputedStyle(button).color,
              background: background(toolbar),
            },
      chrome,
    };
  });
  const ratio = (pair: { color: string; background: string } | null) => {
    if (pair === null) return 0;
    const foreground = rgba(pair.color);
    const background = rgba(pair.background);
    if (foreground === null || background === null) return 0;
    const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
    return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
  };
  const caretRatio = ratio(measured.caret);
  const toolbarRatio = ratio(measured.toolbar);
  const invisible = measured.chrome.filter((item) => ratio(item) < 1.2);
  return [
    visual("caret-contrast", "Caret", caretRatio >= 3, "caret contrast of at least 3:1", measured.caret === null ? "caret missing" : `${caretRatio.toFixed(2)}:1 (${measured.caret.color} on ${measured.caret.background})`),
    visual(
      "toolbar-contrast",
      "Selection toolbar",
      toolbarRatio >= 4.5,
      "toolbar text contrast of at least 4.5:1",
      measured.toolbar === null ? "toolbar missing" : `${toolbarRatio.toFixed(2)}:1 (${measured.toolbar.color} on ${measured.toolbar.background})`,
    ),
    visual(
      "interactive-chrome",
      "Interactive chrome",
      invisible.length === 0,
      "no visible control shares its foreground and background color",
      invisible.length === 0 ? "all visible controls distinguishable" : invisible.map((item) => item.label).join(", "),
    ),
  ];
}

function decodePng(file: string): {
  width: number;
  height: number;
  channels: number;
  pixels: Uint8Array;
} {
  const png = readFileSync(file);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString();
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      channels = chunk[9] === 6 ? 4 : 3;
    }
    if (type === "IDAT") data.push(chunk);
    offset += length + 12;
  }
  const packed = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const distances = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
    return (distances[0] ?? 0) <= (distances[1] ?? 0) && (distances[0] ?? 0) <= (distances[2] ?? 0) ? a : (distances[1] ?? 0) <= (distances[2] ?? 0) ? b : c;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = packed[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const source = packed[y * (stride + 1) + x + 1] ?? 0;
      const left = x >= channels ? (pixels[y * stride + x - channels] ?? 0) : 0;
      const above = y > 0 ? (pixels[(y - 1) * stride + x] ?? 0) : 0;
      const corner = y > 0 && x >= channels ? (pixels[(y - 1) * stride + x - channels] ?? 0) : 0;
      const predictor = filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, corner) : 0;
      pixels[y * stride + x] = (source + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}

function comparePixels(actualPath: string, referencePath: string): VisualCheck {
  if (process.env.UX_FLEET_BLESS === "1") {
    mkdirSync(path.dirname(referencePath), { recursive: true });
    copyFileSync(actualPath, referencePath);
  }
  if (!existsSync(referencePath)) return visual("pixel-reference", "Pixel reference", false, "committed reference screenshot", `missing ${path.basename(referencePath)}; run with --bless`);
  const actual = decodePng(actualPath);
  const reference = decodePng(referencePath);
  if (actual.width !== reference.width || actual.height !== reference.height) return visual("pixel-dimensions", "Pixel reference", false, `${reference.width}x${reference.height}`, `${actual.width}x${actual.height}`);
  if (actual.channels !== reference.channels) return visual("pixel-channels", "Pixel reference", false, `${reference.channels} color channels`, `${actual.channels} color channels`);
  let different = 0;
  let total = 0;
  for (let index = 0; index < actual.pixels.length; index += actual.channels) {
    const delta = Math.max(...[0, 1, 2].map((channel) => Math.abs((actual.pixels[index + channel] ?? 0) - (reference.pixels[index + channel] ?? 0))));
    if (delta > 32) different += 1;
    total += 1;
  }
  const fraction = different / Math.max(1, total);
  return visual("pixel-difference", "Pixel reference", fraction <= 0.03, "no more than 3% of pixels differ by over 32 RGB levels", `${(fraction * 100).toFixed(2)}% differ`);
}

export function resetEvidence(): void {
  mkdirSync(screenshots, { recursive: true });
  for (const entry of readdirSync(screenshots)) {
    if (entry !== ".gitignore") rmSync(path.join(screenshots, entry), { recursive: true, force: true });
  }
}

export async function captureMatrix(kind: "construct" | "persona", name: string): Promise<void> {
  const group = kind === "construct" ? "constructs" : "personas";
  const matrix: Array<[Theme, Viewport]> = [
    ["light", wide],
    ["dark", wide],
    ["light", narrow],
    ["dark", narrow],
  ];
  for (const [selectedTheme, viewport] of matrix) {
    await browser.setWindowSize(viewport.width, viewport.height);
    await setTheme(selectedTheme);
    await capture(group, name, selectedTheme, viewport);
  }
  await browser.setWindowSize(wide.width, wide.height);
  await setTheme("light");
}

export async function compareReference(id: string, selector: string): Promise<VisualCheck> {
  await browser.setWindowSize(wide.width, wide.height);
  await setTheme("light");
  const actual = path.join(screenshots, "pixels", `${id}.png`);
  mkdirSync(path.dirname(actual), { recursive: true });
  await $(id === "canvas" ? selector : ".cm-editor").saveScreenshot(actual);
  return comparePixels(actual, path.join(references, `${id}.png`));
}

function imageFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? imageFiles(file) : entry.name.endsWith(".png") ? [path.relative(screenshots, file)] : [];
  });
}

export function writeGallery(): void {
  const files = imageFiles(screenshots)
    .filter((file) => !file.startsWith("pixels/"))
    .sort();
  const groups = ["personas", "constructs"].map((group) => {
    const images = files.filter((file) => file.startsWith(`${group}/`));
    return `## ${group[0]?.toUpperCase()}${group.slice(1)}\n\n${images.map((file) => `### ${path.basename(file, ".png").replaceAll("--", ", ")}\n\n![${file}](./${file})`).join("\n\n")}`;
  });
  writeFileSync(path.join(screenshots, "index.md"), `# UX fleet screenshot gallery\n\nThe gallery covers every persona and rendered construct in light and dark themes at wide and narrow viewports.\n\n${groups.join("\n\n")}\n`);
}
