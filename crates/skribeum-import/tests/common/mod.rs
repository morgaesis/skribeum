#![allow(dead_code)]

use std::io::{Cursor, Write};
use std::path::{Path, PathBuf};

use skribeum_vault::{FileSystem, RealFs, write_durable};
use zip::write::SimpleFileOptions;

pub fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/corpus")
}

pub fn archive_from_tree(name: &str, target: &Path) {
    let source = corpus_dir().join("archives").join(name);
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    add_tree(&mut writer, &source, &source);
    let cursor = writer.finish().expect("fixture ZIP finishes");
    write_durable(&RealFs, target, cursor.get_ref()).expect("fixture ZIP writes");
}

fn add_tree(writer: &mut zip::ZipWriter<Cursor<Vec<u8>>>, root: &Path, directory: &Path) {
    let mut entries = RealFs.read_dir(directory).expect("fixture directory reads");
    entries.sort_by(|left, right| left.file_name.cmp(&right.file_name));
    for entry in entries {
        if entry.is_dir {
            add_tree(writer, root, &entry.path);
            continue;
        }
        let relative = entry
            .path
            .strip_prefix(root)
            .expect("fixture file remains under its archive root")
            .to_string_lossy()
            .replace('\\', "/");
        writer
            .start_file(
                relative,
                SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
            )
            .expect("fixture ZIP entry starts");
        let bytes = RealFs.read(&entry.path).expect("fixture file reads");
        writer.write_all(&bytes).expect("fixture ZIP entry writes");
    }
}

pub fn snapshot(root: &Path) -> Vec<(String, Vec<u8>)> {
    let mut files = Vec::new();
    snapshot_directory(root, root, &mut files);
    files.sort_by(|left, right| left.0.cmp(&right.0));
    files
}

fn snapshot_directory(root: &Path, directory: &Path, files: &mut Vec<(String, Vec<u8>)>) {
    let mut entries = RealFs
        .read_dir(directory)
        .expect("snapshot directory reads");
    entries.sort_by(|left, right| left.file_name.cmp(&right.file_name));
    for entry in entries {
        if entry.is_dir {
            snapshot_directory(root, &entry.path, files);
            continue;
        }
        let relative = entry
            .path
            .strip_prefix(root)
            .expect("snapshot file remains under root")
            .to_string_lossy()
            .replace('\\', "/");
        files.push((
            relative,
            RealFs.read(&entry.path).expect("snapshot file reads"),
        ));
    }
}
