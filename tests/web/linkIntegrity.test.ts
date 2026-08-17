// Renaming and moving a note against the browser vault, asserted the way a
// reader meets it: rename a note, open a note that linked to it, follow the
// link, and check which note you arrive at. The assertions read the
// destination reached and the bytes on disk, never whether a rewrite
// function ran, so a rewrite that is called and does the wrong thing fails
// here.
//
// The byte-fidelity claim is the same one `tests/web/listMove.test.ts` makes
// for a list relocation: the file afterwards is the file before with the
// link targets replaced and nothing else different, not a terminator and
// not the trailing newline. It is asserted on the bytes the vault actually
// stored, reached through the same line-ending mapping the save path uses.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VaultHandle } from "../../demo/lib/ipc/bindings";
import {
  noteCreate,
  noteWrite,
  openVault,
  readNote,
  resetDemoVault,
  treeEntryMove,
  treeEntryMovePlan,
  treeEntryMoveUndo,
  vaultTree,
} from "../../demo/lib/ipc/vault";
import {
  DEFAULT_OBSIDIAN_APP_CONFIG,
  type LinkUpdateSummary,
  type NoteAddress,
  planLinkUpdates,
  resolveWikilinkTarget,
  type WikilinkResolutionContext,
} from "../../src/lib/features/links";
import { followWikilinkTarget } from "../../src/lib/features/navigation";
import { linkUpdateDescription } from "../../src/lib/features/workspace";
import { STRINGS } from "../../src/lib/strings";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Every note path the demo vault indexes. */
async function notePaths(handle: VaultHandle): Promise<string[]> {
  return (await vaultTree(handle))
    .filter((entry) => entry.kind === "note")
    .map((entry) => entry.path);
}

/** Every indexed path, notes and attachments alike. */
async function indexedPaths(handle: VaultHandle): Promise<string[]> {
  return (await vaultTree(handle))
    .filter((entry) => entry.kind !== "directory")
    .map((entry) => entry.path);
}

/** The raw bytes the vault holds for a note. */
async function noteBytes(
  handle: VaultHandle,
  path: string,
): Promise<Uint8Array> {
  return (await readNote(handle, path)).bytes;
}

async function noteText(handle: VaultHandle, path: string): Promise<string> {
  return decoder.decode(await noteBytes(handle, path));
}

/** Replaces a note's whole contents through the production write path. */
async function putNote(
  handle: VaultHandle,
  path: string,
  text: string,
): Promise<void> {
  try {
    await noteCreate(handle, path);
  } catch {
    // Seeded notes already exist; the write below replaces them.
  }
  const note = await readNote(handle, path);
  await noteWrite(
    handle,
    path,
    [
      {
        start: 0,
        end: note.bytes.byteLength,
        bytes: [...encoder.encode(text)],
      },
    ],
    note.meta.projection_hash,
  );
}

/** The resolution context the editor would hold for `currentPath`. */
async function contextFor(
  handle: VaultHandle,
  currentPath: string,
): Promise<WikilinkResolutionContext> {
  return {
    paths: await notePaths(handle),
    config: DEFAULT_OBSIDIAN_APP_CONFIG,
    currentPath,
    loadNote: async (path) => {
      try {
        return await noteText(handle, path);
      } catch {
        return null;
      }
    },
  };
}

/**
 * Follows the link whose target is `target` from `sourcePath`, exactly as
 * the editor's follow path does, and reports the address it navigated to.
 */
async function followFrom(
  handle: VaultHandle,
  sourcePath: string,
  target: string,
): Promise<{ arrived: NoteAddress | null; reason: string | null }> {
  let arrived: NoteAddress | null = null;
  let reason: string | null = null;
  followWikilinkTarget(target, {
    context: await contextFor(handle, sourcePath),
    currentPath: sourcePath,
    navigate: (address) => {
      arrived = address;
    },
    unresolved: (text) => {
      reason = text;
    },
  });
  return { arrived, reason };
}

describe("renaming a note keeps the links that point at it working", () => {
  let handle: VaultHandle;

  beforeEach(async () => {
    resetDemoVault();
    handle = await openVault("demo");
  });

  it("arrives at the renamed note when a link to the old path is followed", async () => {
    const before = await followFrom(
      handle,
      "Examples/Work/project-ideas.md",
      "Examples/Community/event-plan",
    );
    expect(before.arrived).toEqual({
      path: "Examples/Community/event-plan.md",
    });

    await treeEntryMove(
      handle,
      "Examples/Community/event-plan.md",
      "Examples/Community/repair-cafe.md",
    );

    const source = await noteText(handle, "Examples/Work/project-ideas.md");
    const rewritten = source.match(/\[\[([^\]]*repair-cafe[^\]]*)\]\]/)?.[1];
    expect(rewritten).toBeDefined();

    const after = await followFrom(
      handle,
      "Examples/Work/project-ideas.md",
      (rewritten ?? "").split("|")[0] ?? "",
    );
    expect(after.arrived).toEqual({
      path: "Examples/Community/repair-cafe.md",
    });
    expect(after.reason).toBeNull();
  });

  it("rewrites every note that linked to it and no others", async () => {
    const linking = [
      "Examples/Work/project-ideas.md",
      "Features/tasks.md",
      "Features/tables.md",
      "index.md",
      "Examples/Home/maintenance-log.md",
    ];
    const paths = await notePaths(handle);
    const before = new Map<string, Uint8Array>();
    for (const path of paths) {
      before.set(path, await noteBytes(handle, path));
    }

    await treeEntryMove(
      handle,
      "Examples/Community/event-plan.md",
      "Examples/Community/repair-cafe.md",
    );

    const changed: string[] = [];
    for (const path of paths) {
      if (path === "Examples/Community/event-plan.md") {
        continue;
      }
      const now = await noteBytes(handle, path);
      if (decoder.decode(now) !== decoder.decode(before.get(path) ?? now)) {
        changed.push(path);
      }
    }
    expect(changed.sort()).toEqual([...linking].sort());
  });

  it("changes only the link target bytes, leaving every other byte in place", async () => {
    await putNote(
      handle,
      "byte-check.md",
      "Intro line.\r\nA link [[Examples/Community/event-plan|repair cafe]] here.\r\nTail with no newline",
    );
    const before = await noteBytes(handle, "byte-check.md");

    await treeEntryMove(
      handle,
      "Examples/Community/event-plan.md",
      "Examples/Community/repair-cafe.md",
    );
    const after = await noteBytes(handle, "byte-check.md");

    // Stated independently of the module under test: the same bytes with
    // one run replaced, terminators and the missing final newline intact.
    expect(decoder.decode(after)).toBe(
      "Intro line.\r\nA link [[Examples/Community/repair-cafe|repair cafe]] here.\r\nTail with no newline",
    );
    expect(after.at(-1)).toBe(before.at(-1));
    expect([...after].filter((byte) => byte === 0x0d)).toHaveLength(2);
  });

  it("leaves text that only resembles the renamed note alone", async () => {
    await putNote(
      handle,
      "similar.md",
      [
        "A different note [[Features/tasks|Tasks]].",
        "The words event-plan in prose.",
        "`[[Examples/Community/event-plan]]` inside code.",
        "",
        "```",
        "[[Examples/Community/event-plan]]",
        "```",
        "",
      ].join("\n"),
    );
    const before = await noteText(handle, "similar.md");

    await treeEntryMove(
      handle,
      "Examples/Community/event-plan.md",
      "Examples/Community/repair-cafe.md",
    );

    expect(await noteText(handle, "similar.md")).toBe(before);
  });

  it("moving a note between folders behaves exactly as renaming it does", async () => {
    await treeEntryMove(
      handle,
      "Examples/Personal/travel-plan.md",
      "Trips/travel-plan.md",
    );

    const arrival = await followFrom(
      handle,
      "index.md",
      "Examples/Personal/travel-plan",
    );
    expect(arrival.arrived).toBeNull();

    const source = await noteText(handle, "index.md");
    const target = source.match(/\[\[([^|\]]*travel-plan)[|\]]/)?.[1] ?? "";
    expect(target).not.toBe("Examples/Personal/travel-plan");
    const moved = await followFrom(handle, "index.md", target);
    expect(moved.arrived).toEqual({ path: "Trips/travel-plan.md" });
  });

  it("undo restores the entry and every note the rename rewrote", async () => {
    // Two references in one note, and a replacement of a different length
    // from what it replaces, so an inverse that ignores the offsets the
    // first edit shifted cannot restore the second.
    await putNote(
      handle,
      "two-links.md",
      "One [[Examples/Community/event-plan]] and two [[Examples/Community/event-plan|again]].\n",
    );
    const paths = await notePaths(handle);
    const before = new Map<string, string>();
    for (const path of paths) {
      before.set(path, await noteText(handle, path));
    }

    await treeEntryMove(
      handle,
      "Examples/Community/event-plan.md",
      "Examples/Community/repair-cafe.md",
    );
    await treeEntryMoveUndo(handle);

    expect(await notePaths(handle)).toEqual(paths);
    for (const path of paths) {
      expect(await noteText(handle, path)).toBe(before.get(path));
    }
    const arrival = await followFrom(
      handle,
      "Examples/Work/project-ideas.md",
      "Examples/Community/event-plan",
    );
    expect(arrival.arrived).toEqual({
      path: "Examples/Community/event-plan.md",
    });
  });
});

describe("the person is told what a rename writes before it writes it", () => {
  let handle: VaultHandle;

  beforeEach(async () => {
    resetDemoVault();
    handle = await openVault("demo");
  });

  it("names every note a rename would rewrite, and writes nothing to plan it", async () => {
    const before = await noteText(handle, "index.md");
    const plan = await treeEntryMovePlan(
      handle,
      "Examples/Community/event-plan.md",
      "Examples/Community/repair-cafe.md",
    );
    expect(plan.map((update) => update.path).sort()).toEqual(
      [
        "Examples/Home/maintenance-log.md",
        "Examples/Work/project-ideas.md",
        "Features/tables.md",
        "Features/tasks.md",
        "index.md",
      ].sort(),
    );
    expect(plan.every((update) => update.references >= 1)).toBe(true);
    expect(await noteText(handle, "index.md")).toBe(before);
    expect(
      (await indexedPaths(handle)).includes("Examples/Community/event-plan.md"),
    ).toBe(true);
  });

  it("the frontend preflight agrees with the vault about which notes are written", async () => {
    const context = await contextFor(handle, "index.md");
    const previewed = await planLinkUpdates(
      context,
      "Examples/Community/event-plan.md",
      "Examples/Community/repair-cafe.md",
    );
    const planned = await treeEntryMovePlan(
      handle,
      "Examples/Community/event-plan.md",
      "Examples/Community/repair-cafe.md",
    );
    const key = (updates: readonly LinkUpdateSummary[]) =>
      updates
        .map((update) => `${update.path}:${update.references}`)
        .sort()
        .join(",");
    expect(key(previewed)).toBe(key(planned));
  });

  it("the confirmation names the count and every file, or says none is written", async () => {
    const updates = await treeEntryMovePlan(
      handle,
      "Examples/Community/event-plan.md",
      "Examples/Community/repair-cafe.md",
    );
    const message = linkUpdateDescription(updates);
    expect(message).toContain("5");
    for (const update of updates) {
      expect(message.split("\n")).toContain(update.path);
    }

    expect(linkUpdateDescription([])).toBe(STRINGS.linkUpdateNone);
    expect(linkUpdateDescription([{ path: "a.md", references: 2 }])).toBe(
      `${STRINGS.linkUpdateOne}\na.md`,
    );
  });
});

describe("a link that cannot resolve fails where the reader is standing", () => {
  let handle: VaultHandle;

  beforeEach(async () => {
    resetDemoVault();
    handle = await openVault("demo");
  });

  it("reports the missing path and does not navigate away from the open note", async () => {
    const navigate = vi.fn();
    const unresolved = vi.fn();
    const handled = followWikilinkTarget("Examples/Community/nowhere", {
      context: await contextFor(handle, "index.md"),
      currentPath: "index.md",
      navigate,
      unresolved,
    });

    expect(handled).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    const reason = unresolved.mock.calls[0]?.[0] as string;
    expect(reason).toContain(STRINGS.wikilinkUnresolvedReason);
    expect(reason).toContain("Examples/Community/nowhere.md");
  });

  it("still navigates when the link does resolve", async () => {
    const navigate = vi.fn();
    followWikilinkTarget("Examples/Community/event-plan", {
      context: await contextFor(handle, "index.md"),
      currentPath: "index.md",
      navigate,
      unresolved: vi.fn(),
    });
    expect(navigate).toHaveBeenCalledWith({
      path: "Examples/Community/event-plan.md",
    });
  });

  it("a renamed note leaves no dangling reference to report", async () => {
    await treeEntryMove(
      handle,
      "Examples/Community/event-plan.md",
      "Examples/Community/repair-cafe.md",
    );
    const context = await contextFor(handle, "index.md");
    const source = await noteText(handle, "index.md");
    for (const [, target] of source.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const notePart = (target ?? "").split("|")[0] ?? "";
      if (!notePart.toLowerCase().includes("repair-cafe")) {
        continue;
      }
      expect(resolveWikilinkTarget(notePart, context)).toMatchObject({
        kind: "note",
        path: "Examples/Community/repair-cafe.md",
      });
    }
  });
});
