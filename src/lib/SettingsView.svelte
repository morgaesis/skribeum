<script lang="ts">
import { onDestroy, onMount, tick } from "svelte";
import {
  SETTINGS_DESCRIPTORS,
  type SettingSectionId,
} from "./features/settingsCatalog";
import {
  DEFAULT_SETTINGS,
  type SettingsDocument,
  type SettingsState,
} from "./features/settingsStore";
import { describeUpdateState, type UpdateState } from "./features/updates";
import { STRINGS } from "./strings";
import {
  TASK_COLOR_TOKENS,
  TASK_PAYLOAD_KINDS,
  TASK_TRACKS,
  type TaskPayloadKind,
  type TaskStatus,
  type TaskStatusCategory,
  type TaskTrack,
  taskStatusDisplayName,
  taskStatusDocument,
  taskStatusPayload,
  taskStatusTrack,
  taskTrackLabel,
} from "./taskStatuses";
import type {
  CodeFontName,
  DarkPaletteName,
  LightPaletteName,
  ProseFontName,
} from "./themes/theme";

// registry-exempt keydown: ARIA dialog dismissal plus radio and segmented
// control navigation stays internal to the settings widget.

type IndentStyle = "spaces" | "tabs";
type AttachmentFolderMode = "vault" | "note" | "folder";
type UpdateChannel = "stable" | "beta";
type SearchScope = "titles" | "full-text";
type TaskListboxField =
  | "category"
  | "color_token"
  | "next_status"
  | "track"
  | "payload";
type SectionId = SettingSectionId;

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

const settingSearchText = Object.fromEntries(
  sections.map((section) => [
    section.id,
    SETTINGS_DESCRIPTORS.filter(
      (setting) =>
        setting.section === section.id && setting.id !== "updates.version",
    ).map((setting): [string, string] => [setting.label, setting.description]),
  ]),
) as Record<SectionId, [string, string][]>;

type PaletteCard = {
  value: LightPaletteName | DarkPaletteName;
  mode: "light" | "dark";
  label: string;
};

const paletteCards: PaletteCard[] = [
  {
    value: "manuscript",
    mode: "light",
    label: STRINGS.settingsPaletteManuscript,
  },
  {
    value: "studio",
    mode: "light",
    label: STRINGS.settingsPaletteStudio,
  },
  {
    value: "gazette",
    mode: "light",
    label: STRINGS.settingsPaletteGazette,
  },
  {
    value: "lamplight",
    mode: "dark",
    label: STRINGS.settingsPaletteLamplight,
  },
  {
    value: "graphite",
    mode: "dark",
    label: STRINGS.settingsPaletteGraphite,
  },
  {
    value: "signal",
    mode: "dark",
    label: STRINGS.settingsPaletteSignal,
  },
];

const numericSettings: Record<
  NumericSetting,
  { minimum: number; maximum: number; step: number }
> = {
  editor_font_size: { minimum: 8, maximum: 40, step: 1 },
  editor_line_height: { minimum: 120, maximum: 220, step: 5 },
  editor_line_width: { minimum: 45, maximum: 120, step: 1 },
  autosave_delay_ms: { minimum: 100, maximum: 10_000, step: 100 },
  indent_width: { minimum: 1, maximum: 8, step: 1 },
  search_result_limit: { minimum: 1, maximum: 1000, step: 1 },
};

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
  id: string;
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
    id: "editor.wrap-long-lines",
    key: "wrap_long_lines",
    label: STRINGS.settingsWrapLongLines,
    description: STRINGS.settingsWrapLongLinesDescription,
  },
  {
    id: "editor.line-numbers",
    key: "show_line_numbers",
    label: STRINGS.settingsLineNumbers,
    description: STRINGS.settingsLineNumbersDescription,
  },
  {
    id: "editor.invisibles",
    key: "show_invisible_characters",
    label: STRINGS.settingsInvisibles,
    description: STRINGS.settingsInvisiblesDescription,
  },
  {
    id: "editor.reveal-syntax",
    key: "reveal_markdown_syntax",
    label: STRINGS.settingsRevealSyntax,
    description: STRINGS.settingsRevealSyntaxDescription,
  },
  {
    id: "editor.link-previews",
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
  targetSetting = null,
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
  targetSetting?: string | null;
} = $props();

let dialogElement = $state<HTMLElement | undefined>();
let contentElement = $state<HTMLElement | undefined>();
let jumpButtonElement = $state<HTMLButtonElement | undefined>();
let jumpMenuElement = $state<HTMLElement | undefined>();
const returnFocusElement =
  typeof document !== "undefined" &&
  document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
let searchQuery = $state("");
let jumpMenuOpen = $state(false);
let previewSettings = $state<Partial<SettingsDocument>>({});
let taskStatusError = $state<string | null>(null);
let openTaskListbox = $state<string | null>(null);
let editingNumericSetting = $state<NumericSetting | null>(null);
let numericDraft = $state("");
let numericPrevious = $state(0);
let systemPrefersDark = $state(false);
let focusedTargetSetting: string | null = null;

const documentSettings = $derived(settings.document);
const displayedSettings = $derived({
  ...documentSettings,
  ...previewSettings,
});
const searchScope = $derived<SearchScope>(
  documentSettings.search_note_bodies ? "full-text" : "titles",
);
const activePalette = $derived<LightPaletteName | DarkPaletteName>(
  documentSettings.theme === "dark" ||
    (documentSettings.theme === "system" && systemPrefersDark)
    ? (documentSettings.dark_palette as DarkPaletteName)
    : (documentSettings.light_palette as LightPaletteName),
);
const activePaletteCard = $derived(
  paletteCards.find(({ value }) => value === activePalette) ?? paletteCards[0],
);
const settingsPathText = $derived(
  desktopAvailable
    ? (settingsFilePath ?? STRINGS.settingsFileResolving)
    : STRINGS.settingsFileDesktopRequired,
);
const defaultNoteFolderDescription = $derived(
  desktopAvailable
    ? STRINGS.settingsDefaultNoteFolderDescription
    : STRINGS.settingsDefaultNoteFolderDesktopRequired,
);
const attachmentFolderDescription = $derived(
  desktopAvailable
    ? STRINGS.settingsAttachmentFolderDescription
    : STRINGS.settingsAttachmentFolderDesktopRequired,
);
const obsidianDescription = $derived(
  desktopAvailable
    ? STRINGS.settingsHonorObsidianDescription
    : STRINGS.settingsObsidianDesktopRequired,
);
const updateChannelDescription = $derived(
  desktopAvailable
    ? STRINGS.settingsUpdateChannelDescription
    : STRINGS.settingsUpdateChannelDesktopRequired,
);
const checkUpdatesDescription = $derived(
  desktopAvailable
    ? STRINGS.settingsCheckUpdatesDescription
    : STRINGS.settingsCheckUpdatesDesktopRequired,
);

onMount(() => {
  const query = window.matchMedia?.("(prefers-color-scheme: dark)");
  if (query === undefined) return;
  systemPrefersDark = query.matches;
  const onChange = (event: MediaQueryListEvent) => {
    systemPrefersDark = event.matches;
  };
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
});

$effect(() => {
  if (targetSetting !== null && focusedTargetSetting !== targetSetting) {
    focusedTargetSetting = targetSetting;
    void focusSetting(targetSetting);
  } else if (targetSetting === null) {
    dialogElement
      ?.querySelector<HTMLInputElement>("[data-testid='settings-search']")
      ?.focus();
  }
});

async function focusSetting(id: string) {
  searchQuery = "";
  await tick();
  const targetId = id === "updates.version" ? "about.version" : id;
  const row = contentElement?.querySelector<HTMLElement>(
    `[data-setting-id="${CSS.escape(targetId)}"]`,
  );
  if (contentElement === undefined || row === null || row === undefined) return;
  const contentBox = contentElement.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  contentElement.scrollTop += rowBox.top - contentBox.top;
  const control = row.querySelector<HTMLElement>(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]",
  );
  if (control !== null) {
    control.focus({ preventScroll: true });
  } else {
    row.tabIndex = -1;
    row.focus({ preventScroll: true });
  }
}

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

function paletteIsStoredChoice(card: PaletteCard): boolean {
  return card.mode === "light"
    ? documentSettings.light_palette === card.value
    : documentSettings.dark_palette === card.value;
}

function choosePalette(card: PaletteCard) {
  if (card.mode === "light") {
    update({
      theme: "light",
      light_palette: card.value as LightPaletteName,
    });
  } else {
    update({
      theme: "dark",
      dark_palette: card.value as DarkPaletteName,
    });
  }
}

async function paletteKeydown(event: KeyboardEvent, card: PaletteCard) {
  const index = paletteCards.indexOf(card);
  let nextIndex: number | null = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (index + 1) % paletteCards.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (index - 1 + paletteCards.length) % paletteCards.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = paletteCards.length - 1;
  }
  if (nextIndex === null) return;
  event.preventDefault();
  const next = paletteCards[nextIndex];
  if (next === undefined) return;
  choosePalette(next);
  await tick();
  dialogElement
    ?.querySelector<HTMLButtonElement>(
      `[data-testid="settings-palette-${next.value}"]`,
    )
    ?.focus();
}

function paletteMatches(): boolean {
  const paletteSearchTerms: readonly (readonly [string, string])[] = [
    [STRINGS.settingsPalette, STRINGS.settingsPaletteDescription],
    [STRINGS.settingsTheme, STRINGS.settingsThemeDescription],
    [STRINGS.settingsLightPalette, STRINGS.settingsPaletteDescription],
    [STRINGS.settingsDarkPalette, STRINGS.settingsPaletteDescription],
  ];
  return paletteSearchTerms.some(([label, description]) =>
    matches(label, description),
  );
}

async function startNumericEntry(setting: NumericSetting, value: number) {
  editingNumericSetting = setting;
  numericDraft = String(value);
  numericPrevious = value;
  await tick();
  const input = dialogElement?.querySelector<HTMLInputElement>(
    `[data-numeric-entry="${setting}"]`,
  );
  input?.focus();
  input?.select();
}

function snappedNumericValue(setting: NumericSetting, raw: string): number {
  const { minimum, maximum, step } = numericSettings[setting];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return numericPrevious;
  const clamped = Math.min(maximum, Math.max(minimum, parsed));
  return Math.min(
    maximum,
    Math.max(minimum, minimum + Math.round((clamped - minimum) / step) * step),
  );
}

async function finishNumericEntry(
  setting: NumericSetting,
  commit: boolean,
  restoreReadoutFocus = true,
) {
  if (editingNumericSetting !== setting) return;
  const value = commit
    ? snappedNumericValue(setting, numericDraft)
    : numericPrevious;
  editingNumericSetting = null;
  if (commit) {
    const nextPreview = { ...previewSettings };
    delete nextPreview[setting];
    previewSettings = nextPreview;
    update({ [setting]: value });
  }
  if (restoreReadoutFocus) {
    await tick();
    dialogElement
      ?.querySelector<HTMLButtonElement>(`[data-numeric-readout="${setting}"]`)
      ?.focus();
  }
}

function numericEntryKeydown(event: KeyboardEvent, setting: NumericSetting) {
  event.stopPropagation();
  if (event.key === "Enter") {
    event.preventDefault();
    void finishNumericEntry(setting, true);
  } else if (event.key === "Escape") {
    event.preventDefault();
    void finishNumericEntry(setting, false);
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
  update({ task_statuses: statuses.map(taskStatusDocument) });
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
      track: "reference",
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

function taskPayloadLabel(payload: TaskPayloadKind | undefined): string {
  if (payload === "date") return STRINGS.settingsTaskPayloadDate;
  if (payload === "level") return STRINGS.settingsTaskPayloadLevel;
  return STRINGS.settingsTaskPayloadNone;
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
  updateTaskStatus(index, {
    [field]: field === "payload" && value === "none" ? undefined : value,
  } as Partial<TaskStatus>);
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
  if (
    settingSearchText[section].some(([label, description]) =>
      matches(label, description),
    )
  ) {
    return true;
  }
  if (desktopAvailable) return false;
  const desktopDescriptions: Partial<Record<SectionId, [string, string][]>> = {
    files: [
      [STRINGS.settingsDefaultNoteFolder, defaultNoteFolderDescription],
      [STRINGS.settingsAttachmentFolder, attachmentFolderDescription],
      [STRINGS.settingsHonorObsidian, obsidianDescription],
    ],
    updates: [
      [STRINGS.settingsUpdateChannel, updateChannelDescription],
      [STRINGS.settingsCheckUpdates, checkUpdatesDescription],
    ],
  };
  return (desktopDescriptions[section] ?? []).some(([label, description]) =>
    matches(label, description),
  );
}

async function openJumpMenu() {
  jumpMenuOpen = true;
  await tick();
  jumpMenuElement
    ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
    ?.focus();
}

function onJumpButtonKeydown(event: KeyboardEvent) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  void openJumpMenu();
}

async function closeJumpMenu() {
  jumpMenuOpen = false;
  await tick();
  jumpButtonElement?.focus();
}

async function jumpToSection(section: SectionId) {
  jumpMenuOpen = false;
  await tick();
  const target = contentElement?.querySelector<HTMLElement>(
    `[data-settings-section="${section}"]`,
  );
  if (contentElement !== undefined && target !== null && target !== undefined) {
    const contentBox = contentElement.getBoundingClientRect();
    const targetBox = target.getBoundingClientRect();
    contentElement.scrollTop += targetBox.top - contentBox.top;
  }
  jumpButtonElement?.focus();
}

function onJumpMenuKeydown(event: KeyboardEvent) {
  if (jumpMenuElement === undefined) return;
  const items = [
    ...jumpMenuElement.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
  ];
  const index = items.indexOf(event.target as HTMLButtonElement);
  if ((event.key === "Enter" || event.key === " ") && index >= 0) {
    event.preventDefault();
    items[index]?.click();
    return;
  }
  let nextIndex: number | null = null;
  if (event.key === "ArrowDown") nextIndex = (index + 1) % items.length;
  else if (event.key === "ArrowUp")
    nextIndex = (index - 1 + items.length) % items.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = items.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  items[nextIndex]?.focus();
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
    if (jumpMenuOpen) void closeJumpMenu();
    else closeSettings();
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
  if (jumpMenuOpen && jumpMenuElement !== undefined) {
    const menuFocusable = [
      ...jumpMenuElement.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const menuFirst = menuFocusable[0];
    const menuLast = menuFocusable.at(-1);
    if (menuFirst === undefined || menuLast === undefined) {
      event.preventDefault();
      jumpMenuElement.focus();
    } else if (event.shiftKey && document.activeElement === menuFirst) {
      event.preventDefault();
      menuLast.focus();
    } else if (!event.shiftKey && document.activeElement === menuLast) {
      event.preventDefault();
      menuFirst.focus();
    }
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

{#snippet palettePreview(
  label: string,
  palette: LightPaletteName | DarkPaletteName,
)}
  <div
    class="palette-live-preview skr-palette-swatch"
    data-palette={palette}
    data-testid="settings-palette-preview"
  >
    <strong class="palette-live-heading">{label}</strong>
    <div class="palette-live-rule" aria-hidden="true"></div>
    <p class="palette-live-body">
      {STRINGS.settingsPalettePreviewBeforeLink}<a href="#settings-appearance-heading"
        >{STRINGS.settingsPalettePreviewLink}</a
      >{STRINGS.settingsPalettePreviewAfterLink}
      <code>{STRINGS.settingsPalettePreviewCode}</code>
    </p>
    <div class="palette-live-task">
      <span class="palette-live-box" aria-hidden="true"></span>
      <span>{STRINGS.settingsPalettePreviewUncheckedTask}</span>
    </div>
    <div class="palette-live-task palette-live-task-complete">
      <span class="palette-live-box" aria-hidden="true">✓</span>
      <span>{STRINGS.settingsPalettePreviewCheckedTask}</span>
    </div>
  </div>
{/snippet}

{#snippet paletteCard(card: PaletteCard)}
  <button
    type="button"
    class="palette-card skr-palette-swatch"
    class:active={activePalette === card.value}
    class:paired={documentSettings.theme === "system" &&
      paletteIsStoredChoice(card) &&
      activePalette !== card.value}
    role="radio"
    aria-checked={activePalette === card.value}
    tabindex={activePalette === card.value ? 0 : -1}
    data-palette={card.value}
    data-testid={`settings-palette-${card.value}`}
    onclick={() => choosePalette(card)}
    onkeydown={(event) => paletteKeydown(event, card)}
  >
    <strong>{card.label}</strong>
    <span class="palette-card-dot" aria-hidden="true"></span>
  </button>
{/snippet}

{#snippet numericReadout(
  setting: NumericSetting,
  value: number,
  unit: string,
  label: string,
)}
  {#if editingNumericSetting === setting}
    <input
      class="numeric-entry"
      type="number"
      inputmode="numeric"
      min={numericSettings[setting].minimum}
      max={numericSettings[setting].maximum}
      step={numericSettings[setting].step}
      value={numericDraft}
      aria-label={label}
      data-numeric-entry={setting}
      data-testid={`settings-${setting.replaceAll("_", "-")}-entry`}
      oninput={(event) =>
        (numericDraft = (event.currentTarget as HTMLInputElement).value)}
      onkeydown={(event) => numericEntryKeydown(event, setting)}
      onblur={() => finishNumericEntry(setting, true, false)}
    />
  {:else}
    <button
      class="numeric-readout"
      type="button"
      data-numeric-readout={setting}
      data-testid={`settings-${setting.replaceAll("_", "-")}-readout`}
      aria-label={`${label}: ${value} ${unit}`}
      onclick={() => startNumericEntry(setting, value)}
    >{value}{unit === STRINGS.settingsUnitPercent ? "" : " "}{unit}</button>
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
    <div class="settings-header" inert={jumpMenuOpen ? true : undefined}>
      <div class="settings-header-primary">
        <h2>{STRINGS.settingsLabel}</h2>
        <button
          class="icon-button"
          type="button"
          aria-label={STRINGS.closeAction}
          onclick={closeSettings}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
      <div class="settings-header-tools">
        <label class="settings-search">
          <span class="visually-hidden">{STRINGS.settingsSearchLabel}</span>
          <input
            bind:value={searchQuery}
            data-testid="settings-search"
            type="search"
            placeholder={STRINGS.settingsSearchPlaceholder}
          />
        </label>
        <button
          bind:this={jumpButtonElement}
          class="jump-button"
          type="button"
          aria-label={STRINGS.settingsJumpSections}
          aria-haspopup="menu"
          aria-expanded={jumpMenuOpen}
          data-testid="settings-jump"
          onclick={openJumpMenu}
          onkeydown={onJumpButtonKeydown}
        >
          <span aria-hidden="true">⋯</span>
        </button>
      </div>
    </div>

    {#if jumpMenuOpen}
      <div
        class="settings-jump-layer"
        role="presentation"
        onclick={(event) =>
          event.target === event.currentTarget && void closeJumpMenu()}
      >
        <div
          bind:this={jumpMenuElement}
          class="settings-jump-menu"
          tabindex="-1"
          data-testid="settings-jump-menu"
        >
          <div class="settings-jump-heading">
            <span>{STRINGS.settingsJumpSections}</span>
            <button type="button" onclick={closeJumpMenu}
              >{STRINGS.closeAction}</button
            >
          </div>
          <div
            class="settings-jump-items"
            role="menu"
            aria-label={STRINGS.settingsSectionsLabel}
            tabindex="-1"
            onkeydown={onJumpMenuKeydown}
          >
            {#each sections as section}
              <button
                type="button"
                role="menuitem"
                onclick={() => jumpToSection(section.id)}
                >{section.label}</button
              >
            {/each}
          </div>
        </div>
      </div>
    {/if}

    <div
      bind:this={contentElement}
      class="settings-content"
      inert={jumpMenuOpen ? true : undefined}
    >
        {#if hasMatches("appearance")}
          <section
            aria-labelledby="settings-appearance-heading"
            data-settings-section="appearance"
          >
            <h3 id="settings-appearance-heading">
              {STRINGS.settingsSectionAppearance}
            </h3>

            {#if paletteMatches()}
              <div class="setting-row palette-setting">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsPalette}</span>
                  <p>{STRINGS.settingsPaletteDescription}</p>
                  {@render settingError(["theme", "light_palette", "dark_palette"])}
                </div>
                <div class="palette-picker">
                  <div
                    class="palette-options"
                    role="radiogroup"
                    aria-label={STRINGS.settingsPalette}
                    data-testid="settings-palette"
                  >
                    <span
                      class="palette-target"
                      data-setting-id="appearance.light-palette"
                    >
                      {#each paletteCards.filter(({ mode }) => mode === "light") as card}
                        {@render paletteCard(card)}
                      {/each}
                    </span>
                    <span
                      class="palette-target"
                      data-setting-id="appearance.dark-palette"
                    >
                      {#each paletteCards.filter(({ mode }) => mode === "dark") as card}
                        {@render paletteCard(card)}
                      {/each}
                    </span>
                  </div>
                  <label
                    class="match-system-setting"
                    data-setting-id="appearance.theme"
                  >
                    <span class="setting-copy">
                      <span class="setting-label">{STRINGS.settingsTheme}</span>
                      <span>{STRINGS.settingsThemeDescription}</span>
                    </span>
                    <span class="switch">
                      <input
                        type="checkbox"
                        checked={documentSettings.theme === "system"}
                        data-testid="settings-match-system"
                        onchange={(event) =>
                          update({
                            theme: (
                              event.currentTarget as HTMLInputElement
                            ).checked
                              ? "system"
                              : systemPrefersDark
                                ? "dark"
                                : "light",
                          })}
                      />
                      <span aria-hidden="true"></span>
                    </span>
                  </label>
                  {@render palettePreview(
                    activePaletteCard?.label ?? STRINGS.settingsPaletteManuscript,
                    activePalette,
                  )}
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsProseFont, STRINGS.settingsProseFontDescription)}
              <div class="setting-row" data-setting-id="appearance.prose-font">
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
              <div class="setting-row" data-setting-id="appearance.code-font">
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
              <div class="setting-row" data-setting-id="appearance.font-size">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsFontSize}</span>
                  <span>{STRINGS.settingsFontSizeDescription}</span>
                  {@render settingError(["editor_font_size"])}
                </div>
                <div class="slider-control">
                  <input
                    type="range"
                    aria-label={STRINGS.settingsFontSize}
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
                  {@render numericReadout(
                    "editor_font_size",
                    displayedSettings.editor_font_size,
                    STRINGS.settingsUnitPixels,
                    STRINGS.settingsFontSize,
                  )}
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsLineHeight, STRINGS.settingsLineHeightDescription)}
              <div class="setting-row" data-setting-id="appearance.line-height">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsLineHeight}</span>
                  <span>{STRINGS.settingsLineHeightDescription}</span>
                  {@render settingError(["editor_line_height"])}
                </div>
                <div class="slider-control">
                  <input
                    type="range"
                    aria-label={STRINGS.settingsLineHeight}
                    min="120"
                    max="220"
                    step="5"
                    value={displayedSettings.editor_line_height}
                    oninput={(event) =>
                      previewNumber(event, "editor_line_height", 120, 220)}
                    onchange={(event) =>
                      inputNumber(event, "editor_line_height", 120, 220)}
                  />
                  {@render numericReadout(
                    "editor_line_height",
                    displayedSettings.editor_line_height,
                    STRINGS.settingsUnitPercent,
                    STRINGS.settingsLineHeight,
                  )}
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsLineWidth, STRINGS.settingsLineWidthDescription)}
              <div class="setting-row" data-setting-id="appearance.line-width">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsLineWidth}</span>
                  <span>{STRINGS.settingsLineWidthDescription}</span>
                  {@render settingError(["editor_line_width"])}
                </div>
                <div class="slider-control">
                  <input
                    type="range"
                    aria-label={STRINGS.settingsLineWidth}
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
                  {@render numericReadout(
                    "editor_line_width",
                    displayedSettings.editor_line_width,
                    STRINGS.settingsUnitCharacters,
                    STRINGS.settingsLineWidth,
                  )}
                </div>
              </div>
            {/if}

            {#if matches(STRINGS.settingsAnimations, STRINGS.settingsAnimationsDescription)}
              <label class="setting-row" data-setting-id="appearance.animations">
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

        {#if hasMatches("editor")}
          <section
            aria-labelledby="settings-editor-heading"
            data-settings-section="editor"
          >
            <h3 id="settings-editor-heading">
              {STRINGS.settingsSectionEditor}
            </h3>

            {#if matches(STRINGS.settingsAutosave, STRINGS.settingsAutosaveDescription)}
              <div class="setting-row" data-setting-id="editor.autosave">
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
                  {@render numericReadout(
                    "autosave_delay_ms",
                    documentSettings.autosave_delay_ms,
                    STRINGS.settingsUnitMilliseconds,
                    STRINGS.settingsAutosave,
                  )}
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
              <label class="setting-row" data-setting-id="editor.spell-check">
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
              <div class="setting-row" data-setting-id="editor.indent-style">
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
              <div class="setting-row" data-setting-id="editor.indent-width">
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
                  {@render numericReadout(
                    "indent_width",
                    documentSettings.indent_width,
                    STRINGS.settingsUnitSpaces,
                    STRINGS.settingsIndentWidth,
                  )}
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
                <label class="setting-row" data-setting-id={preference.id}>
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
              <div class="task-status-setting" data-setting-id="editor.task-statuses">
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
                      <span>{STRINGS.settingsTaskTrack}</span>
                      <span>{STRINGS.settingsTaskPayload}</span>
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
                            aria-label={`${STRINGS.settingsTaskTrack}: ${taskStatusDisplayName(status)}`}
                            aria-haspopup="listbox"
                            aria-expanded={openTaskListbox === taskListboxKey(index, "track")}
                            data-task-listbox-trigger={taskListboxKey(index, "track")}
                            data-testid="task-status-track"
                            onclick={() => toggleTaskListbox(index, "track")}
                            onkeydown={(event) => handleTaskListboxTrigger(event, index, "track")}
                          >{taskTrackLabel(taskStatusTrack(status))}</button>
                          {#if openTaskListbox === taskListboxKey(index, "track")}
                            <div
                              class="task-listbox-options"
                              role="listbox"
                              aria-label={`${STRINGS.settingsTaskTrack}: ${taskStatusDisplayName(status)}`}
                              data-task-listbox={taskListboxKey(index, "track")}
                            >
                              {#each TASK_TRACKS as track}
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={taskStatusTrack(status) === track}
                                  tabindex="-1"
                                  onclick={() => chooseTaskListboxOption(index, "track", track)}
                                  onkeydown={handleTaskListboxOption}
                                >{taskTrackLabel(track)}</button>
                              {/each}
                            </div>
                          {/if}
                        </div>
                        <div class="task-listbox-control">
                          <button
                            type="button"
                            class="text-control task-listbox-trigger"
                            aria-label={`${STRINGS.settingsTaskPayload}: ${taskStatusDisplayName(status)}`}
                            aria-haspopup="listbox"
                            aria-expanded={openTaskListbox === taskListboxKey(index, "payload")}
                            data-task-listbox-trigger={taskListboxKey(index, "payload")}
                            data-testid="task-status-payload"
                            onclick={() => toggleTaskListbox(index, "payload")}
                            onkeydown={(event) => handleTaskListboxTrigger(event, index, "payload")}
                          >{taskPayloadLabel(taskStatusPayload(status))}</button>
                          {#if openTaskListbox === taskListboxKey(index, "payload")}
                            <div
                              class="task-listbox-options"
                              role="listbox"
                              aria-label={`${STRINGS.settingsTaskPayload}: ${taskStatusDisplayName(status)}`}
                              data-task-listbox={taskListboxKey(index, "payload")}
                            >
                              <button
                                type="button"
                                role="option"
                                aria-selected={taskStatusPayload(status) === undefined}
                                tabindex="-1"
                                onclick={() => chooseTaskListboxOption(index, "payload", "none")}
                                onkeydown={handleTaskListboxOption}
                              >{STRINGS.settingsTaskPayloadNone}</button>
                              {#each TASK_PAYLOAD_KINDS as payload}
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={taskStatusPayload(status) === payload}
                                  tabindex="-1"
                                  onclick={() => chooseTaskListboxOption(index, "payload", payload)}
                                  onkeydown={handleTaskListboxOption}
                                >{taskPayloadLabel(payload)}</button>
                              {/each}
                            </div>
                          {/if}
                        </div>
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

        {#if hasMatches("files")}
          <section
            aria-labelledby="settings-files-heading"
            data-settings-section="files"
          >
            <h3 id="settings-files-heading">
              {STRINGS.settingsSectionFiles}
            </h3>
            <fieldset disabled={!desktopAvailable}>
              {#if matches(STRINGS.settingsDefaultNoteFolder, defaultNoteFolderDescription)}
                <label class="setting-row" data-setting-id="files.default-note-folder">
                  <span class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsDefaultNoteFolder}</span>
                    <span>{defaultNoteFolderDescription}</span>
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

              {#if matches(STRINGS.settingsAttachmentFolder, attachmentFolderDescription)}
                <div class="setting-row attachment-setting" data-setting-id="files.attachment-folder">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsAttachmentFolder}</span>
                    <p>{attachmentFolderDescription}</p>
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

              {#if matches(STRINGS.settingsHonorObsidian, obsidianDescription)}
                <label class="setting-row" data-setting-id="files.obsidian-config">
                  <span class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsHonorObsidian}</span>
                    <span>{obsidianDescription}</span>
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

        {#if hasMatches("search")}
          <section
            aria-labelledby="settings-search-heading"
            data-settings-section="search"
          >
            <h3 id="settings-search-heading">
              {STRINGS.settingsSectionSearch}
            </h3>
            {#if matches(STRINGS.settingsSearchLimit, STRINGS.settingsSearchLimitDescription)}
              <div class="setting-row" data-setting-id="search.result-limit">
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
                  {@render numericReadout(
                    "search_result_limit",
                    documentSettings.search_result_limit,
                    STRINGS.settingsUnitResults,
                    STRINGS.settingsSearchLimit,
                  )}
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
              <div class="setting-row" data-setting-id="search.note-text">
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
              <label class="setting-row" data-setting-id="search.case-sensitive">
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

        {#if hasMatches("updates")}
          <section
            aria-labelledby="settings-updates-heading"
            data-settings-section="updates"
          >
            <h3 id="settings-updates-heading">
              {STRINGS.settingsSectionUpdates}
            </h3>
            <fieldset disabled={!desktopAvailable}>
              {#if matches(STRINGS.settingsUpdateChannel, updateChannelDescription)}
                <div class="setting-row" data-setting-id="updates.channel">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsUpdateChannel}</span>
                    <p>{updateChannelDescription}</p>
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

              {#if matches(STRINGS.settingsCheckUpdates, checkUpdatesDescription)}
                <div class="setting-row" data-setting-id="updates.check">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsCheckUpdates}</span>
                    <p>{checkUpdatesDescription}</p>
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
            </fieldset>
          </section>
        {/if}

        {#if hasMatches("about")}
          <section
            aria-labelledby="settings-about-heading"
            data-settings-section="about"
          >
            <h3 id="settings-about-heading">
              {STRINGS.settingsSectionAbout}
            </h3>
            {#if matches(STRINGS.settingsVersion, STRINGS.settingsVersionDescription)}
              <div class="setting-row" data-setting-id="about.version">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsVersion}</span>
                  <p>{STRINGS.settingsVersionDescription}</p>
                </div>
                <output tabindex="-1">{currentVersion}</output>
              </div>
            {/if}
            {#if matches(STRINGS.settingsLicense, STRINGS.settingsLicenseDescription)}
              <div class="setting-row" data-setting-id="about.license">
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
              <div class="setting-row" data-setting-id="about.repository">
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
              <div class="setting-row" data-setting-id="about.security-policy">
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
              <div class="setting-row" data-setting-id="about.settings-file">
                <div class="setting-copy">
                  <span class="setting-label">{STRINGS.settingsFile}</span>
                  <p>{STRINGS.settingsFileDescription}</p>
                </div>
                <output
                  class="settings-path"
                  class:desktop-unavailable={!desktopAvailable}
                  tabindex="-1"
                  >{settingsPathText}</output
                >
              </div>
            {/if}
            <p class="prealpha-note">{STRINGS.settingsPreAlphaNote}</p>
          </section>
        {/if}
    </div>

    <footer
      class="settings-footer"
      inert={jumpMenuOpen ? true : undefined}
    >
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
    height: min(85vh, 48rem);
    max-height: calc(100vh - 2rem);
    outline: none;
    overflow: hidden;
    position: relative;
    width: min(48rem, calc(100vw - 2rem));
  }

  .settings-footer {
    align-items: center;
    display: flex;
    flex: none;
    justify-content: space-between;
  }

  .settings-header {
    border-bottom: 1px solid var(--skr-border);
    flex: none;
    padding: 0.625rem 1.125rem;
  }

  .settings-header-primary,
  .settings-header-tools,
  .settings-jump-heading {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .settings-header-primary {
    min-height: 2.75rem;
  }

  .settings-header-primary .icon-button {
    font-size: 1.125rem;
    height: 2.75rem;
    padding: 0;
    width: 2.75rem;
  }

  .settings-header-tools {
    gap: 0.5rem;
  }

  .settings-header h2 {
    font-size: 1rem;
    margin: 0;
  }

  .setting-copy p,
  .setting-copy > span:last-child {
    color: var(--skr-text-muted);
    font-size: 0.75rem;
    line-height: 1.4;
    margin: 0.2rem 0 0;
  }

  .settings-error,
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

  .visually-hidden {
    clip: rect(0 0 0 0);
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  .settings-search {
    flex: 1;
    min-width: 0;
  }

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
    min-height: 2.75rem;
    width: 100%;
  }

  .jump-button,
  .settings-jump-menu button,
  .icon-button,
  .secondary-button,
  .segmented button,
  .palette-options button,
  .numeric-readout,
  .stepper button {
    background: transparent;
    border: 1px solid transparent;
    color: var(--skr-text);
    cursor: pointer;
    font: inherit;
  }

  .jump-button {
    align-items: center;
    border-color: var(--skr-border-strong);
    border-radius: 0.35rem;
    display: flex;
    flex: 0 0 2.75rem;
    font-size: 1.25rem;
    height: 2.75rem;
    justify-content: center;
    padding: 0;
    width: 2.75rem;
  }

  .jump-button:hover,
  .settings-jump-menu button:hover,
  .icon-button:hover,
  .secondary-button:hover {
    background: var(--skr-surface-subtle);
  }

  .settings-jump-layer {
    inset: 0;
    position: absolute;
    z-index: 3;
  }

  .settings-jump-menu {
    background: var(--skr-surface-raised);
    border: 1px solid var(--skr-border);
    border-radius: 0.375rem;
    box-shadow: var(--skr-shadow);
    display: grid;
    padding: 0.5rem;
    position: absolute;
    right: 1.125rem;
    top: 6.75rem;
    width: 14rem;
  }

  .settings-jump-items {
    display: grid;
  }

  .settings-jump-heading {
    color: var(--skr-text-muted);
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0 0 0.5rem 0.5rem;
  }

  .settings-jump-heading button,
  .settings-jump-items > button {
    border: 1px solid transparent;
    border-radius: 0.35rem;
    min-height: 2.75rem;
  }

  .settings-jump-heading button {
    padding-inline: 0.75rem;
  }

  .settings-jump-items > button {
    padding: 0.5rem 0.75rem;
    text-align: left;
  }

  .settings-content {
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    padding: 1rem 1.125rem 1.5rem;
    scrollbar-gutter: stable;
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
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
  }

  .palette-target {
    display: contents;
  }

  .palette-options .palette-card {
    align-items: center;
    background: var(--skr-surface);
    border: 1px solid var(--skr-border);
    border-radius: 0.375rem;
    box-sizing: border-box;
    color: var(--skr-heading);
    display: flex;
    font-family: var(--skr-font-prose);
    justify-content: space-between;
    min-height: 2.75rem;
    min-width: 0;
    padding: 0.5rem 0.75rem;
    text-align: left;
  }

  .palette-card:hover {
    background: var(--skr-surface);
  }

  .palette-card.active {
    border-color: var(--skr-accent);
    border-width: 2px;
  }

  .palette-card.paired {
    border-color: var(--skr-border-strong);
    border-width: 2px;
  }

  .palette-card strong {
    color: var(--skr-heading);
    font-size: 0.875rem;
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .palette-card-dot {
    background: var(--skr-accent);
    border-radius: 50%;
    flex: 0 0 0.5rem;
    height: 0.5rem;
    margin-left: 0.5rem;
    width: 0.5rem;
  }

  .palette-live-preview {
    background: var(--skr-surface);
    border: 1px solid var(--skr-border);
    border-radius: 0.375rem;
    color: var(--skr-text);
    display: grid;
    font-family: var(--skr-font-prose);
    gap: 0.5rem;
    margin-top: 0.5rem;
    padding: 1rem;
  }

  .match-system-setting {
    align-items: center;
    border-bottom: 1px solid var(--skr-border);
    display: grid;
    gap: 1rem;
    grid-template-columns: minmax(0, 1fr) auto;
    min-height: 2.75rem;
    padding: 0.75rem 0;
  }

  .palette-live-heading {
    color: var(--skr-heading);
    font-size: 1.25rem;
    font-weight: 700;
  }

  .palette-live-rule {
    border-top: 1px solid var(--skr-border);
    margin-top: 0;
  }

  .palette-live-body {
    color: var(--skr-text);
    font-size: 0.8125rem;
    font-weight: 400;
    line-height: 1.4;
    margin: 0;
  }

  .palette-live-body a {
    color: var(--skr-link);
    font-size: inherit;
    text-decoration: underline;
    text-underline-offset: 0.15em;
  }

  .palette-live-body code {
    background: var(--skr-code-surface);
    border-radius: 0.2rem;
    font-family: var(--skr-font-mono);
    padding: 0.1rem 0.25rem;
  }

  .palette-live-task {
    align-items: center;
    color: var(--skr-text);
    display: flex;
    font-size: 0.8125rem;
    gap: 0.5rem;
  }

  .palette-live-box {
    align-items: center;
    border: 1px solid var(--skr-border-strong);
    border-radius: 0.2rem;
    display: flex;
    flex: 0 0 0.875rem;
    font-family: var(--skr-font-interface);
    font-size: 0.7rem;
    height: 0.875rem;
    justify-content: center;
    line-height: 1;
    width: 0.875rem;
  }

  .palette-live-task-complete {
    color: var(--skr-text-muted);
    text-decoration: line-through;
  }

  .palette-live-task-complete .palette-live-box {
    background: var(--skr-accent);
    border-color: var(--skr-accent);
    color: var(--skr-surface);
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

  .numeric-readout,
  .numeric-entry {
    background: var(--skr-surface-subtle);
    border: 1px solid transparent;
    border-radius: 0.25rem;
    box-sizing: border-box;
    color: var(--skr-text);
    font-family: var(--skr-font-interface);
    font-size: 0.8125rem;
    min-height: 1.75rem;
    padding: 0.25rem 0.4rem;
    text-align: center;
    width: 5.5rem;
  }

  .numeric-readout {
    cursor: pointer;
    white-space: nowrap;
  }

  .numeric-readout:hover {
    background: var(--skr-accent-subtle);
  }

  .numeric-entry {
    border-color: var(--skr-border-strong);
    font-variant-numeric: tabular-nums;
    width: 5ch;
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

  .stepper .numeric-readout,
  .stepper .numeric-entry {
    align-items: center;
    background: transparent;
    border-bottom: 0;
    border-left: 1px solid var(--skr-border);
    border-radius: 0;
    border-right: 1px solid var(--skr-border);
    border-top: 0;
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
      3.5rem minmax(8rem, 1.2fr) 7rem 8rem 8rem 4rem minmax(9rem, 1fr)
      minmax(9rem, 1fr) 6.5rem;
    min-width: 66rem;
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

  fieldset:disabled :is(button, input) {
    opacity: 0.62;
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

    .settings-header {
      padding-top: calc(0.625rem + env(safe-area-inset-top));
    }

    .settings-jump-layer {
      background: var(--skr-overlay);
    }

    .settings-jump-menu {
      border-bottom: 0;
      border-radius: 0.75rem 0.75rem 0 0;
      bottom: 0;
      left: 0;
      max-height: 80%;
      overflow-y: auto;
      padding-bottom: calc(0.5rem + env(safe-area-inset-bottom));
      right: 0;
      top: auto;
      width: auto;
    }

    .setting-row {
      align-items: start;
      grid-template-columns: 1fr;
    }

    .match-system-setting {
      grid-template-columns: minmax(0, 1fr) auto;
    }

    .slider-control {
      grid-template-columns: minmax(0, 1fr) 5.5rem;
      width: 100%;
    }

    .settings-footer span {
      display: none;
    }

    .settings-footer {
      padding-bottom: calc(0.65rem + env(safe-area-inset-bottom));
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
