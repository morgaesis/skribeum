import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";
import { SETTINGS_DESCRIPTORS } from "../../src/lib/features/settingsCatalog";
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

function renderSettings(targetSetting: string | null = null) {
  const updates: Partial<SettingsDocument>[] = [];
  const component = mount(SettingsView, {
    target: document.body,
    props: {
      settings: settingsState(),
      onUpdate: (patch: Partial<SettingsDocument>) => updates.push(patch),
      onClose: vi.fn(),
      targetSetting,
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
  it("renders one stable target row for every registered setting action", async () => {
    const { component } = renderSettings();
    const rowIds = [
      ...document.querySelectorAll<HTMLElement>("[data-setting-id]"),
    ].map((row) => row.dataset.settingId);
    const visibleSettingIds = SETTINGS_DESCRIPTORS.map((setting) => setting.id);
    expect(new Set(rowIds)).toEqual(new Set(visibleSettingIds));
    expect(rowIds).toHaveLength(visibleSettingIds.length);
    await unmount(component);
  });

  it("focuses a registered setting target without changing its value", async () => {
    const initial = settingsState().document.editor_line_width;
    const { component, updates } = renderSettings("appearance.line-width");
    await vi.waitFor(() => {
      expect(
        document.activeElement?.closest<HTMLElement>("[data-setting-id]")
          ?.dataset.settingId,
      ).toBe("appearance.line-width");
    });
    expect(updates).toEqual([]);
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="settings-line-width"]',
      )?.value,
    ).toBe(String(initial));
    await unmount(component);
  });

  it("focuses the target row when its desktop control is unavailable", async () => {
    const component = mount(SettingsView, {
      target: document.body,
      props: {
        settings: settingsState(),
        onUpdate: vi.fn(),
        onClose: vi.fn(),
        desktopAvailable: false,
        targetSetting: "files.default-note-folder",
      },
    });
    await vi.waitFor(() => {
      expect(document.activeElement?.dataset.settingId).toBe(
        "files.default-note-folder",
      );
    });
    await unmount(component);
  });

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

  it("toggles the section menu: a second click on the same trigger closes it", async () => {
    const { component } = renderSettings();
    const jump = document.querySelector<HTMLButtonElement>(
      '[data-testid="settings-jump"]',
    );
    expect(jump?.getAttribute("aria-expanded")).toBe("false");

    jump?.click();
    flushSync();
    expect(
      document.querySelector('[data-testid="settings-jump-menu"]'),
    ).not.toBeNull();
    expect(jump?.getAttribute("aria-expanded")).toBe("true");

    jump?.click();
    flushSync();
    expect(
      document.querySelector('[data-testid="settings-jump-menu"]'),
    ).toBeNull();
    expect(jump?.getAttribute("aria-expanded")).toBe("false");

    await unmount(component);
  });

  it("updates palette and link preview preferences", () => {
    const { component, updates } = renderSettings();
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="settings-palette-studio"]',
      )
      ?.click();
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="settings-palette-signal"]',
      )
      ?.click();
    openSection("Editor");
    document
      .querySelector<HTMLInputElement>('[data-testid="settings-link-previews"]')
      ?.click();

    expect(updates).toContainEqual({
      theme: "light",
      light_palette: "studio",
    });
    expect(updates).toContainEqual({
      theme: "dark",
      dark_palette: "signal",
    });
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

  it("edits effective tracks and optional payload kinds", async () => {
    const { component, updates } = renderSettings();
    openSection("Editor");
    const track = document.querySelector<HTMLButtonElement>(
      '[data-testid="task-status-track"]',
    );
    expect(track?.textContent).toBe("Task");
    track?.click();
    flushSync();
    [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(({ textContent }) => textContent === "Time")
      ?.click();
    expect(updates.at(-1)?.task_statuses?.[0]?.track).toBe("time");

    const payload = document.querySelector<HTMLButtonElement>(
      '[data-testid="task-status-payload"]',
    );
    payload?.click();
    flushSync();
    [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
      .find(({ textContent }) => textContent === "Due date")
      ?.click();
    expect(updates.at(-1)?.task_statuses?.[0]?.payload).toBe("date");
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
    expect(
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-setting-id$=".version"]',
        ),
      ].map(({ dataset }) => dataset.settingId),
    ).toEqual(["updates.version"]);
    await unmount(component);
  });

  it("applies a palette and its mode with arrow keys", async () => {
    const { component, updates } = renderSettings();
    const manuscript = document.querySelector<HTMLButtonElement>(
      '[data-testid="settings-palette-manuscript"]',
    );
    const studio = document.querySelector<HTMLButtonElement>(
      '[data-testid="settings-palette-studio"]',
    );
    manuscript?.focus();
    manuscript?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(updates.at(-1)).toEqual({
        theme: "light",
        light_palette: "studio",
      });
      expect(document.activeElement).toBe(studio);
    });
    await unmount(component);
  });

  it("commits, clamps, snaps, and reverts typed slider values", async () => {
    const { component, updates } = renderSettings();
    const readout = document.querySelector<HTMLButtonElement>(
      '[data-testid="settings-editor-line-height-readout"]',
    );
    readout?.click();
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLInputElement>(
          '[data-testid="settings-editor-line-height-entry"]',
        ),
      ).not.toBeNull();
    });
    let entry = document.querySelector<HTMLInputElement>(
      '[data-testid="settings-editor-line-height-entry"]',
    );
    if (entry === null) throw new Error("line-height entry is missing");
    entry.value = "999";
    entry.dispatchEvent(new Event("input", { bubbles: true }));
    entry.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(updates.at(-1)).toEqual({ editor_line_height: 220 });
    });

    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="settings-editor-line-height-readout"]',
      )
      ?.click();
    await vi.waitFor(() => {
      entry = document.querySelector<HTMLInputElement>(
        '[data-testid="settings-editor-line-height-entry"]',
      );
      expect(entry).not.toBeNull();
    });
    if (entry === null) throw new Error("line-height entry is missing");
    entry.value = "173";
    entry.dispatchEvent(new Event("input", { bubbles: true }));
    entry.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(updates.at(-1)).toEqual({ editor_line_height: 175 });
    });

    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="settings-editor-line-height-readout"]',
      )
      ?.click();
    await vi.waitFor(() => {
      entry = document.querySelector<HTMLInputElement>(
        '[data-testid="settings-editor-line-height-entry"]',
      );
      expect(entry).not.toBeNull();
    });
    if (entry === null) throw new Error("line-height entry is missing");
    entry.value = "180";
    entry.dispatchEvent(new Event("input", { bubbles: true }));
    entry.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(updates).toHaveLength(2);
      expect(document.activeElement?.getAttribute("data-numeric-readout")).toBe(
        "editor_line_height",
      );
    });
    await unmount(component);
  });

  it("keeps focus on a control clicked while numeric entry commits", async () => {
    const { component, updates } = renderSettings();
    document
      .querySelector<HTMLButtonElement>(
        '[data-testid="settings-editor-line-height-readout"]',
      )
      ?.click();
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-numeric-entry="editor_line_height"]'),
      ).not.toBeNull();
    });
    const search = document.querySelector<HTMLInputElement>(
      '[data-testid="settings-search"]',
    );
    if (search === null) throw new Error("settings search is missing");
    search.focus();
    await vi.waitFor(() => {
      expect(updates.at(-1)).toEqual({ editor_line_height: 170 });
      expect(document.activeElement).toBe(search);
    });
    await unmount(component);
  });

  it("provides typed entry for every numeric readout", async () => {
    const { component } = renderSettings();
    const settings = [
      "editor-font-size",
      "editor-line-height",
      "editor-line-width",
      "autosave-delay-ms",
      "indent-width",
      "search-result-limit",
    ];
    for (const setting of settings) {
      const readout = document.querySelector<HTMLButtonElement>(
        `[data-testid="settings-${setting}-readout"]`,
      );
      expect(readout?.tabIndex).toBe(0);
      readout?.click();
      await vi.waitFor(() => {
        expect(
          document.querySelector(`[data-testid="settings-${setting}-entry"]`),
        ).not.toBeNull();
      });
      document
        .querySelector<HTMLInputElement>(
          `[data-testid="settings-${setting}-entry"]`,
        )
        ?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      await vi.waitFor(() => {
        expect(
          document.querySelector(`[data-testid="settings-${setting}-readout"]`),
        ).not.toBeNull();
      });
    }
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
    expect(document.body.textContent).toContain(
      STRINGS.settingsDefaultNoteFolderDesktopRequired,
    );
    expect(document.body.textContent).toContain(
      STRINGS.settingsAttachmentFolderDesktopRequired,
    );
    expect(document.body.textContent).toContain(
      STRINGS.settingsObsidianDesktopRequired,
    );
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="settings-default-note-folder"]',
      )?.disabled,
    ).toBe(true);
    expect(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[data-setting-id="files.attachment-folder"] button',
        ),
      ].every(({ disabled }) => disabled),
    ).toBe(true);
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-setting-id="files.obsidian-config"] input',
      )?.disabled,
    ).toBe(true);
    const search = document.querySelector<HTMLInputElement>(
      '[data-testid="settings-search"]',
    );
    if (search === null) throw new Error("settings search is missing");
    search.value = "desktop application";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(document.body.textContent).toContain(
      STRINGS.settingsDefaultNoteFolderDesktopRequired,
    );
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    openSection(STRINGS.settingsSectionUpdates);
    expect(document.body.textContent).toContain(
      STRINGS.settingsUpdateChannelDesktopRequired,
    );
    expect(document.body.textContent).toContain(
      STRINGS.settingsCheckUpdatesDesktopRequired,
    );
    expect(
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[data-setting-id="updates.channel"] button',
        ),
      ].every(({ disabled }) => disabled),
    ).toBe(true);
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="settings-check-updates"]',
      )?.disabled,
    ).toBe(true);
    openSection(STRINGS.settingsSectionAbout);
    expect(document.body.textContent).toContain(
      STRINGS.settingsFileDesktopRequired,
    );
    await unmount(component);
  });

  it("shows the installed version beside the update check", async () => {
    const component = mount(SettingsView, {
      target: document.body,
      props: {
        settings: settingsState(),
        onUpdate: vi.fn(),
        onClose: vi.fn(),
        currentVersion: "9.9.9",
      },
    });
    flushSync();
    const row = document.querySelector<HTMLElement>(
      '[data-setting-id="updates.version"]',
    );
    expect(
      row
        ?.closest("[data-settings-section]")
        ?.getAttribute("data-settings-section"),
    ).toBe("updates");
    expect(row?.querySelector(".setting-label")?.textContent).toBe(
      STRINGS.settingsVersion,
    );
    const value = row?.querySelector("output");
    if (row === null || value === null || value === undefined) {
      throw new Error("version row is missing");
    }
    expect(value.textContent).toBe("9.9.9");
    const checkRow = document.querySelector<HTMLElement>(
      '[data-setting-id="updates.check"]',
    );
    if (checkRow === null) throw new Error("update check row is missing");
    expect(checkRow.closest("fieldset")?.nextElementSibling).toBe(row);
    const style = getComputedStyle(value);
    expect(style.fontSize).toBe("12px");
    expect(style.textAlign).toBe("right");
    await unmount(component);
  });

  it("keeps the version readable when the desktop backend is unavailable", async () => {
    const component = mount(SettingsView, {
      target: document.body,
      props: {
        settings: settingsState(),
        onUpdate: vi.fn(),
        onClose: vi.fn(),
        desktopAvailable: false,
        currentVersion: "9.9.9",
      },
    });
    flushSync();
    const value = document.querySelector<HTMLOutputElement>(
      '[data-setting-id="updates.version"] output',
    );
    expect(value?.textContent).toBe("9.9.9");
    expect(value?.closest("fieldset:disabled")).toBeNull();
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="settings-check-updates"]',
      )?.disabled,
    ).toBe(true);
    await unmount(component);
  });
});
