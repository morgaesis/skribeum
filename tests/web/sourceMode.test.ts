import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import Editor from "../../src/lib/Editor.svelte";
import { sourceRevealMode } from "../../src/lib/editor/decorations/engine";
import { noteSourceExtensions } from "../../src/lib/editor/syntaxPolicy";
import { DEFAULT_SETTINGS } from "../../src/lib/features/settingsStore";

const views: EditorView[] = [];

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
  }
  document.body.textContent = "";
});

describe("whole-note source presentation", () => {
  it.each([false, true])(
    "shows every source character when syntax reveal is %s",
    (syntaxReveal) => {
      const source = [
        "---",
        "title: Raw note",
        "---",
        "# Heading",
        "- [ ] task",
        "`code` and $math$",
        "![[embed]]",
      ].join("\n");
      const view = new EditorView({
        state: EditorState.create({
          doc: source,
          extensions: [
            noteSourceExtensions(source),
            sourceRevealMode(syntaxReveal),
          ],
        }),
        parent: document.body,
      });
      views.push(view);

      expect(view.state.doc.toString()).toBe(source);
      expect(
        [...view.contentDOM.querySelectorAll<HTMLElement>(".cm-line")]
          .map((line) => line.textContent ?? "")
          .join("\n"),
      ).toBe(source);
      expect(view.dom.querySelector(".cm-skr-task-checkbox")).toBeNull();
      expect(view.dom.querySelector(".cm-skr-math")).toBeNull();
      expect(view.dom.querySelector(".cm-skr-embed")).toBeNull();
      expect(
        view.dom.querySelector("[class*='cm-skr-frontmatter']"),
      ).toBeNull();
    },
  );

  it("suppresses invisible-character widgets while preserving their setting", async () => {
    const source = "# Raw note\nspace separated\n";
    const host = document.createElement("div");
    document.body.append(host);
    const component = mount(Editor, {
      target: host,
      props: {
        doc: source,
        sourceMode: true,
        settings: {
          ...DEFAULT_SETTINGS,
          show_invisible_characters: true,
        },
      },
    });
    flushSync();

    try {
      const view = component.getView();
      expect(view?.state.doc.toString()).toBe(source);
      expect(host.querySelector(".cm-skr-invisible-line-end")).toBeNull();
      expect(host.querySelector(".cm-skr-invisible-space")).toBeNull();
    } finally {
      await unmount(component);
      host.remove();
    }
  });
});
