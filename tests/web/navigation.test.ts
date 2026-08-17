import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";

const openUrl = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl }));

import { decorationEngine } from "../../src/lib/editor/decorations/engine";
import {
  DEFAULT_OBSIDIAN_APP_CONFIG,
  wikilinkPointerNavigation,
} from "../../src/lib/editor/decorations/wikilinks";
import { obsidianMarkdownExtensions } from "../../src/lib/editor/markdown/obsidian";
import { createAppRegistry } from "../../src/lib/features";
import {
  browserLinkForAddress,
  desktopLinkForAddress,
} from "../../src/lib/features/copyLinks";
import {
  createNoteNavigator,
  externalLinkAt,
  type FollowWikilinkOptions,
  followLinkUnderCursor,
  followWikilinkUnderCursor,
  NAVIGATION_HISTORY_LIMIT,
  noteAddressFromUrl,
  noteFragmentPosition,
  openExternalLink,
  readingViewportTop,
  type ScrollAnchorGeometry,
  type ScrollAnchorLine,
  scrollAnchorForViewport,
  urlForNoteAddress,
} from "../../src/lib/features/navigation";
import { commandItems } from "../../src/lib/features/pickers";
import { type CommandContext, editorKeymap } from "../../src/lib/registry";
import { STRINGS } from "../../src/lib/strings";

const views: EditorView[] = [];

function navigationOptions(overrides: Partial<FollowWikilinkOptions> = {}) {
  return {
    context: {
      paths: ["source.md", "Target note.md"],
      config: DEFAULT_OBSIDIAN_APP_CONFIG,
      currentPath: "source.md",
    },
    currentPath: "source.md",
    navigate: vi.fn(),
    unresolved: vi.fn(),
    ...overrides,
  } satisfies FollowWikilinkOptions;
}

function makePointerView(
  doc: string,
  cursor: number,
  options: FollowWikilinkOptions,
): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: obsidianMarkdownExtensions,
        }),
        decorationEngine(),
        wikilinkPointerNavigation(() => options),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

function wikilinkTarget(view: EditorView): HTMLElement {
  const target = view.dom.querySelector<HTMLElement>(".cm-skr-wikilink-target");
  if (target === null) {
    throw new Error("wikilink target decoration missing");
  }
  return target;
}

function embedTarget(view: EditorView): HTMLElement {
  const target = view.dom.querySelector<HTMLElement>(".cm-skr-embed-header");
  if (target === null) {
    throw new Error("rendered embed navigation target missing");
  }
  return target;
}

function pressLink(
  view: EditorView,
  init: MouseEventInit = {},
  target = wikilinkTarget(view),
): MouseEvent {
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.replaceChildren();
  openUrl.mockReset();
  vi.restoreAllMocks();
});

describe("wikilink pointer navigation", () => {
  it("follows a plain click when the cursor is outside the link", () => {
    const navigate = vi.fn();
    const options = navigationOptions({ navigate });
    const view = makePointerView("Before [[Target note]] after", 0, options);
    view.focus();
    expect(view.hasFocus).toBe(true);

    const event = pressLink(view);

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ path: "Target note.md" });
    expect(view.hasFocus).toBe(false);
  });

  it("follows an embedded note reference", () => {
    const navigate = vi.fn();
    const options = navigationOptions({ navigate });
    const view = makePointerView("Preview ![[Target note]] here", 0, options);

    const event = pressLink(view, {}, embedTarget(view));

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ path: "Target note.md" });
  });

  it("follows a focused embedded note reference with Enter", () => {
    const navigate = vi.fn();
    const options = navigationOptions({ navigate });
    const view = makePointerView("Preview ![[Target note]] here", 0, options);
    const target = embedTarget(view);
    target.focus();
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
    });

    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ path: "Target note.md" });
  });

  it("follows a click event when no pointer-down event precedes it", () => {
    const navigate = vi.fn();
    const options = navigationOptions({ navigate });
    const view = makePointerView("Before [[Target note]] after", 0, options);
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    });

    wikilinkTarget(view).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ path: "Target note.md" });
  });

  it.each(["ctrlKey", "metaKey"] as const)(
    "opens a %s click in a new tab without changing the editor selection",
    (modifier) => {
      const navigate = vi.fn();
      const options = navigationOptions({ navigate });
      const view = makePointerView("Before [[Target note]] after", 0, options);
      view.dispatch({ selection: { anchor: 0, head: 6 } });
      const selection = view.state.selection;

      const event = pressLink(view, { [modifier]: true });

      expect(event.defaultPrevented).toBe(true);
      expect(view.state.selection.eq(selection)).toBe(true);
      expect(navigate).toHaveBeenCalledWith(
        { path: "Target note.md" },
        { newTab: true },
      );
    },
  );

  it("opens a middle-click on a link in a new tab", () => {
    const navigate = vi.fn();
    const options = navigationOptions({ navigate });
    const view = makePointerView("Before [[Target note]] after", 0, options);

    const event = new MouseEvent("auxclick", {
      bubbles: true,
      cancelable: true,
      button: 1,
    });
    wikilinkTarget(view).dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith(
      { path: "Target note.md" },
      { newTab: true },
    );
  });

  it("leaves a plain click in edit mode when the cursor is inside the link", () => {
    const navigate = vi.fn();
    const options = navigationOptions({ navigate });
    const doc = "Before [[Target note]] after";
    const cursor = doc.indexOf("Target note") + 3;
    const view = makePointerView(doc, cursor, options);

    expect(view.dom.querySelectorAll(".cm-skr-reveal-source")).toHaveLength(1);
    pressLink(view);

    expect(navigate).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
  });

  it("follows a rendered link while one other source region is revealed", () => {
    const navigate = vi.fn();
    const options = navigationOptions({
      navigate,
      context: {
        paths: ["First note.md", "Target note.md"],
        config: DEFAULT_OBSIDIAN_APP_CONFIG,
        currentPath: "source.md",
      },
    });
    const doc = "[[First note]] and [[Target note]]";
    const view = makePointerView(doc, doc.indexOf("First note") + 2, options);
    const targets = view.dom.querySelectorAll<HTMLElement>(
      ".cm-skr-wikilink-target",
    );
    const second = targets[1];
    if (second === undefined) {
      throw new Error("second rendered wikilink missing");
    }

    const event = pressLink(view, {}, second);

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ path: "Target note.md" });
    expect(view.dom.querySelectorAll(".cm-skr-reveal-source")).toHaveLength(1);
  });

  it("explains an unresolved link and navigates to its missing candidate", () => {
    const navigate = vi.fn();
    const unresolved = vi.fn();
    const options = navigationOptions({ navigate, unresolved });
    const view = makePointerView("Open [[Missing note]]", 0, options);

    pressLink(view);

    expect(unresolved).toHaveBeenCalledWith(STRINGS.wikilinkUnresolvedReason);
    expect(navigate).toHaveBeenCalledWith({ path: "Missing note.md" });
  });
});

describe("wikilink keyboard navigation", () => {
  it.each([
    ["Enter", false],
    ["Control and Enter", true],
  ])(
    "follows the cursor link with %s when the tag menu is closed",
    (_label, control) => {
      const registry = createAppRegistry();
      const navigate = vi.fn();
      const options = navigationOptions({ navigate });
      const doc = "Before [[Target note]] after";
      let view: EditorView;
      const commandContext = (): CommandContext => ({
        view,
        openNote: () => Promise.resolve(),
        openView: () => {},
        openCommandSurface: () => {},
        toggleView: () => {},
        closeSurfaces: () => {},
        requestSave: () => {},
        notePaths: () => options.context.paths,
        recentNotePaths: () => [],
        navigateBack: () => false,
        navigateForward: () => false,
        followLink: (activeView) =>
          followWikilinkUnderCursor(activeView ?? view, options),
      });
      view = new EditorView({
        state: EditorState.create({
          doc,
          selection: { anchor: doc.indexOf("Target note") + 2 },
          extensions: [
            markdown({
              base: markdownLanguage,
              extensions: obsidianMarkdownExtensions,
            }),
            editorKeymap(registry, commandContext),
          ],
        }),
        parent: document.body,
      });
      views.push(view);
      view.focus();
      expect(view.hasFocus).toBe(true);

      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        ctrlKey: control,
        bubbles: true,
        cancelable: true,
      });
      view.contentDOM.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(navigate).toHaveBeenCalledWith({ path: "Target note.md" });
      expect(view.state.doc.toString()).toBe(doc);
      expect(view.hasFocus).toBe(false);
    },
  );

  it("shows the cross-platform follow binding in the palette", () => {
    const registry = createAppRegistry();
    const command = registry.command("navigation.follow-link");
    const item = commandItems(registry, "Follow link", false).find(
      (candidate) => candidate.value === "navigation.follow-link",
    );

    expect(command?.keybindings).toEqual(["Mod-Enter", "Enter"]);
    expect(item?.keybinding).toBe("Ctrl+Enter");
  });
});

describe("external link navigation", () => {
  it.each([
    ["plain URL", "Visit https://example.com/plain now", ".cm-skr-url"],
    [
      "Markdown link",
      "Visit [External site](https://example.com/markdown) now",
      ".cm-skr-link",
    ],
  ])("follows a %s through pointer activation", (_label, doc, selector) => {
    const openExternal = vi.fn();
    const options = navigationOptions({ openExternal });
    const view = makePointerView(doc, 0, options);
    const target = view.dom.querySelector<HTMLElement>(selector);
    if (target === null) throw new Error(`${selector} decoration missing`);

    const event = pressLink(view, {}, target);

    expect(event.defaultPrevented).toBe(true);
    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(
      doc.includes("markdown")
        ? "https://example.com/markdown"
        : "https://example.com/plain",
    );
  });

  it.each([
    ["https://example.com/plain", 10],
    ["[External](http://example.com/markdown)", 3],
  ])("follows %s through the follow-link command", (doc, position) => {
    const openExternal = vi.fn();
    const options = navigationOptions({ openExternal });
    const view = makePointerView(doc, position, options);
    view.dispatch({ selection: { anchor: position } });

    expect(followLinkUnderCursor(view, options)).toBe(true);
    expect(openExternal).toHaveBeenCalledWith(
      doc.startsWith("[")
        ? "http://example.com/markdown"
        : "https://example.com/plain",
    );
  });

  it("recognizes only HTTP and HTTPS source targets", () => {
    const view = makePointerView(
      "[web](https://example.com) [file](file:///tmp/note.md)",
      0,
      navigationOptions(),
    );
    expect(externalLinkAt(view.state, 3)).toBe("https://example.com");
    expect(externalLinkAt(view.state, 34)).toBeNull();
  });

  it("invokes the desktop opener with the exact URL without navigating", async () => {
    openUrl.mockResolvedValueOnce(undefined);
    const initialLocation = window.location.href;

    await openExternalLink("https://example.com/exact?value=one", "desktop");

    expect(openUrl).toHaveBeenCalledWith("https://example.com/exact?value=one");
    expect(window.location.href).toBe(initialLocation);
  });

  it("uses a noopener browser tab outside the desktop runtime", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);

    await openExternalLink("http://example.com/browser", "browser", window);

    expect(open).toHaveBeenCalledWith(
      "http://example.com/browser",
      "_blank",
      "noopener",
    );
    expect(openUrl).not.toHaveBeenCalled();
  });
});

describe("note addressing and desktop history", () => {
  it("generates browser URLs and configured desktop note links", () => {
    const address = { path: "notes/Target note.md", fragment: "Details" };
    expect(
      browserLinkForAddress(address, new URL("https://example.test/skribeum/")),
    ).toBe(
      "https://example.test/skribeum/?note=notes%2FTarget+note.md#Details",
    );
    const context = {
      paths: ["source.md", "notes/Target note.md"],
      currentPath: "source.md",
      config: {
        newLinkFormat: "shortest" as const,
        useMarkdownLinks: false,
        attachmentFolderPath: null,
      },
    };
    expect(desktopLinkForAddress(address, context)).toBe(
      "[[Target note#Details]]",
    );
    expect(
      desktopLinkForAddress(address, {
        ...context,
        config: { ...context.config, useMarkdownLinks: true },
      }),
    ).toBe("[Details](Target%20note#Details)");
  });

  it("round-trips encoded browser paths and fragments", () => {
    const address = {
      path: "notes/Café & tea.md",
      fragment: "Daily plan #1",
    };
    const encoded = urlForNoteAddress(
      address,
      new URL("https://example.test/skribeum/?theme=dark"),
    );

    expect(encoded.searchParams.get("theme")).toBe("dark");
    expect(encoded.searchParams.get("note")).toBe(address.path);
    expect(encoded.href).toContain("note=notes%2FCaf%C3%A9+%26+tea.md");
    expect(encoded.hash).toBe("#Daily%20plan%20%231");
    expect(noteAddressFromUrl(encoded)).toEqual(address);
  });

  it("locates heading and block fragments in the open note", () => {
    const doc = "# Top\n\n## Details\n\nParagraph ^row-one\n";
    const state = EditorState.create({
      doc,
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: obsidianMarkdownExtensions,
        }),
      ],
    });

    expect(noteFragmentPosition(state, "Details")).toBe(doc.indexOf("##"));
    expect(noteFragmentPosition(state, "^row-one")).toBe(
      doc.indexOf("^row-one"),
    );
  });

  it("loads desktop history entries on back and forward", async () => {
    const first = { path: "first.md" };
    const second = { path: "folder/second.md", fragment: "Details" };
    const load = vi.fn(async () => {});
    let captured = {
      anchor: 7,
      head: 11,
      scrollAnchor: 5,
      scrollOffset: 8,
      propertiesExpanded: false,
    };
    const navigator = createNoteNavigator({
      mode: "desktop",
      load,
      capture: () => captured,
    });

    await navigator.start(first);
    await navigator.open(second);
    expect(navigator.state()).toMatchObject({
      address: second,
      canGoBack: true,
      canGoForward: false,
    });

    captured = {
      anchor: 19,
      head: 19,
      scrollAnchor: 17,
      scrollOffset: 4,
      propertiesExpanded: true,
    };
    expect(navigator.back()).toBe(true);
    await vi.waitFor(() =>
      expect(load).toHaveBeenLastCalledWith(
        first,
        {
          anchor: 7,
          head: 11,
          scrollAnchor: 5,
          scrollOffset: 8,
          propertiesExpanded: false,
        },
        "history",
      ),
    );
    expect(navigator.state()).toMatchObject({
      address: first,
      canGoBack: false,
      canGoForward: true,
    });

    expect(navigator.forward()).toBe(true);
    await vi.waitFor(() =>
      expect(load).toHaveBeenLastCalledWith(
        second,
        {
          anchor: 19,
          head: 19,
          scrollAnchor: 17,
          scrollOffset: 4,
          propertiesExpanded: true,
        },
        "history",
      ),
    );
    expect(navigator.state()).toMatchObject({
      address: second,
      canGoBack: true,
      canGoForward: false,
    });
    navigator.dispose();
  });

  it("caps desktop history at one hundred entries", async () => {
    const load = vi.fn(async () => {});
    const navigator = createNoteNavigator({ mode: "desktop", load });
    await navigator.start({ path: "0.md" });
    for (let index = 1; index <= NAVIGATION_HISTORY_LIMIT; index += 1) {
      await navigator.open({ path: `${index}.md` });
    }

    let traversed = 0;
    while (navigator.back()) {
      traversed += 1;
    }

    expect(traversed).toBe(NAVIGATION_HISTORY_LIMIT - 1);
    await vi.waitFor(() =>
      expect(load).toHaveBeenLastCalledWith({ path: "1.md" }, null, "history"),
    );
    expect(navigator.state().address).toEqual({ path: "1.md" });
    navigator.dispose();
  });

  it("rolls desktop history back when traversal loading is declined", async () => {
    const first = { path: "first.md" };
    const second = { path: "second.md" };
    let declineFirst = false;
    const navigator = createNoteNavigator({
      mode: "desktop",
      load: async (address) => !(declineFirst && address.path === first.path),
    });

    await navigator.start(first);
    await navigator.open(second);
    declineFirst = true;
    expect(navigator.back()).toBe(true);
    await vi.waitFor(() =>
      expect(navigator.state()).toMatchObject({
        address: second,
        canGoBack: true,
        canGoForward: false,
      }),
    );
    navigator.dispose();
  });

  it("projects browser navigation onto the History API", async () => {
    window.history.replaceState({}, "", "/skribeum/");
    const first = { path: "first.md" };
    const second = { path: "folder/second.md" };
    const load = vi.fn(async () => {});
    const navigator = createNoteNavigator({
      mode: "browser",
      browserWindow: window,
      load,
    });

    await navigator.start(first);
    expect(new URL(window.location.href).searchParams.get("note")).toBe(
      "first.md",
    );
    await navigator.open(second);
    expect(new URL(window.location.href).searchParams.get("note")).toBe(
      "folder/second.md",
    );

    expect(navigator.back()).toBe(true);
    await vi.waitFor(() =>
      expect(load).toHaveBeenLastCalledWith(first, null, "history"),
    );
    expect(new URL(window.location.href).searchParams.get("note")).toBe(
      "first.md",
    );
    navigator.dispose();
    window.history.replaceState({}, "", "/");
  });
});

describe("stored reading positions", () => {
  // A laid-out editor as a webview reports one: the line height and the
  // content padding both come out of a rem-based type scale, so line tops and
  // the scroll positions that show them are fractional. Zoom scales the
  // layout and the device pixel together.
  type Layout = {
    lineHeight: number;
    paddingTop: number;
    devicePixelRatio: number;
  };

  const DEFAULT_ZOOM: Layout = {
    lineHeight: 27.1875,
    paddingTop: 37.05,
    devicePixelRatio: 1,
  };
  const LARGER_ZOOM: Layout = {
    lineHeight: 27.1875 * 1.25,
    paddingTop: 37.05 * 1.25,
    devicePixelRatio: 1.25,
  };
  const LINE_LENGTH = 33;
  const LINE_COUNT = 84;
  const DOCUMENT_LENGTH = LINE_COUNT * LINE_LENGTH - 1;

  function lineBlock(layout: Layout, index: number): ScrollAnchorLine {
    const clamped = Math.min(Math.max(index, 0), LINE_COUNT - 1);
    const from = clamped * LINE_LENGTH;
    return {
      from,
      to: from + LINE_LENGTH - 1,
      top: clamped * layout.lineHeight,
    };
  }

  function geometryAt(layout: Layout, scrollTop: number): ScrollAnchorGeometry {
    return {
      viewportTop: Math.max(0, scrollTop - layout.paddingTop),
      documentLength: DOCUMENT_LENGTH,
      devicePixelRatio: layout.devicePixelRatio,
      lineBlockAtHeight: (height) =>
        lineBlock(layout, Math.floor(height / layout.lineHeight)),
      lineBlockAt: (position) =>
        lineBlock(layout, Math.floor(position / LINE_LENGTH)),
    };
  }

  /**
   * A scroll position as the scroller can hold it. Chromium engines round an
   * assigned `scrollTop` to whole device pixels; WebKit keeps the fraction,
   * which is why the same restoration is exact on one engine and off by up to
   * half a device pixel on another.
   */
  function heldScrollTop(layout: Layout, scrollTop: number): number {
    return (
      Math.round(scrollTop * layout.devicePixelRatio) / layout.devicePixelRatio
    );
  }

  /** Scrolls so the stored anchor line sits its stored distance below the edge. */
  function restore(
    layout: Layout,
    state: { scrollAnchor: number; scrollOffset: number },
  ): number {
    const line = lineBlock(
      layout,
      Math.floor(state.scrollAnchor / LINE_LENGTH),
    );
    return heldScrollTop(
      layout,
      line.top - state.scrollOffset + layout.paddingTop,
    );
  }

  function capture(
    layout: Layout,
    scrollTop: number,
  ): { scrollAnchor: number; scrollOffset: number } {
    const position = scrollAnchorForViewport(geometryAt(layout, scrollTop));
    return {
      scrollAnchor: position.line.from,
      scrollOffset: position.offset,
    };
  }

  function denotedViewportTop(
    layout: Layout,
    state: { scrollAnchor: number; scrollOffset: number },
  ): number {
    return readingViewportTop(
      lineBlock(layout, Math.floor(state.scrollAnchor / LINE_LENGTH)).top,
      state.scrollOffset,
    );
  }

  it("restores exactly while the layout is unchanged", () => {
    for (let scrollTop = 0; scrollTop < 1600; scrollTop += 0.5) {
      const held = heldScrollTop(DEFAULT_ZOOM, scrollTop);
      const stored = capture(DEFAULT_ZOOM, held);
      const restored = capture(DEFAULT_ZOOM, restore(DEFAULT_ZOOM, stored));
      expect({ scrollTop, ...restored }).toEqual({ scrollTop, ...stored });
    }
  });

  it("stores the same position against either adjacent line across zoom", () => {
    // Captured while the note was zoomed in, restored after the zoom was
    // reset: the layout the stored distance was measured in is gone, so the
    // scroller rounds to the nearest device pixel and lands a hundredth of a
    // pixel into the anchor line rather than a fraction of a pixel above it.
    // The stored line stops being the first line seen whole and its neighbour
    // takes over, which reads as a whole line of difference in the stored
    // fields and as no difference at all to the reader.
    const stored = capture(LARGER_ZOOM, 1847.2);
    expect(stored.scrollAnchor).toBe(53 * LINE_LENGTH);
    expect(stored.scrollOffset).toBeCloseTo(0.284375, 6);

    const restoredScrollTop = restore(DEFAULT_ZOOM, stored);
    expect(restoredScrollTop).toBe(1478);
    const restored = capture(DEFAULT_ZOOM, restoredScrollTop);
    expect(restored.scrollAnchor).toBe(54 * LINE_LENGTH);
    // A line height less the hundredth of a pixel the anchor line is clipped
    // by: the stored fields differ by a whole line, the reader by nothing.
    expect(restored.scrollOffset).toBeCloseTo(27.175, 6);

    // Both records describe one place, within the finest position the
    // scroller can hold.
    const drift =
      denotedViewportTop(DEFAULT_ZOOM, restored) -
      denotedViewportTop(DEFAULT_ZOOM, stored);
    expect(Math.abs(drift)).toBeLessThanOrEqual(
      1 / DEFAULT_ZOOM.devicePixelRatio,
    );
  });

  it("keeps the reader within a device pixel across every zoom change", () => {
    for (let scrollTop = 0; scrollTop < 1900; scrollTop += 0.125) {
      const stored = capture(
        LARGER_ZOOM,
        heldScrollTop(LARGER_ZOOM, scrollTop),
      );
      const restoredScrollTop = restore(DEFAULT_ZOOM, stored);
      // A distance measured in the zoomed layout can put the position above
      // the start of the document once the zoom is reset, and the scroller
      // stops at the top; positions it cannot reach are not positions it can
      // be held to.
      if (restoredScrollTop < DEFAULT_ZOOM.paddingTop) continue;
      const restored = capture(DEFAULT_ZOOM, restoredScrollTop);
      const drift =
        denotedViewportTop(DEFAULT_ZOOM, restored) -
        denotedViewportTop(DEFAULT_ZOOM, stored);
      expect({ scrollTop, within: Math.abs(drift) <= 1 }).toEqual({
        scrollTop,
        within: true,
      });
    }
  });

  it("anchors to the first line the reader sees whole", () => {
    const { lineHeight, paddingTop } = DEFAULT_ZOOM;
    const stored = capture(
      DEFAULT_ZOOM,
      2 * lineHeight + lineHeight / 2 + paddingTop,
    );
    expect(stored.scrollAnchor).toBe(3 * LINE_LENGTH);
    expect(stored.scrollOffset).toBeCloseTo(lineHeight / 2, 6);
  });
});
