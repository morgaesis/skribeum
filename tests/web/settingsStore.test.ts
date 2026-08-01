// The settings store over the pinned settings shape: load, optimistic
// update with restart-free apply, revert and error surfacing on a failed
// write.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  type SettingsState,
  SettingsStore,
} from "../../src/lib/features/settingsStore";
import type { SettingsDocument } from "../../src/lib/ipc/services";

const PERSISTED: SettingsDocument = {
  schema_version: 1,
  theme: "dark",
  editor_font_size: 18,
  editor_reading_measure: 84,
  search_result_limit: 25,
};

function harness(io?: {
  read?: () => Promise<SettingsDocument>;
  write?: (doc: SettingsDocument) => Promise<void>;
}) {
  const applied: SettingsState[] = [];
  const written: SettingsDocument[] = [];
  const store = new SettingsStore(
    (state) => {
      applied.push(state);
    },
    {
      read: io?.read ?? (() => Promise.resolve(PERSISTED)),
      write:
        io?.write ??
        ((doc) => {
          written.push(doc);
          return Promise.resolve();
        }),
    },
  );
  return { store, applied, written };
}

describe("settings store", () => {
  it("loads the persisted document and applies it", async () => {
    const { store, applied } = harness();
    await store.load();
    expect(store.snapshot).toEqual({
      document: PERSISTED,
      error: null,
      loaded: true,
    });
    expect(applied.at(-1)?.document.editor_font_size).toBe(18);
    expect(applied.at(-1)?.document.editor_reading_measure).toBe(84);
  });

  it("keeps defaults and records the error on a failed read", async () => {
    const { store } = harness({
      read: () => Promise.reject(new Error("io: no settings backend")),
    });
    await store.load();
    expect(store.snapshot.document).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.editor_font_size).toBe(16);
    expect(store.snapshot.loaded).toBe(false);
    expect(store.snapshot.error).toContain("no settings backend");
  });

  it("applies an update optimistically before the write resolves", async () => {
    let resolveWrite: () => void = () => {};
    const { store, applied } = harness({
      write: () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    });
    await store.load();
    const pending = store.update({ editor_reading_measure: 90 });
    // Applied immediately, before the backend acknowledged.
    expect(store.snapshot.document.editor_reading_measure).toBe(90);
    expect(applied.at(-1)?.document.editor_reading_measure).toBe(90);
    resolveWrite();
    expect(await pending).toBe(true);
  });

  it("persists the merged document", async () => {
    const { store, written } = harness();
    await store.load();
    await store.update({ editor_reading_measure: 72 });
    expect(written).toEqual([{ ...PERSISTED, editor_reading_measure: 72 }]);
  });

  it("persists the theme value", async () => {
    const { store, written } = harness();
    await store.load();
    await store.update({ theme: "light" });
    expect(written.at(-1)?.theme).toBe("light");
    expect(store.snapshot.document.theme).toBe("light");
  });

  it("reverts and surfaces the error when the write fails", async () => {
    const { store, applied } = harness({
      write: () => Promise.reject(new Error("io: disk full")),
    });
    await store.load();
    const outcome = await store.update({ editor_font_size: 30 });
    expect(outcome).toBe(false);
    // Reverted to the loaded document, with the failure surfaced.
    expect(store.snapshot.document).toEqual(PERSISTED);
    expect(store.snapshot.error).toContain("disk full");
    // The revert re-applied the previous value (font size restored).
    expect(applied.at(-1)?.document.editor_font_size).toBe(18);
    expect(applied.at(-1)?.document.editor_reading_measure).toBe(84);
  });
});
