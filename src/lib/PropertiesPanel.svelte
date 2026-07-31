<script lang="ts">
import type { Frontmatter, FrontmatterEntry } from "./editor/frontmatter";
import { STRINGS } from "./strings";

let {
  frontmatter,
  onEditValue,
}: {
  frontmatter: Frontmatter;
  /**
   * Replaces exactly the character range `[from, to)` of the document with
   * `insert`. The panel never touches any other byte; edits flow through
   * the editor's normal change-set save path.
   */
  onEditValue: (from: number, to: number, insert: string) => void;
} = $props();

function commitScalar(entry: FrontmatterEntry, value: string) {
  if (value !== entry.raw) {
    onEditValue(entry.valueFrom, entry.valueTo, value);
  }
}

function commitBoolean(entry: FrontmatterEntry, checked: boolean) {
  commitScalar(entry, checked ? "true" : "false");
}

function commitListItem(
  item: { from: number; to: number; raw: string },
  value: string,
) {
  if (value !== item.raw) {
    onEditValue(item.from, item.to, value);
  }
}

function inputValue(event: Event): string {
  return (event.currentTarget as HTMLInputElement).value;
}

function inputChecked(event: Event): boolean {
  return (event.currentTarget as HTMLInputElement).checked;
}

/** Scalar date inputs only accept the date part; time suffixes edit as text. */
function editsAsDateInput(entry: FrontmatterEntry): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(entry.raw);
}
</script>

<section
  class="border-b border-gray-200 bg-gray-50 px-3 py-2 text-xs"
  aria-label={STRINGS.propertiesPanelLabel}
>
  <dl class="m-0 grid grid-cols-[minmax(6rem,max-content)_1fr] gap-x-3 gap-y-1">
    {#each frontmatter.entries as entry, index (index)}
      <dt class="self-center font-medium text-gray-600">{entry.key}</dt>
      <dd class="m-0">
        {#if entry.type === "boolean"}
          <input
            type="checkbox"
            checked={entry.raw === "true"}
            onchange={(event) => commitBoolean(entry, inputChecked(event))}
          />
        {:else if entry.type === "number"}
          <input
            type="number"
            class="w-32 rounded border border-gray-300 px-1 py-0.5"
            value={entry.raw}
            step="any"
            onchange={(event) => commitScalar(entry, inputValue(event))}
          />
        {:else if entry.type === "date" && editsAsDateInput(entry)}
          <input
            type="date"
            class="rounded border border-gray-300 px-1 py-0.5"
            value={entry.raw}
            onchange={(event) => commitScalar(entry, inputValue(event))}
          />
        {:else if entry.type === "list" && entry.items !== undefined}
          <ul class="m-0 flex list-none flex-wrap gap-1 p-0">
            {#each entry.items as item, itemIndex (itemIndex)}
              <li>
                <input
                  type="text"
                  class="rounded border border-gray-300 px-1 py-0.5"
                  size={Math.max(item.raw.length, 4)}
                  value={item.raw}
                  aria-label={`${entry.key} ${STRINGS.propertiesListItemLabel} ${itemIndex + 1}`}
                  onchange={(event) => commitListItem(item, inputValue(event))}
                />
              </li>
            {/each}
          </ul>
        {:else}
          <input
            type="text"
            class="w-full rounded border border-gray-300 px-1 py-0.5"
            value={entry.raw}
            onchange={(event) => commitScalar(entry, inputValue(event))}
          />
        {/if}
      </dd>
    {/each}
  </dl>
</section>
