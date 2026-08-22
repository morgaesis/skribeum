import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_DESCRIPTORS } from "../../src/lib/features/settingsCatalog";
import {
  DEFAULT_SETTINGS,
  type SettingsState,
} from "../../src/lib/features/settingsStore";
import type { UpdateState } from "../../src/lib/features/updates";
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

// The surface remembers the group it was showing across a close and reopen
// within one session, so each test starts from a known one.
afterEach(() => {
  document.body.innerHTML = "";
});

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
  if (targetSetting === null) openSection(STRINGS.settingsSectionAppearance);
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

/** Selects a group from the rail, which is the surface's only navigation. */
function openSection(label: string) {
  [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    .find((tab) => tab.textContent?.trim().startsWith(label))
    ?.click();
  flushSync();
}

function selectedTab(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    '[role="tab"][aria-selected="true"]',
  );
}

function railTabs(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
}

describe("task status settings", () => {
  it("renders one stable target row for every registered setting action", async () => {
    const { component } = renderSettings();
    const rowIds: (string | undefined)[] = [];
    for (const label of [
      STRINGS.settingsSectionAppearance,
      STRINGS.settingsSectionEditor,
      STRINGS.settingsSectionFiles,
      STRINGS.settingsSectionSearch,
      STRINGS.settingsSectionUpdates,
      STRINGS.settingsSectionAbout,
    ]) {
      openSection(label);
      rowIds.push(
        ...[...document.querySelectorAll<HTMLElement>("[data-setting-id]")].map(
          (row) => row.dataset.settingId,
        ),
      );
    }
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

  it("writes only the palette field a card owns, never the colour scheme", () => {
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

    expect(updates).toContainEqual({ light_palette: "studio" });
    expect(updates).toContainEqual({ dark_palette: "signal" });
    expect(updates.some((patch) => "theme" in patch)).toBe(false);
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
  it("shows one group at a time and names it once", async () => {
    const { component } = renderSettings();
    const headings = () =>
      [
        ...document.querySelectorAll<HTMLElement>(
          "[data-settings-section] > h3",
        ),
      ].map(({ textContent }) => textContent?.trim());
    expect(headings()).toEqual([STRINGS.settingsSectionAppearance]);
    openSection(STRINGS.settingsSectionUpdates);
    expect(headings()).toEqual([STRINGS.settingsSectionUpdates]);
    expect(
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-setting-id$=".version"]',
        ),
      ].map(({ dataset }) => dataset.settingId),
    ).toEqual(["updates.version"]);
    await unmount(component);
  });

  it("applies a palette with arrow keys without touching the colour scheme", async () => {
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
      expect(updates.at(-1)).toEqual({ light_palette: "studio" });
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
    const settings: [string, string][] = [
      [STRINGS.settingsSectionAppearance, "editor-font-size"],
      [STRINGS.settingsSectionAppearance, "editor-line-height"],
      [STRINGS.settingsSectionAppearance, "editor-line-width"],
      [STRINGS.settingsSectionEditor, "autosave-delay-ms"],
      [STRINGS.settingsSectionEditor, "indent-width"],
      [STRINGS.settingsSectionSearch, "search-result-limit"],
    ];
    for (const [section, setting] of settings) {
      openSection(section);
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
    openSection(STRINGS.settingsSectionUpdates);
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
    // The readout is caption-tier text. jsdom does not resolve custom
    // properties, so the token is what can be observed here; the pixel value
    // behind it is held to 12px by the interface type scale suite.
    expect(style.fontSize).toBe("var(--skr-type-label)");
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
    openSection(STRINGS.settingsSectionUpdates);
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

describe("settings navigation rail", () => {
  it("names the six groups as a vertical tablist with one selected", async () => {
    const { component } = renderSettings();
    const list = document.querySelector('[role="tablist"]');
    expect(list?.getAttribute("aria-orientation")).toBe("vertical");
    expect(list?.getAttribute("aria-label")).toBe(
      STRINGS.settingsSectionsLabel,
    );
    expect(railTabs().map((tab) => tab.textContent?.trim())).toEqual([
      STRINGS.settingsSectionAppearance,
      STRINGS.settingsSectionEditor,
      STRINGS.settingsSectionFiles,
      STRINGS.settingsSectionSearch,
      STRINGS.settingsSectionUpdates,
      STRINGS.settingsSectionAbout,
    ]);
    expect(
      railTabs().filter((tab) => tab.getAttribute("aria-selected") === "true"),
    ).toHaveLength(1);
    const pane = document.querySelector<HTMLElement>(".settings-content");
    expect(pane?.getAttribute("role")).toBe("tabpanel");
    expect(pane?.getAttribute("aria-labelledby")).toBe(selectedTab()?.id);
    await unmount(component);
  });

  it("keeps one rail stop in the tab order and swaps the pane on the arrow keys", async () => {
    const { component } = renderSettings();
    expect(
      railTabs()
        .filter((tab) => tab.getAttribute("aria-selected") !== "true")
        .every((tab) => tab.getAttribute("tabindex") === "-1"),
    ).toBe(true);
    expect(selectedTab()?.getAttribute("tabindex")).toBe("0");

    selectedTab()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(selectedTab()?.dataset.section).toBe("editor");
      expect(
        document.querySelector<HTMLElement>("[data-settings-section]")?.dataset
          .settingsSection,
      ).toBe("editor");
    });

    selectedTab()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(selectedTab()?.dataset.section).toBe("about");
    });
    selectedTab()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(selectedTab()?.dataset.section).toBe("appearance");
    });

    // The list is vertical, so the horizontal keys have no meaning in it.
    selectedTab()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    flushSync();
    expect(selectedTab()?.dataset.section).toBe("appearance");
    await unmount(component);
  });

  it("renders one group's rows and nothing belonging to another", async () => {
    const { component } = renderSettings();
    openSection(STRINGS.settingsSectionFiles);
    const groups = new Set(
      [...document.querySelectorAll<HTMLElement>("[data-setting-id]")].map(
        (row) => row.dataset.settingId?.split(".")[0],
      ),
    );
    expect([...groups]).toEqual(["files"]);
    await unmount(component);
  });

  it("turns the rail into a facet display while a query is active", async () => {
    const { component } = renderSettings();
    const search = document.querySelector<HTMLInputElement>(
      '[data-testid="settings-search"]',
    );
    if (search === null) throw new Error("settings search is missing");
    search.value = "width";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();

    expect(selectedTab()).toBeNull();
    const counts = Object.fromEntries(
      railTabs().map((tab) => [
        tab.dataset.section,
        Number(
          tab.querySelector(".settings-rail-count")?.textContent?.trim() ??
            "-1",
        ),
      ]),
    );
    const rendered = Object.fromEntries(
      [
        ...document.querySelectorAll<HTMLElement>("[data-settings-section]"),
      ].map((section) => [
        section.dataset.settingsSection,
        section.querySelectorAll("[data-setting-id]").length,
      ]),
    );
    for (const [section, count] of Object.entries(counts)) {
      expect(count, `${section} facet count`).toBe(rendered[section] ?? 0);
    }
    expect(
      railTabs()
        .filter((tab) => counts[tab.dataset.section ?? ""] === 0)
        .every((tab) => tab.getAttribute("aria-disabled") === "true"),
    ).toBe(true);

    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    flushSync();
    expect(selectedTab()?.dataset.section).toBe("appearance");
    await unmount(component);
  });

  it("marks a changed row, its group, and offers that row a reset", async () => {
    const updates: Partial<SettingsDocument>[] = [];
    const component = mount(SettingsView, {
      target: document.body,
      props: {
        // Every other value at its default, so the marks below can only come
        // from the one setting this test moved.
        settings: {
          loaded: true,
          error: null,
          errorSetting: null,
          document: { ...DEFAULT_SETTINGS, editor_font_size: 20 },
        },
        onUpdate: (patch: Partial<SettingsDocument>) => updates.push(patch),
        onClose: vi.fn(),
      },
    });
    flushSync();
    openSection(STRINGS.settingsSectionAppearance);

    const changed = [
      ...document.querySelectorAll<HTMLElement>("[data-setting-id].changed"),
    ].map((row) => row.dataset.settingId);
    expect(changed).toEqual(["appearance.font-size"]);
    expect(
      railTabs()
        .filter((tab) => tab.querySelector(".settings-rail-dot") !== null)
        .map((tab) => tab.dataset.section),
    ).toEqual(["appearance"]);

    const reset = document.querySelector<HTMLButtonElement>(
      '[data-setting-id="appearance.font-size"] [aria-label="Reset to default"]',
    );
    expect(reset?.getAttribute("title")).toBe(STRINGS.settingsResetToDefault);
    reset?.click();
    flushSync();
    expect(updates.at(-1)).toEqual({
      editor_font_size: DEFAULT_SETTINGS.editor_font_size,
    });
    await unmount(component);
  });

  it("gives rows that carry no setting no mark and no reset", async () => {
    const { component } = renderSettings();
    openSection(STRINGS.settingsSectionAbout);
    expect(document.querySelectorAll("[data-setting-id].changed")).toHaveLength(
      0,
    );
    expect(
      document.querySelectorAll('[aria-label="Reset to default"]'),
    ).toHaveLength(0);
    await unmount(component);
  });

  it("deletes the jump control and its glyph outright", async () => {
    const { component } = renderSettings();
    const dialog = document.querySelector<HTMLElement>(
      '[data-testid="settings-view"]',
    );
    expect(
      [...(dialog?.querySelectorAll("*") ?? [])].filter((element) =>
        /jump to section/i.test(element.getAttribute("aria-label") ?? ""),
      ),
    ).toHaveLength(0);
    expect(
      [...(dialog?.querySelectorAll("*") ?? [])].filter(
        (element) =>
          element.children.length === 0 && element.textContent?.trim() === "⋯",
      ),
    ).toHaveLength(0);
    expect(dialog?.querySelector('[aria-haspopup="menu"]')).toBeNull();
    await unmount(component);
  });

  it("draws both header controls as inline SVG on the 24-unit grid", async () => {
    const { component } = renderSettings();
    const close = button(STRINGS.closeAction);
    const glyph = close.querySelector("svg");
    expect(glyph?.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
    expect(close.textContent?.trim()).toBe("");
    await unmount(component);
  });
});

describe("appearance chooser", () => {
  it("offers three mode cards that write only the colour scheme", async () => {
    const { component, updates } = renderSettings();
    const group = document.querySelector<HTMLElement>(
      '[data-testid="settings-theme"]',
    );
    expect(group?.getAttribute("role")).toBe("radiogroup");
    expect(group?.getAttribute("aria-label")).toBe(STRINGS.settingsTheme);
    expect(
      [...(group?.querySelectorAll<HTMLElement>(".mode-card") ?? [])].map(
        (card) => card.dataset.mode,
      ),
    ).toEqual(["system", "light", "dark"]);

    document
      .querySelector<HTMLButtonElement>('[data-testid="settings-theme-dark"]')
      ?.click();
    flushSync();
    expect(updates.at(-1)).toEqual({ theme: "dark" });
    expect(updates.every((patch) => Object.keys(patch).length === 1)).toBe(
      true,
    );
    await unmount(component);
  });

  it("moves the colour scheme with the radiogroup's arrow keys", async () => {
    const { component, updates } = renderSettings();
    const system = document.querySelector<HTMLButtonElement>(
      '[data-testid="settings-theme-system"]',
    );
    expect(system?.getAttribute("aria-checked")).toBe("true");
    system?.focus();
    system?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await vi.waitFor(() => {
      expect(updates.at(-1)).toEqual({ theme: "light" });
      expect(document.activeElement).toBe(
        document.querySelector('[data-testid="settings-theme-light"]'),
      );
    });
    await unmount(component);
  });

  it("paints every miniature pane from the chosen palettes' preview tokens", async () => {
    const { component } = renderSettings();
    const panes = (mode: string) => [
      ...document.querySelectorAll<HTMLElement>(
        `[data-testid="settings-theme-${mode}"] .mode-pane`,
      ),
    ];
    const surfaceOf = (pane: HTMLElement) =>
      pane.style.getPropertyValue("--skr-mode-pane-surface");

    expect(panes("light")).toHaveLength(1);
    expect(panes("dark")).toHaveLength(1);
    expect(surfaceOf(panes("light")[0] as HTMLElement)).toBe(
      `var(--skr-preview-${DEFAULT_SETTINGS.light_palette}-surface)`,
    );
    expect(surfaceOf(panes("dark")[0] as HTMLElement)).toBe(
      `var(--skr-preview-${DEFAULT_SETTINGS.dark_palette}-surface)`,
    );

    // The System card holds both halves at once, the dark one clipped to the
    // trailing side of the slanted seam.
    const system = panes("system");
    expect(system).toHaveLength(2);
    expect(system[0]?.classList.contains("mode-pane-half")).toBe(false);
    expect(system[1]?.classList.contains("mode-pane-half")).toBe(true);
    expect(
      readFileSync(
        path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "..",
          "..",
          "src",
          "lib",
          "SettingsView.svelte",
        ),
        "utf8",
      ),
    ).toContain("clip-path: polygon(58% 0, 100% 0, 100% 100%, 42% 100%)");

    // Every pane carries the sidebar strip, three bars and the accent dot.
    for (const pane of [
      ...panes("system"),
      ...panes("light"),
      ...panes("dark"),
    ]) {
      expect(pane.querySelector(".mode-pane-sidebar")).not.toBeNull();
      expect(pane.querySelectorAll(".mode-pane-lines i")).toHaveLength(3);
      expect(pane.querySelector(".mode-pane-accent")).not.toBeNull();
    }
    await unmount(component);
  });

  it("repaints the previews in the frame a palette choice changes", async () => {
    const updates: Partial<SettingsDocument>[] = [];
    const state = settingsState();
    state.document = { ...state.document, light_palette: "gazette" };
    const component = mount(SettingsView, {
      target: document.body,
      props: {
        settings: state,
        onUpdate: (patch: Partial<SettingsDocument>) => updates.push(patch),
        onClose: vi.fn(),
      },
    });
    flushSync();
    openSection(STRINGS.settingsSectionAppearance);
    for (const mode of ["light", "system"]) {
      const pane = document.querySelector<HTMLElement>(
        `[data-testid="settings-theme-${mode}"] .mode-pane`,
      );
      expect(pane?.style.getPropertyValue("--skr-mode-pane-surface")).toBe(
        "var(--skr-preview-gazette-surface)",
      );
      expect(pane?.style.getPropertyValue("--skr-mode-pane-accent")).toBe(
        "var(--skr-preview-gazette-accent)",
      );
    }
    await unmount(component);
  });

  it("no longer offers a match-system switch", async () => {
    const { component } = renderSettings();
    expect(
      document.querySelector('[data-testid="settings-match-system"]'),
    ).toBeNull();
    await unmount(component);
  });
});

describe("update install and restart", () => {
  function mountWithUpdateState(
    updateState: UpdateState,
    overrides: {
      desktopAvailable?: boolean;
      onInstallUpdate?: () => void;
      onRestartUpdate?: () => void;
    } = {},
  ) {
    const component = mount(SettingsView, {
      target: document.body,
      props: {
        settings: settingsState(),
        onUpdate: vi.fn(),
        onClose: vi.fn(),
        updateState,
        desktopAvailable: overrides.desktopAvailable ?? true,
        onInstallUpdate: overrides.onInstallUpdate ?? vi.fn(),
        onRestartUpdate: overrides.onRestartUpdate ?? vi.fn(),
        onCheckUpdate: vi.fn(),
      },
    });
    flushSync();
    openSection(STRINGS.settingsSectionUpdates);
    return component;
  }

  it("offers an install action, naming what it does, once an update is available", async () => {
    const onInstallUpdate = vi.fn();
    const component = mountWithUpdateState(
      { kind: "available", version: "9.9.9", notes: "" },
      { onInstallUpdate },
    );
    const install = document.querySelector<HTMLButtonElement>(
      '[data-testid="settings-install-update"]',
    );
    if (install === null) throw new Error("install button is missing");
    expect(install.textContent?.trim()).toBe(STRINGS.updateInstall);
    expect(install.disabled).toBe(false);
    expect(
      document.querySelector('[data-testid="settings-restart-update"]'),
    ).toBeNull();
    install.click();
    expect(onInstallUpdate).toHaveBeenCalledTimes(1);
    await unmount(component);
  });

  it("disables the install action when the desktop application is unavailable", async () => {
    const component = mountWithUpdateState(
      { kind: "available", version: "9.9.9", notes: "" },
      { desktopAvailable: false },
    );
    const install = document.querySelector<HTMLButtonElement>(
      '[data-testid="settings-install-update"]',
    );
    expect(install?.disabled).toBe(true);
    await unmount(component);
  });

  it("shows release notes inline, collapsed under a disclosure", async () => {
    const component = mountWithUpdateState({
      kind: "available",
      version: "9.9.9",
      notes: "Fixes a rendering bug.\nAdds dark mode polish.",
    });
    const details = document.querySelector<HTMLDetailsElement>(".update-notes");
    if (details === null) throw new Error("release notes are missing");
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe(
      STRINGS.updateNotesSummary,
    );
    expect(details.querySelector("p")?.textContent).toBe(
      "Fixes a rendering bug.\nAdds dark mode polish.",
    );
    await unmount(component);
  });

  it("omits the release notes disclosure when the check returned none", async () => {
    const component = mountWithUpdateState({
      kind: "available",
      version: "9.9.9",
      notes: "",
    });
    expect(document.querySelector(".update-notes")).toBeNull();
    await unmount(component);
  });

  it("shows a determinate progress bar while a known-size download runs", async () => {
    const component = mountWithUpdateState({
      kind: "downloading",
      version: "9.9.9",
      percent: 42,
    });
    const bar = document.querySelector<HTMLElement>('[role="progressbar"]');
    if (bar === null) throw new Error("progress bar is missing");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    const fill = bar.querySelector<HTMLElement>(".update-progress-fill");
    expect(fill?.style.width).toBe("42%");
    await unmount(component);
  });

  it("shows an honest indeterminate progress bar when no download size is known", async () => {
    const component = mountWithUpdateState({
      kind: "downloading",
      version: "9.9.9",
      percent: null,
    });
    const bar = document.querySelector<HTMLElement>('[role="progressbar"]');
    if (bar === null) throw new Error("progress bar is missing");
    // No known value: the ARIA value attribute is absent rather than stuck
    // at 0, which is what makes this read as indeterminate rather than a
    // download that froze immediately.
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    // The unknown-progress fill still animates, so it never reads as an
    // indicator that simply stopped.
    const pulsing = bar.querySelector(".skr-skeleton-bar");
    expect(pulsing).not.toBeNull();
    await unmount(component);
  });

  it("offers a restart action once the update is installed and waiting", async () => {
    const onRestartUpdate = vi.fn();
    const component = mountWithUpdateState(
      { kind: "ready", version: "9.9.9" },
      { onRestartUpdate },
    );
    const restart = document.querySelector<HTMLButtonElement>(
      '[data-testid="settings-restart-update"]',
    );
    if (restart === null) throw new Error("restart button is missing");
    expect(restart.textContent?.trim()).toBe(STRINGS.updateRestart);
    expect(restart.disabled).toBe(false);
    expect(
      document.querySelector('[data-testid="settings-install-update"]'),
    ).toBeNull();
    restart.click();
    expect(onRestartUpdate).toHaveBeenCalledTimes(1);
    await unmount(component);
  });

  it("announces a security failure assertively", async () => {
    const component = mountWithUpdateState({
      kind: "failed",
      message: STRINGS.updateFailedSignature,
      security: true,
    });
    const status = document.querySelector<HTMLElement>(".update-status");
    if (status === null) throw new Error("update status text is missing");
    expect(status.getAttribute("role")).toBe("alert");
    expect(status.textContent).toBe(STRINGS.updateFailedSignature);
    await unmount(component);
  });

  it("renders an ordinary update failure as a polite status, not an alert", async () => {
    const component = mountWithUpdateState({
      kind: "failed",
      message: STRINGS.updateFailedNetwork,
      security: false,
    });
    const status = document.querySelector<HTMLElement>(".update-status");
    expect(status?.getAttribute("role")).toBe("status");
    await unmount(component);
  });

  it("visually distinguishes a security failure from an ordinary one", async () => {
    const securityComponent = mountWithUpdateState({
      kind: "failed",
      message: STRINGS.updateFailedSignature,
      security: true,
    });
    const securityColor = getComputedStyle(
      document.querySelector(".update-status") as Element,
    ).color;
    await unmount(securityComponent);

    const ordinaryComponent = mountWithUpdateState({
      kind: "failed",
      message: STRINGS.updateFailedNetwork,
      security: false,
    });
    const ordinaryColor = getComputedStyle(
      document.querySelector(".update-status") as Element,
    ).color;
    await unmount(ordinaryComponent);

    expect(securityColor).not.toBe(ordinaryColor);
  });
});
