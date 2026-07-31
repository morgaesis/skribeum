//! Vault-relative paths. `VaultPath` is the only path shape that crosses the
//! IPC boundary: slash-separated, NFC-normalized, relative to the vault root.
//! Absolute paths never leave the vault layer except as the argument of a
//! vault open.

use std::collections::BTreeMap;
use std::fmt;

use unicode_normalization::{UnicodeNormalization, is_nfc};

/// Why a string is not a valid vault path.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum VaultPathError {
    /// The string is empty.
    #[error("vault path is empty")]
    Empty,
    /// The path is absolute (leading slash) or otherwise anchored outside the
    /// vault root.
    #[error("vault path must be relative to the vault root")]
    Absolute,
    /// A segment is empty (leading, trailing or doubled slash).
    #[error("vault path contains an empty segment")]
    EmptySegment,
    /// A segment is `.` or `..`, which would escape or alias inside the vault.
    #[error("vault path contains a traversal segment")]
    Traversal,
    /// The path contains a backslash. Backslashes are directory separators on
    /// Windows and cannot be represented portably in a slash-separated path.
    #[error("vault path contains a backslash")]
    Backslash,
    /// The path contains a NUL byte.
    #[error("vault path contains a NUL byte")]
    Nul,
}

/// A `/`-separated, NFC-normalized path relative to the vault root.
///
/// Construction normalizes to NFC and rejects anything absolute, empty,
/// traversing (`.`/`..`), backslash-separated or NUL-containing. Two raw
/// strings that differ only in Unicode normalization form construct equal
/// `VaultPath` values; detecting when that collapses two distinct on-disk
/// files into one logical path is the vault indexer's job, surfaced through
/// [`detect_collisions`].
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct VaultPath(String);

impl VaultPath {
    /// Parses and normalizes a vault-relative path.
    ///
    /// # Errors
    ///
    /// Returns a [`VaultPathError`] when the input violates any vault path
    /// rule; the input is never silently repaired beyond NFC normalization.
    pub fn new(raw: &str) -> Result<Self, VaultPathError> {
        if raw.is_empty() {
            return Err(VaultPathError::Empty);
        }
        if raw.contains('\0') {
            return Err(VaultPathError::Nul);
        }
        if raw.contains('\\') {
            return Err(VaultPathError::Backslash);
        }
        if raw.starts_with('/') {
            return Err(VaultPathError::Absolute);
        }
        for segment in raw.split('/') {
            if segment.is_empty() {
                return Err(VaultPathError::EmptySegment);
            }
            if segment == "." || segment == ".." {
                return Err(VaultPathError::Traversal);
            }
        }
        let normalized = if is_nfc(raw) {
            raw.to_owned()
        } else {
            raw.nfc().collect()
        };
        Ok(Self(normalized))
    }

    /// Builds a vault path by appending `segment` to `parent`, or from
    /// `segment` alone when `parent` is `None`.
    ///
    /// # Errors
    ///
    /// Returns a [`VaultPathError`] when the resulting path violates any
    /// vault path rule.
    pub fn join(parent: Option<&VaultPath>, segment: &str) -> Result<Self, VaultPathError> {
        match parent {
            Some(parent) => Self::new(&format!("{}/{segment}", parent.0)),
            None => Self::new(segment),
        }
    }

    /// The normalized path string.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// The final path segment.
    #[must_use]
    pub fn file_name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or(&self.0)
    }

    /// Whether the path names a markdown note, by case-insensitive `.md`
    /// extension.
    #[must_use]
    pub fn is_note(&self) -> bool {
        let name = self.file_name();
        name.len() > 3 && name[name.len() - 3..].eq_ignore_ascii_case(".md")
    }

    /// Case-folded key used for collision detection on case-insensitive
    /// filesystems. Unicode default lowercase over the NFC form; this is a
    /// detection key, never a display or storage form.
    #[must_use]
    pub fn case_fold_key(&self) -> String {
        self.0.to_lowercase()
    }
}

impl fmt::Display for VaultPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A group of distinct on-disk paths that collapse into one logical path,
/// either by case folding (case-insensitive filesystems merge them) or by
/// Unicode normalization (NFC and NFD spellings of one name).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathCollision {
    /// The shared case-folded key.
    pub key: String,
    /// The colliding paths, normalized but case-preserved, sorted.
    pub paths: Vec<String>,
}

/// Detects case and normalization collisions across an indexed path set.
///
/// `raw_names` carries one entry per on-disk file: the normalized
/// `VaultPath` plus how many distinct raw spellings mapped onto it. A
/// collision is surfaced, never silently merged (two files that one
/// filesystem treats as distinct and another treats as one are a data-loss
/// hazard, not a cosmetic issue).
#[must_use]
pub fn detect_collisions(paths: &[(VaultPath, usize)]) -> Vec<PathCollision> {
    let mut groups: BTreeMap<String, Vec<&VaultPath>> = BTreeMap::new();
    let mut collisions = Vec::new();
    for (path, raw_spellings) in paths {
        // Distinct raw spellings normalizing to one VaultPath collide even
        // though the folded group below sees a single entry.
        if *raw_spellings > 1 {
            collisions.push(PathCollision {
                key: path.case_fold_key(),
                paths: vec![path.as_str().to_owned()],
            });
        }
        groups.entry(path.case_fold_key()).or_default().push(path);
    }
    for (key, members) in groups {
        if members.len() > 1 {
            let mut member_paths: Vec<String> =
                members.iter().map(|p| p.as_str().to_owned()).collect();
            member_paths.sort();
            collisions.push(PathCollision {
                key,
                paths: member_paths,
            });
        }
    }
    collisions.sort();
    collisions
}

impl PartialOrd for PathCollision {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PathCollision {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        (&self.key, &self.paths).cmp(&(&other.key, &other.paths))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_shapes() {
        assert_eq!(VaultPath::new(""), Err(VaultPathError::Empty));
        assert_eq!(VaultPath::new("/abs"), Err(VaultPathError::Absolute));
        assert_eq!(VaultPath::new("a//b"), Err(VaultPathError::EmptySegment));
        assert_eq!(VaultPath::new("a/"), Err(VaultPathError::EmptySegment));
        assert_eq!(VaultPath::new("../x"), Err(VaultPathError::Traversal));
        assert_eq!(VaultPath::new("a/./b"), Err(VaultPathError::Traversal));
        assert_eq!(VaultPath::new("a\\b"), Err(VaultPathError::Backslash));
        assert_eq!(VaultPath::new("a\0b"), Err(VaultPathError::Nul));
    }

    #[test]
    fn normalizes_nfd_to_nfc() {
        let decomposed = "Cafe\u{0301}.md";
        let composed = "Caf\u{e9}.md";
        let parsed_decomposed = VaultPath::new(decomposed).expect("valid path");
        let parsed_composed = VaultPath::new(composed).expect("valid path");
        assert_eq!(parsed_decomposed, parsed_composed);
        assert_eq!(parsed_decomposed.as_str(), composed);
    }

    #[test]
    fn note_detection_is_case_insensitive() {
        assert!(VaultPath::new("a/b.md").expect("valid").is_note());
        assert!(VaultPath::new("a/b.MD").expect("valid").is_note());
        assert!(!VaultPath::new("a/b.txt").expect("valid").is_note());
        assert!(!VaultPath::new(".md").expect("valid").is_note());
    }

    #[test]
    fn case_collision_detected() {
        let a = VaultPath::new("dir/Note.md").expect("valid");
        let b = VaultPath::new("dir/note.md").expect("valid");
        let collisions = detect_collisions(&[(a, 1), (b, 1)]);
        assert_eq!(collisions.len(), 1);
        assert_eq!(
            collisions[0].paths,
            vec!["dir/Note.md".to_owned(), "dir/note.md".to_owned()]
        );
    }

    #[test]
    fn normalization_collision_detected() {
        let merged = VaultPath::new("Caf\u{e9}.md").expect("valid");
        let collisions = detect_collisions(&[(merged, 2)]);
        assert_eq!(collisions.len(), 1);
        assert_eq!(collisions[0].paths, vec!["Caf\u{e9}.md".to_owned()]);
    }

    #[test]
    fn distinct_paths_produce_no_collision() {
        let a = VaultPath::new("a.md").expect("valid");
        let b = VaultPath::new("b.md").expect("valid");
        assert!(detect_collisions(&[(a, 1), (b, 1)]).is_empty());
    }
}
