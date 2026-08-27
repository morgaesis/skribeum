<script module lang="ts">
import type { SettingSectionId as SessionSectionId } from "./features/settingsCatalog";

/**
 * The group the surface was last showing. Selection survives a close and
 * reopen within one session and is deliberately not written to the settings
 * document: a fresh session opens on Appearance.
 */
let sessionSection: SessionSectionId | null = "appearance";
</script>

<script lang="ts">
import { onDestroy, onMount, tick } from "svelte";
import {
  SETTINGS_DESCRIPTORS,
  type SettingSectionId,
  settingSearchTerms,
} from "./features/settingsCatalog";
import { matchesSearchTerms } from "./fuzzy";
import {
  DEFAULT_SETTINGS,
  type SettingsDocument,
  type SettingsState,
} from "./features/settingsStore";
import { describeUpdateState, type UpdateState } from "./features/updates";
import { enterMotionSurface, exitMotionSurfaces } from "./motion";
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

/**
 * The width, measured on the surface itself rather than the viewport, below
 * which the rail cannot be carved out without pushing rows under their own
 * floor: 8rem of rail, a hairline, the pane's padding and the 31rem row
 * minimum below, rounded up to the next whole rem.
 */
const RAIL_BREAKPOINT = 672;
/**
 * The width a content pane needs before a row can set its copy and its
 * control side by side: 16rem of copy, 1rem of gap and the 14rem
 * slider-and-readout block. Keyed to the pane, never to the viewport.
 */
const ROW_SIDE_BY_SIDE_WIDTH = 496;
/** The rail's fixed 8rem plus the hairline that separates it from the pane. */
const RAIL_AND_HAIRLINE_WIDTH = 129;

/**
 * Every row the pane renders, in render order, with the settings-document
 * fields it owns. A row with no fields (the version output, the About links,
 * the settings file path) has no default to differ from: it never carries a
 * changed bar, never contributes to a group's dot, and never offers a reset.
 * The search's match counts and the results view are both driven from here,
 * so a facet count and the rows it stands for cannot disagree.
 */
type SettingRow = {
  id: string;
  label: string;
  description: string;
  keys: readonly (keyof SettingsDocument)[];
};

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
    value: "nightroom",
    mode: "dark",
    label: STRINGS.settingsPaletteNightroom,
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

type ThemeName = SettingsDocument["theme"];

type ModeCard = { value: ThemeName; label: string };

/**
 * The three colour schemes, each rendered as the shell the application
 * resolves to in that scheme rather than as a label naming it. System shows
 * both halves of its pair at once, so it reads as a first-class choice
 * instead of a toggle a reader has to know to look for.
 */
const modeCards: ModeCard[] = [
  { value: "system", label: STRINGS.settingsThemeSystem },
  { value: "light", label: STRINGS.settingsThemeLight },
  { value: "dark", label: STRINGS.settingsThemeDark },
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
  onInstallUpdate = () => {},
  onRestartUpdate = () => {},
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
  onInstallUpdate?: () => void;
  onRestartUpdate?: () => void;
  targetSetting?: string | null;
} = $props();

let dialogElement = $state<HTMLElement | null>();
let backdropElement = $state<HTMLElement | null>();
let contentElement = $state<HTMLElement | null>();
let railElement = $state<HTMLElement | null>();
let paneElement = $state<HTMLElement | null>();
let closing = false;
const returnFocusElement =
  typeof document !== "undefined" &&
  document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
let searchQuery = $state("");
/**
 * The surface's own width. It starts at the desktop dialog's geometry so the
 * first painted frame is the one the reader almost always gets; the observer
 * below corrects it the moment layout resolves.
 */
let surfaceWidth = $state(896);
let selectedSection = $state<SectionId | null>(sessionSection);
/** The group the results narrow to while a facet is active. */
let narrowedSection = $state<SectionId | null>(null);
let restoreSection: SectionId | null = null;
let restoreScrollTop = 0;
let railIndicatorTop = $state(0);
let railIndicatorHeight = $state(0);
let paneMotion = $state<"fade" | "drill-push" | "drill-pop">("fade");
let previewPalette = $state<LightPaletteName | DarkPaletteName | null>(null);
let previewSettings = $state<Partial<SettingsDocument>>({});
let enteredPaneKey: string | null = null;
let scrollAnchor: ScrollAnchor = null;
let anchorFrame = 0;
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
/** The half of the pair the shell is painting with right now. */
const resolvedScheme = $derived<"light" | "dark">(
  documentSettings.theme === "dark" ||
    (documentSettings.theme === "system" && systemPrefersDark)
    ? "dark"
    : "light",
);
const activePalette = $derived<LightPaletteName | DarkPaletteName>(
  resolvedScheme === "dark"
    ? (documentSettings.dark_palette as DarkPaletteName)
    : (documentSettings.light_palette as LightPaletteName),
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

const sectionRows = $derived<Record<SectionId, SettingRow[]>>({
  appearance: [
    {
      id: "appearance.theme",
      label: STRINGS.settingsTheme,
      description: STRINGS.settingsThemeDescription,
      keys: ["theme"],
    },
    {
      id: "appearance.palette",
      label: `${STRINGS.settingsPalette} ${STRINGS.settingsLightPalette} ${STRINGS.settingsDarkPalette}`,
      description: STRINGS.settingsPaletteDescription,
      keys: ["light_palette", "dark_palette"],
    },
    {
      id: "appearance.prose-font",
      label: STRINGS.settingsProseFont,
      description: STRINGS.settingsProseFontDescription,
      keys: ["prose_font"],
    },
    {
      id: "appearance.code-font",
      label: STRINGS.settingsCodeFont,
      description: STRINGS.settingsCodeFontDescription,
      keys: ["code_font"],
    },
    {
      id: "appearance.font-size",
      label: STRINGS.settingsFontSize,
      description: STRINGS.settingsFontSizeDescription,
      keys: ["editor_font_size"],
    },
    {
      id: "appearance.line-height",
      label: STRINGS.settingsLineHeight,
      description: STRINGS.settingsLineHeightDescription,
      keys: ["editor_line_height"],
    },
    {
      id: "appearance.line-width",
      label: STRINGS.settingsLineWidth,
      description: STRINGS.settingsLineWidthDescription,
      keys: ["editor_line_width"],
    },
    {
      id: "appearance.animations",
      label: STRINGS.settingsAnimations,
      description: STRINGS.settingsAnimationsDescription,
      keys: ["animations"],
    },
  ],
  editor: [
    {
      id: "editor.autosave",
      label: STRINGS.settingsAutosave,
      description: STRINGS.settingsAutosaveDescription,
      keys: ["autosave_delay_ms"],
    },
    {
      id: "editor.spell-check",
      label: STRINGS.settingsSpellCheck,
      description: STRINGS.settingsSpellCheckDescription,
      keys: ["spell_check"],
    },
    {
      id: "editor.indent-style",
      label: STRINGS.settingsIndentStyle,
      description: STRINGS.settingsIndentStyleDescription,
      keys: ["indent_style"],
    },
    {
      id: "editor.indent-width",
      label: STRINGS.settingsIndentWidth,
      description: STRINGS.settingsIndentWidthDescription,
      keys: ["indent_width"],
    },
    ...booleanEditorSettings.map((preference) => ({
      id: preference.id,
      label: preference.label,
      description: preference.description,
      keys: [preference.key] as const,
    })),
    {
      id: "editor.task-statuses",
      label: STRINGS.settingsTaskStatuses,
      description: STRINGS.settingsTaskStatusesDescription,
      keys: ["task_statuses"],
    },
  ],
  files: [
    {
      id: "files.default-note-folder",
      label: STRINGS.settingsDefaultNoteFolder,
      description: defaultNoteFolderDescription,
      keys: ["default_note_folder"],
    },
    {
      id: "files.attachment-folder",
      label: STRINGS.settingsAttachmentFolder,
      description: attachmentFolderDescription,
      keys: ["attachment_folder_mode", "attachment_folder_path"],
    },
    {
      id: "files.obsidian-config",
      label: STRINGS.settingsHonorObsidian,
      description: obsidianDescription,
      keys: ["honor_obsidian_config"],
    },
  ],
  search: [
    {
      id: "search.result-limit",
      label: STRINGS.settingsSearchLimit,
      description: STRINGS.settingsSearchLimitDescription,
      keys: ["search_result_limit"],
    },
    {
      id: "search.note-text",
      label: STRINGS.settingsSearchBodies,
      description: STRINGS.settingsSearchBodiesDescription,
      keys: ["search_note_bodies"],
    },
    {
      id: "search.case-sensitive",
      label: STRINGS.settingsSearchCase,
      description: STRINGS.settingsSearchCaseDescription,
      keys: ["search_case_sensitive"],
    },
  ],
  updates: [
    {
      id: "updates.channel",
      label: STRINGS.settingsUpdateChannel,
      description: updateChannelDescription,
      keys: ["update_channel"],
    },
    {
      id: "updates.check",
      label: STRINGS.settingsCheckUpdates,
      description: checkUpdatesDescription,
      keys: [],
    },
    {
      id: "updates.version",
      label: STRINGS.settingsVersion,
      description: STRINGS.settingsVersionDescription,
      keys: [],
    },
  ],
  about: [
    {
      id: "about.license",
      label: STRINGS.settingsLicense,
      description: STRINGS.settingsLicenseDescription,
      keys: [],
    },
    {
      id: "about.repository",
      label: STRINGS.settingsRepository,
      description: STRINGS.settingsRepositoryDescription,
      keys: [],
    },
    {
      id: "about.security-policy",
      label: STRINGS.settingsThreatModel,
      description: STRINGS.settingsThreatModelDescription,
      keys: [],
    },
    {
      id: "about.settings-file",
      label: STRINGS.settingsFile,
      description: STRINGS.settingsFileDescription,
      keys: [],
    },
  ],
});

const searchActive = $derived(searchQuery.trim().length > 0);
const railVisible = $derived(surfaceWidth >= RAIL_BREAKPOINT);
/**
 * The pane takes whatever the rail leaves, so its width is derived from the
 * one measured quantity rather than observed separately: two observations of
 * the same resize arrive in different frames, and the row layout would spend
 * one of them keyed to a pane width that never finished existing.
 */
const paneWidth = $derived(
  surfaceWidth - (railVisible ? RAIL_AND_HAIRLINE_WIDTH : 0),
);
const stackedRows = $derived(paneWidth < ROW_SIDE_BY_SIDE_WIDTH);
/** The group whose rows the pane shows; null only at the drill-down's first level. */
const shownSection = $derived(railVisible ? (selectedSection ?? "appearance") : selectedSection);
const backControlVisible = $derived(
  !railVisible && shownSection !== null && !searchActive,
);
const matchedRowIds = $derived(
  new Set(
    Object.values(sectionRows)
      .flat()
      .filter((row) => matches(row))
      .map((row) => row.id),
  ),
);
const matchCounts = $derived(
  Object.fromEntries(
    sections.map((section) => [
      section.id,
      sectionRows[section.id].filter((row) => matchedRowIds.has(row.id)).length,
    ]),
  ) as Record<SectionId, number>,
);
const changedRowIds = $derived(
  new Set(
    Object.values(sectionRows)
      .flat()
      .filter((row) => rowIsChanged(row))
      .map((row) => row.id),
  ),
);
const changedSections = $derived(
  new Set(
    sections
      .filter(({ id }) =>
        sectionRows[id].some((row) => changedRowIds.has(row.id)),
      )
      .map(({ id }) => id),
  ),
);
/** The groups the pane renders, in group order: one, or every matching one. */
const renderedSections = $derived(
  searchActive
    ? sections
        .filter(({ id }) => matchCounts[id] > 0)
        .filter(({ id }) => narrowedSection === null || narrowedSection === id)
        .map(({ id }) => id)
    : shownSection === null
      ? []
      : [shownSection],
);
const paneKey = $derived(shownSection ?? "settings-group-list");
const displayedPalette = $derived(previewPalette ?? activePalette);
const displayedPaletteCard = $derived(
  paletteCards.find(({ value }) => value === displayedPalette) ??
    paletteCards[0],
);
const previewLightPalette = $derived(
  documentSettings.light_palette as LightPaletteName,
);
const previewDarkPalette = $derived(
  documentSettings.dark_palette as DarkPaletteName,
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

onMount(() => {
  enterMotionSurface(backdropElement);
  enterMotionSurface(dialogElement);
});

/**
 * The rail and the row layout both follow measured widths, never the
 * viewport's: a 900px window has room for side-by-side rows, and the rule
 * keyed to the viewport stacked them anyway. Crossing the rail's own
 * breakpoint re-anchors the pane on the row the reader was reading, because
 * a reflow changes every row's height and a raw scroll offset would land
 * somewhere else.
 */
onMount(() => {
  if (typeof ResizeObserver === "undefined") return;
  const observer = new ResizeObserver((entries) => {
    const entry = entries.at(-1);
    if (entry === undefined) return;
    const width = entry.borderBoxSize[0]?.inlineSize ?? entry.target.clientWidth;
    if (width >= RAIL_BREAKPOINT === railVisible) {
      surfaceWidth = width;
      return;
    }
    // A measurement still pending would describe the layout the resize has
    // already produced, not the one the reader was looking at.
    if (anchorFrame !== 0) {
      cancelAnimationFrame(anchorFrame);
      anchorFrame = 0;
    }
    const anchor = scrollAnchor;
    surfaceWidth = width;
    void tick().then(() => restoreScrollAnchor(anchor));
  });
  if (dialogElement instanceof HTMLElement) observer.observe(dialogElement);
  return () => observer.disconnect();
});

/**
 * A rail with no selection beside an empty pane is not a state the product
 * has: crossing the breakpoint upward from the group list lands on
 * Appearance.
 */
$effect(() => {
  if (railVisible && selectedSection === null) selectedSection = "appearance";
});

/** Keeps the travelling selected-item bar over the tab it belongs to. */
$effect(() => {
  const active = railVisible && !searchActive ? selectedSection : null;
  const selected =
    active === null
      ? null
      : (railElement?.querySelector<HTMLElement>(`[data-section="${active}"]`) ??
        null);
  railIndicatorTop = selected?.offsetTop ?? 0;
  railIndicatorHeight = selected?.offsetHeight ?? 0;
});

/**
 * The incoming pane fades in over its fully composed frame. Only a group
 * change animates: the results view replaces the pane on every keystroke and
 * is content, not a surface.
 */
$effect(() => {
  const key = paneKey;
  if (key === enteredPaneKey || !(paneElement instanceof HTMLElement)) return;
  enteredPaneKey = key;
  enterMotionSurface(paneElement);
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

onDestroy(() => {
  sessionSection = selectedSection;
});

type ScrollAnchor = { id: string; offset: number } | null;

/**
 * The reader's position in the pane, held as the topmost visible row and the
 * distance the pane has scrolled into it: the same content-anchored form the
 * history restoration uses, so a reflow that changes every row's height still
 * lands on the same row. It is measured while the reader scrolls rather than
 * when the surface resizes, because by the time a resize is observable the
 * rows have already reflowed under the position it would be measuring.
 */
function measureScrollAnchor(): ScrollAnchor {
  if (!(contentElement instanceof HTMLElement)) return null;
  const top = contentElement.scrollTop;
  for (const row of contentElement.querySelectorAll<HTMLElement>(
    "[data-setting-id]",
  )) {
    // A row whose last pixel sits on the pane's top edge is the row above,
    // not the one the reader is reading.
    if (row.offsetTop + row.offsetHeight <= top + 1) continue;
    const id = row.dataset.settingId;
    if (id === undefined) continue;
    return { id, offset: top - row.offsetTop };
  }
  return null;
}

function onPaneScroll() {
  if (anchorFrame !== 0) return;
  anchorFrame = requestAnimationFrame(() => {
    anchorFrame = 0;
    scrollAnchor = measureScrollAnchor();
  });
}

function restoreScrollAnchor(anchor: ScrollAnchor) {
  if (anchor === null || !(contentElement instanceof HTMLElement)) return;
  const row = contentElement.querySelector<HTMLElement>(
    `[data-setting-id="${CSS.escape(anchor.id)}"]`,
  );
  if (row === null) return;
  contentElement.scrollTop = row.offsetTop + anchor.offset;
}

function sectionOfSetting(id: string): SectionId | null {
  return (
    SETTINGS_DESCRIPTORS.find((setting) => setting.id === id)?.section ?? null
  );
}

async function focusSetting(id: string) {
  searchQuery = "";
  narrowedSection = null;
  const section = sectionOfSetting(id);
  if (section !== null) selectedSection = section;
  await tick();
  const row = contentElement?.querySelector<HTMLElement>(
    `[data-setting-id="${CSS.escape(id)}"]`,
  );
  if (
    !(contentElement instanceof HTMLElement) ||
    row === null ||
    row === undefined
  )
    return;
  // Layout coordinates, not viewport rectangles: the dialog is still inside
  // its entrance scale when a deep link arrives, and a rectangle measured
  // through that transform scrolls the pane a couple of percent short.
  contentElement.scrollTop = row.offsetTop;
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

/**
 * A click on a palette card writes that palette's field and nothing else: a
 * light card writes the light palette, a dark card the dark one, and the
 * colour scheme never changes. The mode cards repaint in the same frame,
 * which is where the choice's consequence shows.
 */
function choosePalette(card: PaletteCard) {
  previewPalette = card.value;
  update(
    card.mode === "light"
      ? { light_palette: card.value as LightPaletteName }
      : { dark_palette: card.value as DarkPaletteName },
  );
}

function chooseTheme(theme: ThemeName) {
  update({ theme });
}

async function modeKeydown(event: KeyboardEvent, card: ModeCard) {
  const index = modeCards.indexOf(card);
  let nextIndex: number | null = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (index + 1) % modeCards.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (index - 1 + modeCards.length) % modeCards.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = modeCards.length - 1;
  }
  if (nextIndex === null) return;
  event.preventDefault();
  const next = modeCards[nextIndex];
  if (next === undefined) return;
  chooseTheme(next.value);
  await tick();
  dialogElement
    ?.querySelector<HTMLButtonElement>(`[data-testid="settings-theme-${next.value}"]`)
    ?.focus();
}

/** The preview tokens one miniature shell pane paints from. */
function modePaneStyle(palette: LightPaletteName | DarkPaletteName): string {
  return (
    `--skr-mode-pane-surface: var(--skr-preview-${palette}-surface);` +
    `--skr-mode-pane-text: var(--skr-preview-${palette}-text);` +
    `--skr-mode-pane-accent: var(--skr-preview-${palette}-accent)`
  );
}

/**
 * The task statuses compare on the values the editor actually resolves, not
 * on the shape they were stored in: a document that spells out a default
 * name, or omits a track the resolver would derive anyway, describes the
 * same statuses and is not a change the reader made.
 */
function canonicalStatuses(value: unknown): string {
  if (!Array.isArray(value)) return JSON.stringify(value);
  return JSON.stringify(
    (value as TaskStatus[]).map((status) => [
      status.symbol,
      taskStatusDisplayName(status),
      status.category,
      status.glyph,
      status.color_token,
      status.next_status,
      taskStatusTrack(status),
      taskStatusPayload(status) ?? null,
    ]),
  );
}

function valuesDiffer(
  key: keyof SettingsDocument,
  left: unknown,
  right: unknown,
): boolean {
  if (key === "task_statuses") {
    return canonicalStatuses(left) !== canonicalStatuses(right);
  }
  return left !== right;
}

function rowIsChanged(row: SettingRow): boolean {
  return row.keys.some((key) =>
    valuesDiffer(key, documentSettings[key], DEFAULT_SETTINGS[key]),
  );
}

function rowOf(id: string): SettingRow | undefined {
  return Object.values(sectionRows)
    .flat()
    .find((row) => row.id === id);
}

/** Writes one row's defaults back through the ordinary settings path. */
function resetRow(id: string) {
  const row = rowOf(id);
  if (row === undefined || row.keys.length === 0) return;
  const nextPreview = { ...previewSettings };
  for (const key of row.keys) delete nextPreview[key];
  previewSettings = nextPreview;
  update(
    Object.fromEntries(
      row.keys.map((key) => [key, DEFAULT_SETTINGS[key]]),
    ) as Partial<SettingsDocument>,
  );
}

/** True while the row renders: always in its own group, only when matched under a query. */
function showRow(id: string): boolean {
  return !searchActive || matchedRowIds.has(id);
}

function tabId(section: SectionId): string {
  return `settings-tab-${section}`;
}

function sectionLabel(section: SectionId): string {
  return sections.find(({ id }) => id === section)?.label ?? section;
}

function headingId(section: SectionId): string {
  return `settings-${section}-heading`;
}

async function selectSection(section: SectionId, moveFocus = false) {
  const wasList = shownSection === null;
  narrowedSection = searchActive ? section : null;
  selectedSection = section;
  paneMotion = wasList ? "drill-push" : "fade";
  if (contentElement instanceof HTMLElement) contentElement.scrollTop = 0;
  if (!moveFocus && !wasList) return;
  await tick();
  // A drill-down push destroys the row that was activated, so focus lands on
  // the control that leaves the level it just entered rather than on nothing.
  const target = wasList
    ? dialogElement?.querySelector<HTMLButtonElement>(
        "[data-testid='settings-back']",
      )
    : railElement?.querySelector<HTMLButtonElement>(`[data-section="${section}"]`);
  target?.focus();
}

/** Escape at level two leaves the inner thing first, as everywhere else. */
async function showGroupList() {
  const leaving = selectedSection;
  paneMotion = "drill-pop";
  selectedSection = null;
  narrowedSection = null;
  if (contentElement instanceof HTMLElement) contentElement.scrollTop = 0;
  await tick();
  const rows = contentElement?.querySelectorAll<HTMLButtonElement>(
    ".settings-group-row",
  );
  const returning = [...(rows ?? [])].find(
    (row) => row.dataset.section === leaving,
  );
  (returning ?? rows?.[0])?.focus();
}

function railKeydown(event: KeyboardEvent) {
  const index = sections.findIndex(({ id }) => id === selectedSection);
  let nextIndex: number | null = null;
  if (event.key === "ArrowDown") nextIndex = (index + 1) % sections.length;
  else if (event.key === "ArrowUp")
    nextIndex = (index - 1 + sections.length) % sections.length;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = sections.length - 1;
  if (nextIndex === null) return;
  event.preventDefault();
  const next = sections[nextIndex];
  if (next === undefined) return;
  void selectSection(next.id, true);
}

/**
 * A query owns the surface: the rail drops its selection and becomes a facet
 * display. Clearing it restores the group that was showing and the scroll
 * offset it had, so nothing is lost by searching and changing your mind.
 */
function onSearchInput(event: Event) {
  const wasActive = searchActive;
  searchQuery = (event.currentTarget as HTMLInputElement).value;
  const isActive = searchQuery.trim().length > 0;
  if (isActive && !wasActive) {
    restoreSection = selectedSection;
    restoreScrollTop =
      contentElement instanceof HTMLElement ? contentElement.scrollTop : 0;
    narrowedSection = null;
    if (contentElement instanceof HTMLElement) contentElement.scrollTop = 0;
  } else if (!isActive && wasActive) {
    selectedSection = restoreSection;
    narrowedSection = null;
    const offset = restoreScrollTop;
    void tick().then(() => {
      if (contentElement instanceof HTMLElement) {
        contentElement.scrollTop = offset;
      }
    });
  }
}

function focusSearchField() {
  const field = dialogElement?.querySelector<HTMLInputElement>(
    "[data-testid='settings-search']",
  );
  field?.focus();
  field?.select();
}

/**
 * Arrows travel inside one half of the pair. Each half is its own radio
 * group and writes its own field, so wrapping past the last light palette
 * into the dark ones would step across a group boundary and change a second
 * setting the reader never reached for.
 */
async function paletteKeydown(event: KeyboardEvent, card: PaletteCard) {
  const siblings = paletteCards.filter(({ mode }) => mode === card.mode);
  const index = siblings.indexOf(card);
  let nextIndex: number | null = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    nextIndex = (index + 1) % siblings.length;
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    nextIndex = (index - 1 + siblings.length) % siblings.length;
  } else if (event.key === "Home") {
    nextIndex = 0;
  } else if (event.key === "End") {
    nextIndex = siblings.length - 1;
  }
  if (nextIndex === null) return;
  event.preventDefault();
  const next = siblings[nextIndex];
  if (next === undefined) return;
  choosePalette(next);
  await tick();
  dialogElement
    ?.querySelector<HTMLButtonElement>(
      `[data-testid="settings-palette-${next.value}"]`,
    )
    ?.focus();
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
  if (closing) return;
  closing = true;
  restorePreview();
  exitMotionSurfaces(
    [backdropElement, dialogElement].filter(
      (element): element is HTMLElement => element instanceof HTMLElement,
    ),
    onClose,
  );
}

onDestroy(() => {
  restorePreview();
  if (restoreFocus && returnFocusElement?.isConnected) {
    returnFocusElement.focus();
  }
});

/**
 * The extra words a row answers to. The palette row edits both palettes at
 * once, so it answers to the words either of them carries.
 */
function searchTermsForRow(id: string): readonly string[] {
  return id === "appearance.palette"
    ? [
        ...settingSearchTerms("appearance.light-palette"),
        ...settingSearchTerms("appearance.dark-palette"),
      ]
    : settingSearchTerms(id);
}

function matches(row: SettingRow): boolean {
  return matchesSearchTerms(
    searchQuery,
    row.label,
    row.description,
    searchTermsForRow(row.id),
  );
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
    if (backControlVisible) void showGroupList();
    else closeSettings();
    return;
  }
  // The editor's find surface is unreachable from a modal dialog, so the
  // chord every reader already has for "search this thing" has no competitor
  // here and is the fast route back from deep inside a long group.
  if (
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "f"
  ) {
    event.preventDefault();
    event.stopPropagation();
    focusSearchField();
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
  if (event.key !== "Tab" || !(dialogElement instanceof HTMLElement)) {
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

{#snippet rowReset(id: string)}
  {#if changedRowIds.has(id)}
    <button
      class="row-reset"
      type="button"
      aria-label={STRINGS.settingsResetToDefault}
      title={STRINGS.settingsResetToDefault}
      data-testid={`settings-reset-${id}`}
      onclick={() => resetRow(id)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5.5 9 H10 V4.5" />
        <path d="M5.9 9.2 A7 7 0 1 1 5 13.4" />
      </svg>
    </button>
  {/if}
{/snippet}

{#snippet modePreviewPane(
  palette: LightPaletteName | DarkPaletteName,
  half: boolean,
)}
  <span class="mode-pane" class:mode-pane-half={half} style={modePaneStyle(palette)}>
    <span class="mode-pane-sidebar"></span>
    <span class="mode-pane-lines">
      <i></i><i></i><i></i>
    </span>
    <span class="mode-pane-accent"></span>
  </span>
{/snippet}

{#snippet modeCard(card: ModeCard)}
  <button
    type="button"
    class="mode-card"
    class:active={documentSettings.theme === card.value}
    role="radio"
    aria-checked={documentSettings.theme === card.value}
    tabindex={documentSettings.theme === card.value ? 0 : -1}
    data-mode={card.value}
    data-testid={`settings-theme-${card.value}`}
    onclick={() => chooseTheme(card.value)}
    onkeydown={(event) => modeKeydown(event, card)}
  >
    <span class="mode-preview" aria-hidden="true">
      {#if card.value !== "dark"}
        {@render modePreviewPane(previewLightPalette, false)}
      {/if}
      {#if card.value !== "light"}
        {@render modePreviewPane(previewDarkPalette, card.value === "system")}
      {/if}
    </span>
    <span class="mode-name">{card.label}</span>
  </button>
{/snippet}

{#snippet paletteGroup(
  mode: "light" | "dark",
  label: string,
  settingId: string,
)}
  <span class="palette-target" data-setting-id={settingId}>
    <span class="palette-group-head">
      <span class="palette-group-label">{label}</span>
      {#if resolvedScheme === mode}
        <span class="palette-group-live">{STRINGS.settingsPaletteInUse}</span>
      {/if}
    </span>
    <span
      class="palette-group-options"
      role="radiogroup"
      aria-label={label}
      data-palette-mode={mode}
    >
      {#each paletteCards.filter((card) => card.mode === mode) as card (card.value)}
        {@render paletteCard(card)}
      {/each}
    </span>
  </span>
{/snippet}

{#snippet paletteCard(card: PaletteCard)}
  <button
    type="button"
    class="palette-card skr-palette-swatch"
    class:active={paletteIsStoredChoice(card)}
    class:live={activePalette === card.value}
    role="radio"
    aria-checked={paletteIsStoredChoice(card)}
    tabindex={paletteIsStoredChoice(card) ? 0 : -1}
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
  bind:this={backdropElement}
  class="settings-backdrop"
  role="presentation"
  data-motion-surface="scrim"
  onclick={(event) =>
    event.target === event.currentTarget && void closeSettings()}
>
  <div
    bind:this={dialogElement}
    class="settings-dialog"
    role="dialog"
    aria-modal="true"
    aria-label={STRINGS.settingsLabel}
    tabindex="-1"
    data-testid="settings-view"
    data-motion-surface="centered"
    onkeydown={onKeydown}
  >
    <div class="settings-header">
      {#if backControlVisible}
        <button
          class="icon-button back-button"
          type="button"
          aria-label={STRINGS.settingsAllSettings}
          title={STRINGS.settingsAllSettings}
          data-btn-role="secondary"
          data-testid="settings-back"
          onclick={() => void showGroupList()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14.5 6 L9 12 L14.5 18" />
          </svg>
        </button>
      {/if}
      <h2>{STRINGS.settingsLabel}</h2>
      <label class="settings-search">
        <span class="visually-hidden">{STRINGS.settingsSearchLabel}</span>
        <input
          value={searchQuery}
          oninput={onSearchInput}
          data-testid="settings-search"
          type="search"
          placeholder={STRINGS.settingsSearchPlaceholder}
        />
      </label>
      <button
        class="icon-button close-button"
        type="button"
        aria-label={STRINGS.closeAction}
        data-btn-role="secondary"
        onclick={closeSettings}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 6 L18 18 M18 6 L6 18" />
        </svg>
      </button>
    </div>

    <div class="settings-body">
      {#if railVisible}
        <div
          bind:this={railElement}
          class="settings-rail"
          role="tablist"
          aria-orientation="vertical"
          aria-label={STRINGS.settingsSectionsLabel}
          data-testid="settings-rail"
        >
          <span
            class="settings-rail-indicator"
            class:settings-rail-indicator-hidden={searchActive}
            aria-hidden="true"
            style={`height: ${railIndicatorHeight}px; transform: translateY(${railIndicatorTop}px)`}
          ></span>
          {#each sections as section (section.id)}
            {@const selected = !searchActive && selectedSection === section.id}
            {@const count = matchCounts[section.id]}
            <button
              class="settings-rail-item"
              type="button"
              role="tab"
              id={tabId(section.id)}
              data-section={section.id}
              data-testid={`settings-rail-${section.id}`}
              aria-controls="settings-pane"
              aria-selected={selected}
              aria-disabled={searchActive && count === 0 ? true : undefined}
              class:selected
              class:facet-empty={searchActive && count === 0}
              tabindex={selected || (searchActive && section.id === sections[0]?.id)
                ? 0
                : -1}
              onclick={() => {
                if (searchActive && count === 0) return;
                void selectSection(section.id);
              }}
              onkeydown={railKeydown}
            >
              <span class="settings-rail-label">{section.label}</span>
              <span
                class="settings-rail-slot"
                title={searchActive
                  ? STRINGS.settingsSectionMatchCount
                  : changedSections.has(section.id)
                    ? STRINGS.settingsSectionChanged
                    : undefined}
              >
                {#if searchActive}
                  <span class="settings-rail-count" aria-hidden="true">{count}</span>
                  <span class="visually-hidden"
                    >{STRINGS.settingsSectionMatchCount}: {count}</span
                  >
                {:else if changedSections.has(section.id)}
                  <span class="settings-rail-dot" aria-hidden="true"></span>
                  <span class="visually-hidden"
                    >{STRINGS.settingsSectionChanged}</span
                  >
                {/if}
              </span>
            </button>
          {/each}
        </div>
        <div class="settings-rail-hairline" aria-hidden="true"></div>
      {/if}

    <div
      bind:this={contentElement}
      class="settings-content"
      class:stacked={stackedRows}
      id="settings-pane"
      role={railVisible ? "tabpanel" : undefined}
      aria-labelledby={railVisible && !searchActive && shownSection !== null
        ? tabId(shownSection)
        : undefined}
      onscroll={onPaneScroll}
    >
        {#snippet appearanceRows()}
            {#if showRow("appearance.theme")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("appearance.theme")}
                data-setting-id="appearance.theme"
              >
                <div class="setting-row-fields">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsTheme}</span>
                    <p>{STRINGS.settingsThemeDescription}</p>
                    {@render settingError(["theme"])}
                  </div>
                  <div
                    class="mode-cards"
                    role="radiogroup"
                    aria-label={STRINGS.settingsTheme}
                    data-testid="settings-theme"
                  >
                    {#each modeCards as card (card.value)}
                      {@render modeCard(card)}
                    {/each}
                  </div>
                </div>
                {@render rowReset("appearance.theme")}
              </div>
            {/if}

            {#if showRow("appearance.palette")}
              <div
                class="setting-row palette-setting"
                class:changed={changedRowIds.has("appearance.palette")}
              >
                <div class="setting-row-fields">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsPalette}</span>
                    <p>{STRINGS.settingsPaletteDescription}</p>
                    {@render settingError(["light_palette", "dark_palette"])}
                  </div>
                  <div class="palette-picker">
                    <div class="palette-options" data-testid="settings-palette">
                      {@render paletteGroup(
                        "light",
                        STRINGS.settingsLightPalette,
                        "appearance.light-palette",
                      )}
                      {@render paletteGroup(
                        "dark",
                        STRINGS.settingsDarkPalette,
                        "appearance.dark-palette",
                      )}
                    </div>
                    {@render palettePreview(
                      displayedPaletteCard?.label ??
                        STRINGS.settingsPaletteManuscript,
                      displayedPalette,
                    )}
                  </div>
                </div>
                {@render rowReset("appearance.palette")}
              </div>
            {/if}

            {#if showRow("appearance.prose-font")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("appearance.prose-font")}
                data-setting-id="appearance.prose-font"
              >
                <div class="setting-row-fields">
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
                {@render rowReset("appearance.prose-font")}
              </div>
            {/if}

            {#if showRow("appearance.code-font")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("appearance.code-font")}
                data-setting-id="appearance.code-font"
              >
                <div class="setting-row-fields">
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
                {@render rowReset("appearance.code-font")}
              </div>
            {/if}

            {#if showRow("appearance.font-size")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("appearance.font-size")}
                data-setting-id="appearance.font-size"
              >
                <div class="setting-row-fields">
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
                {@render rowReset("appearance.font-size")}
              </div>
            {/if}

            {#if showRow("appearance.line-height")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("appearance.line-height")}
                data-setting-id="appearance.line-height"
              >
                <div class="setting-row-fields">
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
                {@render rowReset("appearance.line-height")}
              </div>
            {/if}

            {#if showRow("appearance.line-width")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("appearance.line-width")}
                data-setting-id="appearance.line-width"
              >
                <div class="setting-row-fields">
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
                {@render rowReset("appearance.line-width")}
              </div>
            {/if}

            {#if showRow("appearance.animations")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("appearance.animations")}
                data-setting-id="appearance.animations"
              >
                <label class="setting-row-fields">
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
                {@render rowReset("appearance.animations")}
              </div>
            {/if}
        {/snippet}

        {#snippet editorRows()}
            {#if showRow("editor.autosave")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("editor.autosave")}
                data-setting-id="editor.autosave"
              >
                <div class="setting-row-fields">
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
                {@render rowReset("editor.autosave")}
              </div>
            {/if}

            {#if showRow("editor.spell-check")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("editor.spell-check")}
                data-setting-id="editor.spell-check"
              >
                <label class="setting-row-fields">
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
                {@render rowReset("editor.spell-check")}
              </div>
            {/if}

            {#if showRow("editor.indent-style")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("editor.indent-style")}
                data-setting-id="editor.indent-style"
              >
                <div class="setting-row-fields">
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
                {@render rowReset("editor.indent-style")}
              </div>
            {/if}

            {#if showRow("editor.indent-width")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("editor.indent-width")}
                data-setting-id="editor.indent-width"
              >
                <div class="setting-row-fields">
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
                {@render rowReset("editor.indent-width")}
              </div>
            {/if}

            {#each booleanEditorSettings as preference}
              {#if showRow(preference.id)}
                <div
                  class="setting-row"
                  class:changed={changedRowIds.has(preference.id)}
                  data-setting-id={preference.id}
                >
                  <label class="setting-row-fields">
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
                  {@render rowReset(preference.id)}
                </div>
              {/if}
            {/each}

            {#if showRow("editor.task-statuses")}
              <div
                class="task-status-setting setting-row-marked"
                class:changed={changedRowIds.has("editor.task-statuses")}
                data-setting-id="editor.task-statuses"
              >
                <div class="task-status-copy">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsTaskStatuses}</span>
                    <p>{STRINGS.settingsTaskStatusesDescription}</p>
                    {@render settingError(["task_statuses"])}
                  </div>
                  {@render rowReset("editor.task-statuses")}
                </div>
                <details class="task-status-editor">
                  <summary>{STRINGS.settingsTaskEdit}</summary>
                  <div class="task-status-heading">
                    <p>{STRINGS.settingsTaskStatusesHelp}</p>
                    <button
                      type="button"
                      class="secondary-button" data-btn-role="secondary"
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
        {/snippet}

        {#snippet filesRows()}
            <fieldset disabled={!desktopAvailable}>
              {#if showRow("files.default-note-folder")}
                <div
                  class="setting-row"
                  class:changed={changedRowIds.has("files.default-note-folder")}
                  data-setting-id="files.default-note-folder"
                >
                  <label class="setting-row-fields">
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
                  {@render rowReset("files.default-note-folder")}
                </div>
              {/if}

              {#if showRow("files.attachment-folder")}
                <div
                  class="setting-row attachment-setting"
                  class:changed={changedRowIds.has("files.attachment-folder")}
                  data-setting-id="files.attachment-folder"
                >
                  <div class="setting-row-fields">
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
                  {@render rowReset("files.attachment-folder")}
                </div>
              {/if}

              {#if showRow("files.obsidian-config")}
                <div
                  class="setting-row"
                  class:changed={changedRowIds.has("files.obsidian-config")}
                  data-setting-id="files.obsidian-config"
                >
                  <label class="setting-row-fields">
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
                  {@render rowReset("files.obsidian-config")}
                </div>
              {/if}
            </fieldset>
        {/snippet}

        {#snippet searchRows()}
            {#if showRow("search.result-limit")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("search.result-limit")}
                data-setting-id="search.result-limit"
              >
                <div class="setting-row-fields">
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
                {@render rowReset("search.result-limit")}
              </div>
            {/if}

            {#if showRow("search.note-text")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("search.note-text")}
                data-setting-id="search.note-text"
              >
                <div class="setting-row-fields">
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
                {@render rowReset("search.note-text")}
              </div>
            {/if}

            {#if showRow("search.case-sensitive")}
              <div
                class="setting-row"
                class:changed={changedRowIds.has("search.case-sensitive")}
                data-setting-id="search.case-sensitive"
              >
                <label class="setting-row-fields">
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
                {@render rowReset("search.case-sensitive")}
              </div>
            {/if}
        {/snippet}

        {#snippet updatesRows()}
            <fieldset disabled={!desktopAvailable}>
              {#if showRow("updates.channel")}
                <div
                  class="setting-row"
                  class:changed={changedRowIds.has("updates.channel")}
                  data-setting-id="updates.channel"
                >
                  <div class="setting-row-fields">
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
                  {@render rowReset("updates.channel")}
                </div>
              {/if}

              {#if showRow("updates.check")}
                <div class="setting-row" data-setting-id="updates.check">
                  <div class="setting-row-fields">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsCheckUpdates}</span>
                    <p>{checkUpdatesDescription}</p>
                    {#if updateState.kind !== "idle"}
                      <p
                        class="update-status"
                        class:update-status-security={updateState.kind ===
                          "failed" && updateState.security}
                        role={updateState.kind === "failed" &&
                        updateState.security
                          ? "alert"
                          : "status"}
                      >
                        {describeUpdateState(updateState)}
                      </p>
                    {/if}
                    {#if updateState.kind === "available"}
                      {#if updateState.notes.trim() !== ""}
                        <details class="update-notes">
                          <summary>{STRINGS.updateNotesSummary}</summary>
                          <p>{updateState.notes}</p>
                        </details>
                      {/if}
                      <button
                        type="button"
                        class="skr-btn-primary update-action"
                        data-btn-role="primary"
                        data-testid="settings-install-update"
                        disabled={!desktopAvailable}
                        onclick={onInstallUpdate}
                        >{STRINGS.updateInstall}</button
                      >
                    {:else if updateState.kind === "downloading"}
                      <div
                        class="update-progress"
                        role="progressbar"
                        aria-label={describeUpdateState(updateState)}
                        aria-valuemin="0"
                        aria-valuemax="100"
                        aria-valuenow={updateState.percent ?? undefined}
                      >
                        {#if updateState.percent === null}
                          <div
                            class="skr-skeleton-bar"
                            style="width: 100%; height: 100%; border-radius: 0;"
                          ></div>
                        {:else}
                          <div
                            class="update-progress-fill"
                            style={`width: ${updateState.percent}%`}
                          ></div>
                        {/if}
                      </div>
                    {:else if updateState.kind === "ready"}
                      <button
                        type="button"
                        class="skr-btn-primary update-action"
                        data-btn-role="primary"
                        data-testid="settings-restart-update"
                        disabled={!desktopAvailable}
                        onclick={onRestartUpdate}
                        >{STRINGS.updateRestart}</button
                      >
                    {/if}
                  </div>
                  <button
                    type="button"
                    class="secondary-button" data-btn-role="secondary"
                    data-testid="settings-check-updates"
                    disabled={!desktopAvailable}
                    onclick={onCheckUpdate}
                    >{STRINGS.updateCheck}</button
                  >
                  </div>
                </div>
              {/if}
            </fieldset>
            {#if showRow("updates.version")}
              <div class="setting-row" data-setting-id="updates.version">
                <div class="setting-row-fields">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsVersion}</span>
                    <p>{STRINGS.settingsVersionDescription}</p>
                  </div>
                  <output tabindex="-1">{currentVersion}</output>
                </div>
              </div>
            {/if}
        {/snippet}

        {#snippet aboutRows()}
            {#if showRow("about.license")}
              <div class="setting-row" data-setting-id="about.license">
                <div class="setting-row-fields">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsLicense}</span>
                    <p>{STRINGS.settingsLicenseDescription}</p>
                  </div>
                  <a href="https://github.com/morgaesis/skribeum#license" target="_blank" rel="noreferrer">
                    {STRINGS.settingsLicenseLink}
                  </a>
                </div>
              </div>
            {/if}
            {#if showRow("about.repository")}
              <div class="setting-row" data-setting-id="about.repository">
                <div class="setting-row-fields">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsRepository}</span>
                    <p>{STRINGS.settingsRepositoryDescription}</p>
                  </div>
                  <a href="https://github.com/morgaesis/skribeum" target="_blank" rel="noreferrer">
                    {STRINGS.settingsRepositoryLink}
                  </a>
                </div>
              </div>
            {/if}
            {#if showRow("about.security-policy")}
              <div class="setting-row" data-setting-id="about.security-policy">
                <div class="setting-row-fields">
                  <div class="setting-copy">
                    <span class="setting-label">{STRINGS.settingsThreatModel}</span>
                    <p>{STRINGS.settingsThreatModelDescription}</p>
                  </div>
                  <a href="https://github.com/morgaesis/skribeum/blob/main/SECURITY.md" target="_blank" rel="noreferrer">
                    {STRINGS.settingsThreatModelLink}
                  </a>
                </div>
              </div>
            {/if}
            {#if showRow("about.settings-file")}
              <div class="setting-row" data-setting-id="about.settings-file">
                <div class="setting-row-fields">
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
              </div>
            {/if}
            <p class="prealpha-note">{STRINGS.settingsPreAlphaNote}</p>
        {/snippet}

        {#snippet groupBody(section: SectionId)}
          {#if section === "appearance"}
            {@render appearanceRows()}
          {:else if section === "editor"}
            {@render editorRows()}
          {:else if section === "files"}
            {@render filesRows()}
          {:else if section === "search"}
            {@render searchRows()}
          {:else if section === "updates"}
            {@render updatesRows()}
          {:else}
            {@render aboutRows()}
          {/if}
        {/snippet}

        {#key paneKey}
          <div
            bind:this={paneElement}
            class="settings-pane"
            data-motion-surface={paneMotion}
          >
            {#if shownSection === null && !searchActive}
              <div class="settings-group-list" data-testid="settings-group-list">
                {#each sections as section (section.id)}
                  <button
                    class="settings-group-row"
                    type="button"
                    data-section={section.id}
                    onclick={() => void selectSection(section.id)}
                  >
                    <span>{section.label}</span>
                    <span
                      class="settings-group-slot"
                      title={changedSections.has(section.id)
                        ? STRINGS.settingsSectionChanged
                        : undefined}
                    >
                      {#if changedSections.has(section.id)}
                        <span class="settings-rail-dot" aria-hidden="true"></span>
                        <span class="visually-hidden"
                          >{STRINGS.settingsSectionChanged}</span
                        >
                      {/if}
                      <svg class="settings-group-chevron" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M9.5 6 L15 12 L9.5 18" />
                      </svg>
                    </span>
                  </button>
                {/each}
              </div>
            {:else}
              {#each renderedSections as section (section)}
                <section
                  aria-labelledby={headingId(section)}
                  data-settings-section={section}
                >
                  <h3 id={headingId(section)}>{sectionLabel(section)}</h3>
                  {@render groupBody(section)}
                </section>
              {/each}
            {/if}
          </div>
        {/key}
    </div>
    </div>

    <footer
      class="settings-footer"
    >
      <button
        type="button"
        class="secondary-button" data-btn-role="secondary"
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
    border: 0;
    border-radius: var(--skr-radius-dialog);
    /* The surface's 1px edge is painted inside its own box rather than laid
       out as a border, so the full 56rem is available to the rail and the
       pane: the pane must keep the row width it had without a rail, and the
       two pixels a border would take are exactly the two it would lose. */
    box-shadow:
      inset 0 0 0 1px var(--skr-border),
      var(--skr-shadow);
    color: var(--skr-text);
    display: flex;
    flex-direction: column;
    /* The surface's own tier. Controls that carry `font: inherit` (the
       search field, the text controls, the rail's items) resolve their size
       from here rather than from the browser's dialog font. */
    font-family: var(--skr-font-interface);
    font-size: var(--skr-type-control);
    height: min(85vh, 48rem);
    max-height: calc(100vh - 2rem);
    outline: none;
    overflow: hidden;
    position: relative;
    /* Wide enough to seat the rail beside a pane no narrower than the one
       the surface had without it, and narrow enough that the scrim band on
       each side still reads as a dialog over the editor. */
    width: min(56rem, calc(100vw - 4rem));
  }

  /* The rail, its hairline and the pane; the header and footer above and
     below it continue to span the dialog's full width. */
  .settings-body {
    display: flex;
    flex: 1;
    min-height: 0;
    min-width: 0;
  }

  .settings-rail {
    box-sizing: border-box;
    display: flex;
    flex: 0 0 8rem;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.5rem 0.25rem;
    position: relative;
    width: 8rem;
  }

  .settings-rail-hairline {
    background: var(--skr-border);
    flex: 0 0 1px;
    width: 1px;
  }

  .settings-rail-item {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--skr-radius-control);
    box-sizing: border-box;
    color: var(--skr-text-muted);
    cursor: pointer;
    display: flex;
    font: inherit;
    font-weight: 400;
    gap: 0.25rem;
    justify-content: space-between;
    min-height: 2rem;
    /* The rail is a fixed 8rem and the slot reserves its width whether or not
       it holds a mark, which left the longest group name three pixels short
       of fitting and clipped it to "Appeara...". */
    padding: 0 0.625rem;
    position: relative;
    text-align: left;
    transition:
      background-color var(--skr-motion-state-duration)
        var(--skr-motion-state-easing),
      color var(--skr-motion-state-duration) var(--skr-motion-state-easing);
  }

  .settings-rail-item:hover:not(.facet-empty):not(.selected) {
    background: var(--skr-surface-subtle);
  }

  /* The same claim the file tree's open note makes: this is the thing you
     are looking at. */
  .settings-rail-item.selected {
    background: var(--skr-accent-subtle);
    color: var(--skr-text);
    font-weight: 600;
  }

  .settings-rail-item:focus-visible {
    outline: 2px solid var(--skr-focus);
    outline-offset: 2px;
  }

  .settings-rail-item.facet-empty {
    cursor: default;
    opacity: 0.4;
  }

  /* One bar that travels between items on the panel clock, the treatment
     the tab strip's active indicator already uses, rather than a per-item
     bar that pops on the newly selected one. */
  .settings-rail-indicator {
    background: var(--skr-accent);
    inset-block-start: 0;
    inset-inline-start: 0.25rem;
    pointer-events: none;
    position: absolute;
    transition: transform var(--skr-motion-panel-duration)
      var(--skr-motion-panel-easing);
    width: 2px;
  }

  .settings-rail-indicator-hidden {
    opacity: 0;
  }

  .settings-rail-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* The slot costs nothing while it holds nothing. Reserving a mark's width
     on every item permanently clipped the longest group name to make room
     for a mark that is usually absent, and a name that cannot be read is a
     worse trade than a name that shifts on the rare frame a mark appears. */
  .settings-rail-slot {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    justify-content: flex-end;
  }

  .settings-rail-count {
    color: var(--skr-text-muted);
    font-size: var(--skr-type-label);
  }

  .settings-rail-dot {
    background: var(--skr-accent);
    border-radius: var(--skr-radius-control);
    display: block;
    height: 0.25rem;
    width: 0.25rem;
  }

  /* The drill-down's first level: a list of destinations, not a composite
     widget, so its rows are ordinary tab stops. */
  .settings-group-list {
    display: grid;
  }

  .settings-group-row {
    align-items: center;
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--skr-border);
    color: var(--skr-text);
    cursor: pointer;
    display: flex;
    font: inherit;
    justify-content: space-between;
    min-height: 2.75rem;
    padding: 0 0.25rem;
    text-align: left;
    transition: background-color var(--skr-motion-state-duration)
      var(--skr-motion-state-easing);
  }

  .settings-group-row:hover {
    background: var(--skr-surface-subtle);
  }

  .settings-group-slot {
    align-items: center;
    color: var(--skr-text-muted);
    display: flex;
    gap: 0.5rem;
  }

  .settings-group-chevron {
    height: 1rem;
    width: 1rem;
  }

  .settings-pane {
    min-width: 0;
  }

  .settings-footer {
    align-items: center;
    display: flex;
    flex: none;
    justify-content: space-between;
  }

  /* Title, query and closer share one band. Stacking them cost a fifth of
     the surface's height before a single setting was shown, and none of the
     three needs a line of its own to be read. */
  .settings-header {
    align-items: center;
    border-bottom: 1px solid var(--skr-border);
    display: flex;
    flex: none;
    gap: 0.75rem;
    padding: 0.375rem 1.125rem;
  }

  .settings-header .icon-button {
    /* Icon glyphs are 1rem everywhere in the shell. */
    font-size: 1rem;
    height: 2.75rem;
    padding: 0;
    width: 2.75rem;
  }

  .settings-header h2 {
    flex: none;
    font-size: var(--skr-type-title);
    font-weight: 600;
    margin: 0;
  }

  .setting-copy p,
  .setting-copy > span:last-child {
    color: var(--skr-text-muted);
    /* The description sits beneath the label, never beside it: sharing the
       label's line box makes a row's height depend on how far the label
       pushes the description along, which is what doubled these rows the
       moment the pane narrowed. */
    display: block;
    font-size: var(--skr-type-label);
    line-height: 1.4;
    margin: 0.2rem 0 0;
  }

  .settings-error,
  .prealpha-note,
  .update-status {
    border-left: 3px solid var(--skr-warning);
    color: var(--skr-text-muted);
    font-size: var(--skr-type-label);
    margin: 0.75rem 1rem 0;
    padding-left: 0.6rem;
  }

  .settings-error {
    border-left-color: var(--skr-danger);
    color: var(--skr-danger);
  }

  .setting-copy .update-status.update-status-security {
    /* Out-specifies the `.setting-copy p` color rule above on purpose: a
       security failure must read as danger-colored, not the ordinary muted
       status text every other update state uses. */
    border-left-color: var(--skr-danger);
    color: var(--skr-danger);
  }

  .update-action {
    margin-top: 0.6rem;
  }

  .update-notes {
    margin: 0.6rem 1rem 0;
  }

  .update-notes summary {
    color: var(--skr-link);
    cursor: pointer;
    font-size: var(--skr-type-label);
  }

  .update-notes p {
    color: var(--skr-text-muted);
    font-size: var(--skr-type-label);
    margin: 0.4rem 0 0;
    white-space: pre-wrap;
  }

  .update-progress {
    background: var(--skr-surface-subtle);
    border-radius: var(--skr-radius-control);
    height: 0.375rem;
    margin: 0.75rem 1rem 0;
    overflow: hidden;
    width: 12rem;
  }

  .update-progress-fill {
    background: var(--skr-accent);
    height: 100%;
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
    font-size: var(--skr-type-label);
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

  /* The query takes the band's spare width up to a readable field length,
     and sits against the closer so the title keeps the left edge. */
  .settings-search {
    flex: 1;
    margin-inline-start: auto;
    max-width: 22rem;
    min-width: 0;
  }

  .setting-label {
    font-size: var(--skr-type-control);
    font-weight: 600;
    /* A one-line control label sets its own line box rather than inheriting
       the document's looser default, which otherwise adds four pixels to
       every row in the surface. */
    line-height: 1.2;
  }

  .settings-search input,
  .text-control {
    background: var(--skr-surface);
    /* De-boxed per design system section 5.12: a flat field on its surface
       with a bottom rule only, never a boxed outline. */
    border: 0;
    border-bottom: 1px solid var(--skr-border);
    border-radius: 0;
    color: var(--skr-text);
    font: inherit;
    min-width: 0;
    padding: 0.4rem 0.5rem;
  }

  .settings-search input:focus-visible,
  .text-control:focus-visible {
    border-bottom-color: var(--skr-border-strong);
  }

  .settings-search input {
    min-height: 2.75rem;
    width: 100%;
  }

  .icon-button,
  .row-reset,
  .secondary-button,
  .segmented button,
  .palette-options button,
  .mode-cards button,
  .numeric-readout,
  .stepper button {
    background: transparent;
    /* At rest, no control draws a border (design system section 5.12); the
       palette card and the numeric-entry bottom rule apply their own,
       more specific border declarations below. A zero-width border still
       resolves its computed color against `color` unless border-color is
       named explicitly, so this stays transparent rather than falling back
       to currentColor. */
    border: 0;
    border-color: transparent;
    color: var(--skr-text);
    cursor: pointer;
    font: inherit;
  }

  .icon-button:hover,
  .row-reset:hover,
  .secondary-button:hover {
    background: var(--skr-surface-subtle);
  }

  /* Both header controls are drawn by one mechanism: inline SVG on the
     product's 24-unit grid, stroked in the chrome icon colour. */
  .icon-button svg,
  .row-reset svg,
  .settings-group-chevron {
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2;
  }

  .settings-header .icon-button svg {
    height: 1rem;
    width: 1rem;
  }

  .settings-header .icon-button {
    color: var(--skr-text-muted);
  }

  .settings-header .icon-button:active {
    color: var(--skr-text);
  }

  .settings-content {
    flex: 1;
    min-height: 0;
    min-width: 0;
    /* The pane keeps its own content anchor across a breakpoint crossing, so
       the browser's must not correct the same reflow a second time. */
    overflow-anchor: none;
    overflow-y: auto;
    padding: 1rem 1.125rem 1.5rem;
    /* The pane is the offset parent its rows are measured against, so a
       deep link scrolls in layout coordinates rather than through whatever
       transform the surface is carrying at the time. */
    position: relative;
    scrollbar-gutter: stable;
  }

  .settings-pane section + section {
    margin-top: 1.5rem;
  }

  .settings-pane h3 {
    color: var(--skr-text-muted);
    font-size: var(--skr-type-label);
    font-weight: 700;
    letter-spacing: 0.08em;
    margin: 0 0 0.25rem;
    text-transform: uppercase;
  }

  .setting-row {
    align-items: center;
    border-bottom: 1px solid var(--skr-border);
    display: grid;
    /* The reset slot is reserved on every row, changed or not, so a value
       moving off its default never shifts the control the hand is on. */
    grid-template-columns: minmax(0, 1fr) 1.5rem;
    min-height: 2.75rem;
    padding: 0.625rem 0;
    position: relative;
  }

  /* Copy and control, side by side or stacked; a label wrapping this pair
     keeps its click-to-activate behaviour while the reset button beside it
     stays outside the label. */
  .setting-row-fields {
    align-items: center;
    display: grid;
    gap: 1rem;
    grid-template-columns: minmax(0, 1fr) auto;
    min-width: 0;
  }

  /* The changed mark: the same 2px accent bar the file tree gives the open
     note and the rail gives the selected group, drawn inside the pane's
     padding so it never shifts the row's text. */
  .setting-row.changed::before,
  .setting-row-marked.changed::before {
    background: var(--skr-accent);
    content: "";
    inset-block: 0;
    inset-inline-start: -0.5rem;
    position: absolute;
    transition: opacity var(--skr-motion-state-duration)
      var(--skr-motion-state-easing);
    width: 2px;
  }

  .row-reset {
    align-items: center;
    border-radius: var(--skr-radius-control);
    color: var(--skr-text-muted);
    display: flex;
    height: 1.5rem;
    justify-content: center;
    opacity: 0;
    padding: 0;
    transition: opacity var(--skr-motion-state-duration)
      var(--skr-motion-state-easing);
    width: 1.5rem;
  }

  .row-reset svg {
    height: 1rem;
    width: 1rem;
  }

  .setting-row:hover .row-reset,
  .setting-row:focus-within .row-reset,
  .task-status-setting:hover .row-reset,
  .task-status-setting:focus-within .row-reset {
    opacity: 1;
  }

  .row-reset:focus-visible {
    opacity: 1;
    outline: 2px solid var(--skr-focus);
    outline-offset: 2px;
  }

  .setting-copy {
    /* The block's own strut, not the document's looser default: an inline
       label cannot shrink the line box its container establishes, so the
       rule belongs here. */
    line-height: 1.2;
    min-width: 0;
  }

  .segmented {
    /* A row of flat options with no outer box (design system section 5.12);
       grouping comes from the hairline separators between options. */
    display: inline-flex;
  }

  .segmented button {
    border: 0;
    border-right: 1px solid var(--skr-border);
    font-size: var(--skr-type-control);
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
    /* The active option carries accent-subtle fill and ordinary text
       (design system section 5.12), not accent-colored text. */
    background: var(--skr-accent-subtle);
    color: var(--skr-text);
    font-weight: 600;
  }

  .palette-setting .setting-row-fields {
    grid-template-columns: 1fr;
  }

  /* Each card renders the shell the application resolves to in that scheme,
     painted from the palettes currently chosen, so the control displays its
     consequence instead of naming it. */
  .mode-cards {
    display: flex;
    gap: 0.75rem;
  }

  .mode-card {
    background: var(--skr-surface);
    border: 1px solid var(--skr-border);
    border-radius: var(--skr-radius-surface);
    box-sizing: border-box;
    display: grid;
    gap: 0.3rem;
    justify-items: center;
    padding: 0.4rem 0.4rem 0.3rem;
  }

  .mode-card.active {
    border-color: var(--skr-accent);
    border-width: 2px;
    padding: calc(0.4rem - 1px) calc(0.4rem - 1px) calc(0.3rem - 1px);
  }

  .mode-card:focus-visible {
    outline: 2px solid var(--skr-focus);
    outline-offset: 2px;
  }

  .mode-name {
    color: var(--skr-text-muted);
    font-size: var(--skr-type-control);
  }

  .mode-card.active .mode-name {
    color: var(--skr-text);
    font-weight: 600;
  }

  .mode-preview {
    border-radius: var(--skr-radius-control);
    display: block;
    height: 3.25rem;
    overflow: hidden;
    position: relative;
    width: 5.5rem;
  }

  .mode-pane {
    background: var(--skr-mode-pane-surface);
    display: block;
    inset: 0;
    position: absolute;
  }

  /* The system card shows both halves at once: the dark pane overlays the
     light one, clipped to the trailing half along a slanted seam. */
  .mode-pane-half {
    clip-path: polygon(58% 0, 100% 0, 100% 100%, 42% 100%);
  }

  .mode-pane-sidebar {
    background: color-mix(
      in srgb,
      var(--skr-mode-pane-text) 8%,
      var(--skr-mode-pane-surface)
    );
    inset: 0 auto 0 0;
    position: absolute;
    width: 26%;
  }

  .mode-pane-lines {
    display: grid;
    gap: 0.3rem;
    inset: 18% 12% auto 34%;
    position: absolute;
  }

  .mode-pane-lines i {
    background: color-mix(
      in srgb,
      var(--skr-mode-pane-text) 55%,
      var(--skr-mode-pane-surface)
    );
    /* Larger than half the bar's own height, so it clips to a pill while the
       specified value still belongs to the radius scale. */
    border-radius: var(--skr-radius-control);
    display: block;
    height: 0.2rem;
  }

  .mode-pane-lines i:nth-child(2) {
    width: 72%;
  }

  .mode-pane-lines i:nth-child(3) {
    width: 48%;
  }

  .mode-pane-accent {
    background: var(--skr-mode-pane-accent);
    /* Larger than half the dot's own box, so it clips to a full circle while
       the specified value still belongs to the radius scale. */
    border-radius: var(--skr-radius-control);
    bottom: 14%;
    height: 0.5rem;
    position: absolute;
    right: 12%;
    width: 0.5rem;
  }

  /* The two halves of the pair stand side by side, each under its own name,
     so a palette is read as one of three choices for a scheme rather than as
     one of six unrelated cards whose only clue to which scheme it belongs to
     is how dark the card happens to look. */
  .palette-options {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
  }

  .palette-target {
    display: grid;
    gap: 0.375rem;
    min-width: 0;
  }

  /* The marker sits against its own group's name. Pushed to the far edge it
     lands beside the next group's name and labels the wrong half. */
  .palette-group-head {
    align-items: baseline;
    display: flex;
    gap: 0.5rem;
  }

  .palette-group-label {
    color: var(--skr-text-muted);
    font-size: var(--skr-type-label);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  /* Which half the shell is painting with is a property of the colour
     scheme, not of any one card, so it is stated once above the group. */
  .palette-group-live {
    color: var(--skr-accent);
    font-size: var(--skr-type-chip);
    font-weight: 600;
  }

  /* The cards inside a half keep flowing at whatever density their column
     allows. Stacking them one per row costs the swatches their comparability
     on a phone, where the two halves sit above one another and each has the
     full width to spend. */
  .palette-group-options {
    display: grid;
    gap: 0.5rem;
    grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
    min-width: 0;
  }

  .palette-options .palette-card {
    align-items: center;
    background: var(--skr-surface);
    border: 1px solid var(--skr-border);
    border-radius: var(--skr-radius-surface);
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

  /* Chosen for its own scheme. Both halves always have one, so both groups
     always show which card their scheme would paint with. */
  .palette-card.active {
    border-color: var(--skr-border-strong);
    border-width: 2px;
  }

  /* Chosen and painting right now: the accent belongs to the one card the
     reader is actually looking at the consequence of. */
  .palette-card.active.live {
    border-color: var(--skr-accent);
  }

  .palette-card strong {
    color: var(--skr-heading);
    /* A control's name, on the control scale: the card is a specimen of the
       palette, not a heading in it. */
    font-size: var(--skr-type-control);
    font-weight: 700;
    overflow-wrap: anywhere;
  }

  .palette-card-dot {
    background: var(--skr-accent);
    /* Larger than half the dot's own box, so it clips to a full circle
       while the specified value still belongs to the radius scale. */
    border-radius: var(--skr-radius-control);
    flex: 0 0 0.5rem;
    height: 0.5rem;
    margin-left: 0.5rem;
    width: 0.5rem;
  }

  .palette-live-preview {
    background: var(--skr-surface);
    border: 1px solid var(--skr-border);
    border-radius: var(--skr-radius-surface);
    color: var(--skr-text);
    display: grid;
    font-family: var(--skr-font-prose);
    gap: 0.5rem;
    margin-top: 0.5rem;
    padding: 1rem;
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
    font-size: var(--skr-type-control);
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
    border-radius: var(--skr-radius-control);
    font-family: var(--skr-font-mono);
    padding: 0.1rem 0.25rem;
  }

  .palette-live-task {
    align-items: center;
    color: var(--skr-text);
    display: flex;
    font-size: var(--skr-type-control);
    gap: 0.5rem;
  }

  .palette-live-box {
    align-items: center;
    border: 1px solid var(--skr-border-strong);
    /* Mirrors the real task checkbox exactly (design system section 3.6),
       outside the section 5.12 control radius scale. */
    border-radius: 3px;
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
    box-sizing: border-box;
    color: var(--skr-text);
    font-family: var(--skr-font-interface);
    font-size: var(--skr-type-control);
    min-height: 1.75rem;
    padding: 0.25rem 0.4rem;
    text-align: center;
    width: 5.5rem;
  }

  .numeric-readout {
    /* A chip, not a text input: control radius, no border at rest (design
       system section 5.12). */
    background: var(--skr-surface-subtle);
    border: 0;
    border-radius: var(--skr-radius-control);
    cursor: pointer;
    white-space: nowrap;
  }

  .numeric-readout:hover {
    background: var(--skr-accent-subtle);
  }

  .numeric-entry {
    /* The entry-mode field: a flat field with a bottom rule, never a boxed
       outline (design system section 5.12, "the slider readout in entry
       mode"). */
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--skr-border-strong);
    border-radius: 0;
    font-variant-numeric: tabular-nums;
    width: 5ch;
  }

  output {
    color: var(--skr-text-muted);
    font-size: var(--skr-type-label);
    text-align: right;
    white-space: nowrap;
  }

  .settings-path {
    max-width: 16rem;
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .stepper {
    /* No outer box (design system section 5.12): the minus, value and plus
       cells are grouped by the hairlines between them instead. */
    align-items: stretch;
    display: flex;
  }

  /* The step glyphs are icons and take the shell's 1rem icon size. The value
     between them is a control label and keeps the control size: the bare
     element selector outranked `.numeric-readout` and rendered every stepped
     number three pixels larger than the same number shown on a slider. */
  .stepper button:not(.numeric-readout):not(.numeric-entry) {
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

  /* The toggle switch (design system section 7.2, boolean control) is a
     pill track with a circular thumb, its own literal geometry rather than
     a member of the section 5.12 control radius scale, the same way the
     task checkbox's 3px radius sits outside that scale. */
  .switch > span {
    background: var(--skr-border-strong);
    border-radius: 1rem;
    display: block;
    height: 1.25rem;
    transition: background-color var(--skr-motion-state-duration)
      var(--skr-motion-state-easing);
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
    position: relative;
  }

  .task-status-copy {
    display: grid;
    gap: 1rem;
    grid-template-columns: minmax(0, 1fr) 1.5rem;
  }

  .task-status-editor {
    min-width: 0;
  }

  .task-status-editor summary {
    color: var(--skr-link);
    cursor: pointer;
    font-size: var(--skr-type-control);
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
    border-radius: var(--skr-radius-surface);
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
    font-size: var(--skr-type-label);
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
    border-radius: var(--skr-radius-surface);
    display: grid;
    margin-top: 0.2rem;
    max-height: 9rem;
    overflow-y: auto;
    padding: 0.2rem;
  }

  .task-listbox-options button {
    border: 0;
    border-radius: var(--skr-radius-control);
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
    border-radius: var(--skr-radius-control);
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
    border-radius: var(--skr-radius-control);
    font-size: var(--skr-type-label);
    padding: 0.4rem 0.6rem;
  }

  .secondary-button {
    /* A labelled button reads at the control tier wherever it appears, so
       the same widget never renders at two sizes across the product. */
    font-size: var(--skr-type-control);
    font-weight: 600;
  }

  a {
    color: var(--skr-link);
    font-size: var(--skr-type-label);
  }

  .settings-footer {
    border-top: 1px solid var(--skr-border);
    color: var(--skr-text-muted);
    font-size: var(--skr-type-label);
    gap: 1rem;
    padding: 0.65rem 1.125rem;
  }

  .settings-footer span {
    overflow: hidden;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* A row sets its copy and its control side by side whenever its own pane
     has the room, never on the viewport's width: a 900px window has 854px
     of row and stacking it there doubles the row's height for nothing. */
  .settings-content.stacked .setting-row-fields {
    align-items: start;
    grid-template-columns: 1fr;
  }

  .settings-content.stacked .slider-control {
    grid-template-columns: minmax(0, 1fr) 5.5rem;
    width: 100%;
  }

  @media (max-width: 60rem) {
    .settings-backdrop {
      padding: 0;
    }

    .settings-dialog {
      border-radius: 0;
      box-shadow: none;
      height: 100%;
      max-height: none;
      width: 100%;
    }

    .settings-header {
      padding-top: calc(0.375rem + env(safe-area-inset-top));
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
  }

  /* Touch targets follow the input, not the window's width: a 900px desktop
     window is still a pointer surface. */
  @media (pointer: coarse) {
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

    .settings-rail-item {
      min-height: 2.75rem;
    }

    .row-reset {
      opacity: 1;
    }
  }
</style>
