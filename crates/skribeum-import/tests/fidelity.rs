mod common;

use std::path::PathBuf;

use serde::Deserialize;
use skribeum_import::{ImportOptions, import_notion};
use skribeum_vault::{FileSystem, RealFs};

#[derive(Debug, Deserialize)]
struct Manifest {
    construct: Vec<Construct>,
}

#[derive(Debug, Deserialize)]
struct Construct {
    key: String,
    archives: Vec<String>,
}

#[test]
fn every_construct_matches_its_archive_golden_tree_byte_for_byte() {
    let manifest_bytes = RealFs
        .read(&common::corpus_dir().join("manifest.toml"))
        .expect("manifest reads");
    let manifest: Manifest =
        toml::from_str(std::str::from_utf8(&manifest_bytes).expect("manifest is UTF-8"))
            .expect("manifest parses");

    for construct in manifest.construct {
        for archive_name in construct.archives {
            assert_archive_matches(&construct.key, &archive_name);
        }
    }
}

fn assert_archive_matches(construct: &str, archive_name: &str) {
    let temp = tempfile::tempdir().expect("temporary directory creates");
    let archive = temp.path().join(format!("{archive_name}.zip"));
    let output = temp.path().join("vault");
    common::archive_from_tree(archive_name, &archive);
    import_notion(&ImportOptions {
        archive,
        out: output.clone(),
        dry_run: false,
        force: false,
    })
    .unwrap_or_else(|error| panic!("construct '{construct}' imports: {error}"));

    let expected_root: PathBuf = common::corpus_dir().join("golden").join(archive_name);
    assert_eq!(
        common::snapshot(&output),
        common::snapshot(&expected_root),
        "construct '{construct}' differs from archive '{archive_name}' golden output"
    );
}
