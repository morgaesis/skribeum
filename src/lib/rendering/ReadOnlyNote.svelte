<script lang="ts">
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { onMount, untrack } from "svelte";
import {
  dispatchWikilinkContext,
  readOnlyDecorationMode,
} from "../editor/decorations/engine";
import type { WikilinkResolutionContext } from "../editor/decorations/wikilinks";
import { parseFrontmatter } from "../editor/frontmatter";
import { noteRenderingExtensions } from "../editor/syntaxPolicy";
import { DEFAULT_TASK_STATUSES, type TaskStatus } from "../taskStatuses";

let {
  source,
  label,
  context,
  taskStatuses = DEFAULT_TASK_STATUSES,
}: {
  source: string;
  label: string;
  context?: WikilinkResolutionContext | undefined;
  taskStatuses?: readonly TaskStatus[];
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

function stateFor(
  markdown: string,
  linkContext: WikilinkResolutionContext | undefined,
): EditorState {
  const body = visibleSource(markdown);
  return EditorState.create({
    doc: body,
    extensions: [
      ...noteRenderingExtensions(body, linkContext, taskStatuses),
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
  view = new EditorView({ state: stateFor(source, context), parent: host });
  return () => view?.destroy();
});

// A document or task-status change rebuilds the editor state outright; both
// are baked into the extension set at creation. The wikilink context is
// read through `untrack` here so an unrelated pane's navigation, which
// gives this component a freshly identical context object on every
// re-render, does not itself trigger a rebuild: rebuilding tears down and
// recreates every decoration, including a rendered Mermaid diagram, which
// is the flicker this split avoids.
$effect(() => {
  const nextSource = source;
  const nextTaskStatuses = taskStatuses;
  void nextTaskStatuses;
  if (view !== undefined) {
    view.setState(
      stateFor(
        nextSource,
        untrack(() => context),
      ),
    );
  }
});

// Wikilink resolution context changes (a tree refresh, a config edit) push
// through the live state field instead, the same incremental path the
// editable editor uses, so decorations that did not change keep their DOM.
$effect(() => {
  const nextContext = context;
  if (view !== undefined && nextContext !== undefined) {
    dispatchWikilinkContext(view, nextContext);
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
