import type { CommandRegistry } from "../registry";
import { STRINGS } from "../strings";

export type SettingSectionId =
  | "appearance"
  | "editor"
  | "files"
  | "search"
  | "updates"
  | "about";

export type SettingDescriptor = {
  id: string;
  section: SettingSectionId;
  label: string;
  description: string;
};

export const SETTINGS_DESCRIPTORS: readonly SettingDescriptor[] = [
  {
    id: "appearance.theme",
    section: "appearance",
    label: STRINGS.settingsTheme,
    description: STRINGS.settingsThemeDescription,
  },
  {
    id: "appearance.light-palette",
    section: "appearance",
    label: STRINGS.settingsLightPalette,
    description: STRINGS.settingsPaletteDescription,
  },
  {
    id: "appearance.dark-palette",
    section: "appearance",
    label: STRINGS.settingsDarkPalette,
    description: STRINGS.settingsPaletteDescription,
  },
  {
    id: "appearance.prose-font",
    section: "appearance",
    label: STRINGS.settingsProseFont,
    description: STRINGS.settingsProseFontDescription,
  },
  {
    id: "appearance.code-font",
    section: "appearance",
    label: STRINGS.settingsCodeFont,
    description: STRINGS.settingsCodeFontDescription,
  },
  {
    id: "appearance.font-size",
    section: "appearance",
    label: STRINGS.settingsFontSize,
    description: STRINGS.settingsFontSizeDescription,
  },
  {
    id: "appearance.line-height",
    section: "appearance",
    label: STRINGS.settingsLineHeight,
    description: STRINGS.settingsLineHeightDescription,
  },
  {
    id: "appearance.line-width",
    section: "appearance",
    label: STRINGS.settingsLineWidth,
    description: STRINGS.settingsLineWidthDescription,
  },
  {
    id: "appearance.animations",
    section: "appearance",
    label: STRINGS.settingsAnimations,
    description: STRINGS.settingsAnimationsDescription,
  },
  {
    id: "editor.autosave",
    section: "editor",
    label: STRINGS.settingsAutosave,
    description: STRINGS.settingsAutosaveDescription,
  },
  {
    id: "editor.spell-check",
    section: "editor",
    label: STRINGS.settingsSpellCheck,
    description: STRINGS.settingsSpellCheckDescription,
  },
  {
    id: "editor.indent-style",
    section: "editor",
    label: STRINGS.settingsIndentStyle,
    description: STRINGS.settingsIndentStyleDescription,
  },
  {
    id: "editor.indent-width",
    section: "editor",
    label: STRINGS.settingsIndentWidth,
    description: STRINGS.settingsIndentWidthDescription,
  },
  {
    id: "editor.wrap-long-lines",
    section: "editor",
    label: STRINGS.settingsWrapLongLines,
    description: STRINGS.settingsWrapLongLinesDescription,
  },
  {
    id: "editor.line-numbers",
    section: "editor",
    label: STRINGS.settingsLineNumbers,
    description: STRINGS.settingsLineNumbersDescription,
  },
  {
    id: "editor.invisibles",
    section: "editor",
    label: STRINGS.settingsInvisibles,
    description: STRINGS.settingsInvisiblesDescription,
  },
  {
    id: "editor.reveal-syntax",
    section: "editor",
    label: STRINGS.settingsRevealSyntax,
    description: STRINGS.settingsRevealSyntaxDescription,
  },
  {
    id: "editor.link-previews",
    section: "editor",
    label: STRINGS.settingsLinkPreviews,
    description: STRINGS.settingsLinkPreviewsHint,
  },
  {
    id: "editor.task-statuses",
    section: "editor",
    label: STRINGS.settingsTaskStatuses,
    description: STRINGS.settingsTaskStatusesDescription,
  },
  {
    id: "files.default-note-folder",
    section: "files",
    label: STRINGS.settingsDefaultNoteFolder,
    description: STRINGS.settingsDefaultNoteFolderDescription,
  },
  {
    id: "files.attachment-folder",
    section: "files",
    label: STRINGS.settingsAttachmentFolder,
    description: STRINGS.settingsAttachmentFolderDescription,
  },
  {
    id: "files.obsidian-config",
    section: "files",
    label: STRINGS.settingsHonorObsidian,
    description: STRINGS.settingsHonorObsidianDescription,
  },
  {
    id: "search.result-limit",
    section: "search",
    label: STRINGS.settingsSearchLimit,
    description: STRINGS.settingsSearchLimitDescription,
  },
  {
    id: "search.note-text",
    section: "search",
    label: STRINGS.settingsSearchBodies,
    description: STRINGS.settingsSearchBodiesDescription,
  },
  {
    id: "search.case-sensitive",
    section: "search",
    label: STRINGS.settingsSearchCase,
    description: STRINGS.settingsSearchCaseDescription,
  },
  {
    id: "updates.channel",
    section: "updates",
    label: STRINGS.settingsUpdateChannel,
    description: STRINGS.settingsUpdateChannelDescription,
  },
  {
    id: "updates.check",
    section: "updates",
    label: STRINGS.settingsCheckUpdates,
    description: STRINGS.settingsCheckUpdatesDescription,
  },
  {
    id: "updates.version",
    section: "updates",
    label: STRINGS.settingsVersion,
    description: STRINGS.settingsVersionDescription,
  },
  {
    id: "about.version",
    section: "about",
    label: STRINGS.settingsVersion,
    description: STRINGS.settingsVersionDescription,
  },
  {
    id: "about.license",
    section: "about",
    label: STRINGS.settingsLicense,
    description: STRINGS.settingsLicenseDescription,
  },
  {
    id: "about.repository",
    section: "about",
    label: STRINGS.settingsRepository,
    description: STRINGS.settingsRepositoryDescription,
  },
  {
    id: "about.security-policy",
    section: "about",
    label: STRINGS.settingsThreatModel,
    description: STRINGS.settingsThreatModelDescription,
  },
  {
    id: "about.settings-file",
    section: "about",
    label: STRINGS.settingsFile,
    description: STRINGS.settingsFileDescription,
  },
];

export function registerSettingActions(registry: CommandRegistry): void {
  for (const setting of SETTINGS_DESCRIPTORS) {
    registry.register({
      id: `setting.${setting.id}`,
      title: `${STRINGS.settingActionPrefix}${setting.label}`,
      searchTerms: [
        setting.label,
        setting.description,
        setting.id.replaceAll(/[.-]/g, " "),
      ],
      kind: "setting",
      pointer: ["command-palette"],
      run: (context) => context.openSetting?.(setting.id),
    });
  }
}
