// Defect: with a split view, the unfocused pane's `ReadOnlyNote` rebuilt its
// whole editor state (tearing down every decoration, including a rendered
// Mermaid diagram) whenever App.svelte handed it a freshly identical
// wikilink-resolution-context object, which happens on any navigation
// anywhere in the app, not only in this pane. This test counts renders
// rather than looking at pixels, per the fix's own verification bar.

import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_WIKILINK_CONTEXT } from "../../src/lib/features/navigation";
import ReadOnlyNote from "../../src/lib/rendering/ReadOnlyNote.svelte";
import { reactiveState } from "./helpers/reactiveState.svelte";

vi.mock("../../src/lib/rendering/mermaid", () => ({
  renderMermaid: vi.fn(async (host: HTMLElement) => {
    host.textContent = "rendered diagram";
  }),
}));

const MERMAID_SOURCE = "```mermaid\ngraph TD\n  A --> B\n```\n";

describe("read-only note rendering stability", () => {
  it("does not re-render an unchanged Mermaid diagram when only the wikilink context object changes", async () => {
    const { renderMermaid } = await import("../../src/lib/rendering/mermaid");
    const props = reactiveState({
      source: MERMAID_SOURCE,
      label: "Note",
      context: { ...EMPTY_WIKILINK_CONTEXT, currentPath: "a.md" },
    });
    const component = mount(ReadOnlyNote, {
      target: document.body,
      props,
    });
    flushSync();
    await vi.waitFor(() =>
      expect(renderMermaid.mock.calls.length).toBeGreaterThan(0),
    );
    // Mounting settles at a small, fixed number of renders (the initial
    // build plus the state-field dispatch effect's own settle pass); the
    // defect under test is renders that keep accumulating afterward, so the
    // assertions below anchor to this baseline rather than assume 1.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const baseline = renderMermaid.mock.calls.length;

    // Simulate the unfocused pane receiving a brand-new context object on
    // every App-level re-render (an unrelated pane navigating elsewhere),
    // with the same effective shape it already had.
    for (let index = 0; index < 3; index += 1) {
      props.context = { ...EMPTY_WIKILINK_CONTEXT, currentPath: "a.md" };
      flushSync();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renderMermaid).toHaveBeenCalledTimes(baseline);

    // The document itself changing still rebuilds and re-renders.
    props.source = "```mermaid\ngraph TD\n  A --> C\n```\n";
    flushSync();
    await vi.waitFor(() =>
      expect(renderMermaid.mock.calls.length).toBeGreaterThan(baseline),
    );

    void unmount(component);
  });
});
