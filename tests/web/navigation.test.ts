import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decorationEngine } from "../../src/lib/editor/decorations/engine";
import {
  DEFAULT_OBSIDIAN_APP_CONFIG,
  wikilinkPointerNavigation,
} from "../../src/lib/editor/decorations/wikilinks";
import { obsidianMarkdownExtensions } from "../../src/lib/editor/markdown/obsidian";
import { createAppRegistry } from "../../src/lib/features";
import {
  createNoteNavigator,
  type FollowWikilinkOptions,
  followWikilinkUnderCursor,
  noteAddressFromUrl,
  noteFragmentPosition,
  urlForNoteAddress,
} from "../../src/lib/features/navigation";
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

function pressLink(view: EditorView, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  wikilinkTarget(view).dispatchEvent(event);
  return event;
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("wikilink pointer navigation", () => {
  it("follows a plain click when the cursor is outside the link", () => {
    const navigate = vi.fn();
    const options = navigationOptions({ navigate });
    const view = makePointerView("Before [[Target note]] after", 0, options);

    const event = pressLink(view);

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith({ path: "Target note.md" });
  });

  it("follows a note embed through the same click path", () => {
    const navigate = vi.fn();
    const options = navigationOptions({ navigate });
    const view = makePointerView("![[Target note]]", 0, options);

    pressLink(view);

    expect(navigate).toHaveBeenCalledWith({ path: "Target note.md" });
  });

  it("follows an embedded note reference", () => {
    const navigate = vi.fn();
    const options = navigationOptions({ navigate });
    const view = makePointerView("Preview ![[Target note]] here", 0, options);

    const event = pressLink(view);

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ path: "Target note.md" });
  });

  it.each(["ctrlKey", "metaKey"] as const)(
    "follows a %s click without changing the editor selection",
    (modifier) => {
      const navigate = vi.fn();
      const options = navigationOptions({ navigate });
      const view = makePointerView("Before [[Target note]] after", 0, options);
      view.dispatch({ selection: { anchor: 0, head: 6 } });
      const selection = view.state.selection;

      const event = pressLink(view, { [modifier]: true });

      expect(event.defaultPrevented).toBe(true);
      expect(view.state.selection.eq(selection)).toBe(true);
      expect(navigate).toHaveBeenCalledWith({ path: "Target note.md" });
    },
  );

  it("leaves a plain click in edit mode when the cursor is inside the link", () => {
    const navigate = vi.fn();
    const options = navigationOptions({ navigate });
    const doc = "Before [[Target note]] after";
    const cursor = doc.indexOf("Target note") + 3;
    const view = makePointerView(doc, cursor, options);

    pressLink(view);

    expect(navigate).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe(doc);
    expect(view.contentDOM.getAttribute("contenteditable")).toBe("true");
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
  it("follows the cursor link through the registered Enter binding", () => {
    const registry = createAppRegistry();
    const navigate = vi.fn();
    const options = navigationOptions({ navigate });
    const doc = "Before [[Target note]] after";
    let view: EditorView;
    const commandContext = (): CommandContext => ({
      view,
      openNote: () => Promise.resolve(),
      openView: () => {},
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

    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    });
    view.contentDOM.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ path: "Target note.md" });
    expect(view.state.doc.toString()).toBe(doc);
  });
});

describe("note addressing and desktop history", () => {
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
    const navigator = createNoteNavigator({ mode: "desktop", load });

    await navigator.start(first);
    await navigator.open(second);
    expect(navigator.state()).toMatchObject({
      address: second,
      canGoBack: true,
      canGoForward: false,
    });

    expect(navigator.back()).toBe(true);
    await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith(first));
    expect(navigator.state()).toMatchObject({
      address: first,
      canGoBack: false,
      canGoForward: true,
    });

    expect(navigator.forward()).toBe(true);
    await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith(second));
    expect(navigator.state()).toMatchObject({
      address: second,
      canGoBack: true,
      canGoForward: false,
    });
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
    await vi.waitFor(() => expect(load).toHaveBeenLastCalledWith(first));
    expect(new URL(window.location.href).searchParams.get("note")).toBe(
      "first.md",
    );
    navigator.dispose();
    window.history.replaceState({}, "", "/");
  });
});
