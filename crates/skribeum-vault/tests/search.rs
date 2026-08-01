//! Full-text search gates: FTS results verified against a brute-force scan
//! over the committed corpus, ranking sanity (title above body), snippet
//! match-range integrity, incremental updates driven through the
//! deterministic simulator's reconciliation events, transparent recovery
//! from a corrupted index file, and the zero-writes-in-vault guard extended
//! to cover search indexing.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use skribeum_vault::{
    FileSystem, RealFs, ReconEvent, Reconciler, ReconcilerConfig, SearchIndex, SimFs, Vault,
    VaultPath, write_durable,
};

fn corpus_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/corpus")
}

/// Loads every markdown corpus file as `(file name, bytes)`.
fn corpus_notes() -> Vec<(String, Vec<u8>)> {
    let mut notes = Vec::new();
    let entries = RealFs.read_dir(&corpus_dir()).expect("corpus dir readable");
    for entry in entries {
        if entry.is_dir || !entry.file_name.to_lowercase().ends_with(".md") {
            continue;
        }
        let bytes = RealFs.read(&entry.path).expect("corpus file readable");
        notes.push((entry.file_name, bytes));
    }
    assert!(notes.len() > 10, "corpus is present and non-trivial");
    notes
}

/// The reference tokenizer for the brute-force scan, mirroring the FTS5
/// unicode61 rule that alphanumeric runs are tokens: lowercase, split on
/// anything non-alphanumeric.
fn tokens(text: &str) -> BTreeSet<String> {
    let mut set = BTreeSet::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_alphanumeric() {
            for lower in ch.to_lowercase() {
                current.push(lower);
            }
        } else if !current.is_empty() {
            set.insert(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        set.insert(current);
    }
    set
}

/// The note title exactly as the index derives it: final path segment
/// without its extension.
fn title_of(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.')
        .map_or(name, |(stem, _)| stem)
        .to_owned()
}

/// Tokenizes every note once: `(path, title and body tokens)`.
fn tokenized_notes(notes: &[(String, Vec<u8>)]) -> Vec<(String, BTreeSet<String>)> {
    notes
        .iter()
        .filter_map(|(path, bytes)| {
            let text = std::str::from_utf8(bytes).ok()?;
            let mut all = tokens(text);
            all.extend(tokens(&title_of(path)));
            Some((path.clone(), all))
        })
        .collect()
}

/// Brute-force scan: a note is a hit when every query term appears as a
/// token of its title or body.
fn brute_force_hits(tokenized: &[(String, BTreeSet<String>)], query: &str) -> BTreeSet<String> {
    let terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    tokenized
        .iter()
        .filter(|(_, all)| terms.iter().all(|term| all.contains(term)))
        .map(|(path, _)| path.clone())
        .collect()
}

/// Every hit the brute-force scan finds over the corpus, FTS finds too,
/// over a spread of one- and two-term queries drawn from real corpus
/// vocabulary. The assertion is non-tautological: the query set must
/// produce a substantial number of scan hits overall.
#[test]
fn fts_finds_every_brute_force_hit_over_corpus() {
    let notes = corpus_notes();
    let index = SearchIndex::in_memory().expect("index opens");
    for (path, bytes) in &notes {
        index.index_note(path, bytes).expect("note indexes");
    }

    let queries = [
        "heading",
        "table",
        "code",
        "list",
        "link",
        "tag",
        "footnote",
        "emphasis",
        "task",
        "callout",
        "block",
        "line",
        "heading setext",
        "fenced code",
        "nested list",
    ];
    let tokenized = tokenized_notes(&notes);
    let mut total_scan_hits = 0usize;
    for query in queries {
        let expected = brute_force_hits(&tokenized, query);
        total_scan_hits += expected.len();
        let found: BTreeSet<String> = index
            .query(query, 10_000)
            .expect("query runs")
            .into_iter()
            .map(|hit| hit.path)
            .collect();
        for path in &expected {
            assert!(
                found.contains(path),
                "brute-force scan finds {path:?} for {query:?} but FTS does not"
            );
        }
    }
    assert!(
        total_scan_hits >= 20,
        "the query set must actually exercise the corpus (got {total_scan_hits} scan hits)"
    );
}

/// Fixed inputs for the search-scale gate. The generated notes deliberately
/// share common terms while retaining deterministic group and topic terms,
/// so sampled multi-term queries exercise both broad and narrow result sets.
const SEARCH_SCALE_NOTE_COUNT: usize = 5_000;
const SEARCH_SCALE_SEED: u64 = 0x51ca_1e5e_d00d_f00d;

fn search_scale_value(index: usize) -> u64 {
    let mut value = SEARCH_SCALE_SEED ^ u64::try_from(index).expect("note index fits in u64");
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn search_scale_note(index: usize) -> (String, Vec<u8>) {
    let value = search_scale_value(index);
    let group = value % 29;
    let topic = (value >> 16) % 37;
    (
        format!("scale-note-{index:04}.md"),
        format!("# Search scale {index}\n\nscaleanchor group{group} topic{topic} unique{index}\n")
            .into_bytes(),
    )
}

fn search_scale_notes() -> Vec<(String, Vec<u8>)> {
    (0..SEARCH_SCALE_NOTE_COUNT)
        .map(search_scale_note)
        .collect()
}

/// A synthetic 5,000-note vault remains searchable after a full rebuild.
/// The sampled queries must match an independent brute-force token scan.
/// This test intentionally has no timing
/// assertion: `scripts/search-scale.ts` measures its rebuild with a real
/// clock outside the deterministic Rust suite.
#[test]
fn fts_finds_every_brute_force_hit_over_synthetic_scale_vault() {
    let fs = SimFs::new();
    fs.seed(SEARCH_SCALE_SEED);
    let root = PathBuf::from("search-scale-vault");
    fs.external_create_dir(&root);

    let notes = search_scale_notes();
    for (path, bytes) in &notes {
        fs.external_write(&root.join(path), bytes);
    }
    fs.deliver_all();

    let vault = Vault::open(&fs, &root).expect("synthetic vault opens");
    assert_eq!(
        vault
            .tree()
            .iter()
            .filter(|entry| entry.kind == skribeum_vault::EntryKind::Note)
            .count(),
        SEARCH_SCALE_NOTE_COUNT,
        "the synthetic vault contains every generated note"
    );
    let index = SearchIndex::in_memory().expect("index opens");
    assert_eq!(
        index.rebuild(&fs, &vault).expect("rebuild runs"),
        SEARCH_SCALE_NOTE_COUNT,
        "the rebuild indexes every synthetic note"
    );

    let tokenized = tokenized_notes(&notes);
    let mut queries = vec!["scaleanchor".to_owned()];
    for index in [0, 317, 911, 1_729, 2_903, 4_999] {
        let value = search_scale_value(index);
        queries.push(format!(
            "scaleanchor group{} topic{}",
            value % 29,
            (value >> 16) % 37
        ));
    }

    let mut total_scan_hits = 0usize;
    for query in &queries {
        let expected = brute_force_hits(&tokenized, query);
        assert!(
            !expected.is_empty(),
            "the deterministic query {query:?} exercises the synthetic vault"
        );
        total_scan_hits += expected.len();
        let found: BTreeSet<String> = index
            .query(
                query,
                u32::try_from(SEARCH_SCALE_NOTE_COUNT).expect("scale fits in u32"),
            )
            .expect("query runs")
            .into_iter()
            .map(|hit| hit.path)
            .collect();
        assert_eq!(
            found, expected,
            "FTS and the brute-force scan disagree for {query:?}"
        );
    }
    assert!(
        total_scan_hits > SEARCH_SCALE_NOTE_COUNT,
        "the sample queries include broad and narrow result sets (got {total_scan_hits} hits)"
    );
    assert_eq!(
        fs.app_write_count(),
        0,
        "search rebuild never writes to the vault"
    );
}

/// A title match outranks a body match for the same term.
#[test]
fn title_match_outranks_body_match() {
    let index = SearchIndex::in_memory().expect("index opens");
    index
        .index_note(
            "folder/glossary.md",
            b"plain body text with nothing special in it\n",
        )
        .expect("indexes");
    index
        .index_note(
            "other.md",
            b"the word glossary appears here in the body text\n",
        )
        .expect("indexes");

    let hits = index.query("glossary", 10).expect("query runs");
    assert_eq!(hits.len(), 2, "both notes match");
    assert_eq!(
        hits[0].path, "folder/glossary.md",
        "the title match ranks first"
    );
    assert!(
        hits[0].score > hits[1].score,
        "scores order with the ranking"
    );
    assert_eq!(hits[0].title, "glossary");
}

/// Snippet match ranges are byte offsets into the snippet that point at
/// the query term, on character boundaries, with no markup involved.
#[test]
fn snippet_match_ranges_point_at_terms() {
    let index = SearchIndex::in_memory().expect("index opens");
    let body = "Intro line.\n\nThe reconciliation banner appears when the Reconciliation \
                path diverges.\n";
    index
        .index_note("note.md", body.as_bytes())
        .expect("indexes");

    let hits = index.query("reconciliation", 10).expect("query runs");
    assert_eq!(hits.len(), 1);
    let hit = &hits[0];
    assert!(!hit.match_ranges.is_empty(), "match ranges are present");
    for [start, end] in &hit.match_ranges {
        let slice = &hit.snippet[*start as usize..*end as usize];
        assert!(
            slice.eq_ignore_ascii_case("reconciliation"),
            "range points at the term, got {slice:?}"
        );
    }
}

/// A heading match outranks body-only matches, even repeated ones: the
/// heading weight has to actually reach the headings column for this to
/// hold, so the case discriminates a broken weight mapping.
#[test]
fn heading_match_outranks_body_match() {
    let index = SearchIndex::in_memory().expect("index opens");
    index
        .index_note("a.md", b"# Provenance rules\n\nBody follows here.\n")
        .expect("indexes");
    index
        .index_note(
            "b.md",
            b"# Other topic\n\nprovenance in prose, provenance again, provenance thrice.\n",
        )
        .expect("indexes");
    let hits = index.query("provenance", 10).expect("query runs");
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].path, "a.md", "the heading match ranks first");
}

/// FTS5 query operators in user input are inert: they are matched as
/// literal terms, never interpreted as syntax.
#[test]
fn query_syntax_is_inert() {
    let index = SearchIndex::in_memory().expect("index opens");
    index
        .index_note("note.md", b"ordinary text body\n")
        .expect("indexes");
    for hostile in ["NOT text", "\"unbalanced", "a* OR b", "col:value", "(text"] {
        // Must not error; hostile input is quoted internally.
        let _ = index.query(hostile, 10).expect("hostile query still runs");
    }
    assert_eq!(
        index.query("", 10).expect("empty query runs").len(),
        0,
        "an empty query returns nothing"
    );
}

/// A hash-prefixed query uses the tag index rather than FTS tokenization,
/// so similar tags and untagged prose do not enter the result set.
#[test]
fn exact_tag_query_matches_inline_and_frontmatter_occurrences() {
    let index = SearchIndex::in_memory().expect("index opens");
    index
        .index_note(
            "scalar.md",
            b"---\ntags: Alpha\n---\n\nalpha appears as ordinary prose\n",
        )
        .expect("scalar frontmatter indexes");
    index
        .index_note(
            "flow.md",
            b"---\ntags: [alpha, beta-two]\n---\n\n#alpha and #Alpha plus #alphabet\n",
        )
        .expect("flow and inline tags index");
    index
        .index_note(
            "block.md",
            b"---\ntags:\n  - listed/tag\n  - beta-two\n---\n\nNo inline tags.\n",
        )
        .expect("block frontmatter indexes");

    let hits = index.query("#ALPHA", 10).expect("exact tag query runs");
    assert_eq!(
        hits.iter().map(|hit| hit.path.as_str()).collect::<Vec<_>>(),
        ["flow.md", "scalar.md"],
        "frequency orders exact matches and excludes the longer tag"
    );
    assert!((hits[0].score - 3.0).abs() < f64::EPSILON);
    for hit in &hits {
        assert_eq!(hit.match_ranges.len(), 1);
        let [start, end] = hit.match_ranges[0];
        let matched = &hit.snippet[start as usize..end as usize];
        assert_eq!(matched.trim_start_matches('#').to_lowercase(), "alpha");
    }
    assert!(
        index
            .query("#alp", 10)
            .expect("short tag query runs")
            .is_empty(),
        "tag queries do not perform prefix matching"
    );
    assert_eq!(
        index
            .query("#listed/tag", 10)
            .expect("nested tag query runs")[0]
            .path,
        "block.md"
    );
}

#[test]
fn frontmatter_tags_follow_inline_tag_grammar() {
    let index = SearchIndex::in_memory().expect("index opens");
    index
        .index_note(
            "grammar.md",
            b"---\ntags: [two words, 123, trailing/, valid_tag, nested/tag]\n---\n",
        )
        .expect("frontmatter indexes");

    let tags = index
        .tag_frequencies()
        .expect("tag catalog reads")
        .into_iter()
        .map(|entry| entry.tag)
        .collect::<BTreeSet<_>>();
    assert_eq!(
        tags,
        BTreeSet::from(["nested/tag".to_owned(), "valid_tag".to_owned()])
    );
}

/// The catalog folds spelling for counts while retaining a display spelling,
/// and re-indexing or removing a note updates the derived totals.
#[test]
fn tag_catalog_counts_and_tracks_index_updates() {
    let index = SearchIndex::in_memory().expect("index opens");
    index
        .index_note(
            "one.md",
            b"---\ntags: [Alpha, beta]\n---\n\n#alpha #alpha\n",
        )
        .expect("first note indexes");
    index
        .index_note("two.md", b"#ALPHA #gamma\n")
        .expect("second note indexes");

    let catalog = index.tag_frequencies().expect("catalog reads");
    let alpha = catalog
        .iter()
        .find(|entry| entry.tag.eq_ignore_ascii_case("alpha"))
        .expect("alpha is cataloged");
    assert_eq!(alpha.note_count, 2);
    assert_eq!(alpha.occurrence_count, 4);

    index
        .index_note("one.md", b"---\ntags: beta\n---\n")
        .expect("first note re-indexes");
    let alpha = index
        .tag_frequencies()
        .expect("updated catalog reads")
        .into_iter()
        .find(|entry| entry.tag.eq_ignore_ascii_case("alpha"))
        .expect("second note still contributes alpha");
    assert_eq!(alpha.note_count, 1);
    assert_eq!(alpha.occurrence_count, 1);

    index.remove_note("two.md").expect("second note removes");
    assert!(
        index
            .tag_frequencies()
            .expect("catalog after removal reads")
            .iter()
            .all(|entry| !entry.tag.eq_ignore_ascii_case("alpha")),
        "removal drops the final alpha occurrence"
    );
    assert!(
        index
            .query("#alpha", 10)
            .expect("tag query runs")
            .is_empty(),
        "exact tag search uses the same updated index"
    );
}

#[test]
fn tag_catalog_bounds_indexed_values_and_result_count() {
    let index = SearchIndex::in_memory().expect("index opens");
    let mut note = (0..=1000)
        .map(|number| format!("#tag-{number}"))
        .collect::<Vec<_>>()
        .join(" ");
    note.push(' ');
    note.push('#');
    note.push_str(&"x".repeat(513));
    index
        .index_note("many.md", note.as_bytes())
        .expect("bounded catalog indexes");

    let catalog = index.tag_frequencies().expect("bounded catalog reads");
    assert_eq!(catalog.len(), 1000);
    assert!(catalog.iter().all(|entry| entry.tag.len() <= 512));
    assert!(
        index
            .query("#tag-1000", 10)
            .expect("tag query runs")
            .is_empty(),
        "tags beyond the per-note storage bound are not indexed"
    );
}

fn test_config() -> ReconcilerConfig {
    ReconcilerConfig {
        settle: Duration::from_millis(3),
        write_settle: Duration::from_millis(10),
        shrink_guard_percent: 25,
        bulk_threshold: 20,
    }
}

/// Polls the reconciler through the settle window and applies every event
/// to the search index, returning the events.
fn settle_apply(
    fs: &SimFs,
    root: &Path,
    recon: &mut Reconciler,
    index: &SearchIndex,
) -> Vec<ReconEvent> {
    let mut events = Vec::new();
    for _ in 0..6 {
        fs.advance_ticks(4);
        for event in recon.poll(fs, root, Duration::from_millis(fs.tick())) {
            index
                .apply_recon_event(fs, root, &event)
                .expect("event applies to the index");
            events.push(event);
        }
    }
    events
}

/// Incremental index updates driven by the simulator's reconciliation
/// events: external creates and edits re-index, external deletes remove,
/// and the whole pipeline performs zero writes inside the vault.
#[test]
fn incremental_updates_follow_simulator_events() {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_write(&root.join("a.md"), b"alpha content here\n");
    fs.deliver_all();

    let vault = Vault::open(&fs, &root).expect("vault opens");
    let index = SearchIndex::in_memory().expect("index opens");
    let indexed = index.rebuild(&fs, &vault).expect("rebuild runs");
    assert_eq!(indexed, 1);
    let mut recon = Reconciler::new(test_config());
    let a = VaultPath::new("a.md").expect("valid");
    let note = vault.read_note(&fs, &a).expect("note reads");
    recon.record_read(&a, &note.bytes);

    assert_eq!(index.query("alpha", 10).expect("query").len(), 1);

    // External create: a new note appears and becomes searchable.
    let b = VaultPath::new("b.md").expect("valid");
    fs.external_write(&root.join("b.md"), b"bravo fresh note\n");
    fs.advance_ticks(1);
    recon.observe_event(&b, Duration::from_millis(fs.tick()));
    let events = settle_apply(&fs, &root, &mut recon, &index);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ReconEvent::ExternalUpdate { path, .. } if path == &b)),
        "the create classifies as an external update"
    );
    let hits = index.query("bravo", 10).expect("query");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].path, "b.md");

    // External edit: content replaced; the old term stops matching and the
    // new one starts.
    fs.external_write(&root.join("a.md"), b"charlie replaced everything\n");
    fs.advance_ticks(1);
    recon.observe_event(&a, Duration::from_millis(fs.tick()));
    settle_apply(&fs, &root, &mut recon, &index);
    assert_eq!(
        index.query("alpha", 10).expect("query").len(),
        0,
        "the replaced content stops matching"
    );
    assert_eq!(index.query("charlie", 10).expect("query").len(), 1);

    // External delete: the note drops out of the index.
    fs.external_remove(&root.join("a.md"));
    fs.advance_ticks(1);
    recon.observe_event(&a, Duration::from_millis(fs.tick()));
    let events = settle_apply(&fs, &root, &mut recon, &index);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ReconEvent::ExternalRemove { path } if path == &a)),
        "the delete classifies as an external remove"
    );
    assert_eq!(index.query("charlie", 10).expect("query").len(), 0);

    // The zero-writes guard extended to search indexing: opening, reading,
    // rebuilding and incrementally updating the index never wrote a byte
    // inside the vault.
    assert_eq!(
        fs.app_write_count(),
        0,
        "search indexing must never write inside the vault"
    );
}

/// Banner events leave the index untouched: nothing was ingested, so the
/// index keeps serving the last ingested content.
#[test]
fn banner_events_leave_index_untouched() {
    let fs = SimFs::new();
    let root = PathBuf::from("vault");
    fs.external_create_dir(&root);
    fs.external_write(&root.join("a.md"), b"steady searchable content\n");
    fs.deliver_all();
    let vault = Vault::open(&fs, &root).expect("vault opens");
    let index = SearchIndex::in_memory().expect("index opens");
    index.rebuild(&fs, &vault).expect("rebuild runs");
    let mut recon = Reconciler::new(test_config());
    let a = VaultPath::new("a.md").expect("valid");
    recon.record_read(&a, b"steady searchable content\n");

    // A non-empty note reading back empty takes the banner path.
    fs.external_write(&root.join("a.md"), b"");
    fs.advance_ticks(1);
    recon.observe_event(&a, Duration::from_millis(fs.tick()));
    let events = settle_apply(&fs, &root, &mut recon, &index);
    assert!(
        events
            .iter()
            .any(|e| matches!(e, ReconEvent::Banner { .. })),
        "the empty read classifies as a banner"
    );
    assert_eq!(
        index.query("steady", 10).expect("query").len(),
        1,
        "the banner did not disturb the indexed content"
    );
}

/// A unique scratch directory, created through the trait.
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("skribeum-search-{}-{name}", std::process::id()));
    let _ = RealFs.remove_file(&dir);
    RealFs.create_dir_all(&dir).expect("scratch dir creates");
    dir
}

/// Recursive `(relative path, bytes)` snapshot of a directory tree.
fn snapshot(root: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>) {
    for entry in RealFs.read_dir(dir).expect("dir readable") {
        if entry.is_dir {
            snapshot(root, &entry.path, out);
        } else {
            let relative = entry
                .path
                .strip_prefix(root)
                .expect("inside root")
                .to_string_lossy()
                .into_owned();
            out.push((relative, RealFs.read(&entry.path).expect("file readable")));
        }
    }
    out.sort();
}

/// The on-disk index lives in the app-data directory and never in the
/// vault: a full open-rebuild-query cycle leaves every byte of the vault
/// untouched and creates the database file under the app-data dir.
#[test]
fn index_lives_in_app_data_and_vault_stays_untouched() {
    let vault_root = scratch("vault");
    let app_data = scratch("app-data");
    write_durable(
        &RealFs,
        &vault_root.join("first.md"),
        b"# First\n\nsearchable prose\n",
    )
    .expect("note writes");
    RealFs
        .create_dir_all(&vault_root.join("sub"))
        .expect("subdir creates");
    write_durable(
        &RealFs,
        &vault_root.join("sub/second.md"),
        b"more searchable prose\n",
    )
    .expect("note writes");

    let mut before = Vec::new();
    snapshot(&vault_root, &vault_root, &mut before);

    let vault = Vault::open(&RealFs, &vault_root).expect("vault opens");
    let index = SearchIndex::open_in_app_data(&app_data, vault.root()).expect("index opens");
    let indexed = index.rebuild(&RealFs, &vault).expect("rebuild runs");
    assert_eq!(indexed, 2);
    let hits = index.query("searchable", 10).expect("query runs");
    assert_eq!(hits.len(), 2);

    let mut after = Vec::new();
    snapshot(&vault_root, &vault_root, &mut after);
    assert_eq!(
        before, after,
        "search indexing changed bytes inside the vault"
    );

    let db_files = RealFs
        .read_dir(&app_data.join("search"))
        .expect("index dir exists");
    assert!(
        db_files.iter().any(|entry| !entry.is_dir),
        "the index database file exists under the app-data directory"
    );
}

/// A corrupted index file is discarded and recreated transparently on
/// open, and a rebuild restores full search.
#[test]
fn corrupt_index_recovers_transparently_on_open() {
    let dir = scratch("corrupt");
    let db_path = dir.join("index.sqlite3");

    {
        let index = SearchIndex::open_at(&db_path).expect("fresh index opens");
        index
            .index_note("note.md", b"durable words inside\n")
            .expect("indexes");
        assert_eq!(index.query("durable", 10).expect("query").len(), 1);
    }

    // Clobber the database with garbage.
    RealFs
        .write_file(&db_path, b"this is not a sqlite database at all")
        .expect("garbage writes");

    let index = SearchIndex::open_at(&db_path).expect("corrupt index reopens transparently");
    assert_eq!(
        index.query("durable", 10).expect("query runs").len(),
        0,
        "the corrupt index was discarded, not resurrected"
    );
    index
        .index_note("note.md", b"durable words inside\n")
        .expect("re-indexes after recovery");
    assert_eq!(index.query("durable", 10).expect("query").len(), 1);
}

/// Non-UTF-8 notes are read-only and unsearchable; indexing one removes
/// any previous entry. A UTF-8 BOM is stripped from the indexed text.
#[test]
fn encoding_edge_cases() {
    let index = SearchIndex::in_memory().expect("index opens");
    index
        .index_note("note.md", b"findable before corruption\n")
        .expect("indexes");
    assert_eq!(index.query("findable", 10).expect("query").len(), 1);
    index
        .index_note("note.md", &[0xFF, 0xFE, 0x00])
        .expect("non-utf8 handled");
    assert_eq!(
        index.query("findable", 10).expect("query").len(),
        0,
        "a note that became non-UTF-8 drops out of the index"
    );

    let mut bom_note = vec![0xEF, 0xBB, 0xBF];
    bom_note.extend_from_slice(b"bomword here\n");
    index.index_note("bom.md", &bom_note).expect("indexes");
    let hits = index.query("bomword", 10).expect("query");
    assert_eq!(hits.len(), 1);
    assert!(
        !hits[0].snippet.starts_with('\u{FEFF}'),
        "the BOM is not part of the snippet"
    );
}
