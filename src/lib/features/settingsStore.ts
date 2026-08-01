// The settings model over `settings_read`/`settings_write`: one loaded
// document, optimistic updates (apply first, persist after, revert and
// surface on failure). I/O is injected so the store is testable at the
// IPC boundary.

import {
  type SettingsDocument,
  settingsRead,
  settingsWrite,
} from "../ipc/services";

export type { SettingsDocument };

export const DEFAULT_SETTINGS: SettingsDocument = {
  schema_version: 1,
  theme: "system",
  editor_font_size: 17,
  editor_reading_measure: 76,
  search_result_limit: 50,
};

export type SettingsState = {
  document: SettingsDocument;
  /** Human-readable failure of the last read or write, or null. */
  error: string | null;
  /** Whether a read has succeeded since startup. */
  loaded: boolean;
};

type SettingsIo = {
  read(): Promise<SettingsDocument>;
  write(doc: SettingsDocument): Promise<void>;
};

export class SettingsStore {
  private state: SettingsState = {
    document: DEFAULT_SETTINGS,
    error: null,
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
    try {
      const document = await this.io.read();
      this.publish({ document, error: null, loaded: true });
    } catch (error) {
      this.publish({
        document: this.state.document,
        error: String(error),
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
    const previous = this.state.document;
    const next = { ...previous, ...patch };
    this.publish({ document: next, error: null, loaded: this.state.loaded });
    try {
      await this.io.write(next);
      return true;
    } catch (error) {
      this.publish({
        document: previous,
        error: String(error),
        loaded: this.state.loaded,
      });
      return false;
    }
  }
}
