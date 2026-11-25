// Adapted from SAG-Wiki b6940ac834b3b1ec651c0b49dc1b0c45d4d74c4a (MIT, see LICENSE).
use indexmap::IndexMap;
use jieba_rs::Jieba;
use regex::Regex;
use std::{
    collections::HashSet,
    sync::{Arc, LazyLock, Mutex},
};
use unicode_normalization::UnicodeNormalization;

/// A resource rejection is a file issue, not permission to publish partial text.
#[derive(Debug)]
pub(crate) struct ResourceLimit(pub String);
impl std::fmt::Display for ResourceLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "索引文本超过资源上限：{}；原文件未修改，本次文件索引未写入",
            self.0
        )
    }
}
impl std::error::Error for ResourceLimit {}

pub(crate) const MAX_INDEX_LINE_BYTES: usize = 256 * 1024;
pub(crate) const MAX_INDEX_STRUCTURE_ITEMS: usize = 131_072;

fn charge(total: &mut usize, bytes: usize, limit: usize) -> Result<(), ResourceLimit> {
    *total = total
        .checked_add(bytes)
        .filter(|total| *total <= limit)
        .ok_or_else(|| ResourceLimit(format!("分块及元数据预算为 {} MiB", limit / 1024 / 1024)))?;
    Ok(())
}

static JIEBA: LazyLock<Jieba> = LazyLock::new(Jieba::new);
static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]").unwrap());
static STOPS: LazyLock<HashSet<&'static str>> = LazyLock::new(|| {
    "的 了 是 在 和 与 或 哪 什么 哪个 哪些 如何 怎么 为什么 是否 这 那 一个 一种 请 我 你 他 它 吗 呢 吧 地 得 the a an of in on at to for and or is are was were be by with from which what who how when where does do did that this it as".split_whitespace().collect()
});
const TOKEN_CACHE_MAX_BYTES: usize = 8 * 1024 * 1024;
const TOKEN_CACHE_MAX_INPUT_BYTES: usize = 8192;
#[derive(Default)]
struct TokenCache {
    entries: IndexMap<String, Vec<String>>,
    bytes: usize,
}
impl TokenCache {
    fn entry_bytes(source: &str, tokens: &[String]) -> usize {
        source.len() + std::mem::size_of_val(tokens) + tokens.iter().map(String::len).sum::<usize>()
    }
    fn insert(&mut self, source: &str, tokens: &[String]) {
        let bytes = Self::entry_bytes(source, tokens);
        if bytes > TOKEN_CACHE_MAX_BYTES {
            return;
        }
        if let Some(previous) = self.entries.swap_remove(source) {
            self.bytes -= Self::entry_bytes(source, &previous);
        }
        while self.bytes + bytes > TOKEN_CACHE_MAX_BYTES || self.entries.len() >= 8192 {
            let (source, tokens) = self.entries.swap_remove_index(0).unwrap();
            self.bytes -= Self::entry_bytes(&source, &tokens);
        }
        self.entries.insert(source.to_owned(), tokens.to_vec());
        self.bytes += bytes;
    }
}
static TOKEN_CACHE: LazyLock<Mutex<TokenCache>> =
    LazyLock::new(|| Mutex::new(TokenCache::default()));
pub fn tokenize(text: &str) -> Vec<String> {
    // Large source lines (for example embedded images) must not stay resident.
    if text.len() > TOKEN_CACHE_MAX_INPUT_BYTES {
        return tokenize_uncached(text);
    }
    {
        let mut cache = TOKEN_CACHE.lock().expect("token cache mutex poisoned");
        // Cache eviction order does not affect tokens; avoid shifting thousands of entries.
        if let Some(tokens) = cache.entries.swap_remove(text) {
            cache.entries.insert(text.to_owned(), tokens.clone());
            return tokens;
        }
    }
    let tokens = tokenize_uncached(text);
    let mut cache = TOKEN_CACHE.lock().expect("token cache mutex poisoned");
    cache.insert(text, &tokens);
    tokens
}
fn tokenize_uncached(text: &str) -> Vec<String> {
    let s = text.nfkc().collect::<String>().to_lowercase();
    JIEBA
        .cut_for_search(&s, true)
        .into_iter()
        .map(|token| token.word)
        .filter(|s| WORD.is_match(s) && !STOPS.contains(s))
        .map(str::to_owned)
        .collect()
}
pub fn index_text(text: &str) -> String {
    tokenize(text).join(" ")
}
pub fn quote(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}
pub fn search_terms(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    tokenize(text)
        .into_iter()
        .filter(|s| seen.insert(s.clone()))
        .take(80)
        .collect()
}
pub fn match_query(text: &str) -> String {
    search_terms(text)
        .iter()
        .map(|s| quote(s))
        .collect::<Vec<_>>()
        .join(" OR ")
}

pub fn is_markdown(path: &std::path::Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "md" | "markdown"))
}
pub(crate) fn indexable_ranges(source: &str, path: &std::path::Path) -> Vec<(usize, usize)> {
    if !path.extension().is_some_and(|extension| {
        ["html", "htm", "md", "markdown"]
            .iter()
            .any(|kind| extension.eq_ignore_ascii_case(kind))
    }) {
        return vec![(0, source.len())];
    }
    static RESOURCE_DATA: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
            r#"(?i)data:(?:image|font|audio|video|application)/[a-z0-9.+-]+(?:;[^;,\s"'<>]+)*,"#,
        )
        .unwrap()
    });
    static SVG_TAG: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?is)<(/?)svg\b[^>]*>").unwrap());
    let bytes = source.as_bytes();
    let mut excluded = vec![];
    // Keep descriptions and their original source offsets, but never index
    // image destinations (including opaque hashes and signed URL parameters).
    static IMAGE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"!\[((?:\\.|\[[^\]\n]*\]|[^\]\\])*)\]\((?:\\.|[^()\n]|\([^()\n]*\))*\)")
            .unwrap()
    });
    for image in IMAGE.captures_iter(source) {
        let whole = image.get(0).unwrap();
        let alt = image.get(1).unwrap();
        excluded.push((whole.start(), alt.start()));
        excluded.push((alt.end(), whole.end()));
    }
    static REFERENCE_IMAGE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"!\[([^\]\n]*)\](?:\[([^\]\n]*)\])?").unwrap());
    static DEFINITION: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?m)^ {0,3}\[([^\]\n]+)\]:[ \t]*(?:\r?\n[ \t]+)?[^\r\n]*").unwrap()
    });
    let normalize_label = |label: &str| {
        label
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    };
    let references: Vec<_> = REFERENCE_IMAGE
        .captures_iter(source)
        .filter_map(|image| {
            let whole = image.get(0).unwrap();
            if source[whole.end()..].starts_with('(') {
                return None;
            }
            let alt = image.get(1).unwrap();
            let label = image
                .get(2)
                .filter(|m| !m.as_str().is_empty())
                .unwrap_or(alt);
            excluded.push((whole.start(), alt.start()));
            excluded.push((alt.end(), whole.end()));
            Some(normalize_label(label.as_str()))
        })
        .collect();
    for definition in DEFINITION.captures_iter(source) {
        if references.contains(&normalize_label(&definition[1])) {
            let whole = definition.get(0).unwrap();
            excluded.push((whole.start(), whole.end()));
        }
    }
    static HTML_IMAGE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?is)<img\b(?:"[^"]*"|'[^']*'|[^'">])*>"#).unwrap());
    static ALT: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r#"(?is)\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#).unwrap()
    });
    for image in HTML_IMAGE.find_iter(source) {
        if let Some(alt) = ALT
            .captures(image.as_str())
            .and_then(|c| c.get(1).or_else(|| c.get(2)).or_else(|| c.get(3)))
        {
            excluded.push((image.start(), image.start() + alt.start()));
            excluded.push((image.start() + alt.end(), image.end()));
        } else {
            excluded.push((image.start(), image.end()));
        }
    }
    for resource in RESOURCE_DATA.find_iter(source) {
        let quoted = resource.start() > 0 && matches!(bytes[resource.start() - 1], b'\'' | b'"');
        let base64 = resource.as_str().to_ascii_lowercase().contains(";base64,");
        let mut end = resource.end();
        while end < bytes.len() {
            let byte = bytes[end];
            let allowed = if base64 {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'+' | b'/' | b'=')
                    || quoted && byte.is_ascii_whitespace()
            } else {
                !byte.is_ascii_whitespace() && !matches!(byte, b'\'' | b'"' | b'<' | b'>' | b')')
            };
            if !allowed {
                break;
            }
            end += 1;
        }
        excluded.push((resource.start(), end));
    }
    let (mut svg_depth, mut svg_start) = (0usize, 0usize);
    for tag in SVG_TAG.captures_iter(source) {
        let whole = tag.get(0).unwrap();
        if &tag[1] == "/" {
            if svg_depth > 0 {
                svg_depth -= 1;
                if svg_depth == 0 {
                    excluded.push((svg_start, whole.end()));
                }
            }
        } else if whole.as_str().ends_with("/>") {
            if svg_depth == 0 {
                excluded.push((whole.start(), whole.end()));
            }
        } else {
            if svg_depth == 0 {
                svg_start = whole.start();
            }
            svg_depth += 1;
        }
    }
    if svg_depth > 0 {
        excluded.push((svg_start, source.len()));
    }
    excluded.sort_unstable();
    let mut ranges = vec![];
    let mut cursor = 0;
    for (start, end) in excluded {
        if cursor < start {
            ranges.push((cursor, start));
        }
        cursor = cursor.max(end);
    }
    if cursor < source.len() {
        ranges.push((cursor, source.len()));
    }
    ranges
}

#[derive(Clone, Debug, PartialEq)]
pub struct Chunk {
    pub heading: String,
    pub content: String,
    pub ranges: Vec<(usize, usize)>,
    pub spans: Vec<super::SourceSpan>,
}
pub(crate) struct Lines {
    pub(crate) spans: Vec<(usize, usize)>,
    char_checkpoints: Vec<(usize, usize)>,
}
impl Lines {
    pub(crate) fn new(source: &str) -> Self {
        let bytes = source.as_bytes();
        let mut spans = vec![];
        let mut start = 0;
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i] == b'\r' || bytes[i] == b'\n' {
                spans.push((start, i));
                if bytes[i] == b'\r' && bytes.get(i + 1) == Some(&b'\n') {
                    i += 1;
                }
                start = i + 1;
            }
            i += 1;
        }
        spans.push((start, bytes.len()));
        let mut char_checkpoints = vec![(0, 0)];
        for (count, (byte, _)) in source.char_indices().enumerate() {
            if byte - char_checkpoints.last().unwrap().0 >= 4096 {
                char_checkpoints.push((byte, count));
            }
        }
        Self {
            spans,
            char_checkpoints,
        }
    }
    fn point(&self, source: &str, byte: usize) -> (usize, usize) {
        let line = self.spans.partition_point(|(start, _)| *start <= byte) - 1;
        let (start, end) = self.spans[line];
        let char_count = |byte| {
            let index = self
                .char_checkpoints
                .partition_point(|(offset, _)| *offset <= byte)
                - 1;
            let (offset, count) = self.char_checkpoints[index];
            count + source[offset..byte].chars().count()
        };
        (line + 1, char_count(byte.min(end)) - char_count(start) + 1)
    }
    pub(crate) fn span(&self, source: &str, start: usize, end: usize) -> super::SourceSpan {
        let (start_line, start_column) = self.point(source, start);
        let (end_line, end_column) = self.point(source, end);
        super::SourceSpan {
            start_byte: start,
            end_byte: end,
            start_line,
            start_column,
            end_line,
            end_column,
        }
    }
}
// Sentence/line boundaries retain exact source offsets, including closing quotes.
fn sentence_ranges(
    source: &str,
    start: usize,
    end: usize,
    code: bool,
) -> impl Iterator<Item = (usize, usize)> + '_ {
    let mut cursor = start;
    let mut chars = source[start..end].char_indices().peekable();
    std::iter::from_fn(move || {
        while let Some((offset, ch)) = chars.next() {
            let boundary = if code {
                ch == '\n'
            } else {
                "。！？!?".contains(ch)
                    || ch == '.'
                        && chars.peek().is_none_or(|(_, next)| {
                            next.is_whitespace() || "\"'”’）)]}".contains(*next)
                        })
            };
            if !boundary {
                continue;
            }
            let mut cut = start + offset + ch.len_utf8();
            if !code {
                while let Some(&(offset, ch)) = chars.peek() {
                    if !(ch.is_whitespace() || "。！？!?\"'”’）)]}".contains(ch)) {
                        break;
                    }
                    cut = start + offset + ch.len_utf8();
                    chars.next();
                }
            }
            let part = (cursor, cut);
            cursor = cut;
            return Some(part);
        }
        if cursor < end {
            let part = (cursor, end);
            cursor = end;
            Some(part)
        } else {
            None
        }
    })
}

// Exceptionally long sentences/tables are split at word boundaries when possible.
// Original byte ranges, Unicode columns and CRLF pairs remain intact.
fn split_oversized_range(
    source: &str,
    mut start: usize,
    end: usize,
    limit: usize,
) -> Vec<(usize, usize)> {
    let limit = limit.min(MAX_INDEX_LINE_BYTES / 4);
    let mut parts = vec![];
    while start < end {
        let mut length = 0;
        let mut whitespace = None;
        let mut cut = end;
        for (offset, ch) in source[start..end].char_indices() {
            if length + ch.len_utf16() > limit {
                cut = whitespace.unwrap_or(start + offset);
                if source.as_bytes()[cut - 1] == b'\r' && source.as_bytes().get(cut) == Some(&b'\n')
                {
                    cut -= 1;
                }
                break;
            }
            length += ch.len_utf16();
            if ch.is_whitespace() {
                whitespace = Some(start + offset + ch.len_utf8());
            }
        }
        parts.push((start, cut));
        start = cut;
    }
    parts
}

// 512 is a target; only resource-sized sentences/lines need the bounded fallback.
fn split_block(
    source: &str,
    start: usize,
    end: usize,
    limit: usize,
    code: bool,
    bounded: bool,
) -> Vec<(usize, usize)> {
    let mut parts = vec![];
    let mut cursor = start;
    let mut length = 0;
    let sentences = sentence_ranges(source, start, end, code).flat_map(|(s, e)| {
        if bounded && e - s > MAX_INDEX_LINE_BYTES {
            split_oversized_range(source, s, e, limit)
        } else {
            vec![(s, e)]
        }
    });
    for (s, e) in sentences {
        let size = source[s..e].encode_utf16().count();
        if length > 0 && length + size > limit {
            parts.push((cursor, s));
            cursor = s;
            length = 0;
        }
        length += size;
    }
    if cursor < end {
        parts.push((cursor, end));
    }
    parts
}
pub(crate) fn chunks_for_index(
    content: &str,
    max_chars: usize,
    path: &std::path::Path,
    byte_limit: usize,
) -> Result<Vec<Chunk>, ResourceLimit> {
    build_chunks(content, max_chars, path, Some(byte_limit))
}

fn build_chunks(
    content: &str,
    max_chars: usize,
    path: &std::path::Path,
    byte_limit: Option<usize>,
) -> Result<Vec<Chunk>, ResourceLimit> {
    let markdown = is_markdown(path);
    let code = false;
    assert!(max_chars >= 2);
    let ranges = indexable_ranges(content, path);
    if byte_limit.is_some() {
        if content
            .bytes()
            .enumerate()
            .filter(|&(i, byte)| {
                byte == b'\n' || byte == b'\r' && content.as_bytes().get(i + 1) != Some(&b'\n')
            })
            .count()
            > MAX_INDEX_STRUCTURE_ITEMS
        {
            return Err(ResourceLimit(format!(
                "换行数量不得超过 {MAX_INDEX_STRUCTURE_ITEMS}"
            )));
        }
        let mut boundaries = 0usize;
        for &(start, end) in &ranges {
            boundaries += sentence_ranges(content, start, end, code)
                .take(MAX_INDEX_STRUCTURE_ITEMS + 1)
                .count();
            if boundaries > MAX_INDEX_STRUCTURE_ITEMS {
                return Err(ResourceLimit(format!(
                    "句子/行边界数量不得超过 {MAX_INDEX_STRUCTURE_ITEMS}"
                )));
            }
        }
    }
    let lines = Lines::new(content);
    let heading_re = Regex::new(r"^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$").unwrap();
    let fence_re = Regex::new(r"^\s{0,3}(`{3,}|~{3,})").unwrap();
    let mut headings = vec![];
    let mut current_heading: Arc<str> = Arc::from("");
    let mut start = None;
    let mut fence: Option<String> = None;
    let mut front = markdown
        && lines
            .spans
            .first()
            .is_some_and(|(s, e)| content[*s..*e].trim() == "---");
    let mut blocks: Vec<(Arc<str>, usize, usize, bool)> = vec![];
    let mut block_bytes = 0usize;
    let flush = |last: usize,
                 start: &mut Option<usize>,
                 heading: &Arc<str>,
                 code: bool,
                 blocks: &mut Vec<(Arc<str>, usize, usize, bool)>,
                 block_bytes: &mut usize|
     -> Result<(), ResourceLimit> {
        if let Some(first) = start.take() {
            let s = lines.spans[first].0;
            let e = lines.spans[last].1;
            if !content[s..e].trim().is_empty() {
                if let Some(limit) = byte_limit {
                    charge(
                        block_bytes,
                        std::mem::size_of::<(Arc<str>, usize, usize, bool)>(),
                        limit,
                    )?;
                }
                blocks.push((heading.clone(), s, e, code));
            }
        }
        Ok(())
    };
    if !markdown {
        if !content.trim().is_empty() {
            blocks.push((current_heading.clone(), 0, content.len(), code));
        }
    } else {
        for (i, (s, e)) in lines.spans.iter().enumerate() {
            let line = &content[*s..*e];
            if front {
                if i > 0 && matches!(line.trim(), "---" | "...") {
                    front = false;
                }
                continue;
            }
            if let Some(m) = fence_re.captures(line) {
                let f = m[1].to_owned();
                if fence.is_none() {
                    if i > 0 {
                        flush(
                            i - 1,
                            &mut start,
                            &current_heading,
                            false,
                            &mut blocks,
                            &mut block_bytes,
                        )?;
                    }
                    start = Some(i);
                    fence = Some(f);
                } else if fence
                    .as_ref()
                    .is_some_and(|old| old.starts_with(&f[..1]) && f.len() >= old.len())
                {
                    fence = None;
                    flush(
                        i,
                        &mut start,
                        &current_heading,
                        true,
                        &mut blocks,
                        &mut block_bytes,
                    )?;
                }
                continue;
            }
            if fence.is_some() {
                continue;
            }
            if let Some(h) = heading_re.captures(line) {
                if i > 0 {
                    flush(
                        i - 1,
                        &mut start,
                        &current_heading,
                        false,
                        &mut blocks,
                        &mut block_bytes,
                    )?;
                }
                let level = h[1].len();
                if byte_limit.is_some() && h[2].len() > 16 * 1024 {
                    return Err(ResourceLimit("Markdown 标题不得超过 16 KiB".into()));
                }
                headings.resize(level, String::new());
                headings.truncate(level);
                headings[level - 1] = h[2].to_owned();
                current_heading = headings
                    .iter()
                    .filter(|heading| !heading.is_empty())
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(" / ")
                    .into();
                if let Some(limit) = byte_limit {
                    charge(
                        &mut block_bytes,
                        current_heading.len() + 2 * std::mem::size_of::<usize>(),
                        limit,
                    )?;
                }
                continue;
            }
            if line.trim().is_empty() {
                if i > 0 {
                    flush(
                        i - 1,
                        &mut start,
                        &current_heading,
                        false,
                        &mut blocks,
                        &mut block_bytes,
                    )?;
                }
            } else if start.is_none() {
                start = Some(i);
            }
        }
        flush(
            lines.spans.len() - 1,
            &mut start,
            &current_heading,
            fence.is_some(),
            &mut blocks,
            &mut block_bytes,
        )?;
    }
    let overlap = if max_chars >= 160 { 80 } else { 0 };
    let body_limit = max_chars - if overlap > 0 { overlap + 2 } else { 0 };
    let mut result: Vec<Chunk> = vec![];
    let mut sentences: Vec<Vec<(usize, usize)>> = vec![];
    let mut length = 0;
    let mut result_bytes = 0usize;
    // Cut out embedded resource data before splitting, retaining original offsets
    // so search snippets and citations can still be read from the source file.
    let blocks = blocks.into_iter().flat_map(|(heading, start, end, code)| {
        ranges
            .iter()
            .filter_map(move |&(allowed_start, allowed_end)| {
                let start = start.max(allowed_start);
                let end = end.min(allowed_end);
                (start < end).then(|| (heading.clone(), start, end, code))
            })
    });
    for (heading, start, end, code) in blocks {
        for (s, e) in split_block(content, start, end, body_limit, code, byte_limit.is_some()) {
            let part = &content[s..e];
            if byte_limit.is_some() && part.len() > MAX_INDEX_LINE_BYTES {
                return Err(ResourceLimit("单个完整句子/代码行不得超过 256 KiB".into()));
            }
            let sentence_parts: Vec<_> = sentence_ranges(content, s, e, code).collect();
            let n = part.encode_utf16().count();
            let new_chunk = result.last().is_none_or(|c| c.heading != heading.as_ref())
                || length + 2 + n > body_limit;
            if let Some(limit) = byte_limit {
                let metadata = std::mem::size_of::<super::SourceSpan>()
                    + std::mem::size_of::<(usize, usize)>() * (1 + sentence_parts.len());
                // Merged paragraphs share the final chunk's heading and container metadata.
                let overhead = if new_chunk {
                    heading.len()
                        + std::mem::size_of::<Chunk>()
                        + std::mem::size_of::<Vec<(usize, usize)>>()
                } else {
                    2
                };
                charge(&mut result_bytes, part.len() + metadata + overhead, limit)?;
            }
            let span = lines.span(content, s, e);
            let last_line = if e > 0 && content.as_bytes()[e - 1] == b'\n' {
                span.end_line.saturating_sub(1).max(span.start_line)
            } else {
                span.end_line
            };
            if new_chunk {
                result.push(Chunk {
                    heading: heading.to_string(),
                    content: part.into(),
                    ranges: vec![(span.start_line, last_line)],
                    spans: vec![span],
                });
                sentences.push(sentence_parts);
                length = n;
            } else {
                let c = result.last_mut().unwrap();
                c.content.push_str("\n\n");
                c.content.push_str(part);
                c.ranges.push((span.start_line, last_line));
                c.spans.push(span);
                sentences.last_mut().unwrap().extend(sentence_parts);
                length += 2 + n;
            }
        }
    }
    // Work backwards so every prefix comes from the original, non-overlapping chunk.
    for i in (1..result.len()).rev() {
        if overlap == 0 || result[i - 1].heading != result[i].heading {
            continue;
        }
        let mut used = 0;
        let mut prefix = vec![];
        for &(start, end) in sentences[i - 1].iter().rev() {
            let size = content[start..end].encode_utf16().count();
            // Keep at least the last complete sentence, even when it exceeds 80.
            if !prefix.is_empty() && used + size > overlap {
                break;
            }
            prefix.push((start, end));
            used += size;
            if used >= overlap {
                break;
            }
        }
        prefix.reverse();
        if let Some(limit) = byte_limit {
            let extra = prefix
                .iter()
                .map(|(start, end)| {
                    end - start
                        + 2
                        + std::mem::size_of::<super::SourceSpan>()
                        + std::mem::size_of::<(usize, usize)>()
                })
                .sum();
            charge(&mut result_bytes, extra, limit)?;
        }
        prefix.extend(
            result[i]
                .spans
                .iter()
                .map(|span| (span.start_byte, span.end_byte)),
        );
        result[i] = chunk_from_ranges(content, &lines, result[i].heading.clone(), &prefix);
    }
    Ok(result)
}
fn chunk_from_ranges(
    source: &str,
    lines: &Lines,
    heading: String,
    parts: &[(usize, usize)],
) -> Chunk {
    let mut merged: Vec<(usize, usize)> = vec![];
    for &(start, end) in parts {
        if let Some(previous) = merged.last_mut().filter(|previous| start <= previous.1) {
            previous.1 = previous.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    let parts = &merged;
    let spans: Vec<_> = parts
        .iter()
        .map(|&(start, end)| lines.span(source, start, end))
        .collect();
    let ranges = spans
        .iter()
        .map(|span| {
            let last = if source.as_bytes()[span.end_byte - 1] == b'\n' {
                span.end_line.saturating_sub(1).max(span.start_line)
            } else {
                span.end_line
            };
            (span.start_line, last)
        })
        .collect();
    let content = source_content(source, &spans);
    Chunk {
        heading,
        content,
        ranges,
        spans,
    }
}
pub(crate) fn source_content(source: &str, spans: &[super::SourceSpan]) -> String {
    let mut result = String::new();
    for span in spans {
        let part = &source[span.start_byte..span.end_byte];
        if !result.is_empty() && !result.ends_with('\n') && !part.starts_with('\n') {
            result.push_str("\n\n");
        }
        result.push_str(part);
    }
    result
}
