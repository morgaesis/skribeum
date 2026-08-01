//! The sanctioned read path into the excluded `.obsidian` directory:
//! recognized configuration files only, read-only, degrading to defaults.

use skribeum_vault::{SimFs, Vault, VaultError};
use std::path::Path;

fn vault_with_config(app_json: Option<&[u8]>) -> (SimFs, Vault) {
    let fs = SimFs::new();
    fs.external_create_dir(Path::new("v"));
    fs.external_write(Path::new("v/note.md"), b"hello\n");
    if let Some(bytes) = app_json {
        fs.external_create_dir(Path::new("v/.obsidian"));
        fs.external_write(Path::new("v/.obsidian/app.json"), bytes);
    }
    let vault = Vault::open(&fs, Path::new("v")).expect("opens");
    (fs, vault)
}

#[test]
fn reads_recognized_config() {
    let (fs, vault) = vault_with_config(Some(b"{\"newLinkFormat\":\"shortest\"}"));
    let content = vault
        .read_obsidian_config(&fs, "app.json")
        .expect("read ok");
    assert_eq!(content.as_deref(), Some("{\"newLinkFormat\":\"shortest\"}"));
}

#[test]
fn missing_config_reads_as_none() {
    let (fs, vault) = vault_with_config(None);
    assert_eq!(
        vault.read_obsidian_config(&fs, "app.json").expect("ok"),
        None
    );
    assert_eq!(
        vault.read_obsidian_config(&fs, "types.json").expect("ok"),
        None
    );
}

#[test]
fn unrecognized_names_are_refused() {
    let (fs, vault) = vault_with_config(None);
    for name in ["workspace.json", "../note.md", "app.json/../note.md", ""] {
        assert!(matches!(
            vault.read_obsidian_config(&fs, name),
            Err(VaultError::NoteNotFound)
        ));
    }
}

#[test]
fn non_utf8_config_reads_as_none() {
    let (fs, vault) = vault_with_config(Some(&[0xFF, 0xFE, 0x00]));
    assert_eq!(
        vault.read_obsidian_config(&fs, "app.json").expect("ok"),
        None
    );
}

#[test]
fn config_symlink_outside_the_vault_reads_as_none() {
    let (fs, vault) = vault_with_config(None);
    fs.external_write(Path::new("outside.json"), b"{\"secret\":true}");
    fs.external_symlink(Path::new("v/.obsidian/app.json"), Path::new("outside.json"));

    assert_eq!(
        vault.read_obsidian_config(&fs, "app.json").expect("ok"),
        None
    );
}
