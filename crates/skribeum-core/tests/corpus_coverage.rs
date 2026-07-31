//! Enforces corpus manifest coverage: every construct lists at least one
//! existing file, every listed file exists, and every corpus file is listed
//! under at least one construct. A construct with zero coverage fails the
//! build rather than silently shrinking the round-trip guarantee.

use std::collections::BTreeSet;
use std::path::PathBuf;

#[derive(serde::Deserialize)]
struct Manifest {
    construct: Vec<Construct>,
}

#[derive(serde::Deserialize)]
struct Construct {
    key: String,
    #[allow(dead_code)]
    description: String,
    files: Vec<String>,
}

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/corpus")
}

#[test]
fn every_construct_covered_and_every_file_listed() {
    let dir = corpus_dir();
    let manifest_text = std::fs::read_to_string(dir.join("manifest.toml"))
        .expect("manifest.toml must exist and be UTF-8");
    let manifest: Manifest = toml::from_str(&manifest_text).expect("manifest.toml must parse");

    assert!(
        !manifest.construct.is_empty(),
        "manifest lists no constructs"
    );

    let mut listed = BTreeSet::new();
    for construct in &manifest.construct {
        assert!(
            !construct.files.is_empty(),
            "construct '{}' lists no files",
            construct.key
        );
        for file in &construct.files {
            assert!(
                dir.join(file).is_file(),
                "construct '{}' lists missing file '{file}'",
                construct.key
            );
            listed.insert(file.clone());
        }
    }

    let on_disk: BTreeSet<String> = std::fs::read_dir(&dir)
        .expect("corpus directory must be readable")
        .map(|entry| entry.expect("readable dir entry").file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| name != "manifest.toml" && name != "LICENSE")
        .collect();

    let unlisted: Vec<&String> = on_disk.difference(&listed).collect();
    assert!(
        unlisted.is_empty(),
        "corpus files listed under no construct: {unlisted:?}"
    );
}
