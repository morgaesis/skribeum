// Frontmatter write round-trip for the permalink id: `ensurePermalinkId`
// must go through the same positional frontmatter-editing path the
// properties panel uses (decision: no parallel writer), so a note without
// frontmatter gains a block first, an existing block gains one appended
// `id:` line leaving every other byte untouched, and an already-present id
// is returned unchanged rather than duplicated.

import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import Editor from "../../src/lib/Editor.svelte";
import { isNoteId } from "../../src/lib/features/permalink";
import type { LoadedNote } from "../../src/lib/ipc/vault";

/**
 * A note with a real (non-null) session: the properties panel, and so
 * `ensurePermalinkId`'s frontmatter read, only activate once a session
 * exists (mirrors production, where "Copy permalink" only ever runs
 * against an already-loaded note).
 */
function openNote(doc: string): LoadedNote {
  return {
    meta: { encoding: "utf8", projection_hash: "test-hash", byte_length: 0 },
    bytes: new TextEncoder().encode(doc),
    text: doc,
    readOnly: false,
    persistence: "note",
  };
}

describe("ensurePermalinkId", () => {
  it("creates a frontmatter block and appends the id when the note has none", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const doc = "# Untitled\n";
    const component = mount(Editor, {
      target: host,
      props: { doc, note: openNote(doc) },
    });
    flushSync();
    try {
      const id = component.ensurePermalinkId();

      expect(id).not.toBeNull();
      expect(isNoteId(id ?? "")).toBe(true);
      expect(component.getView()?.state.doc.toString()).toBe(
        `---\nid: ${id}\n---\n${doc}`,
      );
    } finally {
      await unmount(component);
      host.remove();
    }
  });

  it("appends the id to an existing frontmatter block, preserving other properties", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const doc = "---\ntitle: Existing\ntags:\n  - one\n---\nBody text\n";
    const component = mount(Editor, {
      target: host,
      props: { doc, note: openNote(doc) },
    });
    flushSync();
    try {
      const id = component.ensurePermalinkId();

      expect(id).not.toBeNull();
      expect(component.getView()?.state.doc.toString()).toBe(
        `---\ntitle: Existing\ntags:\n  - one\nid: ${id}\n---\nBody text\n`,
      );
    } finally {
      await unmount(component);
      host.remove();
    }
  });

  it("returns the existing id unchanged instead of allocating a new one", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const doc = "---\nid: existingId12\n---\nBody\n";
    const component = mount(Editor, {
      target: host,
      props: { doc, note: openNote(doc) },
    });
    flushSync();
    try {
      const id = component.ensurePermalinkId();

      expect(id).toBe("existingId12");
      expect(component.getView()?.state.doc.toString()).toBe(doc);
    } finally {
      await unmount(component);
      host.remove();
    }
  });

  it("declines to write into a read-only note", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const doc = "# Read only\n";
    const note: LoadedNote = {
      meta: { encoding: "non-utf8", projection_hash: "hash", byte_length: 0 },
      bytes: new Uint8Array(),
      text: doc,
      readOnly: true,
    };
    const component = mount(Editor, { target: host, props: { doc, note } });
    flushSync();
    try {
      const id = component.ensurePermalinkId();

      expect(id).toBeNull();
      expect(component.getView()?.state.doc.toString()).toBe(doc);
    } finally {
      await unmount(component);
      host.remove();
    }
  });
});
