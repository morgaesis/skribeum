<script lang="ts">
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { onMount } from "svelte";

let { doc, readOnly = false }: { doc: string; readOnly?: boolean } = $props();

let host: HTMLDivElement;
let view: EditorView | undefined;

function stateFor(content: string, locked: boolean): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [
      markdown(),
      EditorView.lineWrapping,
      EditorState.readOnly.of(locked),
      EditorView.editable.of(!locked),
    ],
  });
}

onMount(() => {
  view = new EditorView({ state: stateFor(doc, readOnly), parent: host });
  return () => view?.destroy();
});

// Replace the whole editor state when another document is opened or the
// read-only flag flips. Editing arrives in a later milestone; browsing
// swaps documents wholesale.
$effect(() => {
  if (
    view !== undefined &&
    (view.state.doc.toString() !== doc ||
      view.state.facet(EditorState.readOnly) !== readOnly)
  ) {
    view.setState(stateFor(doc, readOnly));
  }
});
</script>

<div class="editor h-full" bind:this={host}></div>

<style>
  .editor :global(.cm-editor) {
    height: 100%;
    font-size: 0.95rem;
  }
  .editor :global(.cm-content) {
    font-family: ui-monospace, "Cascadia Code", "Source Code Pro", Menlo,
      Consolas, monospace;
  }
</style>
