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
import {
  defaultTaskStatusDocuments,
  defaultTaskStatuses,
} from "../../src/lib/taskStatuses";

const PERSISTED: SettingsDocument = {
  schema_version: 2,
  theme: "dark",
  light_palette: "studio",
  dark_palette: "graphite",
  prose_font: "sans",
  code_font: "classic",
  editor_font_size: 18,
  editor_line_height: 180,
  editor_line_width: 84,
  zoom_percent: 130,
  show_line_numbers: true,
  animations: false,
  autosave_delay_ms: 750,
  spell_check: false,
  indent_style: "tabs",
  indent_width: 4,
  wrap_long_lines: false,
  show_invisible_characters: true,
  reveal_markdown_syntax: false,
  default_note_folder: "notes/drafts",
  attachment_folder_mode: "folder",
  attachment_folder_path: "media/attachments",
  honor_obsidian_config: false,
  search_result_limit: 25,
  link_previews: false,
  search_note_bodies: false,
  search_case_sensitive: true,
  task_statuses: defaultTaskStatuses(),
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
      errorSetting: null,
      loaded: true,
    });
    expect(applied.at(-1)?.document.editor_font_size).toBe(18);
    expect(applied.at(-1)?.document.editor_line_width).toBe(84);
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
    expect(store.snapshot.errorSetting).toBe("document");
  });

  it("retries a failed read before allowing an update to persist", async () => {
    let reads = 0;
    const { store, written } = harness({
      read: () => {
        reads += 1;
        return reads === 1
          ? Promise.reject(new Error("io: temporarily unavailable"))
          : Promise.resolve(PERSISTED);
      },
    });
    await store.load();
    expect(store.snapshot.loaded).toBe(false);

    expect(await store.update({ theme: "light" })).toBe(true);
    expect(reads).toBe(2);
    expect(written).toEqual([{ ...PERSISTED, theme: "light" }]);
  });

  it("does not write defaults when the initial read keeps failing", async () => {
    const { store, written } = harness({
      read: () => Promise.reject(new Error("io: unavailable")),
    });

    expect(await store.update({ theme: "light" })).toBe(false);
    expect(written).toEqual([]);
    expect(store.snapshot.document).toEqual(DEFAULT_SETTINGS);
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
    const pending = store.update({ editor_line_width: 90 });
    // Applied immediately, before the backend acknowledged.
    expect(store.snapshot.document.editor_line_width).toBe(90);
    expect(applied.at(-1)?.document.editor_line_width).toBe(90);
    await Promise.resolve();
    resolveWrite();
    expect(await pending).toBe(true);
  });

  it("waits for the initial read before merging and persisting an update", async () => {
    let resolveRead: (document: SettingsDocument) => void = () => {};
    const { store, written } = harness({
      read: () =>
        new Promise<SettingsDocument>((resolve) => {
          resolveRead = resolve;
        }),
    });

    const pending = store.update({ theme: "light" });
    await Promise.resolve();
    expect(written).toEqual([]);
    resolveRead(PERSISTED);

    expect(await pending).toBe(true);
    expect(written).toEqual([{ ...PERSISTED, theme: "light" }]);
    expect(store.snapshot.document).toEqual({ ...PERSISTED, theme: "light" });
  });

  it("holds the default document, not the persisted one, until load settles", async () => {
    // Reproduces, at the store level, the race behind the macOS e2e flake in
    // smoke.spec.ts's palette_selection_and_system_matching_round_trip
    // test: opening the settings dialog (mounting the view) is not proof
    // that the persisted document has arrived, since `load()` reads it
    // asynchronously. A caller that treats "load() started" as settled and
    // reads the document immediately observes the default, not what is on
    // disk; only awaiting the load (or polling `snapshot.loaded`) does.
    let resolveRead: (document: SettingsDocument) => void = () => {};
    const { store } = harness({
      read: () =>
        new Promise<SettingsDocument>((resolve) => {
          resolveRead = resolve;
        }),
    });

    const loaded = store.load();
    expect(store.snapshot.loaded).toBe(false);
    expect(store.snapshot.document).toEqual(DEFAULT_SETTINGS);
    expect(store.snapshot.document).not.toEqual(PERSISTED);

    resolveRead(PERSISTED);
    await loaded;

    expect(store.snapshot.loaded).toBe(true);
    expect(store.snapshot.document).toEqual(PERSISTED);
  });

  it("persists the merged document", async () => {
    const { store, written } = harness();
    await store.load();
    await store.update({
      light_palette: "gazette",
      dark_palette: "signal",
      prose_font: "serif",
      code_font: "modern",
      editor_font_size: 20,
      editor_line_height: 190,
      editor_line_width: 72,
      show_line_numbers: false,
      animations: true,
      autosave_delay_ms: 400,
      spell_check: true,
      indent_style: "spaces",
      indent_width: 2,
      wrap_long_lines: true,
      show_invisible_characters: false,
      reveal_markdown_syntax: true,
      default_note_folder: "",
      attachment_folder_mode: "note",
      attachment_folder_path: "attachments",
      honor_obsidian_config: true,
      search_result_limit: 50,
      search_note_bodies: true,
      search_case_sensitive: false,
    });
    expect(written).toEqual([
      {
        ...PERSISTED,
        light_palette: "gazette",
        dark_palette: "signal",
        prose_font: "serif",
        code_font: "modern",
        editor_font_size: 20,
        editor_line_height: 190,
        editor_line_width: 72,
        show_line_numbers: false,
        animations: true,
        autosave_delay_ms: 400,
        spell_check: true,
        indent_style: "spaces",
        indent_width: 2,
        wrap_long_lines: true,
        show_invisible_characters: false,
        reveal_markdown_syntax: true,
        default_note_folder: "",
        attachment_folder_mode: "note",
        attachment_folder_path: "attachments",
        honor_obsidian_config: true,
        search_result_limit: 50,
        search_note_bodies: true,
        search_case_sensitive: false,
      },
    ]);
  });

  it("persists the theme value", async () => {
    const { store, written } = harness();
    await store.load();
    await store.update({ theme: "light" });
    expect(written.at(-1)?.theme).toBe("light");
    expect(store.snapshot.document.theme).toBe("light");
  });

  it("persists palette and link preview preferences", async () => {
    const { store, written } = harness();
    await store.load();
    await store.update({
      light_palette: "gazette",
      dark_palette: "signal",
      link_previews: true,
    });
    expect(written.at(-1)).toMatchObject({
      light_palette: "gazette",
      dark_palette: "signal",
      link_previews: true,
    });
  });

  it("serializes rapid updates so the newest document persists last", async () => {
    const pendingWrites: Array<{
      document: SettingsDocument;
      resolve: () => void;
    }> = [];
    const { store } = harness({
      write: (document) =>
        new Promise<void>((resolve) => {
          pendingWrites.push({ document, resolve });
        }),
    });
    await store.load();

    const first = store.update({ editor_font_size: 19 });
    const second = store.update({ editor_font_size: 20 });
    await Promise.resolve();
    expect(pendingWrites).toHaveLength(1);
    expect(pendingWrites[0]?.document.editor_font_size).toBe(19);

    pendingWrites[0]?.resolve();
    await first;
    await Promise.resolve();
    expect(pendingWrites).toHaveLength(2);
    expect(pendingWrites[1]?.document.editor_font_size).toBe(20);
    pendingWrites[1]?.resolve();

    expect(await second).toBe(true);
    expect(store.snapshot.document.editor_font_size).toBe(20);
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
    expect(store.snapshot.errorSetting).toBe("editor_font_size");
    // The revert re-applied the previous value (font size restored).
    expect(applied.at(-1)?.document.editor_font_size).toBe(18);
    expect(applied.at(-1)?.document.editor_line_width).toBe(84);
  });

  it("reverts a failed rapid sequence to the last persisted document", async () => {
    const { store } = harness({
      write: () => Promise.reject(new Error("io: disk full")),
    });
    await store.load();

    const first = store.update({ editor_font_size: 19 });
    const second = store.update({ editor_font_size: 20 });
    expect(await first).toBe(false);
    expect(await second).toBe(false);

    expect(store.snapshot.document).toEqual(PERSISTED);
    expect(store.snapshot.error).toContain("disk full");
  });

  it("falls back to the complete default graph for malformed task statuses", async () => {
    const malformed = {
      ...PERSISTED,
      task_statuses: [
        {
          symbol: "?",
          name: "Question",
          category: "TODO",
          glyph: "?",
          color_token: "--skr-accent",
          next_status: "missing",
        },
      ],
    } as unknown as SettingsDocument;
    const { store } = harness({ read: () => Promise.resolve(malformed) });
    await store.load();
    expect(store.snapshot.document.task_statuses).toEqual(
      defaultTaskStatusDocuments(),
    );
  });

  it("keeps stable default names when another setting is written", async () => {
    const persisted = {
      ...PERSISTED,
      task_statuses: defaultTaskStatusDocuments(),
    };
    const { store, written } = harness({
      read: () => Promise.resolve(persisted),
    });
    await store.load();
    await store.update({ theme: "light" });
    expect(written.at(-1)?.task_statuses).toEqual(defaultTaskStatusDocuments());
  });
});
