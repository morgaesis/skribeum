<script lang="ts">
import {
  type EditorStatistics,
  formatTimestamp,
} from "./features/noteStatistics";
import { STRINGS } from "./strings";

let {
  path,
  createdMs,
  modifiedMs,
  statistics,
}: {
  /** Vault-relative path of the open note. */
  path: string | null;
  /** Creation time in milliseconds since the epoch, when known. */
  createdMs: number | null;
  /** Modification time in milliseconds since the epoch, when known. */
  modifiedMs: number | null;
  /** Live document statistics; null when no editor is live. */
  statistics: EditorStatistics | null;
} = $props();

const rows = $derived([
  {
    label: STRINGS.noteInfoCreated,
    value:
      createdMs === null
        ? STRINGS.noteInfoUnavailable
        : formatTimestamp(createdMs),
  },
  {
    label: STRINGS.noteInfoModified,
    value:
      modifiedMs === null
        ? STRINGS.noteInfoUnavailable
        : formatTimestamp(modifiedMs),
  },
  {
    label: STRINGS.noteInfoPath,
    value: path ?? STRINGS.noteInfoUnavailable,
  },
  {
    label: STRINGS.noteInfoWords,
    value:
      statistics === null
        ? STRINGS.noteInfoUnavailable
        : statistics.words.toLocaleString("en"),
  },
  {
    label: STRINGS.noteInfoCharacters,
    value:
      statistics === null
        ? STRINGS.noteInfoUnavailable
        : statistics.characters.toLocaleString("en"),
  },
]);
</script>

<dl class="skr-note-info">
  {#each rows as row (row.label)}
    <dt>{row.label}</dt>
    <dd>{row.value}</dd>
  {/each}
</dl>

<style>
  .skr-note-info {
    display: grid;
    margin: 0;
    gap: 0.125rem 1rem;
    color: var(--skr-text);
    font-family: var(--skr-font-interface);
    font-size: var(--skr-type-control);
    grid-template-columns: max-content minmax(0, 1fr);
  }

  dt {
    color: var(--skr-text-muted);
  }

  dd {
    overflow-wrap: anywhere;
    margin: 0;
  }
</style>
