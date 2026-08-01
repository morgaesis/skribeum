<script lang="ts">
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { onMount } from "svelte";
import { readOnlyDecorationMode } from "../editor/decorations/engine";
import type { WikilinkResolutionContext } from "../editor/decorations/wikilinks";
import { parseFrontmatter } from "../editor/frontmatter";
import { noteRenderingExtensions } from "../editor/syntaxPolicy";

let {
  source,
  label,
  context,
}: {
  source: string;
  label: string;
  context?: WikilinkResolutionContext | undefined;
} = $props();

let host: HTMLDivElement;
let view: EditorView | undefined;

function visibleSource(markdown: string): string {
  const frontmatter = parseFrontmatter(markdown);
  if (frontmatter === null) {
    return markdown;
  }
  let bodyStart = frontmatter.to;
  if (markdown[bodyStart] === "\n") {
    bodyStart += 1;
  }
  return markdown.slice(bodyStart).replace(/^\n/u, "");
}

function stateFor(markdown: string): EditorState {
  const body = visibleSource(markdown);
  return EditorState.create({
    doc: body,
    extensions: [
      ...noteRenderingExtensions(body, context),
      readOnlyDecorationMode,
      EditorView.lineWrapping,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({
        "aria-label": label,
        tabindex: "-1",
      }),
    ],
  });
}

onMount(() => {
  view = new EditorView({ state: stateFor(source), parent: host });
  return () => view?.destroy();
});

$effect(() => {
  const nextSource = source;
  const nextContext = context;
  if (view !== undefined) {
    void nextContext;
    view.setState(stateFor(nextSource));
  }
});
</script>

<div class="read-only-note" bind:this={host}></div>

<style>
  .read-only-note :global(.cm-editor),
  .read-only-note :global(.cm-scroller) {
    background: transparent;
  }
  .read-only-note :global(.cm-scroller) {
    overflow: visible;
  }
  .read-only-note :global(.cm-content) {
    padding: 0;
    font-family: var(--skr-font-prose);
    line-height: 1.7;
  }
  .read-only-note :global(.cm-line.cm-skr-code-block) {
    font-family: var(--skr-font-mono);
    font-size: 0.875em;
    font-weight: 400;
    line-height: 1.6;
  }
</style>
