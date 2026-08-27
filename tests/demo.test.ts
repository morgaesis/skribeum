import { beforeEach, describe, expect, it } from "vitest";
import {
  searchQuery,
  settingsRead,
  settingsWrite,
  vaultTreeRefresh,
} from "../demo/lib/ipc/services";
import {
  type BrowserDirectoryHandle,
  type BrowserFileHandle,
  closeVault,
  demoVaultStatus,
  IpcError,
  noteCreate,
  noteWrite,
  openVault,
  openVaultResult,
  readNote,
  readVaultFile,
  resetDemoVault,
  selectLocalDirectory,
  useLocalDirectory,
  vaultTree,
  watchSubscribe,
} from "../demo/lib/ipc/vault";
import { defaultTaskStatuses } from "../src/lib/taskStatuses";

class MockFileHandle implements BrowserFileHandle {
  readonly kind = "file" as const;
  private unavailable = false;
  private aborted = false;

  constructor(
    readonly name: string,
    private contents: Uint8Array,
    private readonly failure:
      | "open"
      | "deleted"
      | "write"
      | "close"
      | null = null,
  ) {}

  async getFile(): Promise<File> {
    if (this.unavailable) {
      throw new Error("browser file unavailable");
    }
    return new File([this.contents.slice().buffer], this.name);
  }

  async createWritable() {
    if (this.failure === "deleted") {
      this.unavailable = true;
      throw new Error("browser file unavailable");
    }
    if (this.failure === "open") {
      throw new Error("browser write failed");
    }
    let pending = this.contents;
    let aborted = false;
    return {
      write: async (data: Uint8Array) => {
        if (this.failure === "write") {
          throw new Error("browser write failed");
        }
        pending = data.slice();
      },
      close: async () => {
        if (this.failure === "close") {
          throw new Error("browser close failed");
        }
        if (!aborted) {
          this.contents = pending;
        }
      },
      abort: async () => {
        aborted = true;
        this.aborted = true;
      },
    };
  }

  text(): string {
    return new TextDecoder().decode(this.contents);
  }

  wasAborted(): boolean {
    return this.aborted;
  }
}

class MockDirectoryHandle implements BrowserDirectoryHandle {
  readonly kind = "directory" as const;

  constructor(
    readonly name: string,
    private readonly entries: Array<BrowserFileHandle | BrowserDirectoryHandle>,
    private readonly permission: PermissionState,
  ) {}

  async *values() {
    yield* this.entries;
  }

  async queryPermission(): Promise<PermissionState> {
    return this.permission;
  }

  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
}

describe("browser demo IPC", () => {
  it("provides canonical-style result identity and idempotent handle cleanup", async () => {
    const opened = await openVaultResult("demo");

    expect(opened.root).toBe("demo");
    await closeVault(opened.handle);
    await closeVault(opened.handle);
  });

  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, "showDirectoryPicker");
    resetDemoVault();
  });

  it("opens the seeded vault and indexes its nested content", async () => {
    const handle = await openVault("ignored-in-browser");
    const tree = await vaultTree(handle);

    expect(tree.filter((entry) => entry.kind === "note")).toHaveLength(28);
    expect(tree).toContainEqual({
      path: "Features",
      kind: "directory",
      hidden: false,
    });
    expect(tree).toContainEqual({
      path: "demo.canvas",
      kind: "file",
      hidden: false,
    });
    await expect(vaultTreeRefresh(handle)).resolves.toEqual(tree);
    await expect(watchSubscribe(handle)).resolves.toBeUndefined();
  });

  it("reads Markdown notes and render-only vault files", async () => {
    const handle = await openVault("demo");
    const note = await readNote(handle, "quickstart.md");
    const canvas = await readVaultFile(handle, "demo.canvas");

    expect(note.text).toContain("# Quickstart");
    expect(note.meta.byte_length).toBe(note.bytes.byteLength);
    expect(note.meta.projection_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(new TextDecoder().decode(canvas))).toHaveProperty(
      "nodes",
    );
  });

  it("indexes and opens files that are not notes", async () => {
    const handle = await openVault("demo");
    const tree = await vaultTree(handle);

    // A dot-prefixed name is ordinary vault content, and the tree shows it.
    expect(tree).toContainEqual({
      path: ".gitignore",
      kind: "file",
      hidden: true,
    });
    expect(tree).toContainEqual({
      path: "Features/deploy.yml",
      kind: "file",
      hidden: false,
    });
    // The excluded configuration directory stays out of the index.
    expect(tree.some((entry) => entry.path.startsWith(".obsidian"))).toBe(
      false,
    );

    const ignore = await readNote(handle, ".gitignore");
    expect(ignore.readOnly).toBe(false);
    expect(ignore.text).toContain("drafts/*.tmp");

    const pipeline = await readNote(handle, "Features/deploy.yml");
    expect(pipeline.readOnly).toBe(false);
    expect(pipeline.text).toContain("targets:");
  });

  it("keeps a binary file intact and never opens it as editable text", async () => {
    const handle = await openVault("demo");
    const path = "Examples/Work/printed-handout.pdf";
    const raw = await readVaultFile(handle, path);
    const document = await readNote(handle, path);

    // The seeding pipeline delivered the file's own bytes, not a UTF-8
    // re-encoding of them: a PDF opens with its signature intact.
    expect([...raw.subarray(0, 5)]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(raw.some((byte) => byte > 0x7f)).toBe(true);
    expect(document.readOnly).toBe(true);
    expect(document.meta.encoding).toBe("non-utf8");
  });

  it("collects every file from a local folder, not only its notes", async () => {
    const ignoreFile = new MockFileHandle(
      ".gitignore",
      new TextEncoder().encode("public/\n"),
    );
    const noteFile = new MockFileHandle(
      "note.md",
      new TextEncoder().encode("# Local"),
    );
    const directory = new MockDirectoryHandle(
      "Writing",
      [ignoreFile, noteFile],
      "granted",
    );
    const handle = await openVault(await useLocalDirectory(directory));

    expect(await vaultTree(handle)).toContainEqual({
      path: ".gitignore",
      kind: "file",
      hidden: true,
    });
    const loaded = await readNote(handle, ".gitignore");
    expect(loaded.text).toBe("public/\n");
  });

  it("creates a new note without overwriting an existing path", async () => {
    const handle = await openVault("demo");
    await expect(
      noteCreate(handle, "Drafts/Untitled.md"),
    ).resolves.toBeUndefined();
    const created = await readNote(handle, "Drafts/Untitled.md");
    expect(created).toMatchObject({ text: "", readOnly: false });
    await noteWrite(
      handle,
      "Drafts/Untitled.md",
      [
        {
          start: 0,
          end: 0,
          bytes: Array.from(new TextEncoder().encode("Newly searchable note")),
        },
      ],
      created.meta.projection_hash,
    );
    await expect(searchQuery(handle, "searchable", 50)).resolves.toContainEqual(
      expect.objectContaining({ path: "Drafts/Untitled.md" }),
    );
    await expect(noteCreate(handle, "Drafts/Untitled.md")).rejects.toThrow(
      "already exists",
    );
  });

  it("applies note edits to memory without touching the seed source", async () => {
    const handle = await openVault("demo");
    const before = await readNote(handle, "about.md");
    const addition = "\n\nA temporary browser note.";
    const result = await noteWrite(
      handle,
      "about.md",
      [
        {
          start: before.bytes.byteLength,
          end: before.bytes.byteLength,
          bytes: Array.from(new TextEncoder().encode(addition)),
        },
      ],
      before.meta.projection_hash,
    );

    expect(result.result).toBe("written");
    const after = await readNote(handle, "about.md");
    expect(after.text).toBe(`${before.text}${addition}`);
    expect(after.meta.projection_hash).not.toBe(before.meta.projection_hash);
  });

  it("loads nested Markdown from a local folder and writes through", async () => {
    const noteFile = new MockFileHandle(
      "note.md",
      new TextEncoder().encode("# Local"),
    );
    const nested = new MockDirectoryHandle("Notes", [noteFile], "granted");
    const directory = new MockDirectoryHandle("Writing", [nested], "granted");
    const handle = await openVault(await useLocalDirectory(directory));

    expect(await vaultTree(handle)).toContainEqual({
      path: "Notes/note.md",
      kind: "note",
      hidden: false,
    });
    const before = await readNote(handle, "Notes/note.md");
    await noteWrite(
      handle,
      "Notes/note.md",
      [
        {
          start: before.bytes.byteLength,
          end: before.bytes.byteLength,
          bytes: Array.from(new TextEncoder().encode("\nBody")),
        },
      ],
      before.meta.projection_hash,
    );

    expect(noteFile.text()).toBe("# Local\nBody");
    expect(demoVaultStatus()).toEqual({
      source: "folder",
      name: "Writing",
      writes: "folder",
      skipped: 0,
    });
  });

  it("keeps local-folder edits in memory when write permission is denied", async () => {
    const noteFile = new MockFileHandle(
      "note.md",
      new TextEncoder().encode("A"),
    );
    const directory = new MockDirectoryHandle(
      "Read only",
      [noteFile],
      "denied",
    );
    const handle = await openVault(await useLocalDirectory(directory));
    const before = await readNote(handle, "note.md");

    await noteWrite(
      handle,
      "note.md",
      [{ start: 1, end: 1, bytes: [66] }],
      before.meta.projection_hash,
    );

    expect(noteFile.text()).toBe("A");
    expect((await readNote(handle, "note.md")).text).toBe("AB");
    expect(demoVaultStatus()).toMatchObject({ writes: "memory" });
  });

  it.each(["write", "close"] as const)(
    "keeps edits pending when the browser %s step fails",
    async (failure) => {
      const noteFile = new MockFileHandle(
        "note.md",
        new TextEncoder().encode("A"),
        failure,
      );
      const directory = new MockDirectoryHandle(
        "Writing",
        [noteFile],
        "granted",
      );
      const handle = await openVault(await useLocalDirectory(directory));
      const before = await readNote(handle, "note.md");

      await expect(
        noteWrite(
          handle,
          "note.md",
          [{ start: 1, end: 1, bytes: [66] }],
          before.meta.projection_hash,
        ),
      ).rejects.toBeInstanceOf(IpcError);
      expect(noteFile.text()).toBe("A");
      expect(noteFile.wasAborted()).toBe(true);
      expect((await readNote(handle, "note.md")).text).toBe("A");
    },
  );

  it("marks non-UTF-8 notes read-only at the IPC boundary", async () => {
    const lockedFile = new MockFileHandle(
      "locked.md",
      Uint8Array.from([0xff, 0xfe, 0x41]),
    );
    const directory = new MockDirectoryHandle(
      "Writing",
      [lockedFile],
      "granted",
    );
    const handle = await openVault(await useLocalDirectory(directory));
    const locked = await readNote(handle, "locked.md");

    expect(locked.readOnly).toBe(true);
    await expect(
      noteWrite(
        handle,
        "locked.md",
        [{ start: 0, end: 0, bytes: [65] }],
        locked.meta.projection_hash,
      ),
    ).rejects.toMatchObject({ app: { code: "note/non-utf8-read-only" } });
  });

  it("calls the directory picker with its Window receiver and reports skipped files", async () => {
    const unreadable: BrowserFileHandle = {
      kind: "file",
      name: "unreadable.md",
      getFile: async () => {
        throw new Error("unreadable");
      },
    };
    const directory = new MockDirectoryHandle(
      "Writing",
      [
        unreadable,
        new MockFileHandle("note.md", new TextEncoder().encode("# Note")),
      ],
      "denied",
    );
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async function (this: Window) {
        expect(this).toBe(window);
        return directory;
      },
    });

    const selection = await selectLocalDirectory();
    expect(selection).not.toBeNull();
    await openVault(selection ?? "");
    expect(demoVaultStatus()).toMatchObject({ skipped: 1, writes: "memory" });
  });

  it("performs lexical search and ranks earlier body matches first", async () => {
    const handle = await openVault("demo");
    const results = await searchQuery(handle, "cedar", 50);

    expect(results.length).toBeGreaterThan(2);
    expect(results.every((result) => result.match_ranges.length > 0)).toBe(
      true,
    );
    const positions = await Promise.all(
      results.map(async (result) =>
        (await readNote(handle, result.path)).text
          .toLocaleLowerCase()
          .indexOf("cedar"),
      ),
    );
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    await expect(searchQuery(handle, "cedar", 2)).resolves.toHaveLength(2);
    await expect(searchQuery(handle, "", 50)).resolves.toEqual([]);
  });

  it("persists settings through local storage", async () => {
    await expect(settingsRead()).resolves.toEqual({
      schema_version: 2,
      theme: "system",
      light_palette: "manuscript",
      dark_palette: "nightroom",
      prose_font: "serif",
      code_font: "modern",
      editor_font_size: 16,
      editor_line_height: 170,
      editor_line_width: 72,
      zoom_percent: 100,
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
      attachment_folder_mode: "vault",
      attachment_folder_path: "attachments",
      honor_obsidian_config: true,
      search_result_limit: 50,
      link_previews: true,
      search_note_bodies: true,
      search_case_sensitive: false,
      update_channel: "stable",
      check_updates_on_startup: true,
      task_statuses: defaultTaskStatuses(),
    });

    const settings = {
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
      search_result_limit: 24,
      link_previews: false,
      search_note_bodies: false,
      search_case_sensitive: true,
      update_channel: "beta",
      check_updates_on_startup: false,
      task_statuses: defaultTaskStatuses(),
    };
    await settingsWrite(settings);
    await expect(settingsRead()).resolves.toEqual(settings);
    expect(localStorage.getItem("skribeum.demo.settings")).toBe(
      JSON.stringify(settings),
    );
  });

  it("defaults invalid stored settings and rejects invalid writes", async () => {
    localStorage.setItem(
      "skribeum.demo.settings",
      JSON.stringify({
        schema_version: "two",
        theme: "neon",
        light_palette: "blue",
        dark_palette: "blue",
        prose_font: "cursive",
        code_font: "script",
        editor_font_size: Number.POSITIVE_INFINITY,
        editor_line_height: 119,
        editor_line_width: 44,
        zoom_percent: 105,
        show_line_numbers: "yes",
        animations: 1,
        autosave_delay_ms: 99,
        spell_check: "yes",
        indent_style: "mixed",
        indent_width: 0,
        wrap_long_lines: "no",
        show_invisible_characters: null,
        reveal_markdown_syntax: 0,
        default_note_folder: "C:/notes",
        attachment_folder_mode: "nearby",
        attachment_folder_path: "/attachments",
        honor_obsidian_config: "yes",
        search_result_limit: 0,
        link_previews: "yes",
        search_note_bodies: "yes",
        search_case_sensitive: 1,
        update_channel: "nightly",
      }),
    );

    await expect(settingsRead()).resolves.toEqual({
      schema_version: 2,
      theme: "system",
      light_palette: "manuscript",
      dark_palette: "nightroom",
      prose_font: "serif",
      code_font: "modern",
      editor_font_size: 16,
      editor_line_height: 170,
      editor_line_width: 72,
      zoom_percent: 100,
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
      attachment_folder_mode: "vault",
      attachment_folder_path: "attachments",
      honor_obsidian_config: true,
      search_result_limit: 50,
      link_previews: true,
      search_note_bodies: true,
      search_case_sensitive: false,
      update_channel: "stable",
      check_updates_on_startup: true,
      task_statuses: defaultTaskStatuses(),
    });
    const valid = await settingsRead();
    const invalidWrites: Array<[keyof typeof valid, unknown]> = [
      ["schema_version", "two"],
      ["theme", "neon"],
      ["light_palette", "blue"],
      ["dark_palette", "blue"],
      ["prose_font", "cursive"],
      ["code_font", "script"],
      ["editor_font_size", 5],
      ["editor_line_height", 119],
      ["editor_line_width", 44],
      ["zoom_percent", 105],
      ["show_line_numbers", "yes"],
      ["animations", 1],
      ["autosave_delay_ms", 99],
      ["spell_check", "yes"],
      ["indent_style", "mixed"],
      ["indent_width", 0],
      ["wrap_long_lines", "no"],
      ["show_invisible_characters", null],
      ["reveal_markdown_syntax", 0],
      ["default_note_folder", "C:/notes"],
      ["default_note_folder", "notes:archive"],
      ["default_note_folder", ".obsidian"],
      ["attachment_folder_mode", "nearby"],
      ["attachment_folder_path", "/attachments"],
      ["attachment_folder_path", ".skribeum/assets"],
      ["honor_obsidian_config", "yes"],
      ["search_result_limit", 0],
      ["link_previews", "yes"],
      ["search_note_bodies", "yes"],
      ["search_case_sensitive", 1],
      ["update_channel", "nightly"],
      [
        "task_statuses",
        [
          {
            symbol: "?",
            name: "Question",
            category: "TODO",
            glyph: "?",
            color_token: "--skr-accent",
            next_status: "missing",
          },
        ],
      ],
    ];
    for (const [key, value] of invalidWrites) {
      await expect(
        settingsWrite({ ...valid, [key]: value } as typeof valid),
      ).rejects.toThrow(String(key));
    }
  });

  it("uses the legacy width key when line width is absent", async () => {
    localStorage.setItem(
      "skribeum.demo.settings",
      JSON.stringify({ editor_reading_measure: 88 }),
    );
    await expect(settingsRead()).resolves.toMatchObject({
      editor_line_width: 88,
      zoom_percent: 100,
    });
  });

  it("defaults folder values that note creation cannot use", async () => {
    localStorage.setItem(
      "skribeum.demo.settings",
      JSON.stringify({
        default_note_folder: "notes:archive",
        attachment_folder_path: ".obsidian/assets",
      }),
    );
    await expect(settingsRead()).resolves.toMatchObject({
      default_note_folder: "",
      attachment_folder_path: "attachments",
    });
  });

  it("preserves unknown settings keys on write", async () => {
    localStorage.setItem(
      "skribeum.demo.settings",
      JSON.stringify({ future_feature: { enabled: true } }),
    );
    const settings = await settingsRead();
    await settingsWrite({ ...settings, theme: "dark" });
    expect(
      JSON.parse(localStorage.getItem("skribeum.demo.settings") ?? "{}"),
    ).toMatchObject({ future_feature: { enabled: true }, theme: "dark" });
  });
});
