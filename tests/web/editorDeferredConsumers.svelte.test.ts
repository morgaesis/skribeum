import {
  deleteCharBackward,
  deleteGroupBackward,
  redo,
  undo,
} from "@codemirror/commands";
import { Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import Editor from "../../src/lib/Editor.svelte";
import { PostPaintScheduler } from "../../src/lib/editor/postPaintScheduler";
import {
  type EditorStatistics,
  formatWordCount,
} from "../../src/lib/features/noteStatistics";
import type { LoadedNote } from "../../src/lib/ipc/vault";
import Statusline from "../../src/lib/Statusline.svelte";
import TabStrip from "../../src/lib/TabStrip.svelte";
import { reactiveState } from "./support/reactiveState.svelte";

type EditorExports = {
  flush: () => Promise<boolean>;
  getView: () => EditorView | undefined;
  preparePaneSwitch: (kind: "note" | "history" | "tab") => void;
};

const encoder = new TextEncoder();
const mounted: object[] = [];

function loadedNote(text: string, hash: string): LoadedNote {
  const bytes = encoder.encode(text);
  return {
    meta: {
      encoding: "utf8",
      projection_hash: hash,
      byte_length: bytes.length,
    },
    bytes,
    text,
    readOnly: false,
  };
}

function mountEditor(props: Record<string, unknown>): {
  component: EditorExports;
  host: HTMLElement;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const component = mount(Editor, { target: host, props }) as EditorExports;
  mounted.push(component);
  flushSync();
  return { component, host };
}

async function settlePostPaint(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
  flushSync();
}

function observeMaterialization() {
  const original = Text.prototype.toString;
  let units = 0;
  const spy = vi.spyOn(Text.prototype, "toString").mockImplementation(function (
    this: Text,
  ) {
    units += this.length;
    return original.call(this);
  });
  return { spy, units: () => units };
}

afterEach(async () => {
  for (const component of mounted.splice(0)) await unmount(component);
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("large-note editor consumers", () => {
  it("coalesces rapid input into one post-paint materialization", async () => {
    const source = `${"large note words\n".repeat(75_000)}final word`;
    const changedSources: string[] = [];
    const statistics: EditorStatistics[] = [];
    const dirtyStates: boolean[] = [];
    const { component } = mountEditor({
      doc: source,
      note: loadedNote(source, "large-hash"),
      path: "large.md",
      onDocChanged: (next: string) => changedSources.push(next),
      onStatisticsChanged: (next: EditorStatistics) => statistics.push(next),
      onDirtyChanged: (dirty: boolean) => dirtyStates.push(dirty),
    });
    await settlePostPaint();
    const view = component.getView();
    if (view === undefined) throw new Error("editor did not mount");
    changedSources.length = 0;
    statistics.length = 0;
    dirtyStates.length = 0;
    const materialization = observeMaterialization();

    for (const character of "abcdefgh") {
      const head = view.state.doc.length;
      view.dispatch({
        changes: { from: head, insert: character },
        selection: { anchor: head + 1 },
        userEvent: "input.type",
      });
    }

    expect(view.state.sliceDoc(source.length)).toBe("abcdefgh");
    expect(dirtyStates.at(-1)).toBe(true);
    expect(materialization.spy).not.toHaveBeenCalled();
    expect(changedSources).toHaveLength(0);
    expect(statistics).toHaveLength(0);

    await settlePostPaint();

    expect(materialization.spy).toHaveBeenCalledTimes(1);
    expect(materialization.units()).toBe(source.length + 8);
    expect(changedSources).toEqual([`${source}abcdefgh`]);
    expect(statistics).toHaveLength(1);
    expect(statistics[0]?.characters).toBe(source.length + 8);
  });

  it("keeps self-embed source materialization out of the input dispatch", async () => {
    const source = `![[#Details]]\n\n## Details\n${"embedded body\n".repeat(10_000)}`;
    const changedSources: string[] = [];
    const { component } = mountEditor({
      doc: source,
      note: loadedNote(source, "self-embed-hash"),
      path: "self-embed.md",
      linkContext: {
        paths: ["self-embed.md"],
        config: {
          newLinkFormat: "shortest",
          useMarkdownLinks: false,
          attachmentFolderPath: null,
        },
        currentPath: "self-embed.md",
        embedAncestry: ["self-embed.md"],
        embedDepth: 0,
      },
      onDocChanged: (next: string) => changedSources.push(next),
    });
    await settlePostPaint();
    const view = component.getView();
    if (view === undefined) throw new Error("editor did not mount");
    changedSources.length = 0;
    const materialization = observeMaterialization();

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "updated" },
      userEvent: "input.type",
    });

    expect(materialization.spy).not.toHaveBeenCalled();
    expect(changedSources).toHaveLength(0);
    await settlePostPaint();
    expect(materialization.spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(changedSources).toEqual([`${source}updated`]);
  });

  it.each([
    ["Backspace", deleteCharBackward],
    ["word deletion", deleteGroupBackward],
  ])("defers full-document consumers for %s", async (_label, command) => {
    const source = `${"body line\n".repeat(25_000)}last words`;
    const changedSources: string[] = [];
    const dirtyStates: boolean[] = [];
    const { component } = mountEditor({
      doc: source,
      note: loadedNote(source, "delete-hash"),
      path: "delete.md",
      onDocChanged: (next: string) => changedSources.push(next),
      onDirtyChanged: (dirty: boolean) => dirtyStates.push(dirty),
    });
    await settlePostPaint();
    const view = component.getView();
    if (view === undefined) throw new Error("editor did not mount");
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    await settlePostPaint();
    changedSources.length = 0;
    dirtyStates.length = 0;
    const materialization = observeMaterialization();

    expect(command(view)).toBe(true);

    const changed = view.state.sliceDoc();
    expect(changed).not.toBe(source);
    expect(dirtyStates.at(-1)).toBe(true);
    expect(materialization.spy).not.toHaveBeenCalled();
    expect(changedSources).toHaveLength(0);

    await settlePostPaint();

    expect(materialization.spy).toHaveBeenCalledTimes(1);
    expect(changedSources).toEqual([changed]);
  });

  it("defers undo and redo consumers while preserving immediate history state", async () => {
    const source = `${"history line\n".repeat(10_000)}alpha`;
    const changedSources: string[] = [];
    const { component } = mountEditor({
      doc: source,
      note: loadedNote(source, "history-hash"),
      path: "history.md",
      onDocChanged: (next: string) => changedSources.push(next),
    });
    await settlePostPaint();
    const view = component.getView();
    if (view === undefined) throw new Error("editor did not mount");
    view.dispatch({
      changes: { from: view.state.doc.length, insert: " beta" },
      selection: { anchor: view.state.doc.length + 5 },
      userEvent: "input.type",
    });
    await settlePostPaint();
    changedSources.length = 0;
    const materialization = observeMaterialization();

    expect(undo(view)).toBe(true);
    expect(view.state.sliceDoc()).toBe(source);
    expect(materialization.spy).not.toHaveBeenCalled();
    await settlePostPaint();
    expect(changedSources).toEqual([source]);
    expect(materialization.spy).toHaveBeenCalledTimes(1);

    changedSources.length = 0;
    materialization.spy.mockClear();
    expect(redo(view)).toBe(true);
    expect(view.state.sliceDoc()).toBe(`${source} beta`);
    expect(materialization.spy).not.toHaveBeenCalled();
    await settlePostPaint();
    expect(changedSources).toEqual([`${source} beta`]);
    expect(materialization.spy).toHaveBeenCalledTimes(1);
  });

  it("updates the dirty tab immediately and its title and statistics after paint", async () => {
    const source = "# Original title\nbody words\n";
    const note = loadedNote(source, "visible-hash");
    const tabProps = reactiveState({
      tabs: [
        { path: "visible.md", viewState: null, dirty: false },
        { path: "other.md", viewState: null, dirty: false },
      ],
      activePath: "visible.md" as string | null,
      titleSources: {
        "visible.md": source,
        "other.md": "# Other title\n",
      } as Record<string, string>,
      focused: true,
      onActivate: (_path: string) => {},
      onClose: (_path: string) => {},
      onReorder: (_from: number, _to: number) => {},
    });
    const statusProps = reactiveState({
      path: "visible.md" as string | null,
      statistics: null as EditorStatistics | null,
    });
    const tabHost = document.createElement("div");
    const statusHost = document.createElement("div");
    document.body.append(tabHost, statusHost);
    mounted.push(
      mount(TabStrip, {
        target: tabHost,
        props: tabProps,
      }),
      mount(Statusline, {
        target: statusHost,
        props: statusProps,
      }),
    );
    const { component } = mountEditor({
      doc: source,
      note,
      path: "visible.md",
      onDocChanged: (next: string) => {
        tabProps.titleSources = {
          ...tabProps.titleSources,
          "visible.md": next,
        };
      },
      onDirtyChanged: (dirty: boolean) => {
        const tab = tabProps.tabs[0];
        if (tab !== undefined) tab.dirty = dirty;
      },
      onStatisticsChanged: (statistics: EditorStatistics) => {
        statusProps.statistics = statistics;
      },
    });
    await settlePostPaint();
    const view = component.getView();
    if (view === undefined) throw new Error("editor did not mount");
    expect(tabHost.querySelector(".skr-tab-label")?.textContent).toBe(
      "Original title",
    );
    expect(
      statusHost.querySelector('[data-testid="statusline-word-count"]')
        ?.textContent,
    ).toBe(formatWordCount(5, 0));

    view.dispatch({
      changes: { from: 2, to: "# Original title".length, insert: "Revised" },
      userEvent: "input.type",
    });
    flushSync();

    expect(view.state.sliceDoc(0, "# Revised".length)).toBe("# Revised");
    expect(
      tabHost.querySelector('[role="tab"]')?.getAttribute("data-dirty"),
    ).toBe("true");
    expect(tabHost.querySelector(".skr-tab-label")?.textContent).toBe(
      "Original title",
    );

    await settlePostPaint();

    expect(tabHost.querySelector(".skr-tab-label")?.textContent).toBe(
      "Revised",
    );
    expect(
      statusHost.querySelector('[data-testid="statusline-word-count"]')
        ?.textContent,
    ).toBe(formatWordCount(4, 0));
  });

  it("fences pending source and statistics work when switching notes", async () => {
    const noteA = loadedNote("# Alpha\nalpha body\n", "hash-a");
    const noteB = loadedNote("# Bravo\nbravo body words\n", "hash-b");
    const changed: Array<{ source: string; path: string | null }> = [];
    const statistics: EditorStatistics[] = [];
    const props = reactiveState({
      doc: noteA.text,
      note: noteA as LoadedNote | null,
      path: "a.md" as string | null,
      onDocChanged: (source: string, path: string | null) =>
        changed.push({ source, path }),
      onStatisticsChanged: (next: EditorStatistics) => statistics.push(next),
    });
    const { component } = mountEditor(props);
    await settlePostPaint();
    changed.length = 0;
    statistics.length = 0;
    const view = component.getView();
    if (view === undefined) throw new Error("editor did not mount");
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "stale" },
      userEvent: "input.type",
    });

    component.preparePaneSwitch("tab");
    props.note = noteB;
    props.path = "b.md";
    props.doc = noteB.text;
    flushSync();
    await settlePostPaint();

    expect(changed).toEqual([{ source: noteB.text, path: "b.md" }]);
    expect(statistics).toHaveLength(1);
    expect(statistics[0]?.words).toBe(5);
  });

  it("settles the outgoing source before an application-managed switch", async () => {
    const sourceA = "# Alpha\nbody\n";
    const noteB = loadedNote("# Bravo\nbody\n", "flush-hash-b");
    const changed: Array<{ source: string; path: string | null }> = [];
    const props = reactiveState({
      doc: sourceA,
      note: null as LoadedNote | null,
      path: "a.md" as string | null,
      onDocChanged: (source: string, path: string | null) =>
        changed.push({ source, path }),
    });
    const { component } = mountEditor(props);
    await settlePostPaint();
    changed.length = 0;
    const view = component.getView();
    if (view === undefined) throw new Error("editor did not mount");
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "latest" },
      userEvent: "input.type",
    });

    expect(await component.flush()).toBe(true);
    expect(changed).toEqual([{ source: `${sourceA}latest`, path: "a.md" }]);

    component.preparePaneSwitch("tab");
    props.note = noteB;
    props.path = "b.md";
    props.doc = noteB.text;
    flushSync();
    await settlePostPaint();
    expect(changed).toEqual([
      { source: `${sourceA}latest`, path: "a.md" },
      { source: noteB.text, path: "b.md" },
    ]);
  });

  it("fences pending consumers during teardown", async () => {
    const changedSources: string[] = [];
    const source = "# Teardown\nbody\n";
    const { component } = mountEditor({
      doc: source,
      note: loadedNote(source, "teardown-hash"),
      path: "teardown.md",
      onDocChanged: (next: string) => changedSources.push(next),
    });
    await settlePostPaint();
    changedSources.length = 0;
    const view = component.getView();
    if (view === undefined) throw new Error("editor did not mount");
    const materialization = observeMaterialization();
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "stale" },
      userEvent: "input.type",
    });

    await unmount(component);
    mounted.splice(mounted.indexOf(component), 1);
    await settlePostPaint();

    expect(changedSources).toHaveLength(0);
    expect(materialization.spy).not.toHaveBeenCalled();
  });
});

describe("post-paint scheduler generation fence", () => {
  it("coalesces work and rejects a stale task even if cancellation loses the race", () => {
    let nextHandle = 0;
    const frames = new Map<number, FrameRequestCallback>();
    const tasks = new Map<number, () => void>();
    const clock = {
      requestFrame: (callback: FrameRequestCallback) => {
        nextHandle += 1;
        frames.set(nextHandle, callback);
        return nextHandle;
      },
      cancelFrame: (handle: number) => frames.delete(handle),
      scheduleTask: (callback: () => void) => {
        nextHandle += 1;
        tasks.set(nextHandle, callback);
        return nextHandle as ReturnType<typeof setTimeout>;
      },
      cancelTask: (handle: ReturnType<typeof setTimeout>) =>
        tasks.delete(handle as number),
    };
    const scheduler = new PostPaintScheduler(clock);
    const observed: string[] = [];
    scheduler.schedule(() => observed.push("first"));
    scheduler.schedule(() => observed.push("latest"));
    const frame = frames.values().next().value;
    if (frame === undefined) throw new Error("frame was not scheduled");
    frame(0);
    const staleTask = tasks.values().next().value;
    if (staleTask === undefined) throw new Error("task was not scheduled");

    scheduler.fence();
    staleTask();
    expect(observed).toEqual([]);

    scheduler.schedule(() => observed.push("fresh"));
    const freshFrame = Array.from(frames.values()).at(-1);
    if (freshFrame === undefined)
      throw new Error("fresh frame was not scheduled");
    freshFrame(0);
    const freshTask = Array.from(tasks.values()).at(-1);
    if (freshTask === undefined)
      throw new Error("fresh task was not scheduled");
    freshTask();
    expect(observed).toEqual(["fresh"]);
  });
});
