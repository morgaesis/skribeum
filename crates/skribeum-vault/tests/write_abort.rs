//! Write-abort fault injection over the crash-safe write sequence: 1,000
//! iterations sweeping an injected failure (out-of-space at every write and
//! fsync site, generic I/O at the rest) across every interleaving point of
//! the sequence. Invariants after every aborted save: the failure is
//! visible (an error returned), the on-disk file is intact (byte-identical
//! old content, or the complete new content when only the final directory
//! fsync failed), never torn, and no temporary file remains. Runs entirely
//! under the deterministic simulator, so the same harness runs on every
//! platform in CI.

use std::path::{Path, PathBuf};

use skribeum_vault::{FileSystem, FsError, SimFs, write_durable};

const OLD: &[u8] = b"the original note content, safe on disk\n";
const NEW: &[u8] = b"the replacement content the save intends\n";
const MODE: u32 = 0o640;

/// Number of interleaving points in one replace-existing-file sequence:
/// `write_file`, `fsync_file`, `copy_permissions`, `rename`, `fsync_dir`.
const SEQUENCE_OPS: u64 = 5;

fn vault_with_note(seed: u64) -> (SimFs, PathBuf, PathBuf) {
    let fs = SimFs::new();
    fs.seed(seed);
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    let note = root.join("note.md");
    fs.external_write(&note, OLD);
    fs.external_set_mode(&note, MODE);
    (fs, root, note)
}

/// Asserts the abort invariants; returns an error string instead of
/// panicking so the mutation companion can assert the checker itself
/// rejects a broken writer.
fn check_abort_invariants(
    fs: &SimFs,
    root: &Path,
    note: &Path,
    failed_site: u64,
) -> Result<(), String> {
    let on_disk = fs
        .read(note)
        .map_err(|e| format!("note vanished after abort: {e}"))?;
    if on_disk != OLD && on_disk != NEW {
        return Err(format!(
            "torn file after abort at site {failed_site}: {} bytes",
            on_disk.len()
        ));
    }
    if fs.mode_of(note) != Some(MODE) {
        return Err(format!(
            "permission mode lost after abort at site {failed_site}"
        ));
    }
    let residue: Vec<String> = fs
        .read_dir(root)
        .map_err(|e| format!("vault unreadable: {e}"))?
        .into_iter()
        .map(|entry| entry.file_name)
        .filter(|name| skribeum_vault::is_write_temp_name(name))
        .collect();
    if !residue.is_empty() {
        return Err(format!(
            "temp residue after abort at site {failed_site}: {residue:?}"
        ));
    }
    Ok(())
}

/// 1,000 iterations sweeping every failure site, out-of-space included at
/// every write and fsync site.
#[test]
fn one_thousand_aborted_saves_leave_no_torn_file_and_no_residue() {
    for iteration in 0..1_000u64 {
        let site = iteration % SEQUENCE_OPS + 1;
        // Sites 1 (write), 2 (file fsync) and 5 (dir fsync) sweep
        // out-of-space; every site also sweeps a generic I/O failure on
        // alternating rounds.
        let error = if iteration % (2 * SEQUENCE_OPS) < SEQUENCE_OPS {
            FsError::NoSpace
        } else {
            FsError::Io("injected".to_owned())
        };
        let (fs, root, note) = vault_with_note(iteration);
        fs.inject_failure(site, error.clone());

        let result = write_durable(&fs, &note, NEW);
        assert!(
            result.is_err(),
            "iteration {iteration}: an injected failure at site {site} must fail the save visibly"
        );
        if site < SEQUENCE_OPS {
            // Failure before the final directory fsync: the replace must
            // not have happened at all.
            assert_eq!(
                fs.read(&note).expect("note readable"),
                OLD,
                "iteration {iteration}: abort before the rename completed must leave old bytes"
            );
        }
        check_abort_invariants(&fs, &root, &note, site)
            .unwrap_or_else(|violation| panic!("iteration {iteration}: {violation}"));
    }
}

/// Out-of-space during the temp write must leave the target untouched even
/// though the failed write itself left torn bytes in the temp file: the
/// abort path removes them.
#[test]
fn enospc_at_the_write_site_leaves_the_target_intact() {
    for seed in 0..50u64 {
        let (fs, root, note) = vault_with_note(seed);
        fs.inject_failure(1, FsError::NoSpace);
        let result = write_durable(&fs, &note, NEW);
        assert_eq!(result, Err(FsError::NoSpace), "the failure must surface");
        assert_eq!(
            fs.read(&note).expect("note readable"),
            OLD,
            "seed {seed}: the on-disk file must be intact after out-of-space"
        );
        check_abort_invariants(&fs, &root, &note, 1)
            .unwrap_or_else(|violation| panic!("seed {seed}: {violation}"));
    }
}

/// Mutation companion: a deliberately broken writer that writes the target
/// in place (no temp, no rename) must be rejected by the same checker when
/// the write fails mid-way, proving the checker detects torn files.
#[test]
fn abort_checker_rejects_an_in_place_writer() {
    let (fs, root, note) = vault_with_note(7);
    fs.inject_failure(1, FsError::NoSpace);
    // The broken implementation: aim write_file at the target directly.
    let result = fs.write_file(&note, NEW);
    assert!(result.is_err(), "the injected failure fires");
    let verdict = check_abort_invariants(&fs, &root, &note, 1);
    assert!(
        verdict.is_err(),
        "the checker must reject the torn file an in-place writer leaves"
    );
}

/// Mutation companion: a broken writer that skips temp cleanup on failure
/// must be rejected for temp residue.
#[test]
fn abort_checker_rejects_leftover_temp_files() {
    let (fs, root, note) = vault_with_note(9);
    let temp = skribeum_vault::write_temp_path(&note).expect("temp path");
    fs.write_file(&temp, NEW).expect("temp writes");
    let verdict = check_abort_invariants(&fs, &root, &note, 0);
    assert!(
        verdict.is_err(),
        "the checker must reject temp residue left by a broken abort path"
    );
}
