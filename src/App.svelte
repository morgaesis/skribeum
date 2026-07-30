<script lang="ts">
import Editor from "./lib/Editor.svelte";
import { M0_FIXTURE } from "./lib/fixture";
</script>

<main class="h-screen overflow-hidden">
  <Editor doc={M0_FIXTURE} />
</main>
