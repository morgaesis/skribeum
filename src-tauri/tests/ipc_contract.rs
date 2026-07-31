//! IPC contract gates, run in CI on every push:
//!
//! 1. The command set in the tauri-specta generated bindings equals the
//!    committed `ipc-allowlist.json` exactly.
//! 2. The committed `src/lib/ipc/bindings.ts` matches what the current code
//!    generates (set `SKRIBEUM_WRITE_BINDINGS=1` while running this test to
//!    rewrite it after an intentional change).
//!
//! Not run on Windows: the bare test harness fails at process start there
//! (STATUS_ENTRYPOINT_NOT_FOUND loading the webview DLLs) while the checks
//! themselves are platform-independent generated TypeScript, still gated on
//! the Linux and macOS legs. The Windows binary itself is exercised by the
//! end-to-end job.
#![cfg(not(windows))]

use std::collections::BTreeSet;
use std::path::PathBuf;

use skribeum_vault::{FileSystem, RealFs};

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
    String::from_utf8(bytes).expect("bindings are UTF-8")
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
        RealFs
            .write_atomic(&path, generated.as_bytes())
            .expect("bindings file writes");
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
