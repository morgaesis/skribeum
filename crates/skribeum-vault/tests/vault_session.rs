use std::path::{Path, PathBuf};

use serde_json::Value;
#[cfg(unix)]
use skribeum_vault::RealFs;
use skribeum_vault::{
    FileSystem, MAX_RECENT_VAULTS, SimFs, VAULT_SESSION_SCHEMA_VERSION, VaultSession,
    VaultSessionStore,
};

fn store() -> (SimFs, VaultSessionStore) {
    let fs = SimFs::new();
    fs.external_create_dir(&PathBuf::from("config"));
    (
        fs,
        VaultSessionStore::new(Path::new("config/vault-session")),
    )
}

#[test]
fn missing_or_corrupt_document_reads_as_an_empty_session() {
    let (fs, store) = store();
    assert_eq!(
        store.read(&fs).expect("missing document is safe"),
        VaultSession::default()
    );

    fs.external_write(store.path(), b"not json");
    assert_eq!(
        store.read(&fs).expect("corrupt document is safe"),
        VaultSession::default()
    );

    fs.external_write(
        store.path(),
        br#"{"schema_version":999,"last_vault":"/old"}"#,
    );
    assert_eq!(
        store.read(&fs).expect("unknown schema is safe"),
        VaultSession::default()
    );
}

#[test]
fn opened_vault_becomes_canonical_last_and_newest_recent_entry() {
    let (fs, store) = store();
    let canonical_root = Path::new("/vaults/canonical-root");

    store
        .record_opened(&fs, canonical_root)
        .expect("opened vault is recorded");

    assert_eq!(
        store.read(&fs).expect("session rereads"),
        VaultSession {
            schema_version: VAULT_SESSION_SCHEMA_VERSION,
            last_vault: Some("/vaults/canonical-root".to_owned()),
            recent_vaults: vec!["/vaults/canonical-root".to_owned()],
        }
    );
    let document: Value =
        serde_json::from_slice(&fs.read(store.path()).expect("document exists")).expect("JSON");
    assert_eq!(document["schema_version"], VAULT_SESSION_SCHEMA_VERSION);
}

#[test]
fn recent_vaults_are_newest_first_deduplicated_and_bounded() {
    let (fs, store) = store();
    for index in 0..=MAX_RECENT_VAULTS {
        store
            .record_opened(&fs, Path::new(&format!("/vaults/{index}")))
            .expect("vault is recorded");
    }
    store
        .record_opened(&fs, Path::new("/vaults/3"))
        .expect("existing vault moves to the front");

    let session = store.read(&fs).expect("session rereads");
    assert_eq!(session.last_vault.as_deref(), Some("/vaults/3"));
    assert_eq!(session.recent_vaults.len(), MAX_RECENT_VAULTS);
    assert_eq!(
        session.recent_vaults.first().map(String::as_str),
        Some("/vaults/3")
    );
    assert_eq!(
        session
            .recent_vaults
            .iter()
            .filter(|path| path.as_str() == "/vaults/3")
            .count(),
        1
    );
    assert!(!session.recent_vaults.iter().any(|path| path == "/vaults/0"));
}

#[test]
fn forgetting_an_explicit_candidate_removes_it_and_clear_last_keeps_recents() {
    let (fs, store) = store();
    store
        .record_opened(&fs, Path::new("/vaults/older"))
        .expect("older vault is recorded");
    store
        .record_opened(&fs, Path::new("/vaults/current"))
        .expect("current vault is recorded");

    let forgotten = store
        .forget(&fs, "/vaults/older")
        .expect("explicit stale candidate is forgotten");
    assert_eq!(forgotten.last_vault.as_deref(), Some("/vaults/current"));
    assert_eq!(forgotten.recent_vaults, ["/vaults/current"]);

    let cleared = store.clear_last(&fs).expect("last vault is cleared");
    assert_eq!(cleared.last_vault, None);
    assert_eq!(cleared.recent_vaults, ["/vaults/current"]);
}

#[cfg(unix)]
#[test]
fn session_directory_and_replaced_document_remain_owner_only() {
    use std::sync::atomic::{AtomicU32, Ordering};

    static CALL: AtomicU32 = AtomicU32::new(0);
    let directory = std::env::temp_dir().join(format!(
        "skribeum-vault-session-mode-{}-{}",
        std::process::id(),
        CALL.fetch_add(1, Ordering::Relaxed)
    ));
    let store = VaultSessionStore::new(&directory);

    store
        .record_opened(&RealFs, Path::new("/vaults/first"))
        .expect("first private session write succeeds");
    assert_eq!(
        RealFs
            .metadata(&directory)
            .expect("session directory metadata")
            .mode
            .expect("Unix mode")
            & 0o777,
        0o700,
        "the session directory is owner-only"
    );
    assert_eq!(
        RealFs
            .metadata(store.path())
            .expect("session file metadata")
            .mode
            .expect("Unix mode")
            & 0o777,
        0o600,
        "the first absolute-root document is owner-only"
    );

    store
        .record_opened(&RealFs, Path::new("/vaults/second"))
        .expect("replacement private session write succeeds");
    assert_eq!(
        RealFs
            .metadata(store.path())
            .expect("replacement metadata")
            .mode
            .expect("Unix mode")
            & 0o777,
        0o600,
        "atomic replacement preserves the private mode"
    );
}
