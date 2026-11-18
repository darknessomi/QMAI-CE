//! 首次运行只复制全局配置。书架记录里的路径和项目目录都不改动。
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

use serde_json::Value;

use crate::app_state::{value_has_substance, BAK_FILE_NAME, PRIMARY_FILE_NAME};
use crate::secret_store::MODEL_CONFIGS_FILE;

const IMPORTED: &str = ".original-config-imported-v1";

fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

// 与正常启动的恢复顺序一致，但只读原版文件，不在原目录隔离损坏配置或刷新备份。
fn read_original_state(dir: &Path) -> io::Result<Option<Vec<u8>>> {
    fn parse(bytes: &[u8]) -> Option<Value> {
        serde_json::from_slice::<Value>(bytes)
            .ok()
            .filter(Value::is_object)
    }
    let primary = read_optional(&dir.join(PRIMARY_FILE_NAME))?;
    let parsed = primary.as_deref().and_then(parse);
    if parsed.as_ref().is_some_and(value_has_substance) {
        return Ok(primary);
    }
    let backup = read_optional(&dir.join(BAK_FILE_NAME))?;
    if let Some(value) = backup.as_deref().and_then(parse) {
        if parsed.is_none() || value_has_substance(&value) {
            return Ok(backup);
        }
    }
    if parsed.is_some() || (primary.is_none() && backup.is_none()) {
        return Ok(primary);
    }
    Err(io::Error::new(
        io::ErrorKind::InvalidData,
        "原版全局配置及其备份都无法读取",
    ))
}

fn write_new(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    fs::create_dir_all(parent)?;
    // 临时文件与目标同卷，在 Unix 上自创建起即为 0600。
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    match tmp.persist_noclobber(path) {
        Ok(_) => Ok(()),
        Err(err) if err.error.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(err) => Err(err.error),
    }
}

// 早期 CE 对全新安装和导入都写了同一个标记。升级时只修复有共同来源的配置。
fn same_profile(original: &Value, ce: &Value) -> bool {
    [
        "analytics_device_uuid",
        "lastProject",
        "llmConfig",
        "providerConfigs",
    ]
    .iter()
    .any(|key| {
        original
            .get(key)
            .is_some_and(|v| !v.is_null() && Some(v) == ce.get(key))
    }) || original["projectRegistry"]
        .as_object()
        .is_some_and(|books| {
            books
                .keys()
                .any(|id| ce["projectRegistry"].get(id).is_some())
        })
}

fn ui_record(state: Option<&Value>, _original: &Path) -> Value {
    let Some(state) = state else {
        return serde_json::json!({ "imported": false });
    };
    #[cfg(target_os = "macos")]
    let web = mac_web_preferences(_original);
    #[cfg(not(target_os = "macos"))]
    let web = Value::Null;
    let theme = state["theme__uiTest"].as_str().or(state["theme"].as_str());
    let skin = [state["uiTestSkin"].as_str(), web["skin"].as_str(), theme]
        .into_iter()
        .flatten()
        .find_map(|value| match value {
            "xing" | "dark" => Some("dark"),
            "jing" | "zhi" | "light" => Some("light"),
            _ => None,
        });
    serde_json::json!({ "imported": true, "skin": skin, "guide": web["guide"] })
}

#[cfg(target_os = "macos")]
fn mac_web_preferences(original: &Path) -> Value {
    // 仅访问原版应用的顶层本地来源，跳过其他来源、iframe 和 CE 自身的数据库。
    let Some(library) = original.parent().and_then(Path::parent) else {
        return Value::Null;
    };
    let webkit = library.join("WebKit");
    let mut profiles = vec![(
        "com.qingmuai.writer",
        b"\x05\0\0\0\x01tauri\x09\0\0\0\x01localhost\0".as_slice(),
    )];
    if cfg!(debug_assertions) {
        profiles.insert(
            0,
            (
                "qmai",
                b"\x04\0\0\0\x01http\x09\0\0\0\x01localhost\x01\x8c\x05",
            ),
        );
    }
    for (profile, origin) in profiles {
        let Ok(dirs) = fs::read_dir(webkit.join(profile).join("WebsiteData/Default")) else {
            continue;
        };
        for entry in dirs.flatten() {
            let root = entry.path().join(entry.file_name());
            if fs::read(root.join("origin")).ok().as_deref()
                != Some([origin, origin].concat().as_slice())
            {
                continue;
            }
            let db = root.join("LocalStorage/localstorage.sqlite3");
            if !db.is_file() {
                continue;
            }
            let sql = "SELECT key,hex(value) FROM ItemTable WHERE key IN ('qm-uitest-skin','qmai-guide-v1')";
            let Ok(output) = std::process::Command::new("/usr/bin/sqlite3")
                .args([
                    "-batch",
                    "-init",
                    "/dev/null",
                    "-readonly",
                    "-noheader",
                    "-separator",
                    "|",
                ])
                .arg(db)
                .arg(sql)
                .output()
            else {
                continue;
            };
            if !output.status.success() {
                continue;
            }
            let mut prefs = serde_json::json!({});
            for row in String::from_utf8_lossy(&output.stdout).lines() {
                let Some((key, hex)) = row.split_once('|') else {
                    continue;
                };
                let bytes: Option<Vec<_>> = hex
                    .as_bytes()
                    .chunks_exact(2)
                    .map(|p| u8::from_str_radix(std::str::from_utf8(p).ok()?, 16).ok())
                    .collect();
                let Some(bytes) = bytes else {
                    continue;
                };
                let value = if bytes.contains(&0) {
                    String::from_utf16_lossy(
                        &bytes
                            .chunks_exact(2)
                            .map(|p| u16::from_le_bytes([p[0], p[1]]))
                            .collect::<Vec<_>>(),
                    )
                } else {
                    String::from_utf8_lossy(&bytes).into_owned()
                };
                match key {
                    "qm-uitest-skin" => prefs["skin"] = Value::String(value),
                    "qmai-guide-v1" => {
                        if let Ok(g) = serde_json::from_str::<Value>(&value) {
                            prefs["guide"] = serde_json::json!({"status":g["status"],"stepIndex":g["stepIndex"],"finishedAt":g["finishedAt"]});
                        }
                    }
                    _ => {}
                }
            }
            if prefs["skin"].is_string() || prefs["guide"].is_object() {
                return prefs;
            }
        }
    }
    Value::Null
}

pub fn import_once(
    original: &Path,
    original_local: &Path,
    ce: &Path,
    ce_local: &Path,
) -> io::Result<()> {
    if original == ce || original_local == ce_local {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "CE 与原版配置目录重合",
        ));
    }
    let marker = ce.join(IMPORTED);
    if let Some(mark) = read_optional(&marker)? {
        if mark == b"1" {
            // 用户已在使用 CE；只补界面偏好，不重写两份全局配置。
            let upgrade = || -> io::Result<()> {
                let old =
                    read_original_state(original)?.and_then(|b| serde_json::from_slice(&b).ok());
                let current =
                    read_original_state(ce)?.and_then(|b| serde_json::from_slice(&b).ok());
                let source = old
                    .as_ref()
                    .filter(|s| current.as_ref().is_some_and(|c| same_profile(s, c)));
                crate::atomic_file::write_bytes_atomically(
                    &marker,
                    ui_record(source, original).to_string().as_bytes(),
                )
                .map_err(io::Error::other)
            };
            if let Err(e) = upgrade() {
                log::warn!("补充旧版 CE 界面偏好失败：{e}");
            }
        }
        return Ok(());
    }
    let mut imported = None;
    let state = ce.join(PRIMARY_FILE_NAME);
    if !state.try_exists()? && !ce.join(BAK_FILE_NAME).try_exists()? {
        let settings = read_original_state(original)?;
        // 模型凭据先就位。意外退出后可以重试，已有 CE 文件始终优先。
        let models = ce_local.join(MODEL_CONFIGS_FILE);
        if !models.try_exists()? {
            if let Some(bytes) = read_optional(&original_local.join(MODEL_CONFIGS_FILE))? {
                write_new(&models, &bytes)?;
                imported = Some(serde_json::json!({}));
            }
        }
        if let Some(bytes) = settings {
            write_new(&state, &bytes)?;
            imported = serde_json::from_slice(&bytes).ok();
        }
    }
    write_new(
        &marker,
        ui_record(imported.as_ref(), original)
            .to_string()
            .as_bytes(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn editions_share_the_book_but_each_owns_its_settings_and_credentials() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let original = root.join("original");
        let local = root.join("original-local");
        let ce = root.join("ce");
        let ce_local = root.join("ce-local");
        let book = root.join("我的长篇小说");
        fs::create_dir_all(&book).unwrap();
        let chapter = book.join("第一章.md");
        fs::write(&chapter, "原稿").unwrap();
        let record = json!({"id":"book-1", "name":"我的长篇小说", "path":book});
        let state = json!({
            "recentProjects":[record], "lastProject":record, "projectRegistry":{"book-1":record},
            "projectLastReadChapters":{"book-1":chapter}, "uiBodyFontPx":20, "uiFontSizeScale":1.25
        });
        let bytes = serde_json::to_vec(&state).unwrap();
        write_new(&original.join(PRIMARY_FILE_NAME), &bytes).unwrap();
        let models =
            crate::secret_store::protect(br#"{"custom-test":{"model":"model-1"}}"#).unwrap();
        write_new(&local.join(MODEL_CONFIGS_FILE), &models).unwrap();
        let run = || import_once(&original, &local, &ce, &ce_local).unwrap();
        run();
        let mut imported: Value =
            serde_json::from_slice(&fs::read(ce.join(PRIMARY_FILE_NAME)).unwrap()).unwrap();
        assert_eq!(imported, state);
        assert_eq!(fs::read(ce_local.join(MODEL_CONFIGS_FILE)).unwrap(), models);
        fs::write(
            imported["projectLastReadChapters"]["book-1"]
                .as_str()
                .unwrap(),
            "CE 修改后的正文",
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&chapter).unwrap(), "CE 修改后的正文");
        imported["uiBodyFontPx"] = json!(24);
        fs::write(ce.join(PRIMARY_FILE_NAME), imported.to_string()).unwrap();
        fs::remove_file(ce_local.join(MODEL_CONFIGS_FILE)).unwrap();
        run();
        assert_eq!(fs::read(original.join(PRIMARY_FILE_NAME)).unwrap(), bytes);
        assert_eq!(fs::read(local.join(MODEL_CONFIGS_FILE)).unwrap(), models);
        assert_eq!(
            fs::read_to_string(ce.join(PRIMARY_FILE_NAME)).unwrap(),
            imported.to_string()
        );
        assert!(!ce_local.join(MODEL_CONFIGS_FILE).exists());
    }

    #[test]
    fn recovers_from_original_backup_without_repairing_source_or_overwriting_ce() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let ce = tmp.path().join("ce");
        write_new(&src.join(PRIMARY_FILE_NAME), b"broken").unwrap();
        assert!(import_once(&src, &src, &ce, &ce).is_err());
        assert!(!ce.join(IMPORTED).exists());
        write_new(
            &src.join(BAK_FILE_NAME),
            br#"{"lastProject":{"id":"book-1"}}"#,
        )
        .unwrap();
        import_once(&src, &src, &ce, &ce).unwrap();
        assert_eq!(
            fs::read(ce.join(PRIMARY_FILE_NAME)).unwrap(),
            fs::read(src.join(BAK_FILE_NAME)).unwrap()
        );
        assert_eq!(fs::read(src.join(PRIMARY_FILE_NAME)).unwrap(), b"broken");
        let existing = tmp.path().join("existing");
        write_new(&existing.join(PRIMARY_FILE_NAME), b"{}").unwrap();
        import_once(&src, &src, &existing, &existing).unwrap();
        assert_eq!(fs::read(existing.join(PRIMARY_FILE_NAME)).unwrap(), b"{}");
    }

    #[test]
    fn upgrades_old_marker_without_touching_ce_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let ce = tmp.path().join("ce");
        let old = json!({"theme__uiTest":"dark","projectRegistry":{"shared-book":{}}});
        let current = json!({"theme__uiTest":"light","projectRegistry":{"shared-book":{}}});
        write_new(&src.join(PRIMARY_FILE_NAME), old.to_string().as_bytes()).unwrap();
        write_new(&ce.join(PRIMARY_FILE_NAME), current.to_string().as_bytes()).unwrap();
        write_new(&ce.join(IMPORTED), b"1").unwrap();
        import_once(&src, &src, &ce, &ce).unwrap();
        let record: Value = serde_json::from_slice(&fs::read(ce.join(IMPORTED)).unwrap()).unwrap();
        assert_eq!(record["imported"], true);
        assert_eq!(record["skin"], "dark");
        assert_eq!(
            fs::read_to_string(ce.join(PRIMARY_FILE_NAME)).unwrap(),
            current.to_string()
        );

        let separate = tmp.path().join("separate");
        write_new(&separate.join(PRIMARY_FILE_NAME), br#"{"theme":"light"}"#).unwrap();
        write_new(&separate.join(IMPORTED), b"1").unwrap();
        import_once(&src, &src, &separate, &separate).unwrap();
        let unrelated: Value =
            serde_json::from_slice(&fs::read(separate.join(IMPORTED)).unwrap()).unwrap();
        assert_eq!(unrelated["imported"], false);
    }

    #[test]
    fn fresh_install_does_not_import_an_original_installed_later() {
        let tmp = tempfile::tempdir().unwrap();
        let src = tmp.path().join("src");
        let ce = tmp.path().join("ce");
        import_once(&src, &src, &ce, &ce).unwrap();
        write_new(&src.join(PRIMARY_FILE_NAME), br#"{"theme":"light"}"#).unwrap();
        import_once(&src, &src, &ce, &ce).unwrap();
        assert!(!ce.join(PRIMARY_FILE_NAME).exists());
    }
}
