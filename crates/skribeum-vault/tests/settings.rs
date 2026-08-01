//! Settings-store gates: round trips through `settings.json` preserve
//! unknown keys byte-content-equivalent, missing files yield defaults,
//! corrupt files fail loudly instead of being clobbered, and invalid
//! values are rejected before anything is written. Everything runs on the
//! deterministic simulator; the store touches the filesystem only through
//! the `FileSystem` trait and the durable write sequence.

use std::path::PathBuf;

use serde_json::{Value, json};
use skribeum_vault::{
    FileSystem, SETTINGS_SCHEMA_VERSION, Settings, SettingsError, SettingsStore, SimFs, TaskStatus,
    TaskStatusCategory, default_task_statuses,
};

fn store() -> (SimFs, SettingsStore) {
    let fs = SimFs::new();
    fs.external_create_dir(&PathBuf::from("config"));
    (
        fs,
        SettingsStore::new(PathBuf::from("config/settings.json")),
    )
}

/// A missing file reads as the defaults.
#[test]
fn missing_file_yields_defaults() {
    let (fs, store) = store();
    let settings = store.read(&fs).expect("read succeeds");
    assert_eq!(settings, Settings::default());
    assert_eq!(settings.schema_version, SETTINGS_SCHEMA_VERSION);
    assert_eq!(settings.theme, "system");
    assert_eq!(settings.light_palette, "manuscript");
    assert_eq!(settings.dark_palette, "lamplight");
    assert_eq!(settings.editor_font_size, 16);
    assert_eq!(settings.editor_reading_measure, 72);
    assert!(settings.link_previews);
    assert_eq!(settings.task_statuses, default_task_statuses());
}

/// A full round trip: unknown keys already in the file, including nested
/// structures, survive a typed write untouched, and the typed keys update.
#[test]
fn write_preserves_unknown_keys() {
    let (fs, store) = store();
    fs.external_write(
        &PathBuf::from("config/settings.json"),
        br#"{
            "schema_version": 1,
            "theme": "dark",
            "light_palette": "studio",
            "dark_palette": "graphite",
            "editor_font_size": 18,
            "editor_reading_measure": 72,
            "search_result_limit": 25,
            "link_previews": false,
            "future_feature": {"enabled": true, "levels": [1, 2, 3]},
            "another_unknown": "keep me"
        }"#,
    );

    let mut settings = store.read(&fs).expect("read succeeds");
    assert_eq!(settings.theme, "dark");
    assert_eq!(settings.light_palette, "studio");
    assert_eq!(settings.dark_palette, "graphite");
    assert_eq!(settings.editor_font_size, 18);
    assert_eq!(settings.editor_reading_measure, 72);
    assert_eq!(settings.search_result_limit, 25);
    assert!(!settings.link_previews);

    settings.theme = "light".to_owned();
    settings.light_palette = "gazette".to_owned();
    settings.dark_palette = "signal".to_owned();
    settings.link_previews = true;
    settings.editor_font_size = 16;
    settings.editor_reading_measure = 76;
    store.write(&fs, &settings).expect("write succeeds");

    let bytes = fs
        .read(&PathBuf::from("config/settings.json"))
        .expect("file readable");
    let object: Value = serde_json::from_slice(&bytes).expect("valid JSON");
    assert_eq!(object["theme"], "light");
    assert_eq!(object["light_palette"], "gazette");
    assert_eq!(object["dark_palette"], "signal");
    assert_eq!(object["editor_font_size"], 16);
    assert_eq!(object["editor_reading_measure"], 76);
    assert_eq!(object["search_result_limit"], 25);
    assert_eq!(object["link_previews"], true);
    assert_eq!(object["future_feature"]["enabled"], true);
    assert_eq!(
        object["future_feature"]["levels"],
        Value::from(vec![1, 2, 3])
    );
    assert_eq!(object["another_unknown"], "keep me");

    let reread = store.read(&fs).expect("reread succeeds");
    assert_eq!(reread, settings, "the typed document round-trips");
}

/// A file that does not parse as a JSON object fails both read and write:
/// nothing is guessed, and unknown keys are never silently dropped by an
/// overwrite.
#[test]
fn corrupt_file_fails_loudly_and_is_never_clobbered() {
    let (fs, store) = store();
    let path = PathBuf::from("config/settings.json");
    fs.external_write(&path, b"not json at all {{{");

    assert_eq!(store.read(&fs), Err(SettingsError::Corrupt));
    assert_eq!(
        store.write(&fs, &Settings::default()),
        Err(SettingsError::Corrupt)
    );
    assert_eq!(
        fs.read(&path).expect("file still readable"),
        b"not json at all {{{",
        "the corrupt file is untouched"
    );

    // A JSON document that is not an object is equally corrupt.
    fs.external_write(&path, b"[1, 2, 3]");
    assert_eq!(store.read(&fs), Err(SettingsError::Corrupt));
}

/// Known keys with the wrong type or out-of-range values fall back to
/// their defaults on read; a bad value never locks the user out.
#[test]
fn invalid_stored_values_read_as_defaults() {
    let (fs, store) = store();
    fs.external_write(
        &PathBuf::from("config/settings.json"),
        br#"{
            "schema_version": 1,
            "theme": "purple",
            "light_palette": "sepia",
            "dark_palette": "midnight",
            "editor_font_size": "large",
            "editor_reading_measure": 44,
            "search_result_limit": 0,
            "link_previews": "sometimes"
        }"#,
    );
    let settings = store.read(&fs).expect("read succeeds");
    let defaults = Settings::default();
    assert_eq!(settings.theme, defaults.theme);
    assert_eq!(settings.light_palette, defaults.light_palette);
    assert_eq!(settings.dark_palette, defaults.dark_palette);
    assert_eq!(settings.editor_font_size, defaults.editor_font_size);
    assert_eq!(
        settings.editor_reading_measure,
        defaults.editor_reading_measure
    );
    assert_eq!(settings.search_result_limit, defaults.search_result_limit);
    assert_eq!(settings.link_previews, defaults.link_previews);
}

/// Out-of-range values are rejected on write, before anything touches the
/// file.
#[test]
fn invalid_values_are_rejected_on_write() {
    let (fs, store) = store();
    let cases = [
        Settings {
            theme: "purple".to_owned(),
            ..Settings::default()
        },
        Settings {
            light_palette: "sepia".to_owned(),
            ..Settings::default()
        },
        Settings {
            dark_palette: "midnight".to_owned(),
            ..Settings::default()
        },
        Settings {
            editor_font_size: 1,
            ..Settings::default()
        },
        Settings {
            editor_font_size: 4096,
            ..Settings::default()
        },
        Settings {
            editor_reading_measure: 44,
            ..Settings::default()
        },
        Settings {
            editor_reading_measure: 121,
            ..Settings::default()
        },
        Settings {
            search_result_limit: 0,
            ..Settings::default()
        },
    ];
    for bad in cases {
        assert!(
            matches!(store.write(&fs, &bad), Err(SettingsError::InvalidValue(_))),
            "out-of-range value must be rejected: {bad:?}"
        );
    }
    assert_eq!(
        fs.read(&PathBuf::from("config/settings.json")),
        Err(skribeum_vault::FsError::NotFound),
        "no rejected write created the file"
    );
}

/// Writing into a missing config directory creates it, and every accepted
/// theme value round-trips.
#[test]
fn write_creates_directory_and_themes_round_trip() {
    let fs = SimFs::new();
    let store = SettingsStore::new(PathBuf::from("deep/config/dir/settings.json"));
    for theme in ["system", "light", "dark"] {
        let settings = Settings {
            theme: theme.to_owned(),
            ..Settings::default()
        };
        store.write(&fs, &settings).expect("write succeeds");
        assert_eq!(store.read(&fs).expect("read succeeds").theme, theme);
    }
}

#[test]
fn custom_task_statuses_round_trip_in_order() {
    let (fs, store) = store();
    let statuses = vec![
        TaskStatus {
            symbol: " ".to_owned(),
            name: "Ready".to_owned(),
            category: TaskStatusCategory::Todo,
            glyph: "○".to_owned(),
            color_token: "--skr-accent".to_owned(),
            next_status: "~".to_owned(),
        },
        TaskStatus {
            symbol: "~".to_owned(),
            name: "Paused".to_owned(),
            category: TaskStatusCategory::OnHold,
            glyph: "Ⅱ".to_owned(),
            color_token: "--skr-callout-purple".to_owned(),
            next_status: " ".to_owned(),
        },
    ];
    let settings = Settings {
        task_statuses: statuses.clone(),
        ..Settings::default()
    };
    store.write(&fs, &settings).expect("write succeeds");
    assert_eq!(
        store.read(&fs).expect("read succeeds").task_statuses,
        statuses
    );
}

#[test]
fn malformed_task_status_configuration_reads_as_defaults() {
    let (fs, store) = store();
    fs.external_write(
        &PathBuf::from("config/settings.json"),
        serde_json::to_string(&json!({
            "task_statuses": [{
                "symbol": "?",
                "name": "Question",
                "category": "TODO",
                "glyph": "?",
                "color_token": "--skr-accent",
                "next_status": "missing"
            }]
        }))
        .expect("fixture serializes")
        .as_bytes(),
    );
    assert_eq!(
        store.read(&fs).expect("read succeeds").task_statuses,
        default_task_statuses()
    );
}

#[test]
fn write_preserves_unknown_fields_inside_status_entries() {
    let (fs, store) = store();
    let path = PathBuf::from("config/settings.json");
    let mut first = default_task_statuses()[0].clone();
    first.next_status = first.symbol.clone();
    let mut entry = serde_json::to_value(&first).expect("status serializes");
    entry["future_style"] = json!({"weight": 2});
    fs.external_write(
        &path,
        serde_json::to_string(&json!({"task_statuses": [entry]}))
            .expect("fixture serializes")
            .as_bytes(),
    );

    let settings = Settings {
        task_statuses: vec![first],
        ..Settings::default()
    };
    store.write(&fs, &settings).expect("write succeeds");
    let stored: Value =
        serde_json::from_slice(&fs.read(&path).expect("file readable")).expect("valid JSON");
    assert_eq!(stored["task_statuses"][0]["future_style"]["weight"], 2);
}

/// Remapping a symbol keeps forward-compatible fields attached to the same
/// ordered status entry.
#[test]
fn symbol_remap_preserves_unknown_fields_inside_status_entries() {
    let (fs, store) = store();
    let path = PathBuf::from("config/settings.json");
    let mut status = default_task_statuses()[0].clone();
    status.next_status = status.symbol.clone();
    let mut entry = serde_json::to_value(&status).expect("status serializes");
    entry["future_style"] = json!({"weight": 2});
    fs.external_write(
        &path,
        serde_json::to_string(&json!({"task_statuses": [entry]}))
            .expect("fixture serializes")
            .as_bytes(),
    );

    status.symbol = "u".to_owned();
    status.next_status = "u".to_owned();
    let settings = Settings {
        task_statuses: vec![status],
        ..Settings::default()
    };
    store.write(&fs, &settings).expect("write succeeds");

    let stored: Value =
        serde_json::from_slice(&fs.read(&path).expect("file readable")).expect("valid JSON");
    assert_eq!(stored["task_statuses"][0]["symbol"], "u");
    assert_eq!(stored["task_statuses"][0]["future_style"]["weight"], 2);
}
