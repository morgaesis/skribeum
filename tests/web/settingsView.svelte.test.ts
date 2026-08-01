import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";
import type { SettingsState } from "../../src/lib/features/settingsStore";
import type { SettingsDocument } from "../../src/lib/ipc/services";
import SettingsView from "../../src/lib/SettingsView.svelte";
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
    document: {
      schema_version: 1,
      theme: "system",
      editor_font_size: 16,
      editor_reading_measure: 72,
      search_result_limit: 50,
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

describe("task status settings", () => {
  it("remaps a symbol and every transition that targets it", async () => {
    const { component, updates } = renderSettings();
    expect(
      document.querySelectorAll('[data-testid="task-status-row"]'),
    ).toHaveLength(3);
    const symbol = document.querySelector<HTMLInputElement>(
      '[data-testid="task-status-symbol"]',
    );
    expect(symbol).not.toBeNull();
    if (symbol === null) return;
    symbol.value = "u";
    symbol.dispatchEvent(new Event("change", { bubbles: true }));
    flushSync();

    const statuses = updates.at(-1)?.task_statuses;
    expect(statuses?.map((status) => status.symbol)).toEqual(["u", "~", "x"]);
    expect(statuses?.find((status) => status.symbol === "x")?.next_status).toBe(
      "u",
    );
    await unmount(component);
  });

  it("reorders, removes, and adds statuses without breaking transitions", async () => {
    let rendered = renderSettings();
    button("Move status down: Ready").click();
    flushSync();
    expect(
      rendered.updates.at(-1)?.task_statuses?.map((status) => status.symbol),
    ).toEqual(["~", " ", "x"]);
    await unmount(rendered.component);

    rendered = renderSettings();
    button("Remove status: Paused").click();
    flushSync();
    const remaining = rendered.updates.at(-1)?.task_statuses;
    expect(remaining?.map((status) => status.symbol)).toEqual([" ", "x"]);
    expect(remaining?.[0]?.next_status).toBe("x");
    await unmount(rendered.component);

    rendered = renderSettings();
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
});
