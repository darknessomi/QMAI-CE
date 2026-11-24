use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(windows)]
fn move_path_windows(source: &Path, destination: &Path, replace: bool) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    #[link(name = "Kernel32")]
    extern "system" {
        fn MoveFileExW(existing: *const u16, new: *const u16, flags: u32) -> i32;
    }

    const MOVEFILE_REPLACE_EXISTING: u32 = 0x1;
    const MOVEFILE_WRITE_THROUGH: u32 = 0x8;
    let existing: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let new: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            existing.as_ptr(),
            new.as_ptr(),
            if replace {
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH
            } else {
                MOVEFILE_WRITE_THROUGH
            },
        )
    };
    if result == 0 {
        Err(format!("移动失败：{}", std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

#[cfg(windows)]
pub fn replace_file_atomically(temp: &Path, destination: &Path) -> Result<(), String> {
    move_path_windows(temp, destination, true)
}

#[cfg(windows)]
pub fn move_path_if_absent(source: &Path, destination: &Path) -> Result<(), String> {
    move_path_windows(source, destination, false)
}

// 系统调用同时判定目标不存在并改名，避免先 exists 再 rename 覆盖并发写入。
#[cfg(any(target_vendor = "apple", target_os = "linux", target_os = "android"))]
pub fn move_path_if_absent(source: &Path, destination: &Path) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let source = CString::new(source.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let destination =
        CString::new(destination.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(target_vendor = "apple")]
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE as _,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(format!("移动失败：{}", std::io::Error::last_os_error()))
    }
}

#[cfg(not(any(windows, target_vendor = "apple", target_os = "linux", target_os = "android")))]
pub fn move_path_if_absent(_: &Path, _: &Path) -> Result<(), String> {
    Err("当前平台不支持安全改名。".to_string())
}

#[cfg(not(windows))]
pub fn replace_file_atomically(temp: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temp, destination).map_err(|e| format!("原子替换文件失败: {e}"))
}

pub fn write_bytes_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    write_bytes_atomically_with_replace(path, bytes, replace_file_atomically)
}

pub fn write_bytes_atomically_with_replace<F>(
    path: &Path,
    bytes: &[u8],
    replace: F,
) -> Result<(), String>
where
    F: FnOnce(&Path, &Path) -> Result<(), String>,
{
    let parent = path
        .parent()
        .ok_or_else(|| "路径缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 '{}': {e}", parent.display()))?;
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "app-state.json".to_string());
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let temp = parent.join(format!(".{file_name}.{stamp}.tmp"));
    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|e| format!("创建临时文件失败 '{}': {e}", temp.display()))?;
        file.write_all(bytes)
            .map_err(|e| format!("写入临时文件失败 '{}': {e}", temp.display()))?;
        file.sync_all()
            .map_err(|e| format!("同步临时文件失败 '{}': {e}", temp.display()))?;
        drop(file);
        replace(&temp, path)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    write_result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn unique_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qmai_atomic_file_{name}_{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn move_without_replacement_preserves_complete_folder_and_existing_targets() {
        let dir = unique_test_dir("move");
        let source = dir.join("原目录");
        let target = dir.join("新目录");
        fs::create_dir_all(source.join(".hidden")).unwrap();
        fs::write(source.join(".hidden/image"), [0xff, 0x00]).unwrap();
        fs::write(source.join("小传.html"), "小传").unwrap();
        fs::create_dir(&target).unwrap();
        assert!(move_path_if_absent(&source, &target).is_err());
        fs::remove_dir(&target).unwrap();
        move_path_if_absent(&source, &target).unwrap();
        assert_eq!(
            fs::read(target.join(".hidden/image")).unwrap(),
            [0xff, 0x00]
        );
        assert_eq!(
            fs::read_to_string(target.join("小传.html")).unwrap(),
            "小传"
        );
        assert!(!source.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn failed_replace_leaves_the_original_file() {
        let dir = unique_test_dir("replace_fail");
        let path = dir.join("app-state.json");
        fs::write(&path, r#"{"llmConfig":{"model":"keep"}}"#).unwrap();

        let result = write_bytes_atomically_with_replace(
            &path,
            br#"{"llmConfig":{"model":"new"}}"#,
            |_temp, _dest| Err("injected replace failure".to_string()),
        );

        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            r#"{"llmConfig":{"model":"keep"}}"#
        );
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files leftover: {leftovers:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn atomic_write_replaces_existing_content() {
        let dir = unique_test_dir("replace_ok");
        let path = dir.join("app-state.json");
        fs::write(&path, "{}").unwrap();
        write_bytes_atomically(&path, br#"{"ok":true}"#).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), r#"{"ok":true}"#);
        let _ = fs::remove_dir_all(&dir);
    }
}
