//! Recognize retired QMAI-generated artifacts by their original writer's
//! filename and JSON shape. Historical IDs are read from the migration input.
//! All changes are made in the transaction's staging tree.
use super::{exists, ioerr, Report, Result};
use serde::{de, Deserialize};
use serde_json::Value;
use std::{fmt, fs, io::BufReader, path::Path};

fn only(v: &Value, names: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.keys().all(|k| names.contains(&k.as_str())))
}
fn rows(v: &Value, valid: impl Fn(&Value) -> bool) -> bool {
    v.as_array().is_some_and(|r| r.iter().all(valid))
}
fn index(v: &Value, chapter: i64, field: &str) -> bool {
    if v["documentId"] != format!("chapter:{chapter}") {
        return false;
    }
    match field {
        "searchIndexText" => {
            only(v, &["documentId", "title", "sections"])
                && v["title"].is_string()
                && rows(&v["sections"], |s| {
                    only(s, &["name", "content", "weight"])
                        && s["name"].is_string()
                        && s["content"].is_string()
                        && s["weight"].is_number()
                })
        }
        "vectorIndexText" => {
            only(v, &["documentId", "chunks"])
                && rows(&v["chunks"], |s| {
                    only(s, &["kind", "text", "metadata"])
                        && s["kind"].is_string()
                        && s["text"].is_string()
                        && only(&s["metadata"], &["chapterNumber", "snapshotId"])
                        && s["metadata"]["chapterNumber"] == chapter
                        && s["metadata"]["snapshotId"].is_string()
                })
        }
        _ => false,
    }
}
fn patch(v: &Value, chapter: i64) -> bool {
    only(v, &["sharedWiki", "entries"])
        && v["sharedWiki"] == true
        && v["entries"]
            .as_array()
            .is_some_and(|entries| !entries.is_empty())
        && rows(&v["entries"], |e| {
            only(
                e,
                &[
                    "entryId",
                    "entryType",
                    "title",
                    "mergeStrategy",
                    "fields",
                    "sources",
                ],
            ) && e["entryId"].is_string()
                && e["fields"].is_object()
                && e["mergeStrategy"] == "merge-by-entry-id"
                && e["sources"].as_array().is_some_and(|s| !s.is_empty())
                && rows(&e["sources"], |s| {
                    s["chapterNumber"] == chapter && s["snapshotId"].is_string()
                })
        })
}
fn invalid(stage: &Path, p: &Path) -> String {
    format!(
        "无法确认旧文件是自动生成的缓存，请检查后重试：{}",
        p.strip_prefix(stage).unwrap_or(p).display()
    )
}
fn read(stage: &Path, p: &Path) -> Result<Value> {
    serde_json::from_slice(&fs::read(p).map_err(ioerr)?).map_err(|_| invalid(stage, p))
}
fn count(report: &mut Report, kind: &str) {
    *report.retired_artifacts.entry(kind.to_owned()).or_default() += 1;
}
fn clean_chapter_outputs(stage: &Path, report: &mut Report) -> Result<()> {
    let dir = stage.join(".qmai/novel/chapter-ingest-output");
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(ioerr)? {
        let p = entry.map_err(ioerr)?.path();
        let Some((number, suffix)) = p
            .file_name()
            .and_then(|s| s.to_str())
            .and_then(|s| s.split_once('.'))
        else {
            continue;
        };
        let Ok(chapter) = number.parse::<i64>() else {
            continue;
        };
        let kind = match suffix {
            "search-index.json" => "searchIndexText",
            "vector-index.json" => "vectorIndexText",
            "wiki-patch.json" if chapter < 0 => "outlineWikiPatch",
            "output.json" => "output",
            _ => continue,
        };
        let mut value = read(stage, &p)?;
        let valid = match kind {
            "outlineWikiPatch" => patch(&value, chapter),
            "output" => {
                let fields = [
                    ("searchIndexText", "embeddedSearchIndex"),
                    ("vectorIndexText", "embeddedVectorIndex"),
                ];
                if chapter >= 0 && fields.iter().all(|(k, _)| value.get(k).is_none()) {
                    continue;
                }
                let valid = value["snapshotWikiFields"]["chapterNumber"] == chapter
                    && patch(&value["wikiUpdatePatch"], chapter)
                    && value["graphDerivation"]["nodes"].is_array()
                    && value["graphDerivation"]["edges"].is_array()
                    && fields
                        .iter()
                        .all(|(k, _)| value.get(k).is_none_or(|v| index(v, chapter, k)));
                if !valid {
                    return Err(invalid(stage, &p));
                }
                if chapter >= 0 {
                    for (field, label) in fields {
                        if value.as_object_mut().unwrap().remove(field).is_some() {
                            count(report, label);
                        }
                    }
                    let bytes = serde_json::to_vec_pretty(&value).map_err(|e| e.to_string())?;
                    fs::write(&p, bytes).map_err(ioerr)?;
                    continue;
                }
                only(
                    &value,
                    &[
                        "snapshotWikiFields",
                        "wikiUpdatePatch",
                        "graphDerivation",
                        "searchIndexText",
                        "vectorIndexText",
                    ],
                )
            }
            _ => index(&value, chapter, kind),
        };
        if !valid {
            return Err(invalid(stage, &p));
        }
        fs::remove_file(&p).map_err(ioerr)?;
        count(
            report,
            if kind == "output" {
                "outlineOutput"
            } else {
                kind
            },
        );
    }
    Ok(())
}

fn serial(id: &str) -> Result<u64> {
    let Some(digits) = id.strip_prefix('F') else {
        return Ok(0);
    };
    if digits.is_empty() || !digits.bytes().all(|n| n.is_ascii_digit()) {
        return Ok(0);
    }
    digits
        .parse()
        .map_err(|_| "伏笔编号过大，无法安全分配新编号。".to_owned())
}

fn tracker_serial(store: &Value) -> Result<u64> {
    let items = store["items"].as_array().ok_or("伏笔记录缺少条目列表。")?;
    let mut highest = match store.get("lastSerial") {
        Some(n) => n.as_u64().ok_or("伏笔编号计数器无效。")?,
        None => 0,
    };
    for item in items {
        highest = highest.max(serial(item["id"].as_str().ok_or("伏笔条目缺少编号。")?)?);
    }
    Ok(highest)
}

// The cleanup undo file can contain hundreds of megabytes of unrelated text.
// Read one entry at a time, recognizing only snapshots of the tracker itself.
fn backup_files_serial<'de, D: de::Deserializer<'de>>(d: D) -> std::result::Result<u64, D::Error> {
    #[derive(Deserialize)]
    struct BackupFile {
        path: String,
        before: Option<String>,
    }
    struct Files;
    impl<'de> de::Visitor<'de> for Files {
        type Value = u64;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("记忆清理备份文件列表")
        }
        fn visit_seq<A: de::SeqAccess<'de>>(
            self,
            mut entries: A,
        ) -> std::result::Result<u64, A::Error> {
            let mut highest = 0;
            while let Some(file) = entries.next_element::<BackupFile>()? {
                if matches!(
                    file.path.as_str(),
                    ".novel/foreshadowing-tracker.json" | ".qmai/novel/foreshadowing-tracker.json"
                ) {
                    if let Some(before) = file.before {
                        let tracker = serde_json::from_str(&before).map_err(de::Error::custom)?;
                        highest = highest.max(tracker_serial(&tracker).map_err(de::Error::custom)?);
                    }
                }
            }
            Ok(highest)
        }
    }
    d.deserialize_seq(Files)
}

fn cleanup_history_serial(source: &Path) -> Result<u64> {
    #[derive(Deserialize)]
    struct Backup {
        version: u32,
        #[serde(deserialize_with = "backup_files_serial")]
        files: u64,
    }
    let mut highest = 0;
    for prefix in [".qmai", ".llm-wiki"] {
        let root = source.join(prefix).join("memory-cleanup-history");
        if !exists(&root)? {
            continue;
        }
        if !fs::symlink_metadata(&root).map_err(ioerr)?.is_dir() {
            return Err(invalid(source, &root));
        }
        for entry in fs::read_dir(&root).map_err(ioerr)? {
            let entry = entry.map_err(ioerr)?;
            if !entry
                .file_name()
                .to_str()
                .and_then(|n| n.split_once('-'))
                .is_some_and(|(stamp, id)| {
                    stamp.len() == 13
                        && stamp.bytes().all(|c| c.is_ascii_digit())
                        && uuid::Uuid::parse_str(id).is_ok()
                })
            {
                continue;
            }
            if !entry.file_type().map_err(ioerr)?.is_dir() {
                return Err(invalid(source, &entry.path()));
            }
            let path = entry.path().join("backup.json");
            if !exists(&path)? {
                continue;
            }
            if !fs::symlink_metadata(&path).map_err(ioerr)?.is_file() {
                return Err(invalid(source, &path));
            }
            let backup: Backup =
                serde_json::from_reader(BufReader::new(fs::File::open(&path).map_err(ioerr)?))
                    .map_err(|e| format!("旧记忆清理备份无效：{}（{e}）", path.display()))?;
            if backup.version != 1 {
                return Err(invalid(source, &path));
            }
            highest = highest.max(backup.files);
        }
    }
    Ok(highest)
}

fn reserve_foreshadowing_ids(stage: &Path, mut highest: u64) -> Result<()> {
    let keep = stage.join(".qmai/foreshadowing-keep.json");
    if exists(&keep)? {
        let groups: Vec<Vec<String>> = serde_json::from_slice(&fs::read(&keep).map_err(ioerr)?)
            .map_err(|_| "伏笔保留组的格式损坏，请修复后重试。".to_owned())?;
        for id in groups.iter().flatten() {
            highest = highest.max(serial(id)?);
        }
    }
    let path = stage.join(".qmai/novel/foreshadowing-tracker.json");
    let mut tracker = if exists(&path)? {
        read(stage, &path)?
    } else {
        serde_json::json!({"items": [], "lastUpdated": ""})
    };
    highest = highest.max(tracker_serial(&tracker)?);
    // The allocator runs in JavaScript and must be able to increment the counter.
    if highest >= (1 << 53) - 1 {
        return Err("伏笔编号超出可安全递增的范围，请检查旧记录后重试。".into());
    }
    if highest > tracker["lastSerial"].as_u64().unwrap_or(0) {
        tracker["lastSerial"] = highest.into();
        fs::write(
            &path,
            serde_json::to_vec(&tracker).map_err(|e| e.to_string())?,
        )
        .map_err(ioerr)?;
    }
    Ok(())
}

pub(super) fn clean(source: &Path, stage: &Path, report: &mut Report) -> Result<()> {
    clean_chapter_outputs(stage, report)?;
    let mut highest = cleanup_history_serial(source)?;
    // Only the old cleanup writer's dated backups are obsolete. An author
    // may also have an unrelated "foreshadowing-..." file in page-history.
    let history = stage.join(".qmai/page-history");
    if history.is_dir() {
        for item in fs::read_dir(&history).map_err(ioerr)? {
            let item = item.map_err(ioerr)?;
            let name = item.file_name();
            let Some(label) = name.to_str().and_then(|s| s.strip_prefix("foreshadowing-")) else {
                continue;
            };
            let stamp = label
                .strip_prefix("rebuild-")
                .or_else(|| label.strip_prefix("bulk-"))
                .unwrap_or(label);
            let pattern = "0000-00-00T00-00-00-000Z";
            if !item.file_type().map_err(ioerr)?.is_dir()
                || stamp.len() != pattern.len()
                || !stamp.bytes().zip(pattern.bytes()).all(|(n, p)| {
                    if p == b'0' {
                        n.is_ascii_digit()
                    } else {
                        n == p
                    }
                })
            {
                continue;
            }
            for backup in fs::read_dir(item.path()).map_err(ioerr)? {
                let backup = backup.map_err(ioerr)?;
                if !matches!(
                    backup.file_name().to_str(),
                    Some(
                        "foreshadowing-tracker.json"
                            | "wiki_tracking_伏笔.md"
                            | "QM_tracking_伏笔.md"
                            | "wiki_memory_foreshadowing-tracker.md"
                            | "QM_memory_foreshadowing-tracker.md"
                            | ".DS_Store"
                    )
                ) || !backup.file_type().map_err(ioerr)?.is_file()
                {
                    return Err(invalid(stage, &backup.path()));
                }
                if backup.file_name() == "foreshadowing-tracker.json" {
                    highest = highest.max(tracker_serial(&read(stage, &backup.path())?)?);
                }
            }
            fs::remove_dir_all(item.path()).map_err(ioerr)?;
            count(report, "foreshadowingCleanupHistory");
        }
    }
    reserve_foreshadowing_ids(stage, highest)?;
    for (name, key) in [
        ("dedup-scan-cache.json", "groups"),
        ("foreshadowing-scan-cache.json", "issues"),
        ("ingest-cache.json", "entries"),
    ] {
        let p = stage.join(".qmai").join(name);
        if !p.exists() {
            continue;
        }
        let v = read(stage, &p)?;
        let known = if key == "entries" {
            only(&v, &[key])
                && v[key].as_object().is_some_and(|m| {
                    m.values().all(|e| {
                        only(e, &["hash", "timestamp", "filesWritten"])
                            && e["hash"].is_string()
                            && e["timestamp"].is_number()
                            && rows(&e["filesWritten"], Value::is_string)
                    })
                })
        } else {
            let fields = if key == "groups" {
                &[
                    "version",
                    "projectId",
                    "scannedAt",
                    "scannedPageCount",
                    "modelId",
                    "mergeModelId",
                    "groups",
                ][..]
            } else {
                &[
                    "version",
                    "projectId",
                    "scannedAt",
                    "scannedItemCount",
                    "currentChapter",
                    "modelId",
                    "applyModelId",
                    "issues",
                ][..]
            };
            only(&v, fields)
                && v["version"] == 1
                && v["projectId"].is_string()
                && v["scannedAt"].is_number()
                && v[key].is_array()
        };
        if !known {
            return Err(invalid(stage, &p));
        }
        fs::remove_file(&p).map_err(ioerr)?;
        count(report, name);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn put(root: &Path, path: &str, data: Value) {
        let dest = root.join(path);
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(dest, data.to_string()).unwrap();
    }

    #[test]
    fn reserve_only_previously_allocated_or_kept_foreshadowing_ids() {
        let tmp = tempfile::tempdir().unwrap();
        let stage = tmp.path().join("stage");
        let source = tmp.path().join("source");
        let current = ".qmai/novel/foreshadowing-tracker.json";
        let keep = ".qmai/foreshadowing-keep.json";
        let history = ".qmai/page-history/foreshadowing-bulk-2026-08-01T10-27-49-235Z/foreshadowing-tracker.json";
        let undo = ".qmai/memory-cleanup-history/1793030278905-cac92a83-18b8-4416-82f2-13fa9cf7393b/backup.json";
        let item = json!({"id":"F98","notes":"人工记录中提到 F9999"});
        put(&stage, current, json!({"items":[item], "lastSerial":90}));
        put(&stage, keep, json!([["F125", "作者自定义编号"]]));
        put(
            &stage,
            history,
            json!({"items":[{"id":"F203"}],"lastSerial":220}),
        );
        put(
            &source,
            undo,
            json!({"version":1,"files":[
                {"path":".novel/foreshadowing-tracker.json","before":json!({"items":[{"id":"F315"}]}).to_string()},
                {"path":"作者备忘/foreshadowing-tracker.json","before":json!({"items":[{"id":"F9998"}]}).to_string()}
            ]}),
        );
        put(
            &stage,
            ".qmai/page-history/foreshadowing-作者笔记/foreshadowing-tracker.json",
            json!({"items":[{"id":"F9997"}]}),
        );
        clean(&source, &stage, &mut Report::default()).unwrap();
        let store = read(&stage, &stage.join(current)).unwrap();
        assert_eq!(store["items"], json!([item]));
        assert_eq!(store["lastSerial"], 315);
        assert!(!stage.join(history).exists());
        assert_eq!(
            read(&stage, &stage.join(keep)).unwrap(),
            json!([["F125", "作者自定义编号"]])
        );

        // Older undo and page copies must not lower an existing counter.
        put(&stage, current, json!({"items":[item], "lastSerial":400}));
        clean(&source, &stage, &mut Report::default()).unwrap();
        assert_eq!(
            read(&stage, &stage.join(current)).unwrap()["lastSerial"],
            400
        );
    }

    #[test]
    fn missing_tracker_keeps_the_maximum_from_history_and_manual_decisions() {
        let tmp = tempfile::tempdir().unwrap();
        let stage = tmp.path();
        fs::create_dir_all(stage.join(".qmai/novel")).unwrap();
        let current = stage.join(".qmai/novel/foreshadowing-tracker.json");
        clean(stage, stage, &mut Report::default()).unwrap();
        assert!(!current.exists());
        put(
            stage,
            ".qmai/foreshadowing-keep.json",
            json!([["F2246", "F2247", "F2248"]]),
        );
        clean(stage, stage, &mut Report::default()).unwrap();
        assert_eq!(read(stage, &current).unwrap()["lastSerial"], 2248);
        put(
            stage,
            ".qmai/page-history/foreshadowing-2026-08-01T10-27-49-235Z/foreshadowing-tracker.json",
            json!({"items":[{"id":"F2657"}]}),
        );
        clean(stage, stage, &mut Report::default()).unwrap();
        let store = read(stage, &current).unwrap();
        assert_eq!(store["lastSerial"], 2657);
        assert_eq!(store["items"], json!([]));
    }
}
