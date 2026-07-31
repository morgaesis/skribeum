//! Notion Markdown and CSV export conversion.

mod io;

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt;
use std::path::{Component, Path, PathBuf};

use csv::StringRecord;
use percent_encoding::percent_decode_str;
use pulldown_cmark::{Event, Options, Parser, Tag};
use skribeum_core::{ByteRangeReplace, apply_change_set};
use unicode_normalization::UnicodeNormalization;

const MARKDOWN_EXTENSION: &str = "md";
const CSV_EXTENSION: &str = "csv";
type PathMap = BTreeMap<PathBuf, PathBuf>;

/// Options for one Notion export import.
#[derive(Debug, Clone)]
pub struct ImportOptions {
    /// Notion export archive.
    pub archive: PathBuf,
    /// Output vault directory.
    pub out: PathBuf,
    /// Plan without writing.
    pub dry_run: bool,
    /// Permit overwriting planned files in an existing output directory.
    pub force: bool,
}

/// Counts reported after planning or importing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImportReport {
    /// Number of files in the output plan.
    pub file_count: usize,
    /// Number of names disambiguated with a numeric suffix.
    pub collision_count: usize,
    /// Number of Markdown links rewritten.
    pub link_rewrite_count: usize,
    /// Whether no output was written.
    pub dry_run: bool,
}

impl fmt::Display for ImportReport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let label = if self.dry_run { "Plan" } else { "Imported" };
        write!(
            formatter,
            "{label}: {} {}, {} {}, {} {}",
            self.file_count,
            plural(self.file_count, "file", "files"),
            self.collision_count,
            plural(self.collision_count, "collision", "collisions"),
            self.link_rewrite_count,
            plural(self.link_rewrite_count, "link rewrite", "link rewrites")
        )
    }
}

fn plural<'a>(count: usize, singular: &'a str, plural: &'a str) -> &'a str {
    if count == 1 { singular } else { plural }
}

/// Import failure.
#[derive(Debug, thiserror::Error)]
pub enum ImportError {
    /// Filesystem operation failed.
    #[error("filesystem operation failed for '{}': {source}", path.display())]
    Io {
        /// Affected path.
        path: PathBuf,
        /// Underlying error.
        source: std::io::Error,
    },
    /// ZIP archive failed to parse or read.
    #[error("invalid ZIP archive: {0}")]
    Zip(#[from] zip::result::ZipError),
    /// CSV database failed to parse.
    #[error("invalid CSV database '{}': {source}", path.display())]
    Csv {
        /// Source path in the archive.
        path: PathBuf,
        /// Underlying error.
        source: csv::Error,
    },
    /// A text export file is not UTF-8.
    #[error("export text is not UTF-8: '{}'", path.display())]
    NonUtf8 {
        /// Source path in the archive.
        path: PathBuf,
    },
    /// An archive entry escapes the archive root.
    #[error("archive entry has an unsafe path: '{0}'")]
    UnsafeArchivePath(String),
    /// Two ZIP entries have the same source path.
    #[error("archive contains a duplicate path: '{}'", .0.display())]
    DuplicateArchivePath(PathBuf),
    /// Archive does not contain supported Notion export content.
    #[error("archive contains no Notion Markdown or CSV content")]
    NoSupportedContent,
    /// Output already exists and force was not supplied.
    #[error("output directory already exists: '{}'; pass --force to overwrite planned files", .0.display())]
    OutputExists(PathBuf),
    /// Output path exists but is not a directory.
    #[error("output path is not a directory: '{}'", .0.display())]
    OutputNotDirectory(PathBuf),
    /// A source path lacks a final component.
    #[error("archive entry has no file name: '{}'", .0.display())]
    MissingFileName(PathBuf),
    /// A path cannot be represented as UTF-8.
    #[error("archive path is not valid UTF-8: '{}'", .0.display())]
    NonUtf8Path(PathBuf),
    /// Pure byte-range rewriting failed.
    #[error("Markdown rewrite ranges are invalid: {0}")]
    ChangeSet(#[from] skribeum_core::ChangeSetError),
}

#[derive(Debug)]
pub(crate) struct RawArchiveEntry {
    archive_name: String,
    path: PathBuf,
    bytes: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct PlannedFile {
    path: PathBuf,
    content: PlannedContent,
}

#[derive(Debug)]
pub(crate) enum PlannedContent {
    Bytes(Vec<u8>),
    ArchiveEntry(String),
}

#[derive(Debug)]
struct ImportPlan {
    files: Vec<PlannedFile>,
    report: ImportReport,
}

#[derive(Debug)]
struct SourceFile {
    archive_name: String,
    path: PathBuf,
    bytes: Vec<u8>,
    kind: SourceKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceKind {
    Markdown,
    Csv,
    Attachment,
}

#[derive(Debug, Default)]
struct NameAllocator {
    used: HashMap<PathBuf, BTreeSet<String>>,
    collisions: usize,
}

impl NameAllocator {
    fn allocate(&mut self, parent: &Path, desired: &str) -> String {
        let names = self.used.entry(parent.to_owned()).or_default();
        let key = collision_key(desired);
        if names.insert(key) {
            return desired.to_owned();
        }

        self.collisions += 1;
        let path = Path::new(desired);
        let stem = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or(desired);
        let extension = path.extension().and_then(|value| value.to_str());
        for number in 2usize.. {
            let candidate = match extension {
                Some(extension) => format!("{stem} ({number}).{extension}"),
                None => format!("{stem} ({number})"),
            };
            if names.insert(collision_key(&candidate)) {
                return candidate;
            }
        }
        unreachable!("the numeric collision suffix space is unbounded")
    }
}

/// Converts a Notion Markdown and CSV export archive into a vault.
///
/// # Errors
///
/// Returns an error for an invalid archive, malformed source content, unsafe
/// paths, or an existing output directory without `force`.
pub fn import_notion(options: &ImportOptions) -> Result<ImportReport, ImportError> {
    match io::output_is_directory(&options.out)? {
        Some(false) => return Err(ImportError::OutputNotDirectory(options.out.clone())),
        Some(true) if !options.force => return Err(ImportError::OutputExists(options.out.clone())),
        _ => {}
    }

    let mut plan = build_plan(&options.archive)?;
    plan.report.dry_run = options.dry_run;
    if !options.dry_run {
        io::write_plan(&options.archive, &options.out, &plan.files)?;
    }
    Ok(plan.report)
}

fn build_plan(archive_path: &Path) -> Result<ImportPlan, ImportError> {
    let sources = load_sources(archive_path)?;
    let source_directories = source_directories(&sources);
    let mut allocator = NameAllocator::default();
    let directory_map = allocate_directories(&source_directories, &mut allocator)?;
    let databases = database_directories(
        &sources,
        &source_directories,
        &directory_map,
        &mut allocator,
    )?;
    let (source_to_output, csv_to_index) =
        allocate_files(&sources, &databases, &directory_map, &mut allocator)?;
    let (rewritten_markdown, link_rewrite_count) =
        rewrite_all_markdown(&sources, &source_to_output)?;
    let mut files = assemble_files(
        &sources,
        &databases,
        &source_to_output,
        &csv_to_index,
        rewritten_markdown,
        &mut allocator,
    )?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let report = ImportReport {
        file_count: files.len(),
        collision_count: allocator.collisions,
        link_rewrite_count,
        dry_run: false,
    };
    Ok(ImportPlan { files, report })
}

fn load_sources(archive_path: &Path) -> Result<Vec<SourceFile>, ImportError> {
    let raw_entries = io::read_archive(archive_path)?;
    let mut seen = HashSet::new();
    let mut sources = Vec::new();
    for raw in raw_entries {
        if !seen.insert(raw.path.clone()) {
            return Err(ImportError::DuplicateArchivePath(raw.path));
        }
        if is_sitemap(&raw.path) {
            continue;
        }
        let kind = source_kind(&raw.path);
        if matches!(kind, SourceKind::Markdown | SourceKind::Csv)
            && std::str::from_utf8(&raw.bytes).is_err()
        {
            return Err(ImportError::NonUtf8 { path: raw.path });
        }
        sources.push(SourceFile {
            archive_name: raw.archive_name,
            path: raw.path,
            bytes: raw.bytes,
            kind,
        });
    }
    sources.sort_by(|left, right| left.path.cmp(&right.path));
    if !sources
        .iter()
        .any(|source| matches!(source.kind, SourceKind::Markdown | SourceKind::Csv))
    {
        return Err(ImportError::NoSupportedContent);
    }
    Ok(sources)
}

fn allocate_files(
    sources: &[SourceFile],
    databases: &[Database],
    directory_map: &PathMap,
    allocator: &mut NameAllocator,
) -> Result<(PathMap, PathMap), ImportError> {
    let mut source_to_output = BTreeMap::new();
    let mut csv_to_index = BTreeMap::new();
    for database in databases {
        let index_name = allocator.allocate(
            &database.output_directory,
            &format!("{}.md", database.clean_name),
        );
        let index_path = database.output_directory.join(index_name);
        source_to_output.insert(database.csv_path.clone(), index_path.clone());
        csv_to_index.insert(database.csv_path.clone(), index_path);
    }

    for source in sources {
        if source.kind == SourceKind::Csv {
            continue;
        }
        let source_parent = source.path.parent().unwrap_or_else(|| Path::new(""));
        let output_parent = directory_map
            .get(source_parent)
            .cloned()
            .unwrap_or_default();
        let file_name = source
            .path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| ImportError::MissingFileName(source.path.clone()))?;
        let clean_name = clean_component(file_name);
        let output_name = allocator.allocate(&output_parent, &clean_name);
        source_to_output.insert(source.path.clone(), output_parent.join(output_name));
    }
    Ok((source_to_output, csv_to_index))
}

fn rewrite_all_markdown(
    sources: &[SourceFile],
    source_to_output: &PathMap,
) -> Result<(BTreeMap<PathBuf, Vec<u8>>, usize), ImportError> {
    let id_map = build_id_map(sources, source_to_output);
    let mut rewritten_markdown = BTreeMap::new();
    let mut link_rewrite_count = 0usize;
    for source in sources
        .iter()
        .filter(|source| source.kind == SourceKind::Markdown)
    {
        let text = std::str::from_utf8(&source.bytes).map_err(|_| ImportError::NonUtf8 {
            path: source.path.clone(),
        })?;
        let promoted = promote_page_times(text);
        let (rewritten, count) = rewrite_markdown(
            promoted.as_bytes(),
            &source.path,
            source_to_output
                .get(&source.path)
                .expect("every Markdown source has an output path"),
            source_to_output,
            &id_map,
        )?;
        link_rewrite_count += count;
        rewritten_markdown.insert(source.path.clone(), rewritten);
    }
    Ok((rewritten_markdown, link_rewrite_count))
}

fn assemble_files(
    sources: &[SourceFile],
    databases: &[Database],
    source_to_output: &PathMap,
    csv_to_index: &PathMap,
    mut rewritten_markdown: BTreeMap<PathBuf, Vec<u8>>,
    allocator: &mut NameAllocator,
) -> Result<Vec<PlannedFile>, ImportError> {
    let mut files = Vec::new();
    for source in sources
        .iter()
        .filter(|source| source.kind == SourceKind::Attachment)
    {
        files.push(PlannedFile {
            path: source_to_output
                .get(&source.path)
                .expect("every attachment has an output path")
                .clone(),
            content: PlannedContent::ArchiveEntry(source.archive_name.clone()),
        });
    }

    let mut consumed_markdown = HashSet::new();
    for database in databases {
        let csv = sources
            .iter()
            .find(|source| source.path == database.csv_path)
            .expect("database source remains available");
        let (mut database_files, consumed) = plan_database(
            csv,
            database,
            csv_to_index
                .get(&database.csv_path)
                .expect("database index is reserved"),
            sources,
            source_to_output,
            &rewritten_markdown,
            allocator,
        )?;
        consumed_markdown.extend(consumed);
        files.append(&mut database_files);
    }

    for source in sources
        .iter()
        .filter(|source| source.kind == SourceKind::Markdown)
    {
        if consumed_markdown.contains(&source.path) {
            continue;
        }
        files.push(PlannedFile {
            path: source_to_output
                .get(&source.path)
                .expect("every Markdown source has an output path")
                .clone(),
            content: PlannedContent::Bytes(
                rewritten_markdown
                    .remove(&source.path)
                    .expect("every Markdown source was rewritten"),
            ),
        });
    }
    Ok(files)
}

#[derive(Debug)]
struct Database {
    csv_path: PathBuf,
    source_directory: Option<PathBuf>,
    output_directory: PathBuf,
    clean_name: String,
}

fn database_directories(
    sources: &[SourceFile],
    source_directories: &BTreeSet<PathBuf>,
    directory_map: &PathMap,
    allocator: &mut NameAllocator,
) -> Result<Vec<Database>, ImportError> {
    let mut databases = Vec::new();
    for source in sources
        .iter()
        .filter(|source| source.kind == SourceKind::Csv)
    {
        let parent = source.path.parent().unwrap_or_else(|| Path::new(""));
        let output_parent = directory_map.get(parent).cloned().unwrap_or_default();
        let stem = source
            .path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or_else(|| ImportError::MissingFileName(source.path.clone()))?;
        let clean_name = strip_notion_id(stem).0.nfc().collect::<String>();
        let matching_source_directory = parent.join(stem);
        let (source_directory, output_directory) =
            if source_directories.contains(&matching_source_directory) {
                (
                    Some(matching_source_directory.clone()),
                    directory_map
                        .get(&matching_source_directory)
                        .expect("source directory was allocated")
                        .clone(),
                )
            } else {
                let allocated = allocator.allocate(&output_parent, &clean_name);
                (None, output_parent.join(allocated))
            };
        databases.push(Database {
            csv_path: source.path.clone(),
            source_directory,
            output_directory,
            clean_name,
        });
    }
    Ok(databases)
}

fn plan_database(
    csv_source: &SourceFile,
    database: &Database,
    index_path: &Path,
    sources: &[SourceFile],
    source_to_output: &PathMap,
    rewritten_markdown: &BTreeMap<PathBuf, Vec<u8>>,
    allocator: &mut NameAllocator,
) -> Result<(Vec<PlannedFile>, HashSet<PathBuf>), ImportError> {
    let mut reader = csv::ReaderBuilder::new()
        .flexible(true)
        .from_reader(csv_source.bytes.as_slice());
    let headers = reader
        .headers()
        .map_err(|source| ImportError::Csv {
            path: csv_source.path.clone(),
            source,
        })?
        .clone();
    let title_index = headers
        .iter()
        .position(|header| header.eq_ignore_ascii_case("name"))
        .or_else(|| {
            headers
                .iter()
                .position(|header| header.eq_ignore_ascii_case("title"))
        })
        .unwrap_or(0);

    let mut page_candidates: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    if let Some(source_directory) = &database.source_directory {
        for source in sources.iter().filter(|source| {
            source.kind == SourceKind::Markdown
                && source.path.parent() == Some(source_directory.as_path())
        }) {
            let stem = source
                .path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            page_candidates
                .entry(collision_key(strip_notion_id(stem).0))
                .or_default()
                .push(source.path.clone());
        }
    }

    let mut rows = Vec::new();
    let mut consumed = HashSet::new();
    for (row_number, record) in reader.records().enumerate() {
        let record = record.map_err(|source| ImportError::Csv {
            path: csv_source.path.clone(),
            source,
        })?;
        let title = record
            .get(title_index)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map_or_else(|| format!("Row {}", row_number + 1), ToOwned::to_owned);
        let candidate_key = collision_key(&title);
        let source_page = page_candidates
            .get_mut(&candidate_key)
            .and_then(|candidates| (!candidates.is_empty()).then(|| candidates.remove(0)));
        let output_path = if let Some(source_page) = &source_page {
            consumed.insert(source_page.clone());
            source_to_output
                .get(source_page)
                .expect("database page has an output path")
                .clone()
        } else {
            let desired = format!("{}.md", clean_component(&title));
            let name = allocator.allocate(&database.output_directory, &desired);
            database.output_directory.join(name)
        };
        let body = source_page
            .as_ref()
            .and_then(|path| rewritten_markdown.get(path).cloned())
            .unwrap_or_else(|| format!("# {title}\n").into_bytes());
        let content = render_row_note(&headers, &record, &body);
        rows.push((title, output_path, content));
    }

    let mut index = format!("# {}\n\n", database.clean_name);
    for (title, path, _) in &rows {
        index.push_str("- ");
        index.push_str(&wikilink(path, None, title));
        index.push('\n');
    }

    let mut files = vec![PlannedFile {
        path: index_path.to_owned(),
        content: PlannedContent::Bytes(index.into_bytes()),
    }];
    files.extend(rows.into_iter().map(|(_, path, content)| PlannedFile {
        path,
        content: PlannedContent::Bytes(content),
    }));
    Ok((files, consumed))
}

fn render_row_note(headers: &StringRecord, record: &StringRecord, body: &[u8]) -> Vec<u8> {
    let mut output = String::from("---\n");
    for (header, value) in headers.iter().zip(record.iter()) {
        let key = canonical_property_name(header);
        output.push_str(key);
        output.push_str(": ");
        output.push_str(&yaml_scalar(value));
        output.push('\n');
    }
    output.push_str("---\n\n");
    let mut bytes = output.into_bytes();
    bytes.extend_from_slice(body);
    bytes
}

fn canonical_property_name(header: &str) -> &str {
    if header.eq_ignore_ascii_case("created time") {
        "created"
    } else if header.eq_ignore_ascii_case("last edited time") {
        "edited"
    } else {
        header
    }
}

fn yaml_scalar(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.eq_ignore_ascii_case("true") {
        return "true".to_owned();
    }
    if trimmed.eq_ignore_ascii_case("false") {
        return "false".to_owned();
    }
    if is_plain_number(trimmed) || is_iso_date_or_datetime(trimmed) {
        return trimmed.to_owned();
    }
    format!("\"{}\"", escape_yaml_string(value))
}

fn is_plain_number(value: &str) -> bool {
    if value.is_empty() || (value.starts_with('0') && value.len() > 1 && !value.starts_with("0.")) {
        return false;
    }
    value.parse::<i64>().is_ok()
        || ((value.contains('.') || value.contains(['e', 'E'])) && value.parse::<f64>().is_ok())
}

fn is_iso_date_or_datetime(value: &str) -> bool {
    let bytes = value.as_bytes();
    let date = bytes.len() >= 10
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit);
    date && (bytes.len() == 10
        || bytes
            .get(10)
            .is_some_and(|separator| matches!(separator, b'T' | b' ')))
}

fn escape_yaml_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            other => escaped.push(other),
        }
    }
    escaped
}

fn rewrite_markdown(
    markdown: &[u8],
    source_path: &Path,
    output_path: &Path,
    source_to_output: &PathMap,
    id_map: &BTreeMap<String, PathBuf>,
) -> Result<(Vec<u8>, usize), ImportError> {
    let text = std::str::from_utf8(markdown).map_err(|_| ImportError::NonUtf8 {
        path: source_path.to_owned(),
    })?;
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    let mut changes = Vec::new();

    for (event, range) in Parser::new_ext(text, options).into_offset_iter() {
        let (destination, image) = match event {
            Event::Start(Tag::Link { dest_url, .. }) => (dest_url.into_string(), false),
            Event::Start(Tag::Image { dest_url, .. }) => (dest_url.into_string(), true),
            _ => continue,
        };
        let Some(replacement) = rewrite_link(
            &text[range.clone()],
            &destination,
            image,
            source_path,
            output_path,
            source_to_output,
            id_map,
        ) else {
            continue;
        };
        if replacement == text[range.clone()] {
            continue;
        }
        changes.push(ByteRangeReplace {
            start: range.start,
            end: range.end,
            bytes: replacement.into_bytes(),
        });
    }
    changes.sort_by_key(|change| change.start);
    let count = changes.len();
    Ok((apply_change_set(markdown, &changes)?, count))
}

fn rewrite_link(
    raw: &str,
    destination: &str,
    image: bool,
    source_path: &Path,
    output_path: &Path,
    source_to_output: &PathMap,
    id_map: &BTreeMap<String, PathBuf>,
) -> Option<String> {
    let (destination_without_fragment, fragment) = split_fragment(destination);
    let target = resolve_destination(
        destination_without_fragment,
        source_path,
        source_to_output,
        id_map,
    )?;
    let label = markdown_link_label(raw, image);
    if target
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(MARKDOWN_EXTENSION))
    {
        let link = wikilink(&target, fragment, label);
        return Some(if image { format!("!{link}") } else { link });
    }

    let output_parent = output_path.parent().unwrap_or_else(|| Path::new(""));
    let relative = relative_path(output_parent, &target);
    let encoded = encode_markdown_path(&path_to_slashes(&relative));
    Some(replace_inline_destination(raw, &encoded))
}

fn resolve_destination(
    destination: &str,
    source_path: &Path,
    source_to_output: &PathMap,
    id_map: &BTreeMap<String, PathBuf>,
) -> Option<PathBuf> {
    if destination.is_empty() || destination.starts_with('#') {
        return None;
    }
    if destination.starts_with("https://www.notion.so/")
        || destination.starts_with("https://notion.so/")
        || destination.contains(".notion.site/")
    {
        return notion_id_in(destination).and_then(|id| id_map.get(&id).cloned());
    }
    if destination.contains("://") || destination.starts_with("mailto:") {
        return None;
    }
    let decoded = percent_decode_str(destination).decode_utf8().ok()?;
    let path_part = decoded.split('?').next().unwrap_or(decoded.as_ref());
    let parent = source_path.parent().unwrap_or_else(|| Path::new(""));
    let resolved = normalize_relative_path(&parent.join(path_part))?;
    source_to_output.get(&resolved).cloned()
}

fn split_fragment(destination: &str) -> (&str, Option<&str>) {
    destination
        .split_once('#')
        .map_or((destination, None), |(path, fragment)| {
            (path, Some(fragment))
        })
}

fn markdown_link_label(raw: &str, image: bool) -> &str {
    let start = usize::from(image) + 1;
    raw.find("](")
        .and_then(|end| raw.get(start..end))
        .unwrap_or_default()
}

fn replace_inline_destination(raw: &str, destination: &str) -> String {
    let Some(start) = raw.find("](").map(|position| position + 2) else {
        return raw.to_owned();
    };
    let Some(end) = raw.rfind(')') else {
        return raw.to_owned();
    };
    format!("{}{}{}", &raw[..start], destination, &raw[end..])
}

fn wikilink(path: &Path, fragment: Option<&str>, label: &str) -> String {
    let without_extension = path.with_extension("");
    let mut target = path_to_slashes(&without_extension);
    if let Some(fragment) = fragment.filter(|value| !value.is_empty()) {
        target.push('#');
        target.push_str(fragment);
    }
    let display_name = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if label.is_empty() || label == display_name {
        format!("[[{target}]]")
    } else {
        format!("[[{target}|{label}]]")
    }
}

fn relative_path(from: &Path, to: &Path) -> PathBuf {
    let from_components: Vec<_> = from.components().collect();
    let to_components: Vec<_> = to.components().collect();
    let common = from_components
        .iter()
        .zip(&to_components)
        .take_while(|(left, right)| left == right)
        .count();
    let mut result = PathBuf::new();
    for _ in common..from_components.len() {
        result.push("..");
    }
    for component in &to_components[common..] {
        result.push(component.as_os_str());
    }
    result
}

fn encode_markdown_path(path: &str) -> String {
    let mut encoded = String::with_capacity(path.len());
    for character in path.chars() {
        match character {
            ' ' => encoded.push_str("%20"),
            '%' => encoded.push_str("%25"),
            '#' => encoded.push_str("%23"),
            '(' => encoded.push_str("%28"),
            ')' => encoded.push_str("%29"),
            other => encoded.push(other),
        }
    }
    encoded
}

fn promote_page_times(markdown: &str) -> String {
    let mut created = None;
    let mut edited = None;
    let mut output_lines = Vec::new();
    for (index, line) in markdown.split_inclusive('\n').enumerate() {
        let logical = line.trim_end_matches(['\r', '\n']);
        let promoted = if index < 20 {
            split_property(logical, "Created time")
                .map(|value| created = Some(value.to_owned()))
                .or_else(|| {
                    split_property(logical, "Last edited time")
                        .map(|value| edited = Some(value.to_owned()))
                })
                .is_some()
        } else {
            false
        };
        if !promoted {
            output_lines.push(line);
        }
    }
    if created.is_none() && edited.is_none() {
        return markdown.to_owned();
    }
    let mut output = String::from("---\n");
    if let Some(created) = created {
        output.push_str("created: ");
        output.push_str(&yaml_scalar(&created));
        output.push('\n');
    }
    if let Some(edited) = edited {
        output.push_str("edited: ");
        output.push_str(&yaml_scalar(&edited));
        output.push('\n');
    }
    output.push_str("---\n\n");
    for line in output_lines {
        output.push_str(line);
    }
    output
}

fn split_property<'a>(line: &'a str, property: &str) -> Option<&'a str> {
    let (key, value) = line.split_once(':')?;
    key.trim()
        .eq_ignore_ascii_case(property)
        .then(|| value.trim())
}

fn source_directories(sources: &[SourceFile]) -> BTreeSet<PathBuf> {
    let mut directories = BTreeSet::new();
    directories.insert(PathBuf::new());
    for source in sources {
        let mut current = source.path.parent();
        while let Some(directory) = current {
            directories.insert(directory.to_owned());
            current = directory.parent();
        }
    }
    directories
}

fn allocate_directories(
    source_directories: &BTreeSet<PathBuf>,
    allocator: &mut NameAllocator,
) -> Result<PathMap, ImportError> {
    let mut directories: Vec<_> = source_directories.iter().cloned().collect();
    directories.sort_by(|left, right| {
        left.components()
            .count()
            .cmp(&right.components().count())
            .then_with(|| left.cmp(right))
    });
    let mut mapping = BTreeMap::from([(PathBuf::new(), PathBuf::new())]);
    for source in directories
        .into_iter()
        .filter(|path| !path.as_os_str().is_empty())
    {
        let parent = source.parent().unwrap_or_else(|| Path::new(""));
        let output_parent = mapping.get(parent).cloned().unwrap_or_default();
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| ImportError::NonUtf8Path(source.clone()))?;
        let clean = clean_component(name);
        let allocated = allocator.allocate(&output_parent, &clean);
        mapping.insert(source, output_parent.join(allocated));
    }
    Ok(mapping)
}

fn build_id_map(sources: &[SourceFile], source_to_output: &PathMap) -> BTreeMap<String, PathBuf> {
    let mut ids = BTreeMap::new();
    for source in sources
        .iter()
        .filter(|source| matches!(source.kind, SourceKind::Markdown | SourceKind::Csv))
    {
        let Some(stem) = source.path.file_stem().and_then(|value| value.to_str()) else {
            continue;
        };
        let (_, Some(id)) = strip_notion_id(stem) else {
            continue;
        };
        if let Some(output) = source_to_output.get(&source.path) {
            ids.insert(id.to_ascii_lowercase(), output.clone());
        }
    }
    ids
}

fn notion_id_in(value: &str) -> Option<String> {
    let compact: String = value
        .chars()
        .filter(|character| *character != '-')
        .collect();
    compact
        .as_bytes()
        .windows(32)
        .find(|window| window.iter().all(u8::is_ascii_hexdigit))
        .map(|window| String::from_utf8_lossy(window).to_ascii_lowercase())
}

fn source_kind(path: &Path) -> SourceKind {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some(MARKDOWN_EXTENSION) => SourceKind::Markdown,
        Some(CSV_EXTENSION) => SourceKind::Csv,
        _ => SourceKind::Attachment,
    }
}

fn is_sitemap(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("index.html"))
}

fn clean_component(component: &str) -> String {
    let path = Path::new(component);
    let stem = path.file_stem().and_then(|value| value.to_str());
    let extension = path.extension().and_then(|value| value.to_str());
    match (stem, extension) {
        (Some(stem), Some(extension)) => format!("{}.{}", strip_notion_id(stem).0, extension)
            .nfc()
            .collect(),
        _ => strip_notion_id(component).0.nfc().collect(),
    }
}

fn strip_notion_id(value: &str) -> (&str, Option<String>) {
    let Some((prefix, candidate)) = value.rsplit_once(' ') else {
        return (value, None);
    };
    if candidate.len() == 32 && candidate.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        (prefix, Some(candidate.to_ascii_lowercase()))
    } else {
        (value, None)
    }
}

fn collision_key(value: &str) -> String {
    value.nfc().flat_map(char::to_lowercase).collect()
}

fn normalize_relative_path(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !normalized.pop() {
                    return None;
                }
            }
            Component::Normal(value) => normalized.push(value),
            Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    Some(normalized)
}

fn path_to_slashes(path: &Path) -> String {
    path.components()
        .filter_map(|component| match component {
            Component::Normal(value) => value.to_str(),
            Component::ParentDir => Some(".."),
            Component::CurDir => Some("."),
            Component::RootDir | Component::Prefix(_) => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notion_suffix_requires_a_space_and_exact_hex_length() {
        assert_eq!(
            strip_notion_id("Page 0123456789abcdef0123456789abcdef").0,
            "Page"
        );
        assert_eq!(
            strip_notion_id("Page0123456789abcdef0123456789abcdef").0,
            "Page0123456789abcdef0123456789abcdef"
        );
        assert_eq!(strip_notion_id("Page 1234").0, "Page 1234");
    }

    #[test]
    fn typed_yaml_scalars_are_conservative() {
        assert_eq!(yaml_scalar("true"), "true");
        assert_eq!(yaml_scalar("FALSE"), "false");
        assert_eq!(yaml_scalar("42"), "42");
        assert_eq!(yaml_scalar("2026-01-31"), "2026-01-31");
        assert_eq!(yaml_scalar("0042"), "\"0042\"");
        assert_eq!(yaml_scalar("In progress"), "\"In progress\"");
    }
}
