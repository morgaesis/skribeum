//! Rust side of the two-parser conformance gate. Emits the extraction set of
//! every corpus file in the canonical line format from
//! `tests/syntax-spec.toml` (`<kind> <start_byte>..<end_byte>`, sorted, LF
//! terminated), writes the emission as a build artifact under
//! `target/conformance/rust/`, and compares it byte-for-byte against the
//! committed golden snapshot in `tests/conformance/rust/`. The TypeScript
//! emitter produces the same format and diffs against the same committed
//! files. Set `SKRIBEUM_UPDATE_CONFORMANCE=1` to regenerate the snapshots
//! after a reviewed specification change.

use std::collections::BTreeSet;
use std::fmt::Write as _;
use std::path::{Path, PathBuf};

fn repository_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn emit(source: &[u8]) -> String {
    let mut out = String::new();
    for extraction in skribeum_core::extract(source) {
        writeln!(
            out,
            "{} {}..{}",
            extraction.kind.as_str(),
            extraction.start_byte,
            extraction.end_byte
        )
        .expect("writing to a String cannot fail");
    }
    out
}

fn corpus_files(corpus_dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(corpus_dir)
        .expect("corpus directory must be readable")
        .map(|entry| entry.expect("readable dir entry").path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
        .collect();
    files.sort();
    files
}

#[test]
fn rust_extraction_matches_committed_snapshots() {
    let root = repository_root();
    let corpus_dir = root.join("tests/corpus");
    let golden_dir = root.join("tests/conformance/rust");
    let artifact_dir = root.join("target/conformance/rust");
    std::fs::create_dir_all(&artifact_dir).expect("artifact directory must be creatable");
    let update = std::env::var_os("SKRIBEUM_UPDATE_CONFORMANCE").is_some();
    if update {
        std::fs::create_dir_all(&golden_dir).expect("golden directory must be creatable");
    }

    let mut failures: Vec<String> = Vec::new();
    let mut expected_snapshots: BTreeSet<String> = BTreeSet::new();

    for path in corpus_files(&corpus_dir) {
        let file_name = path
            .file_name()
            .expect("corpus files have names")
            .to_string_lossy()
            .into_owned();
        let snapshot_name = format!("{file_name}.txt");
        expected_snapshots.insert(snapshot_name.clone());

        let source = std::fs::read(&path).expect("corpus file must be readable");
        let emitted = emit(&source);
        std::fs::write(artifact_dir.join(&snapshot_name), &emitted)
            .expect("artifact must be writable");

        let golden_path = golden_dir.join(&snapshot_name);
        if update {
            std::fs::write(&golden_path, &emitted).expect("golden must be writable");
            continue;
        }
        match std::fs::read_to_string(&golden_path) {
            Ok(golden) if golden == emitted => {}
            Ok(_) => failures.push(format!(
                "{snapshot_name}: emission differs from committed snapshot; \
                 compare target/conformance/rust/{snapshot_name} against \
                 tests/conformance/rust/{snapshot_name}"
            )),
            Err(_) => failures.push(format!(
                "{snapshot_name}: no committed snapshot; run with \
                 SKRIBEUM_UPDATE_CONFORMANCE=1 and review the diff"
            )),
        }
    }

    if !update {
        let committed: BTreeSet<String> = std::fs::read_dir(&golden_dir)
            .expect("golden directory must exist and be readable")
            .map(|entry| {
                entry
                    .expect("readable dir entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        for stale in committed.difference(&expected_snapshots) {
            failures.push(format!("{stale}: snapshot has no corpus file; delete it"));
        }
    }

    assert!(
        failures.is_empty(),
        "conformance snapshot mismatches:\n{}",
        failures.join("\n")
    );
}
