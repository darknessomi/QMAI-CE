use super::{sag2_v10::Corpus, text, Candidate};
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_yaml::Value;
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio_util::sync::CancellationToken;

const MAX_SOURCE_BYTES: u64 = 32 * 1024 * 1024;
const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS documents(path TEXT PRIMARY KEY, hash BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY, path TEXT NOT NULL, title TEXT NOT NULL, heading TEXT NOT NULL,
        content TEXT NOT NULL, first INTEGER NOT NULL, last INTEGER NOT NULL, tokens INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS span_ranges(id INTEGER PRIMARY KEY, bytes TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS chunks_by_path ON chunks(path);
    CREATE VIRTUAL TABLE IF NOT EXISTS evidence USING fts5(title,heading,body,content='',contentless_delete=1);
    CREATE TEMP TABLE allowed(path TEXT PRIMARY KEY, input TEXT NOT NULL, hash BLOB NOT NULL);
    CREATE TEMP VIEW visible AS SELECT c.*, a.input FROM chunks c JOIN temp.allowed a ON a.path=c.path
        JOIN documents d ON d.path=a.path AND d.hash=a.hash;";

extern "C" {
    fn sag_register_rank(db: *mut rusqlite::ffi::sqlite3) -> std::os::raw::c_int;
}

pub(super) struct Source {
    path: PathBuf,
    requested_path: PathBuf,
    hash: [u8; 32],
}

impl Source {
    pub(super) fn for_dedup(project: &str, version: &super::SourceVersion) -> Result<Self> {
        ensure!(Path::new(project).is_absolute(), "项目路径必须是绝对路径");
        let root = Path::new(project)
            .canonicalize()
            .context("无法访问项目目录")?;
        let (requested_path, path) = document_paths(project, &root, &version.path, None)?;
        let kind = path.strip_prefix(&root)?.components().nth(1);
        ensure!(
            kind.is_some_and(|c| c.as_os_str() == "entities" || c.as_os_str() == "concepts"),
            "查重仅支持实体和概念页"
        );
        let text = read_source(&path)?;
        let hash = Sha256::digest(text.as_bytes());
        // WebView read_file strips a UTF-8 BOM. Keep the exact on-disk hash for subsequent checks.
        let decoded = text.strip_prefix('\u{feff}').unwrap_or(&text);
        ensure!(
            body(&text, None, "").is_some()
                && (format!("{hash:x}") == version.content_hash
                    || (decoded.len() != text.len()
                        && format!("{:x}", Sha256::digest(decoded.as_bytes()))
                            == version.content_hash)),
            "查重原文或禁读状态已变化，请重新扫描"
        );
        Ok(Self {
            requested_path,
            path,
            hash: hash.into(),
        })
    }

    pub(super) fn verify(&self) -> Result<()> {
        let actual = self
            .requested_path
            .canonicalize()
            .context("资料已删除，请重新检索")?;
        ensure!(
            actual == self.path
                && Sha256::digest(read_source(&actual)?.as_bytes()).as_slice() == self.hash,
            "资料或禁读状态已变化，请重新检索"
        );
        Ok(())
    }
}
pub(super) struct Store {
    db: Connection,
    sources: HashMap<String, Source>,
    writing: WritingScope,
    pub corpus: Corpus,
    documents: usize,
    average_tokens: f64,
    stats: RefCell<HashMap<String, Vec<u8>>>,
}

fn check_cancel(token: &CancellationToken) -> Result<()> {
    ensure!(!token.is_cancelled(), "检索已取消");
    Ok(())
}

fn read_source(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)
        .context("无法打开项目资料")?
        .take(MAX_SOURCE_BYTES + 1);
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).context("无法读取项目资料")?;
    ensure!(
        bytes.len() as u64 <= MAX_SOURCE_BYTES,
        "资料文件超过 32 MiB"
    );
    String::from_utf8(bytes).context("资料文件并非有效 UTF-8")
}

fn cache_path(root: &Path) -> Result<PathBuf> {
    let mut dir = root.to_path_buf();
    for part in [".qmai", "sag"] {
        dir.push(part);
        match fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(e).context("无法创建 SAG 索引目录"),
        }
        ensure!(
            dir.canonicalize()? == dir && dir.is_dir(),
            "索引目录不能使用符号链接"
        );
    }
    let db = dir.join("index-v10.sqlite");
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let file = dir.join(format!("index-v10.sqlite{suffix}"));
        if let Ok(info) = file.symlink_metadata() {
            ensure!(
                info.is_file() && !info.file_type().is_symlink(),
                "索引文件不能使用符号链接"
            );
        }
    }
    Ok(db)
}

fn body<'a>(
    source: &'a str,
    chapter: Option<u64>,
    name: &str,
) -> Option<(&'a str, usize, Option<u64>)> {
    body_if(source, chapter, name, |_| true)
}

fn body_if<'a>(
    source: &'a str,
    chapter: Option<u64>,
    name: &str,
    accept: impl FnOnce(&Value) -> bool,
) -> Option<(&'a str, usize, Option<u64>)> {
    let source = source.strip_prefix('\u{feff}').unwrap_or(source);
    let ordinary = chapter.is_none().then_some((source, 0, None));
    // The editor also accepts a short preamble (e.g. a legacy fenced YAML
    // header). Honour its exclusion flags before considering ordinary text.
    let mut lines = source.split_inclusive('\n').enumerate();
    let mut opening_end = 0;
    let mut opening_line = None;
    for (index, line) in lines.by_ref().take(6) {
        opening_end += line.len();
        if line.trim_end() == "---" {
            opening_line = Some(index);
            break;
        }
    }
    let Some(opening_line) = opening_line else {
        return ordinary;
    };
    let mut offset = opening_end;
    for (index, line) in lines {
        if line.trim_end() != "---" {
            offset += line.len();
            continue;
        }
        let yaml = &source[opening_end..offset];
        let fields: Value = match serde_yaml::from_str::<Value>(yaml) {
            Ok(value) if value.is_mapping() => value,
            _ if opening_line > 0 && !yaml.contains("ai_exclude") => return ordinary,
            _ => return None,
        };
        let field = |key: &str| match &fields[key] {
            Value::String(s) => s.to_owned(),
            Value::Bool(v) => v.to_string(),
            Value::Number(v) => v.to_string(),
            _ => String::new(),
        };
        if matches!(
            field("ai_exclude").trim().to_lowercase().as_str(),
            "1" | "true" | "y" | "yes" | "on"
        ) || fields["ai_exclude"].as_f64() == Some(1.0)
        {
            return None;
        }
        if !accept(&fields) {
            return None;
        }
        let mut chapter_number = None;
        if let Some(bound) = chapter {
            if field("chapter_status") != "final" {
                return None;
            }
            let numeric = field("chapter_number")
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite());
            if numeric.is_some_and(|n| n < 1. || n.fract() != 0. || n > 9_007_199_254_740_991.) {
                return None;
            }
            let metadata_number = numeric.map(|n| n as u64);
            static NUMBER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
                regex::Regex::new(r"(?i)^(?:第\s*(\d+)\s*章|chapter[-_ ]?(\d+))").unwrap()
            });
            let number = metadata_number.or_else(|| {
                NUMBER
                    .captures(name)?
                    .iter()
                    .skip(1)
                    .flatten()
                    .next()?
                    .as_str()
                    .parse()
                    .ok()
            })?;
            chapter_number = Some(number);
            if number == 0 || number >= bound {
                return None;
            }
        }
        return Some((&source[offset + line.len()..], index + 1, chapter_number));
    }
    if opening_line > 0 && !source[opening_end..].contains("ai_exclude") {
        ordinary
    } else {
        None
    }
}

fn purge(db: &Connection, key: &str) -> Result<()> {
    db.prepare_cached("DELETE FROM evidence WHERE rowid IN (SELECT id FROM chunks WHERE path=?)")?
        .execute([key])?;
    db.prepare_cached("DELETE FROM span_ranges WHERE id IN (SELECT id FROM chunks WHERE path=?)")?
        .execute([key])?;
    db.prepare_cached("DELETE FROM chunks WHERE path=?")?
        .execute([key])?;
    db.prepare_cached("DELETE FROM documents WHERE path=?")?
        .execute([key])?;
    Ok(())
}

fn document_paths(
    project: &str,
    root: &Path,
    input: &str,
    chapter: Option<u64>,
) -> Result<(PathBuf, PathBuf)> {
    let requested = Path::new(input);
    let relative = requested
        .strip_prefix(project)
        .or_else(|_| requested.strip_prefix(root))
        .context("资料路径超出项目")?;
    ensure!(
        relative
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_))),
        "检索路径不能包含父级目录"
    );
    let mut lexical = Path::new(project).join(relative);
    if let Ok(rest) = relative.strip_prefix("wiki") {
        let current = Path::new(project).join("QM").join(rest);
        if current.is_file() || !lexical.exists() {
            lexical = current;
        }
    }
    let path = lexical
        .canonicalize()
        .context("资料文件已移动或删除，请重新检索")?;
    let relative = path.strip_prefix(root).context("检索文件超出当前项目")?;
    let mut parts = relative.components();
    ensure!(
        matches!(
            parts.next().and_then(|v| v.as_os_str().to_str()),
            Some("QM" | "wiki")
        ),
        "检索仅支持本项目知识库"
    );
    if chapter.is_some() {
        ensure!(
            matches!(
                parts.next().and_then(|v| v.as_os_str().to_str()),
                Some("chapters" | "entities" | "concepts")
            ),
            "写作检索仅支持正文、实体和概念目录"
        );
    }
    ensure!(text::is_markdown(&path), "检索仅支持 Markdown 资料");
    // Reject aliases to other in-project files: the caller granted the exact document.
    let original_rel = lexical
        .strip_prefix(project)
        .or_else(|_| lexical.strip_prefix(root))
        .context("资料路径超出项目")?;
    ensure!(
        root.join(original_rel) == path,
        "检索文件不能使用符号链接或父级路径"
    );
    Ok((lexical, path))
}

// Collect readable chapters first, regardless of the order supplied by the WebView.
fn ordered_files(
    project: &str,
    root: &Path,
    mut files: Vec<String>,
    chapter: Option<u64>,
) -> Vec<String> {
    if chapter.is_some() {
        files.sort_by_key(|input| {
            let path = Path::new(input);
            let relative = path
                .strip_prefix(project)
                .or_else(|_| path.strip_prefix(root))
                .ok();
            !relative
                .is_some_and(|p| p.starts_with("QM/chapters") || p.starts_with("wiki/chapters"))
        });
    }
    files
}

#[derive(Default)]
struct WritingScope {
    chapters: HashMap<u64, String>,
    page_sources: HashMap<String, Vec<u64>>,
}

impl WritingScope {
    fn body<'a>(
        &mut self,
        source: &'a str,
        bound: Option<u64>,
        title: &str,
        relative: &Path,
        input: &str,
    ) -> Option<(&'a str, usize, Option<u64>)> {
        if bound.is_none()
            || relative.starts_with("QM/chapters")
            || relative.starts_with("wiki/chapters")
        {
            let result = body(source, bound, title)?;
            if let Some(n) = result.2 {
                self.chapters.insert(n, input.to_owned());
            }
            return Some(result);
        }
        if relative
            .components()
            .any(|part| part.as_os_str() == "history")
        {
            return None;
        }
        let mut numbers = Vec::new();
        let result = body_if(source, None, title, |fields| {
            let Some(refs) = page_chapters(fields) else {
                return false;
            };
            if !refs.iter().all(|n| self.chapters.contains_key(n)) {
                return false;
            }
            numbers = refs;
            true
        })?;
        // A plain Markdown page without provenance can serve project search, but
        // cannot establish what the writer could know at a given chapter.
        if numbers.is_empty() {
            return None;
        }
        self.page_sources.insert(input.to_owned(), numbers);
        Some(result)
    }
}

fn page_chapters(fields: &Value) -> Option<Vec<u64>> {
    if !matches!(&fields["source_type"], Value::Null)
        && fields["source_type"].as_str() != Some("chapter")
    {
        return None;
    }
    match &fields["is_historical"] {
        Value::Null | Value::Bool(false) => {}
        Value::String(s) if s.eq_ignore_ascii_case("false") => {}
        _ => return None,
    }
    let mut refs = Vec::new();
    for key in ["source_sequence", "chapter_number"] {
        if !fields[key].is_null() {
            refs.push(
                fields[key]
                    .as_u64()
                    .or_else(|| fields[key].as_str()?.parse().ok())?,
            );
        }
    }
    if !fields["snapshot_id"].is_null() {
        let id = fields["snapshot_id"].as_str()?.strip_prefix("chapter-")?;
        let number = id.split_once("-r").map_or(id, |(n, _)| n);
        refs.push(number.parse().ok()?);
    }
    if !fields["sources"].is_null() {
        for item in fields["sources"].as_sequence()? {
            refs.push(
                item.as_str()?
                    .strip_suffix(".snapshot.json")?
                    .parse()
                    .ok()?,
            );
        }
    }
    refs.sort_unstable();
    refs.dedup();
    Some(refs)
}

fn signature(sources: &HashMap<String, Source>) -> String {
    let mut entries: Vec<_> = sources.values().collect();
    entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    let mut digest = Sha256::new();
    for source in entries {
        let path = source.path.as_os_str().as_encoded_bytes();
        digest.update((path.len() as u64).to_be_bytes());
        digest.update(path);
        digest.update(source.hash);
    }
    format!("{:x}", digest.finalize())
}

#[derive(serde::Serialize)]
pub struct Fingerprint {
    pub fingerprint: String,
    pub chapters: Vec<ScopedChapter>,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopedChapter {
    pub path: String,
    pub chapter_number: u64,
}

pub(super) fn fingerprint(
    project: &str,
    files: Vec<String>,
    chapter: Option<u64>,
) -> Result<Fingerprint> {
    ensure!(Path::new(project).is_absolute(), "项目路径必须是绝对路径");
    let root = Path::new(project)
        .canonicalize()
        .context("无法访问项目目录")?;
    let mut chapters = Vec::new();
    let mut sources = HashMap::new();
    let mut seen = HashSet::new();
    let mut writing = WritingScope::default();
    for input in ordered_files(project, &root, files, chapter) {
        let (requested_path, path) = document_paths(project, &root, &input, chapter)?;
        if !seen.insert(path.clone()) {
            continue;
        }
        let content = read_source(&path)?;
        let title = path
            .file_stem()
            .and_then(|s| s.to_str())
            .context("文件名无效")?;
        if let Some((_, _, number)) =
            writing.body(&content, chapter, title, path.strip_prefix(&root)?, &input)
        {
            if let Some(chapter_number) = number {
                chapters.push(ScopedChapter {
                    path: input.clone(),
                    chapter_number,
                });
            }
            sources.insert(
                input,
                Source {
                    path,
                    requested_path,
                    hash: Sha256::digest(content.as_bytes()).into(),
                },
            );
        }
    }
    Ok(Fingerprint {
        fingerprint: signature(&sources),
        chapters,
    })
}

impl Store {
    pub(super) fn open(
        project: &str,
        files: Vec<String>,
        chapter: Option<u64>,
        cancel: &CancellationToken,
    ) -> Result<Self> {
        ensure!(Path::new(project).is_absolute(), "项目路径必须是绝对路径");
        let root = Path::new(project)
            .canonicalize()
            .context("无法访问项目目录")?;
        let mut db = Connection::open(cache_path(&root)?).context("无法打开 SAG 索引")?;
        db.busy_timeout(Duration::from_secs(10))?;
        // WAL permits another request to refresh the index while this request is awaiting Jev.
        db.pragma_update(None, "journal_mode", "wal")?;
        db.execute_batch(SCHEMA)?;
        // SAFETY: the native scorer only registers an FTS5 auxiliary function on a live connection.
        ensure!(
            unsafe { sag_register_rank(db.handle()) } == rusqlite::ffi::SQLITE_OK,
            "无法注册 SAG2 排序器"
        );
        let mut sources = HashMap::new();
        let mut seen = HashSet::new();
        let mut titles = vec![];
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        // Only remove files that actually disappeared. A request normally sees a subset.
        let indexed = tx
            .prepare("SELECT path FROM documents")?
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for key in indexed {
            check_cancel(cancel)?;
            if !root.join(&key).try_exists()? {
                purge(&tx, &key)?;
            }
        }
        let mut writing = WritingScope::default();
        for input in ordered_files(project, &root, files, chapter) {
            check_cancel(cancel)?;
            let (lexical, path) = document_paths(project, &root, &input, chapter)?;
            let relative = path.strip_prefix(&root)?;
            if !seen.insert(path.clone()) {
                continue;
            }
            let title = path
                .file_stem()
                .and_then(|s| s.to_str())
                .context("文件名无效")?
                .to_owned();
            let source = read_source(&path)?;
            let key = relative.to_str().context("文件路径编码无效")?;
            let Some((document_body, line_offset, _)) =
                writing.body(&source, chapter, &title, relative, &input)
            else {
                // A draft or future chapter can remain a valid general-search document.
                // A source now marked AI-excluded must be removed even from the persisted index.
                if chapter.is_none() || body(&source, None, &title).is_none() {
                    purge(&tx, key)?;
                }
                continue;
            };
            let hash: [u8; 32] = Sha256::digest(source.as_bytes()).into();
            let body_start = source.len() - document_body.len();
            let existing: Option<Vec<u8>> = tx
                .query_row("SELECT hash FROM documents WHERE path=?1 AND NOT EXISTS (SELECT 1 FROM chunks c LEFT JOIN span_ranges r ON r.id=c.id WHERE c.path=?1 AND r.id IS NULL)", [key], |row| {
                    row.get(0)
                })
                .optional()?;
            if existing.as_deref() != Some(hash.as_slice()) {
                purge(&tx, key)?;
                let title_terms = text::index_text(&title);
                let chunks = text::chunks_for_index(document_body, 512, &path, 64 << 20)?;
                let mut add = tx.prepare_cached("INSERT INTO chunks(path,title,heading,content,first,last,tokens) VALUES(?,?,?,?,?,?,?)")?;
                let mut index = tx.prepare_cached(
                    "INSERT INTO evidence(rowid,title,heading,body) VALUES(?,?,?,?)",
                )?;
                for chunk in chunks {
                    check_cancel(cancel)?;
                    let first = chunk.ranges.first().context("索引片段缺少位置")?.0 + line_offset;
                    let last = chunk.ranges.last().unwrap().1 + line_offset;
                    let heading_terms = text::index_text(&chunk.heading);
                    let body_terms = text::index_text(&chunk.content);
                    add.execute(params![
                        key,
                        title,
                        chunk.heading,
                        chunk.content,
                        first,
                        last,
                        0
                    ])?;
                    let id = tx.last_insert_rowid();
                    let ranges: Vec<_> = chunk
                        .spans
                        .iter()
                        .map(|s| (body_start + s.start_byte, body_start + s.end_byte))
                        .collect();
                    tx.prepare_cached("INSERT INTO span_ranges VALUES(?,?)")?
                        .execute(params![id, serde_json::to_string(&ranges)?])?;
                    index.execute(params![id, title_terms, heading_terms, body_terms])?;
                    tx.prepare_cached("UPDATE chunks SET tokens=(SELECT sag_token_count(evidence) FROM evidence WHERE rowid=?1) WHERE id=?1")?.execute([id])?;
                }
                tx.execute(
                    "INSERT OR REPLACE INTO documents VALUES(?,?)",
                    params![key, hash.as_slice()],
                )?;
            }
            // Both FTS ranking and expansion frequencies are scoped. An excluded file cannot
            // affect the judge's candidates, vocabulary, title repair or ranking statistics.
            tx.execute(
                "INSERT INTO temp.allowed VALUES(?,?,?)",
                params![key, input, hash.as_slice()],
            )?;
            titles.push(title);
            sources.insert(
                input,
                Source {
                    path,
                    requested_path: lexical,
                    hash,
                },
            );
        }
        check_cancel(cancel)?;
        tx.commit()?;
        db.execute_batch("BEGIN DEFERRED")?;
        let (documents, average_tokens) = db.query_row(
            "SELECT COUNT(*), COALESCE(AVG(tokens),0) FROM temp.visible",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        Ok(Self {
            db,
            sources,
            writing,
            corpus: Corpus::new(&titles)?,
            documents,
            average_tokens,
            stats: RefCell::new(HashMap::new()),
        })
    }

    pub(super) fn verify(
        &self,
        candidates: &[Candidate],
        cancel: &CancellationToken,
    ) -> Result<()> {
        let mut seen = HashSet::new();
        for c in candidates {
            check_cancel(cancel)?;
            if !seen.insert(&c.path) {
                continue;
            }
            let src = self
                .sources
                .get(&c.path)
                .context("片段超出请求的文件范围")?;
            src.verify()?;
            if let Some(numbers) = self.writing.page_sources.get(&c.path) {
                for n in numbers {
                    let path = &self.writing.chapters[n];
                    if seen.insert(path) {
                        check_cancel(cancel)?;
                        self.sources[path].verify()?;
                    }
                }
            }
        }
        check_cancel(cancel)
    }

    /// A scored passage can combine separate Markdown blocks. Emit verbatim source
    /// slices (including original whitespace), never a reconstructed quotation.
    pub(super) fn quotations(
        &self,
        ranked: Vec<Candidate>,
        limit: usize,
        cancel: &CancellationToken,
    ) -> Result<Vec<Candidate>> {
        let mut results = Vec::new();
        let mut seen = HashSet::new();
        let mut contents = HashMap::new();
        self.verify(&ranked, cancel)?;
        for hit in ranked {
            check_cancel(cancel)?;
            let source = self.sources.get(&hit.path).context("证据超出检索范围")?;
            if !contents.contains_key(&hit.path) {
                let actual = source.requested_path.canonicalize().context("资料已删除")?;
                ensure!(actual == source.path, "资料路径已变化，请重新检索");
                let original = read_source(&actual)?;
                ensure!(
                    Sha256::digest(original.as_bytes()).as_slice() == source.hash,
                    "资料已修改，请重新检索"
                );
                let lines = text::Lines::new(&original);
                contents.insert(hit.path.clone(), (original, lines));
            }
            let (original, lines) = &contents[&hit.path];
            let encoded: String =
                self.db
                    .query_row("SELECT bytes FROM span_ranges WHERE id=?", [hit.id], |r| {
                        r.get(0)
                    })?;
            let spans: Vec<(usize, usize)> = serde_json::from_str(&encoded)?;
            let mut contiguous: Vec<(usize, usize)> = vec![];
            for (start, end) in spans {
                ensure!(
                    original.get(start..end).is_some(),
                    "索引定位无效，请重建索引"
                );
                if let Some((_, last)) = contiguous.last_mut() {
                    if start <= *last || original[*last..start].trim().is_empty() {
                        *last = (*last).max(end);
                        continue;
                    }
                }
                contiguous.push((start, end));
            }
            for (start, end) in contiguous {
                if !seen.insert((hit.path.clone(), start, end)) {
                    continue;
                }
                let mut quote = hit.clone();
                let first = lines.spans.partition_point(|&(line, _)| line <= start);
                let last = lines.spans.partition_point(|&(line, _)| line < end);
                quote.start_line = first;
                quote.end_line = last.max(first);
                quote.content = original[start..end].to_owned();
                results.push(quote);
                if results.len() == limit {
                    return Ok(results);
                }
            }
        }
        Ok(results)
    }

    pub(super) fn fingerprint(&self) -> String {
        signature(&self.sources)
    }

    pub fn chunk_count(&self) -> Result<usize> {
        Ok(self.documents)
    }

    pub fn frequencies(&self, terms: &[String]) -> Result<HashMap<String, usize>> {
        let mut q = self.db.prepare_cached("SELECT COUNT(*) FROM evidence JOIN temp.visible v ON v.id=evidence.rowid WHERE evidence MATCH ?")?;
        terms
            .iter()
            .map(|t| {
                Ok((
                    t.clone(),
                    q.query_row([format!("body : {}", text::quote(t))], |r| r.get(0))?,
                ))
            })
            .collect()
    }

    fn statistics(&self, expression: &str) -> Result<Vec<u8>> {
        if let Some(stats) = self.stats.borrow().get(expression) {
            return Ok(stats.clone());
        }
        static PHRASES: std::sync::LazyLock<regex::Regex> =
            std::sync::LazyLock::new(|| regex::Regex::new(r#""(?:""|[^"])*""#).unwrap());
        let mut stats = self.average_tokens.to_ne_bytes().to_vec();
        let mut count = self.db.prepare_cached("SELECT COUNT(*) FROM evidence JOIN temp.visible v ON v.id=evidence.rowid WHERE evidence MATCH ?")?;
        for phrase in PHRASES.find_iter(expression) {
            let n: f64 = count.query_row([phrase.as_str()], |r| r.get(0))?;
            let idf = ((self.documents as f64 - n + 0.5) / (n + 0.5)).ln();
            stats.extend_from_slice(&(if idf > 0.0 { idf } else { 1e-6 }).to_ne_bytes());
        }
        self.stats
            .borrow_mut()
            .insert(expression.to_owned(), stats.clone());
        Ok(stats)
    }

    pub fn has_match(&self, term: &str, excluded: &[i64]) -> Result<bool> {
        Ok(self.db.query_row(
            "SELECT EXISTS(SELECT 1 FROM evidence JOIN temp.visible v ON v.id=evidence.rowid
            WHERE evidence MATCH ? AND v.id NOT IN (SELECT value FROM json_each(?)))",
            params![term, serde_json::to_string(excluded)?],
            |r| r.get(0),
        )?)
    }

    pub fn candidates(
        &self,
        expression: &str,
        required: Option<&String>,
        excluded: &[i64],
        limit: usize,
    ) -> Result<Vec<Candidate>> {
        let sql = "SELECT v.id,v.input,v.title,v.heading,v.content,v.first,v.last
            FROM evidence JOIN temp.visible v ON v.id=evidence.rowid
            WHERE evidence MATCH ?1 AND v.id NOT IN (SELECT value FROM json_each(?2))
            ORDER BY sag_bm25(evidence,?3,2,2,1),v.id LIMIT ?4";
        let mut q = self.db.prepare_cached(sql)?;
        let ids = serde_json::to_string(excluded)?;
        let stats = self.statistics(expression)?;
        let query = required.map_or_else(
            || expression.to_owned(),
            |term| format!("({expression}) AND ({term})"),
        );
        let mut result = vec![];
        let mut rows = q.query(params![query, ids, stats, limit])?;
        while let Some(row) = rows.next()? {
            result.push(Candidate {
                id: row.get(0)?,
                path: row.get(1)?,
                title: row.get(2)?,
                heading: row.get(3)?,
                content: row.get(4)?,
                start_line: row.get(5)?,
                end_line: row.get(6)?,
                order: result.len(),
                score: 0.,
                previous_score: None,
            });
        }
        Ok(result)
    }
}
