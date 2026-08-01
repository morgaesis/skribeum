<script lang="ts">
import { onDestroy, tick } from "svelte";
import {
  DEFAULT_SETTINGS,
  type SettingsDocument,
  type SettingsState,
} from "./features/settingsStore";
import { describeUpdateState, type UpdateState } from "./features/updates";
import { STRINGS } from "./strings";
import {
  TASK_COLOR_TOKENS,
  type TaskStatus,
  type TaskStatusCategory,
  taskStatusDisplayName,
} from "./taskStatuses";
import type {
  CodeFontName,
  DarkPaletteName,
  LightPaletteName,
  ProseFontName,
  ThemeName,
} from "./themes/theme";

// registry-exempt keydown: ARIA dialog dismissal plus radio and segmented
// control navigation stays internal to the settings widget.

type IndentStyle = "spaces" | "tabs";
type AttachmentFolderMode = "vault" | "note" | "folder";
type UpdateChannel = "stable" | "beta";
type SearchScope = "titles" | "full-text";
type TaskListboxField = "category" | "color_token" | "next_status";
type SectionId =
  | "appearance"
  | "editor"
  | "files"
  | "search"
  | "updates"
  | "about";

type NumericSetting =
  | "editor_font_size"
  | "editor_line_height"
  | "editor_line_width"
  | "autosave_delay_ms"
  | "indent_width"
  | "search_result_limit";

const sections: { id: SectionId; label: string }[] = [
  { id: "appearance", label: STRINGS.settingsSectionAppearance },
  { id: "editor", label: STRINGS.settingsSectionEditor },
  { id: "files", label: STRINGS.settingsSectionFiles },
  { id: "search", label: STRINGS.settingsSectionSearch },
  { id: "updates", label: STRINGS.settingsSectionUpdates },
  { id: "about", label: STRINGS.settingsSectionAbout },
];

const settingSearchText: Record<SectionId, [string, string][]> = {
  appearance: [
    [STRINGS.settingsTheme, STRINGS.settingsThemeDescription],
    [STRINGS.settingsLightPalette, STRINGS.settingsPaletteDescription],
    [STRINGS.settingsDarkPalette, STRINGS.settingsPaletteDescription],
    [STRINGS.settingsProseFont, STRINGS.settingsProseFontDescription],
    [STRINGS.settingsCodeFont, STRINGS.settingsCodeFontDescription],
    [STRINGS.settingsFontSize, STRINGS.settingsFontSizeDescription],
    [STRINGS.settingsLineHeight, STRINGS.settingsLineHeightDescription],
    [STRINGS.settingsLineWidth, STRINGS.settingsLineWidthDescription],
    [STRINGS.settingsAnimations, STRINGS.settingsAnimationsDescription],
  ],
  editor: [
    [STRINGS.settingsAutosave, STRINGS.settingsAutosaveDescription],
    [STRINGS.settingsSpellCheck, STRINGS.settingsSpellCheckDescription],
    [STRINGS.settingsIndentStyle, STRINGS.settingsIndentStyleDescription],
    [STRINGS.settingsIndentWidth, STRINGS.settingsIndentWidthDescription],
    [STRINGS.settingsWrapLongLines, STRINGS.settingsWrapLongLinesDescription],
    [STRINGS.settingsLineNumbers, STRINGS.settingsLineNumbersDescription],
    [STRINGS.settingsInvisibles, STRINGS.settingsInvisiblesDescription],
    [STRINGS.settingsRevealSyntax, STRINGS.settingsRevealSyntaxDescription],
    [STRINGS.settingsLinkPreviews, STRINGS.settingsLinkPreviewsHint],
    [STRINGS.settingsTaskStatuses, STRINGS.settingsTaskStatusesDescription],
  ],
  files: [
    [
      STRINGS.settingsDefaultNoteFolder,
      STRINGS.settingsDefaultNoteFolderDescription,
    ],
    [
      STRINGS.settingsAttachmentFolder,
      STRINGS.settingsAttachmentFolderDescription,
    ],
    [STRINGS.settingsHonorObsidian, STRINGS.settingsHonorObsidianDescription],
  ],
  search: [
    [STRINGS.settingsSearchLimit, STRINGS.settingsSearchLimitDescription],
    [STRINGS.settingsSearchBodies, STRINGS.settingsSearchBodiesDescription],
    [STRINGS.settingsSearchCase, STRINGS.settingsSearchCaseDescription],
  ],
  updates: [
    [STRINGS.settingsUpdateChannel, STRINGS.settingsUpdateChannelDescription],
    [STRINGS.settingsCheckUpdates, STRINGS.settingsCheckUpdatesDescription],
    [STRINGS.settingsVersion, STRINGS.settingsVersionDescription],
  ],
  about: [
    [STRINGS.settingsVersion, STRINGS.settingsVersionDescription],
    [STRINGS.settingsLicense, STRINGS.settingsLicenseDescription],
    [STRINGS.settingsRepository, STRINGS.settingsRepositoryDescription],
    [STRINGS.settingsThreatModel, STRINGS.settingsThreatModelDescription],
    [STRINGS.settingsFile, STRINGS.settingsFileDescription],
  ],
};

const lightPaletteCards: {
  value: LightPaletteName;
  label: string;
}[] = [
  {
    value: "manuscript",
    label: STRINGS.settingsPaletteManuscript,
  },
  {
    value: "studio",
    label: STRINGS.settingsPaletteStudio,
  },
  {
    value: "gazette",
    label: STRINGS.settingsPaletteGazette,
  },
];

const darkPaletteCards: {
  value: DarkPaletteName;
  label: string;
}[] = [
  { value: "lamplight", label: STRINGS.settingsPaletteLamplight },
  { value: "graphite", label: STRINGS.settingsPaletteGraphite },
  { value: "signal", label: STRINGS.settingsPaletteSignal },
];

const TASK_STATUS_CATEGORIES: readonly TaskStatusCategory[] = [
  "TODO",
  "IN_PROGRESS",
  "ON_HOLD",
  "DONE",
  "CANCELLED",
  "NON_TASK",
];
const NEW_STATUS_SYMBOLS: readonly string[] = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  ..."0123456789",
  ..."*=_%^$#;:,.|(){}",
];

const booleanEditorSettings: {
  key:
    | "wrap_long_lines"
    | "show_line_numbers"
    | "show_invisible_characters"
    | "reveal_markdown_syntax"
    | "link_previews";
  label: string;
  description: string;
}[] = [
  {
    key: "wrap_long_lines",
    label: STRINGS.settingsWrapLongLines,
    description: STRINGS.settingsWrapLongLinesDescription,
  },
  {
    key: "show_line_numbers",
    label: STRINGS.settingsLineNumbers,
    description: STRINGS.settingsLineNumbersDescription,
  },
  {
    key: "show_invisible_characters",
    label: STRINGS.settingsInvisibles,
    description: STRINGS.settingsInvisiblesDescription,
  },
  {
    key: "reveal_markdown_syntax",
    label: STRINGS.settingsRevealSyntax,
    description: STRINGS.settingsRevealSyntaxDescription,
  },
  {
    key: "link_previews",
    label: STRINGS.settingsLinkPreviews,
    description: STRINGS.settingsLinkPreviewsHint,
  },
];

let {
  settings,
  onUpdate,
  onPreview = () => {},
  onClose,
  restoreFocus = true,
  desktopAvailable = true,
  currentVersion = "0.0.0",
  settingsFilePath = null,
  updateState = { kind: "idle" } as UpdateState,
  onCheckUpdate = () => {},
}: {
  settings: SettingsState;
  onUpdate: (patch: Partial<SettingsDocument>) => void;
  onPreview?: (patch: Partial<SettingsDocument>) => void;
  onClose: () => void;
  restoreFocus?: boolean;
  desktopAvailable?: boolean;
  currentVersion?: string;
  settingsFilePath?: string | null;
  updateState?: UpdateState;
  onCheckUpdate?: () => void;
} = $props();

let dialogElement = $state<HTMLElement | undefined>();
const returnFocusElement =
  typeof document !== "undefined" &&
  document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
let searchQuery = $state("");
let activeSection = $state<SectionId>("appearance");
let previewSettings = $state<Partial<SettingsDocument>>({});
let taskStatusError = $state<string | null>(null);
let openTaskListbox = $state<string | null>(null);

const documentSettings = $derived(settings.document);
const displayedSettings = $derived({
  ...documentSettings,
  ...previewSettings,
});
const isSearching = $derived(searchQuery.trim().length > 0);
const searchScope = $derived<SearchScope>(
  documentSettings.search_note_bodies ? "full-text" : "titles",
);
const settingsPathText = $derived(
  desktopAvailable
    ? (settingsFilePath ?? STRINGS.settingsFileResolving)
    : STRINGS.settingsDesktopUnavailableShort,
);

$effect(() => {
  dialogElement
    ?.querySelector<HTMLInputElement>("[data-testid='settings-search']")
    ?.focus();
});

function update(patch: Partial<SettingsDocument>) {
  onUpdate(patch);
}

function restoreDefaults() {
  restorePreview();
  update({
    ...DEFAULT_SETTINGS,
    schema_version: documentSettings.schema_version,
  });
}

function updateNumber(
  setting: NumericSetting,
  value: number,
  minimum: number,
  maximum: number,
) {
  if (Number.isInteger(value) && value >= minimum && value <= maximum) {
    update({ [setting]: value });
  }
}

function inputNumber(
  event: Event,
  setting: NumericSetting,
  minimum: number,
  maximum: number,
) {
  const nextPreview = { ...previewSettings };
  delete nextPreview[setting];
  previewSettings = nextPreview;
  updateNumber(
    setting,
    Number((event.currentTarget as HTMLInputElement).value),
    minimum,
    maximum,
  );
}

function previewNumber(
  event: Event,
  setting: NumericSetting,
  minimum: number,
  maximum: number,
) {
  const value = Number((event.currentTarget as HTMLInputElement).value);
  if (Number.isInteger(value) && value >= minimum && value <= maximum) {
    previewSettings = { ...previewSettings, [setting]: value };
    onPreview({ [setting]: value });
  }
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
  taskStatusError = null;
  update({ task_statuses: statuses.map((status) => ({ ...status })) });
}

function updateTaskStatus(index: number, patch: Partial<TaskStatus>) {
  saveTaskStatuses(
    documentSettings.task_statuses.map((status, statusIndex) =>
      statusIndex === index ? { ...status, ...patch } : status,
    ),
  );
}

function changeTaskSymbol(index: number, event: Event) {
  const statuses = documentSettings.task_statuses;
  const previousSymbol = statuses[index]?.symbol;
  const input = event.currentTarget as HTMLInputElement;
  const nextSymbol = input.value;
  if (
    previousSymbol === undefined ||
    !oneSourceCharacter(nextSymbol) ||
    statuses.some(
      (status, statusIndex) =>
        statusIndex !== index && status.symbol === nextSymbol,
    )
  ) {
    if (previousSymbol !== undefined) input.value = previousSymbol;
    taskStatusError = STRINGS.settingsTaskInvalid;
    return;
  }
  saveTaskStatuses(
    statuses.map((status, statusIndex) => ({
      ...status,
      symbol: statusIndex === index ? nextSymbol : status.symbol,
      name:
        statusIndex === index && status.name.length === 0
          ? taskStatusDisplayName(status)
          : status.name,
      next_status:
        status.next_status === previousSymbol ? nextSymbol : status.next_status,
    })),
  );
}

function moveTaskStatus(index: number, offset: -1 | 1) {
  const target = index + offset;
  const statuses = documentSettings.task_statuses.map((status) => ({
    ...status,
  }));
  if (target < 0 || target >= statuses.length) return;
  const current = statuses[index];
  const adjacent = statuses[target];
  if (current === undefined || adjacent === undefined) return;
  statuses[index] = adjacent;
  statuses[target] = current;
  saveTaskStatuses(statuses);
}

function removeTaskStatus(index: number) {
  const statuses = documentSettings.task_statuses;
  if (statuses.length <= 1) return;
  const removed = statuses[index];
  if (removed === undefined) return;
  const remaining = statuses.filter((_, statusIndex) => statusIndex !== index);
  const fallback = remaining[Math.min(index, remaining.length - 1)]?.symbol;
  if (fallback === undefined) return;
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
    documentSettings.task_statuses.map(({ symbol }) => symbol),
  );
  return NEW_STATUS_SYMBOLS.find((symbol) => !used.has(symbol)) ?? null;
}

function addTaskStatus() {
  const symbol = availableNewStatusSymbol();
  const first = documentSettings.task_statuses[0];
  if (symbol === null || first === undefined) return;
  saveTaskStatuses([
    ...documentSettings.task_statuses,
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

function taskCategoryLabel(category: TaskStatusCategory): string {
  switch (category) {
    case "TODO":
      return STRINGS.settingsTaskCategoryTodo;
    case "IN_PROGRESS":
      return STRINGS.settingsTaskCategoryInProgress;
    case "ON_HOLD":
      return STRINGS.settingsTaskCategoryOnHold;
    case "DONE":
      return STRINGS.settingsTaskCategoryDone;
    case "CANCELLED":
      return STRINGS.settingsTaskCategoryCancelled;
    case "NON_TASK":
      return STRINGS.settingsTaskCategoryNonTask;
  }
}

function taskListboxKey(index: number, field: TaskListboxField): string {
  return `${index}-${field}`;
}

async function toggleTaskListbox(
  index: number,
  field: TaskListboxField,
  openAt: "selected" | "first" = "selected",
) {
  const key = taskListboxKey(index, field);
  openTaskListbox = openTaskListbox === key ? null : key;
  await tick();
  if (openTaskListbox !== key) return;
  const listbox = dialogElement?.querySelector<HTMLElement>(
    `[data-task-listbox="${key}"]`,
  );
  const target =
    openAt === "selected"
      ? listbox?.querySelector<HTMLElement>('[aria-selected="true"]')
      : listbox?.querySelector<HTMLElement>('[role="option"]');
  target?.focus();
}

async function chooseTaskListboxOption(
  index: number,
  field: TaskListboxField,
  value: string,
) {
  updateTaskStatus(index, { [field]: value } as Partial<TaskStatus>);
  openTaskListbox = null;
  await tick();
  dialogElement
    ?.querySelector<HTMLElement>(
      `[data-task-listbox-trigger="${taskListboxKey(index, field)}"]`,
    )
    ?.focus();
}

function handleTaskListboxTrigger(
  event: KeyboardEvent,
  index: number,
  field: TaskListboxField,
) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  void toggleTaskListbox(
    index,
    field,
    event.key === "ArrowDown" ? "first" : "selected",
  );
}

function handleTaskListboxOption(event: KeyboardEvent) {
  const option = event.currentTarget as HTMLElement;
  const listbox = option.closest<HTMLElement>('[role="listbox"]');
  const options = [
    ...(listbox?.querySelectorAll<HTMLElement>('[role="option"]') ?? []),
  ];
  const index = options.indexOf(option);
  let target = index;
  if (event.key === "ArrowDown")
    target = Math.min(index + 1, options.length - 1);
  else if (event.key === "ArrowUp") target = Math.max(index - 1, 0);
  else if (event.key === "Home") target = 0;
  else if (event.key === "End") target = options.length - 1;
  else if (event.key === "Escape") {
    event.preventDefault();
    openTaskListbox = null;
    const key = listbox?.dataset.taskListbox;
    void tick().then(() => {
      if (key !== undefined) {
        dialogElement
          ?.querySelector<HTMLElement>(`[data-task-listbox-trigger="${key}"]`)
          ?.focus();
      }
    });
    return;
  } else return;
  event.preventDefault();
  options[target]?.focus();
}

function restorePreview() {
  if (Object.keys(previewSettings).length === 0) return;
  onPreview({
    editor_font_size: documentSettings.editor_font_size,
    editor_line_height: documentSettings.editor_line_height,
    editor_line_width: documentSettings.editor_line_width,
  });
  previewSettings = {};
}

function closeSettings() {
  restorePreview();
  onClose();
}

onDestroy(() => {
  restorePreview();
  if (restoreFocus && returnFocusElement?.isConnected) {
    returnFocusElement.focus();
  }
});

function matches(label: string, description: string): boolean {
  const query = searchQuery.trim().toLocaleLowerCase();
  return (
    query.length === 0 ||
    `${label} ${description}`.toLocaleLowerCase().includes(query)
  );
}

function hasMatches(section: SectionId): boolean {
  return settingSearchText[section].some(([label, description]) =>
    matches(label, description),
  );
}

function sectionVisible(section: SectionId): boolean {
  return !isSearching || hasMatches(section);
}

function segmentedKeydown<T extends string>(
  event: KeyboardEvent,
  values: readonly T[],
  current: T,
  setting: keyof SettingsDocument,
  mapValue: (value: T) => SettingsDocument[keyof SettingsDocument] = (value) =>
    value,
) {
  const index = values.indexOf(current);
  let nextIndex: number | null = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (index + 1) % values.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (index - 1 + values.length) % values.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = values.length - 1;
  }
  if (nextIndex === null) return;
  event.preventDefault();
  const value = values[nextIndex];
  if (value === undefined) return;
  onUpdate({ [setting]: mapValue(value) } as Partial<SettingsDocument>);
  dialogElement
    ?.querySelector<HTMLButtonElement>(`[data-choice="${setting}-${value}"]`)
    ?.focus();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeSettings();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    const target = event.target;
    const editingShortcut =
      target instanceof HTMLInputElement &&
      /^[acvxyz]$/iu.test(event.key) &&
      !event.altKey;
    event.stopPropagation();
    if (!editingShortcut) {
      event.preventDefault();
    }
    return;
  }
  if (event.key !== "Tab" || dialogElement === undefined) {
    return;
  }
  const focusable = [
    ...dialogElement.querySelectorAll<HTMLElement>(
      'a[href], button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => element.closest("fieldset:disabled") === null);
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) {
    event.preventDefault();
    dialogElement.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
</script>

{#snippet settingError(keys: readonly (keyof SettingsDocument)[])}
  {#if settings.error !== null && settings.errorSetting !== null && settings.errorSetting !== "document" && keys.includes(settings.errorSetting)}
    <span class="setting-inline-error" role="alert">
      {STRINGS.settingsWriteFailed}
    </span>
  {/if}
{/snippet}

<div
  class="settings-backdrop"
  role="presentation"
  onclick={(event) => event.target === event.currentTarget && closeSettings()}
>
  <div
    bind:this={dialogElement}
    class="settings-dialog"
    role="dialog"
    aria-modal="true"
    aria-label={STRINGS.settingsLabel}
    tabindex="-1"
    data-testid="settings-view"
    onkeydown={onKeydown}
  >
    <div class="settings-header">
      <div>
        <h2>{STRINGS.settingsLabel}</h2>
        <p>{STRINGS.settingsIntro}</p>
      </div>
      <button class="icon-button" type="button" onclick={closeSettings}
        >{STRINGS.closeAction}</button
      >
    </div>

    <div class="settings-layout">
      <aside class="settings-rail">
        <label class="settings-search">
          <span>{STRINGS.settingsSearchLabel}</span>
          <input
            bind:value={searchQuery}
            data-testid="settings-search"
            type="search"
            placeholder={STRINGS.settingsSearchPlaceholder}
          />
        </label>
        <nav class="settings-nav" aria-label={STRINGS.settingsSectionsLabel}>
          {#each sections as section}
            {#if sectionVisible(section.id)}
              <button
                type="button"
                class:active={activeSection === section.id && !isSearching}
                aria-current={activeSection === section.id && !isSearching
                  ? "page"
                  : undefined}
                onclick={() => (activeSection = section.id)}
                >{section.label}</button
              >
            {/if}
          {/each}
        </nav>
      </aside>

      <div class="settings-content">
        {#if (activeSection === "appearance" || isSearching) && hasMatches("appearance")}
          <section aria-labelledby="settings-appearance-heading">
            <h3 id="settings-appearance-heading">
              {STRINGS.settingsSectionAppearance}
            </h3>

            {#if matches(STRINGS.settingsTheme, STRINGS.settingsThemeDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsTheme}</span>
                  <p>{STRINGS.settingsThemeDescription}</p>
                  {@render settingError(["theme"])}
                </div>
                <div
                  class="segmented"
                  role="radiogroup"
                  aria-label={STRINGS.settingsTheme}
                  data-testid="settings-theme"
                >
                  {#each ["system", "light", "dark"] as theme}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={documentSettings.theme === theme}
                      tabindex={documentSettings.theme === theme ? 0 : -1}
                      class:active={documentSettings.theme === theme}
                      data-choice={`theme-${theme}`}
                      data-testid={`settings-theme-${theme}`}
                      onclick={() => update({ theme })}
                      onkeydown={(event) =>
                        segmentedKeydown(
                          event,
                          ["system", "light", "dark"],
                          theme as ThemeName,
                          "theme",
                        )}
                      >{theme === "system"
                        ? STRINGS.settingsThemeSystem
                        : theme === "light"
                          ? STRINGS.settingsThemeLight
                          : STRINGS.settingsThemeDark}</button
                    >
                  {/each}
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsLightPalette, STRINGS.settingsPaletteDescription)}
              <div class="setting-row palette-setting">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsLightPalette}</span>
                  <p>{STRINGS.settingsPaletteDescription}</p>
                  {@render settingError(["light_palette"])}
                </div>
                <div
                  class="palette-options"
                  role="radiogroup"
                  aria-label={STRINGS.settingsLightPalette}
                >
                  {#each lightPaletteCards as palette}
                    <button
                      type="button"
                      class:active={documentSettings.light_palette === palette.value}
                      role="radio"
                      aria-checked={documentSettings.light_palette === palette.value}
                      tabindex={documentSettings.light_palette === palette.value
                        ? 0
                        : -1}
                      data-choice={`light_palette-${palette.value}`}
                      data-testid={`settings-light-palette-${palette.value}`}
                      onclick={() => update({ light_palette: palette.value })}
                      onkeydown={(event) =>
                        segmentedKeydown(
                          event,
                          ["manuscript", "studio", "gazette"],
                          palette.value,
                          "light_palette",
                        )}
                    >
                      <span class="palette-preview" aria-hidden="true">
                        <span class={`palette-mode ${palette.value}`}>
                          <i></i><b></b>
                        </span>
                      </span>
                      <strong>{palette.label}</strong>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsDarkPalette, STRINGS.settingsPaletteDescription)}
              <div class="setting-row palette-setting">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsDarkPalette}</span>
                  <p>{STRINGS.settingsPaletteDescription}</p>
                  {@render settingError(["dark_palette"])}
                </div>
                <div
                  class="palette-options"
                  role="radiogroup"
                  aria-label={STRINGS.settingsDarkPalette}
                >
                  {#each darkPaletteCards as palette}
                    <button
                      type="button"
                      class:active={documentSettings.dark_palette === palette.value}
                      role="radio"
                      aria-checked={documentSettings.dark_palette === palette.value}
                      tabindex={documentSettings.dark_palette === palette.value
                        ? 0
                        : -1}
                      data-choice={`dark_palette-${palette.value}`}
                      data-testid={`settings-dark-palette-${palette.value}`}
                      onclick={() => update({ dark_palette: palette.value })}
                      onkeydown={(event) =>
                        segmentedKeydown(
                          event,
                          ["lamplight", "graphite", "signal"],
                          palette.value,
                          "dark_palette",
                        )}
                    >
                      <span class="palette-preview" aria-hidden="true">
                        <span class={`palette-mode ${palette.value}`}>
                          <i></i><b></b>
                        </span>
                      </span>
                      <strong>{palette.label}</strong>
                    </button>
                  {/each}
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsProseFont, STRINGS.settingsProseFontDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsProseFont}</span>
                  <p>{STRINGS.settingsProseFontDescription}</p>
                  {@render settingError(["prose_font"])}
                </div>
                <div class="segmented" role="radiogroup" aria-label={STRINGS.settingsProseFont}>
                  {#each ["serif", "sans"] as font}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={documentSettings.prose_font === font}
                      tabindex={documentSettings.prose_font === font ? 0 : -1}
                      class:active={documentSettings.prose_font === font}
                      data-choice={`prose_font-${font}`}
                      onclick={() => update({ prose_font: font })}
                      onkeydown={(event) =>
                        segmentedKeydown(
                          event,
                          ["serif", "sans"],
                          font as ProseFontName,
                          "prose_font",
                        )}
                      >{font === "serif"
                        ? STRINGS.settingsProseFontSerif
                        : STRINGS.settingsProseFontSans}</button
                    >
                  {/each}
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsCodeFont, STRINGS.settingsCodeFontDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsCodeFont}</span>
                  <p>{STRINGS.settingsCodeFontDescription}</p>
                  {@render settingError(["code_font"])}
                </div>
                <div class="segmented" role="radiogroup" aria-label={STRINGS.settingsCodeFont}>
                  {#each ["modern", "classic"] as font}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={documentSettings.code_font === font}
                      tabindex={documentSettings.code_font === font ? 0 : -1}
                      class:active={documentSettings.code_font === font}
                      data-choice={`code_font-${font}`}
                      onclick={() => update({ code_font: font })}
                      onkeydown={(event) =>
                        segmentedKeydown(
                          event,
                          ["modern", "classic"],
                          font as CodeFontName,
                          "code_font",
                        )}
                      >{font === "modern"
                        ? STRINGS.settingsCodeFontModern
                        : STRINGS.settingsCodeFontClassic}</button
                    >
                  {/each}
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsFontSize, STRINGS.settingsFontSizeDescription)}
              <label class="setting-row">
                <span class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsFontSize}</span>
                  <span>{STRINGS.settingsFontSizeDescription}</span>
                  {@render settingError(["editor_font_size"])}
                </span>
                <span class="slider-control">
                  <input
                    type="range"
                    min="8"
                    max="40"
                    step="1"
                    value={displayedSettings.editor_font_size}
                    data-testid="settings-font-size"
                    oninput={(event) =>
                      previewNumber(event, "editor_font_size", 8, 40)}
                    onchange={(event) =>
                      inputNumber(event, "editor_font_size", 8, 40)}
                  />
                  <output>{displayedSettings.editor_font_size} {STRINGS.settingsUnitPixels}</output>
                </span>
              </label>
            {/if}

            {#if matches(STRINGS.settingsLineHeight, STRINGS.settingsLineHeightDescription)}
              <label class="setting-row">
                <span class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsLineHeight}</span>
                  <span>{STRINGS.settingsLineHeightDescription}</span>
                  {@render settingError(["editor_line_height"])}
                </span>
                <span class="slider-control">
                  <input
                    type="range"
                    min="120"
                    max="220"
                    step="5"
                    value={displayedSettings.editor_line_height}
                    oninput={(event) =>
                      previewNumber(event, "editor_line_height", 120, 220)}
                    onchange={(event) =>
                      inputNumber(event, "editor_line_height", 120, 220)}
                  />
                  <output>{displayedSettings.editor_line_height}{STRINGS.settingsUnitPercent}</output>
                </span>
              </label>
            {/if}

            {#if matches(STRINGS.settingsLineWidth, STRINGS.settingsLineWidthDescription)}
              <label class="setting-row">
                <span class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsLineWidth}</span>
                  <span>{STRINGS.settingsLineWidthDescription}</span>
                  {@render settingError(["editor_line_width"])}
                </span>
                <span class="slider-control">
                  <input
                    type="range"
                    min="45"
                    max="120"
                    step="1"
                    value={displayedSettings.editor_line_width}
                    data-testid="settings-line-width"
                    oninput={(event) =>
                      previewNumber(event, "editor_line_width", 45, 120)}
                    onchange={(event) =>
                      inputNumber(event, "editor_line_width", 45, 120)}
                  />
                  <output>{displayedSettings.editor_line_width} {STRINGS.settingsUnitCharacters}</output>
                </span>
              </label>
            {/if}

            {#if matches(STRINGS.settingsAnimations, STRINGS.settingsAnimationsDescription)}
              <label class="setting-row">
                <span class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsAnimations}</span>
                  <span>{STRINGS.settingsAnimationsDescription}</span>
                  {@render settingError(["animations"])}
                </span>
                <span class="switch">
                  <input
                    type="checkbox"
                    checked={documentSettings.animations}
                    onchange={(event) =>
                      update({
                        animations: (event.currentTarget as HTMLInputElement)
                          .checked,
                      })}
                  />
                  <span aria-hidden="true"></span>
                </span>
              </label>
            {/if}
          </section>
        {/if}

        {#if (activeSection === "editor" || isSearching) && hasMatches("editor")}
          <section aria-labelledby="settings-editor-heading">
            <h3 id="settings-editor-heading">
              {STRINGS.settingsSectionEditor}
            </h3>

            {#if matches(STRINGS.settingsAutosave, STRINGS.settingsAutosaveDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsAutosave}</span>
                  <p>{STRINGS.settingsAutosaveDescription}</p>
                  {@render settingError(["autosave_delay_ms"])}
                </div>
                <div class="stepper">
                  <button
                    type="button"
                    aria-label={`${STRINGS.settingsDecrease} ${STRINGS.settingsAutosave}`}
                    disabled={documentSettings.autosave_delay_ms <= 100}
                    onclick={() =>
                      updateNumber(
                        "autosave_delay_ms",
                        documentSettings.autosave_delay_ms - 100,
                        100,
                        10_000,
                      )}>−</button
                  >
                  <output>{documentSettings.autosave_delay_ms} {STRINGS.settingsUnitMilliseconds}</output>
                  <button
                    type="button"
                    aria-label={`${STRINGS.settingsIncrease} ${STRINGS.settingsAutosave}`}
                    disabled={documentSettings.autosave_delay_ms >= 10_000}
                    onclick={() =>
                      updateNumber(
                        "autosave_delay_ms",
                        documentSettings.autosave_delay_ms + 100,
                        100,
                        10_000,
                      )}>+</button
                  >
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsSpellCheck, STRINGS.settingsSpellCheckDescription)}
              <label class="setting-row">
                <span class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsSpellCheck}</span>
                  <span>{STRINGS.settingsSpellCheckDescription}</span>
                  {@render settingError(["spell_check"])}
                </span>
                <span class="switch">
                  <input
                    type="checkbox"
                    checked={documentSettings.spell_check}
                    onchange={(event) =>
                      update({
                        spell_check: (event.currentTarget as HTMLInputElement)
                          .checked,
                      })}
                  />
                  <span aria-hidden="true"></span>
                </span>
              </label>
            {/if}

            {#if matches(STRINGS.settingsIndentStyle, STRINGS.settingsIndentStyleDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsIndentStyle}</span>
                  <p>{STRINGS.settingsIndentStyleDescription}</p>
                  {@render settingError(["indent_style"])}
                </div>
                <div class="segmented" role="radiogroup" aria-label={STRINGS.settingsIndentStyle}>
                  {#each ["spaces", "tabs"] as style}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={documentSettings.indent_style === style}
                      tabindex={documentSettings.indent_style === style ? 0 : -1}
                      class:active={documentSettings.indent_style === style}
                      data-choice={`indent_style-${style}`}
                      onclick={() => update({ indent_style: style })}
                      onkeydown={(event) =>
                        segmentedKeydown(
                          event,
                          ["spaces", "tabs"],
                          style as IndentStyle,
                          "indent_style",
                        )}
                      >{style === "spaces"
                        ? STRINGS.settingsIndentSpaces
                        : STRINGS.settingsIndentTabs}</button
                    >
                  {/each}
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsIndentWidth, STRINGS.settingsIndentWidthDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsIndentWidth}</span>
                  <p>{STRINGS.settingsIndentWidthDescription}</p>
                  {@render settingError(["indent_width"])}
                </div>
                <div class="stepper">
                  <button
                    type="button"
                    aria-label={`${STRINGS.settingsDecrease} ${STRINGS.settingsIndentWidth}`}
                    disabled={documentSettings.indent_width <= 1}
                    onclick={() =>
                      updateNumber(
                        "indent_width",
                        documentSettings.indent_width - 1,
                        1,
                        8,
                      )}>−</button
                  >
                  <output>{documentSettings.indent_width} {STRINGS.settingsUnitSpaces}</output>
                  <button
                    type="button"
                    aria-label={`${STRINGS.settingsIncrease} ${STRINGS.settingsIndentWidth}`}
                    disabled={documentSettings.indent_width >= 8}
                    onclick={() =>
                      updateNumber(
                        "indent_width",
                        documentSettings.indent_width + 1,
                        1,
                        8,
                      )}>+</button
                  >
                </div>
              </div>
            {/if}

            {#each booleanEditorSettings as preference}
              {#if matches(preference.label, preference.description)}
                <label class="setting-row">
                  <span class="setting-copy">
                    <span class="setting-label">{preference.label}</span>
                    <span>{preference.description}</span>
                    {@render settingError([preference.key])}
                  </span>
                  <span class="switch">
                    <input
                      type="checkbox"
                      data-testid={`settings-${preference.key.replaceAll("_", "-")}`}
                      checked={documentSettings[preference.key]}
                      onchange={(event) =>
                        update({
                          [preference.key]: (
                            event.currentTarget as HTMLInputElement
                          ).checked,
                        })}
                    />
                    <span aria-hidden="true"></span>
                  </span>
                </label>
              {/if}
            {/each}

            {#if matches(STRINGS.settingsTaskStatuses, STRINGS.settingsTaskStatusesDescription)}
              <div class="task-status-setting">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsTaskStatuses}</span>
                  <p>{STRINGS.settingsTaskStatusesDescription}</p>
                  {@render settingError(["task_statuses"])}
                </div>
                <details class="task-status-editor">
                  <summary>{STRINGS.settingsTaskEdit}</summary>
                  <div class="task-status-heading">
                    <p>{STRINGS.settingsTaskStatusesHelp}</p>
                    <button
                      type="button"
                      class="secondary-button"
                      disabled={availableNewStatusSymbol() === null}
                      onclick={addTaskStatus}
                      data-testid="task-status-add"
                    >{STRINGS.settingsTaskAdd}</button>
                  </div>
                  <div class="task-status-table">
                    <div class="task-status-row task-status-header" aria-hidden="true">
                      <span>{STRINGS.settingsTaskSymbol}</span>
                      <span>{STRINGS.settingsTaskName}</span>
                      <span>{STRINGS.settingsTaskCategory}</span>
                      <span>{STRINGS.settingsTaskGlyph}</span>
                      <span>{STRINGS.settingsTaskColor}</span>
                      <span>{STRINGS.settingsTaskNext}</span>
                      <span></span>
                    </div>
                    {#each documentSettings.task_statuses as status, index (index)}
                      <div
                        class="task-status-row"
                        role="group"
                        aria-label={taskStatusDisplayName(status)}
                        data-testid="task-status-row"
                      >
                        <input
                          class="text-control"
                          value={status.symbol}
                          maxlength="2"
                          aria-label={`${STRINGS.settingsTaskSymbol}: ${taskStatusDisplayName(status)}`}
                          onchange={(event) => changeTaskSymbol(index, event)}
                          data-testid="task-status-symbol"
                        />
                        <input
                          class="text-control"
                          value={taskStatusDisplayName(status)}
                          maxlength="80"
                          aria-label={`${STRINGS.settingsTaskName}: ${taskStatusDisplayName(status)}`}
                          onchange={(event) => {
                            const name = inputValue(event).trim();
                            if (name.length > 0 && [...name].length <= 80) {
                              updateTaskStatus(index, { name });
                            } else {
                              (event.currentTarget as HTMLInputElement).value =
                                taskStatusDisplayName(status);
                              taskStatusError = STRINGS.settingsTaskInvalid;
                            }
                          }}
                          data-testid="task-status-name"
                        />
                        <div class="task-listbox-control">
                          <button
                            type="button"
                            class="text-control task-listbox-trigger"
                            aria-label={`${STRINGS.settingsTaskCategory}: ${taskStatusDisplayName(status)}`}
                            aria-haspopup="listbox"
                            aria-expanded={openTaskListbox === taskListboxKey(index, "category")}
                            data-task-listbox-trigger={taskListboxKey(index, "category")}
                            data-testid="task-status-category"
                            onclick={() => toggleTaskListbox(index, "category")}
                            onkeydown={(event) => handleTaskListboxTrigger(event, index, "category")}
                          >{taskCategoryLabel(status.category)}</button>
                          {#if openTaskListbox === taskListboxKey(index, "category")}
                            <div
                              class="task-listbox-options"
                              role="listbox"
                              aria-label={`${STRINGS.settingsTaskCategory}: ${taskStatusDisplayName(status)}`}
                              data-task-listbox={taskListboxKey(index, "category")}
                            >
                              {#each TASK_STATUS_CATEGORIES as category}
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={status.category === category}
                                  tabindex="-1"
                                  onclick={() => chooseTaskListboxOption(index, "category", category)}
                                  onkeydown={handleTaskListboxOption}
                                >{taskCategoryLabel(category)}</button>
                              {/each}
                            </div>
                          {/if}
                        </div>
                        <input
                          class="text-control"
                          value={status.glyph}
                          maxlength="8"
                          aria-label={`${STRINGS.settingsTaskGlyph}: ${taskStatusDisplayName(status)}`}
                          onchange={(event) => {
                            const glyph = inputValue(event);
                            if (
                              [...glyph].length > 0 &&
                              [...glyph].length <= 8 &&
                              !/[\p{Cc}]/u.test(glyph)
                            ) {
                              updateTaskStatus(index, { glyph });
                            } else {
                              (event.currentTarget as HTMLInputElement).value =
                                status.glyph;
                              taskStatusError = STRINGS.settingsTaskInvalid;
                            }
                          }}
                          data-testid="task-status-glyph"
                        />
                        <div class="task-listbox-control task-color-token">
                          <button
                            type="button"
                            class="text-control task-listbox-trigger"
                            aria-label={`${STRINGS.settingsTaskColor}: ${taskStatusDisplayName(status)}`}
                            aria-haspopup="listbox"
                            aria-expanded={openTaskListbox === taskListboxKey(index, "color_token")}
                            data-task-listbox-trigger={taskListboxKey(index, "color_token")}
                            data-testid="task-status-color"
                            onclick={() => toggleTaskListbox(index, "color_token")}
                            onkeydown={(event) => handleTaskListboxTrigger(event, index, "color_token")}
                          >{status.color_token}</button>
                          {#if openTaskListbox === taskListboxKey(index, "color_token")}
                            <div
                              class="task-listbox-options"
                              role="listbox"
                              aria-label={`${STRINGS.settingsTaskColor}: ${taskStatusDisplayName(status)}`}
                              data-task-listbox={taskListboxKey(index, "color_token")}
                            >
                              {#each TASK_COLOR_TOKENS as token}
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={status.color_token === token}
                                  tabindex="-1"
                                  onclick={() => chooseTaskListboxOption(index, "color_token", token)}
                                  onkeydown={handleTaskListboxOption}
                                >{token}</button>
                              {/each}
                            </div>
                          {/if}
                        </div>
                        <div class="task-listbox-control">
                          <button
                            type="button"
                            class="text-control task-listbox-trigger"
                            aria-label={`${STRINGS.settingsTaskNext}: ${taskStatusDisplayName(status)}`}
                            aria-haspopup="listbox"
                            aria-expanded={openTaskListbox === taskListboxKey(index, "next_status")}
                            data-task-listbox-trigger={taskListboxKey(index, "next_status")}
                            data-testid="task-status-next"
                            onclick={() => toggleTaskListbox(index, "next_status")}
                            onkeydown={(event) => handleTaskListboxTrigger(event, index, "next_status")}
                          >
                            {symbolLabel(status.next_status)}:
                            {taskStatusDisplayName(documentSettings.task_statuses.find((target) => target.symbol === status.next_status) ?? status)}
                          </button>
                          {#if openTaskListbox === taskListboxKey(index, "next_status")}
                            <div
                              class="task-listbox-options"
                              role="listbox"
                              aria-label={`${STRINGS.settingsTaskNext}: ${taskStatusDisplayName(status)}`}
                              data-task-listbox={taskListboxKey(index, "next_status")}
                            >
                              {#each documentSettings.task_statuses as target}
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={status.next_status === target.symbol}
                                  tabindex="-1"
                                  onclick={() => chooseTaskListboxOption(index, "next_status", target.symbol)}
                                  onkeydown={handleTaskListboxOption}
                                >
                                  {symbolLabel(target.symbol)}: {taskStatusDisplayName(target)}
                                </button>
                              {/each}
                            </div>
                          {/if}
                        </div>
                        <span class="task-status-actions">
                          <button
                            type="button"
                            disabled={index === 0}
                            aria-label={`${STRINGS.settingsTaskMoveUp}: ${taskStatusDisplayName(status)}`}
                            onclick={() => moveTaskStatus(index, -1)}
                          >↑</button>
                          <button
                            type="button"
                            disabled={index === documentSettings.task_statuses.length - 1}
                            aria-label={`${STRINGS.settingsTaskMoveDown}: ${taskStatusDisplayName(status)}`}
                            onclick={() => moveTaskStatus(index, 1)}
                          >↓</button>
                          <button
                            type="button"
                            disabled={documentSettings.task_statuses.length <= 1}
                            aria-label={`${STRINGS.settingsTaskRemove}: ${taskStatusDisplayName(status)}`}
                            onclick={() => removeTaskStatus(index)}
                          >×</button>
                        </span>
                      </div>
                    {/each}
                  </div>
                  {#if taskStatusError !== null}
                    <p class="setting-inline-error" role="alert">
                      {taskStatusError}
                    </p>
                  {/if}
                </details>
              </div>
            {/if}
          </section>
        {/if}

        {#if (activeSection === "files" || isSearching) && hasMatches("files")}
          <section aria-labelledby="settings-files-heading">
            <h3 id="settings-files-heading">
              {STRINGS.settingsSectionFiles}
            </h3>
            {#if !desktopAvailable}
              <p class="desktop-only" data-testid="settings-desktop-unavailable">
                {STRINGS.settingsDesktopOnly}
              </p>
            {/if}
            <fieldset disabled={!desktopAvailable}>
              {#if matches(STRINGS.settingsDefaultNoteFolder, STRINGS.settingsDefaultNoteFolderDescription)}
                <label class="setting-row">
                  <span class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsDefaultNoteFolder}</span>
                    <span>{STRINGS.settingsDefaultNoteFolderDescription}</span>
                    {@render settingError(["default_note_folder"])}
                  </span>
                  <input
                    class="text-control"
                    type="text"
                    value={documentSettings.default_note_folder}
                    data-testid="settings-default-note-folder"
                    disabled={!desktopAvailable}
                    onchange={(event) =>
                      update({
                        default_note_folder: (
                          event.currentTarget as HTMLInputElement
                        ).value,
                      })}
                  />
                </label>
              {/if}

              {#if matches(STRINGS.settingsAttachmentFolder, STRINGS.settingsAttachmentFolderDescription)}
                <div class="setting-row attachment-setting">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsAttachmentFolder}</span>
                    <p>{STRINGS.settingsAttachmentFolderDescription}</p>
                    {@render settingError(["attachment_folder_mode", "attachment_folder_path"])}
                  </div>
                  <div class="attachment-controls">
                    <div class="segmented" role="radiogroup" aria-label={STRINGS.settingsAttachmentFolder}>
                      {#each ["vault", "note", "folder"] as mode}
                        <button
                          type="button"
                          role="radio"
                          aria-checked={documentSettings.attachment_folder_mode === mode}
                          tabindex={documentSettings.attachment_folder_mode === mode ? 0 : -1}
                          class:active={documentSettings.attachment_folder_mode === mode}
                          data-choice={`attachment_folder_mode-${mode}`}
                          disabled={!desktopAvailable}
                          onclick={() =>
                            update({ attachment_folder_mode: mode })}
                          onkeydown={(event) =>
                            segmentedKeydown(
                              event,
                              ["vault", "note", "folder"],
                              mode as AttachmentFolderMode,
                              "attachment_folder_mode",
                            )}
                          >{mode === "vault"
                            ? STRINGS.settingsAttachmentVault
                            : mode === "note"
                              ? STRINGS.settingsAttachmentNote
                              : STRINGS.settingsAttachmentFolderChoice}</button
                        >
                      {/each}
                    </div>
                    {#if documentSettings.attachment_folder_mode === "folder"}
                      <input
                        class="text-control"
                        type="text"
                        aria-label={STRINGS.settingsAttachmentFolderPath}
                        value={documentSettings.attachment_folder_path}
                        disabled={!desktopAvailable}
                        onchange={(event) =>
                          update({
                            attachment_folder_path: (
                              event.currentTarget as HTMLInputElement
                            ).value,
                          })}
                      />
                    {/if}
                  </div>
                </div>
              {/if}

              {#if matches(STRINGS.settingsHonorObsidian, STRINGS.settingsHonorObsidianDescription)}
                <label class="setting-row">
                  <span class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsHonorObsidian}</span>
                    <span>{STRINGS.settingsHonorObsidianDescription}</span>
                    {@render settingError(["honor_obsidian_config"])}
                  </span>
                  <span class="switch">
                    <input
                      type="checkbox"
                      checked={documentSettings.honor_obsidian_config}
                      disabled={!desktopAvailable}
                      onchange={(event) =>
                        update({
                          honor_obsidian_config: (
                            event.currentTarget as HTMLInputElement
                          ).checked,
                        })}
                    />
                    <span aria-hidden="true"></span>
                  </span>
                </label>
              {/if}
            </fieldset>
          </section>
        {/if}

        {#if (activeSection === "search" || isSearching) && hasMatches("search")}
          <section aria-labelledby="settings-search-heading">
            <h3 id="settings-search-heading">
              {STRINGS.settingsSectionSearch}
            </h3>
            {#if matches(STRINGS.settingsSearchLimit, STRINGS.settingsSearchLimitDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsSearchLimit}</span>
                  <p>{STRINGS.settingsSearchLimitDescription}</p>
                  {@render settingError(["search_result_limit"])}
                </div>
                <div class="stepper">
                  <button
                    type="button"
                    aria-label={`${STRINGS.settingsDecrease} ${STRINGS.settingsSearchLimit}`}
                    disabled={documentSettings.search_result_limit <= 1}
                    onclick={() =>
                      updateNumber(
                        "search_result_limit",
                        Math.max(1, documentSettings.search_result_limit - 10),
                        1,
                        1000,
                      )}>−</button
                  >
                  <output>{documentSettings.search_result_limit} {STRINGS.settingsUnitResults}</output>
                  <button
                    type="button"
                    aria-label={`${STRINGS.settingsIncrease} ${STRINGS.settingsSearchLimit}`}
                    disabled={documentSettings.search_result_limit >= 1000}
                    onclick={() =>
                      updateNumber(
                        "search_result_limit",
                        Math.min(
                          1000,
                          documentSettings.search_result_limit + 10,
                        ),
                        1,
                        1000,
                      )}>+</button
                  >
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsSearchBodies, STRINGS.settingsSearchBodiesDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsSearchBodies}</span>
                  <p>{STRINGS.settingsSearchBodiesDescription}</p>
                  {@render settingError(["search_note_bodies"])}
                </div>
                <div class="segmented" role="radiogroup" aria-label={STRINGS.settingsSearchBodies}>
                  {#each ["titles", "full-text"] as scope}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={searchScope === scope}
                      tabindex={searchScope === scope ? 0 : -1}
                      class:active={searchScope === scope}
                      data-choice={`search_note_bodies-${scope}`}
                      onclick={() =>
                        update({ search_note_bodies: scope === "full-text" })}
                      onkeydown={(event) =>
                        segmentedKeydown(
                          event,
                          ["titles", "full-text"],
                          scope as SearchScope,
                          "search_note_bodies",
                          (value) => value === "full-text",
                        )}
                      >{scope === "titles"
                        ? STRINGS.settingsSearchTitles
                        : STRINGS.settingsSearchFullText}</button
                    >
                  {/each}
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsSearchCase, STRINGS.settingsSearchCaseDescription)}
              <label class="setting-row">
                <span class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsSearchCase}</span>
                  <span>{STRINGS.settingsSearchCaseDescription}</span>
                  {@render settingError(["search_case_sensitive"])}
                </span>
                <span class="switch">
                  <input
                    type="checkbox"
                    checked={documentSettings.search_case_sensitive}
                    onchange={(event) =>
                      update({
                        search_case_sensitive: (
                          event.currentTarget as HTMLInputElement
                        ).checked,
                      })}
                  />
                  <span aria-hidden="true"></span>
                </span>
              </label>
            {/if}
          </section>
        {/if}

        {#if (activeSection === "updates" || isSearching) && hasMatches("updates")}
          <section aria-labelledby="settings-updates-heading">
            <h3 id="settings-updates-heading">
              {STRINGS.settingsSectionUpdates}
            </h3>
            {#if !desktopAvailable}
              <p class="desktop-only" data-testid="settings-desktop-unavailable">
                {STRINGS.settingsDesktopOnly}
              </p>
            {/if}
            <fieldset disabled={!desktopAvailable}>
              {#if matches(STRINGS.settingsUpdateChannel, STRINGS.settingsUpdateChannelDescription)}
                <div class="setting-row">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsUpdateChannel}</span>
                    <p>{STRINGS.settingsUpdateChannelDescription}</p>
                    {@render settingError(["update_channel"])}
                  </div>
                  <div class="segmented" role="radiogroup" aria-label={STRINGS.settingsUpdateChannel}>
                    {#each ["stable", "beta"] as channel}
                      <button
                        type="button"
                        role="radio"
                        aria-checked={documentSettings.update_channel === channel}
                        tabindex={documentSettings.update_channel === channel ? 0 : -1}
                        class:active={documentSettings.update_channel === channel}
                        data-choice={`update_channel-${channel}`}
                        disabled={!desktopAvailable}
                        onclick={() => update({ update_channel: channel })}
                        onkeydown={(event) =>
                          segmentedKeydown(
                            event,
                            ["stable", "beta"],
                            channel as UpdateChannel,
                            "update_channel",
                          )}
                        >{channel === "stable"
                          ? STRINGS.settingsUpdateStable
                          : STRINGS.settingsUpdateBeta}</button
                      >
                    {/each}
                  </div>
                </div>
              {/if}

              {#if matches(STRINGS.settingsCheckUpdates, STRINGS.settingsCheckUpdatesDescription)}
                <div class="setting-row">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsCheckUpdates}</span>
                    <p>{STRINGS.settingsCheckUpdatesDescription}</p>
                    {#if updateState.kind !== "idle"}
                      <p class="update-status" role="status">
                        {describeUpdateState(updateState)}
                      </p>
                    {/if}
                  </div>
                  <button
                    type="button"
                    class="secondary-button"
                    data-testid="settings-check-updates"
                    disabled={!desktopAvailable}
                    onclick={onCheckUpdate}
                    >{STRINGS.updateCheck}</button
                  >
                </div>
              {/if}

              {#if matches(STRINGS.settingsVersion, STRINGS.settingsVersionDescription)}
                <div class="setting-row">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsVersion}</span>
                    <p>{STRINGS.settingsVersionDescription}</p>
                  </div>
                  <output>{currentVersion}</output>
                </div>
              {/if}
            </fieldset>
          </section>
        {/if}

        {#if (activeSection === "about" || isSearching) && hasMatches("about")}
          <section aria-labelledby="settings-about-heading">
            <h3 id="settings-about-heading">
              {STRINGS.settingsSectionAbout}
            </h3>
            {#if matches(STRINGS.settingsVersion, STRINGS.settingsVersionDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsVersion}</span>
                  <p>{STRINGS.settingsVersionDescription}</p>
                </div>
                <output>{currentVersion}</output>
              </div>
            {/if}
            {#if matches(STRINGS.settingsLicense, STRINGS.settingsLicenseDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsLicense}</span>
                  <p>{STRINGS.settingsLicenseDescription}</p>
                </div>
                <a href="https://github.com/morgaesis/skribeum#license" target="_blank" rel="noreferrer">
                  {STRINGS.settingsLicenseLink}
                </a>
              </div>
            {/if}
            {#if matches(STRINGS.settingsRepository, STRINGS.settingsRepositoryDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsRepository}</span>
                  <p>{STRINGS.settingsRepositoryDescription}</p>
                </div>
                <a href="https://github.com/morgaesis/skribeum" target="_blank" rel="noreferrer">
                  {STRINGS.settingsRepositoryLink}
                </a>
              </div>
            {/if}
            {#if matches(STRINGS.settingsThreatModel, STRINGS.settingsThreatModelDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsThreatModel}</span>
                  <p>{STRINGS.settingsThreatModelDescription}</p>
                </div>
                <a href="https://github.com/morgaesis/skribeum/blob/main/SECURITY.md" target="_blank" rel="noreferrer">
                  {STRINGS.settingsThreatModelLink}
                </a>
              </div>
            {/if}
            {#if matches(STRINGS.settingsFile, STRINGS.settingsFileDescription)}
              <div class="setting-row">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsFile}</span>
                  <p>{STRINGS.settingsFileDescription}</p>
                </div>
                <output
                  class="settings-path"
                  class:desktop-unavailable={!desktopAvailable}
                  >{settingsPathText}</output
                >
              </div>
            {/if}
            <p class="prealpha-note">{STRINGS.settingsPreAlphaNote}</p>
          </section>
        {/if}
      </div>
    </div>

    <footer class="settings-footer">
      <button
        type="button"
        class="secondary-button"
        onclick={restoreDefaults}
        >{STRINGS.settingsRestoreDefaults}</button
      >
      <div class="settings-file-status">
        {#if settings.error !== null && settings.errorSetting === "document"}
          <span class="settings-error" role="alert">
            {settings.loaded
              ? STRINGS.settingsWriteFailed
              : STRINGS.settingsReadFailed}
          </span>
        {/if}
        <span>{settingsPathText}</span>
      </div>
    </footer>
  </div>
</div>

<style>
  .settings-backdrop {
    align-items: center;
    background: var(--skr-overlay);
    display: flex;
    inset: 0;
    justify-content: center;
    padding: 1rem;
    position: fixed;
    z-index: 40;
  }

  .settings-dialog {
    background: var(--skr-surface-raised);
    border: 1px solid var(--skr-border);
    border-radius: 0.75rem;
    box-shadow: var(--skr-shadow);
    color: var(--skr-text);
    display: flex;
    flex-direction: column;
    height: min(80vh, 34rem);
    max-height: calc(100vh - 2rem);
    outline: none;
    overflow: hidden;
    width: min(44rem, calc(100vw - 2rem));
  }

  .settings-header,
  .settings-footer {
    align-items: center;
    display: flex;
    flex: none;
    justify-content: space-between;
  }

  .settings-header {
    border-bottom: 1px solid var(--skr-border);
    gap: 1rem;
    padding: 1rem 1.125rem;
  }

  .settings-header h2 {
    font-size: 1rem;
    margin: 0;
  }

  .settings-header p,
  .setting-copy p,
  .setting-copy > span:last-child {
    color: var(--skr-text-muted);
    font-size: 0.75rem;
    line-height: 1.4;
    margin: 0.2rem 0 0;
  }

  .settings-error,
  .desktop-only,
  .prealpha-note,
  .update-status {
    border-left: 3px solid var(--skr-warning);
    color: var(--skr-text-muted);
    font-size: 0.75rem;
    margin: 0.75rem 1rem 0;
    padding-left: 0.6rem;
  }

  .settings-error {
    border-left-color: var(--skr-danger);
    color: var(--skr-danger);
  }

  .settings-file-status {
    align-items: flex-end;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-width: 65%;
    overflow-wrap: anywhere;
    text-align: right;
  }

  .settings-file-status .settings-error {
    margin: 0;
  }

  .setting-inline-error {
    color: var(--skr-danger);
    display: block;
    font-size: 0.75rem;
    margin-top: 0.35rem;
  }

  .settings-layout {
    display: grid;
    flex: 1;
    grid-template-columns: 11rem minmax(0, 1fr);
    min-height: 0;
  }

  .settings-rail {
    background: var(--skr-surface-subtle);
    border-right: 1px solid var(--skr-border);
    min-width: 0;
    overflow-y: auto;
    padding: 0.875rem 0.75rem;
  }

  .settings-search {
    display: grid;
    gap: 0.35rem;
  }

  .settings-search span,
  .setting-label {
    font-size: 0.8125rem;
    font-weight: 600;
  }

  .settings-search input,
  .text-control {
    background: var(--skr-surface);
    border: 1px solid var(--skr-border-strong);
    border-radius: 0.35rem;
    color: var(--skr-text);
    font: inherit;
    min-width: 0;
    padding: 0.4rem 0.5rem;
  }

  .settings-search input {
    width: 100%;
  }

  .settings-nav {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    margin-top: 0.75rem;
  }

  .settings-nav button,
  .icon-button,
  .secondary-button,
  .segmented button,
  .palette-options button,
  .stepper button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--skr-text);
    cursor: pointer;
    font: inherit;
  }

  .settings-nav button {
    border-radius: 0.35rem;
    font-size: 0.8125rem;
    padding: 0.45rem 0.55rem;
    text-align: left;
  }

  .settings-nav button:hover,
  .settings-nav button.active,
  .icon-button:hover,
  .secondary-button:hover {
    background: var(--skr-surface);
  }

  .settings-nav button.active {
    color: var(--skr-accent);
    font-weight: 600;
  }

  .settings-content {
    min-width: 0;
    overflow-y: auto;
    padding: 1rem 1.125rem 1.5rem;
  }

  .settings-content section + section {
    margin-top: 1.5rem;
  }

  .settings-content h3 {
    color: var(--skr-text-muted);
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    margin: 0 0 0.25rem;
    text-transform: uppercase;
  }

  .setting-row {
    align-items: center;
    border-bottom: 1px solid var(--skr-border);
    display: grid;
    gap: 1rem;
    grid-template-columns: minmax(0, 1fr) auto;
    min-height: 2.75rem;
    padding: 0.75rem 0;
  }

  .setting-copy {
    min-width: 0;
  }

  .segmented {
    border: 1px solid var(--skr-border-strong);
    border-radius: 0.4rem;
    display: inline-flex;
    overflow: hidden;
  }

  .segmented button {
    border: 0;
    border-right: 1px solid var(--skr-border);
    font-size: 0.75rem;
    padding: 0.4rem 0.55rem;
    white-space: nowrap;
  }

  .segmented button:last-child {
    border-right: 0;
  }

  .segmented button:hover {
    background: var(--skr-surface-subtle);
  }

  .segmented button.active {
    background: var(--skr-accent-subtle);
    color: var(--skr-accent);
    font-weight: 600;
  }

  .palette-setting {
    grid-template-columns: 1fr;
  }

  .palette-options {
    display: grid;
    gap: 0.5rem;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .palette-options button {
    border-color: var(--skr-border);
    border-radius: 0.5rem;
    display: grid;
    gap: 0.35rem;
    min-width: 0;
    padding: 0.45rem;
    text-align: left;
  }

  .palette-options button:hover {
    background: var(--skr-surface-subtle);
  }

  .palette-options button.active {
    border-color: var(--skr-accent);
    box-shadow: inset 0 0 0 1px var(--skr-accent);
  }

  .palette-options strong {
    overflow-wrap: anywhere;
    font-size: 0.75rem;
  }

  .palette-preview {
    border: 1px solid var(--skr-border);
    border-radius: 0.3rem;
    display: grid;
    grid-template-columns: 1fr 1fr;
    height: 2.5rem;
    overflow: hidden;
  }

  .palette-mode {
    align-items: center;
    background: var(--preview-surface);
    color: var(--preview-text);
    display: flex;
    gap: 0.3rem;
    padding: 0.35rem;
  }

  .palette-mode i {
    background: currentColor;
    display: block;
    height: 0.15rem;
    width: 65%;
  }

  .palette-mode b {
    background: var(--preview-accent);
    border-radius: 50%;
    display: block;
    height: 0.45rem;
    width: 0.45rem;
  }

  .palette-mode.manuscript {
    --preview-surface: var(--skr-preview-manuscript-surface);
    --preview-text: var(--skr-preview-manuscript-text);
    --preview-accent: var(--skr-preview-manuscript-accent);
  }

  .palette-mode.lamplight {
    --preview-surface: var(--skr-preview-lamplight-surface);
    --preview-text: var(--skr-preview-lamplight-text);
    --preview-accent: var(--skr-preview-lamplight-accent);
  }

  .palette-mode.studio {
    --preview-surface: var(--skr-preview-studio-surface);
    --preview-text: var(--skr-preview-studio-text);
    --preview-accent: var(--skr-preview-studio-accent);
  }

  .palette-mode.graphite {
    --preview-surface: var(--skr-preview-graphite-surface);
    --preview-text: var(--skr-preview-graphite-text);
    --preview-accent: var(--skr-preview-graphite-accent);
  }

  .palette-mode.gazette {
    --preview-surface: var(--skr-preview-gazette-surface);
    --preview-text: var(--skr-preview-gazette-text);
    --preview-accent: var(--skr-preview-gazette-accent);
  }

  .palette-mode.signal {
    --preview-surface: var(--skr-preview-signal-surface);
    --preview-text: var(--skr-preview-signal-text);
    --preview-accent: var(--skr-preview-signal-accent);
  }

  .slider-control {
    align-items: center;
    display: grid;
    gap: 0.5rem;
    grid-template-columns: 8rem 5.5rem;
  }

  .slider-control input {
    accent-color: var(--skr-accent);
    width: 100%;
  }

  output {
    color: var(--skr-text-muted);
    font-size: 0.75rem;
    text-align: right;
    white-space: nowrap;
  }

  .settings-path {
    max-width: 16rem;
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .stepper {
    align-items: stretch;
    border: 1px solid var(--skr-border-strong);
    border-radius: 0.4rem;
    display: flex;
    overflow: hidden;
  }

  .stepper button {
    border: 0;
    font-size: 1rem;
    min-width: 2rem;
  }

  .stepper button:hover:not(:disabled) {
    background: var(--skr-surface-subtle);
  }

  .stepper button:disabled {
    color: var(--skr-text-muted);
    cursor: default;
    opacity: 0.5;
  }

  .stepper output {
    align-items: center;
    border-left: 1px solid var(--skr-border);
    border-right: 1px solid var(--skr-border);
    display: flex;
    justify-content: center;
    min-width: 6.5rem;
    padding: 0.35rem 0.5rem;
    text-align: center;
  }

  .switch {
    align-items: center;
    display: inline-flex;
    height: 2.75rem;
    justify-content: center;
    position: relative;
    width: 2.75rem;
  }

  .switch input {
    height: 100%;
    inset: 0;
    margin: 0;
    opacity: 0;
    position: absolute;
    width: 100%;
    z-index: 1;
  }

  .switch > span {
    background: var(--skr-border-strong);
    border-radius: 1rem;
    display: block;
    height: 1.25rem;
    transition: background-color 50ms linear;
    width: 2.25rem;
  }

  .switch > span::after {
    background: var(--skr-surface);
    border-radius: 50%;
    content: "";
    display: block;
    height: 0.875rem;
    margin: 0.1875rem;
    width: 0.875rem;
  }

  .switch input:checked + span {
    background: var(--skr-accent);
  }

  .switch input:checked + span::after {
    transform: translateX(1rem);
  }

  .switch input:focus-visible + span {
    outline: 2px solid var(--skr-focus);
    outline-offset: 2px;
  }

  .task-status-setting {
    border-bottom: 1px solid var(--skr-border);
    display: grid;
    gap: 0.65rem;
    padding: 0.75rem 0;
  }

  .task-status-editor {
    min-width: 0;
  }

  .task-status-editor summary {
    color: var(--skr-link);
    cursor: pointer;
    font-size: 0.75rem;
    width: fit-content;
  }

  .task-status-heading {
    align-items: center;
    display: flex;
    justify-content: space-between;
    margin-block: 0.65rem;
  }

  .task-status-heading p {
    margin: 0;
  }

  .task-status-table {
    border: 1px solid var(--skr-border);
    border-radius: 0.4rem;
    overflow: auto;
  }

  .task-status-row {
    align-items: center;
    display: grid;
    gap: 0.35rem;
    grid-template-columns:
      3.5rem minmax(8rem, 1.2fr) 8rem 4rem minmax(9rem, 1fr)
      minmax(9rem, 1fr) 6.5rem;
    min-width: 51rem;
    padding: 0.35rem;
  }

  .task-status-row + .task-status-row {
    border-top: 1px solid var(--skr-border);
  }

  .task-status-header {
    background: var(--skr-surface-subtle);
    color: var(--skr-text-muted);
    font-size: 0.7rem;
    font-weight: 600;
  }

  .task-status-row .text-control {
    box-sizing: border-box;
    min-width: 0;
    width: 100%;
  }

  .task-color-token {
    font-family: var(--skr-font-mono);
  }

  .task-listbox-control {
    align-self: stretch;
    min-width: 0;
  }

  .task-listbox-trigger {
    overflow: hidden;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-listbox-options {
    background: var(--skr-surface-raised);
    border: 1px solid var(--skr-border-strong);
    border-radius: 0.35rem;
    display: grid;
    margin-top: 0.2rem;
    max-height: 9rem;
    overflow-y: auto;
    padding: 0.2rem;
  }

  .task-listbox-options button {
    border: 0;
    border-radius: 0.25rem;
    overflow: hidden;
    padding: 0.3rem 0.4rem;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-listbox-options button:hover,
  .task-listbox-options button:focus-visible {
    background: var(--skr-surface-subtle);
  }

  .task-listbox-options button[aria-selected="true"] {
    background: var(--skr-accent-subtle);
    color: var(--skr-accent);
    font-weight: 600;
  }

  .task-status-actions {
    display: flex;
    justify-content: end;
  }

  .task-status-actions button {
    border-color: var(--skr-border-strong);
    border-radius: 0.25rem;
    min-width: 1.8rem;
    padding: 0.3rem;
  }

  .attachment-setting {
    align-items: start;
  }

  .attachment-controls {
    display: grid;
    gap: 0.5rem;
    justify-items: end;
  }

  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
  }

  fieldset:disabled {
    opacity: 0.62;
  }

  .desktop-only {
    margin-inline: 0;
  }

  .prealpha-note {
    background: var(--skr-warning-surface);
    border-left-color: var(--skr-warning);
    color: var(--skr-warning);
    margin-inline: 0;
    padding-block: 0.55rem;
  }

  .update-status {
    margin: 0.4rem 0 0;
  }

  .icon-button,
  .secondary-button {
    border-color: var(--skr-border-strong);
    border-radius: 0.35rem;
    font-size: 0.75rem;
    padding: 0.4rem 0.6rem;
  }

  a {
    color: var(--skr-link);
    font-size: 0.75rem;
  }

  .settings-footer {
    border-top: 1px solid var(--skr-border);
    color: var(--skr-text-muted);
    font-size: 0.75rem;
    gap: 1rem;
    padding: 0.65rem 1.125rem;
  }

  .settings-footer span {
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 60rem) {
    .settings-backdrop {
      padding: 0;
    }

    .settings-dialog {
      border: 0;
      border-radius: 0;
      height: 100%;
      max-height: none;
      width: 100%;
    }

    .settings-layout {
      grid-template-columns: 1fr;
    }

    .settings-rail {
      border-bottom: 1px solid var(--skr-border);
      border-right: 0;
      overflow: visible;
    }

    .settings-nav {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .settings-nav button {
      min-width: 0;
    }

    .palette-options {
      grid-template-columns: 1fr;
    }

    .setting-row {
      align-items: start;
      grid-template-columns: 1fr;
    }

    .slider-control {
      grid-template-columns: minmax(0, 1fr) 5.5rem;
      width: 100%;
    }

    .settings-footer span {
      display: none;
    }

    .task-status-table {
      border: 0;
      overflow: visible;
    }

    .task-status-header {
      display: none;
    }

    .task-status-row {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      min-width: 0;
      padding-block: 0.75rem;
    }

    .task-status-actions {
      grid-column: 1 / -1;
    }

    button,
    input:not([type="range"]),
    a {
      min-height: 2.75rem;
    }

    button {
      min-width: 2.75rem;
    }

    input[type="range"] {
      min-height: 2.75rem;
    }
  }
</style>
