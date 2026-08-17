<script lang="ts">
// registry-exempt keydown: Enter and Escape inside an editable property
// value are ARIA textbox pattern internals (commit and cancel of the
// field being edited), not application commands.
import type { Frontmatter, FrontmatterEntry } from "./editor/frontmatter";
import { wikilinkValue } from "./editor/frontmatter";
import { STRINGS } from "./strings";

let {
  frontmatter,
  onEditValue,
  onAddProperty,
  onFollowWikilink,
  expanded = $bindable(false),
  adding = $bindable(false),
}: {
  frontmatter: Frontmatter;
  /**
   * Replaces exactly the character range `[from, to)` of the document with
   * `insert`. The panel never touches any other byte; edits flow through
   * the editor's normal change-set save path.
   */
  onEditValue: (from: number, to: number, insert: string) => void;
  /** Appends one `key: value` line before the closing fence. */
  onAddProperty?: (key: string, value: string) => void;
  /** Follows a wikilink-shaped property value. */
  onFollowWikilink?: (target: string) => void;
  /** Controlled expansion state owned by the note view-state record. */
  expanded?: boolean;
  /** Whether the add-property row is in its inline entry state. */
  adding?: boolean;
} = $props();

const panelContentId = "skr-properties-content";

let addKeyElement = $state<HTMLElement | null>();
let addValueElement = $state<HTMLElement | null>();
let addRowElement = $state<HTMLElement | null>();
// Tracked alongside the CSS :hover rule below (real pointer hover keeps
// working through :hover directly) so the reveal is also driven by an
// observable pointer event, matching the reveal pattern used elsewhere
// (App.svelte's sidebar header actions, the link preview).
let panelHovered = $state(false);

/**
 * Commits an edited scalar. When the cleaned text matches the authored
 * value nothing is written and the element's text resets, so the DOM a
 * contenteditable session rewrote never drifts from the document.
 */
function commitScalar(
  entry: FrontmatterEntry,
  element: EventTarget | null,
): void {
  const clean = elementText(element)
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (clean !== entry.raw) {
    onEditValue(entry.valueFrom, entry.valueTo, clean);
  } else if (element instanceof HTMLElement) {
    element.textContent = entry.raw;
  }
}

function commitBoolean(entry: FrontmatterEntry, checked: boolean) {
  const value = checked ? "true" : "false";
  if (value !== entry.raw) {
    onEditValue(entry.valueFrom, entry.valueTo, value);
  }
}

function commitListItem(
  item: { from: number; to: number; raw: string },
  element: EventTarget | null,
) {
  const clean = elementText(element)
    .replace(/[\r\n]+/g, " ")
    .trim();
  if (clean !== item.raw) {
    onEditValue(item.from, item.to, clean);
  } else if (element instanceof HTMLElement) {
    element.textContent = item.raw;
  }
}

function inputChecked(event: Event): boolean {
  return (event.currentTarget as HTMLInputElement).checked;
}

/**
 * Keyboard contract for an editable value: Enter commits by leaving the
 * field, Escape restores the authored text and leaves without a commit.
 */
function editableKeydown(event: KeyboardEvent, original: string) {
  const target = event.currentTarget as HTMLElement;
  if (event.key === "Enter") {
    event.preventDefault();
    target.blur();
  } else if (event.key === "Escape") {
    event.preventDefault();
    target.textContent = original;
    target.blur();
  }
}

function elementText(element: EventTarget | null): string {
  return element instanceof HTMLElement ? (element.textContent ?? "") : "";
}

/**
 * Native focus assignment for a click happens on mousedown, not click, and
 * a non-form contenteditable element does not reliably receive it in every
 * engine; focusing explicitly on mousedown (rather than the later click)
 * matches when the browser itself would assign focus, so it never fights
 * native caret placement.
 */
function focusEditable(event: MouseEvent) {
  if (event.currentTarget instanceof HTMLElement) {
    event.currentTarget.focus();
  }
}

$effect(() => {
  if (adding && addKeyElement instanceof HTMLElement) {
    addKeyElement.focus();
  }
});

function commitAddition() {
  if (!adding) return;
  const key = elementText(addKeyElement ?? null).trim();
  const value = elementText(addValueElement ?? null).trim();
  adding = false;
  if (key.length > 0) {
    onAddProperty?.(key, value);
  }
}

function cancelAddition() {
  adding = false;
}

function additionKeydown(event: KeyboardEvent, cell: "key" | "value") {
  if (event.key === "Escape") {
    event.preventDefault();
    cancelAddition();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (cell === "key") {
      addValueElement?.focus();
    } else {
      commitAddition();
    }
  }
}

function additionFocusout(event: FocusEvent) {
  const next = event.relatedTarget;
  if (
    addRowElement instanceof HTMLElement &&
    next instanceof Node &&
    addRowElement.contains(next)
  ) {
    return;
  }
  commitAddition();
}
</script>

<section
  class="skr-properties"
  class:skr-properties-hovered={panelHovered}
  aria-label={STRINGS.propertiesPanelLabel}
  onpointerenter={() => (panelHovered = true)}
  onpointerleave={() => (panelHovered = false)}
>
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
    <span class="skr-properties-leading" aria-hidden="true">
      <svg viewBox="0 0 16 16" class:skr-properties-chevron-open={expanded}>
        <path d="m5.5 3.5 4.5 4.5-4.5 4.5" />
      </svg>
    </span>
    <span class="skr-properties-title">{STRINGS.propertiesPanelTitle}</span>
    <span class="skr-properties-count">{frontmatter.entries.length}</span>
  </button>

  <div class:expanded class="skr-properties-reveal">
    <div
      id={panelContentId}
      class="skr-properties-content"
      aria-hidden={!expanded}
      inert={!expanded}
    >
      <div class="skr-properties-list">
        {#each frontmatter.entries as entry, index (index)}
          <div class="skr-property-row">
            <span class="skr-property-label" id={`skr-property-key-${index}`}>
              {entry.key}
            </span>
            <div class="skr-property-value">
              {#if entry.type === "boolean"}
                <span class="skr-property-checkbox">
                  <input
                    type="checkbox"
                    checked={entry.raw === "true"}
                    aria-labelledby={`skr-property-key-${index}`}
                    onchange={(event) =>
                      commitBoolean(entry, inputChecked(event))}
                  />
                  <span class="skr-property-check-glyph" aria-hidden="true">
                    ✓
                  </span>
                </span>
              {:else if entry.type === "list" && entry.items !== undefined}
                <ul class="skr-property-chips">
                  {#each entry.items as item, itemIndex (`${itemIndex}:${item.raw}`)}
                    <li>
                      <span
                        class="skr-property-editable skr-property-chip"
                        role="textbox"
                tabindex="0"
                        contenteditable="plaintext-only"
                        aria-label={`${entry.key} ${STRINGS.propertiesListItemLabel} ${itemIndex + 1}`}
                        onmousedown={focusEditable}
                        onkeydown={(event) => editableKeydown(event, item.raw)}
                        onblur={(event) =>
                          commitListItem(item, event.currentTarget)}
                        >{item.raw}</span
                      >
                    </li>
                  {/each}
                </ul>
              {:else if wikilinkValue(entry.raw) !== null}
                {@const link = wikilinkValue(entry.raw)}
                <button
                  type="button"
                  class="skr-property-wikilink"
                  data-wikilink-target={link?.target}
                  onclick={() =>
                    link !== null && onFollowWikilink?.(link.target)}
                >
                  {link?.label}
                </button>
              {:else}
                {#key entry.raw}
                  <span
                    class="skr-property-editable"
                    role="textbox"
                    tabindex="0"
                    contenteditable="plaintext-only"
                    aria-labelledby={`skr-property-key-${index}`}
                    data-property-key={entry.key}
                    onmousedown={focusEditable}
                    onkeydown={(event) => editableKeydown(event, entry.raw)}
                    onblur={(event) => commitScalar(entry, event.currentTarget)}
                    >{entry.raw}</span
                  >
                {/key}
              {/if}
            </div>
          </div>
        {/each}

        {#if adding}
          <div
            class="skr-property-row skr-property-add-row"
            bind:this={addRowElement}
            onfocusout={additionFocusout}
          >
            <span class="skr-property-label">
              <span
                class="skr-property-editable skr-property-add-key"
                role="textbox"
                tabindex="0"
                contenteditable="plaintext-only"
                aria-label={STRINGS.propertiesAddKeyLabel}
                bind:this={addKeyElement}
                onmousedown={focusEditable}
                onkeydown={(event) => additionKeydown(event, "key")}
              ></span>
            </span>
            <div class="skr-property-value">
              <span
                class="skr-property-editable"
                role="textbox"
                tabindex="0"
                contenteditable="plaintext-only"
                aria-label={STRINGS.propertiesAddValueLabel}
                bind:this={addValueElement}
                onmousedown={focusEditable}
                onkeydown={(event) => additionKeydown(event, "value")}
              ></span>
            </div>
          </div>
        {:else if onAddProperty !== undefined}
          <button
            type="button"
            class="skr-properties-add skr-btn-secondary"
            data-btn-role="secondary"
            onclick={() => (adding = true)}
          >
            {STRINGS.propertiesAddProperty}
          </button>
        {/if}
      </div>
    </div>
  </div>
</section>

<style>
  /* Section 4.15: flat panel at the note top inside the prose column. No
     card, no frame, no fill; a single hairline closes it. */
  .skr-properties {
    flex: none;
    border-bottom: 1px solid var(--skr-border);
    color: var(--skr-text);
    font-family: var(--skr-font-interface);
  }

  .skr-properties-toggle {
    display: flex;
    box-sizing: border-box;
    width: min(
      100%,
      calc(var(--skr-editor-measure, 72) * 1ch + 2 * var(--skr-gutter))
    );
    height: 1.75rem;
    align-items: center;
    gap: 0.375rem;
    margin-inline: auto;
    padding: 0 var(--skr-gutter);
    border: 0;
    background: transparent;
    color: var(--skr-text-muted);
    font-family: inherit;
    font-size: var(--skr-type-label);
    font-weight: 600;
    letter-spacing: 0.05em;
    line-height: 1.4;
    text-align: left;
    text-transform: uppercase;
    cursor: pointer;
  }

  .skr-properties-toggle:focus-visible,
  .skr-properties-add:focus-visible,
  .skr-property-wikilink:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--skr-focus);
    outline-offset: 2px;
  }

  .skr-properties-leading {
    display: inline-grid;
    width: 1rem;
    height: 1rem;
    flex: none;
    place-items: center;
  }

  .skr-properties-leading svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.25;
    /* Section 4.15: the chevron swap is instant. */
    transition: none;
  }

  .skr-properties-chevron-open {
    transform: rotate(90deg);
  }

  .skr-properties-count {
    font-weight: 400;
  }

  .skr-properties-reveal {
    display: grid;
    grid-template-rows: 0fr;
    transition: grid-template-rows var(--skr-motion-panel-duration)
      var(--skr-motion-panel-easing);
  }

  .skr-properties-reveal.expanded {
    grid-template-rows: 1fr;
  }

  .skr-properties-content {
    min-height: 0;
    overflow: hidden;
  }

  .skr-properties-list {
    display: flex;
    box-sizing: border-box;
    width: min(
      100%,
      calc(var(--skr-editor-measure, 72) * 1ch + 2 * var(--skr-gutter))
    );
    flex-direction: column;
    margin-inline: auto;
    padding-inline: var(--skr-gutter);
    padding-bottom: 0.25rem;
  }

  /* Section 4.15 rows: one property per 1.75rem line; a wrapped value
     grows its row and is never truncated. */
  .skr-property-row {
    display: grid;
    min-height: 1.75rem;
    align-items: start;
    grid-template-columns: 8rem minmax(0, 1fr);
  }

  .skr-property-label {
    overflow: hidden;
    width: 8rem;
    box-sizing: border-box;
    padding-right: 0.75rem;
    color: var(--skr-text-muted);
    font-size: var(--skr-type-control);
    line-height: 1.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .skr-property-value {
    display: flex;
    min-width: 0;
    align-items: center;
    font-size: var(--skr-type-control);
  }

  .skr-property-editable {
    overflow-wrap: anywhere;
    min-width: 1.5rem;
    /* The edit-state 1px bottom rule of section 5.12, reserved at rest so
       entering the edit state never moves text. */
    border-bottom: 1px solid transparent;
    color: var(--skr-text);
    outline: none;
    white-space: pre-wrap;
  }

  .skr-property-editable:focus {
    border-bottom-color: var(--skr-border-strong);
  }

  .skr-property-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .skr-property-chip {
    display: inline-block;
    border-radius: var(--skr-radius-control);
    padding: 0.0625rem 0.375rem;
    background: var(--skr-surface-subtle);
    font-size: 0.8125em;
  }

  .skr-property-wikilink {
    overflow-wrap: anywhere;
    margin: 0;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--skr-accent);
    font: inherit;
    text-align: left;
    text-decoration: underline;
    cursor: pointer;
  }

  .skr-property-checkbox {
    position: relative;
    display: inline-grid;
    width: 1em;
    height: 1em;
    place-items: center;
  }

  .skr-property-checkbox input {
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    margin: 0;
    appearance: none;
    border: 1.5px solid var(--skr-border-strong);
    border-radius: 3px;
    background: transparent;
    cursor: pointer;
  }

  .skr-property-checkbox input:checked {
    border-color: var(--skr-accent);
    background: var(--skr-accent);
  }

  .skr-property-check-glyph {
    position: absolute;
    color: var(--skr-surface);
    font-size: 0.78em;
    font-weight: 800;
    line-height: 1;
    opacity: 0;
    pointer-events: none;
  }

  .skr-property-checkbox input:checked + .skr-property-check-glyph {
    opacity: 1;
  }

  /* The ghost add row: revealed by panel hover or focus, never the only
     route (the registered command reaches the same flow). It carries the
     secondary labelled-button role (section 5.12) for fill and weight, with
     the row's own geometry overriding the role class's pill padding and
     centering so it still reads as a compact 4.15 row, not a button. */
  .skr-properties-add {
    display: flex;
    min-height: 1.75rem;
    align-items: center;
    justify-content: flex-start;
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--skr-text-muted);
    font-family: inherit;
    font-size: var(--skr-type-control);
    font-weight: 400;
    text-align: left;
    cursor: pointer;
    opacity: 0;
    transition: opacity var(--skr-motion-state-duration)
      var(--skr-motion-state-easing);
  }

  .skr-properties:hover .skr-properties-add,
  .skr-properties:focus-within .skr-properties-add,
  .skr-properties-hovered .skr-properties-add {
    opacity: 1;
  }

  .skr-property-add-key {
    display: inline-block;
    min-width: 4rem;
  }

  @media (max-width: 60rem) {
    /* Section 5.1: the toggle is instant when the pane cannot hold the
       measure and text would re-wrap. */
    .skr-properties-reveal {
      transition-duration: 0ms;
    }

    .skr-properties-toggle {
      height: 2.75rem;
    }

    .skr-property-row,
    .skr-properties-add {
      min-height: 2.75rem;
    }

    .skr-property-row {
      grid-template-columns: minmax(0, 1fr);
    }

    .skr-property-label {
      width: auto;
      padding-right: 0;
    }
  }
</style>
