use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::Path;

use zip::ZipArchive;

use crate::{ImportError, PlannedContent, PlannedFile, RawArchiveEntry};

pub(crate) fn read_archive(path: &Path) -> Result<Vec<RawArchiveEntry>, ImportError> {
    let file = File::open(path).map_err(|source| ImportError::Io {
        path: path.to_owned(),
        source,
    })?;
    let mut archive = ZipArchive::new(file)?;
    let mut entries = Vec::new();

    for index in 0..archive.len() {
        let mut entry = archive.by_index(index)?;
        if entry.is_dir() {
            continue;
        }
        let archive_name = entry.name().to_owned();
        let path = entry
            .enclosed_name()
            .ok_or_else(|| ImportError::UnsafeArchivePath(archive_name.clone()))?
            .clone();
        let mut bytes = Vec::new();
        let reads_during_planning = path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("md") || extension.eq_ignore_ascii_case("csv")
            });
        if reads_during_planning {
            entry
                .read_to_end(&mut bytes)
                .map_err(|source| ImportError::Io {
                    path: path.clone(),
                    source,
                })?;
        }
        entries.push(RawArchiveEntry {
            archive_name,
            path,
            bytes,
        });
    }

    Ok(entries)
}

pub(crate) fn output_is_directory(path: &Path) -> Result<Option<bool>, ImportError> {
    match fs::metadata(path) {
        Ok(metadata) => Ok(Some(metadata.is_dir())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(source) => Err(ImportError::Io {
            path: path.to_owned(),
            source,
        }),
    }
}

pub(crate) fn write_plan(
    archive_path: &Path,
    output_root: &Path,
    files: &[PlannedFile],
) -> Result<(), ImportError> {
    fs::create_dir_all(output_root).map_err(|source| ImportError::Io {
        path: output_root.to_owned(),
        source,
    })?;

    let archive_file = File::open(archive_path).map_err(|source| ImportError::Io {
        path: archive_path.to_owned(),
        source,
    })?;
    let mut archive = ZipArchive::new(archive_file)?;

    for planned in files {
        let output_path = output_root.join(&planned.path);
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|source| ImportError::Io {
                path: parent.to_owned(),
                source,
            })?;
        }
        let mut output = File::create(&output_path).map_err(|source| ImportError::Io {
            path: output_path.clone(),
            source,
        })?;
        match &planned.content {
            PlannedContent::Bytes(bytes) => {
                output.write_all(bytes).map_err(|source| ImportError::Io {
                    path: output_path.clone(),
                    source,
                })?;
            }
            PlannedContent::ArchiveEntry(name) => {
                let mut source = archive.by_name(name)?;
                std::io::copy(&mut source, &mut output).map_err(|source| ImportError::Io {
                    path: output_path.clone(),
                    source,
                })?;
            }
        }
    }

    Ok(())
}
