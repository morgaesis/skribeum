// The design reference page: the theme's tokens rendered as specimens, with
// every displayed value read back from the live cascade rather than restated.
// The page therefore cannot drift from src/lib/themes/theme.css; a token
// change reprints here on the next load.

import "./design.css";

type TokenGroup = { title: string; note?: string; tokens: string[] };

const COLOR_GROUPS: TokenGroup[] = [
  {
    title: "Surfaces",
    tokens: [
      "--skr-canvas",
      "--skr-surface",
      "--skr-surface-subtle",
      "--skr-surface-raised",
      "--skr-code-surface",
    ],
  },
  {
    title: "Text",
    tokens: [
      "--skr-text",
      "--skr-text-muted",
      "--skr-heading",
      "--skr-heading-subtle",
    ],
  },
  {
    title: "Interaction",
    tokens: [
      "--skr-accent",
      "--skr-accent-subtle",
      "--skr-link",
      "--skr-caret",
      "--skr-focus",
      "--skr-selection-surface",
      "--skr-selection-text",
    ],
  },
  {
    title: "Structure",
    tokens: ["--skr-border", "--skr-border-strong"],
  },
  {
    title: "Feedback",
    tokens: [
      "--skr-danger",
      "--skr-danger-surface",
      "--skr-warning",
      "--skr-warning-surface",
      "--skr-success",
      "--skr-success-surface",
    ],
  },
  {
    title: "Callouts",
    tokens: [
      "--skr-callout-blue",
      "--skr-callout-cyan",
      "--skr-callout-green",
      "--skr-callout-yellow",
      "--skr-callout-orange",
      "--skr-callout-red",
      "--skr-callout-purple",
      "--skr-callout-gray",
    ],
  },
  {
    title: "Syntax",
    tokens: [
      "--skr-syntax-keyword",
      "--skr-syntax-string",
      "--skr-syntax-number",
      "--skr-syntax-comment",
      "--skr-syntax-function",
      "--skr-syntax-type",
      "--skr-syntax-property",
      "--skr-syntax-operator",
    ],
  },
];

const SCALAR_TOKENS = [
  "--skr-radius-control",
  "--skr-radius-surface",
  "--skr-radius-dialog",
  "--skr-type-chip",
  "--skr-type-label",
  "--skr-type-control",
  "--skr-type-title",
  "--skr-gutter",
  "--skr-motion-state-duration",
  "--skr-motion-surface-duration",
  "--skr-motion-panel-duration",
  "--skr-motion-distance",
  "--skr-hover-intent-delay",
  "--skr-caret-blink-cycle",
];

const LIGHT_PALETTES = ["manuscript", "studio", "gazette"] as const;
const DARK_PALETTES = ["nightroom", "graphite", "signal"] as const;

/** The pairs the product actually sets, checked at their governing level.
 * Body-size text needs 4.5:1; UI components and large text need 3:1. */
const CONTRAST_PAIRS: {
  label: string;
  fg: string;
  bg: string;
  floor: number;
}[] = [
  {
    label: "Body text on canvas",
    fg: "--skr-text",
    bg: "--skr-canvas",
    floor: 4.5,
  },
  {
    label: "Body text on surface",
    fg: "--skr-text",
    bg: "--skr-surface",
    floor: 4.5,
  },
  {
    label: "Muted text on surface",
    fg: "--skr-text-muted",
    bg: "--skr-surface",
    floor: 4.5,
  },
  {
    label: "Heading on canvas",
    fg: "--skr-heading",
    bg: "--skr-canvas",
    floor: 4.5,
  },
  {
    label: "Accent on canvas",
    fg: "--skr-accent",
    bg: "--skr-canvas",
    floor: 4.5,
  },
  {
    label: "Selected text on selection",
    fg: "--skr-selection-text",
    bg: "--skr-selection-surface",
    floor: 4.5,
  },
  {
    label: "Danger on its surface",
    fg: "--skr-danger",
    bg: "--skr-danger-surface",
    floor: 4.5,
  },
  {
    label: "Warning on its surface",
    fg: "--skr-warning",
    bg: "--skr-warning-surface",
    floor: 4.5,
  },
  {
    label: "Success on its surface",
    fg: "--skr-success",
    bg: "--skr-success-surface",
    floor: 4.5,
  },
  {
    label: "Strong border on surface",
    fg: "--skr-border-strong",
    bg: "--skr-surface",
    floor: 3,
  },
  {
    label: "Focus ring on canvas",
    fg: "--skr-focus",
    bg: "--skr-canvas",
    floor: 3,
  },
  {
    label: "Caret on surface",
    fg: "--skr-caret",
    bg: "--skr-surface",
    floor: 3,
  },
];

function readToken(name: string): string {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/** Parses the computed form of a color token. Computed custom properties keep
 * their authored text, so hex is the common case; rgb() covers the rest. */
function parseColor(value: string): [number, number, number] | null {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex?.[1] !== undefined) {
    const digits = hex[1];
    return [
      Number.parseInt(digits.slice(0, 2), 16),
      Number.parseInt(digits.slice(2, 4), 16),
      Number.parseInt(digits.slice(4, 6), 16),
    ];
  }
  const rgb = value.match(/^rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+)/);
  if (rgb?.[1] !== undefined && rgb[2] !== undefined && rgb[3] !== undefined) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  }
  return null;
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const scaled = value / 255;
    return scaled <= 0.03928
      ? scaled / 12.92
      : ((scaled + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(foreground: string, background: string): number | null {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  if (fg === null || bg === null) return null;
  const lighter = Math.max(relativeLuminance(fg), relativeLuminance(bg));
  const darker = Math.min(relativeLuminance(fg), relativeLuminance(bg));
  return (lighter + 0.05) / (darker + 0.05);
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function section(title: string, note?: string): HTMLElement {
  const container = element("section", "design-section");
  container.append(element("h2", undefined, title));
  if (note !== undefined) container.append(element("p", undefined, note));
  return container;
}

/* ---- Appearance state ---- */

function applyAppearance(): void {
  const root = document.documentElement;
  const theme = localStorage.getItem("design-theme") ?? "system";
  root.dataset.theme = theme;
  const light = localStorage.getItem("design-light-palette");
  const dark = localStorage.getItem("design-dark-palette");
  if (light !== null) root.dataset.lightPalette = light;
  if (dark !== null) root.dataset.darkPalette = dark;
}

function setAppearance(key: string, value: string): void {
  localStorage.setItem(key, value);
  applyAppearance();
  renderLiveValues();
  syncModePreviews();
}

/* ---- Sections ---- */

/** A miniature shell mockup painted from one palette's preview tokens. */
function modePreviewPane(paletteKind: "light" | "dark"): HTMLElement {
  const pane = element("span", "design-mode-pane");
  pane.dataset.paneMode = paletteKind;
  const sidebar = element("span", "design-mode-pane-sidebar");
  const lines = element("span", "design-mode-pane-lines");
  for (let index = 0; index < 3; index += 1) {
    lines.append(element("i"));
  }
  const accent = element("span", "design-mode-pane-accent");
  pane.append(sidebar, lines, accent);
  return pane;
}

/** Repaints every mode card's panes from the selected palettes' preview
 * tokens, so the cards always show the palettes the page would resolve. */
function syncModePreviews(): void {
  const light = localStorage.getItem("design-light-palette") ?? "manuscript";
  const dark = localStorage.getItem("design-dark-palette") ?? "nightroom";
  for (const pane of document.querySelectorAll<HTMLElement>(
    ".design-mode-pane",
  )) {
    const palette = pane.dataset.paneMode === "light" ? light : dark;
    pane.style.setProperty(
      "--design-pane-surface",
      `var(--skr-preview-${palette}-surface)`,
    );
    pane.style.setProperty(
      "--design-pane-text",
      `var(--skr-preview-${palette}-text)`,
    );
    pane.style.setProperty(
      "--design-pane-accent",
      `var(--skr-preview-${palette}-accent)`,
    );
  }
}

function headerBlock(): HTMLElement {
  const header = element("header", "design-header");
  const mark = element("img");
  mark.src = "/favicon.svg";
  mark.alt = "";
  const title = element("h1", undefined, "Skribeum design system");
  const modes = element("div", "design-mode-cards");
  modes.setAttribute("role", "group");
  modes.setAttribute("aria-label", "Color scheme");
  for (const mode of ["system", "light", "dark"]) {
    const button = element("button", "design-mode-card");
    button.type = "button";
    button.dataset.mode = mode;
    const preview = element("span", "design-mode-preview");
    if (mode === "light" || mode === "system") {
      preview.append(modePreviewPane("light"));
    }
    if (mode === "dark" || mode === "system") {
      const pane = modePreviewPane("dark");
      // The system card shows both halves at once: the dark pane overlays
      // the light one, clipped to the trailing half along a slanted seam.
      if (mode === "system") pane.classList.add("design-mode-pane-half");
      preview.append(pane);
    }
    button.append(preview, element("span", "design-mode-name", mode));
    button.addEventListener("click", () => {
      setAppearance("design-theme", mode);
      syncModeButtons();
    });
    modes.append(button);
  }
  header.append(mark, title, modes);
  return header;

  function syncModeButtons(): void {
    const active = document.documentElement.dataset.theme;
    for (const button of modes.querySelectorAll("button")) {
      button.setAttribute(
        "aria-pressed",
        String((button as HTMLElement).dataset.mode === active),
      );
    }
  }
}

function paletteStrip(): HTMLElement {
  const strip = element("span", "design-palette-strip");
  const heading = element("span", "strip-heading", "Aa Heading");
  const muted = element("span", "strip-muted", " muted ");
  const accent = element("span", "strip-accent", "accent ");
  const code = element("span", "strip-code", "mono");
  strip.append(heading, document.createElement("br"), muted, accent, code);
  return strip;
}

function paletteCard(
  palette: string,
  mode: "light" | "dark",
): HTMLButtonElement {
  const card = element("button", "design-palette-card");
  card.type = "button";
  const strip = paletteStrip();
  strip.classList.add("skr-palette-swatch");
  strip.dataset.palette = palette;
  const name = element("div", "design-palette-name");
  name.append(
    element("span", undefined, palette),
    element("span", undefined, mode),
  );
  card.append(strip, name);
  card.addEventListener("click", () => {
    setAppearance(`design-${mode}-palette`, palette);
    for (const other of document.querySelectorAll(
      `.design-palette-card[data-mode="${mode}"]`,
    )) {
      other.setAttribute("aria-pressed", String(other === card));
    }
  });
  card.dataset.mode = mode;
  card.dataset.palette = palette;
  return card;
}

function palettesSection(): HTMLElement {
  const container = section(
    "Palettes",
    "Three light and three dark palettes. Each card paints with its palette's own swatch tokens; selecting one switches the page, so every specimen below re-renders under it.",
  );
  const grid = element("div", "design-palette-grid");
  for (const palette of LIGHT_PALETTES)
    grid.append(paletteCard(palette, "light"));
  for (const palette of DARK_PALETTES)
    grid.append(paletteCard(palette, "dark"));
  container.append(grid);
  return container;
}

function tokenRow(token: string): HTMLElement {
  const row = element("div", "design-token-row");
  const chip = element("span", "design-token-chip");
  chip.style.background = `var(${token})`;
  const name = element("code", undefined, token);
  const value = element("span", "design-token-value");
  value.dataset.token = token;
  row.append(chip, name, value);
  return row;
}

function colorSection(): HTMLElement {
  const container = section(
    "Color roles",
    "Every color the interface may use, by role. Values are read from the live cascade for the active palette.",
  );
  for (const group of COLOR_GROUPS) {
    const heading = element("h3", undefined, group.title);
    heading.style.font = "inherit";
    heading.style.fontWeight = "600";
    const grid = element("div", "design-token-grid");
    for (const token of group.tokens) grid.append(tokenRow(token));
    container.append(heading, grid);
  }
  return container;
}

function typeSection(): HTMLElement {
  const container = section(
    "Typography",
    "Three families and the four fixed interface sizes. Editor prose scales independently and never moves the shell.",
  );
  const specimen = element("div", "design-type-specimen");
  const rows: [string, string, string][] = [
    ["prose", "specimen-prose", "The lamp is lit and the page is quiet."],
    [
      "interface",
      "specimen-interface",
      "Open vault · Settings · Search everywhere",
    ],
    ["mono", "specimen-mono", "skribeum --vault ~/notes 0.0.9"],
    ["chip 11px", "specimen-mono specimen-chip-size", "CTRL K"],
    ["label 12px", "specimen-interface specimen-label-size", "Appearance"],
    [
      "control 13px",
      "specimen-interface specimen-control-size",
      "Match system appearance",
    ],
    ["title 16px", "specimen-interface specimen-title-size", "Settings"],
  ];
  for (const [label, className, text] of rows) {
    const row = element("div");
    row.append(
      element("span", "design-type-label", label),
      element("span", className, text),
    );
    specimen.append(row);
  }
  container.append(specimen);
  return container;
}

function radiusSection(): HTMLElement {
  const container = section(
    "Radius and elevation",
    "Three radii, two shadows, tiered together: controls sit flat in their surface, floating surfaces carry the light shadow, and window-scale dialogs carry the deep one.",
  );
  const row = element("div", "design-radius-row");
  for (const [name, className, caption] of [
    ["control", "radius-control", "--skr-radius-control · no shadow"],
    [
      "surface",
      "radius-surface shadow-surface",
      "--skr-radius-surface · --skr-shadow-surface",
    ],
    [
      "dialog",
      "radius-dialog shadow-dialog",
      "--skr-radius-dialog · --skr-shadow",
    ],
  ]) {
    const figure = element("figure");
    const box = element("div", `radius-box ${className}`);
    box.dataset.radius = name;
    figure.append(box, element("figcaption", undefined, caption));
    row.append(figure);
  }
  container.append(row);
  return container;
}

function controlsSection(): HTMLElement {
  const container = section(
    "Controls",
    "Rest state carries no border unless the control is an input; depth comes from surface tone, not elevation.",
  );

  const buttons = element("div", "design-control-row");
  buttons.append(element("span", undefined, "buttons"));
  const primary = element("button", "skr-button-primary", "Open vault");
  const secondary = element("button", "skr-button-secondary", "History");
  const flat = element("button", "skr-button-flat", "Restore defaults");
  for (const button of [primary, secondary, flat]) button.type = "button";
  buttons.append(primary, secondary, flat);

  const inputs = element("div", "design-control-row");
  inputs.append(element("span", undefined, "input / slider"));
  const input = element("input", "design-input") as HTMLInputElement;
  input.placeholder = "Search everywhere…";
  const slider = element("input", "design-slider") as HTMLInputElement;
  slider.type = "range";
  const checkbox = element("input", "design-checkbox") as HTMLInputElement;
  checkbox.type = "checkbox";
  checkbox.checked = true;
  inputs.append(input, slider, checkbox);

  const segmented = element("div", "design-control-row");
  segmented.append(element("span", undefined, "segmented"));
  const group = element("div", "design-segmented");
  for (const [index, label] of ["Edit", "Read", "Source"].entries()) {
    const button = element("button", undefined, label);
    button.type = "button";
    button.setAttribute("aria-pressed", String(index === 0));
    button.addEventListener("click", () => {
      for (const sibling of group.querySelectorAll("button")) {
        sibling.setAttribute("aria-pressed", String(sibling === button));
      }
    });
    group.append(button);
  }
  segmented.append(group);

  const chips = element("div", "design-control-row");
  chips.append(element("span", undefined, "kbd chips"));
  for (const keys of ["Ctrl K", "Ctrl P", "Esc"]) {
    chips.append(element("kbd", "design-kbd", keys));
  }

  const toolbar = element("div", "design-control-row");
  toolbar.append(element("span", undefined, "selection toolbar"));
  const bar = element("div", "design-toolbar");
  for (const glyph of ["B", "I", "`", "S", "[["]) {
    const button = element("button", undefined, glyph);
    button.type = "button";
    bar.append(button);
  }
  toolbar.append(bar);

  const menu = element("div", "design-control-row");
  menu.append(element("span", undefined, "menu rows"));
  const list = element("div", "design-menu");
  for (const [label, keys] of [
    ["Rename note", "F2"],
    ["Reveal in tree", ""],
    ["Copy link", "Ctrl L"],
  ]) {
    const row = element("button");
    row.type = "button";
    row.append(element("span", undefined, label));
    if (keys !== "") row.append(element("kbd", "design-kbd", keys));
    list.append(row);
  }
  menu.append(list);

  const feedback = element("div", "design-control-row");
  feedback.append(element("span", undefined, "feedback"));
  const states = element("div", "design-status-row");
  for (const [tone, text] of [
    ["danger", "Vault is unreadable"],
    ["warning", "Note changed on disk"],
    ["success", "Saved"],
  ]) {
    const chip = element("span", "design-status", text);
    chip.dataset.tone = tone;
    states.append(chip);
  }
  feedback.append(states);

  const selection = element("div", "design-control-row");
  selection.append(element("span", undefined, "selection / caret"));
  const prose = element("p", "design-selection-specimen");
  prose.append(
    "The quick brown fox ",
    (() => {
      const marked = element("mark", undefined, "jumps over the lazy dog");
      return marked;
    })(),
    " and the page keeps its measure",
    element("span", "design-caret"),
  );
  selection.append(prose);

  container.append(
    buttons,
    inputs,
    segmented,
    chips,
    toolbar,
    menu,
    feedback,
    selection,
  );
  return container;
}

/** Reads a duration token from the element's cascade, in milliseconds. */
function tokenMilliseconds(styles: CSSStyleDeclaration, name: string): number {
  const value = styles.getPropertyValue(name).trim();
  if (value.endsWith("ms")) return Number.parseFloat(value);
  if (value.endsWith("s")) return Number.parseFloat(value) * 1000;
  return 0;
}

/** How long the box rests hidden between its exit and its entrance, so the
 * two phases read as two events rather than one flicker. */
const MOTION_REST_MILLISECONDS = 240;

function motionSection(): HTMLElement {
  const container = section(
    "Motion",
    "Three one-shot classes, opacity and position only. Every exit rides the 50ms state clock; each entrance uses its own class. Click a box to watch it leave and arrive. The caret blink and loading pulse are the only continuous indicators.",
  );
  const row = element("div", "design-motion-row");
  for (const [kind, label] of [
    ["state", "exit 50ms · enter 50ms state"],
    ["surface", "exit 50ms · enter 120ms surface"],
    ["panel", "exit 50ms · enter 160ms panel"],
  ]) {
    const figure = element("figure");
    const box = element("div", "design-motion-box", "replay");
    box.dataset.motion = kind;
    box.addEventListener("click", () => {
      if (box.dataset.playing === "true") return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        return;
      }
      box.dataset.playing = "true";
      const styles = getComputedStyle(box);
      const distance = styles.getPropertyValue("--skr-motion-distance").trim();
      const exit = box.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: tokenMilliseconds(styles, "--skr-motion-state-duration"),
        easing: "linear",
        fill: "forwards",
      });
      exit.onfinish = () => {
        setTimeout(() => {
          const enter =
            kind === "state"
              ? box.animate([{ opacity: 0 }, { opacity: 1 }], {
                  duration: tokenMilliseconds(
                    styles,
                    "--skr-motion-state-duration",
                  ),
                  easing: "linear",
                })
              : box.animate(
                  [
                    { opacity: 0, transform: `translateY(${distance})` },
                    { opacity: 1, transform: "translateY(0)" },
                  ],
                  {
                    duration: tokenMilliseconds(
                      styles,
                      `--skr-motion-${kind}-duration`,
                    ),
                    easing:
                      styles
                        .getPropertyValue(`--skr-motion-${kind}-easing`)
                        .trim() || "linear",
                  },
                );
          exit.cancel();
          enter.onfinish = () => {
            delete box.dataset.playing;
          };
        }, MOTION_REST_MILLISECONDS);
      };
    });
    figure.append(box, element("figcaption", undefined, label));
    row.append(figure);
  }
  container.append(row);
  return container;
}

function scalarSection(): HTMLElement {
  const container = section(
    "Scalar tokens",
    "Dimensions and durations, read from the live cascade.",
  );
  const grid = element("div", "design-token-grid");
  for (const token of SCALAR_TOKENS) {
    const row = element("div", "design-token-row");
    const name = element("code", undefined, token);
    const value = element("span", "design-token-value");
    value.dataset.token = token;
    row.append(name, value);
    grid.append(row);
  }
  container.append(grid);
  return container;
}

function contrastSection(): HTMLElement {
  const container = section(
    "Contrast",
    "WCAG 2.x ratios computed live from the active palette's resolved tokens. Text pairs are held to 4.5:1, component pairs to 3:1. A failing row is a defect in the palette, not in this page.",
  );
  const table = element("table", "design-contrast-table");
  const head = element("thead");
  const headRow = element("tr");
  for (const label of ["Pair", "Sample", "Ratio", "Floor", "Verdict"]) {
    headRow.append(element("th", undefined, label));
  }
  head.append(headRow);
  const body = element("tbody");
  body.id = "design-contrast-body";
  table.append(head, body);
  container.append(table);
  return container;
}

/* ---- Live value rendering ---- */

function renderLiveValues(): void {
  for (const node of document.querySelectorAll<HTMLElement>("[data-token]")) {
    const token = node.dataset.token;
    if (token !== undefined) node.textContent = readToken(token);
  }

  const body = document.getElementById("design-contrast-body");
  if (body === null) return;
  body.replaceChildren();
  for (const pair of CONTRAST_PAIRS) {
    const row = element("tr");
    const foreground = readToken(pair.fg);
    const background = readToken(pair.bg);
    const ratio = contrastRatio(foreground, background);
    const sample = element("span", "design-contrast-sample", "Aa 13px");
    sample.style.color = foreground;
    sample.style.background = background;
    const sampleCell = element("td");
    sampleCell.append(sample);
    const verdict = element("td");
    const verdictText = element(
      "span",
      undefined,
      ratio === null ? "?" : ratio >= pair.floor ? "pass" : "fail",
    );
    verdictText.dataset.verdict =
      ratio !== null && ratio >= pair.floor ? "pass" : "fail";
    verdict.append(verdictText);
    row.append(
      element("td", undefined, pair.label),
      sampleCell,
      element("td", undefined, ratio === null ? "–" : `${ratio.toFixed(2)}:1`),
      element("td", undefined, `${pair.floor}:1`),
      verdict,
    );
    body.append(row);
  }
}

/* ---- Assembly ---- */

applyAppearance();

const shell = element("div", "design-shell");
shell.append(
  headerBlock(),
  palettesSection(),
  colorSection(),
  typeSection(),
  radiusSection(),
  controlsSection(),
  motionSection(),
  scalarSection(),
  contrastSection(),
);
document.getElementById("design")?.append(shell);

for (const button of document.querySelectorAll(
  ".design-mode-card[data-mode]",
)) {
  button.setAttribute(
    "aria-pressed",
    String(
      button.getAttribute("data-mode") ===
        document.documentElement.dataset.theme,
    ),
  );
}
for (const card of document.querySelectorAll(".design-palette-card")) {
  const mode = card.getAttribute("data-mode");
  const active =
    mode === "light"
      ? (document.documentElement.dataset.lightPalette ?? "manuscript")
      : (document.documentElement.dataset.darkPalette ?? "nightroom");
  card.setAttribute(
    "aria-pressed",
    String(card.getAttribute("data-palette") === active),
  );
}

renderLiveValues();
syncModePreviews();

const colourScheme = window.matchMedia("(prefers-color-scheme: dark)");
colourScheme.addEventListener("change", () => renderLiveValues());
