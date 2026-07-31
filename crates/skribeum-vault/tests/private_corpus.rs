//! Local-only harness over a private vault. Reads the directory named by
//! `SKRIBEUM_PRIVATE_CORPUS`, opens it with the vault model and reads every
//! indexed note. Reports counts and pass/fail only: no file name, path
//! fragment or content ever appears in the output. Skips silently when the
//! variable is unset, so this is never a CI gate.

use std::path::PathBuf;

use skribeum_vault::{EntryKind, RealFs, Vault};

#[test]
fn private_corpus_opens_and_reads() {
    let Ok(root) = std::env::var("SKRIBEUM_PRIVATE_CORPUS") else {
        // Not configured on this machine; the harness is local-only.
        return;
    };
    let root = PathBuf::from(root);

    let vault = match Vault::open(&RealFs, &root) {
        Ok(vault) => vault,
        Err(error) => panic!("private corpus failed to open: {error}"),
    };

    let mut notes = 0u64;
    let mut other_files = 0u64;
    let mut directories = 0u64;
    let mut read_failures = 0u64;
    let mut non_utf8 = 0u64;

    for entry in vault.tree() {
        match entry.kind {
            EntryKind::Directory => directories += 1,
            EntryKind::File => other_files += 1,
            EntryKind::Note => {
                notes += 1;
                match vault.read_note(&RealFs, &entry.path) {
                    Ok(content) => {
                        if content.encoding == skribeum_vault::Encoding::NonUtf8 {
                            non_utf8 += 1;
                        }
                    }
                    Err(_) => read_failures += 1,
                }
            }
        }
    }

    println!(
        "private corpus: {notes} notes, {other_files} other files, \
         {directories} directories, {} collisions, {non_utf8} non-utf8 notes, \
         {read_failures} read failures",
        vault.collisions().len()
    );

    assert_eq!(
        read_failures, 0,
        "open+read must succeed on every note ({read_failures} of {notes} failed)"
    );
}
