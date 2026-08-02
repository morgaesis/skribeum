use std::path::PathBuf;

use serde_json::{Value, json};
use skribeum_vault::settings::{TaskStatusPayload, TaskStatusTrack};
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

fn configured_settings() -> Settings {
    Settings {
        schema_version: SETTINGS_SCHEMA_VERSION,
        theme: "dark".to_owned(),
        light_palette: "studio".to_owned(),
        dark_palette: "graphite".to_owned(),
        prose_font: "sans".to_owned(),
        code_font: "classic".to_owned(),
        editor_font_size: 18,
        editor_line_height: 180,
        editor_line_width: 84,
        show_line_numbers: true,
        animations: false,
        autosave_delay_ms: 750,
        spell_check: false,
        indent_style: "tabs".to_owned(),
        indent_width: 4,
        wrap_long_lines: false,
        show_invisible_characters: true,
        reveal_markdown_syntax: false,
        default_note_folder: "notes/drafts".to_owned(),
        attachment_folder_mode: "folder".to_owned(),
        attachment_folder_path: "media/attachments".to_owned(),
        honor_obsidian_config: false,
        search_result_limit: 25,
        link_previews: false,
        search_note_bodies: false,
        search_case_sensitive: true,
        update_channel: "beta".to_owned(),
        task_statuses: configured_task_statuses(),
    }
}

fn configured_task_statuses() -> Vec<TaskStatus> {
    vec![
        TaskStatus {
            symbol: " ".to_owned(),
            name: "Ready".to_owned(),
            category: TaskStatusCategory::Todo,
            glyph: "○".to_owned(),
            color_token: "--skr-accent".to_owned(),
            next_status: "~".to_owned(),
            track: Some(TaskStatusTrack::Task),
            payload: None,
        },
        TaskStatus {
            symbol: "~".to_owned(),
            name: "Paused".to_owned(),
            category: TaskStatusCategory::OnHold,
            glyph: "Ⅱ".to_owned(),
            color_token: "--skr-callout-purple".to_owned(),
            next_status: " ".to_owned(),
            track: Some(TaskStatusTrack::Reference),
            payload: None,
        },
    ]
}

#[test]
fn missing_file_yields_every_default() {
    let (fs, store) = store();
    assert_eq!(store.read(&fs).expect("read succeeds"), Settings::default());
}

#[test]
fn every_setting_round_trips_and_unknown_keys_survive() {
    let (fs, store) = store();
    let path = PathBuf::from("config/settings.json");
    fs.external_write(
        &path,
        br#"{
          "editor_reading_measure": 72,
          "future_feature": {"enabled": true},
          "another_unknown": "keep me"
        }"#,
    );
    let settings = configured_settings();
    store.write(&fs, &settings).expect("write succeeds");

    assert_eq!(store.read(&fs).expect("reread succeeds"), settings);
    let bytes = fs.read(&path).expect("file readable");
    let object: Value = serde_json::from_slice(&bytes).expect("valid JSON");
    assert_eq!(object["editor_reading_measure"], 72);
    assert_eq!(object["future_feature"]["enabled"], true);
    assert_eq!(object["another_unknown"], "keep me");
}

#[test]
fn legacy_reading_measure_is_used_only_as_a_line_width_fallback() {
    let (fs, store) = store();
    let path = PathBuf::from("config/settings.json");
    fs.external_write(&path, br#"{"editor_reading_measure": 88}"#);
    assert_eq!(
        store.read(&fs).expect("read succeeds").editor_line_width,
        88
    );

    fs.external_write(
        &path,
        br#"{"editor_line_width": 82, "editor_reading_measure": 88}"#,
    );
    assert_eq!(
        store.read(&fs).expect("read succeeds").editor_line_width,
        82
    );
}

#[test]
fn every_malformed_stored_value_falls_back_safely() {
    let (fs, store) = store();
    let path = PathBuf::from("config/settings.json");
    let invalid = json!({
        "schema_version": "two",
        "theme": "purple",
        "light_palette": "blue",
        "dark_palette": "blue",
        "prose_font": "cursive",
        "code_font": "script",
        "editor_font_size": 5,
        "editor_line_height": 119,
        "editor_line_width": 44,
        "show_line_numbers": "yes",
        "animations": 1,
        "autosave_delay_ms": 99,
        "spell_check": "true",
        "indent_style": "mixed",
        "indent_width": 0,
        "wrap_long_lines": "no",
        "show_invisible_characters": null,
        "reveal_markdown_syntax": 0,
        "default_note_folder": "C:/notes",
        "attachment_folder_mode": "nearby",
        "attachment_folder_path": "/attachments",
        "honor_obsidian_config": "yes",
        "search_result_limit": 0,
        "link_previews": "yes",
        "search_note_bodies": "yes",
        "search_case_sensitive": 1,
        "update_channel": "nightly",
        "task_statuses": [{
            "symbol": "?",
            "name": "Question",
            "category": "TODO",
            "glyph": "?",
            "color_token": "--skr-accent",
            "next_status": "missing"
        }]
    });
    fs.external_write(
        &path,
        serde_json::to_string(&invalid)
            .expect("serializes")
            .as_bytes(),
    );
    assert_eq!(store.read(&fs).expect("read succeeds"), Settings::default());
}

#[test]
fn uncreatable_folder_values_fall_back_safely() {
    let (fs, store) = store();
    fs.external_write(
        &PathBuf::from("config/settings.json"),
        br#"{
          "default_note_folder": "notes:archive",
          "attachment_folder_path": ".obsidian/assets"
        }"#,
    );
    let settings = store.read(&fs).expect("read succeeds");
    assert_eq!(settings.default_note_folder, "");
    assert_eq!(settings.attachment_folder_path, "attachments");
}

#[test]
fn invalid_writes_are_rejected_before_creating_a_file() {
    let (fs, store) = store();
    macro_rules! rejects {
        ($field:ident, $value:expr) => {{
            let mut settings = Settings::default();
            settings.$field = $value;
            assert_eq!(
                store.write(&fs, &settings),
                Err(SettingsError::InvalidValue(stringify!($field)))
            );
        }};
    }
    rejects!(theme, "purple".to_owned());
    rejects!(light_palette, "blue".to_owned());
    rejects!(dark_palette, "blue".to_owned());
    rejects!(prose_font, "cursive".to_owned());
    rejects!(code_font, "script".to_owned());
    rejects!(editor_font_size, 5);
    rejects!(editor_line_height, 119);
    rejects!(editor_line_width, 44);
    rejects!(autosave_delay_ms, 99);
    rejects!(indent_style, "mixed".to_owned());
    rejects!(indent_width, 0);
    rejects!(default_note_folder, "C:/notes".to_owned());
    rejects!(default_note_folder, "notes:archive".to_owned());
    rejects!(default_note_folder, ".obsidian".to_owned());
    rejects!(attachment_folder_mode, "nearby".to_owned());
    rejects!(attachment_folder_path, "/attachments".to_owned());
    rejects!(attachment_folder_path, ".skribeum/assets".to_owned());
    rejects!(search_result_limit, 0);
    rejects!(update_channel, "nightly".to_owned());
    rejects!(task_statuses, Vec::new());
    assert_eq!(
        fs.read(&PathBuf::from("config/settings.json")),
        Err(skribeum_vault::FsError::NotFound)
    );
}

#[test]
fn corrupt_file_is_never_clobbered() {
    let (fs, store) = store();
    let path = PathBuf::from("config/settings.json");
    fs.external_write(&path, b"not json at all {{{");
    assert_eq!(store.read(&fs), Err(SettingsError::Corrupt));
    assert_eq!(
        store.write(&fs, &Settings::default()),
        Err(SettingsError::Corrupt)
    );
    assert_eq!(
        fs.read(&path).expect("file remains"),
        b"not json at all {{{"
    );
}

#[test]
fn write_creates_missing_parent_directories() {
    let fs = SimFs::new();
    let store = SettingsStore::new(PathBuf::from("deep/config/dir/settings.json"));
    store
        .write(&fs, &configured_settings())
        .expect("write succeeds");
    assert_eq!(
        store.read(&fs).expect("read succeeds"),
        configured_settings()
    );
}

#[test]
fn custom_task_statuses_round_trip_in_order() {
    let (fs, store) = store();
    let statuses = configured_task_statuses();
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
fn default_status_names_round_trip_as_stable_catalogue_markers() {
    let (fs, store) = store();
    let settings = Settings::default();
    store.write(&fs, &settings).expect("write succeeds");
    let reloaded = store.read(&fs).expect("read succeeds");
    assert!(
        reloaded
            .task_statuses
            .iter()
            .all(|status| status.name.is_empty())
    );
    assert_eq!(reloaded, settings);
}

#[test]
fn default_task_statuses_assign_tracks_and_payloads() {
    let statuses = default_task_statuses();
    for status in &statuses {
        let expected_track = match status.symbol.as_str() {
            " " | "/" | "x" | "-" | "X" => TaskStatusTrack::Task,
            "D" | "<" | ">" => TaskStatusTrack::Time,
            "!" => TaskStatusTrack::Importance,
            _ => TaskStatusTrack::Reference,
        };
        let expected_payload = match status.symbol.as_str() {
            "D" | "<" | ">" => Some(TaskStatusPayload::Date),
            "!" => Some(TaskStatusPayload::Level),
            _ => None,
        };
        assert_eq!(status.track, Some(expected_track), "{}", status.symbol);
        assert_eq!(status.payload, expected_payload, "{}", status.symbol);
    }
}

#[test]
fn missing_task_metadata_round_trips_without_becoming_null() {
    let (fs, store) = store();
    let path = PathBuf::from("config/settings.json");
    fs.external_write(
        &path,
        br#"{
          "task_statuses": [{
            "symbol": "?",
            "name": "Question",
            "category": "TODO",
            "glyph": "?",
            "color_token": "--skr-accent",
            "next_status": "?",
            "future_style": {"weight": 2}
          }]
        }"#,
    );

    let settings = store.read(&fs).expect("read succeeds");
    assert_eq!(settings.task_statuses[0].track, None);
    assert_eq!(settings.task_statuses[0].payload, None);
    store.write(&fs, &settings).expect("write succeeds");

    let stored: Value =
        serde_json::from_slice(&fs.read(&path).expect("file readable")).expect("valid JSON");
    assert!(stored["task_statuses"][0].get("track").is_none());
    assert!(stored["task_statuses"][0].get("payload").is_none());
    assert_eq!(stored["task_statuses"][0]["future_style"]["weight"], 2);
}

#[test]
fn undefined_task_color_tokens_fall_back_on_read_and_fail_on_write() {
    let (fs, store) = store();
    let path = PathBuf::from("config/settings.json");
    let mut statuses = configured_task_statuses();
    statuses[0].color_token = "--skr-not-defined".to_owned();
    fs.external_write(
        &path,
        serde_json::to_string(&json!({"task_statuses": statuses}))
            .expect("fixture serializes")
            .as_bytes(),
    );
    assert_eq!(
        store.read(&fs).expect("read succeeds").task_statuses,
        default_task_statuses()
    );

    let mut settings = Settings::default();
    settings.task_statuses[0].color_token = "--skr-not-defined".to_owned();
    assert_eq!(
        store.write(&fs, &settings),
        Err(SettingsError::InvalidValue("task_statuses"))
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
fn malformed_task_metadata_rejects_the_complete_status_graph() {
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
                "next_status": "?",
                "track": "invalid"
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
    status.name = "Remapped".to_owned();
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
