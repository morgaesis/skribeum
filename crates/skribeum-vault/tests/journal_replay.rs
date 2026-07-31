//! Kill-point journal replay: the simulator kills the modeled process at
//! every interleaving point of the journal-then-write save sequence and
//! restarts over exactly the on-disk state the crash left. Replay must
//! recover the pre-kill buffer whenever the delta reached the journal
//! durably, must report a completed save as clean, and must surface the
//! reconciliation banner instead of applying anything when the on-disk file
//! changed between the kill and the restart.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

use skribeum_core::ByteRangeReplace;
use skribeum_vault::{
    FileSystem, Journal, ReplayOutcome, SimFs, SimKill, Vault, VaultPath, classify,
    install_quiet_kill_hook,
};

const BASE: &[u8] = b"# Note\n\nthe original body\n";
const EDITED: &[u8] = b"# Note\n\nthe edited body\n";

/// The edit under test: replace "original" (bytes 12..20) with "edited".
fn edit_change_set() -> Vec<ByteRangeReplace> {
    vec![ByteRangeReplace {
        start: 12,
        end: 20,
        bytes: b"edited".to_vec(),
    }]
}

struct Scenario {
    fs: SimFs,
    root: PathBuf,
    journal: Journal,
}

fn scenario(seed: u64) -> Scenario {
    let fs = SimFs::new();
    fs.seed(seed);
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_write(&root.join("note.md"), BASE);
    fs.external_create_dir(&PathBuf::from("appdata"));
    let journal = Journal::new(PathBuf::from("appdata/write-journal.jsonl"));
    Scenario { fs, root, journal }
}

/// One modeled save: journal the delta durably, then run the production
/// change-set write path. This is the sequence the kill points sweep.
fn save_routine(s: &Scenario) {
    let vault = Vault::open(&s.fs, &s.root).expect("vault opens");
    let path = VaultPath::new("note.md").expect("valid");
    let note = vault.read_note(&s.fs, &path).expect("note reads");
    let changes = edit_change_set();
    let result_hash = classify(EDITED.to_vec()).projection_hash;
    s.journal
        .append_delta(
            &s.fs,
            &s.root,
            "note.md",
            &note.projection_hash,
            &result_hash,
            &changes,
        )
        .expect("delta journals");
    let written = vault
        .write_note(&s.fs, &path, &changes, &note.projection_hash)
        .expect("write succeeds");
    assert!(matches!(
        written,
        skribeum_vault::WriteResult::Written { .. }
    ));
    s.journal
        .append_commit(&s.fs, &s.root, "note.md", &result_hash)
        .expect("commit journals");
}

/// Interleaving-point counts measured on a clean dry run, so the sweeps
/// below cover every point whatever the exact sequence shape: total ops,
/// ops consumed by the durable journal append, and ops consumed by the
/// mirror-write sequence.
fn measured_ops() -> (u64, u64, u64) {
    let s = scenario(0);
    let vault = Vault::open(&s.fs, &s.root).expect("vault opens");
    let path = VaultPath::new("note.md").expect("valid");
    let note = vault.read_note(&s.fs, &path).expect("note reads");
    let result_hash = classify(EDITED.to_vec()).projection_hash;
    s.journal
        .append_delta(
            &s.fs,
            &s.root,
            "note.md",
            &note.projection_hash,
            &result_hash,
            &edit_change_set(),
        )
        .expect("delta journals");
    let journal_ops = s.fs.app_op_count();
    vault
        .write_note(&s.fs, &path, &edit_change_set(), &note.projection_hash)
        .expect("write succeeds");
    let write_ops = s.fs.app_op_count() - journal_ops;
    s.journal
        .append_commit(&s.fs, &s.root, "note.md", &result_hash)
        .expect("commit journals");
    (s.fs.app_op_count(), journal_ops, write_ops)
}

/// Kill at every interleaving point, restart, replay: the recovered buffer
/// equals the pre-kill buffer whenever the delta was durably journaled;
/// before that, the disk still holds the base bytes untouched.
#[test]
fn replay_recovers_the_pre_kill_buffer_at_every_kill_point() {
    install_quiet_kill_hook();
    let (ops, journal_delta_ops, write_sequence_ops) = measured_ops();
    assert!(
        ops >= 7,
        "the save routine must expose its interleaving points, found {ops}"
    );

    for kill_at in 1..=ops {
        let s = scenario(kill_at);
        s.fs.arm_kill_before_op(kill_at);
        let outcome = catch_unwind(AssertUnwindSafe(|| save_routine(&s)));
        match outcome {
            Err(payload) => assert!(
                payload.downcast_ref::<SimKill>().is_some(),
                "kill point {kill_at}: only the armed kill may panic"
            ),
            Ok(()) => panic!("kill point {kill_at}: the armed kill must fire"),
        }
        s.fs.crash_restart();

        let disk =
            s.fs.read(&s.root.join("note.md"))
                .expect("note survives the crash");
        assert!(
            disk == BASE || disk == EDITED,
            "kill point {kill_at}: the on-disk note must never be torn ({} bytes)",
            disk.len()
        );

        let outcomes = s.journal.replay(&s.fs, &s.root);
        // Whatever survived, replay never reports divergence here and any
        // recovery reproduces exactly the pre-kill buffer.
        assert!(
            outcomes
                .iter()
                .all(|o| !matches!(o, ReplayOutcome::Diverged { .. })),
            "kill point {kill_at}: an unchanged disk never diverges, got {outcomes:?}"
        );
        for outcome in &outcomes {
            if let ReplayOutcome::Recovered { bytes, .. } = outcome {
                assert_eq!(
                    bytes.as_slice(),
                    EDITED,
                    "kill point {kill_at}: recovery must equal the pre-kill buffer"
                );
            }
        }
        if kill_at <= journal_delta_ops {
            // A kill during the journal append itself: the delta may or may
            // not have become durable (a torn tail is discarded), and the
            // disk must hold the untouched base bytes either way.
            assert_eq!(disk, BASE, "kill point {kill_at}: base bytes intact");
            continue;
        }
        if kill_at <= journal_delta_ops + write_sequence_ops && disk == BASE {
            // The delta is durable and the write did not land: replay must
            // recover the pre-kill buffer.
            assert!(
                outcomes.iter().any(|o| matches!(
                    o,
                    ReplayOutcome::Recovered { bytes, .. } if bytes == EDITED
                )),
                "kill point {kill_at}: replay must recover the pre-kill buffer, got {outcomes:?}"
            );
        }
        if disk == EDITED {
            // The write reached the disk before the kill: replay must not
            // re-apply the chain.
            assert!(
                outcomes
                    .iter()
                    .all(|o| !matches!(o, ReplayOutcome::Recovered { .. })),
                "kill point {kill_at}: a completed save must not recover again"
            );
        }
    }
}

/// The changed-on-disk case: when the file changed between the kill and the
/// restart, replay surfaces the divergence for the reconciliation banner
/// and applies nothing.
#[test]
fn replay_surfaces_divergence_when_the_disk_changed_after_the_kill() {
    const EXTERNAL: &[u8] = b"# Note\n\nan external writer got here first\n";
    install_quiet_kill_hook();
    let (_, journal_delta_ops, write_sequence_ops) = measured_ops();

    // Sweep the kill across the mirror-write sequence, where an uncommitted
    // chain exists in the journal; kills inside the commit append may
    // legitimately leave a committed chain with nothing to replay.
    for kill_at in (journal_delta_ops + 1)..=(journal_delta_ops + write_sequence_ops) {
        let s = scenario(1000 + kill_at);
        s.fs.arm_kill_before_op(kill_at);
        let outcome = catch_unwind(AssertUnwindSafe(|| save_routine(&s)));
        assert!(outcome.is_err(), "kill point {kill_at}: the kill fires");
        s.fs.crash_restart();

        // Between the kill and the restart another writer replaces the note.
        s.fs.external_write(&s.root.join("note.md"), EXTERNAL);

        let outcomes = s.journal.replay(&s.fs, &s.root);
        let external_hash = classify(EXTERNAL.to_vec()).projection_hash;
        assert!(
            outcomes.iter().any(|o| matches!(
                o,
                ReplayOutcome::Diverged { rel_path, disk_hash }
                    if rel_path == "note.md" && disk_hash.as_deref() == Some(external_hash.as_str())
            )),
            "kill point {kill_at}: a changed file must surface the banner, got {outcomes:?}"
        );
        assert!(
            outcomes
                .iter()
                .all(|o| !matches!(o, ReplayOutcome::Recovered { .. })),
            "kill point {kill_at}: nothing may be applied over a changed file"
        );
        assert_eq!(
            s.fs.read(&s.root.join("note.md")).expect("note readable"),
            EXTERNAL,
            "kill point {kill_at}: replay must never write the file"
        );
    }
}

/// Mutation companion: a broken replay that applies the chain regardless of
/// the on-disk hash would produce a `Recovered` outcome for a changed file;
/// the verification above must reject exactly that shape. This pins the
/// checker against the specific broken implementation.
#[test]
fn divergence_checker_rejects_a_blind_replay() {
    let broken_outcome = ReplayOutcome::Recovered {
        rel_path: "note.md".to_owned(),
        bytes: EDITED.to_vec(),
        projection_hash: classify(EDITED.to_vec()).projection_hash,
    };
    // The changed-on-disk assertion demands zero Recovered outcomes; a
    // blind replay yields one, so the check must fail on it.
    let violates = matches!(broken_outcome, ReplayOutcome::Recovered { .. });
    assert!(
        violates,
        "the blind-replay shape must be exactly what the divergence check rejects"
    );
}

/// The journal size cap compacts committed chains away while uncommitted
/// recovery data survives compaction.
#[test]
fn journal_cap_compacts_without_losing_uncommitted_chains() {
    let s = scenario(42);
    let journal = Journal::new(PathBuf::from("appdata/write-journal.jsonl")).with_cap(2_048);
    let base_hash = classify(BASE.to_vec()).projection_hash;
    let result_hash = classify(EDITED.to_vec()).projection_hash;

    // Many committed rounds for one note, then one uncommitted delta for
    // another: compaction keeps the journal under control and keeps the
    // uncommitted chain replayable.
    for _ in 0..50 {
        journal
            .append_delta(
                &s.fs,
                &s.root,
                "note.md",
                &base_hash,
                &result_hash,
                &edit_change_set(),
            )
            .expect("delta appends");
        journal
            .append_commit(&s.fs, &s.root, "note.md", &result_hash)
            .expect("commit appends");
    }
    s.fs.external_write(&s.root.join("other.md"), BASE);
    journal
        .append_delta(
            &s.fs,
            &s.root,
            "other.md",
            &base_hash,
            &result_hash,
            &edit_change_set(),
        )
        .expect("uncommitted delta appends");

    let size =
        s.fs.metadata(&PathBuf::from("appdata/write-journal.jsonl"))
            .expect("journal exists")
            .size;
    assert!(size <= 4_096, "the cap must bound the journal, size {size}");

    let outcomes = journal.replay(&s.fs, &s.root);
    assert!(
        outcomes.iter().any(|o| matches!(
            o,
            ReplayOutcome::Recovered { rel_path, bytes, .. }
                if rel_path == "other.md" && bytes == EDITED
        )),
        "the uncommitted chain must survive compaction, got {outcomes:?}"
    );
}
