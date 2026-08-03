//! IPC contract gates, run in CI on every push:
//!
//! 1. The command set in the tauri-specta generated bindings equals the
//!    committed `ipc-allowlist.json` exactly.
//! 2. The committed `src/lib/ipc/bindings.ts` matches what the current code
//!    generates (set `SKRIBEUM_WRITE_BINDINGS=1` while running this test to
//!    rewrite it after an intentional change).
//!
//! Not run on Windows: the bare test harness fails at process start there
//! (`STATUS_ENTRYPOINT_NOT_FOUND` loading the webview DLLs) while the checks
//! themselves are platform-independent generated TypeScript, still gated on
//! the Linux and macOS legs. The Windows binary itself is exercised by the
//! end-to-end job.
#![cfg(not(windows))]

use std::collections::BTreeSet;
use std::path::PathBuf;

use skribeum_vault::{FileSystem, RealFs, write_durable};

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Exports the bindings the current command surface generates, as a string.
fn generate_bindings() -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static CALL: AtomicU32 = AtomicU32::new(0);
    let out = std::env::temp_dir().join(format!(
        "skribeum-bindings-{}-{}.ts",
        std::process::id(),
        CALL.fetch_add(1, Ordering::Relaxed)
    ));
    skribeum_app_lib::ipc_builder()
        .export(specta_typescript::Typescript::default(), &out)
        .expect("bindings export succeeds");
    let bytes = RealFs.read(&out).expect("exported bindings are readable");
    let _ = RealFs.remove_file(&out);
    let generated = String::from_utf8(bytes).expect("bindings are UTF-8");
    skribeum_app_lib::normalize_generated_bindings(&generated)
}

/// Command names invoked by the generated bindings, extracted from the
/// `TAURI_INVOKE("name", ...)` call sites tauri-specta emits.
fn command_set(bindings: &str) -> BTreeSet<String> {
    let mut commands = BTreeSet::new();
    let needle = "TAURI_INVOKE(\"";
    let mut rest = bindings;
    while let Some(start) = rest.find(needle) {
        let after = &rest[start + needle.len()..];
        if let Some(end) = after.find('"') {
            commands.insert(after[..end].to_owned());
            rest = &after[end..];
        } else {
            break;
        }
    }
    commands
}

#[derive(serde::Deserialize)]
struct Allowlist {
    commands: Vec<String>,
    plugin_commands: Vec<String>,
}

#[test]
fn plugin_commands_are_deliberate_and_capability_scoped() {
    let repository = repository_root();
    let allowlist_bytes = RealFs
        .read(&repository.join("ipc-allowlist.json"))
        .expect("ipc-allowlist.json exists at the repository root");
    let allowlist: Allowlist =
        serde_json::from_slice(&allowlist_bytes).expect("ipc-allowlist.json parses");
    assert_eq!(
        allowlist.plugin_commands,
        ["plugin:dialog|confirm", "plugin:opener|open_url"],
        "the plugin IPC surface is an exact reviewed allowlist"
    );

    let capability_bytes = RealFs
        .read(&repository.join("src-tauri/capabilities/default.json"))
        .expect("default capability exists");
    let capability: serde_json::Value =
        serde_json::from_slice(&capability_bytes).expect("default capability parses");
    let permissions = capability["permissions"]
        .as_array()
        .expect("capability permissions are an array");
    let opener = permissions
        .iter()
        .find(|permission| permission["identifier"] == "opener:allow-open-url")
        .expect("the opener URL command has a capability");
    assert_eq!(
        opener["allow"],
        serde_json::json!([
            { "url": "http://*" },
            { "url": "https://*" }
        ]),
        "the opener capability must allow only HTTP and HTTPS URLs"
    );
    assert!(
        permissions
            .iter()
            .any(|permission| permission == "dialog:allow-confirm"),
        "the clear-history confirmation has a scoped dialog capability"
    );
}

#[test]
fn generated_command_set_matches_committed_allowlist() {
    let allowlist_bytes = RealFs
        .read(&repository_root().join("ipc-allowlist.json"))
        .expect("ipc-allowlist.json exists at the repository root");
    let allowlist: Allowlist =
        serde_json::from_slice(&allowlist_bytes).expect("ipc-allowlist.json parses");
    let allowed: BTreeSet<String> = allowlist.commands.into_iter().collect();

    let generated = command_set(&generate_bindings());
    assert!(
        !generated.is_empty(),
        "no TAURI_INVOKE call sites found in generated bindings; the extraction is broken"
    );
    assert_eq!(
        generated, allowed,
        "the generated bindings' command set diverges from ipc-allowlist.json; \
         every allowlist change must be deliberate"
    );
}

#[test]
fn committed_bindings_are_current() {
    let path = repository_root().join("src/lib/ipc/bindings.ts");
    let generated = generate_bindings();

    if std::env::var("SKRIBEUM_WRITE_BINDINGS").is_ok() {
        write_durable(&RealFs, &path, generated.as_bytes()).expect("bindings file writes");
        return;
    }

    let committed = RealFs
        .read(&path)
        .expect("src/lib/ipc/bindings.ts is committed; regenerate with SKRIBEUM_WRITE_BINDINGS=1");
    let committed = String::from_utf8(committed).expect("bindings are UTF-8");
    assert_eq!(
        committed, generated,
        "src/lib/ipc/bindings.ts is stale; rerun this test with SKRIBEUM_WRITE_BINDINGS=1 \
         and commit the result"
    );
}
