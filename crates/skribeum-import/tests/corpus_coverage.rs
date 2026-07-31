mod common;

use std::collections::BTreeSet;
use std::path::Path;

use serde::Deserialize;
use skribeum_vault::{FileSystem, RealFs};

#[derive(Debug, Deserialize)]
struct Manifest {
    construct: Vec<Construct>,
}

#[derive(Debug, Deserialize)]
struct Construct {
    key: String,
    description: String,
    archives: Vec<String>,
    files: Vec<String>,
}

#[test]
fn every_construct_is_covered_and_every_source_file_is_listed() {
    let corpus = common::corpus_dir();
    let manifest_bytes = RealFs
        .read(&corpus.join("manifest.toml"))
        .expect("manifest reads");
    let manifest_text = std::str::from_utf8(&manifest_bytes).expect("manifest is UTF-8");
    let manifest: Manifest = toml::from_str(manifest_text).expect("manifest parses");
    assert!(
        !manifest.construct.is_empty(),
        "manifest lists no constructs"
    );

    let mut keys = BTreeSet::new();
    let mut listed = BTreeSet::new();
    for construct in &manifest.construct {
        assert!(!construct.key.is_empty(), "construct key is empty");
        assert!(
            keys.insert(&construct.key),
            "construct key '{}' is duplicated",
            construct.key
        );
        assert!(
            !construct.description.is_empty(),
            "construct '{}' has no description",
            construct.key
        );
        assert!(
            !construct.archives.is_empty(),
            "construct '{}' lists no archives",
            construct.key
        );
        assert!(
            !construct.files.is_empty(),
            "construct '{}' lists no files",
            construct.key
        );
        for archive in &construct.archives {
            assert!(
                RealFs
                    .metadata(&corpus.join("archives").join(archive))
                    .is_ok(),
                "construct '{}' lists missing archive tree '{archive}'",
                construct.key
            );
            assert!(
                RealFs
                    .metadata(&corpus.join("golden").join(archive))
                    .is_ok(),
                "construct '{}' has no golden tree for archive '{archive}'",
                construct.key
            );
        }
        for file in &construct.files {
            assert!(
                RealFs.metadata(&corpus.join(file)).is_ok(),
                "construct '{}' lists missing file '{file}'",
                construct.key
            );
            listed.insert(file.clone());
        }
    }

    let mut on_disk = BTreeSet::new();
    collect_files(&corpus, &corpus.join("archives"), &mut on_disk);
    let unlisted: Vec<_> = on_disk.difference(&listed).collect();
    assert!(
        unlisted.is_empty(),
        "corpus source files listed under no construct: {unlisted:?}"
    );
}

fn collect_files(root: &Path, directory: &Path, files: &mut BTreeSet<String>) {
    for entry in RealFs.read_dir(directory).expect("corpus directory reads") {
        if entry.is_dir {
            collect_files(root, &entry.path, files);
        } else {
            let relative = entry
                .path
                .strip_prefix(root)
                .expect("corpus file remains under root")
                .to_string_lossy()
                .replace('\\', "/");
            files.insert(relative);
        }
    }
}
