//! Application settings: `settings.json` in the OS app-config directory,
//! never in any vault. Typed known keys are validated while unknown keys
//! survive writes unchanged so newer settings remain forward compatible.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::fs::{FileSystem, FsError};
use crate::path::VaultPath;
use crate::vault::is_indexed_path;
use crate::write::write_durable;

/// File name of the settings document inside the OS app-config directory.
pub const SETTINGS_FILE_NAME: &str = "settings.json";

/// Schema version written by this build.
pub const SETTINGS_SCHEMA_VERSION: u32 = 2;

/// Semantic category used by task status rendering and accessibility.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TaskStatusCategory {
    /// An open task.
    Todo,
    /// Work is underway.
    InProgress,
    /// Work is intentionally paused.
    OnHold,
    /// Work is complete.
    Done,
    /// Work was cancelled.
    Cancelled,
    /// A checkbox-like marker that is not a task.
    NonTask,
}

/// Track that groups a task status by its purpose.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatusTrack {
    /// Ordinary task state.
    Task,
    /// A dated task state.
    Time,
    /// A task importance marker.
    Importance,
    /// A user-defined reference marker.
    Reference,
}

/// Optional plain-text payload associated with a task status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatusPayload {
    /// An Obsidian Tasks date token.
    Date,
    /// An importance-level token.
    Level,
}

/// One configured task marker. `next_status` names another symbol in the
/// same ordered list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskStatus {
    /// The single source character between brackets.
    pub symbol: String,
    /// Custom status name, or empty when the frontend resolves a default name.
    pub name: String,
    /// Semantic status category.
    pub category: TaskStatusCategory,
    /// Short glyph rendered inside the checkbox.
    pub glyph: String,
    /// Existing CSS theme custom property used for the status color.
    pub color_token: String,
    /// Symbol written by the default click transition.
    pub next_status: String,
    /// Optional grouping metadata. Absent fields remain absent on writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub track: Option<TaskStatusTrack>,
    /// Optional payload metadata. Absent fields remain absent on writes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<TaskStatusPayload>,
}

type DefaultTaskStatusRow = (
    &'static str,
    TaskStatusCategory,
    &'static str,
    &'static str,
    &'static str,
    TaskStatusTrack,
    Option<TaskStatusPayload>,
);

const DEFAULT_TASK_STATUS_ROWS: &[DefaultTaskStatusRow] = &[
    (
        " ",
        TaskStatusCategory::Todo,
        // Todo, the default cycle's entry state, is the empty checkbox
        // (design system section 3.6): the checkbox box itself, with no
        // glyph layered inside it, matching `DEFAULT_TASK_STATUSES` in
        // `src/lib/taskStatuses.ts`.
        "",
        "--skr-accent",
        "/",
        TaskStatusTrack::Task,
        None,
    ),
    (
        "/",
        TaskStatusCategory::InProgress,
        "◐",
        "--skr-warning",
        "x",
        TaskStatusTrack::Task,
        None,
    ),
    (
        "x",
        TaskStatusCategory::Done,
        "✓",
        "--skr-success",
        " ",
        TaskStatusTrack::Task,
        None,
    ),
    (
        "-",
        TaskStatusCategory::Cancelled,
        "✕",
        "--skr-danger",
        " ",
        TaskStatusTrack::Task,
        None,
    ),
    (
        "X",
        TaskStatusCategory::Done,
        "✔",
        "--skr-success",
        " ",
        TaskStatusTrack::Task,
        None,
    ),
    (
        "D",
        TaskStatusCategory::Todo,
        "◷",
        "--skr-accent",
        "x",
        TaskStatusTrack::Time,
        Some(TaskStatusPayload::Date),
    ),
    (
        "<",
        TaskStatusCategory::Todo,
        "←",
        "--skr-accent",
        "x",
        TaskStatusTrack::Time,
        Some(TaskStatusPayload::Date),
    ),
    (
        ">",
        TaskStatusCategory::Todo,
        "→",
        "--skr-accent",
        "x",
        TaskStatusTrack::Time,
        Some(TaskStatusPayload::Date),
    ),
    (
        "!",
        TaskStatusCategory::Todo,
        "!",
        "--skr-accent",
        "!",
        TaskStatusTrack::Importance,
        Some(TaskStatusPayload::Level),
    ),
    (
        "?",
        TaskStatusCategory::Todo,
        "?",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "+",
        TaskStatusCategory::Todo,
        "+",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "R",
        TaskStatusCategory::Todo,
        "⌕",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "i",
        TaskStatusCategory::Todo,
        "◇",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "B",
        TaskStatusCategory::Todo,
        "◎",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "P",
        TaskStatusCategory::Todo,
        "+",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "C",
        TaskStatusCategory::Todo,
        "−",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "Q",
        TaskStatusCategory::Todo,
        "❝",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "N",
        TaskStatusCategory::Todo,
        "▤",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "b",
        TaskStatusCategory::Todo,
        "◆",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "I",
        TaskStatusCategory::Todo,
        "ⓘ",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "p",
        TaskStatusCategory::Todo,
        "¶",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "L",
        TaskStatusCategory::Todo,
        "⌖",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "E",
        TaskStatusCategory::Todo,
        "◇",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "A",
        TaskStatusCategory::Todo,
        "↳",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "r",
        TaskStatusCategory::Todo,
        "★",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "c",
        TaskStatusCategory::Todo,
        "◆",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "d",
        TaskStatusCategory::InProgress,
        "◒",
        "--skr-warning",
        "x",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "T",
        TaskStatusCategory::Todo,
        "◷",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "@",
        TaskStatusCategory::Todo,
        "@",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "t",
        TaskStatusCategory::Todo,
        "◖",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "O",
        TaskStatusCategory::Todo,
        "☰",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "~",
        TaskStatusCategory::Todo,
        "≈",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "W",
        TaskStatusCategory::Todo,
        "◉",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "f",
        TaskStatusCategory::Todo,
        "?",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "F",
        TaskStatusCategory::Todo,
        "⋙",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "H",
        TaskStatusCategory::Todo,
        "♥",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "&",
        TaskStatusCategory::Todo,
        "§",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
    (
        "s",
        TaskStatusCategory::Todo,
        "◆",
        "--skr-accent",
        "/",
        TaskStatusTrack::Reference,
        None,
    ),
];

/// Default task status configuration.
#[must_use]
pub fn default_task_statuses() -> Vec<TaskStatus> {
    DEFAULT_TASK_STATUS_ROWS
        .iter()
        .map(
            |(symbol, category, glyph, color_token, next_status, track, payload)| TaskStatus {
                symbol: (*symbol).to_owned(),
                name: String::new(),
                category: *category,
                glyph: (*glyph).to_owned(),
                color_token: (*color_token).to_owned(),
                next_status: (*next_status).to_owned(),
                track: Some(*track),
                payload: *payload,
            },
        )
        .collect()
}

/// Settings failures.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SettingsError {
    /// The settings file exists but is not a JSON object.
    #[error("settings file is not a JSON object")]
    Corrupt,
    /// A value is outside its accepted range or set.
    #[error("settings value out of range: {0}")]
    InvalidValue(&'static str),
    /// A filesystem operation failed.
    #[error(transparent)]
    Fs(#[from] FsError),
}

/// The typed settings document. Unknown keys in the file pass through writes
/// untouched, including retired keys from earlier schemas.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "flat fields mirror the forward-compatible settings document"
)]
pub struct Settings {
    pub schema_version: u32,
    pub theme: String,
    /// Palette used in light mode.
    pub light_palette: String,
    /// Palette used in dark mode.
    pub dark_palette: String,
    pub prose_font: String,
    pub code_font: String,
    /// Application webview zoom as an integer percentage.
    pub zoom_percent: u32,
    pub editor_font_size: u32,
    pub editor_line_height: u32,
    pub editor_line_width: u32,
    pub show_line_numbers: bool,
    pub animations: bool,
    pub autosave_delay_ms: u32,
    pub spell_check: bool,
    pub indent_style: String,
    pub indent_width: u32,
    pub wrap_long_lines: bool,
    pub show_invisible_characters: bool,
    pub reveal_markdown_syntax: bool,
    pub default_note_folder: String,
    pub attachment_folder_mode: String,
    pub attachment_folder_path: String,
    pub honor_obsidian_config: bool,
    pub search_result_limit: u32,
    /// Whether note links show rendered previews.
    pub link_previews: bool,
    pub search_note_bodies: bool,
    pub search_case_sensitive: bool,
    /// Whether the desktop shell asks the update server once at startup.
    pub check_updates_on_startup: bool,
    /// Ordered task marker vocabulary and click-transition graph.
    pub task_statuses: Vec<TaskStatus>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            theme: "system".to_owned(),
            light_palette: "manuscript".to_owned(),
            dark_palette: "nightroom".to_owned(),
            prose_font: "serif".to_owned(),
            code_font: "modern".to_owned(),
            zoom_percent: 100,
            editor_font_size: 16,
            editor_line_height: 170,
            editor_line_width: 72,
            show_line_numbers: false,
            animations: true,
            autosave_delay_ms: 400,
            spell_check: true,
            indent_style: "spaces".to_owned(),
            indent_width: 2,
            wrap_long_lines: true,
            show_invisible_characters: false,
            reveal_markdown_syntax: true,
            default_note_folder: String::new(),
            attachment_folder_mode: "vault".to_owned(),
            attachment_folder_path: "attachments".to_owned(),
            honor_obsidian_config: true,
            search_result_limit: 50,
            link_previews: true,
            search_note_bodies: true,
            search_case_sensitive: false,
            check_updates_on_startup: true,
            task_statuses: default_task_statuses(),
        }
    }
}

const THEMES: &[&str] = &["system", "light", "dark"];
/// Accepted light palette values.
const LIGHT_PALETTES: &[&str] = &["manuscript", "studio", "gazette"];
/// Accepted dark palette values.
const DARK_PALETTES: &[&str] = &["nightroom", "graphite", "signal"];
const PROSE_FONTS: &[&str] = &["serif", "sans"];
const CODE_FONTS: &[&str] = &["modern", "classic"];
/// Inclusive application zoom range, represented without floating-point drift.
pub const ZOOM_PERCENT_RANGE: (u32, u32) = (50, 200);
/// Application zoom increment in percentage points.
pub const ZOOM_PERCENT_STEP: u32 = 10;
const FONT_SIZE_RANGE: (u32, u32) = (8, 40);
const LINE_HEIGHT_RANGE: (u32, u32) = (120, 220);
const LINE_WIDTH_RANGE: (u32, u32) = (45, 120);
const AUTOSAVE_DELAY_RANGE: (u32, u32) = (100, 10_000);
const INDENT_STYLES: &[&str] = &["spaces", "tabs"];
const INDENT_WIDTH_RANGE: (u32, u32) = (1, 8);
const ATTACHMENT_FOLDER_MODES: &[&str] = &["vault", "note", "folder"];
const RESULT_LIMIT_RANGE: (u32, u32) = (1, 1000);

impl Settings {
    /// Validates every typed value before a write touches the file.
    ///
    /// # Errors
    ///
    /// Returns [`SettingsError::InvalidValue`] when any field falls outside
    /// its accepted range, choice set, path rules, or task-status graph.
    pub fn validate(&self) -> Result<(), SettingsError> {
        validate_choice("theme", &self.theme, THEMES)?;
        validate_choice("light_palette", &self.light_palette, LIGHT_PALETTES)?;
        validate_choice("dark_palette", &self.dark_palette, DARK_PALETTES)?;
        validate_choice("prose_font", &self.prose_font, PROSE_FONTS)?;
        validate_choice("code_font", &self.code_font, CODE_FONTS)?;
        validate_zoom_percent(self.zoom_percent)?;
        validate_range("editor_font_size", self.editor_font_size, FONT_SIZE_RANGE)?;
        validate_range(
            "editor_line_height",
            self.editor_line_height,
            LINE_HEIGHT_RANGE,
        )?;
        validate_range(
            "editor_line_width",
            self.editor_line_width,
            LINE_WIDTH_RANGE,
        )?;
        validate_range(
            "autosave_delay_ms",
            self.autosave_delay_ms,
            AUTOSAVE_DELAY_RANGE,
        )?;
        validate_choice("indent_style", &self.indent_style, INDENT_STYLES)?;
        validate_range("indent_width", self.indent_width, INDENT_WIDTH_RANGE)?;
        if !is_safe_vault_folder(&self.default_note_folder, true) {
            return Err(SettingsError::InvalidValue("default_note_folder"));
        }
        validate_choice(
            "attachment_folder_mode",
            &self.attachment_folder_mode,
            ATTACHMENT_FOLDER_MODES,
        )?;
        if !is_safe_vault_folder(&self.attachment_folder_path, false) {
            return Err(SettingsError::InvalidValue("attachment_folder_path"));
        }
        validate_range(
            "search_result_limit",
            self.search_result_limit,
            RESULT_LIMIT_RANGE,
        )?;
        if !valid_task_statuses(&self.task_statuses) {
            return Err(SettingsError::InvalidValue("task_statuses"));
        }
        Ok(())
    }
}

/// Validates an application zoom percentage against its range and step.
///
/// # Errors
///
/// Returns [`SettingsError::InvalidValue`] unless `value` is an exact
/// ten-point increment from 50 through 200.
pub fn validate_zoom_percent(value: u32) -> Result<(), SettingsError> {
    if (ZOOM_PERCENT_RANGE.0..=ZOOM_PERCENT_RANGE.1).contains(&value)
        && value.is_multiple_of(ZOOM_PERCENT_STEP)
    {
        Ok(())
    } else {
        Err(SettingsError::InvalidValue("zoom_percent"))
    }
}

fn validate_choice(key: &'static str, value: &str, choices: &[&str]) -> Result<(), SettingsError> {
    if choices.contains(&value) {
        Ok(())
    } else {
        Err(SettingsError::InvalidValue(key))
    }
}

fn validate_range(key: &'static str, value: u32, range: (u32, u32)) -> Result<(), SettingsError> {
    if (range.0..=range.1).contains(&value) {
        Ok(())
    } else {
        Err(SettingsError::InvalidValue(key))
    }
}

/// The settings store at a fixed file path.
#[derive(Debug, Clone)]
pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    /// A store at `path`.
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// The settings file path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Reads the settings document. Each malformed known key falls back to
    /// its default while the on-disk value remains available for preservation
    /// until a subsequent successful write.
    ///
    /// # Errors
    ///
    /// Returns an error when the file cannot be read or its root is not a JSON
    /// object. Malformed individual settings do not produce an error.
    pub fn read(&self, fs: &dyn FileSystem) -> Result<Settings, SettingsError> {
        let object = match self.read_object(fs) {
            Ok(object) => object,
            Err(SettingsError::Fs(FsError::NotFound)) => return Ok(Settings::default()),
            Err(error) => return Err(error),
        };
        let defaults = Settings::default();
        Ok(Settings {
            schema_version: read_u32(&object, "schema_version").unwrap_or(defaults.schema_version),
            theme: read_choice(&object, "theme", THEMES, &defaults.theme),
            light_palette: read_choice(
                &object,
                "light_palette",
                LIGHT_PALETTES,
                &defaults.light_palette,
            ),
            dark_palette: read_choice(
                &object,
                "dark_palette",
                DARK_PALETTES,
                &defaults.dark_palette,
            ),
            prose_font: read_choice(&object, "prose_font", PROSE_FONTS, &defaults.prose_font),
            code_font: read_choice(&object, "code_font", CODE_FONTS, &defaults.code_font),
            zoom_percent: read_in_range(&object, "zoom_percent", ZOOM_PERCENT_RANGE)
                .filter(|value| value.is_multiple_of(ZOOM_PERCENT_STEP))
                .unwrap_or(defaults.zoom_percent),
            editor_font_size: read_in_range(&object, "editor_font_size", FONT_SIZE_RANGE)
                .unwrap_or(defaults.editor_font_size),
            editor_line_height: read_in_range(&object, "editor_line_height", LINE_HEIGHT_RANGE)
                .unwrap_or(defaults.editor_line_height),
            editor_line_width: read_in_range(&object, "editor_line_width", LINE_WIDTH_RANGE)
                .or_else(|| read_in_range(&object, "editor_reading_measure", LINE_WIDTH_RANGE))
                .unwrap_or(defaults.editor_line_width),
            show_line_numbers: read_bool(&object, "show_line_numbers")
                .unwrap_or(defaults.show_line_numbers),
            animations: read_bool(&object, "animations").unwrap_or(defaults.animations),
            autosave_delay_ms: read_in_range(&object, "autosave_delay_ms", AUTOSAVE_DELAY_RANGE)
                .unwrap_or(defaults.autosave_delay_ms),
            spell_check: read_bool(&object, "spell_check").unwrap_or(defaults.spell_check),
            indent_style: read_choice(
                &object,
                "indent_style",
                INDENT_STYLES,
                &defaults.indent_style,
            ),
            indent_width: read_in_range(&object, "indent_width", INDENT_WIDTH_RANGE)
                .unwrap_or(defaults.indent_width),
            wrap_long_lines: read_bool(&object, "wrap_long_lines")
                .unwrap_or(defaults.wrap_long_lines),
            show_invisible_characters: read_bool(&object, "show_invisible_characters")
                .unwrap_or(defaults.show_invisible_characters),
            reveal_markdown_syntax: read_bool(&object, "reveal_markdown_syntax")
                .unwrap_or(defaults.reveal_markdown_syntax),
            default_note_folder: read_folder(&object, "default_note_folder", true)
                .unwrap_or_else(|| defaults.default_note_folder.clone()),
            attachment_folder_mode: read_choice(
                &object,
                "attachment_folder_mode",
                ATTACHMENT_FOLDER_MODES,
                &defaults.attachment_folder_mode,
            ),
            attachment_folder_path: read_folder(&object, "attachment_folder_path", false)
                .unwrap_or_else(|| defaults.attachment_folder_path.clone()),
            honor_obsidian_config: read_bool(&object, "honor_obsidian_config")
                .unwrap_or(defaults.honor_obsidian_config),
            search_result_limit: read_in_range(&object, "search_result_limit", RESULT_LIMIT_RANGE)
                .unwrap_or(defaults.search_result_limit),
            link_previews: read_bool(&object, "link_previews").unwrap_or(defaults.link_previews),
            search_note_bodies: read_bool(&object, "search_note_bodies")
                .unwrap_or(defaults.search_note_bodies),
            search_case_sensitive: read_bool(&object, "search_case_sensitive")
                .unwrap_or(defaults.search_case_sensitive),
            check_updates_on_startup: read_bool(&object, "check_updates_on_startup")
                .unwrap_or(defaults.check_updates_on_startup),
            task_statuses: object
                .get("task_statuses")
                .cloned()
                .and_then(|value| serde_json::from_value::<Vec<TaskStatus>>(value).ok())
                .filter(|statuses| valid_task_statuses(statuses))
                .unwrap_or(defaults.task_statuses),
        })
    }

    /// Writes the settings document, validating it first and preserving every
    /// unknown key already in the file. The write is whole-document and durable.
    ///
    /// # Errors
    ///
    /// Returns an error when validation, serialization, directory creation, or
    /// the durable filesystem write fails.
    pub fn write(&self, fs: &dyn FileSystem, settings: &Settings) -> Result<(), SettingsError> {
        settings.validate()?;
        let mut object = match self.read_object(fs) {
            Ok(object) => object,
            Err(SettingsError::Fs(FsError::NotFound)) => Map::new(),
            Err(error) => return Err(error),
        };
        for (key, value) in [
            ("schema_version", Value::from(settings.schema_version)),
            ("theme", Value::from(settings.theme.clone())),
            ("light_palette", Value::from(settings.light_palette.clone())),
            ("dark_palette", Value::from(settings.dark_palette.clone())),
            ("prose_font", Value::from(settings.prose_font.clone())),
            ("code_font", Value::from(settings.code_font.clone())),
            ("zoom_percent", Value::from(settings.zoom_percent)),
            ("editor_font_size", Value::from(settings.editor_font_size)),
            (
                "editor_line_height",
                Value::from(settings.editor_line_height),
            ),
            ("editor_line_width", Value::from(settings.editor_line_width)),
            ("show_line_numbers", Value::from(settings.show_line_numbers)),
            ("animations", Value::from(settings.animations)),
            ("autosave_delay_ms", Value::from(settings.autosave_delay_ms)),
            ("spell_check", Value::from(settings.spell_check)),
            ("indent_style", Value::from(settings.indent_style.clone())),
            ("indent_width", Value::from(settings.indent_width)),
            ("wrap_long_lines", Value::from(settings.wrap_long_lines)),
            (
                "show_invisible_characters",
                Value::from(settings.show_invisible_characters),
            ),
            (
                "reveal_markdown_syntax",
                Value::from(settings.reveal_markdown_syntax),
            ),
            (
                "default_note_folder",
                Value::from(settings.default_note_folder.clone()),
            ),
            (
                "attachment_folder_mode",
                Value::from(settings.attachment_folder_mode.clone()),
            ),
            (
                "attachment_folder_path",
                Value::from(settings.attachment_folder_path.clone()),
            ),
            (
                "honor_obsidian_config",
                Value::from(settings.honor_obsidian_config),
            ),
            (
                "search_result_limit",
                Value::from(settings.search_result_limit),
            ),
            ("link_previews", Value::from(settings.link_previews)),
            (
                "search_note_bodies",
                Value::from(settings.search_note_bodies),
            ),
            (
                "search_case_sensitive",
                Value::from(settings.search_case_sensitive),
            ),
            (
                "check_updates_on_startup",
                Value::from(settings.check_updates_on_startup),
            ),
        ] {
            object.insert(key.to_owned(), value);
        }
        let task_statuses =
            merged_task_statuses(object.get("task_statuses"), &settings.task_statuses)?;
        object.insert("task_statuses".to_owned(), task_statuses);
        let mut bytes = serde_json::to_vec_pretty(&Value::Object(object))
            .map_err(|_| SettingsError::Corrupt)?;
        bytes.push(b'\n');
        if let Some(parent) = self.path.parent()
            && fs.metadata(parent).is_err()
        {
            fs.create_dir_all(parent)?;
        }
        write_durable(fs, &self.path, &bytes)?;
        Ok(())
    }

    fn read_object(&self, fs: &dyn FileSystem) -> Result<Map<String, Value>, SettingsError> {
        let bytes = fs.read(&self.path)?;
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(object)) => Ok(object),
            _ => Err(SettingsError::Corrupt),
        }
    }
}

fn read_u32(object: &Map<String, Value>, key: &str) -> Option<u32> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

fn read_in_range(object: &Map<String, Value>, key: &str, range: (u32, u32)) -> Option<u32> {
    read_u32(object, key).filter(|value| (range.0..=range.1).contains(value))
}

fn read_bool(object: &Map<String, Value>, key: &str) -> Option<bool> {
    object.get(key).and_then(Value::as_bool)
}

fn read_choice(object: &Map<String, Value>, key: &str, choices: &[&str], default: &str) -> String {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| choices.contains(value))
        .unwrap_or(default)
        .to_owned()
}

fn read_folder(object: &Map<String, Value>, key: &str, allow_empty: bool) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| is_safe_vault_folder(value, allow_empty))
        .map(ToOwned::to_owned)
}

fn is_safe_vault_folder(value: &str, allow_empty: bool) -> bool {
    if value.is_empty() {
        return allow_empty;
    }
    VaultPath::new(value).is_ok_and(|path| is_indexed_path(&path))
}

const MAX_TASK_STATUS_COUNT: usize = 128;
const MAX_TASK_STATUS_NAME_LENGTH: usize = 80;
const MAX_TASK_STATUS_GLYPH_LENGTH: usize = 8;
const TASK_COLOR_TOKENS: &[&str] = &[
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
];

fn single_source_character(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(character) = characters.next() else {
        return false;
    };
    characters.next().is_none()
        && character != '['
        && character != ']'
        && (!character.is_control() || character == ' ')
}

fn valid_color_token(value: &str) -> bool {
    TASK_COLOR_TOKENS.contains(&value)
}

fn valid_task_statuses(statuses: &[TaskStatus]) -> bool {
    if statuses.is_empty() || statuses.len() > MAX_TASK_STATUS_COUNT {
        return false;
    }
    let symbols: HashSet<&str> = statuses
        .iter()
        .map(|status| status.symbol.as_str())
        .collect();
    if symbols.len() != statuses.len() {
        return false;
    }
    statuses.iter().all(|status| {
        single_source_character(&status.symbol)
            && (!status.name.trim().is_empty()
                || (status.name.is_empty()
                    && DEFAULT_TASK_STATUS_ROWS
                        .iter()
                        .any(|(symbol, ..)| *symbol == status.symbol)))
            && status.name.chars().count() <= MAX_TASK_STATUS_NAME_LENGTH
            && {
                // Empty is valid: it is how the default Todo state asks the
                // checkbox to render as its bare box, with no glyph layered
                // inside it (design system section 3.6).
                let glyph_length = status.glyph.chars().count();
                glyph_length <= MAX_TASK_STATUS_GLYPH_LENGTH
                    && !status.glyph.chars().any(char::is_control)
            }
            && valid_color_token(&status.color_token)
            && single_source_character(&status.next_status)
            && symbols.contains(status.next_status.as_str())
    })
}

fn merged_task_statuses(
    existing: Option<&Value>,
    statuses: &[TaskStatus],
) -> Result<Value, SettingsError> {
    let existing_entries = existing.and_then(Value::as_array);
    let mut merged = Vec::with_capacity(statuses.len());
    let mut used_existing = HashSet::new();
    for (status_index, status) in statuses.iter().enumerate() {
        let existing_match = existing_entries
            .and_then(|entries| {
                entries.iter().enumerate().find_map(|(entry_index, entry)| {
                    if used_existing.contains(&entry_index) {
                        return None;
                    }
                    let object = entry.as_object()?;
                    (object.get("symbol").and_then(Value::as_str) == Some(&status.symbol))
                        .then(|| (entry_index, object.clone()))
                })
            })
            .or_else(|| {
                existing_entries.and_then(|entries| {
                    let object = entries.get(status_index)?.as_object()?;
                    (!used_existing.contains(&status_index)).then(|| (status_index, object.clone()))
                })
            });
        let mut object = match existing_match {
            Some((entry_index, object)) => {
                used_existing.insert(entry_index);
                object
            }
            None => Map::new(),
        };
        let known = serde_json::to_value(status).map_err(|_| SettingsError::Corrupt)?;
        let Value::Object(known) = known else {
            return Err(SettingsError::Corrupt);
        };
        object.extend(known);
        merged.push(Value::Object(object));
    }
    Ok(Value::Array(merged))
}
