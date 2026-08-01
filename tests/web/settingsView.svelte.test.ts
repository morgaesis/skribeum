import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  type SettingsState,
} from "../../src/lib/features/settingsStore";
import type { SettingsDocument } from "../../src/lib/ipc/services";
import SettingsView from "../../src/lib/SettingsView.svelte";
import { STRINGS } from "../../src/lib/strings";
import type { TaskStatus } from "../../src/lib/taskStatuses";

const TASK_STATUSES: TaskStatus[] = [
  {
    symbol: " ",
    name: "Ready",
    category: "TODO",
    glyph: "○",
    color_token: "--skr-accent",
    next_status: "~",
  },
  {
    symbol: "~",
    name: "Paused",
    category: "ON_HOLD",
    glyph: "Ⅱ",
    color_token: "--skr-warning",
    next_status: "x",
  },
  {
    symbol: "x",
    name: "Finished",
    category: "DONE",
    glyph: "✓",
    color_token: "--skr-success",
    next_status: " ",
  },
];

function settingsState(): SettingsState {
  return {
    loaded: true,
    error: null,
    errorSetting: null,
    document: {
      ...DEFAULT_SETTINGS,
      task_statuses: TASK_STATUSES.map((status) => ({ ...status })),
    },
  };
}

function renderSettings() {
  const updates: Partial<SettingsDocument>[] = [];
  const component = mount(SettingsView, {
    target: document.body,
    props: {
      settings: settingsState(),
      onUpdate: (patch: Partial<SettingsDocument>) => updates.push(patch),
      onClose: vi.fn(),
    },
  });
  flushSync();
  return { component, updates };
}

function button(label: string): HTMLButtonElement {
  const candidate = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (candidate === null) {
    throw new Error(`button not found: ${label}`);
  }
  return candidate;
}

function openSection(label: string) {
  document
    .querySelector<HTMLButtonElement>('[data-testid="settings-jump"]')
    ?.click();
  flushSync();
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    .find(({ textContent }) => textContent === label)
    ?.click();
  flushSync();
}

describe("task status settings", () => {
  it("reopens the section menu after a jump", async () => {
    const { component } = renderSettings();
    const jump = document.querySelector<HTMLButtonElement>(
      '[data-testid="settings-jump"]',
    );
    jump?.click();
    flushSync();
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')?.click();
    flushSync();

    expect(jump?.closest(".settings-header")?.hasAttribute("inert")).toBe(
      false,
    );
    jump?.click();
    flushSync();
    expect(
      document.querySelector('[data-testid="settings-jump-menu"]'),
    ).not.toBeNull();

    await unmount(component);
  });

  it("updates palette and link preview preferences", () => {
    const { component, updates } = renderSettings();
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="settings-light-palette-studio"]',
      )
      ?.click();
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="settings-dark-palette-signal"]',
      )
      ?.click();
    openSection("Editor");
    document
      .querySelector<HTMLInputElement>('[data-testid="settings-link-previews"]')
      ?.click();

    expect(updates).toContainEqual({ light_palette: "studio" });
    expect(updates).toContainEqual({ dark_palette: "signal" });
    expect(updates).toContainEqual({ link_previews: false });
    unmount(component);
  });

  it("remaps a symbol and every transition that targets it", async () => {
    const { component, updates } = renderSettings();
    openSection("Editor");
    expect(
      document.querySelectorAll('[data-testid="task-status-row"]'),
    ).toHaveLength(3);
    const symbol = document.querySelector<HTMLInputElement>(
      '[data-testid="task-status-symbol"]',
    );
    expect(symbol).not.toBeNull();
    if (symbol === null) return;
    symbol.focus();
    symbol.value = "u";
    symbol.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();

    const statuses = updates.at(-1)?.task_statuses;
    expect(statuses?.map((status) => status.symbol)).toEqual(["u", "~", "x"]);
    expect(statuses?.find((status) => status.symbol === "x")?.next_status).toBe(
      "u",
    );
    expect(document.activeElement).toBe(symbol);
    await unmount(component);
  });

  it("reorders, removes, and adds statuses without breaking transitions", async () => {
    let rendered = renderSettings();
    openSection("Editor");
    button("Move status down: Ready").click();
    flushSync();
    expect(
      rendered.updates.at(-1)?.task_statuses?.map((status) => status.symbol),
    ).toEqual(["~", " ", "x"]);
    await unmount(rendered.component);

    rendered = renderSettings();
    openSection("Editor");
    button("Remove status: Paused").click();
    flushSync();
    const remaining = rendered.updates.at(-1)?.task_statuses;
    expect(remaining?.map((status) => status.symbol)).toEqual([" ", "x"]);
    expect(remaining?.[0]?.next_status).toBe("x");
    await unmount(rendered.component);

    rendered = renderSettings();
    openSection("Editor");
    document
      .querySelector<HTMLButtonElement>('[data-testid="task-status-add"]')
      ?.click();
    flushSync();
    const added = rendered.updates.at(-1)?.task_statuses;
    expect(added).toHaveLength(4);
    expect(added?.at(-1)).toMatchObject({
      symbol: "a",
      name: "New status",
      next_status: " ",
    });
    await unmount(rendered.component);
  });

  it("restores an invalid status edit and explains the error", async () => {
    const { component, updates } = renderSettings();
    openSection("Editor");
    const symbols = document.querySelectorAll<HTMLInputElement>(
      '[data-testid="task-status-symbol"]',
    );
    const first = symbols[0];
    if (first === undefined) throw new Error("task symbol input is missing");
    first.value = "~";
    first.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();
    expect(first.value).toBe(" ");
    expect(updates).toEqual([]);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "unique symbol",
    );
    await unmount(component);
  });

  it("offers only provided theme colour tokens", async () => {
    const { component, updates } = renderSettings();
    openSection("Editor");
    const color = document.querySelector<HTMLButtonElement>(
      '[data-testid="task-status-color"]',
    );
    if (color === null) throw new Error("task colour control is missing");
    color.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    });
    const options = [
      ...document.querySelectorAll<HTMLButtonElement>(
        '[role="listbox"] [role="option"]',
      ),
    ];
    expect(
      options.some(({ textContent }) => textContent === "--skr-not-defined"),
    ).toBe(false);
    options
      .find(({ textContent }) => textContent === "--skr-callout-purple")
      ?.click();
    expect(updates.at(-1)?.task_statuses?.[0]?.color_token).toBe(
      "--skr-callout-purple",
    );
    await unmount(component);
  });

  it("uses keyboard-operable listboxes for task enums", async () => {
    const { component, updates } = renderSettings();
    openSection("Editor");
    expect(document.querySelector(".task-status-table select")).toBeNull();
    const category = document.querySelector<HTMLButtonElement>(
      '[data-testid="task-status-category"]',
    );
    if (category === null) throw new Error("task category control is missing");
    category.focus();
    category.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(document.activeElement?.getAttribute("role")).toBe("option");
    });
    const listbox = document.querySelector<HTMLElement>('[role="listbox"]');
    expect(listbox).not.toBeNull();
    const onHold = [
      ...(listbox?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ].find(({ textContent }) => textContent === "On hold");
    onHold?.click();
    expect(updates.at(-1)?.task_statuses?.[0]?.category).toBe("ON_HOLD");
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(category);
    });
    await unmount(component);
  });
});

describe("settings surface", () => {
  it("names every section once in one scrolling pane", async () => {
    const { component } = renderSettings();
    const headings = [
      ...document.querySelectorAll<HTMLElement>("[data-settings-section] > h3"),
    ].map(({ textContent }) => textContent?.trim());
    expect(headings).toEqual([
      STRINGS.settingsSectionAppearance,
      STRINGS.settingsSectionEditor,
      STRINGS.settingsSectionFiles,
      STRINGS.settingsSectionSearch,
      STRINGS.settingsSectionUpdates,
      STRINGS.settingsSectionAbout,
    ]);
    expect(document.querySelector(".settings-nav")).toBeNull();
    await unmount(component);
  });

  it("changes the direct theme control with arrow keys", async () => {
    const { component, updates } = renderSettings();
    const system = document.querySelector<HTMLButtonElement>(
      '[data-testid="settings-theme-system"]',
    );
    const light = document.querySelector<HTMLButtonElement>(
      '[data-testid="settings-theme-light"]',
    );
    system?.focus();
    system?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    flushSync();
    expect(updates.at(-1)).toEqual({ theme: "light" });
    expect(document.activeElement).toBe(light);
    await unmount(component);
  });

  it("filters settings by name and description", async () => {
    const { component } = renderSettings();
    const search = document.querySelector<HTMLInputElement>(
      '[data-testid="settings-search"]',
    );
    if (search === null) throw new Error("settings search is missing");
    search.value = "text column width";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(document.body.textContent).toContain("Text column width");
    expect(document.body.textContent).not.toContain("Autosave delay");
    await unmount(component);
  });

  it("previews a slider live and restores it when closing", async () => {
    const onPreview = vi.fn();
    const onClose = vi.fn();
    const component = mount(SettingsView, {
      target: document.body,
      props: {
        settings: settingsState(),
        onUpdate: vi.fn(),
        onPreview,
        onClose,
      },
    });
    flushSync();
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="settings-font-size"]',
    );
    if (input === null) throw new Error("font size input is missing");
    input.value = "20";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(input.closest(".slider-control")?.textContent).toContain("20 px");
    document
      .querySelector<HTMLButtonElement>(".settings-header .icon-button")
      ?.click();
    expect(onPreview).toHaveBeenLastCalledWith({
      editor_font_size: 16,
      editor_line_height: 170,
      editor_line_width: 72,
    });
    expect(onClose).toHaveBeenCalledOnce();
    await unmount(component);
  });

  it("clears live preview before restoring the complete defaults", async () => {
    const onPreview = vi.fn();
    const updates: Partial<SettingsDocument>[] = [];
    const component = mount(SettingsView, {
      target: document.body,
      props: {
        settings: settingsState(),
        onUpdate: (patch: Partial<SettingsDocument>) => updates.push(patch),
        onPreview,
        onClose: vi.fn(),
      },
    });
    flushSync();
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="settings-font-size"]',
    );
    if (input === null) throw new Error("font size input is missing");
    input.value = "20";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();

    const restore = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find(({ textContent }) => textContent?.trim() === "Restore defaults");
    if (restore === undefined) throw new Error("restore defaults is missing");
    restore.click();
    flushSync();

    expect(onPreview).toHaveBeenLastCalledWith({
      editor_font_size: 16,
      editor_line_height: 170,
      editor_line_width: 72,
    });
    expect(updates.at(-1)).toEqual(DEFAULT_SETTINGS);
    expect(input.value).toBe("16");
    await unmount(component);
  });

  it("marks desktop-only controls unavailable in the browser", async () => {
    const component = mount(SettingsView, {
      target: document.body,
      props: {
        settings: settingsState(),
        onUpdate: vi.fn(),
        onClose: vi.fn(),
        desktopAvailable: false,
      },
    });
    flushSync();
    openSection(STRINGS.settingsSectionFiles);
    expect(
      document
        .querySelector<HTMLElement>(
          '[data-testid="settings-desktop-unavailable"]',
        )
        ?.textContent?.trim(),
    ).toBe(STRINGS.settingsDesktopOnly);
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="settings-default-note-folder"]',
      )?.disabled,
    ).toBe(true);
    openSection(STRINGS.settingsSectionUpdates);
    expect(
      document
        .querySelector<HTMLElement>(
          '[data-testid="settings-desktop-unavailable"]',
        )
        ?.textContent?.trim(),
    ).toBe(STRINGS.settingsDesktopOnly);
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="settings-check-updates"]',
      )?.disabled,
    ).toBe(true);
    await unmount(component);
  });
});
