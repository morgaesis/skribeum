<script lang="ts">
/**
 * A panel that fails the way a real one does: from inside an `$effect`,
 * during an update, after it has already rendered once.
 */
let { shouldFail }: { shouldFail: boolean } = $props();

$effect(() => {
  if (shouldFail) {
    throw new TypeError("Cannot read properties of null (reading 'style')");
  }
});
</script>

<div data-testid="panel">{shouldFail}</div>
