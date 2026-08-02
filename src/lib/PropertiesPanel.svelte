<script lang="ts">
import type { Frontmatter, FrontmatterEntry } from "./editor/frontmatter";
import { STRINGS } from "./strings";

let {
  frontmatter,
  onEditValue,
  noteIdentity = null,
  expanded = $bindable(false),
}: {
  frontmatter: Frontmatter;
  /**
   * Replaces exactly the character range `[from, to)` of the document with
   * `insert`. The panel never touches any other byte; edits flow through
   * the editor's normal change-set save path.
   */
  onEditValue: (from: number, to: number, insert: string) => void;
  noteIdentity?: string | null;
  /** Controlled expansion state owned by the note view-state record. */
  expanded?: boolean;
} = $props();

const panelContentId = "skr-properties-content";

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

<section class="skr-properties" aria-label={STRINGS.propertiesPanelLabel}>
  <div class="skr-properties-header">
    <button
      type="button"
      class="skr-properties-toggle"
      aria-expanded={expanded}
      aria-controls={panelContentId}
      aria-label={expanded
        ? STRINGS.propertiesCollapse
        : STRINGS.propertiesExpand}
      onclick={() => (expanded = !expanded)}
    >
      <span class="skr-properties-chevron" aria-hidden="true"></span>
      <span>{STRINGS.propertiesPanelTitle}</span>
      {#if noteIdentity !== null}
        <span class="skr-properties-path">{noteIdentity}</span>
      {/if}
      <span class="skr-properties-count">{frontmatter.entries.length}</span>
    </button>
  </div>

  <div class:expanded class="skr-properties-reveal">
    <div
      id={panelContentId}
      class="skr-properties-content"
      aria-hidden={!expanded}
      inert={!expanded}
    >
      <dl class="skr-properties-list">
        {#each frontmatter.entries as entry, index (index)}
          <dt>{entry.key}</dt>
          <dd>
            {#if entry.type === "boolean"}
              <input
                type="checkbox"
                checked={entry.raw === "true"}
                onchange={(event) => commitBoolean(entry, inputChecked(event))}
              />
            {:else if entry.type === "number"}
              <input
                type="number"
                class="skr-property-number"
                value={entry.raw}
                step="any"
                onchange={(event) => commitScalar(entry, inputValue(event))}
              />
            {:else if entry.type === "date" && editsAsDateInput(entry)}
              <input
                type="date"
                value={entry.raw}
                onchange={(event) => commitScalar(entry, inputValue(event))}
              />
            {:else if entry.type === "list" && entry.items !== undefined}
              <ul>
                {#each entry.items as item, itemIndex (itemIndex)}
                  <li>
                    <input
                      type="text"
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
                value={entry.raw}
                onchange={(event) => commitScalar(entry, inputValue(event))}
              />
            {/if}
          </dd>
        {/each}
      </dl>
    </div>
  </div>
</section>

<style>
  .skr-properties {
    flex: none;
    border-bottom: 1px solid var(--skr-border);
    background: var(--skr-surface-subtle);
    color: var(--skr-text);
    font-family: var(--skr-font-interface);
  }

  .skr-properties-header {
    display: flex;
    justify-content: center;
    min-height: 2.75rem;
    background: var(--skr-surface);
  }

  .skr-properties-toggle {
    display: flex;
    align-items: center;
    gap: 0.65rem;
    width: min(
      100%,
      calc(var(--skr-editor-measure, 72) * 1ch + 2 * var(--skr-gutter))
    );
    padding: 0.65rem var(--skr-gutter);
    border: 0;
    background: transparent;
    color: var(--skr-text);
    font: inherit;
    font-size: 0.82rem;
    font-weight: 600;
    letter-spacing: 0.02em;
    text-align: left;
    cursor: pointer;
  }

  .skr-properties-toggle:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--skr-focus);
    outline-offset: 2px;
  }

  .skr-properties-chevron {
    width: 0.45rem;
    height: 0.45rem;
    border-right: 1.5px solid var(--skr-text-muted);
    border-bottom: 1.5px solid var(--skr-text-muted);
    transform: rotate(-45deg);
  }

  .skr-properties-toggle[aria-expanded="true"] .skr-properties-chevron {
    transform: rotate(45deg) translateY(-0.1rem);
  }

  .skr-properties-count {
    display: inline-grid;
    min-width: 1.5rem;
    min-height: 1.5rem;
    place-items: center;
    border: 1px solid var(--skr-border);
    border-radius: 999px;
    color: var(--skr-text-muted);
    font-size: 0.72rem;
    font-weight: 600;
  }

  .skr-properties-path {
    min-width: 0;
    overflow: hidden;
    color: var(--skr-text-muted);
    font-family: var(--skr-font-mono);
    font-size: 0.72rem;
    font-weight: 400;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .skr-properties-reveal {
    display: grid;
    grid-template-rows: 0fr;
  }

  .skr-properties-reveal.expanded {
    grid-template-rows: 1fr;
  }

  .skr-properties-content {
    min-height: 0;
    overflow: hidden;
  }

  .skr-properties-list {
    width: min(
      100%,
      calc(var(--skr-editor-measure, 72) * 1ch + 2 * var(--skr-gutter))
    );
    box-sizing: border-box;
    margin-inline: auto;
    padding-inline: var(--skr-gutter);
  }

  .skr-properties-list {
    display: grid;
    grid-template-columns: minmax(7rem, max-content) minmax(10rem, 1fr);
    gap: 0.55rem 1rem;
    margin-block: 0;
    padding-top: 0.75rem;
    padding-bottom: 1rem;
    font-size: 0.8rem;
  }

  dt {
    align-self: center;
    color: var(--skr-text-muted);
    font-weight: 600;
  }

  dd {
    min-width: 0;
    margin: 0;
  }

  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  input:not([type="checkbox"]) {
    box-sizing: border-box;
    max-width: 100%;
    min-height: 1.85rem;
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--skr-border);
    border-radius: 0.35rem;
    background: var(--skr-surface);
    color: var(--skr-text);
    font: inherit;
  }

  dd > input[type="text"] {
    width: 100%;
  }

  .skr-property-number {
    width: 8rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .skr-properties-chevron,
    .skr-properties-reveal {
      transition: none;
    }
  }

  @media (max-width: 60rem) {
    .skr-properties-toggle,
    input {
      min-height: 2.75rem;
    }

    .skr-properties-list {
      grid-template-columns: 1fr;
      gap: 0.25rem;
    }

    dd input[type="checkbox"] {
      width: 2.75rem;
      min-width: 2.75rem;
    }

    dd {
      margin-bottom: 0.5rem;
    }
  }
</style>
