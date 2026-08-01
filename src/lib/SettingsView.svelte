<script lang="ts">
import type { SettingsState } from "./features/settingsStore";
import type { SettingsDocument } from "./ipc/services";
import { STRINGS } from "./strings";
import type { TaskStatus, TaskStatusCategory } from "./taskStatuses";
import {
  type DarkPaletteName,
  isThemeName,
  type LightPaletteName,
  type ThemeName,
} from "./themes/theme";

let {
  settings,
  onUpdate,
  onClose,
}: {
  settings: SettingsState;
  onUpdate: (patch: Partial<SettingsDocument>) => void;
  onClose: () => void;
} = $props();

let dialogElement = $state<HTMLElement | undefined>();
let selectedTheme = $state<ThemeName>("system");

const LIGHT_PALETTES: readonly {
  id: LightPaletteName;
  label: string;
}[] = [
  { id: "manuscript", label: STRINGS.settingsPaletteManuscript },
  { id: "studio", label: STRINGS.settingsPaletteStudio },
  { id: "gazette", label: STRINGS.settingsPaletteGazette },
];
const DARK_PALETTES: readonly {
  id: DarkPaletteName;
  label: string;
}[] = [
  { id: "lamplight", label: STRINGS.settingsPaletteLamplight },
  { id: "graphite", label: STRINGS.settingsPaletteGraphite },
  { id: "signal", label: STRINGS.settingsPaletteSignal },
];

const TASK_STATUS_CATEGORIES: readonly TaskStatusCategory[] = [
  "TODO",
  "IN_PROGRESS",
  "ON_HOLD",
  "DONE",
  "CANCELLED",
  "NON_TASK",
];
const TASK_COLOR_TOKENS = [
  "--skr-accent",
  "--skr-text-muted",
  "--skr-warning",
  "--skr-success",
  "--skr-danger",
  "--skr-callout-blue",
  "--skr-callout-cyan",
  "--skr-callout-green",
  "--skr-callout-yellow",
  "--skr-callout-orange",
  "--skr-callout-red",
  "--skr-callout-purple",
  "--skr-callout-gray",
] as const;
const NEW_STATUS_SYMBOLS: readonly string[] = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  ..."*=_%^$#;:,.|(){}",
];
const COLOR_TOKEN_PATTERN = /^--skr-[a-z0-9]+(?:-[a-z0-9]+)*$/u;

$effect(() => {
  if (isThemeName(settings.document.theme)) {
    selectedTheme = settings.document.theme;
  }
});

$effect(() => {
  dialogElement?.querySelector("select")?.focus();
});

function numberFrom(event: Event): number | null {
  const value = Number((event.currentTarget as HTMLInputElement).value);
  return Number.isFinite(value) ? value : null;
}

function inputValue(event: Event): string {
  return (event.currentTarget as HTMLInputElement | HTMLSelectElement).value;
}

function oneSourceCharacter(value: string): boolean {
  return (
    [...value].length === 1 &&
    value !== "[" &&
    value !== "]" &&
    (value === " " || !/[\p{Cc}]/u.test(value))
  );
}

function saveTaskStatuses(statuses: readonly TaskStatus[]) {
  onUpdate({ task_statuses: statuses.map((status) => ({ ...status })) });
}

function updateTaskStatus(index: number, patch: Partial<TaskStatus>) {
  saveTaskStatuses(
    settings.document.task_statuses.map((status, statusIndex) =>
      statusIndex === index ? { ...status, ...patch } : status,
    ),
  );
}

function changeTaskSymbol(index: number, nextSymbol: string) {
  const statuses = settings.document.task_statuses;
  const previousSymbol = statuses[index]?.symbol;
  if (
    previousSymbol === undefined ||
    !oneSourceCharacter(nextSymbol) ||
    statuses.some(
      (status, statusIndex) =>
        statusIndex !== index && status.symbol === nextSymbol,
    )
  ) {
    return;
  }
  saveTaskStatuses(
    statuses.map((status, statusIndex) => ({
      ...status,
      symbol: statusIndex === index ? nextSymbol : status.symbol,
      next_status:
        status.next_status === previousSymbol ? nextSymbol : status.next_status,
    })),
  );
}

function moveTaskStatus(index: number, offset: -1 | 1) {
  const target = index + offset;
  const statuses = settings.document.task_statuses.map((status) => ({
    ...status,
  }));
  if (target < 0 || target >= statuses.length) {
    return;
  }
  const current = statuses[index];
  const adjacent = statuses[target];
  if (current === undefined || adjacent === undefined) {
    return;
  }
  statuses[index] = adjacent;
  statuses[target] = current;
  saveTaskStatuses(statuses);
}

function removeTaskStatus(index: number) {
  const statuses = settings.document.task_statuses;
  if (statuses.length <= 1) {
    return;
  }
  const removed = statuses[index];
  if (removed === undefined) {
    return;
  }
  const remaining = statuses.filter((_, statusIndex) => statusIndex !== index);
  const fallback = remaining[Math.min(index, remaining.length - 1)]?.symbol;
  if (fallback === undefined) {
    return;
  }
  saveTaskStatuses(
    remaining.map((status) => ({
      ...status,
      next_status:
        status.next_status === removed.symbol ? fallback : status.next_status,
    })),
  );
}

function availableNewStatusSymbol(): string | null {
  const used = new Set(
    settings.document.task_statuses.map((status) => status.symbol),
  );
  return NEW_STATUS_SYMBOLS.find((symbol) => !used.has(symbol)) ?? null;
}

function addTaskStatus() {
  const symbol = availableNewStatusSymbol();
  const first = settings.document.task_statuses[0];
  if (symbol === null || first === undefined) {
    return;
  }
  saveTaskStatuses([
    ...settings.document.task_statuses,
    {
      symbol,
      name: STRINGS.settingsTaskNewName,
      category: "TODO",
      glyph: "•",
      color_token: "--skr-accent",
      next_status: first.symbol,
    },
  ]);
}

function symbolLabel(symbol: string): string {
  return symbol === " " ? STRINGS.settingsTaskSpace : symbol;
}

// registry-exempt keydown: ARIA dialog pattern internal dismissal
// (Escape closes the dialog), scoped to this widget; the chord that
// opens settings is a registry keybinding.
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    onClose();
  }
}

$effect(() => {
  if (isThemeName(selectedTheme) && selectedTheme !== settings.document.theme) {
    onUpdate({ theme: selectedTheme });
  }
});
</script>

<div
  class="skr-overlay fixed inset-0 z-40 flex items-start justify-center pt-24"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }}
>
  <div
    bind:this={dialogElement}
    class="max-h-[calc(100vh-8rem)] w-[64rem] max-w-[94vw] overflow-y-auto rounded-lg border p-4"
    role="dialog"
    aria-modal="true"
    aria-label={STRINGS.settingsLabel}
    tabindex="-1"
    data-testid="settings-view"
    onkeydown={onKeydown}
  >
    <div class="mb-3 flex items-center justify-between">
      <h2 class="m-0 text-sm font-semibold">{STRINGS.settingsLabel}</h2>
      <button
        type="button"
        class="skr-control rounded border px-2 py-0.5 text-sm"
        onclick={onClose}
      >
        {STRINGS.closeAction}
      </button>
    </div>

    {#if settings.error !== null}
      <p class="skr-error mb-3 rounded border px-2 py-1 text-xs" role="alert">
        {settings.loaded ? STRINGS.settingsWriteFailed : STRINGS.settingsReadFailed}:
        {settings.error}
      </p>
    {/if}

    <div class="flex flex-col gap-3 text-sm">
      <label class="flex items-center justify-between gap-3">
        <span>{STRINGS.settingsTheme}</span>
        <select
          class="skr-control rounded border px-2 py-1"
          bind:value={selectedTheme}
          data-testid="settings-theme"
        >
          <option value="system">{STRINGS.settingsThemeSystem}</option>
          <option value="light">{STRINGS.settingsThemeLight}</option>
          <option value="dark">{STRINGS.settingsThemeDark}</option>
        </select>
      </label>

      <fieldset class="skr-palette-fieldset">
        <legend>{STRINGS.settingsLightPalette}</legend>
        <div class="skr-palette-options">
          {#each LIGHT_PALETTES as palette}
            <button
              type="button"
              class="skr-palette-card"
              class:skr-palette-card-active={settings.document.light_palette === palette.id}
              aria-pressed={settings.document.light_palette === palette.id}
              data-testid={`settings-light-palette-${palette.id}`}
              onclick={() => onUpdate({ light_palette: palette.id })}
            >
              <span class="skr-palette-swatch" data-palette={palette.id} aria-hidden="true">
                <span class="skr-palette-line"></span>
                <span class="skr-palette-dot"></span>
              </span>
              <span>{palette.label}</span>
            </button>
          {/each}
        </div>
      </fieldset>

      <fieldset class="skr-palette-fieldset">
        <legend>{STRINGS.settingsDarkPalette}</legend>
        <div class="skr-palette-options">
          {#each DARK_PALETTES as palette}
            <button
              type="button"
              class="skr-palette-card"
              class:skr-palette-card-active={settings.document.dark_palette === palette.id}
              aria-pressed={settings.document.dark_palette === palette.id}
              data-testid={`settings-dark-palette-${palette.id}`}
              onclick={() => onUpdate({ dark_palette: palette.id })}
            >
              <span class="skr-palette-swatch" data-palette={palette.id} aria-hidden="true">
                <span class="skr-palette-line"></span>
                <span class="skr-palette-dot"></span>
              </span>
              <span>{palette.label}</span>
            </button>
          {/each}
        </div>
      </fieldset>

      <label class="flex items-center justify-between gap-3">
        <span>{STRINGS.settingsFontSize}</span>
        <input
          type="number"
          min="8"
          max="40"
          class="skr-control w-24 rounded border px-2 py-1"
          value={settings.document.editor_font_size}
          data-testid="settings-font-size"
          onchange={(event) => {
            const value = numberFrom(event);
            if (value !== null && value >= 8 && value <= 40) {
              onUpdate({ editor_font_size: value });
            }
          }}
        />
      </label>

      <label class="flex items-center justify-between gap-3">
        <span>{STRINGS.settingsReadingMeasure}</span>
        <span class="flex items-center gap-2">
          <input
            type="number"
            min="45"
            max="120"
            class="skr-settings-input w-24 rounded border px-2 py-1"
            value={settings.document.editor_reading_measure}
            data-testid="settings-reading-measure"
            onchange={(event) => {
              const value = numberFrom(event);
              if (value !== null && value >= 45 && value <= 120) {
                onUpdate({ editor_reading_measure: value });
              }
            }}
          />
          <span class="skr-settings-unit text-xs">
            {STRINGS.settingsReadingMeasureUnit}
          </span>
        </span>
      </label>

      <label class="flex items-center justify-between gap-3">
        <span>{STRINGS.settingsSearchLimit}</span>
        <input
          type="number"
          min="1"
          max="500"
          class="skr-control w-24 rounded border px-2 py-1"
          value={settings.document.search_result_limit}
          data-testid="settings-search-limit"
          onchange={(event) => {
            const value = numberFrom(event);
            if (value !== null && value >= 1 && value <= 500) {
              onUpdate({ search_result_limit: value });
            }
          }}
        />
      </label>

      <label class="flex items-start justify-between gap-3">
        <span>
          <span class="block">{STRINGS.settingsLinkPreviews}</span>
          <span class="skr-settings-help block text-xs">
            {STRINGS.settingsLinkPreviewsHint}
          </span>
        </span>
        <input
          type="checkbox"
          checked={settings.document.link_previews}
          data-testid="settings-link-previews"
          onchange={(event) => {
            onUpdate({
              link_previews: (event.currentTarget as HTMLInputElement).checked,
            });
          }}
        />
      </label>

      <section class="mt-2 border-t pt-3" aria-labelledby="task-statuses-title">
        <div class="mb-2 flex items-start justify-between gap-3">
          <div>
            <h3 id="task-statuses-title" class="m-0 text-sm font-semibold">
              {STRINGS.settingsTaskStatuses}
            </h3>
            <p class="skr-settings-help m-0 mt-1 text-xs">
              {STRINGS.settingsTaskStatusesHelp}
            </p>
          </div>
          <button
            type="button"
            class="skr-control shrink-0 rounded border px-2 py-1 text-xs"
            disabled={availableNewStatusSymbol() === null}
            onclick={addTaskStatus}
            data-testid="task-status-add"
          >
            {STRINGS.settingsTaskAdd}
          </button>
        </div>

        <datalist id="task-color-tokens">
          {#each TASK_COLOR_TOKENS as token}
            <option value={token}></option>
          {/each}
        </datalist>

        <div class="skr-task-status-table overflow-x-auto">
          <div class="skr-task-status-row skr-task-status-header text-xs font-semibold" aria-hidden="true">
            <span>{STRINGS.settingsTaskSymbol}</span>
            <span>{STRINGS.settingsTaskName}</span>
            <span>{STRINGS.settingsTaskCategory}</span>
            <span>{STRINGS.settingsTaskGlyph}</span>
            <span>{STRINGS.settingsTaskColor}</span>
            <span>{STRINGS.settingsTaskNext}</span>
            <span></span>
          </div>
          {#each settings.document.task_statuses as status, index (status.symbol)}
            <div
              class="skr-task-status-row py-1"
              role="group"
              aria-label={status.name}
              data-testid="task-status-row"
            >
              <input
                class="skr-control min-w-0 rounded border px-2 py-1"
                value={status.symbol}
                maxlength="2"
                aria-label={`${STRINGS.settingsTaskSymbol}: ${status.name}`}
                onchange={(event) => changeTaskSymbol(index, inputValue(event))}
                data-testid="task-status-symbol"
              />
              <input
                class="skr-control min-w-0 rounded border px-2 py-1"
                value={status.name}
                maxlength="80"
                aria-label={`${STRINGS.settingsTaskName}: ${status.name}`}
                onchange={(event) => {
                  const name = inputValue(event).trim();
                  if (name.length > 0 && [...name].length <= 80) {
                    updateTaskStatus(index, { name });
                  }
                }}
                data-testid="task-status-name"
              />
              <select
                class="skr-control min-w-0 rounded border px-1 py-1"
                value={status.category}
                aria-label={`${STRINGS.settingsTaskCategory}: ${status.name}`}
                onchange={(event) =>
                  updateTaskStatus(index, {
                    category: inputValue(event) as TaskStatusCategory,
                  })}
                data-testid="task-status-category"
              >
                {#each TASK_STATUS_CATEGORIES as category}
                  <option value={category}>{category}</option>
                {/each}
              </select>
              <input
                class="skr-control min-w-0 rounded border px-2 py-1"
                value={status.glyph}
                maxlength="8"
                aria-label={`${STRINGS.settingsTaskGlyph}: ${status.name}`}
                onchange={(event) => {
                  const glyph = inputValue(event);
                  if (
                    [...glyph].length > 0 &&
                    [...glyph].length <= 8 &&
                    !/[\p{Cc}]/u.test(glyph)
                  ) {
                    updateTaskStatus(index, { glyph });
                  }
                }}
                data-testid="task-status-glyph"
              />
              <input
                class="skr-control min-w-0 rounded border px-2 py-1 font-mono text-xs"
                value={status.color_token}
                list="task-color-tokens"
                aria-label={`${STRINGS.settingsTaskColor}: ${status.name}`}
                onchange={(event) => {
                  const color_token = inputValue(event);
                  if (COLOR_TOKEN_PATTERN.test(color_token)) {
                    updateTaskStatus(index, { color_token });
                  }
                }}
                data-testid="task-status-color"
              />
              <select
                class="skr-control min-w-0 rounded border px-1 py-1"
                value={status.next_status}
                aria-label={`${STRINGS.settingsTaskNext}: ${status.name}`}
                onchange={(event) =>
                  updateTaskStatus(index, { next_status: inputValue(event) })}
                data-testid="task-status-next"
              >
                {#each settings.document.task_statuses as target}
                  <option value={target.symbol}>
                    {symbolLabel(target.symbol)}: {target.name}
                  </option>
                {/each}
              </select>
              <span class="flex justify-end gap-1">
                <button
                  type="button"
                  class="skr-control rounded border px-1.5 py-1"
                  disabled={index === 0}
                  aria-label={`${STRINGS.settingsTaskMoveUp}: ${status.name}`}
                  onclick={() => moveTaskStatus(index, -1)}
                >↑</button>
                <button
                  type="button"
                  class="skr-control rounded border px-1.5 py-1"
                  disabled={index === settings.document.task_statuses.length - 1}
                  aria-label={`${STRINGS.settingsTaskMoveDown}: ${status.name}`}
                  onclick={() => moveTaskStatus(index, 1)}
                >↓</button>
                <button
                  type="button"
                  class="skr-control rounded border px-1.5 py-1"
                  disabled={settings.document.task_statuses.length <= 1}
                  aria-label={`${STRINGS.settingsTaskRemove}: ${status.name}`}
                  onclick={() => removeTaskStatus(index)}
                >×</button>
              </span>
            </div>
          {/each}
        </div>
      </section>
    </div>
  </div>
</div>

<style>
  .skr-palette-fieldset {
    margin: 0;
    border: 0;
    padding: 0;
  }

  .skr-palette-fieldset legend {
    margin-bottom: 0.375rem;
  }

  .skr-palette-options {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 7rem));
    gap: 0.5rem;
  }

  .skr-palette-card {
    display: grid;
    gap: 0.375rem;
    border: 1px solid var(--skr-border-strong);
    border-radius: 0.5rem;
    padding: 0.375rem;
    color: var(--skr-text);
    background: var(--skr-surface);
    cursor: pointer;
    font-size: 0.75rem;
    text-align: left;
  }

  .skr-palette-card-active {
    border: 2px solid var(--skr-accent);
    padding: calc(0.375rem - 1px);
  }

  .skr-palette-swatch {
    position: relative;
    display: block;
    height: 2.5rem;
    border: 1px solid var(--skr-border-strong, var(--skr-border));
    border-radius: 0.3rem;
    background: var(--skr-surface);
  }

  .skr-palette-line {
    position: absolute;
    top: 0.75rem;
    right: 0.75rem;
    left: 0.75rem;
    height: 0.2rem;
    border-radius: 1rem;
    background: var(--skr-text);
  }

  .skr-palette-dot {
    position: absolute;
    right: 0.75rem;
    bottom: 0.55rem;
    width: 0.55rem;
    height: 0.55rem;
    border-radius: 50%;
    background: var(--skr-accent);
  }

  .skr-settings-input {
    border-color: var(--skr-border);
    background: var(--skr-surface);
    color: var(--skr-text);
    caret-color: var(--skr-caret);
  }

  .skr-settings-unit {
    color: var(--skr-text-muted);
  }

  .skr-settings-help,
  .skr-task-status-header {
    color: var(--skr-text-muted);
  }

  .skr-task-status-table {
    border: 1px solid var(--skr-border);
    border-radius: 0.375rem;
  }

  .skr-task-status-row {
    display: grid;
    grid-template-columns:
      4rem minmax(9rem, 1.2fr) 8.5rem 4.5rem minmax(10rem, 1fr)
      minmax(10rem, 1fr) 8rem;
    gap: 0.375rem;
    min-width: 56rem;
    padding-inline: 0.375rem;
    align-items: center;
  }

  .skr-task-status-row + .skr-task-status-row {
    border-top: 1px solid var(--skr-border);
  }

  .skr-task-status-header {
    padding-block: 0.375rem;
    background: var(--skr-surface-subtle);
  }
</style>
