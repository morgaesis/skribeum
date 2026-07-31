//! Ranked full-text search over vault notes, backed by `SQLite` FTS5. The
//! index is device-local derived state: it lives in the OS app-data
//! directory, never inside the vault, and is rebuildable at any time from
//! the notes themselves. A corrupted or missing index file is rebuilt
//! transparently on open.
//!
//! Each note indexes as three weighted fields extracted through
//! `skribeum-core`: the title (final path segment without its extension),
//! the heading texts, and the body. Results rank by BM25 with the title
//! outweighing headings and headings outweighing body text. Snippets are
//! assembled Rust-side from the indexed note text, and match positions
//! return as byte ranges into the snippet so the UI highlights without any
//! HTML injection surface.
//!
//! `SQLite` performs its own file I/O, so this module is the one place in the
//! crate where persistence does not go through the [`FileSystem`] trait;
//! incremental updates and rebuilds still read note content exclusively
//! through the trait, which is what lets the simulator assert that
//! indexing never writes inside the vault.

use std::path::Path;

use rusqlite::{Connection, Transaction};
use sha2::{Digest, Sha256};
use skribeum_core::{ExtractionKind, extract};

use crate::fs::FileSystem;
use crate::real::RealFs;
use crate::recon::ReconEvent;
use crate::vault::{EntryKind, Vault};

/// Version of the on-disk index schema. A file carrying any other version
/// is dropped and rebuilt rather than migrated: the index is derived state.
pub const SEARCH_SCHEMA_VERSION: u32 = 1;

/// Search failures. The index is derived state, so every failure is
/// recoverable by a rebuild; messages never contain note content.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SearchError {
    /// The underlying index storage failed.
    #[error("search index storage failure: {0}")]
    Storage(String),
}

impl From<rusqlite::Error> for SearchError {
    fn from(error: rusqlite::Error) -> Self {
        // SQLite error text describes storage and SQL state, never note
        // content: no query here interpolates note bytes into SQL.
        Self::Storage(error.to_string())
    }
}

/// One ranked search result.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    /// Vault-relative path of the note.
    pub path: String,
    /// Note title (the final path segment without its extension).
    pub title: String,
    /// A snippet of the note text around the first match.
    pub snippet: String,
    /// Byte ranges of query-term matches inside `snippet`, `[start, end)`,
    /// aligned to character boundaries.
    pub match_ranges: Vec<[u32; 2]>,
    /// Relevance score; higher ranks better. Derived from BM25 with title
    /// matches weighted above heading matches above body matches.
    pub score: f64,
}

/// Maximum snippet length in bytes, before character-boundary snapping.
const SNIPPET_MAX_BYTES: usize = 180;
/// Bytes of context kept before the first match in a snippet.
const SNIPPET_LEAD_BYTES: usize = 40;

/// BM25 column weights: title, headings, body.
const BM25_WEIGHTS: (f64, f64, f64) = (8.0, 3.0, 1.0);

/// A full-text index over one vault's notes.
pub struct SearchIndex {
    conn: Connection,
}

impl SearchIndex {
    /// Opens (or creates) the index for `vault_root` inside `app_data_dir`.
    /// The database file name is derived from a hash of the vault root, so
    /// distinct vaults get distinct index files and no vault path appears
    /// in the file name. A corrupted or version-skewed file is deleted and
    /// recreated transparently; the caller rebuilds content via
    /// [`SearchIndex::rebuild`].
    ///
    /// # Errors
    ///
    /// Returns [`SearchError::Storage`] when the index directory or a fresh
    /// database cannot be created even after discarding a corrupt file.
    pub fn open_in_app_data(app_data_dir: &Path, vault_root: &Path) -> Result<Self, SearchError> {
        let dir = app_data_dir.join("search");
        RealFs
            .create_dir_all(&dir)
            .map_err(|e| SearchError::Storage(e.to_string()))?;
        Self::open_at(&dir.join(index_file_name(vault_root)))
    }

    /// Opens (or creates) the index at an explicit database path,
    /// discarding and recreating the file when it is corrupt or carries a
    /// different schema version.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError::Storage`] when a usable database cannot be
    /// produced at `db_path` even after discarding the existing file.
    pub fn open_at(db_path: &Path) -> Result<Self, SearchError> {
        Self::try_open(db_path).or_else(|_| {
            // Corrupt, unreadable or version-skewed: the index is derived
            // state, so discard and recreate.
            let _ = RealFs.remove_file(db_path);
            Self::try_open(db_path)
        })
    }

    /// Opens an in-memory index, used by the deterministic tests.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError::Storage`] when `SQLite` cannot create the
    /// in-memory database.
    pub fn in_memory() -> Result<Self, SearchError> {
        let conn = Connection::open_in_memory()?;
        let index = Self { conn };
        index.initialize()?;
        Ok(index)
    }

    fn try_open(db_path: &Path) -> Result<Self, SearchError> {
        let conn = Connection::open(db_path)?;
        let index = Self { conn };
        index.initialize()?;
        Ok(index)
    }

    /// Creates the schema when absent and enforces the schema version:
    /// any other version drops the tables and starts fresh.
    fn initialize(&self) -> Result<(), SearchError> {
        self.conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )?;
        let version: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM index_meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .map(Some)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(None),
                other => Err(other),
            })?;
        if version.as_deref() != Some(&SEARCH_SCHEMA_VERSION.to_string()) {
            self.conn
                .execute_batch("DROP TABLE IF EXISTS note_index;")?;
            self.conn.execute(
                "INSERT OR REPLACE INTO index_meta(key, value) VALUES('schema_version', ?1)",
                [SEARCH_SCHEMA_VERSION.to_string()],
            )?;
        }
        self.conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS note_index USING fts5(
                path UNINDEXED,
                title,
                headings,
                body,
                tokenize = 'unicode61 remove_diacritics 2'
            );",
        )?;
        // Verify the FTS table is actually usable; a corrupt database can
        // survive DDL and fail only on first use.
        self.conn
            .query_row("SELECT count(*) FROM note_index", [], |row| {
                row.get::<_, i64>(0)
            })?;
        Ok(())
    }

    /// Indexes (or re-indexes) one note from its exact on-disk bytes.
    /// Non-UTF-8 notes are read-only and unsearchable; indexing one removes
    /// any stale entry instead.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError::Storage`] when the index cannot be updated.
    pub fn index_note(&self, path: &str, bytes: &[u8]) -> Result<(), SearchError> {
        let tx = self.conn.unchecked_transaction()?;
        Self::index_note_in_transaction(&tx, path, bytes)?;
        tx.commit()?;
        Ok(())
    }

    fn index_note_in_transaction(
        tx: &Transaction<'_>,
        path: &str,
        bytes: &[u8],
    ) -> Result<(), SearchError> {
        tx.execute("DELETE FROM note_index WHERE path = ?1", [path])?;
        let Ok(text) = core::str::from_utf8(bytes) else {
            return Ok(());
        };
        let body = text.strip_prefix('\u{FEFF}').unwrap_or(text);
        let headings = extract(bytes)
            .iter()
            .filter(|extraction| extraction.kind == ExtractionKind::Heading)
            .filter_map(|extraction| {
                core::str::from_utf8(&bytes[extraction.start_byte..extraction.end_byte]).ok()
            })
            .collect::<Vec<_>>()
            .join("\n");
        tx.execute(
            "INSERT INTO note_index(path, title, headings, body) VALUES(?1, ?2, ?3, ?4)",
            [path, &note_title(path), &headings, body],
        )?;
        Ok(())
    }

    /// Removes a note from the index.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError::Storage`] when the index cannot be updated.
    pub fn remove_note(&self, path: &str) -> Result<(), SearchError> {
        self.conn
            .execute("DELETE FROM note_index WHERE path = ?1", [path])?;
        Ok(())
    }

    /// Rebuilds the whole index from an open vault, reading every indexed
    /// note through the [`FileSystem`] trait. Reads only: the zero-writes
    /// guard asserts mechanically that a rebuild never writes inside the
    /// vault.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError::Storage`] when the index cannot be written.
    /// Unreadable notes are skipped; the index must never block on one bad
    /// file.
    pub fn rebuild(&self, fs: &dyn FileSystem, vault: &Vault) -> Result<usize, SearchError> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM note_index", [])?;
        let mut indexed = 0usize;
        for entry in vault.tree() {
            if entry.kind != EntryKind::Note {
                continue;
            }
            let absolute = vault.root().join(entry.path.as_str());
            let Ok(bytes) = fs.read(&absolute) else {
                continue;
            };
            Self::index_note_in_transaction(&tx, entry.path.as_str(), &bytes)?;
            indexed += 1;
        }
        tx.commit()?;
        Ok(indexed)
    }

    /// Applies one reconciliation event to the index: external updates
    /// re-read the note through the trait and re-index it, removals drop
    /// it, and banner or bulk-review events leave the index untouched
    /// (nothing was ingested, so nothing changes).
    ///
    /// # Errors
    ///
    /// Returns [`SearchError::Storage`] when the index cannot be updated.
    pub fn apply_recon_event(
        &self,
        fs: &dyn FileSystem,
        root: &Path,
        event: &ReconEvent,
    ) -> Result<(), SearchError> {
        match event {
            ReconEvent::ExternalUpdate { path, .. } => {
                match fs.read(&root.join(path.as_str())) {
                    Ok(bytes) => self.index_note(path.as_str(), &bytes),
                    // Gone again already; the remove event will follow.
                    Err(_) => Ok(()),
                }
            }
            ReconEvent::ExternalRemove { path } => self.remove_note(path.as_str()),
            ReconEvent::Banner { .. } | ReconEvent::BulkDivergence { .. } => Ok(()),
        }
    }

    /// Runs a ranked query. `query` is split on whitespace into terms that
    /// must all match (quoted internally, so FTS5 operator syntax in user
    /// input is inert); at most `limit` hits return, best first.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError::Storage`] when the query cannot run.
    pub fn query(&self, query: &str, limit: u32) -> Result<Vec<SearchHit>, SearchError> {
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|term| term.replace('"', "\"\""))
            .collect();
        if terms.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let match_expression = terms
            .iter()
            .map(|term| format!("\"{term}\""))
            .collect::<Vec<_>>()
            .join(" ");

        let (title_weight, heading_weight, body_weight) = BM25_WEIGHTS;
        // bm25() takes one weight per column in declaration order, the
        // UNINDEXED path column included; its weight is inert and passed as
        // zero.
        let mut statement = self.conn.prepare(
            "SELECT path, title, body, bm25(note_index, 0.0, ?2, ?3, ?4) AS rank
             FROM note_index
             WHERE note_index MATCH ?1
             ORDER BY rank
             LIMIT ?5",
        )?;
        let rows = statement.query_map(
            rusqlite::params![
                match_expression,
                title_weight,
                heading_weight,
                body_weight,
                i64::from(limit)
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, f64>(3)?,
                ))
            },
        )?;

        let lowered_terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
        let mut hits = Vec::new();
        for row in rows {
            let (path, title, body, rank) = row?;
            let (snippet, match_ranges) = build_snippet(&body, &lowered_terms);
            hits.push(SearchHit {
                path,
                title,
                snippet,
                match_ranges,
                // BM25 in FTS5 returns lower-is-better (negative for
                // matches); negate so higher ranks better for callers.
                score: -rank,
            });
        }
        Ok(hits)
    }
}

/// The index database file name for a vault root: a hash, so no vault path
/// leaks into the app-data directory listing.
#[must_use]
pub fn index_file_name(vault_root: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(vault_root.to_string_lossy().as_bytes());
    let digest = hasher.finalize();
    let mut name = String::with_capacity(48);
    for byte in digest.iter().take(16) {
        use std::fmt::Write;
        let _ = write!(name, "{byte:02x}");
    }
    name.push_str(".sqlite3");
    name
}

/// The note title used for indexing and results: the final path segment
/// without its extension.
fn note_title(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.')
        .map_or(name, |(stem, _)| if stem.is_empty() { name } else { stem })
        .to_owned()
}

/// Case-insensitive match of `term_lower` at byte position `pos` of
/// `text`; returns the matched byte length in `text`.
fn match_length_at(text: &str, pos: usize, term_lower: &str) -> Option<usize> {
    let mut term_chars = term_lower.chars();
    let mut consumed = 0usize;
    let mut expected = term_chars.next();
    for ch in text[pos..].chars() {
        let Some(_) = expected else { break };
        let mut lowered = ch.to_lowercase();
        while let Some(want) = expected {
            let Some(have) = lowered.next() else { break };
            if have != want {
                return None;
            }
            expected = term_chars.next();
        }
        if lowered.next().is_some() {
            // The character lowercases to more text than the term has left.
            return None;
        }
        consumed += ch.len_utf8();
        if expected.is_none() {
            return Some(consumed);
        }
    }
    None
}

/// The first lowered character of each non-empty term, used to prune match
/// attempts to positions that can possibly start one.
fn first_chars(terms_lower: &[String]) -> Vec<char> {
    terms_lower
        .iter()
        .filter_map(|term| term.chars().next())
        .collect()
}

/// Whether `ch` can start any term (its first lowered character equals a
/// term's first character).
fn can_start_term(ch: char, firsts: &[char]) -> bool {
    ch.to_lowercase()
        .next()
        .is_some_and(|lowered| firsts.contains(&lowered))
}

/// Every case-insensitive occurrence of any term inside `text`, as sorted,
/// non-overlapping `[start, end)` byte ranges.
fn term_ranges(text: &str, terms_lower: &[String]) -> Vec<(usize, usize)> {
    let firsts = first_chars(terms_lower);
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for (pos, ch) in text.char_indices() {
        if ranges.last().is_some_and(|&(_, end)| pos < end) {
            continue;
        }
        if !can_start_term(ch, &firsts) {
            continue;
        }
        let best = terms_lower
            .iter()
            .filter(|term| !term.is_empty())
            .filter_map(|term| match_length_at(text, pos, term))
            .max();
        if let Some(length) = best {
            ranges.push((pos, pos + length));
        }
    }
    ranges
}

/// The byte position of the earliest case-insensitive occurrence of any
/// term in `text`. Scanning stops at the first hit, so snippet assembly
/// never walks a whole large note.
fn first_match(text: &str, terms_lower: &[String]) -> Option<usize> {
    let firsts = first_chars(terms_lower);
    for (pos, ch) in text.char_indices() {
        if !can_start_term(ch, &firsts) {
            continue;
        }
        if terms_lower
            .iter()
            .filter(|term| !term.is_empty())
            .any(|term| match_length_at(text, pos, term).is_some())
        {
            return Some(pos);
        }
    }
    None
}

/// Snaps a byte offset to the nearest character boundary at or before it.
fn snap_to_char_boundary(text: &str, mut offset: usize) -> usize {
    offset = offset.min(text.len());
    while offset > 0 && !text.is_char_boundary(offset) {
        offset -= 1;
    }
    offset
}

/// Builds the result snippet from the indexed note text: a window around
/// the first term match (or the head of the note when only the title
/// matched), plus the byte ranges of every term match inside the window.
/// Match scanning is bounded to the window, so a hit inside a very large
/// note never costs a whole-note scan.
fn build_snippet(body: &str, terms_lower: &[String]) -> (String, Vec<[u32; 2]>) {
    let first = first_match(body, terms_lower).unwrap_or(0);
    let window_start = snap_to_char_boundary(body, first.saturating_sub(SNIPPET_LEAD_BYTES));
    let window_end = snap_to_char_boundary(body, window_start + SNIPPET_MAX_BYTES);
    let snippet = body[window_start..window_end].to_owned();

    let ranges = term_ranges(&snippet, terms_lower)
        .into_iter()
        .filter_map(|(start, end)| {
            let s = u32::try_from(start).ok()?;
            let e = u32::try_from(end).ok()?;
            Some([s, e])
        })
        .collect();
    (snippet, ranges)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn title_strips_directories_and_extension() {
        assert_eq!(note_title("folder/note.md"), "note");
        assert_eq!(note_title("note.md"), "note");
        assert_eq!(note_title("no-extension"), "no-extension");
        assert_eq!(note_title(".hidden.md"), ".hidden");
    }

    #[test]
    fn snippet_ranges_align_and_match() {
        let body = "before the Quick brown fox jumps over the lazy dog after";
        let (snippet, ranges) = build_snippet(body, &["quick".to_owned(), "dog".to_owned()]);
        assert!(!ranges.is_empty());
        for [start, end] in &ranges {
            let slice = &snippet[*start as usize..*end as usize];
            assert!(
                slice.eq_ignore_ascii_case("quick") || slice.eq_ignore_ascii_case("dog"),
                "range points at a term, got {slice:?}"
            );
        }
    }

    #[test]
    fn snippet_handles_multibyte_boundaries() {
        let body = "\u{1F600}".repeat(100) + "needle" + &"\u{1F600}".repeat(100);
        let (snippet, ranges) = build_snippet(&body, &["needle".to_owned()]);
        assert_eq!(ranges.len(), 1);
        let [start, end] = ranges[0];
        assert_eq!(&snippet[start as usize..end as usize], "needle");
    }

    #[test]
    fn match_length_handles_case_folding() {
        assert_eq!(match_length_at("Straße", 0, "straße"), Some(7));
        assert_eq!(match_length_at("HELLO", 0, "hello"), Some(5));
        assert_eq!(match_length_at("world", 0, "word"), None);
    }
}
