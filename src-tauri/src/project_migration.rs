//! Offline layout migration. The old project is left in place until the new
//! layout has been generated and validated in a sibling directory.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
};
use walkdir::WalkDir;

#[path = "migration_retired.rs"]
mod retired;

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    DryRun,
    Apply,
    Rollback,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub required: bool,
    pub interrupted: bool,
}
#[derive(Clone, Serialize)]
pub struct Progress {
    pub stage: String,
    pub detail: String,
    pub completed: usize,
    pub total: usize,
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    pub changes: Vec<String>,
    pub warnings: Vec<String>,
    pub retired_artifacts: std::collections::BTreeMap<String, usize>,
    pub before: Option<MemoryCount>,
    pub after: Option<MemoryCount>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCount {
    pub characters: usize,
    pub active_foreshadows: usize,
    pub timeline_events: usize,
    pub candidate_changes: usize,
}
fn memory_count(dir: &Path, readable: &Path) -> MemoryCount {
    let array = |file: &str, key: &str| -> Vec<serde_json::Value> {
        File::open(dir.join(file))
            .ok()
            .and_then(|f| serde_json::from_reader::<_, serde_json::Value>(f).ok())
            .and_then(|v| v.get(key).and_then(|a| a.as_array()).cloned())
            .unwrap_or_default()
    };
    let candidate_changes = [
        "character-states.md",
        "foreshadowing-tracker.md",
        "timeline.md",
    ]
    .iter()
    .map(|name| {
        let s = fs::read_to_string(readable.join(name)).unwrap_or_default();
        s.split("## 候选区")
            .nth(1)
            .unwrap_or("")
            .lines()
            .filter(|l| l.trim().starts_with("- 第"))
            .count()
    })
    .sum();
    MemoryCount {
        characters: array("character-states.json", "characters").len(),
        active_foreshadows: array("foreshadowing-tracker.json", "items")
            .iter()
            .filter(|v| !matches!(v["status"].as_str(), Some("abandoned" | "resolved")))
            .count(),
        timeline_events: array("timeline.json", "entries").len(),
        candidate_changes,
    }
}

const LEGACY: &[&str] = &[
    ".novel",
    ".qm",
    "retrieval",
    "QM/tracking",
    "wiki",
    ".llm-wiki",
];
const CACHE: &[&str] = &[
    "context-cache",
    "embedding-index.json",
    "embedding-index.log",
    "lancedb",
    "memory-cleanup-last.json",
    "memory-cleanup-checkpoint.json",
    "memory-cleanup-history",
    "memory-cleanup-scan.json",
];
const TRACKING: &[&str] = &["角色状态.md", "伏笔.md", "时间线.md", "上下文.md"];
const SWITCH: &[&str] = &[
    "QM",
    ".qmai",
    ".novel",
    ".qm",
    "retrieval",
    "wiki",
    ".llm-wiki",
    ".gitignore",
    ".trash/items.json",
    ".obsidian/app.json",
];

fn ioerr(e: io::Error) -> String {
    format!("读写迁移数据失败：{e}")
}
fn exists(p: &Path) -> Result<bool> {
    match fs::symlink_metadata(p) {
        Ok(_) => Ok(true),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(ioerr(e)),
    }
}
fn real_dir(p: &Path) -> Result<PathBuf> {
    let d = p.canonicalize().map_err(ioerr)?;
    if !d.is_dir() || d.parent().is_none() {
        return Err("请选择有效小说项目目录".into());
    }
    Ok(d)
}
fn external(p: &Path) -> PathBuf {
    let digest = Sha256::digest(p.as_os_str().as_encoded_bytes());
    p.parent()
        .unwrap()
        .join(format!(".qmai-migration-{:x}", digest))
}
fn safe_dir(p: &Path) -> Result<()> {
    fs::create_dir_all(p).map_err(ioerr)?;
    if !fs::symlink_metadata(p).map_err(ioerr)?.is_dir() {
        return Err(format!("目录不能是符号链接：{}", p.display()));
    }
    Ok(())
}
// A command-line TMPDIR/TEMP override must never create a second set of
// locks for an open project. Keep the stable inode outside the novel itself.
#[cfg(unix)]
fn lock_directory() -> Result<PathBuf> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    // getuid has no parameters or failure returns.
    let uid = unsafe { libc::getuid() };
    let directory = Path::new("/tmp").join(format!("qmai-project-locks-{uid}"));
    match fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(ioerr(e)),
    }
    let info = fs::symlink_metadata(&directory).map_err(ioerr)?;
    if !info.is_dir() || info.uid() != uid || info.mode() & 0o077 != 0 {
        return Err("项目锁目录权限无效，请检查系统临时目录。".into());
    }
    Ok(directory)
}
#[cfg(windows)]
fn lock_directory() -> Result<PathBuf> {
    // FOLDERID_LocalAppData is obtained from the Windows Known Folder API.
    let directory = dirs::cache_dir()
        .ok_or("无法定位当前用户的项目锁目录")?
        .join("QMAI")
        .join("project-locks");
    safe_dir(&directory)?;
    Ok(directory)
}
fn lock(project: &Path, exclusive: bool) -> Result<File> {
    let lock_dir = lock_directory()?;
    let path = lock_dir.join(format!(
        "{:x}.lock",
        Sha256::digest(project.as_os_str().as_encoded_bytes())
    ));
    if exists(&path)? && !fs::symlink_metadata(&path).map_err(ioerr)?.is_file() {
        return Err("迁移锁文件无效".into());
    }
    let f = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(ioerr)?;
    let r = if exclusive {
        f.try_lock()
    } else {
        f.try_lock_shared()
    };
    r.map_err(|_| "这个项目正由青幕或迁移工具使用，请先关闭占用项目的窗口。".to_owned())?;
    Ok(f)
}
pub fn acquire_project_session(path: &Path) -> Result<File> {
    lock(&real_dir(path)?, false)
}
// The parent exists, but a successful rename must reserve the new identifier
// before exposing that path to other processes.
pub fn reserve_session_destination(parent: &Path, name: &std::ffi::OsStr) -> Result<File> {
    lock(&parent.canonicalize().map_err(ioerr)?.join(name), false)
}

#[derive(Serialize, Deserialize)]
struct Journal {
    project: PathBuf,
    run: String,
    status: String,
    entries: Vec<Entry>,
}
#[derive(Serialize, Deserialize)]
struct Entry {
    name: String,
    original: Option<String>,
    next: Option<String>,
}

fn atomic_json(path: &Path, data: &impl Serialize) -> Result<()> {
    let mut f = tempfile::Builder::new()
        .prefix(".qmai-state-")
        .suffix(".tmp")
        .tempfile_in(path.parent().unwrap())
        .map_err(ioerr)?;
    serde_json::to_writer(&mut f, data).map_err(|e| e.to_string())?;
    f.as_file().sync_all().map_err(ioerr)?;
    f.persist(path).map_err(|e| ioerr(e.error))?;
    sync_dir(path.parent().unwrap())
}
#[cfg(unix)]
fn sync_dir(p: &Path) -> Result<()> {
    File::open(p).and_then(|f| f.sync_all()).map_err(ioerr)
}
#[cfg(not(unix))]
fn sync_dir(_: &Path) -> Result<()> {
    Ok(())
}
fn journal(project: &Path) -> Result<Option<Journal>> {
    let ext = external(project);
    if exists(&ext)? && !fs::symlink_metadata(&ext).map_err(ioerr)?.is_dir() {
        return Err("迁移工作目录无效".into());
    }
    let p = guarded_root(&ext, "state.json")?;
    if !exists(&p)? {
        return Ok(None);
    }
    let j: Journal = serde_json::from_reader(File::open(&p).map_err(ioerr)?)
        .map_err(|e| format!("迁移记录损坏：{e}"))?;
    if j.project != project
        || uuid::Uuid::parse_str(&j.run).is_err()
        || j.entries.iter().any(|e| !SWITCH.contains(&e.name.as_str()))
    {
        return Err("迁移记录与所选项目不匹配".into());
    }
    if !matches!(
        j.status.as_str(),
        "preparing" | "switching" | "restoring" | "committed" | "restored"
    ) {
        return Err("迁移记录阶段无效".into());
    }
    guarded_root(&ext, &j.run)?;
    Ok(Some(j))
}
pub const FORMAT_FILE: &str = ".qmai/novel/project-format.json";
const CURRENT_FORMAT: u64 = 1;

#[derive(Serialize, Deserialize)]
struct ProjectFormat {
    version: u64,
}

pub fn project_format(project: &Path) -> Result<Option<u64>> {
    let path = guarded_root(project, FORMAT_FILE)?;
    if !exists(&path)? {
        return Ok(None);
    }
    if !fs::symlink_metadata(&path).map_err(ioerr)?.is_file() {
        return Err(format!("项目格式版本文件无效：{FORMAT_FILE}"));
    }
    let format: ProjectFormat = serde_json::from_reader(File::open(path).map_err(ioerr)?)
        .map_err(|_| format!("项目格式版本文件损坏，请检查 {FORMAT_FILE}。"))?;
    if format.version > CURRENT_FORMAT {
        return Err(format!(
            "项目格式版本为 {}，当前青幕最高支持版本 {CURRENT_FORMAT}。请升级青幕后再打开。",
            format.version
        ));
    }
    Ok(Some(format.version))
}

pub fn write_current_format(project: &Path) -> Result<()> {
    if project_format(project)? == Some(CURRENT_FORMAT) {
        return Ok(());
    }
    let path = guarded_root(project, FORMAT_FILE)?;
    safe_dir(path.parent().unwrap())?;
    atomic_json(
        &path,
        &ProjectFormat {
            version: CURRENT_FORMAT,
        },
    )
}

pub fn inspect(path: &Path) -> Result<Inspection> {
    let project = real_dir(path)?;
    // During a directory switch the manifest can be missing or belong to the
    // new tree. Only the transaction journal can decide what to recover.
    if journal(&project)?.is_some() || exists(&external(&project))? {
        return Ok(Inspection {
            required: false,
            interrupted: true,
        });
    }
    let version = project_format(&project)?;
    let mut legacy = false;
    for name in LEGACY {
        legacy |= exists(&project.join(name))?;
    }
    if !legacy && version.is_none() && project.join(".qmai/novel").is_dir() {
        return Err(format!("项目缺少格式版本文件，请检查 {FORMAT_FILE}。"));
    }
    Ok(Inspection {
        required: legacy || version.is_some_and(|v| v < CURRENT_FORMAT),
        interrupted: false,
    })
}
fn progress(
    f: &mut impl FnMut(Progress),
    stage: &str,
    detail: &str,
    completed: usize,
    total: usize,
) {
    f(Progress {
        stage: stage.into(),
        detail: detail.into(),
        completed,
        total,
    });
}
fn renamed(s: &str) -> String {
    const MAP: &[(&str, &str)] = &[
        ("QM/tracking/上下文.md", "QM/memory/writing-progress.md"),
        ("wiki/tracking/上下文.md", "wiki/memory/writing-progress.md"),
        ("QM/tracking/角色状态.md", "QM/memory/character-states.md"),
        (
            "wiki/tracking/角色状态.md",
            "wiki/memory/character-states.md",
        ),
        ("QM/tracking/时间线.md", "QM/memory/timeline.md"),
        ("wiki/tracking/时间线.md", "wiki/memory/timeline.md"),
        ("QM/tracking/伏笔.md", "QM/memory/foreshadowing-tracker.md"),
        (
            "wiki/tracking/伏笔.md",
            "wiki/memory/foreshadowing-tracker.md",
        ),
        ("wiki/tracking", "wiki/memory"),
        ("QM/tracking", "QM/memory"),
        (".novel", ".qmai/novel"),
        ("retrieval", ".qmai/retrieval"),
        (".llm-wiki", ".qmai"),
    ];
    let normalized = s.replace('\\', "/");
    for &(old, new) in MAP {
        if normalized == old {
            return new.into();
        }
        if let Some(rest) = normalized.strip_prefix(&format!("{old}/")) {
            return format!("{new}/{rest}");
        }
    }
    s.into()
}
fn rewrite_project_ref(s: &str, project: &Path) -> String {
    let raw = s.replace('\\', "/");
    let project = project.to_string_lossy().replace('\\', "/");
    let project = project.strip_prefix("//?/").unwrap_or(&project);
    let prefix = format!("{project}/");
    if let Some(tail) = raw
        .strip_prefix("//?/")
        .unwrap_or(&raw)
        .strip_prefix(&prefix)
    {
        let result = renamed(tail);
        if result != tail {
            return format!("{prefix}{result}");
        }
        return s.into();
    }
    if let Some(tail) = raw.strip_prefix("./") {
        let result = renamed(tail);
        if result != tail {
            return format!("./{result}");
        }
        return s.into();
    }
    renamed(s)
}
fn rewrite_refs(v: &mut serde_json::Value, field: &str, project: &Path) -> bool {
    let key = field.to_ascii_lowercase();
    let is_path = matches!(
        key.as_str(),
        "path"
            | "paths"
            | "dir"
            | "dirs"
            | "directory"
            | "directories"
            | "file"
            | "files"
            | "source"
            | "sources"
            | "userignorefilters"
            | "excludeglobs"
            | "excludedirs"
    ) || [
        "Path",
        "Paths",
        "Dir",
        "Dirs",
        "File",
        "Files",
        "Directory",
        "Directories",
        "_path",
        "_paths",
        "_dir",
        "_dirs",
        "_file",
        "_files",
    ]
    .iter()
    .any(|suffix| field.ends_with(suffix));
    match v {
        serde_json::Value::Object(m) => {
            let keys = m.keys().cloned().collect::<Vec<_>>();
            let mut changed = false;
            for key in keys {
                changed |= rewrite_refs(m.get_mut(&key).unwrap(), &key, project);
            }
            changed
        }
        serde_json::Value::Array(a) => a.iter_mut().fold(false, |changed, x| {
            rewrite_refs(x, field, project) || changed
        }),
        serde_json::Value::String(s) if is_path => {
            let r = rewrite_project_ref(s, project);
            if *s != r {
                *s = r;
                true
            } else {
                false
            }
        }
        _ => false,
    }
}
fn is_volume(s: &str) -> bool {
    s == "index.md"
        || s.strip_prefix("volume-")
            .and_then(|s| s.strip_suffix(".md"))
            .is_some_and(|n| n.parse::<u32>().is_ok())
}
fn empty_extraction_cache(path: &Path, kind: fs::FileType) -> Result<bool> {
    if !kind.is_dir() || !path.file_name().is_some_and(|name| name == ".cache") {
        return Ok(false);
    }
    Ok(fs::read_dir(path)
        .map_err(ioerr)?
        .next()
        .transpose()
        .map_err(ioerr)?
        .is_none())
}
fn unknowns(project: &Path, report: &mut Report) -> Result<()> {
    let breakpoint = project.join(".qm/breakpoint.json");
    if breakpoint.is_file() {
        let data = fs::read(&breakpoint).map_err(ioerr)?;
        match serde_json::from_slice::<serde_json::Value>(&data) {
            Ok(v) if v.is_null() => {}
            _ => report.warnings.push(
                "旧任务断点仍有内容，请先保存 .qm/breakpoint.json 中的任务信息并移出该文件。"
                    .into(),
            ),
        }
    }
    for (folder, known) in [
        (".qm", &["breakpoint.json"][..]),
        ("QM/tracking", TRACKING),
        ("wiki/tracking", TRACKING),
        ("retrieval", &[][..]),
    ] {
        let p = project.join(folder);
        if !exists(&p)? {
            continue;
        }
        for item in fs::read_dir(p).map_err(ioerr)? {
            let item = item.map_err(ioerr)?;
            let n = item.file_name();
            let n = n.to_string_lossy();
            let kind = item.file_type().map_err(ioerr)?;
            let known_file = kind.is_file()
                && (n == ".DS_Store"
                    || known.contains(&n.as_ref())
                    || (folder == "retrieval" && is_volume(&n)));
            if !known_file && !empty_extraction_cache(&item.path(), kind)? {
                report
                    .warnings
                    .push(format!("请先移出退役目录中的自定义文件：{folder}/{n}"));
            }
        }
    }
    Ok(())
}
fn merge_file(from: &Path, to: &Path) -> Result<()> {
    if exists(to)? {
        if !to.is_file() || fs::read(from).map_err(ioerr)? != fs::read(to).map_err(ioerr)? {
            return Err(format!("新旧位置内容冲突：{}", to.display()));
        }
        return Ok(());
    }
    fs::create_dir_all(to.parent().unwrap()).map_err(ioerr)?;
    fs::copy(from, to).map_err(ioerr)?;
    Ok(())
}
fn obsolete(name: &str) -> bool {
    CACHE.contains(&name)
        || name
            .strip_prefix('.')
            .and_then(|s| s.strip_suffix(".tmp"))
            .and_then(|s| s.rsplit_once('.'))
            .is_some_and(|(file, stamp)| {
                !file.contains('/')
                    && file.ends_with(".json")
                    && stamp.len() >= 10
                    && stamp.bytes().all(|b| b.is_ascii_digit())
            })
}
fn stage_tree(
    project: &Path,
    stage: &Path,
    folder: &str,
    target: &str,
    original_project: &Path,
    f: &mut impl FnMut(Progress),
) -> Result<()> {
    let origin = project.join(folder);
    if !exists(&origin)? {
        return Ok(());
    }
    let meta = folder == ".qmai" || folder == ".llm-wiki";
    let wiki = folder == "QM" || folder == "wiki";
    let iter = WalkDir::new(&origin)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            let rel = e
                .path()
                .strip_prefix(&origin)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if wiki && rel == "tracking" {
                return false;
            }
            if meta && obsolete(&rel) {
                return false;
            }
            true
        });
    for (count, item) in iter.enumerate() {
        let item = item.map_err(|e| e.to_string())?;
        let rel = item.path().strip_prefix(&origin).unwrap();
        let dest = stage.join(target).join(rel);
        if item.file_type().is_dir() {
            if empty_extraction_cache(item.path(), item.file_type())? {
                continue;
            }
            fs::create_dir_all(&dest).map_err(ioerr)?;
        } else if item.file_type().is_file() {
            merge_file(item.path(), &dest)?;
            // Prose, Markdown, history text and chat messages are never globally replaced.
            if (meta || folder == ".novel")
                && dest.extension().is_some_and(|x| x == "json")
                && !dest.starts_with(stage.join(".qmai/novel/snapshots"))
            {
                rewrite_json_file(&dest, original_project)?;
            }
        } else {
            return Err(format!(
                "迁移管理目录包含符号链接或特殊文件，请先移出：{}",
                item.path().display()
            ));
        }
        if count % 200 == 0 {
            progress(
                f,
                "staging",
                &format!("正在准备 {folder}/{}", rel.display()),
                count,
                0,
            );
        }
    }
    Ok(())
}
// The old Markdown tables could be edited directly. Only import explicit
// differences from their corresponding JSON records, never classify a generated
// "未知"/"medium" placeholder as an author override.
fn inspect_staged_memory(stage: &Path) -> Result<()> {
    let dir = stage.join(".qmai/novel");
    for (name, key) in [
        ("character-states.json", "characters"),
        ("foreshadowing-tracker.json", "items"),
        ("timeline.json", "entries"),
    ] {
        let p = dir.join(name);
        if !p.is_file() {
            continue;
        }
        let malformed =
            || format!("旧记忆 {name} 格式损坏，可能包含尚未同步的人工资料，请修复后重试。");
        let data: serde_json::Value =
            serde_json::from_reader(File::open(&p).map_err(ioerr)?).map_err(|_| malformed())?;
        let rows = data
            .get(key)
            .and_then(|v| v.as_array())
            .ok_or_else(malformed)?;
        for (i, r) in rows.iter().enumerate() {
            let valid = match key {
                "characters" => r["characterName"].as_str().is_some_and(|s| !s.is_empty()),
                "items" => {
                    r["name"].as_str().is_some_and(|s| !s.is_empty())
                        && r["id"].as_str().is_some_and(|s| !s.is_empty())
                }
                _ => r["event"].is_string() && r["chapterNumber"].is_i64(),
            };
            if !valid {
                return Err(format!("{}（第 {} 条）", malformed(), i + 1));
            }
        }
    }
    let snapshots = dir.join("snapshots");
    if snapshots.is_dir() {
        for entry in fs::read_dir(&snapshots).map_err(ioerr)? {
            let e = entry.map_err(ioerr)?;
            let filename = e.file_name();
            let n = filename.to_string_lossy();
            let Some(id) = n.strip_suffix(".snapshot.json") else {
                continue;
            };
            if !(id.parse::<i32>().is_ok()
                || id
                    .strip_prefix("outline-")
                    .is_some_and(|s| s.parse::<u32>().is_ok()))
            {
                continue;
            }
            let value = serde_json::from_reader::<_, serde_json::Value>(
                File::open(e.path()).map_err(ioerr)?,
            );
            if !value.is_ok_and(|v| v.is_object()) {
                return Err(format!(
                    "章节快照 snapshots/{n} 损坏，迁移未切换任何文件。请修复原快照后重试。"
                ));
            }
        }
    }
    Ok(())
}
fn reject_competing_notes(
    old: &serde_json::Value,
    new: &serde_json::Value,
    fields: &[&str],
    doc: &str,
    id: &str,
) -> Result<()> {
    for field in fields {
        let value = &old[*field];
        let filled = match value {
            serde_json::Value::Null => false,
            serde_json::Value::String(s) => !s.is_empty(),
            serde_json::Value::Array(a) => !a.is_empty(),
            _ => true,
        };
        if filled && value != &new[*field] {
            return Err(format!(
                "追踪页 {doc} 和原记忆库的人工字段存在冲突：{id}（{field}）。请核对后重试。"
            ));
        }
    }
    Ok(())
}
fn import_tracking_fields(source: &Path, stage: &Path) -> Result<()> {
    for prefix in ["QM/tracking", "wiki/tracking"] {
        let tracking = source.join(prefix);
        let machine = stage.join(".qmai/novel");
        for (doc, store, key) in [
            ("角色状态.md", "character-states.json", "characters"),
            ("伏笔.md", "foreshadowing-tracker.json", "items"),
            ("时间线.md", "timeline.json", "entries"),
        ] {
            let json = machine.join(store);
            if !tracking.join(doc).is_file() || !json.is_file() {
                continue;
            }
            let mut data: serde_json::Value =
                serde_json::from_reader(File::open(&json).map_err(ioerr)?)
                    .map_err(|e| e.to_string())?;
            let Some(rows) = data.get_mut(key).and_then(|r| r.as_array_mut()) else {
                continue;
            };
            let md = fs::read_to_string(tracking.join(doc)).map_err(ioerr)?;
            let mut subject = "";
            let mut changed = false;
            for line in md.lines() {
                if let Some(h) = line.strip_prefix("## ") {
                    subject = h.trim();
                    continue;
                }
                if doc == "角色状态.md" {
                    let Some((field, value)) =
                        line.strip_prefix("- **").and_then(|s| s.split_once("**："))
                    else {
                        continue;
                    };
                    let Some(row) = rows.iter_mut().find(|r| r["characterName"] == subject) else {
                        continue;
                    };
                    let previous = row.clone();
                    match field {
                        "状态"
                            if !value.is_empty() && value != "正常" && row["status"] != value =>
                        {
                            row["generatedStatus"] = row["status"].clone();
                            row["status"] = value.into();
                            changed = true;
                        }
                        "当前位置"
                            if value != "未知"
                                && !value.is_empty()
                                && row["currentLocation"] != value =>
                        {
                            row["currentLocation"] = value.into();
                            changed = true;
                        }
                        "公众形象" if !value.is_empty() && row["publicImage"] != value => {
                            row["publicImage"] = value.into();
                            changed = true;
                        }
                        "待回收伏笔" if !value.is_empty() => {
                            let ids = serde_json::json!(value
                                .split(['、', '，', ','])
                                .map(str::trim)
                                .filter(|s| !s.is_empty())
                                .collect::<Vec<_>>());
                            if row["pendingForeshadowing"] != ids {
                                row["pendingForeshadowing"] = ids;
                                changed = true;
                            }
                        }
                        _ => {}
                    }
                    reject_competing_notes(
                        &previous,
                        row,
                        &["publicImage", "pendingForeshadowing", "currentLocation"],
                        doc,
                        subject,
                    )?;
                    continue;
                }
                let Some(raw) = line.strip_prefix('|').and_then(|s| s.strip_suffix('|')) else {
                    continue;
                };
                let fields = raw.split('|').map(str::trim).collect::<Vec<_>>();
                if doc == "时间线.md" {
                    if fields.len() == 2 {
                        let chapter = fields[0]
                            .strip_prefix('第')
                            .and_then(|s| s.strip_suffix('章'))
                            .and_then(|s| s.parse::<u32>().ok());
                        if let Some(ch) = chapter {
                            if !fields[1].is_empty()
                                && !rows
                                    .iter()
                                    .any(|r| r["chapterNumber"] == ch && r["event"] == fields[1])
                            {
                                rows.push(serde_json::json!({"chapterNumber":ch,"event":fields[1],"manual":true}));
                                changed = true;
                            }
                        }
                    }
                } else if let Some(row) = rows.iter_mut().find(|r| r["id"] == fields[0]) {
                    let previous = row.clone();
                    if subject == "活跃伏笔" && fields.len() == 8 {
                        if !fields[7].is_empty() {
                            row["notes"] = fields[7].into();
                        }
                        if let Some(n) = fields[3]
                            .strip_prefix('第')
                            .and_then(|s| s.strip_suffix('章'))
                            .and_then(|s| s.parse::<u32>().ok())
                        {
                            row["expectedResolveChapter"] = n.into();
                        }
                        if let Some(level) = match fields[5] {
                            "高" | "high" => Some("high"),
                            "低" | "low" => Some("low"),
                            "中" | "medium" if row["importance"].is_string() => Some("medium"),
                            _ => None,
                        } {
                            row["importance"] = level.into();
                        }
                        if !fields[6].is_empty() {
                            row["relatedCharacters"] = serde_json::json!(fields[6]
                                .split(['、', '，', ','])
                                .map(str::trim)
                                .collect::<Vec<_>>());
                        }
                    } else if subject == "已放弃伏笔" && fields.len() == 5 {
                        row["status"] = "abandoned".into();
                        if !fields[4].is_empty() {
                            row["notes"] = fields[4].into();
                        }
                    }
                    reject_competing_notes(
                        &previous,
                        row,
                        &[
                            "importance",
                            "notes",
                            "relatedCharacters",
                            "expectedResolveChapter",
                        ],
                        doc,
                        fields[0],
                    )?;
                    changed |= previous != *row;
                }
            }
            if changed {
                atomic_json(&json, &data)?;
            }
        }
    }
    Ok(())
}
fn rewrite_json_file(p: &Path, project: &Path) -> Result<()> {
    let Ok(mut v) = serde_json::from_reader::<_, serde_json::Value>(File::open(p).map_err(ioerr)?)
    else {
        return Ok(());
    };
    let mut changed = false;
    if p.file_name().is_some_and(|n| n == "file-snapshot.json") {
        if let Some(files) = v.get_mut("files").and_then(|x| x.as_object_mut()) {
            for key in files.keys().cloned().collect::<Vec<_>>() {
                let to = rewrite_project_ref(&key, project);
                if to != key {
                    if let Some(value) = files.remove(&key) {
                        files.entry(to).or_insert(value);
                        changed = true;
                    }
                }
            }
        }
    }
    if rewrite_refs(&mut v, "", project) || changed {
        atomic_json(p, &v)?;
    }
    Ok(())
}
fn updated_ignore(raw: &str) -> String {
    let special = raw
        .lines()
        .any(|l| matches!(l.trim(), ".qmai" | ".qmai/" | "/.qmai" | "/.qmai/"));
    let mut out = Vec::new();
    if special {
        out.extend(["/.qmai/*", "!/.qmai/novel/", "!/.qmai/retrieval/"].map(str::to_owned));
    }
    for l in raw.lines() {
        if special && matches!(l.trim(), ".qmai/" | ".qmai" | "/.qmai/" | "/.qmai") {
            continue;
        }
        let (prefix, l) = l.strip_prefix('!').map_or(("", l), |s| ("!", s));
        let (root, l) = l.strip_prefix('/').map_or(("", l), |s| ("/", s));
        if l.trim_end_matches('/') == ".qm" {
            continue;
        }
        let r = renamed(l);
        out.push(format!("{prefix}{root}{r}"));
    }
    out.join("\n") + if raw.ends_with('\n') { "\n" } else { "" }
}
fn fingerprint(p: &Path) -> Result<Option<String>> {
    if !exists(p)? {
        return Ok(None);
    }
    let mut h = Sha256::new();
    for entry in WalkDir::new(p).sort_by_file_name().follow_links(false) {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry
            .path()
            .strip_prefix(p)
            .unwrap()
            .as_os_str()
            .as_encoded_bytes();
        h.update((name.len() as u64).to_le_bytes());
        h.update(name);
        if entry.file_type().is_file() {
            let mut file = File::open(entry.path()).map_err(ioerr)?;
            h.update(b"f");
            h.update(file.metadata().map_err(ioerr)?.len().to_le_bytes());
            let mut buf = [0u8; 65536];
            loop {
                let n = file.read(&mut buf).map_err(ioerr)?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
        } else if entry.file_type().is_dir() {
            h.update(b"d");
        } else {
            return Err(format!("不支持的文件类型：{}", entry.path().display()));
        }
    }
    Ok(Some(format!("{:x}", h.finalize())))
}
fn guarded_root(p: &Path, relative: &str) -> Result<PathBuf> {
    let mut b = p.to_path_buf();
    for c in relative.split('/') {
        b.push(c);
        if exists(&b)? && fs::symlink_metadata(&b).map_err(ioerr)?.is_symlink() {
            return Err(format!("拒绝操作符号链接：{}", b.display()));
        }
    }
    Ok(b)
}
fn mv(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to.parent().unwrap()).map_err(ioerr)?;
    fs::rename(from, to).map_err(|e| format!("切换 {} 失败：{e}", from.display()))?;
    sync_dir(from.parent().unwrap())?;
    sync_dir(to.parent().unwrap())
}
fn copy_tree(src: &Path, dst: &Path, mut copied: impl FnMut(&Path)) -> Result<()> {
    for entry in WalkDir::new(src).follow_links(false) {
        let e = entry.map_err(|err| err.to_string())?;
        let rel = e.path().strip_prefix(src).unwrap();
        let to = if rel.as_os_str().is_empty() {
            dst.to_owned()
        } else {
            dst.join(rel)
        };
        if e.file_type().is_dir() {
            safe_dir(&to)?;
        } else if e.file_type().is_file() {
            fs::create_dir_all(to.parent().unwrap()).map_err(ioerr)?;
            fs::copy(e.path(), &to).map_err(ioerr)?;
            File::open(&to).and_then(|f| f.sync_all()).map_err(ioerr)?;
        } else {
            return Err(format!("不能备份特殊文件：{}", e.path().display()));
        }
        copied(rel);
    }
    Ok(())
}
fn remove_workspace(ext: &Path) -> Result<()> {
    for item in fs::read_dir(ext).map_err(ioerr)? {
        let item = item.map_err(ioerr)?;
        let name = item.file_name();
        let name = name.to_string_lossy();
        if name.starts_with(".qmai-state-")
            && name.ends_with(".tmp")
            && item.file_type().map_err(ioerr)?.is_file()
        {
            fs::remove_file(item.path()).map_err(ioerr)?;
        } else {
            return Err(format!(
                "迁移目录存在未知内容，请先检查：{}",
                item.path().display()
            ));
        }
    }
    fs::remove_dir(ext).map_err(ioerr)?;
    sync_dir(ext.parent().unwrap())
}
fn finalize(ext: &Path, j: &Journal) -> Result<()> {
    let run = guarded_root(ext, &j.run)?;
    if exists(&run)? {
        fs::remove_dir_all(&run).map_err(ioerr)?;
    }
    sync_dir(ext)?;
    fs::remove_file(ext.join("state.json")).map_err(ioerr)?;
    sync_dir(ext)?;
    remove_workspace(ext)
}
fn restore(
    project: &Path,
    ext: &Path,
    j: &mut Journal,
    f: &mut impl FnMut(Progress),
) -> Result<()> {
    if matches!(j.status.as_str(), "committed" | "restored" | "preparing") {
        return finalize(ext, j);
    }
    let run = guarded_root(ext, &j.run)?;
    let backups = guarded_root(&run, "original")?;
    j.status = "restoring".into();
    atomic_json(&ext.join("state.json"), j)?;
    for (i, e) in j.entries.iter().enumerate().rev() {
        let live = guarded_root(project, &e.name)?;
        let current = fingerprint(&live)?;
        if current != e.original {
            if current.is_some() && current != e.next {
                return Err(format!("恢复时检测到外部修改，请保留备份：{}", e.name));
            }
            let original = guarded_root(&backups, &e.name)?;
            if fingerprint(&original)? != e.original {
                return Err(format!("备份校验失败：{}", e.name));
            }
            if current.is_some() {
                mv(
                    &live,
                    &run.join("discard").join(uuid::Uuid::new_v4().to_string()),
                )?;
            }
            if e.original.is_some() {
                let temp = run
                    .join("restore-files")
                    .join(uuid::Uuid::new_v4().to_string());
                let mut copied = 0usize;
                copy_tree(&original, &temp, |relative| {
                    copied += 1;
                    if copied % 100 == 0 {
                        let path = Path::new(&e.name).join(relative);
                        progress(
                            f,
                            "restoring",
                            &format!("正在恢复 {}（已复制 {copied} 项）", path.display()),
                            copied,
                            0,
                        );
                    }
                })?;
                mv(&temp, &live)?;
            }
            if fingerprint(&live)? != e.original {
                return Err(format!("恢复后校验失败：{}", e.name));
            }
        }
        progress(
            f,
            "restoring",
            &format!("正在恢复 {}", e.name),
            j.entries.len() - i,
            j.entries.len(),
        );
    }
    j.status = "restored".into();
    atomic_json(&ext.join("state.json"), j)?;
    finalize(ext, j)
}
pub fn run(
    path: &Path,
    mode: Mode,
    mut f: impl FnMut(Progress),
    refresh: impl FnOnce(&Path) -> Result<()>,
) -> Result<Report> {
    let project = real_dir(path)?;
    let ext = external(&project);
    let _lock = if mode == Mode::DryRun {
        None
    } else {
        Some(lock(&project, true)?)
    };
    let result = run_locked(&project, &ext, mode, &mut f, refresh);
    if result.is_err() && mode == Mode::Apply {
        if let Some(j) = journal(&project)? {
            if j.status == "preparing" {
                finalize(&ext, &j)?;
            }
        }
    }
    result
}
fn run_locked(
    project: &Path,
    ext: &Path,
    mode: Mode,
    mut f: impl FnMut(Progress),
    refresh: impl FnOnce(&Path) -> Result<()>,
) -> Result<Report> {
    let state = inspect(&project)?;
    let mut report = Report::default();
    if mode == Mode::Rollback {
        let Some(mut j) = journal(project)? else {
            // The process can stop between creating the workspace and recording
            // the first journal, or between unlinking the final journal and rmdir.
            if state.interrupted {
                remove_workspace(ext)?;
                return Ok(report);
            }
            return Err("没有找到项目的迁移备份".into());
        };
        restore(&project, &ext, &mut j, &mut f)?;
        return Ok(report);
    }
    if state.interrupted {
        return Err("上次迁移被意外中断，请先恢复备份，再重新迁移。".into());
    }
    if !state.required {
        return Ok(report);
    }
    // This converter implements the initial layout only. Raising CURRENT_FORMAT
    // requires an explicit migration for that version before stamping a book.
    let from = project_format(project)?.unwrap_or(0);
    if !matches!((from, CURRENT_FORMAT), (0 | 1, 1)) {
        return Err(format!(
            "缺少从项目格式版本 {from} 升级到 {CURRENT_FORMAT} 的迁移步骤。"
        ));
    }
    if !project.join("QM").is_dir()
        && !project.join("wiki").is_dir()
        && !project.join("schema.md").is_file()
        && !project.join(".qmai/novel").is_dir()
    {
        return Err("未识别到青幕小说项目，请检查选择的目录。".into());
    }
    progress(&mut f, "scanning", "正在核对项目目录和可迁移内容", 0, 0);
    for n in LEGACY {
        if exists(&guarded_root(&project, n)?)? {
            report.changes.push((*n).into());
        }
    }
    report.changes.push(FORMAT_FILE.into());
    unknowns(&project, &mut report)?;
    if !report.warnings.is_empty() {
        return if mode == Mode::DryRun {
            Ok(report)
        } else {
            Err(report.warnings.join("\n"))
        };
    }
    let previous = if project.join(".novel").exists() {
        project.join(".novel")
    } else {
        project.join(".qmai/novel")
    };
    report.before = Some(memory_count(&previous, &project.join("QM/memory")));
    let id = uuid::Uuid::new_v4().to_string();
    let run = ext.join(&id);
    let preview = if mode == Mode::DryRun {
        Some(tempfile::tempdir().map_err(ioerr)?)
    } else {
        None
    };
    let stage = match &preview {
        Some(p) => p.path().canonicalize().map_err(ioerr)?,
        None => run.join("stage"),
    };
    if mode == Mode::Apply {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(ext).map_err(ioerr)?;
        atomic_json(
            &ext.join("state.json"),
            &Journal {
                project: project.to_owned(),
                run: id.clone(),
                status: "preparing".into(),
                entries: vec![],
            },
        )?;
        fs::create_dir(&run).map_err(ioerr)?;
    }
    safe_dir(&stage)?;
    for meta in [".qmai", ".llm-wiki"] {
        let dir = project.join(meta);
        if dir.is_dir() {
            for item in fs::read_dir(dir).map_err(ioerr)? {
                let n = item.map_err(ioerr)?.file_name();
                let n = n.to_string_lossy();
                if obsolete(&n) {
                    report.changes.push(format!("{meta}/{n}"));
                }
            }
        }
    }
    let mut initial = std::collections::BTreeMap::new();
    let source = if mode == Mode::Apply {
        let original = run.join("original");
        let mut size = 0u64;
        let mut total = 0usize;
        let mut completed = 0usize;
        for name in SWITCH {
            let live = guarded_root(project, name)?;
            if exists(&live)? {
                for entry in WalkDir::new(&live).follow_links(false) {
                    let entry = entry.map_err(|e| e.to_string())?;
                    total += 1;
                    size = size.saturating_add(entry.metadata().map_err(|e| e.to_string())?.len());
                }
            }
        }
        let available = fs4::available_space(project.parent().unwrap()).map_err(ioerr)?;
        let required = size.saturating_mul(2);
        if available < required {
            return Err(format!(
                "可用空间不足，备份和暂存预计需要 {} MiB，当前可用 {} MiB。",
                required.div_ceil(1048576),
                available / 1048576
            ));
        }
        for name in SWITCH {
            let live = guarded_root(project, name)?;
            let digest = fingerprint(&live)?;
            if digest.is_some() {
                progress(
                    &mut f,
                    "backup",
                    &format!("正在备份并校验 {name}"),
                    completed,
                    total,
                );
                let dest = original.join(name);
                copy_tree(&live, &dest, |relative| {
                    completed += 1;
                    if completed % 100 == 0 || completed == total {
                        let path = Path::new(name).join(relative);
                        progress(
                            &mut f,
                            "backup",
                            &format!("正在备份 {}", path.display()),
                            completed,
                            total,
                        );
                    }
                })?;
                if fingerprint(&dest)? != digest {
                    return Err(format!("备份校验失败，项目尚未切换：{name}"));
                }
            }
            initial.insert(*name, digest);
        }
        original
    } else {
        project.to_owned()
    };
    if mode == Mode::Apply {
        // The backup may include a new author file created after the first preflight.
        unknowns(&source, &mut report)?;
        if !report.warnings.is_empty() {
            return Err(report.warnings.join("\n"));
        }
    }
    for (folder, target) in [
        ("QM", "QM"),
        ("wiki", "QM"),
        (".qmai", ".qmai"),
        (".llm-wiki", ".qmai"),
        (".novel", ".qmai/novel"),
        ("retrieval", ".qmai/retrieval"),
    ] {
        stage_tree(&source, &stage, folder, target, project, &mut f)?;
    }
    for folder in ["QM/tracking", "wiki/tracking"] {
        for n in TRACKING {
            let from = source.join(folder).join(n);
            if exists(&from)? {
                merge_file(&from, &stage.join("migration-input").join(n))?;
            }
        }
        let old = source.join(folder).join("上下文.md");
        if exists(&old)? {
            merge_file(&old, &stage.join("QM/memory/writing-progress.md"))?;
        }
    }
    for folder in [".gitignore", ".trash/items.json", ".obsidian/app.json"] {
        let from = guarded_root(&source, folder)?;
        if !exists(&from)? {
            continue;
        }
        let to = stage.join(folder);
        merge_file(&from, &to)?;
        if folder == ".gitignore" {
            let raw = fs::read_to_string(&from).map_err(ioerr)?;
            fs::write(to, updated_ignore(&raw)).map_err(ioerr)?;
        } else {
            rewrite_json_file(&to, project)?;
        }
    }
    fs::create_dir_all(stage.join(".qmai/novel/snapshots")).map_err(ioerr)?;
    retired::clean(&source, &stage, &mut report)?;
    inspect_staged_memory(&stage)?;
    for warning in &report.warnings {
        progress(&mut f, "warning", warning, 0, 0);
    }
    import_tracking_fields(&source, &stage)?;
    progress(&mut f, "rebuilding", "正在按新版规则重建记忆和检索", 0, 0);
    refresh(&stage)?;
    write_current_format(&stage)?;
    for n in LEGACY {
        if exists(&stage.join(n))? {
            return Err(format!("重建结果仍包含旧路径：{n}"));
        }
    }
    report.after = Some(memory_count(
        &stage.join(".qmai/novel"),
        &stage.join("QM/memory"),
    ));
    if mode == Mode::DryRun {
        return Ok(report);
    }
    let mut entries = Vec::new();
    progress(&mut f, "verifying", "正在校验即将切换的文件", 0, 0);
    for n in SWITCH {
        let next = fingerprint(&stage.join(n))?;
        let live = guarded_root(&project, n)?;
        let original = fingerprint(&live)?;
        if initial.get(n) != Some(&original) {
            return Err(format!("准备迁移期间文件已被其他程序修改：{n}"));
        }
        if original.is_some() || next.is_some() {
            entries.push(Entry {
                name: (*n).into(),
                original,
                next,
            });
        }
    }
    let mut j = Journal {
        project: project.to_owned(),
        run: id,
        status: "switching".into(),
        entries,
    };
    atomic_json(&ext.join("state.json"), &j)?;
    let switch = (|| {
        for (i, e) in j.entries.iter().enumerate() {
            progress(
                &mut f,
                "switching",
                &format!("正在切换 {}", e.name),
                i,
                j.entries.len(),
            );
            let live = guarded_root(&project, &e.name)?;
            if fingerprint(&live)? != e.original {
                return Err(format!("备份后文件发生变化：{}", e.name));
            }
            if e.original.is_some() {
                mv(&live, &run.join("displaced").join(&e.name))?;
            }
            if e.next.is_some() {
                mv(&stage.join(&e.name), &live)?;
            }
        }
        for e in &j.entries {
            if fingerprint(&project.join(&e.name))? != e.next {
                return Err(format!("切换后校验失败：{}", e.name));
            }
        }
        for n in LEGACY {
            if exists(&project.join(n))? {
                return Err(format!("项目中仍有旧目录：{n}"));
            }
        }
        Ok(())
    })();
    if let Err(e) = switch {
        restore(&project, &ext, &mut j, &mut f).map_err(|r| format!("{e}；恢复尚未完成：{r}"))?;
        return Err(e);
    }
    j.status = "committed".into();
    atomic_json(&ext.join("state.json"), &j)?;
    progress(
        &mut f,
        "cleanup",
        "校验已通过，正在清理备份和暂存文件",
        0,
        0,
    );
    finalize(ext, &j)?;
    progress(&mut f, "completed", "已完成迁移及最终校验", 1, 1);
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("小说测试");
        for (name, text) in [
            ("QM/chapters/正文.md", "正文"),
            ("QM/tracking/上下文.md", "作者备注"),
            ("QM/tracking/时间线.md", "派生时间线"),
            (".novel/fanfic-canon.md", "原著规则"),
            (".qm/breakpoint.json", "null"),
            ("retrieval/volume-1.md", "人工备注"),
            (".qmai/context-cache/v2/manifest.json", "{}"),
            (".qmai/memory-cleanup-history/1/backup.json", "{}"),
            (
                ".qmai/chat.json",
                r#"{"title":".novel/原话","filePath":".novel/fanfic-canon.md"}"#,
            ),
            (".gitignore", ".novel/*\n!.novel/fanfic-canon.md\n.qmai/\n"),
        ] {
            let f = p.join(name);
            fs::create_dir_all(f.parent().unwrap()).unwrap();
            fs::write(f, text).unwrap();
        }
        (dir, p.canonicalize().unwrap())
    }
    fn worker(p: &Path) -> Result<()> {
        assert!(p.join("QM/chapters/正文.md").is_file());
        assert!(p.join("QM/memory/writing-progress.md").is_file());
        fs::write(p.join("QM/memory/timeline.md"), "重建").map_err(ioerr)
    }
    #[test]
    fn dry_run_does_not_touch_project_or_parent() {
        let (_dir, p) = fixture();
        let old = fingerprint(&p).unwrap();
        let report = run(&p, Mode::DryRun, |_| (), worker).unwrap();
        assert!(report.changes.contains(&".qm".to_owned()));
        assert_eq!(fingerprint(&p).unwrap(), old);
        assert!(!external(&p).exists());
    }
    #[test]
    fn missing_manifest_in_existing_layout_is_not_silently_written() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".qmai/novel")).unwrap();
        assert!(run(dir.path(), Mode::Apply, |_| (), |_| panic!()).is_err());
        assert!(!dir.path().join(FORMAT_FILE).exists());
    }
    #[test]
    fn reject_unreadable_or_newer_format_before_migration() {
        let (_dir, p) = fixture();
        let marker = p.join(FORMAT_FILE);
        fs::create_dir_all(marker.parent().unwrap()).unwrap();
        for contents in [r#"{"version":2}"#, r#"{"version":"1"}"#, "{}"] {
            fs::write(&marker, contents).unwrap();
            let before = fingerprint(&p).unwrap();
            assert!(inspect(&p).is_err());
            assert!(run(&p, Mode::Apply, |_| (), |_| panic!()).is_err());
            assert_eq!(fingerprint(&p).unwrap(), before);
            assert!(!external(&p).exists());
        }
    }
    #[test]
    fn migration_preserves_content_and_discards_its_working_files() {
        let (_dir, p) = fixture();
        run(&p, Mode::Apply, |_| (), worker).unwrap();
        assert_eq!(project_format(&p).unwrap(), Some(CURRENT_FORMAT));
        assert!(!inspect(&p).unwrap().required);
        assert!(!p.join(".qmai/context-cache").exists());
        assert!(!p.join(".qmai/memory-cleanup-history").exists());
        assert_eq!(
            fs::read_to_string(p.join(".qmai/retrieval/volume-1.md")).unwrap(),
            "人工备注"
        );
        let chat = fs::read_to_string(p.join(".qmai/chat.json")).unwrap();
        assert!(chat.contains(".novel/原话"));
        assert!(chat.contains(".qmai/novel/fanfic-canon.md"));
        assert!(run(&p, Mode::Apply, |_| (), |_| panic!())
            .unwrap()
            .changes
            .is_empty());
        assert!(run(&p, Mode::Rollback, |_| (), |_| panic!()).is_err());
        assert!(journal(&p).unwrap().is_none());
        assert!(!external(&p).exists());
    }
    #[test]
    fn only_known_generated_outputs_are_retired() {
        use serde_json::json;
        let (_dir, p) = fixture();
        let output = p.join(".novel/chapter-ingest-output");
        fs::create_dir_all(&output).unwrap();
        let patch = |n: i64| json!({"sharedWiki":true,"entries":[{"entryId":format!("chapter:{n}"),"entryType":"chapter","title":"章","mergeStrategy":"merge-by-entry-id","fields":{},"sources":[{"chapterNumber":n,"snapshotId":format!("chapter-{n}")}]}]});
        let output_json = |n: i64| json!({"snapshotWikiFields":{"chapterNumber":n},"wikiUpdatePatch":patch(n),"graphDerivation":{"nodes":[],"edges":[]}});
        let search = json!({"documentId":"chapter:1","title":"章","sections":[]});
        let vector = json!({"documentId":"chapter:1","chunks":[]});
        let mut positive = output_json(1);
        positive["searchIndexText"] = search.clone();
        positive["vectorIndexText"] = vector.clone();
        positive["other"] = json!("作者的扩展字段");
        for (name, data) in [
            ("001.search-index.json", search),
            ("001.vector-index.json", vector),
            ("001.output.json", positive),
            ("-3.output.json", output_json(-3)),
            ("-3.wiki-patch.json", patch(-3)),
        ] {
            fs::write(output.join(name), data.to_string()).unwrap();
        }
        let community = p.join(".novel/community-summaries");
        fs::create_dir(&community).unwrap();
        fs::write(community.join("5.json"),json!({"communityId":5,"nodeCount":6,"summary":"摘要","generatedAt":"时间","topNodes":[]}).to_string()).unwrap();
        fs::write(p.join(".qmai/ingest-cache.json"), r#"{"entries":{}}"#).unwrap();
        fs::write(p.join(".qmai/dedup-queue.json"), "待执行").unwrap();
        fs::write(p.join(".qmai/.作者.tmp"), "私有备忘").unwrap();
        let snapshots = p.join(".novel/snapshots");
        fs::create_dir(&snapshots).unwrap();
        let original = "{  \"filePath\": \".novel/历史资料\",
 \"summary\": \"原文\"  }";
        fs::write(snapshots.join("001.snapshot.json"), original).unwrap();
        let report = run(&p, Mode::Apply, |_| (), worker).unwrap();
        assert_eq!(report.retired_artifacts.len(), 8);
        assert!(report.retired_artifacts.values().all(|n| *n == 1));
        assert_eq!(
            fs::read_dir(p.join(".qmai/novel/chapter-ingest-output"))
                .unwrap()
                .count(),
            1
        );
        let positive: serde_json::Value = serde_json::from_slice(
            &fs::read(p.join(".qmai/novel/chapter-ingest-output/001.output.json")).unwrap(),
        )
        .unwrap();
        assert!(
            positive.get("searchIndexText").is_none() && positive.get("vectorIndexText").is_none()
        );
        assert_eq!(positive["other"], "作者的扩展字段");
        assert!(!p.join(".qmai/novel/community-summaries").exists());
        assert_eq!(
            fs::read_to_string(p.join(".qmai/novel/snapshots/001.snapshot.json")).unwrap(),
            original
        );
        assert_eq!(
            fs::read_to_string(p.join(".qmai/dedup-queue.json")).unwrap(),
            "待执行"
        );
        assert!(p.join(".qmai/.作者.tmp").exists());
    }
    #[test]
    fn unexpected_content_in_retired_cache_aborts_before_switch() {
        let (_dir, p) = fixture();
        let output = p.join(".novel/chapter-ingest-output");
        fs::create_dir(&output).unwrap();
        fs::write(
            output.join("002.search-index.json"),
            r#"{"authorNote":"唯一副本"}"#,
        )
        .unwrap();
        let old = fingerprint(&p).unwrap();
        let error = run(&p, Mode::Apply, |_| (), |_| panic!()).err().unwrap();
        assert!(error.contains("002.search-index.json"));
        assert_eq!(fingerprint(&p).unwrap(), old);
        assert!(!external(&p).exists());
    }
    #[test]
    fn lock_conflict_and_staging_failure_do_not_change_project() {
        let (_dir, p) = fixture();
        let old = fingerprint(&p).unwrap();
        let lock = acquire_project_session(&p).unwrap();
        assert!(run(&p, Mode::Apply, |_| (), worker).is_err());
        drop(lock);
        assert!(run(&p, Mode::Apply, |_| (), |_| Err("模拟磁盘满".into())).is_err());
        assert_eq!(fingerprint(&p).unwrap(), old);
        assert!(!inspect(&p).unwrap().interrupted);
    }
    #[test]
    fn rollback_skips_completed_project_with_later_edits() {
        let (_dir, p) = fixture();
        run(&p, Mode::Apply, |_| (), worker).unwrap();
        fs::write(p.join("QM/chapters/正文.md"), "新正文").unwrap();
        assert!(run(&p, Mode::Rollback, |_| (), |_| panic!()).is_err());
        assert_eq!(
            fs::read_to_string(p.join("QM/chapters/正文.md")).unwrap(),
            "新正文"
        );
    }
    #[test]
    fn backup_reports_monotonic_item_progress_for_large_directories() {
        let (_dir, p) = fixture();
        for i in 0..205 {
            fs::write(p.join("QM/chapters").join(format!("{i}.md")), "正文").unwrap();
        }
        let mut updates = Vec::new();
        run(
            &p,
            Mode::Apply,
            |event| {
                if event.stage == "backup" {
                    updates.push(event);
                }
            },
            worker,
        )
        .unwrap();
        assert!(updates
            .iter()
            .any(|u| u.completed == 100 && u.detail.contains("QM/chapters")));
        assert!(updates.iter().any(|u| u.completed == 200));
        assert!(updates
            .windows(2)
            .all(|u| u[0].total == u[1].total && u[0].completed <= u[1].completed));
        assert_eq!(updates.last().unwrap().completed, updates[0].total);
    }
    #[test]
    fn concurrent_author_edit_aborts_before_switch() {
        let (_dir, p) = fixture();
        let result = run(
            &p,
            Mode::Apply,
            |_| (),
            |stage| {
                fs::write(p.join("QM/chapters/正文.md"), "编辑器刚写入").unwrap();
                worker(stage)
            },
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(p.join("QM/chapters/正文.md")).unwrap(),
            "编辑器刚写入"
        );
        assert!(p.join("QM/tracking").is_dir());
        assert!(!external(&p).exists());
    }
    #[test]
    fn empty_workspace_after_final_unlink_recovers_cleanly() {
        let (_dir, p) = fixture();
        let ext = external(&p);
        fs::create_dir(&ext).unwrap();
        fs::write(ext.join(".qmai-state-interrupted.tmp"), "partial").unwrap();
        assert!(inspect(&p).unwrap().interrupted);
        run(&p, Mode::Rollback, |_| (), |_| panic!()).unwrap();
        assert!(!ext.exists());
        assert!(!inspect(&p).unwrap().interrupted);
    }
    #[test]
    fn corrupt_snapshot_is_reported_and_retained() {
        let (_dir, p) = fixture();
        let snapshots = p.join(".novel/snapshots");
        fs::create_dir_all(&snapshots).unwrap();
        fs::write(snapshots.join("001.snapshot.json"), "{损坏").unwrap();
        let old = fingerprint(&p).unwrap();
        let error = run(&p, Mode::Apply, |_| (), |_| panic!()).err().unwrap();
        assert!(error.contains("001.snapshot.json"));
        assert_eq!(fingerprint(&p).unwrap(), old);
        assert!(!external(&p).exists());
    }
    #[cfg(unix)]
    #[test]
    fn forged_transaction_directory_cannot_escape_library() {
        let (_dir, p) = fixture();
        let elsewhere = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), external(&p)).unwrap();
        assert!(inspect(&p).is_err());
        assert!(run(&p, Mode::Apply, |_| (), worker).is_err());
        assert_eq!(fs::read_dir(elsewhere.path()).unwrap().count(), 0);
    }
    #[test]
    fn crash_after_commit_only_resumes_cleanup() {
        let (_dir, p) = fixture();
        let interrupted = std::panic::catch_unwind(|| {
            run(
                &p,
                Mode::Apply,
                |event| {
                    if event.stage == "cleanup" {
                        panic!("模拟提交后强退")
                    }
                },
                worker,
            )
        });
        assert!(interrupted.is_err());
        let j = journal(&p).unwrap().unwrap();
        assert_eq!(j.status, "committed");
        // A power loss may occur after backup disposal already began.
        fs::remove_dir_all(external(&p).join(&j.run).join("original")).unwrap();
        run(&p, Mode::Rollback, |_| (), |_| panic!()).unwrap();
        assert!(!inspect(&p).unwrap().required);
        assert!(!external(&p).exists());
    }
    #[test]
    fn unknown_author_files_prevent_applying() {
        let (_dir, p) = fixture();
        fs::write(p.join("QM/tracking/笔记.md"), "作者笔记").unwrap();
        assert_eq!(
            run(&p, Mode::DryRun, |_| (), |_| panic!())
                .unwrap()
                .warnings
                .len(),
            1
        );
        assert!(run(&p, Mode::Apply, |_| (), |_| panic!()).is_err());
    }
    #[test]
    fn empty_extraction_caches_do_not_block_or_leave_old_directories() {
        let (_dir, p) = fixture();
        for rel in [
            "QM/tracking/.cache",
            "retrieval/.cache",
            ".novel/snapshots/.cache",
            ".novel/community-summaries/.cache",
            "QM/chapters/.cache",
        ] {
            fs::create_dir_all(p.join(rel)).unwrap();
        }
        let note = p.join("retrieval/.cache/作者备注.txt");
        fs::write(&note, "保留").unwrap();
        assert!(!run(&p, Mode::DryRun, |_| (), worker)
            .unwrap()
            .warnings
            .is_empty());
        assert!(run(&p, Mode::Apply, |_| (), worker).is_err());
        assert_eq!(fs::read_to_string(&note).unwrap(), "保留");
        fs::remove_file(&note).unwrap();
        let active_cache = p.join("QM/chapters/.cache/资料.pdf.txt");
        fs::write(&active_cache, "提取文字").unwrap();
        assert!(run(&p, Mode::DryRun, |_| (), worker)
            .unwrap()
            .warnings
            .is_empty());
        run(&p, Mode::Apply, |_| (), worker).unwrap();
        assert!(!p.join(".qmai/novel/snapshots/.cache").exists());
        assert!(!p.join(".qmai/retrieval/.cache").exists());
        assert_eq!(fs::read_to_string(active_cache).unwrap(), "提取文字");
    }
    #[test]
    fn a_new_author_file_between_preflight_and_backup_survives() {
        let (_dir, p) = fixture();
        let note = p.join(".qm/笔记.txt");
        let result = run(
            &p,
            Mode::Apply,
            |event| {
                if event.stage == "backup" && !note.exists() {
                    fs::write(&note, "备份期间新增").unwrap();
                }
            },
            worker,
        );
        assert!(result.is_err());
        assert_eq!(fs::read_to_string(note).unwrap(), "备份期间新增");
        assert!(!external(&p).exists());
    }
    #[test]
    fn interrupted_switch_can_resume_rollback() {
        let (_dir, p) = fixture();
        let old = fingerprint(&p).unwrap();
        // A simulated hard stop leaves the durable journal and installed files intact.
        let interrupted = std::panic::catch_unwind(|| {
            run(
                &p,
                Mode::Apply,
                |event| {
                    if event.stage == "switching" && event.completed == 2 {
                        panic!("模拟强制退出")
                    }
                },
                worker,
            )
        });
        assert!(interrupted.is_err());
        assert!(inspect(&p).unwrap().interrupted);
        run(&p, Mode::Rollback, |_| (), |_| panic!()).unwrap();
        assert_eq!(fingerprint(&p).unwrap(), old);
    }
}
