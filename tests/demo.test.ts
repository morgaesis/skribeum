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
  demoVaultStatus,
  IpcError,
  noteWrite,
  openVault,
  readNote,
  readVaultFile,
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
  beforeEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, "showDirectoryPicker");
  });

  it("opens the seeded vault and indexes its nested content", async () => {
    const handle = await openVault("ignored-in-browser");
    const tree = await vaultTree(handle);

    expect(tree.filter((entry) => entry.kind === "note")).toHaveLength(25);
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
      schema_version: 1,
      theme: "system",
      light_palette: "manuscript",
      dark_palette: "lamplight",
      editor_font_size: 16,
      editor_reading_measure: 72,
      search_result_limit: 50,
      link_previews: true,
      task_statuses: defaultTaskStatuses(),
    });

    const settings = {
      schema_version: 1,
      theme: "dark",
      light_palette: "studio",
      dark_palette: "graphite",
      editor_font_size: 18,
      editor_reading_measure: 84,
      search_result_limit: 24,
      link_previews: false,
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
        schema_version: 1,
        theme: "neon",
        editor_font_size: Number.POSITIVE_INFINITY,
        editor_reading_measure: 121,
        search_result_limit: 0,
      }),
    );

    await expect(settingsRead()).resolves.toEqual({
      schema_version: 1,
      theme: "system",
      light_palette: "manuscript",
      dark_palette: "lamplight",
      editor_font_size: 16,
      editor_reading_measure: 72,
      search_result_limit: 50,
      link_previews: true,
      task_statuses: defaultTaskStatuses(),
    });
    await expect(
      settingsWrite({
        schema_version: 1,
        theme: "system",
        light_palette: "manuscript",
        dark_palette: "lamplight",
        editor_font_size: 17,
        editor_reading_measure: 76,
        search_result_limit: 1001,
        link_previews: true,
        task_statuses: defaultTaskStatuses(),
      }),
    ).rejects.toThrow("search_result_limit");
    await expect(
      settingsWrite({
        schema_version: 1,
        theme: "system",
        light_palette: "manuscript",
        dark_palette: "lamplight",
        editor_font_size: 17,
        editor_reading_measure: 44,
        search_result_limit: 50,
        link_previews: true,
        task_statuses: defaultTaskStatuses(),
      }),
    ).rejects.toThrow("editor_reading_measure");
  });
});
