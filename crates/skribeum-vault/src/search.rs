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

use std::collections::{BTreeMap, VecDeque};
use std::path::Path;

use rusqlite::{Connection, Transaction, params};
use sha2::{Digest, Sha256};
use skribeum_core::{ExtractionKind, extract, read_frontmatter};

use crate::fs::FileSystem;
use crate::real::RealFs;
use crate::recon::ReconEvent;
use crate::vault::{EntryKind, Vault};

/// Version of the on-disk index schema. A file carrying any other version
/// is dropped and rebuilt rather than migrated: the index is derived state.
pub const SEARCH_SCHEMA_VERSION: u32 = 5;

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

/// One existing vault tag and its aggregate usage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagFrequency {
    /// Tag text without its leading hash, preserving one vault spelling.
    pub tag: String,
    /// Number of notes containing the tag.
    pub note_count: u32,
    /// Total inline and frontmatter occurrences across indexed notes.
    pub occurrence_count: u32,
}

/// Maximum snippet length in bytes, before character-boundary snapping.
const SNIPPET_MAX_BYTES: usize = 180;
/// Bytes of context kept before the first match in a snippet.
const SNIPPET_LEAD_BYTES: usize = 40;
/// Maximum stored tag length, aligned with the search query byte limit.
const MAX_INDEXED_TAG_BYTES: usize = 512;
/// Maximum number of distinct tags returned to one catalog consumer.
const MAX_TAG_CATALOG_ENTRIES: u32 = 1000;
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
            self.conn.execute_batch(
                "DROP TABLE IF EXISTS note_index;
                 DROP TABLE IF EXISTS note_tags;
                 DROP TABLE IF EXISTS note_case_index;
                 DROP TABLE IF EXISTS note_case_paths;",
            )?;
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
            );
             CREATE TABLE IF NOT EXISTS note_tags(
                path TEXT NOT NULL,
                normalized TEXT NOT NULL,
                display TEXT NOT NULL,
                occurrences INTEGER NOT NULL,
                first_start INTEGER NOT NULL,
                first_end INTEGER NOT NULL,
                PRIMARY KEY(path, normalized)
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
        tx.prepare_cached("DELETE FROM note_index WHERE path = ?1")?
            .execute([path])?;
        tx.prepare_cached("DELETE FROM note_tags WHERE path = ?1")?
            .execute([path])?;
        let Ok(text) = core::str::from_utf8(bytes) else {
            return Ok(());
        };
        let body = text.strip_prefix('\u{FEFF}').unwrap_or(text);
        let body_byte_offset = bytes.len().saturating_sub(body.len());
        let extractions = extract(bytes);
        let mut headings = String::new();
        let mut tags = BTreeMap::<String, (String, u32, usize, usize)>::new();
        for (raw, start, end) in frontmatter_tags(body) {
            record_tag(&mut tags, raw, start, end);
        }
        for extraction in &extractions {
            match extraction.kind {
                ExtractionKind::Heading => {
                    let Ok(heading) =
                        core::str::from_utf8(&bytes[extraction.start_byte..extraction.end_byte])
                    else {
                        continue;
                    };
                    if !headings.is_empty() {
                        headings.push('\n');
                    }
                    headings.push_str(heading);
                }
                ExtractionKind::Tag => {
                    let Some(raw) = bytes
                        .get(extraction.start_byte + 1..extraction.end_byte)
                        .and_then(|slice| core::str::from_utf8(slice).ok())
                    else {
                        continue;
                    };
                    record_tag(
                        &mut tags,
                        raw,
                        extraction.start_byte.saturating_sub(body_byte_offset),
                        extraction.end_byte.saturating_sub(body_byte_offset),
                    );
                }
                _ => {}
            }
        }
        let title = note_title(path);
        tx.prepare_cached(
            "INSERT INTO note_index(path, title, headings, body) VALUES(?1, ?2, ?3, ?4)",
        )?
        .execute([path, &title, &headings, body])?;
        let mut insert_tag = tx.prepare_cached(
            "INSERT INTO note_tags(path, normalized, display, occurrences, first_start, first_end)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        )?;
        for (normalized, (display, occurrences, first_start, first_end)) in tags {
            insert_tag.execute(params![
                path,
                normalized,
                display,
                i64::from(occurrences),
                i64::try_from(first_start).unwrap_or(i64::MAX),
                i64::try_from(first_end).unwrap_or(i64::MAX)
            ])?;
        }
        Ok(())
    }

    /// Removes a note from the index.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError::Storage`] when the index cannot be updated.
    pub fn remove_note(&self, path: &str) -> Result<(), SearchError> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM note_index WHERE path = ?1", [path])?;
        tx.execute("DELETE FROM note_tags WHERE path = ?1", [path])?;
        tx.commit()?;
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
        tx.execute("DELETE FROM note_tags", [])?;
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
        self.query_with_options(query, limit, true, false)
    }

    /// Returns the vault's tags with note and occurrence counts.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError::Storage`] when the catalog cannot be read.
    pub fn tag_frequencies(&self) -> Result<Vec<TagFrequency>, SearchError> {
        let mut statement = self.conn.prepare(
            "SELECT MIN(display), COUNT(*), SUM(occurrences)
             FROM note_tags
             GROUP BY normalized
             ORDER BY SUM(occurrences) DESC, normalized ASC
             LIMIT ?1",
        )?;
        let rows = statement.query_map([i64::from(MAX_TAG_CATALOG_ENTRIES)], |row| {
            let note_count = row.get::<_, i64>(1)?;
            let occurrence_count = row.get::<_, i64>(2)?;
            Ok(TagFrequency {
                tag: row.get(0)?,
                note_count: u32::try_from(note_count).unwrap_or(u32::MAX),
                occurrence_count: u32::try_from(occurrence_count).unwrap_or(u32::MAX),
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(SearchError::from)
    }

    fn query_tag(&self, tag: &str, limit: u32) -> Result<Vec<SearchHit>, SearchError> {
        let mut statement = self.conn.prepare(
            "SELECT note_index.path, note_index.title, note_index.body,
                    note_tags.occurrences, note_tags.first_start, note_tags.first_end
             FROM note_tags
             JOIN note_index ON note_index.path = note_tags.path
             WHERE note_tags.normalized = ?1
             ORDER BY note_tags.occurrences DESC, note_index.path ASC
             LIMIT ?2",
        )?;
        let rows = statement.query_map(params![tag.to_lowercase(), i64::from(limit)], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })?;
        let mut hits = Vec::new();
        for row in rows {
            let (path, title, body, occurrences, first_start, first_end) = row?;
            let start = usize::try_from(first_start).unwrap_or(0).min(body.len());
            let end = usize::try_from(first_end)
                .unwrap_or(start)
                .clamp(start, body.len());
            let (snippet, match_ranges) = build_range_snippet(&body, start, end);
            hits.push(SearchHit {
                path,
                title,
                snippet,
                match_ranges,
                score: f64::from(u32::try_from(occurrences).unwrap_or(u32::MAX)),
            });
        }
        Ok(hits)
    }

    /// Runs a ranked query with title-only and case-sensitive filtering.
    /// FTS5 identifies the complete candidate set before exact-case filtering,
    /// so case-sensitive matches cannot be hidden by higher-ranked case variants.
    ///
    /// # Errors
    ///
    /// Returns [`SearchError::Storage`] when the query cannot run.
    pub fn query_with_options(
        &self,
        query: &str,
        limit: u32,
        search_note_bodies: bool,
        case_sensitive: bool,
    ) -> Result<Vec<SearchHit>, SearchError> {
        let source_terms: Vec<String> = query.split_whitespace().map(str::to_owned).collect();
        if source_terms.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        if source_terms.len() == 1
            && let Some(tag) = source_terms[0]
                .strip_prefix('#')
                .filter(|tag| !tag.is_empty())
        {
            return self.query_tag(tag, limit);
        }
        let match_expression = regular_match_expression(&source_terms, search_note_bodies);
        if match_expression.is_empty() {
            return Ok(Vec::new());
        }

        let (title_weight, heading_weight, body_weight) = BM25_WEIGHTS;
        // bm25() takes one weight per column in declaration order, the
        // UNINDEXED path column included; its weight is inert and passed as
        // zero.
        let sql = "SELECT path, title, headings, body,
                          bm25(note_index, 0.0, ?2, ?3, ?4) AS rank
                   FROM note_index
                   WHERE note_index MATCH ?1
                   ORDER BY rank
                   LIMIT ?5";
        let mut statement = self.conn.prepare(sql)?;
        // Exact-case filtering happens after FTS ranking, so it must inspect
        // every case-insensitive candidate to remain complete. Other queries
        // retain SQLite's bounded result limit.
        let candidate_limit = if case_sensitive {
            i64::MAX
        } else {
            i64::from(limit)
        };
        let rows = statement.query_map(
            params![
                match_expression,
                title_weight,
                heading_weight,
                body_weight,
                candidate_limit
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, f64>(4)?,
                ))
            },
        )?;

        let lowered_terms: Vec<String> = source_terms
            .iter()
            .map(|term| term.to_lowercase())
            .collect();
        let mut hits = Vec::new();
        for row in rows {
            let (path, title, headings, body, rank) = row?;
            if case_sensitive
                && !source_terms.iter().all(|term| {
                    case_phrase_matches(&title, term)
                        || (search_note_bodies
                            && (case_phrase_matches(&headings, term)
                                || case_phrase_matches(&body, term)))
                })
            {
                continue;
            }
            let searchable = if search_note_bodies { &body } else { &title };
            let (snippet, match_ranges) = if case_sensitive {
                build_case_sensitive_snippet(searchable, &source_terms)
            } else {
                build_snippet(searchable, &lowered_terms)
            };
            hits.push(SearchHit {
                path,
                title,
                snippet,
                match_ranges,
                // BM25 in FTS5 returns lower-is-better (negative for
                // matches); negate so higher ranks better for callers.
                score: -rank,
            });
            if hits.len() == limit as usize {
                break;
            }
        }
        Ok(hits)
    }
}

type IndexedTags = BTreeMap<String, (String, u32, usize, usize)>;

fn record_tag(tags: &mut IndexedTags, raw: &str, start: usize, end: usize) {
    let display = raw.strip_prefix('#').unwrap_or(raw);
    if display.is_empty() || display.len() > MAX_INDEXED_TAG_BYTES {
        return;
    }
    let entry = tags
        .entry(display.to_lowercase())
        .or_insert_with(|| (display.to_owned(), 0, start, end));
    entry.1 = entry.1.saturating_add(1);
}

#[derive(Clone, Copy)]
struct SourceLine<'a> {
    from: usize,
    text: &'a str,
}

fn source_lines(text: &str, range: core::ops::Range<usize>) -> Vec<SourceLine<'_>> {
    let mut lines = Vec::new();
    let mut from = range.start;
    while from < range.end {
        let rest = &text[from..range.end];
        let terminator = rest
            .char_indices()
            .find(|(_, character)| matches!(character, '\n' | '\r'));
        let (line_end, next) = match terminator {
            Some((offset, '\r')) if rest.as_bytes().get(offset + 1) == Some(&b'\n') => {
                (from + offset, from + offset + 2)
            }
            Some((offset, _)) => (from + offset, from + offset + 1),
            None => (range.end, range.end),
        };
        lines.push(SourceLine {
            from,
            text: &text[from..line_end],
        });
        from = next;
    }
    lines
}

fn frontmatter_tag_item(raw: &str, start: usize) -> Option<(&str, usize, usize)> {
    let trimmed_start = raw.trim_start();
    let leading = raw.len().saturating_sub(trimmed_start.len());
    let trimmed = trimmed_start.trim_end();
    if trimmed.is_empty() {
        return None;
    }
    Some((trimmed, start + leading, start + leading + trimmed.len()))
}

/// Reads only the scalar, simple flow-list and block-list forms understood
/// by the browser's positional frontmatter parser. Quoted and nested flow
/// values remain plain metadata rather than being interpreted as tags.
fn frontmatter_tags(body: &str) -> Vec<(&str, usize, usize)> {
    let Some(range) = read_frontmatter(body.as_bytes()) else {
        return Vec::new();
    };
    let lines = source_lines(body, range);
    if lines.len() < 2 {
        return Vec::new();
    }

    let mut tags = Vec::new();
    let mut line_index = 1usize;
    while line_index + 1 < lines.len() {
        let line = lines[line_index];
        let Some((key, after_colon)) = line.text.split_once(':') else {
            line_index += 1;
            continue;
        };
        if key.is_empty() || key.chars().next().is_some_and(char::is_whitespace) || key != "tags" {
            line_index += 1;
            continue;
        }

        let value_start = line.from + key.len() + 1;
        let value = after_colon.trim();
        let leading = after_colon
            .len()
            .saturating_sub(after_colon.trim_start().len());
        let trimmed_start = value_start + leading;
        if value.is_empty() {
            let mut item_index = line_index + 1;
            while item_index + 1 < lines.len() {
                let item_line = lines[item_index];
                let indentation = item_line.text.len() - item_line.text.trim_start().len();
                let after_indent = &item_line.text[indentation..];
                let Some(after_dash) = after_indent.strip_prefix('-') else {
                    break;
                };
                if !after_dash.chars().next().is_some_and(char::is_whitespace) {
                    break;
                }
                let item_start = item_line.from + indentation + 1;
                if let Some(item) = frontmatter_tag_item(after_dash, item_start) {
                    tags.push(item);
                }
                item_index += 1;
            }
            line_index = item_index;
            continue;
        }

        if value.starts_with('[') && value.ends_with(']') {
            let inner = &value[1..value.len() - 1];
            if inner
                .chars()
                .any(|character| matches!(character, '"' | '\'' | '['))
            {
                line_index += 1;
                continue;
            }
            let mut offset = 0usize;
            for part in inner.split(',') {
                if let Some(item) = frontmatter_tag_item(part, trimmed_start + 1 + offset) {
                    tags.push(item);
                }
                offset += part.len() + 1;
            }
        } else if let Some(item) = frontmatter_tag_item(value, trimmed_start) {
            tags.push(item);
        }
        line_index += 1;
    }
    tags
}

fn regular_match_expression(source_terms: &[String], search_note_bodies: bool) -> String {
    source_terms
        .iter()
        .map(|term| term.replace('"', "\"\""))
        .map(|term| {
            if search_note_bodies {
                format!("\"{term}\"")
            } else {
                format!("title : \"{term}\"")
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn case_tokens(text: &str) -> impl Iterator<Item = &str> {
    text.split(|character: char| !character.is_alphanumeric() && character != '_')
        .filter(|term| !term.is_empty())
}

/// Matches one FTS phrase without folding case. Punctuation remains a token
/// separator, matching the index tokenizer while preserving Unicode bytes.
fn case_phrase_matches(text: &str, phrase: &str) -> bool {
    let expected = case_tokens(phrase).collect::<Vec<_>>();
    if expected.is_empty() {
        return false;
    }
    let mut window = VecDeque::with_capacity(expected.len());
    for token in case_tokens(text) {
        window.push_back(token);
        if window.len() > expected.len() {
            window.pop_front();
        }
        if window.len() == expected.len()
            && window
                .iter()
                .zip(&expected)
                .all(|(actual, expected)| actual == expected)
        {
            return true;
        }
    }
    false
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

/// Builds a snippet around one known byte range and translates that range
/// into snippet-relative byte offsets.
fn build_range_snippet(body: &str, start: usize, end: usize) -> (String, Vec<[u32; 2]>) {
    let match_start = snap_to_char_boundary(body, start);
    let match_end = snap_to_char_boundary(body, end.max(match_start)).max(match_start);
    let window_start = snap_to_char_boundary(body, match_start.saturating_sub(SNIPPET_LEAD_BYTES));
    let window_end = snap_to_char_boundary(body, (window_start + SNIPPET_MAX_BYTES).max(match_end));
    let snippet = body[window_start..window_end].to_owned();
    let range_start = match_start.saturating_sub(window_start);
    let range_end = match_end.saturating_sub(window_start);
    let match_ranges = match (u32::try_from(range_start), u32::try_from(range_end)) {
        (Ok(start), Ok(end)) if start < end => vec![[start, end]],
        _ => Vec::new(),
    };
    (snippet, match_ranges)
}

fn build_case_sensitive_snippet(body: &str, terms: &[String]) -> (String, Vec<[u32; 2]>) {
    let first = terms
        .iter()
        .filter_map(|term| body.find(term))
        .min()
        .unwrap_or(0);
    let window_start = snap_to_char_boundary(body, first.saturating_sub(SNIPPET_LEAD_BYTES));
    let window_end = snap_to_char_boundary(body, window_start + SNIPPET_MAX_BYTES);
    let snippet = body[window_start..window_end].to_owned();
    let mut ranges = terms
        .iter()
        .flat_map(|term| {
            snippet
                .match_indices(term)
                .map(|(start, matched)| (start, start + matched.len()))
        })
        .collect::<Vec<_>>();
    ranges.sort_unstable();
    let mut previous_end = 0;
    let mut converted = Vec::new();
    for (start, end) in ranges {
        if start < previous_end {
            continue;
        }
        let (Ok(start), Ok(end)) = (u32::try_from(start), u32::try_from(end)) else {
            continue;
        };
        previous_end = end as usize;
        converted.push([start, end]);
    }
    (snippet, converted)
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

    #[test]
    fn case_phrase_matching_preserves_case_and_tokenizes_punctuation() {
        assert!(case_phrase_matches(
            "before Case Phrase after",
            "Case-Phrase"
        ));
        assert!(!case_phrase_matches(
            "before case phrase after",
            "Case-Phrase"
        ));
    }

    #[test]
    fn query_options_control_scope_and_case() {
        let index = SearchIndex::in_memory().expect("index opens");
        index
            .index_note("Folder/Upper.md", b"Body Needle")
            .expect("note indexes");

        assert!(
            index
                .query_with_options("Needle", 10, false, false)
                .expect("title-only query runs")
                .is_empty()
        );
        assert_eq!(
            index
                .query_with_options("Needle", 10, true, true)
                .expect("case-sensitive query runs")
                .len(),
            1
        );
        assert_eq!(
            index
                .query_with_options("Upper", 10, true, true)
                .expect("case-sensitive title query runs")
                .len(),
            1
        );
        assert!(
            index
                .query_with_options("needle", 10, true, true)
                .expect("case-sensitive miss runs")
                .is_empty()
        );
        assert_eq!(
            index
                .query_with_options("upper", 10, false, false)
                .expect("title query runs")
                .len(),
            1
        );
    }

    #[test]
    fn case_sensitive_query_remains_complete_after_many_wrong_case_matches() {
        let index = SearchIndex::in_memory().expect("index opens");
        for number in 0..300 {
            index
                .index_note(&format!("wrong-{number}.md"), b"needle")
                .expect("note indexes");
        }
        index
            .index_note("right.md", b"Needle")
            .expect("matching note indexes");

        let hits = index
            .query_with_options("Needle", 1, true, true)
            .expect("query runs");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "right.md");
    }

    #[test]
    fn oversized_notes_remain_available_to_case_sensitive_search() {
        let index = SearchIndex::in_memory().expect("index opens");
        let mut body = vec![b'a'; 8 * 1024 * 1024 + 1];
        body[..7].copy_from_slice(b"Needle ");
        body[7..].fill(b' ');
        index
            .index_note("large.md", &body)
            .expect("note indexes normally");

        assert_eq!(
            index
                .query_with_options("needle", 1, true, false)
                .expect("regular query runs")
                .len(),
            1
        );
        assert_eq!(
            index
                .query_with_options("Needle", 1, true, true)
                .expect("case-sensitive query runs")
                .len(),
            1
        );
    }
}
