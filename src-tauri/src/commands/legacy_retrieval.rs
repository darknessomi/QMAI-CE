use std::{fs, io::ErrorKind, path::Path};

const PROJECT_ITEMS: [(&str, bool); 4] = [
    ("lancedb", true),
    ("embedding-index.json", false),
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

#[tauri::command]
pub async fn clear_legacy_project_retrieval(project_path: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = crate::migration_gate::enter_io()?;
        crate::migration_gate::with_open_project(Path::new(&project_path), clean_project)
    })
    .await
    .map_err(|_| "清理旧检索数据的任务异常终止".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

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
            "dedup-summary-vectors.json",
            "rerank-config.json",
        ] {
            fs::write(dir.join(name), name).unwrap();
        }
        assert_eq!(clean_project(project.path()).unwrap(), 4);
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
