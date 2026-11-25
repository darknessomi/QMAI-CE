use serde_json::Value;
use std::{
    fs,
    io::{self, BufReader, ErrorKind},
    path::Path,
};

const PROJECT_ITEMS: [(&str, bool); 5] = [
    ("lancedb", true),
    ("embedding-index.json", false),
    ("embedding-index.log", false),
    ("dedup-summary-vectors.json", false),
    ("rerank-config.json", false),
];

fn clean_project(project: &Path) -> Result<usize, String> {
    if !project.is_absolute() {
        return Err("项目路径必须是绝对路径".into());
    }
    let root = project
        .canonicalize()
        .map_err(|e| format!("无法定位项目：{e}"))?;
    let dir = root.join(".qmai");
    match dir.canonicalize() {
        Ok(actual) if actual == dir => {}
        Err(e) if e.kind() == ErrorKind::NotFound && !dir.is_symlink() => return Ok(0),
        _ => return Err("无法安全访问项目的 .qmai 目录".into()),
    }
    let mut targets = Vec::new();
    for (name, directory) in PROJECT_ITEMS {
        let path = dir.join(name);
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("无法检查 {name}：{e}")),
        };
        let expected_type = if directory {
            meta.is_dir()
        } else {
            meta.is_file()
        };
        if !expected_type || path.canonicalize().ok().as_ref() != Some(&path) {
            return Err(format!("{name} 类型异常或为符号链接，已停止清理"));
        }
        targets.push((path, name, directory));
    }
    let mut removed = 0;
    for (path, name, directory) in targets {
        let result = if directory {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
        match result {
            Ok(()) => removed += 1,
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => {
                return Err(format!(
                    "已清理 {removed} 项，清理 {name} 失败：{e}。可重试。"
                ))
            }
        }
    }
    Ok(removed)
}

#[derive(Default, serde::Serialize)]
pub struct SummaryCleanup {
    removed: usize,
    skipped: usize,
}

fn is_summary_record(stem: &str, record: &Value) -> bool {
    let Some(fields) = record.as_object() else {
        return false;
    };
    let string_list = |key: &str| {
        record[key]
            .as_array()
            .is_some_and(|items| items.iter().all(Value::is_string))
    };
    let name_matches = match fields.get("memberFingerprint") {
        Some(fingerprint) => {
            stem.len() == 16
                && stem.bytes().all(|c| c.is_ascii_hexdigit())
                && fingerprint.as_str() == Some(stem)
                && string_list("memberIds")
        }
        None => record["communityId"]
            .as_u64()
            .is_some_and(|id| id.to_string() == stem && !fields.contains_key("memberIds")),
    };
    name_matches
        && record["communityId"].is_u64()
        && record["summary"].is_string()
        && record["nodeCount"].is_u64()
        && string_list("topNodes")
        && record["generatedAt"].is_string()
        && fields.keys().all(|key| {
            matches!(
                key.as_str(),
                "communityId"
                    | "summary"
                    | "nodeCount"
                    | "topNodes"
                    | "generatedAt"
                    | "memberFingerprint"
                    | "memberIds"
                    | "memoryCleanupFingerprint"
            )
        })
}

fn clean_summary_dir(dir: &Path, report: &mut SummaryCleanup) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let plausible_name = stem.parse::<u64>().is_ok()
            || (stem.len() == 16 && stem.bytes().all(|c| c.is_ascii_hexdigit()));
        if !plausible_name
            || path.extension().is_none_or(|ext| ext != "json")
            || !entry.file_type()?.is_file()
        {
            report.skipped += 1;
            continue;
        }
        let file = fs::File::open(&path)?;
        match serde_json::from_reader(BufReader::new(file)) {
            Ok(record) if is_summary_record(stem, &record) => {
                fs::remove_file(&path)?;
                report.removed += 1;
            }
            Err(error) if error.is_io() => return Err(error.into()),
            _ => report.skipped += 1,
        }
    }
    // 仅移除空目录，作者放入的其他资料和子目录原地保留。
    match fs::remove_dir(dir) {
        Err(error) if error.kind() == ErrorKind::DirectoryNotEmpty => Ok(()),
        result => result,
    }
}

fn clean_community_summaries(project: &Path) -> Result<SummaryCleanup, String> {
    let mut dirs = Vec::new();
    for relative in [
        ".qmai/novel/community-summaries",
        ".novel/community-summaries",
    ] {
        let dir = project.join(relative);
        match fs::symlink_metadata(&dir) {
            Ok(meta) if meta.is_dir() && dir.canonicalize().ok().as_ref() == Some(&dir) => {
                dirs.push(dir)
            }
            Ok(_) => {
                return Err(format!(
                    "摘要目录 {relative} 类型异常或含符号链接，已停止清理。"
                ))
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {}
            Err(e) => return Err(format!("无法检查摘要目录 {relative}：{e}")),
        }
    }
    let mut report = SummaryCleanup::default();
    for dir in dirs {
        clean_summary_dir(&dir, &mut report).map_err(|e| {
            format!(
                "已清理 {} 份旧社区摘要，清理未完成：{e}。可重试。",
                report.removed
            )
        })?;
    }
    Ok(report)
}

async fn run_project_cleanup<T: Send + 'static>(
    project_path: String,
    clean: fn(&Path) -> Result<T, String>,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = crate::migration_gate::enter_io()?;
        crate::migration_gate::with_open_project(Path::new(&project_path), clean)
    })
    .await
    .map_err(|_| "清理旧检索数据的任务异常终止".to_string())?
}

#[tauri::command]
pub async fn clear_legacy_project_retrieval(project_path: String) -> Result<usize, String> {
    run_project_cleanup(project_path, clean_project).await
}

#[tauri::command]
pub async fn clear_legacy_community_summaries(
    project_path: String,
) -> Result<SummaryCleanup, String> {
    run_project_cleanup(project_path, clean_community_summaries).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn old_summary(id: u64) -> Value {
        json!({"communityId": id, "summary": "群组摘要", "nodeCount": 6, "topNodes": ["甲"], "generatedAt": "时间"})
    }

    #[test]
    fn cleans_both_summary_formats_without_touching_other_project_data() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let empty = clean_community_summaries(&root).unwrap();
        assert_eq!((empty.removed, empty.skipped), (0, 0));
        assert!(!root.join(".qmai").exists());
        let dir = root.join(".qmai/novel/community-summaries");
        let legacy = root.join(".novel/community-summaries");
        let mut record = old_summary(7);
        let fingerprint = "0123456789abcdef";
        record["memberFingerprint"] = json!(fingerprint);
        record["memberIds"] = json!(["甲", "乙"]);
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&legacy).unwrap();
        fs::write(dir.join(format!("{fingerprint}.json")), record.to_string()).unwrap();
        fs::write(legacy.join("7.json"), old_summary(7).to_string()).unwrap();
        let protected = [
            ".qmai/novel/snapshots/001.snapshot.json",
            ".qmai/sag/index-v10.sqlite",
            ".qmai/lancedb/data",
            ".qmai/retrieval/volume-1.md",
            ".qmai/novel/memory-cleanup-history/backup.json",
            "QM/entities/甲.md",
        ];
        for relative in protected {
            let path = root.join(relative);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, "原内容").unwrap();
        }
        let mut annotated = old_summary(9);
        annotated["作者补记"] = json!("保留这份文件");
        let other_files = [
            ("笔记.md", "作者的笔记".to_owned()),
            ("5.json", "{损坏".to_owned()),
            ("8.json", old_summary(7).to_string()),
            ("9.json", annotated.to_string()),
            ("fedcba9876543210.json", record.to_string()),
            ("6.json", json!({"summary":"章节摘要"}).to_string()),
        ];
        for (name, content) in &other_files {
            fs::write(dir.join(name), content).unwrap();
        }
        fs::create_dir(dir.join("子目录")).unwrap();
        fs::write(dir.join("子目录/7.json"), old_summary(7).to_string()).unwrap();
        let report = clean_community_summaries(&root).unwrap();
        assert_eq!(report.removed, 2);
        assert_eq!(report.skipped, other_files.len() + 1);
        assert!(!legacy.exists());
        assert!(!dir.join(format!("{fingerprint}.json")).exists());
        for (name, content) in other_files {
            assert_eq!(fs::read_to_string(dir.join(name)).unwrap(), content);
        }
        assert!(dir.join("子目录/7.json").is_file());
        for relative in protected {
            assert_eq!(fs::read_to_string(root.join(relative)).unwrap(), "原内容");
        }
        assert_eq!(clean_community_summaries(&root).unwrap().removed, 0);
    }

    #[cfg(unix)]
    #[test]
    fn summary_cleanup_rejects_linked_dirs_and_preserves_linked_files() {
        use std::os::unix::fs::symlink;
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let external = outside.path().join("community-summaries");
        fs::create_dir(&external).unwrap();
        fs::write(external.join("1.json"), old_summary(1).to_string()).unwrap();
        let dir = root.join(".qmai/novel/community-summaries");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("2.json"), old_summary(2).to_string()).unwrap();
        symlink(outside.path(), root.join(".novel")).unwrap();
        assert!(clean_community_summaries(&root).is_err());
        assert!(dir.join("2.json").exists());
        fs::remove_file(root.join(".novel")).unwrap();
        symlink(external.join("1.json"), dir.join("1.json")).unwrap();
        let report = clean_community_summaries(&root).unwrap();
        assert_eq!((report.removed, report.skipped), (1, 1));
        assert!(dir.join("1.json").is_symlink());
        assert!(external.join("1.json").exists());
    }

    #[test]
    fn cleans_only_legacy_items_and_can_retry() {
        let project = tempfile::tempdir().unwrap();
        let dir = project.path().join(".qmai");
        assert_eq!(clean_project(project.path()).unwrap(), 0);
        for path in ["sag", "retrieval", "lancedb/wiki_vectors.lance"] {
            fs::create_dir_all(dir.join(path)).unwrap();
        }
        for name in [
            "sag/index-v10.sqlite",
            "retrieval/entries.json",
            "novel-config.json",
            "lancedb/wiki_vectors.lance/data",
            "embedding-index.json",
            "embedding-index.log",
            "dedup-summary-vectors.json",
            "rerank-config.json",
        ] {
            fs::write(dir.join(name), name).unwrap();
        }
        assert_eq!(clean_project(project.path()).unwrap(), 5);
        assert_eq!(clean_project(project.path()).unwrap(), 0);
        for name in [
            "sag/index-v10.sqlite",
            "retrieval/entries.json",
            "novel-config.json",
        ] {
            assert_eq!(fs::read_to_string(dir.join(name)).unwrap(), name);
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_linked_metadata_dir_or_target_before_deleting() {
        use std::os::unix::fs::symlink;
        let project = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("rerank-config.json"), "outside").unwrap();
        let dir = project.path().join(".qmai");
        symlink(outside.path(), &dir).unwrap();
        assert!(clean_project(project.path()).is_err());
        fs::remove_file(&dir).unwrap();
        fs::create_dir_all(dir.join("lancedb")).unwrap();
        symlink(
            outside.path().join("rerank-config.json"),
            dir.join("rerank-config.json"),
        )
        .unwrap();
        assert!(clean_project(project.path()).is_err());
        assert!(dir.join("lancedb").is_dir());
        assert!(outside.path().join("rerank-config.json").is_file());
    }
}
