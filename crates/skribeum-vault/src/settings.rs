//! Application settings: `settings.json` in the OS app-config directory,
//! never in any vault, per the architecture contract. The document carries
//! a `schema_version` and typed known keys; unknown keys are preserved
//! byte-for-byte-equivalent on every write, so a newer build's settings
//! survive a round trip through an older one. All file access goes through
//! the [`FileSystem`] trait and the crash-safe durable write sequence.

use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::fs::{FileSystem, FsError};
use crate::write::write_durable;

/// File name of the settings document inside the OS app-config directory.
pub const SETTINGS_FILE_NAME: &str = "settings.json";

/// Schema version written by this build.
pub const SETTINGS_SCHEMA_VERSION: u32 = 1;

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

/// One configured task marker. `next_status` names another symbol in the
/// same ordered list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskStatus {
    /// The single source character between brackets.
    pub symbol: String,
    /// Human-readable status name.
    pub name: String,
    /// Semantic status category.
    pub category: TaskStatusCategory,
    /// Short glyph rendered inside the checkbox.
    pub glyph: String,
    /// Existing CSS theme custom property used for the status color.
    pub color_token: String,
    /// Symbol written by the default click transition.
    pub next_status: String,
}

const DEFAULT_TASK_STATUS_ROWS: &[(&str, &str, TaskStatusCategory, &str, &str, &str)] = &[
    (
        " ",
        "Unchecked",
        TaskStatusCategory::Todo,
        "○",
        "--skr-accent",
        "/",
    ),
    (
        "x",
        "Regular",
        TaskStatusCategory::Done,
        "✓",
        "--skr-success",
        " ",
    ),
    (
        "X",
        "Checked",
        TaskStatusCategory::Done,
        "✔",
        "--skr-success",
        " ",
    ),
    (
        "-",
        "Dropped",
        TaskStatusCategory::Cancelled,
        "✕",
        "--skr-danger",
        " ",
    ),
    (
        ">",
        "Forward",
        TaskStatusCategory::Todo,
        "→",
        "--skr-accent",
        "/",
    ),
    (
        "<",
        "Migrated",
        TaskStatusCategory::Todo,
        "←",
        "--skr-accent",
        "/",
    ),
    (
        "D",
        "Date",
        TaskStatusCategory::Todo,
        "◷",
        "--skr-accent",
        "/",
    ),
    (
        "?",
        "Question",
        TaskStatusCategory::Todo,
        "?",
        "--skr-accent",
        "/",
    ),
    (
        "/",
        "Half Done",
        TaskStatusCategory::InProgress,
        "◐",
        "--skr-warning",
        "x",
    ),
    (
        "+",
        "Add",
        TaskStatusCategory::Todo,
        "+",
        "--skr-accent",
        "/",
    ),
    (
        "R",
        "Research",
        TaskStatusCategory::Todo,
        "⌕",
        "--skr-accent",
        "/",
    ),
    (
        "!",
        "Important",
        TaskStatusCategory::Todo,
        "!",
        "--skr-accent",
        "/",
    ),
    (
        "i",
        "Idea",
        TaskStatusCategory::Todo,
        "◇",
        "--skr-accent",
        "/",
    ),
    (
        "B",
        "Brainstorm",
        TaskStatusCategory::Todo,
        "◎",
        "--skr-accent",
        "/",
    ),
    (
        "P",
        "Pro",
        TaskStatusCategory::Todo,
        "+",
        "--skr-accent",
        "/",
    ),
    (
        "C",
        "Con",
        TaskStatusCategory::Todo,
        "−",
        "--skr-accent",
        "/",
    ),
    (
        "Q",
        "Quote",
        TaskStatusCategory::Todo,
        "❝",
        "--skr-accent",
        "/",
    ),
    (
        "N",
        "Note",
        TaskStatusCategory::Todo,
        "▤",
        "--skr-accent",
        "/",
    ),
    (
        "b",
        "Bookmark",
        TaskStatusCategory::Todo,
        "◆",
        "--skr-accent",
        "/",
    ),
    (
        "I",
        "Information",
        TaskStatusCategory::Todo,
        "ⓘ",
        "--skr-accent",
        "/",
    ),
    (
        "p",
        "Paraphrase",
        TaskStatusCategory::Todo,
        "¶",
        "--skr-accent",
        "/",
    ),
    (
        "L",
        "Location",
        TaskStatusCategory::Todo,
        "⌖",
        "--skr-accent",
        "/",
    ),
    (
        "E",
        "Example",
        TaskStatusCategory::Todo,
        "◇",
        "--skr-accent",
        "/",
    ),
    (
        "A",
        "Answer",
        TaskStatusCategory::Todo,
        "↳",
        "--skr-accent",
        "/",
    ),
    (
        "r",
        "Reward",
        TaskStatusCategory::Todo,
        "★",
        "--skr-accent",
        "/",
    ),
    (
        "c",
        "Choice",
        TaskStatusCategory::Todo,
        "◆",
        "--skr-accent",
        "/",
    ),
    (
        "d",
        "Doing",
        TaskStatusCategory::InProgress,
        "◒",
        "--skr-warning",
        "x",
    ),
    (
        "T",
        "Time",
        TaskStatusCategory::Todo,
        "◷",
        "--skr-accent",
        "/",
    ),
    (
        "@",
        "Character",
        TaskStatusCategory::Todo,
        "@",
        "--skr-accent",
        "/",
    ),
    (
        "t",
        "Talk",
        TaskStatusCategory::Todo,
        "◖",
        "--skr-accent",
        "/",
    ),
    (
        "O",
        "Outline",
        TaskStatusCategory::Todo,
        "☰",
        "--skr-accent",
        "/",
    ),
    (
        "~",
        "Conflict",
        TaskStatusCategory::Todo,
        "≈",
        "--skr-accent",
        "/",
    ),
    (
        "W",
        "World",
        TaskStatusCategory::Todo,
        "◉",
        "--skr-accent",
        "/",
    ),
    (
        "f",
        "Clue",
        TaskStatusCategory::Todo,
        "?",
        "--skr-accent",
        "/",
    ),
    (
        "F",
        "Foreshadow",
        TaskStatusCategory::Todo,
        "⋙",
        "--skr-accent",
        "/",
    ),
    (
        "H",
        "Favorite",
        TaskStatusCategory::Todo,
        "♥",
        "--skr-accent",
        "/",
    ),
    (
        "&",
        "Symbolism",
        TaskStatusCategory::Todo,
        "§",
        "--skr-accent",
        "/",
    ),
    (
        "s",
        "Secret",
        TaskStatusCategory::Todo,
        "◆",
        "--skr-accent",
        "/",
    ),
];

/// Default task status configuration.
#[must_use]
pub fn default_task_statuses() -> Vec<TaskStatus> {
    DEFAULT_TASK_STATUS_ROWS
        .iter()
        .map(
            |(symbol, name, category, glyph, color_token, next_status)| TaskStatus {
                symbol: (*symbol).to_owned(),
                name: (*name).to_owned(),
                category: *category,
                glyph: (*glyph).to_owned(),
                color_token: (*color_token).to_owned(),
                next_status: (*next_status).to_owned(),
            },
        )
        .collect()
}

/// Settings failures.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SettingsError {
    /// The settings file exists but is not a JSON object; nothing is
    /// guessed and nothing is overwritten.
    #[error("settings file is not a JSON object")]
    Corrupt,
    /// A value is outside its accepted range or set.
    #[error("settings value out of range: {0}")]
    InvalidValue(&'static str),
    /// A filesystem operation failed.
    #[error(transparent)]
    Fs(#[from] FsError),
}

/// The typed settings document. Kept deliberately minimal and growable:
/// every key here is consumed by a shipped surface, and unknown keys in the
/// file pass through writes untouched.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// Schema version of the document.
    pub schema_version: u32,
    /// Color theme: `system`, `light` or `dark`.
    pub theme: String,
    /// Editor font size in CSS pixels.
    pub editor_font_size: u32,
    /// Maximum number of results a search query returns.
    pub search_result_limit: u32,
    /// Ordered task marker vocabulary and click-transition graph.
    pub task_statuses: Vec<TaskStatus>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION,
            theme: "system".to_owned(),
            editor_font_size: 15,
            search_result_limit: 50,
            task_statuses: default_task_statuses(),
        }
    }
}

/// Accepted theme values.
const THEMES: &[&str] = &["system", "light", "dark"];
/// Accepted editor font size range in CSS pixels.
const FONT_SIZE_RANGE: (u32, u32) = (6, 128);
/// Accepted search result limit range.
const RESULT_LIMIT_RANGE: (u32, u32) = (1, 1000);

impl Settings {
    /// Validates every typed value.
    ///
    /// # Errors
    ///
    /// Returns [`SettingsError::InvalidValue`] naming the offending key.
    pub fn validate(&self) -> Result<(), SettingsError> {
        if !THEMES.contains(&self.theme.as_str()) {
            return Err(SettingsError::InvalidValue("theme"));
        }
        if self.editor_font_size < FONT_SIZE_RANGE.0 || self.editor_font_size > FONT_SIZE_RANGE.1 {
            return Err(SettingsError::InvalidValue("editor_font_size"));
        }
        if self.search_result_limit < RESULT_LIMIT_RANGE.0
            || self.search_result_limit > RESULT_LIMIT_RANGE.1
        {
            return Err(SettingsError::InvalidValue("search_result_limit"));
        }
        if !valid_task_statuses(&self.task_statuses) {
            return Err(SettingsError::InvalidValue("task_statuses"));
        }
        Ok(())
    }
}

/// The settings store at a fixed file path (conventionally
/// [`SETTINGS_FILE_NAME`] inside the OS app-config directory).
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

    /// Reads the settings document. A missing file yields the defaults; a
    /// present file must be a JSON object. Known keys with the wrong type
    /// and out-of-range values fall back to their defaults rather than
    /// failing the read: a bad value must never lock the user out of the
    /// settings surface, and the invalid value is preserved on disk until
    /// a write replaces it.
    ///
    /// # Errors
    ///
    /// Returns [`SettingsError::Corrupt`] when the file exists but does not
    /// parse as a JSON object, and propagates filesystem failures other
    /// than not-found.
    pub fn read(&self, fs: &dyn FileSystem) -> Result<Settings, SettingsError> {
        let object = match self.read_object(fs) {
            Ok(object) => object,
            Err(SettingsError::Fs(FsError::NotFound)) => return Ok(Settings::default()),
            Err(error) => return Err(error),
        };
        let defaults = Settings::default();
        let settings = Settings {
            schema_version: read_u32(&object, "schema_version").unwrap_or(defaults.schema_version),
            theme: object
                .get("theme")
                .and_then(Value::as_str)
                .filter(|theme| THEMES.contains(theme))
                .unwrap_or(&defaults.theme)
                .to_owned(),
            editor_font_size: read_u32(&object, "editor_font_size")
                .filter(|size| (FONT_SIZE_RANGE.0..=FONT_SIZE_RANGE.1).contains(size))
                .unwrap_or(defaults.editor_font_size),
            search_result_limit: read_u32(&object, "search_result_limit")
                .filter(|limit| (RESULT_LIMIT_RANGE.0..=RESULT_LIMIT_RANGE.1).contains(limit))
                .unwrap_or(defaults.search_result_limit),
            task_statuses: object
                .get("task_statuses")
                .cloned()
                .and_then(|value| serde_json::from_value::<Vec<TaskStatus>>(value).ok())
                .filter(|statuses| valid_task_statuses(statuses))
                .unwrap_or(defaults.task_statuses),
        };
        Ok(settings)
    }

    /// Writes the settings document, validating it first and preserving
    /// every unknown key already in the file. The write is whole-document
    /// and durable (temp file, fsync, rename).
    ///
    /// # Errors
    ///
    /// Returns [`SettingsError::InvalidValue`] for an out-of-range value,
    /// [`SettingsError::Corrupt`] when the existing file cannot be parsed
    /// (overwriting it would silently drop the unknown keys it may hold),
    /// and propagates filesystem failures.
    pub fn write(&self, fs: &dyn FileSystem, settings: &Settings) -> Result<(), SettingsError> {
        settings.validate()?;
        let mut object = match self.read_object(fs) {
            Ok(object) => object,
            Err(SettingsError::Fs(FsError::NotFound)) => Map::new(),
            Err(error) => return Err(error),
        };
        object.insert(
            "schema_version".to_owned(),
            Value::from(settings.schema_version),
        );
        object.insert("theme".to_owned(), Value::from(settings.theme.clone()));
        object.insert(
            "editor_font_size".to_owned(),
            Value::from(settings.editor_font_size),
        );
        object.insert(
            "search_result_limit".to_owned(),
            Value::from(settings.search_result_limit),
        );
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

/// Reads an unsigned 32-bit integer key from a JSON object.
fn read_u32(object: &Map<String, Value>, key: &str) -> Option<u32> {
    object
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
}

const MAX_TASK_STATUS_COUNT: usize = 128;
const MAX_TASK_STATUS_NAME_LENGTH: usize = 80;
const MAX_TASK_STATUS_GLYPH_LENGTH: usize = 8;

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
    let Some(suffix) = value.strip_prefix("--skr-") else {
        return false;
    };
    !suffix.is_empty()
        && !suffix.starts_with('-')
        && !suffix.ends_with('-')
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
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
            && !status.name.trim().is_empty()
            && status.name.chars().count() <= MAX_TASK_STATUS_NAME_LENGTH
            && {
                let glyph_length = status.glyph.chars().count();
                glyph_length > 0
                    && glyph_length <= MAX_TASK_STATUS_GLYPH_LENGTH
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
    for status in statuses {
        let mut object = existing_entries
            .and_then(|entries| {
                entries.iter().find_map(|entry| {
                    let object = entry.as_object()?;
                    (object.get("symbol").and_then(Value::as_str) == Some(&status.symbol))
                        .then(|| object.clone())
                })
            })
            .unwrap_or_default();
        let known = serde_json::to_value(status).map_err(|_| SettingsError::Corrupt)?;
        let Value::Object(known) = known else {
            return Err(SettingsError::Corrupt);
        };
        object.extend(known);
        merged.push(Value::Object(object));
    }
    Ok(Value::Array(merged))
}
