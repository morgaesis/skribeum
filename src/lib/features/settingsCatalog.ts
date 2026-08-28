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
    id: "updates.startup-check",
    section: "updates",
    label: STRINGS.settingsCheckUpdatesOnStartup,
    description: STRINGS.settingsCheckUpdatesOnStartupDescription,
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

/**
 * Words that reach a setting without appearing in its label or description:
 * the other spelling of a word, the concept the wording avoids, and the names
 * of the options the setting offers. "Colour palette" is what a reader means
 * by "theme", spells "color", and recognizes by the name of one palette, and
 * a search that answers none of those three has failed at its only job.
 *
 * The settings surface and the command palette both search through this, so a
 * setting stays reachable by the same words wherever it is looked for.
 */
export const SETTING_SEARCH_TERMS: Readonly<Record<string, string>> = {
  "appearance.theme":
    "theme themes colour color scheme mode dark light night system appearance contrast",
  "appearance.light-palette":
    "theme themes colour color colours colors palette palettes scheme light manuscript studio gazette",
  "appearance.dark-palette":
    "theme themes colour color colours colors palette palettes scheme dark night nightroom graphite signal",
  "appearance.prose-font":
    "font fonts typeface typography family prose text serif sans",
  "appearance.code-font":
    "font fonts typeface typography family code monospace mono modern classic",
  "appearance.font-size":
    "font size text bigger smaller larger zoom scale typography",
  "appearance.line-height":
    "line height leading spacing space lines typography",
  "appearance.line-width":
    "line width measure column characters wrap reading typography",
  "appearance.animations":
    "animation animations motion transition transitions reduce",
  "editor.autosave": "autosave save saving delay debounce milliseconds",
  "editor.spell-check": "spell spelling checker dictionary typos misspelling",
  "editor.indent-style": "indent indentation tab tabs spaces whitespace",
  "editor.indent-width": "indent indentation width size tab tabs spaces",
  "editor.wrap-long-lines":
    "wrap wrapping lines soft overflow horizontal scroll",
  "editor.line-numbers": "line lines numbers numbering gutter",
  "editor.invisibles":
    "invisible invisibles whitespace spaces tabs characters marks",
  "editor.reveal-syntax":
    "reveal syntax markers markdown raw source formatting",
  "editor.link-previews": "link links preview previews hover popup tooltip",
  "editor.task-statuses":
    "task tasks checkbox checkboxes status statuses todo done kanban",
  "files.default-note-folder":
    "file files folder directory location path new note",
  "files.attachment-folder":
    "attachment attachments image images paste folder directory path",
  "files.obsidian-config":
    "obsidian compatibility config vault import interoperability",
  "search.result-limit": "search results limit maximum count",
  "search.note-text": "search full text body bodies contents notes",
  "search.case-sensitive": "search case sensitive sensitivity matching",
  "updates.startup-check":
    "update updates check automatic automatically startup start launch boot notify notification background",
  "updates.check": "update updates check download install version",
  "updates.version": "version build release updates about",
  "about.license": "license licence legal copyright mit apache about",
  "about.repository": "repository repo source github code about",
  "about.security-policy":
    "security threat model privacy vulnerability report about",
  "about.settings-file":
    "settings file path json config configuration location backup",
};

/** The extra words for a setting, and none when it declares no extras. */
export function settingSearchTerms(id: string): readonly string[] {
  const terms = SETTING_SEARCH_TERMS[id];
  return terms === undefined ? [] : terms.split(" ");
}

export function registerSettingActions(registry: CommandRegistry): void {
  for (const setting of SETTINGS_DESCRIPTORS) {
    registry.register({
      id: `setting.${setting.id}`,
      title: `${STRINGS.settingActionPrefix}${setting.label}`,
      searchTerms: [
        setting.label,
        setting.description,
        setting.id.replaceAll(/[.-]/g, " "),
        ...settingSearchTerms(setting.id),
      ],
      kind: "setting",
      pointer: ["command-palette"],
      run: (context) => context.openSetting?.(setting.id),
    });
  }
}
