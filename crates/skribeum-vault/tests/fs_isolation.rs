//! Guard: no `std::fs` or `tokio::fs` call sites outside the real
//! filesystem implementation. Comments and string literals are stripped
//! before matching so documentation mentioning the forbidden paths does not
//! false-positive. Runs in CI on every push.

use std::path::{Path, PathBuf};

use skribeum_vault::{FileSystem, RealFs};

/// Files allowed to touch the real filesystem directly.
const ALLOWED: &[&str] = &[
    // The single production call site; everything else goes through traits.
    "crates/skribeum-vault/src/real.rs",
    // Fixture loading in the I/O-free core crate's test harnesses. The
    // core crate has no dependency on this crate, so it cannot use RealFs.
    "crates/skribeum-core/tests/corpus_coverage.rs",
    "crates/skribeum-core/tests/line_ending_corpus.rs",
    "crates/skribeum-core/tests/conformance.rs",
    "crates/skribeum-core/tests/wikilink_properties.rs",
];

/// Source roots scanned for Rust files.
const SCAN_ROOTS: &[&str] = &["crates", "src-tauri/src", "src-tauri/tests"];

#[test]
fn no_direct_fs_call_sites_outside_real_implementation() {
    let workspace = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let workspace = workspace.canonicalize().unwrap_or(workspace);
    let mut violations = Vec::new();

    for root in SCAN_ROOTS {
        let root = workspace.join(root);
        if RealFs.metadata(&root).is_err() {
            continue;
        }
        scan(&workspace, &root, &mut violations);
    }

    assert!(
        violations.is_empty(),
        "direct std::fs/tokio::fs call sites outside the real implementation:\n{}",
        violations.join("\n")
    );
}

fn scan(workspace: &Path, dir: &Path, violations: &mut Vec<String>) {
    let entries = RealFs.read_dir(dir).expect("source directory is readable");
    for entry in entries {
        if entry.is_dir {
            if entry.file_name == "target" || entry.file_name == "gen" {
                continue;
            }
            scan(workspace, &entry.path, violations);
            continue;
        }
        if !Path::new(&entry.file_name)
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("rs"))
        {
            continue;
        }
        let relative = entry
            .path
            .strip_prefix(workspace)
            .unwrap_or(&entry.path)
            .to_string_lossy()
            .replace('\\', "/");
        if ALLOWED.contains(&relative.as_str()) {
            continue;
        }
        let source = RealFs.read(&entry.path).expect("source file is readable");
        let source = String::from_utf8_lossy(&source);
        let code = strip_comments_and_strings(&source);
        for finding in findings(&code) {
            violations.push(format!("{relative}: {finding}"));
        }
    }
}

/// Reports forbidden module references in comment- and string-stripped
/// source: direct paths (`std::fs`, `tokio::fs`) and brace imports
/// (`use std::{fs, ...}`).
fn findings(code: &str) -> Vec<String> {
    let mut found = Vec::new();
    for module in ["std", "tokio"] {
        let direct = [module, "::", "fs"].concat();
        if code.contains(&direct) {
            found.push(direct.clone());
        }
        let brace_prefix = [module, "::{"].concat();
        let mut rest = code;
        while let Some(start) = rest.find(&brace_prefix) {
            let inner = &rest[start + brace_prefix.len()..];
            let end = inner.find('}').unwrap_or(inner.len());
            for item in inner[..end].split(',') {
                let item = item.trim();
                if item == "fs" || item.starts_with("fs::") || item.starts_with("fs ") {
                    found.push(format!("{brace_prefix}... fs ...}}"));
                }
            }
            rest = &inner[end.min(inner.len())..];
        }
    }
    found
}

/// Removes comments (line and nested block) and string literals (regular,
/// raw and byte) so occurrences inside documentation and message text do not
/// count as call sites.
fn strip_comments_and_strings(source: &str) -> String {
    let bytes: Vec<char> = source.chars().collect();
    let mut out = String::with_capacity(source.len());
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        let next = bytes.get(i + 1).copied();
        // Line comment.
        if c == '/' && next == Some('/') {
            while i < bytes.len() && bytes[i] != '\n' {
                i += 1;
            }
            continue;
        }
        // Nested block comment.
        if c == '/' && next == Some('*') {
            let mut depth = 1;
            i += 2;
            while i < bytes.len() && depth > 0 {
                if bytes[i] == '/' && bytes.get(i + 1) == Some(&'*') {
                    depth += 1;
                    i += 2;
                } else if bytes[i] == '*' && bytes.get(i + 1) == Some(&'/') {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        // Raw string literal: r"..." / r#"..."# (with optional b prefix),
        // only when `r` is not part of a longer identifier.
        if (c == 'r' || (c == 'b' && next == Some('r'))) && !prev_is_identifier(&bytes, i) {
            let hash_start = if c == 'b' { i + 2 } else { i + 1 };
            let mut hashes = 0;
            while bytes.get(hash_start + hashes) == Some(&'#') {
                hashes += 1;
            }
            if bytes.get(hash_start + hashes) == Some(&'"') {
                let mut j = hash_start + hashes + 1;
                let closer: String = std::iter::once('"')
                    .chain(std::iter::repeat_n('#', hashes))
                    .collect();
                let rest: String = bytes[j..].iter().collect();
                j += rest.find(&closer).map_or(rest.len(), |p| p + closer.len());
                out.push(' ');
                i = j;
                continue;
            }
        }
        // Regular or byte string literal.
        if c == '"' {
            i += 1;
            while i < bytes.len() {
                if bytes[i] == '\\' {
                    i += 2;
                } else if bytes[i] == '"' {
                    i += 1;
                    break;
                } else {
                    i += 1;
                }
            }
            out.push(' ');
            continue;
        }
        // Character literal (kept distinct from lifetimes): 'x' or '\x'.
        if c == '\'' {
            if next == Some('\\') {
                let mut j = i + 2;
                while j < bytes.len() && bytes[j] != '\'' {
                    j += 1;
                }
                i = j + 1;
                out.push(' ');
                continue;
            }
            if bytes.get(i + 2) == Some(&'\'') {
                i += 3;
                out.push(' ');
                continue;
            }
            // A lifetime; keep scanning normally.
        }
        out.push(c);
        i += 1;
    }
    out
}

fn prev_is_identifier(bytes: &[char], i: usize) -> bool {
    i > 0
        && bytes
            .get(i - 1)
            .is_some_and(|c| c.is_alphanumeric() || *c == '_')
}

#[test]
fn guard_detects_a_forbidden_call_site() {
    // Mutation companion: the guard must actually flag real call sites and
    // must ignore comments and strings.
    let hit = ["let x = std", "::fs::read(path);"].concat();
    assert!(!findings(&strip_comments_and_strings(&hit)).is_empty());

    let brace_import = ["use std", "::{fs, io};"].concat();
    assert!(!findings(&strip_comments_and_strings(&brace_import)).is_empty());

    let tokio_hit = ["tokio", "::fs::read(path).await"].concat();
    assert!(!findings(&strip_comments_and_strings(&tokio_hit)).is_empty());

    let comment = ["// this mentions std", "::fs in prose\nlet x = 1;"].concat();
    assert!(findings(&strip_comments_and_strings(&comment)).is_empty());

    let string = ["let s = \"std", "::fs\";"].concat();
    assert!(findings(&strip_comments_and_strings(&string)).is_empty());

    let raw_string = ["let s = r#\"std", "::fs\"#;"].concat();
    assert!(findings(&strip_comments_and_strings(&raw_string)).is_empty());

    let clean = ["use std", "::path::PathBuf;"].concat();
    assert!(findings(&strip_comments_and_strings(&clean)).is_empty());
}
