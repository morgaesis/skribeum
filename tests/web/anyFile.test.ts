// Every file a vault holds opens. This suite covers the three properties
// that decide whether that is safe: what a path opens as, whether a
// non-note document survives an edit byte for byte, and what an image
// viewer is allowed to do with a file's bytes.

import type { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Editor from "../../src/lib/Editor.svelte";
import { applyByteChangeSet } from "../../src/lib/editor/byteChangeSet";
import {
  fileExtension,
  isMarkdownDocument,
  vaultDocumentKind,
} from "../../src/lib/editor/documentKinds";
import { fileLanguageDescription } from "../../src/lib/editor/syntaxPolicy";
import type { LoadedNote, VaultHandle } from "../../src/lib/ipc/vault";
import * as vaultIpc from "../../src/lib/ipc/vault";
import ImageView from "../../src/lib/rendering/ImageView.svelte";

type EditorExports = {
  flush: () => Promise<boolean>;
  getView: () => EditorView | undefined;
};

const VAULT: VaultHandle = { id: 1 };
const mounted: object[] = [];

/** Silences the durable journal, which has no native side under jsdom. */
function stubEditHistory(): void {
  vi.spyOn(vaultIpc, "editHistoryRead").mockResolvedValue({
    undo: [],
    redo: [],
  });
  vi.spyOn(vaultIpc, "editHistoryAppend").mockResolvedValue(undefined);
  vi.spyOn(vaultIpc, "editHistoryFence").mockResolvedValue(undefined);
  vi.spyOn(vaultIpc, "editHistoryClear").mockResolvedValue(undefined);
}

function mountEditor(props: Record<string, unknown>): EditorExports {
  const host = document.createElement("div");
  document.body.append(host);
  const component = mount(Editor, { target: host, props }) as EditorExports;
  mounted.push(component);
  flushSync();
  return component;
}

/** Presents raw bytes as an open document, the way `note_read` does. */
function openedDocument(bytes: Uint8Array): LoadedNote {
  let utf8 = true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    utf8 = false;
  }
  const hasBom =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf;
  return {
    meta: {
      encoding: !utf8 ? "non-utf8" : hasBom ? "utf8-bom" : "utf8",
      projection_hash: "base",
      byte_length: bytes.byteLength,
    },
    bytes,
    text: new TextDecoder("utf-8", { fatal: false }).decode(
      hasBom ? bytes.subarray(3) : bytes,
    ),
    readOnly: !utf8,
  };
}

/**
 * Edits a document through the editor and returns the bytes that land in
 * the vault: the change set the editor sent, applied to the base exactly as
 * `Vault::write_note` applies it. The byte-change implementation is the one
 * the conformance corpus pins to the Rust apply, so this is the same
 * arithmetic the desktop write performs.
 */
async function savedBytes(
  bytes: Uint8Array,
  path: string,
  edit: (view: EditorView) => void,
): Promise<Uint8Array | null> {
  let written: Uint8Array | null = null;
  stubEditHistory();
  vi.spyOn(vaultIpc, "noteWrite").mockImplementation(
    async (_handle, _relPath, changeSet, expectedProjectionHash) => {
      expect(expectedProjectionHash).toBe("base");
      written = applyByteChangeSet(
        bytes,
        changeSet.map((change) => ({
          start: change.start,
          end: change.end,
          bytes: Uint8Array.from(change.bytes),
        })),
      );
      return { result: "written", projection_hash: "written" };
    },
  );
  const component = mountEditor({
    note: openedDocument(bytes),
    path,
    vault: VAULT,
  });
  const view = component.getView();
  expect(view).toBeDefined();
  if (view === undefined) return null;
  edit(view);
  flushSync();
  await component.flush();
  return written;
}

function hex(bytes: Uint8Array | null): string {
  return bytes === null
    ? "<nothing written>"
    : [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("vault document kinds", () => {
  it("classifies every path by its own name, never by its bytes", () => {
    expect(vaultDocumentKind("notes/today.md")).toBe("note");
    expect(vaultDocumentKind("notes/today.MARKDOWN")).toBe("note");
    expect(vaultDocumentKind("log.txt")).toBe("note");
    expect(vaultDocumentKind("board.canvas")).toBe("canvas");
    expect(vaultDocumentKind("shot.PNG")).toBe("image");
    expect(vaultDocumentKind("shot.jpeg")).toBe("image");
    expect(vaultDocumentKind("anim.gif")).toBe("image");
    expect(vaultDocumentKind("photo.webp")).toBe("image");
    expect(vaultDocumentKind("mark.svg")).toBe("image");
    expect(vaultDocumentKind(".gitignore")).toBe("text");
    expect(vaultDocumentKind("deploy.yml")).toBe("text");
    expect(vaultDocumentKind("archive.zip")).toBe("text");
  });

  it("treats a leading dot as the start of a name, not an extension", () => {
    expect(fileExtension(".gitignore")).toBe("");
    expect(fileExtension("a/.env")).toBe("");
    expect(fileExtension("Makefile")).toBe("");
    expect(fileExtension("deploy.YML")).toBe("yml");
  });

  it("reserves Markdown services for Markdown documents", () => {
    expect(isMarkdownDocument(null)).toBe(true);
    expect(isMarkdownDocument("note.md")).toBe(true);
    expect(isMarkdownDocument("deploy.yml")).toBe(false);
    expect(isMarkdownDocument("build.sh")).toBe(false);
  });
});

describe("file highlighting", () => {
  it.each([
    ["deploy.yml", "YAML"],
    ["deploy.yaml", "YAML"],
    ["package.json", "JSON"],
    ["Cargo.toml", "TOML"],
    ["install.sh", "Shell"],
    ["install.bash", "Shell"],
    ["main.rs", "Rust"],
    ["main.py", "Python"],
    ["app.ts", "TypeScript"],
    ["app.js", "JavaScript"],
    ["page.html", "HTML"],
    ["page.css", "CSS"],
    ["schema.xml", "XML"],
    ["query.sql", "SQL"],
    ["main.go", "Go"],
    ["conf.ini", "Properties files"],
  ])("chooses %s highlighting from the extension alone", (path, language) => {
    expect(fileLanguageDescription(path)?.name).toBe(language);
  });

  it.each([
    ["Dockerfile", "Dockerfile"],
    [".bashrc", "Shell"],
    ["project/.zshrc", "Shell"],
    [".editorconfig", "Properties files"],
  ])("names %s by its file name when it has no extension", (path, language) => {
    expect(fileLanguageDescription(path)?.name).toBe(language);
  });

  it("leaves a path it does not recognise as plain text", () => {
    expect(fileLanguageDescription(".gitignore")).toBeNull();
    expect(fileLanguageDescription("notes.wat-is-dit")).toBeNull();
  });
});

describe("non-note editing", () => {
  it("carries no Markdown presentation into a configuration file", async () => {
    const source = "---\n# not a heading\nkey: value\n";
    const component = mountEditor({
      note: openedDocument(new TextEncoder().encode(source)),
      path: "deploy.yml",
      vault: VAULT,
    });
    const view = component.getView();
    expect(view).toBeDefined();
    if (view === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
    flushSync();
    // Every source character is present, none of it is folded away as a
    // frontmatter block, and no properties panel claims those lines.
    expect(view.state.doc.toString()).toBe(source);
    expect(view.contentDOM.textContent).toContain("---");
    expect(view.contentDOM.textContent).toContain("# not a heading");
    expect(document.querySelector(".skr-properties")).toBeNull();
    expect(
      view.contentDOM.querySelector(".cm-skr-frontmatter, .cm-skr-heading"),
    ).toBeNull();
  });

  it("keeps Markdown presentation for a note", async () => {
    const source = "---\ntitle: Real\n---\n\n# A heading\n";
    const component = mountEditor({
      note: {
        meta: { encoding: "utf8", projection_hash: "h", byte_length: 0 },
        bytes: new TextEncoder().encode(source),
        text: source,
        readOnly: false,
      } satisfies LoadedNote,
      path: "note.md",
      vault: VAULT,
    });
    const view = component.getView();
    expect(view).toBeDefined();
    if (view === undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
    flushSync();
    expect(document.querySelector(".skr-properties")).not.toBeNull();
  });

  it.each([
    [
      "CRLF endings and no trailing newline",
      "first\r\nsecond\r\nthird",
      "first\r\nsecond\r\nthird!",
    ],
    ["mixed endings", "a\r\nb\nc\rd\n", "a\r\nb\nc\rd\n!"],
    ["no trailing newline", "single line", "single line!"],
    ["trailing whitespace", "value:   \n\n", "value:   \n\n!"],
  ])("writes %s back byte for byte", async (_name, source, expected) => {
    const bytes = new TextEncoder().encode(source);
    const written = await savedBytes(bytes, ".gitignore", (view) => {
      view.dispatch({
        changes: { from: view.state.doc.length, insert: "!" },
      });
    });
    expect(hex(written)).toBe(hex(new TextEncoder().encode(expected)));
  });

  it("keeps a byte-order mark at the head of the file", async () => {
    const bytes = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode("root: true\n"),
    ]);
    const written = await savedBytes(bytes, "deploy.yml", (view) => {
      view.dispatch({ changes: { from: 0, insert: "# lead\n" } });
    });
    expect(hex(written)).toBe(
      hex(
        Uint8Array.from([
          0xef,
          0xbb,
          0xbf,
          ...new TextEncoder().encode("# lead\nroot: true\n"),
        ]),
      ),
    );
  });

  it("writes an empty file's first content exactly", async () => {
    const written = await savedBytes(new Uint8Array(), ".gitignore", (view) => {
      view.dispatch({ changes: { from: 0, insert: "public/" } });
    });
    expect(hex(written)).toBe(hex(new TextEncoder().encode("public/")));
  });

  it("emits a new line break in the file's own terminator style", async () => {
    const bytes = new TextEncoder().encode("first\r\nsecond\r\n");
    const written = await savedBytes(bytes, ".gitignore", (view) => {
      view.dispatch({ changes: { from: 5, insert: "\nsplit" } });
    });
    expect(hex(written)).toBe(
      hex(new TextEncoder().encode("first\r\nsplit\r\nsecond\r\n")),
    );
  });

  it.each([
    ["a lone surrogate encoded as WTF-8", [0xed, 0xa0, 0x80, 0x0a]],
    ["a PNG signature", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ])("never writes %s", async (_name, source) => {
    const bytes = Uint8Array.from(source);
    stubEditHistory();
    const write = vi.spyOn(vaultIpc, "noteWrite");
    const component = mountEditor({
      note: openedDocument(bytes),
      path: "archive.bin",
      vault: VAULT,
    });
    const view = component.getView();
    expect(view?.state.readOnly).toBe(true);
    expect(view?.contentDOM.getAttribute("contenteditable")).toBe("false");
    await component.flush();
    expect(write).not.toHaveBeenCalled();
  });

  it("opens an empty file as an empty editable document", () => {
    const component = mountEditor({
      note: openedDocument(new Uint8Array()),
      path: ".gitignore",
      vault: VAULT,
    });
    const view = component.getView();
    expect(view?.state.readOnly).toBe(false);
    expect(view?.state.doc.toString()).toBe("");
  });

  it("surfaces a conflict when the file moved under the open document", async () => {
    const bytes = new TextEncoder().encode("root: true\n");
    stubEditHistory();
    vi.spyOn(vaultIpc, "noteWrite").mockResolvedValue({
      result: "conflict",
      current_projection_hash: "elsewhere",
      reconciliation: 1,
    });
    vi.spyOn(vaultIpc, "readNote").mockResolvedValue(
      openedDocument(new TextEncoder().encode("someone else wrote this\n")),
    );
    const onConflict = vi.fn();
    const component = mountEditor({
      note: openedDocument(bytes),
      path: "deploy.yml",
      vault: VAULT,
      onConflict,
    });
    const view = component.getView();
    expect(view).toBeDefined();
    if (view === undefined) return;
    view.dispatch({ changes: { from: 0, insert: "# mine\n" } });
    flushSync();
    await component.flush();
    expect(onConflict).toHaveBeenCalled();
    // The other writer's content is loaded and the local edit is kept on
    // top of it, rather than either side being dropped.
    expect(view.state.doc.toString()).toContain("someone else wrote this");
    expect(view.state.doc.toString()).toContain("# mine");
  });
});

describe("image viewer", () => {
  const PIXEL_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>';

  function withObjectUrls(): {
    blobFor: (url: string) => Blob | undefined;
    revoked: string[];
  } {
    const blobs = new Map<string, Blob>();
    const revoked: string[] = [];
    let count = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob) => {
      count += 1;
      const url = `blob:image-view/${count}`;
      blobs.set(url, blob);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url: string) => {
      revoked.push(url);
    });
    return { blobFor: (url) => blobs.get(url), revoked };
  }

  function mountViewer(
    bytes: Uint8Array,
    mediaType: string,
    fileName: string,
  ): HTMLElement {
    const host = document.createElement("div");
    document.body.append(host);
    mounted.push(
      mount(ImageView, {
        target: host,
        props: { bytes, mediaType, fileName },
      }),
    );
    flushSync();
    return host;
  }

  it("hands the exact vault bytes to an image element under the declared type", async () => {
    const urls = withObjectUrls();
    const bytes = new TextEncoder().encode(PIXEL_SVG);
    const host = mountViewer(bytes, "image/svg+xml", "mark.svg");
    const image = host.querySelector<HTMLImageElement>(
      '[data-testid="image-view-frame"]',
    );
    expect(image?.tagName).toBe("IMG");
    expect(image?.alt).toBe("mark.svg");
    const blob = urls.blobFor(image?.getAttribute("src") ?? "");
    expect(blob?.type).toBe("image/svg+xml");
    expect([...new Uint8Array(await (blob as Blob).arrayBuffer())]).toEqual([
      ...bytes,
    ]);
  });

  it("renders vector markup only as an image, never as document markup", () => {
    withObjectUrls();
    const hostile = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" onload="globalThis.__ran = true">' +
        "<script>globalThis.__ran = true</script>" +
        '<image href="https://example.invalid/pixel.png"/></svg>',
    );
    const host = mountViewer(hostile, "image/svg+xml", "hostile.svg");
    expect(host.querySelector("svg")).toBeNull();
    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("iframe")).toBeNull();
    expect(host.querySelector("object")).toBeNull();
    expect(host.innerHTML).not.toContain("onload");
    expect(
      (globalThis as unknown as { __ran?: boolean }).__ran,
    ).toBeUndefined();
  });

  it("releases the object URL when the viewer goes away", async () => {
    const urls = withObjectUrls();
    const host = mountViewer(
      new TextEncoder().encode(PIXEL_SVG),
      "image/svg+xml",
      "mark.svg",
    );
    const image = host.querySelector<HTMLImageElement>(
      '[data-testid="image-view-frame"]',
    );
    const source = image?.getAttribute("src") ?? "";
    expect(source).not.toBe("");
    for (const component of mounted.splice(0)) await unmount(component);
    expect(urls.revoked).toContain(source);
  });
});
