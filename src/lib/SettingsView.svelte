<script lang="ts">
import type { SettingsState } from "./features/settingsStore";
import type { SettingsDocument } from "./ipc/services";
import { STRINGS } from "./strings";

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

$effect(() => {
  dialogElement?.querySelector("select")?.focus();
});

function numberFrom(event: Event): number | null {
  const value = Number((event.currentTarget as HTMLInputElement).value);
  return Number.isFinite(value) ? value : null;
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
</script>

<div
  class="fixed inset-0 z-40 flex items-start justify-center bg-black/20 pt-24"
  role="presentation"
  onclick={(event) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }}
>
  <div
    bind:this={dialogElement}
    class="w-[28rem] max-w-[90vw] rounded-lg border border-gray-300 bg-white p-4 shadow-xl"
    role="dialog"
    aria-label={STRINGS.settingsLabel}
    tabindex="-1"
    data-testid="settings-view"
    onkeydown={onKeydown}
  >
    <header class="mb-3 flex items-center justify-between">
      <h2 class="m-0 text-sm font-semibold">{STRINGS.settingsLabel}</h2>
      <button
        type="button"
        class="rounded border border-gray-300 px-2 py-0.5 text-sm outline-offset-1 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-blue-500"
        onclick={onClose}
      >
        {STRINGS.closeAction}
      </button>
    </header>

    {#if settings.error !== null}
      <p class="mb-3 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs" role="alert">
        {settings.loaded ? STRINGS.settingsWriteFailed : STRINGS.settingsReadFailed}:
        {settings.error}
      </p>
    {/if}

    <div class="flex flex-col gap-3 text-sm">
      <label class="flex items-center justify-between gap-3">
        <span>{STRINGS.settingsTheme}</span>
        <select
          class="rounded border border-gray-300 px-2 py-1"
          value={settings.document.theme}
          onchange={(event) => {
            onUpdate({ theme: (event.currentTarget as HTMLSelectElement).value });
          }}
        >
          <option value="system">{STRINGS.settingsThemeSystem}</option>
          <option value="light">{STRINGS.settingsThemeLight}</option>
          <option value="dark">{STRINGS.settingsThemeDark}</option>
        </select>
      </label>

      <label class="flex items-center justify-between gap-3">
        <span>{STRINGS.settingsFontSize}</span>
        <input
          type="number"
          min="8"
          max="40"
          class="w-24 rounded border border-gray-300 px-2 py-1"
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
        <span>{STRINGS.settingsSearchLimit}</span>
        <input
          type="number"
          min="1"
          max="500"
          class="w-24 rounded border border-gray-300 px-2 py-1"
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
    </div>
  </div>
</div>
