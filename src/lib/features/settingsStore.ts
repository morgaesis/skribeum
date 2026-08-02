// The settings model over `settings_read`/`settings_write`: one loaded
// document, optimistic updates (apply first, persist after, revert and
// surface on failure). I/O is injected so the store is testable at the
// IPC boundary.

import {
  type SettingsDocument,
  settingsRead,
  settingsWrite,
} from "../ipc/services";
import {
  defaultTaskStatusDocuments,
  validateTaskStatusDocuments,
} from "../taskStatuses";
import {
  isDarkPaletteName,
  isLightPaletteName,
  isThemeName,
} from "../themes/theme";

export type { SettingsDocument };

export const DEFAULT_SETTINGS: SettingsDocument = {
  schema_version: 2,
  theme: "system",
  light_palette: "manuscript",
  dark_palette: "lamplight",
  prose_font: "serif",
  code_font: "modern",
  editor_font_size: 16,
  editor_line_height: 170,
  editor_line_width: 72,
  zoom_percent: 100,
  show_line_numbers: false,
  animations: true,
  autosave_delay_ms: 400,
  spell_check: true,
  indent_style: "spaces",
  indent_width: 2,
  wrap_long_lines: true,
  show_invisible_characters: false,
  reveal_markdown_syntax: true,
  default_note_folder: "",
  attachment_folder_mode: "vault",
  attachment_folder_path: "attachments",
  honor_obsidian_config: true,
  search_result_limit: 50,
  link_previews: true,
  search_note_bodies: true,
  search_case_sensitive: false,
  update_channel: "stable",
  task_statuses: defaultTaskStatusDocuments(),
};

function normalizedDocument(document: SettingsDocument): SettingsDocument {
  return {
    ...document,
    theme: isThemeName(document.theme)
      ? document.theme
      : DEFAULT_SETTINGS.theme,
    light_palette: isLightPaletteName(document.light_palette)
      ? document.light_palette
      : DEFAULT_SETTINGS.light_palette,
    dark_palette: isDarkPaletteName(document.dark_palette)
      ? document.dark_palette
      : DEFAULT_SETTINGS.dark_palette,
    zoom_percent:
      Number.isInteger(document.zoom_percent) &&
      document.zoom_percent >= 50 &&
      document.zoom_percent <= 200 &&
      document.zoom_percent % 10 === 0
        ? document.zoom_percent
        : DEFAULT_SETTINGS.zoom_percent,
    link_previews:
      typeof document.link_previews === "boolean"
        ? document.link_previews
        : DEFAULT_SETTINGS.link_previews,
    task_statuses: validateTaskStatusDocuments(document.task_statuses),
  };
}

export type SettingsState = {
  document: SettingsDocument;
  /** Human-readable failure of the last read or write, or null. */
  error: string | null;
  /** Setting whose write failed, or `document` for whole-file failures. */
  errorSetting: keyof SettingsDocument | "document" | null;
  /** Whether a read has succeeded since startup. */
  loaded: boolean;
};

type SettingsIo = {
  read(): Promise<SettingsDocument>;
  write(doc: SettingsDocument): Promise<void>;
};

export class SettingsStore {
  private loadPromise: Promise<void> | null = null;
  private persistedDocument: SettingsDocument = DEFAULT_SETTINGS;
  private writeQueue: Promise<void> = Promise.resolve();
  private revision = 0;
  private state: SettingsState = {
    document: DEFAULT_SETTINGS,
    error: null,
    errorSetting: null,
    loaded: false,
  };

  constructor(
    private readonly onChange: (state: SettingsState) => void,
    private readonly io: SettingsIo = {
      read: settingsRead,
      write: settingsWrite,
    },
  ) {}

  get snapshot(): SettingsState {
    return this.state;
  }

  /** Applies a document fragment already persisted by the native runtime. */
  applyExternal(patch: Partial<SettingsDocument>): void {
    const document = normalizedDocument({ ...this.state.document, ...patch });
    this.revision += 1;
    this.persistedDocument = document;
    this.publish({
      document,
      error: null,
      errorSetting: null,
      loaded: this.state.loaded,
    });
  }

  private publish(state: SettingsState): void {
    this.state = state;
    this.onChange(state);
  }

  /**
   * Loads the persisted document. A failed read keeps the defaults and
   * records the error; the settings view surfaces it, the rest of the
   * application runs on defaults.
   */
  async load(): Promise<void> {
    if (this.loadPromise !== null) {
      return this.loadPromise;
    }
    const pending = this.loadOnce();
    this.loadPromise = pending;
    await pending;
    if (!this.state.loaded && this.loadPromise === pending) {
      this.loadPromise = null;
    }
  }

  private async loadOnce(): Promise<void> {
    try {
      const document = normalizedDocument(await this.io.read());
      this.persistedDocument = document;
      this.publish({ document, error: null, errorSetting: null, loaded: true });
    } catch (error) {
      this.publish({
        document: this.state.document,
        error: String(error),
        errorSetting: "document",
        loaded: false,
      });
    }
  }

  /**
   * Applies a partial update optimistically and persists the result. On
   * write failure the previous document is restored and the error kept
   * for the view.
   */
  async update(patch: Partial<SettingsDocument>): Promise<boolean> {
    if (!this.state.loaded) {
      await this.load();
      if (!this.state.loaded) {
        return false;
      }
    }
    const previous = this.state.document;
    const next = normalizedDocument({ ...previous, ...patch });
    const patchKeys = Object.keys(patch) as (keyof SettingsDocument)[];
    const errorSetting =
      patchKeys.length === 1 ? (patchKeys[0] ?? "document") : "document";
    const revision = ++this.revision;
    this.publish({
      document: next,
      error: null,
      errorSetting: null,
      loaded: this.state.loaded,
    });

    const write = this.writeQueue.then(() => this.io.write(next));
    this.writeQueue = write.catch(() => {});
    try {
      await write;
      this.persistedDocument = next;
      return true;
    } catch (error) {
      if (revision === this.revision) {
        this.publish({
          document: this.persistedDocument,
          error: String(error),
          errorSetting,
          loaded: this.state.loaded,
        });
      }
      return false;
    }
  }
}
