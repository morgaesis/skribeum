<script lang="ts">
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { onMount } from "svelte";

let { doc }: { doc: string } = $props();

let host: HTMLDivElement;

onMount(() => {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: [markdown(), EditorView.lineWrapping],
    }),
    parent: host,
  });
  return () => view.destroy();
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
