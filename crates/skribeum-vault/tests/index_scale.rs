//! Indexing a vault must stay linear in its entry count.
//!
//! Opening and refreshing a vault walks every entry, and both run on the path
//! that decides whether the application answers input. A per-entry scan over
//! everything already seen makes that walk quadratic, which is invisible on a
//! sample vault and fatal on a real one, so the cost is asserted rather than
//! left to review.
//!
//! This measures the real filesystem deliberately. The simulator answers
//! `read_dir` by scanning its whole entry table, so a vault indexed through it
//! is quadratic whatever the indexer does, and a scaling assertion run there
//! would measure the harness.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use skribeum_vault::{FileSystem, RealFs, Vault};

/// Notes per folder, matching the shape of a vault organised by topic.
const NOTES_PER_FOLDER: usize = 20;
/// Entry counts compared. Their ratio sets the linear expectation.
const SMALL_NOTES: usize = 1_000;
const LARGE_NOTES: usize = 6_000;

/// A temporary directory removed when the guard drops.
struct TempVault(PathBuf);

impl TempVault {
    fn build(label: &str, notes: usize) -> Self {
        let root = std::env::temp_dir().join(format!(
            "skribeum-index-scale-{label}-{}",
            std::process::id()
        ));
        let _ = RealFs.remove_dir_all(&root);
        RealFs
            .create_dir_all(&root)
            .expect("temporary vault root is creatable");
        for index in 0..notes {
            let folder = root.join(format!("folder-{:05}", index / NOTES_PER_FOLDER));
            if index % NOTES_PER_FOLDER == 0 {
                RealFs.create_dir_all(&folder).expect("folder is creatable");
            }
            RealFs
                .write_file(&folder.join(format!("note-{index:06}.md")), b"# Note\n")
                .expect("note is writable");
        }
        Self(root)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempVault {
    fn drop(&mut self) {
        let _ = RealFs.remove_dir_all(&self.0);
    }
}

/// Median of several opens, so one scheduling hiccup cannot decide the result.
fn median_open_duration(root: &Path) -> Duration {
    let mut samples: Vec<Duration> = (0..5)
        .map(|_| {
            let started = Instant::now();
            let vault = Vault::open(&RealFs, root).expect("vault opens");
            let elapsed = started.elapsed();
            assert!(!vault.tree().is_empty(), "the vault indexed entries");
            elapsed
        })
        .collect();
    samples.sort_unstable();
    samples[samples.len() / 2]
}

/// The observed cost ratio, and the ratio a linear indexer would produce.
fn scaling(small: Duration, large: Duration) -> (f64, f64) {
    let observed = large.as_secs_f64() / small.as_secs_f64().max(f64::EPSILON);
    #[expect(
        clippy::cast_precision_loss,
        reason = "entry counts are small integers"
    )]
    let linear = LARGE_NOTES as f64 / SMALL_NOTES as f64;
    (observed, linear)
}

#[test]
fn opening_a_vault_scales_linearly_with_its_entry_count() {
    let small = TempVault::build("open-small", SMALL_NOTES);
    let large = TempVault::build("open-large", LARGE_NOTES);
    // Warm the directory cache so the first sample is not paying for it.
    let _ = Vault::open(&RealFs, small.path()).expect("small vault opens");
    let _ = Vault::open(&RealFs, large.path()).expect("large vault opens");

    let (observed, linear) = scaling(
        median_open_duration(small.path()),
        median_open_duration(large.path()),
    );

    // Linear indexing lands near the entry-count ratio; the per-entry scan
    // this guards against lands near its square. The ceiling sits far enough
    // above the linear expectation to absorb allocator and cache effects on a
    // loaded machine while still failing decisively on a reintroduced scan.
    assert!(
        observed < linear * 3.0,
        "indexing {linear:.0}x the entries took {observed:.1}x the time; \
         indexing is not linear"
    );
}

#[test]
fn refreshing_a_vault_scales_linearly_with_its_entry_count() {
    let small = TempVault::build("refresh-small", SMALL_NOTES);
    let large = TempVault::build("refresh-large", LARGE_NOTES);
    let mut small_vault = Vault::open(&RealFs, small.path()).expect("small vault opens");
    let mut large_vault = Vault::open(&RealFs, large.path()).expect("large vault opens");

    let started = Instant::now();
    small_vault.refresh(&RealFs).expect("small vault refreshes");
    let small_elapsed = started.elapsed();
    let started = Instant::now();
    large_vault.refresh(&RealFs).expect("large vault refreshes");
    let large_elapsed = started.elapsed();

    let (observed, linear) = scaling(small_elapsed, large_elapsed);
    assert!(
        observed < linear * 3.0,
        "refreshing {linear:.0}x the entries took {observed:.1}x the time; \
         refreshing is not linear"
    );
}

#[test]
fn indexing_reports_a_normalization_collision_the_filesystem_preserved() {
    // The keyed spelling count has to keep surfacing two on-disk spellings
    // that normalize onto one vault path. A filesystem that normalizes names
    // itself stores one file for both spellings, so the collision cannot
    // exist there; which case this run is in is read back from disk rather
    // than assumed from the platform.
    let root =
        std::env::temp_dir().join(format!("skribeum-index-collision-{}", std::process::id()));
    let _ = RealFs.remove_dir_all(&root);
    RealFs
        .create_dir_all(&root)
        .expect("temporary vault root is creatable");
    RealFs
        .write_file(&root.join("caf\u{e9}.md"), b"precomposed\n")
        .expect("note is writable");
    RealFs
        .write_file(&root.join("cafe\u{301}.md"), b"decomposed\n")
        .expect("note is writable");

    let spellings = RealFs
        .read_dir(&root)
        .expect("vault root is readable")
        .len();
    let vault = Vault::open(&RealFs, &root).expect("vault opens");
    let collisions = vault.collisions().to_vec();
    let entries = vault.tree().len();
    let _ = RealFs.remove_dir_all(&root);

    if spellings == 2 {
        assert!(
            !collisions.is_empty(),
            "two preserved spellings of one normalized path collide"
        );
    } else {
        assert_eq!(
            spellings, 1,
            "the filesystem either preserves both spellings or folds them into one"
        );
        assert_eq!(entries, 1, "one on-disk file indexes as one entry");
        assert!(collisions.is_empty(), "one file cannot collide with itself");
    }
}
