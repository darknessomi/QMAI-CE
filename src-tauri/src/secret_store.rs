
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

#[cfg(windows)]
pub(crate) fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{CryptProtectData, CRYPT_INTEGER_BLOB};

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(&mut input, None, None, None, None, 0, &mut output)
            .map_err(|error| format!("系统加密失败：{error}"))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(output.pbData as _)));
        Ok(bytes)
    }
}

#[cfg(windows)]
pub(crate) fn unprotect(payload: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::LocalFree;
    use windows::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    let mut input = CRYPT_INTEGER_BLOB {
        cbData: payload.len() as u32,
        pbData: payload.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(&mut input, None, None, None, None, 0, &mut output)
            .map_err(|error| format!("系统解密失败：{error}"))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(windows::Win32::Foundation::HLOCAL(output.pbData as _)));
        Ok(bytes)
    }
}

#[cfg(not(windows))]
pub(crate) fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
pub(crate) fn unprotect(payload: &[u8]) -> Result<Vec<u8>, String> {
    Ok(payload.to_vec())
}

#[cfg(not(windows))]
pub(crate) fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(windows)]
pub(crate) fn restrict_permissions(_path: &Path) {
    // Windows 侧靠 DPAPI 保护内容，不需要额外 ACL（文件已在应用数据目录内）。
}

/// app-state 单字段加密上限：模型/搜索/网盘配置整块加密，256KB 足够。
const MAX_STATE_SECRET_BYTES: usize = 256 * 1024;

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建密钥目录失败：{error}"))?;
    }
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, bytes).map_err(|error| format!("写入密钥失败：{error}"))?;
    restrict_permissions(&tmp);
    fs::rename(&tmp, path).map_err(|error| format!("保存密钥失败：{error}"))?;
    Ok(())
}

// JEV 与旧版模型配置分别存储，切换检索引擎不会改写旧模型的凭据。
fn jev_config_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|path| path.join("secrets/jev"))
        .map_err(|_| "无法定位 JEV 配置目录".to_string())
}

#[tauri::command]
pub fn jev_config_save<R: Runtime>(app: AppHandle<R>, contents: String) -> Result<(), String> {
    if contents.len() > MAX_STATE_SECRET_BYTES {
        return Err("JEV 配置内容过大".to_string());
    }
    let dir = jev_config_dir(&app)?;
    let envelope = crate::plugins::secret_box::seal(&dir.join("key.bin"), contents.as_bytes())?;
    crate::atomic_file::write_bytes_atomically(&dir.join("config.enc"), envelope.as_bytes())
}

#[tauri::command]
pub fn jev_config_load<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let dir = jev_config_dir(&app)?;
    let envelope = match fs::read_to_string(dir.join("config.enc")) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("无法读取 JEV 配置".to_string()),
    };
    let bytes = crate::plugins::secret_box::open(&dir.join("key.bin"), &envelope)
        .map_err(|_| "JEV 配置无法解密，请重新配置。".to_string())?;
    String::from_utf8(bytes).map(Some).map_err(|_| "JEV 配置格式无效".to_string())
}

/// 模型配置的本地密文文件名。
pub(crate) const MODEL_CONFIGS_FILE: &str = "secrets/model-configs.bin";
/// 单份模型配置上限：10 个 provider 约 10KB，256KB 足够并且能兜住异常膨胀。
const MAX_MODEL_CONFIGS_BYTES: usize = 256 * 1024;

fn model_configs_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|error| format!("无法定位应用数据目录：{error}"))?;
    Ok(base.join(MODEL_CONFIGS_FILE))
}

/// 保存模型配置的密文（Windows 走 DPAPI；其它平台是 0600 文件）。
#[tauri::command]
pub fn model_configs_save<R: Runtime>(app: AppHandle<R>, contents: String) -> Result<(), String> {
    if contents.len() > MAX_MODEL_CONFIGS_BYTES {
        return Err("模型配置内容过大。".to_string());
    }
    let path = model_configs_path(&app)?;
    let protected = protect(contents.as_bytes())?;
    write_atomic(&path, &protected)
}

/// 读取模型配置密文；不存在或解不开都返回 `None`（换机器后就是这种情况）。
#[tauri::command]
pub fn model_configs_load<R: Runtime>(app: AppHandle<R>) -> Result<Option<String>, String> {
    let path = model_configs_path(&app)?;
    let payload = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let plain = match unprotect(&payload) {
        Ok(plain) => plain,
        Err(error) => {
            let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
            let _ = fs::rename(&path, path.with_extension(format!("corrupt-{stamp}")));
            log::warn!("[secret] 无法解密本地模型配置：{error}");
            return Ok(None);
        }
    };
    String::from_utf8(plain)
        .map(Some)
        .map_err(|_| "模型配置内容不是合法文本。".to_string())
}

/// 删除模型配置密文（不存在也算成功）。
#[tauri::command]
pub fn model_configs_clear<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let path = model_configs_path(&app)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除本地模型配置失败：{error}")),
    }
}

// ---------------------------------------------------------------- app-state 敏感字段的透明加密

/// 把一段 JSON 文本加密成 base64 密文（Windows 走 DPAPI）。
///
/// 用于 app-state.json 里的 API Key / WebDAV 密码：前端在写盘前调用、读回时解密，
/// 因此磁盘上不再出现明文凭据。
#[tauri::command]
pub fn state_secret_encrypt(plaintext: String) -> Result<String, String> {
    if plaintext.len() > MAX_STATE_SECRET_BYTES {
        return Err("要加密的内容过长。".to_string());
    }
    let protected = protect(plaintext.as_bytes())?;
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(protected))
}

/// 解密 `state_secret_encrypt` 的产物；解不开返回 `None`（换机器/换用户就是这样）。
#[tauri::command]
pub fn state_secret_decrypt(payload: String) -> Result<Option<String>, String> {
    use base64::Engine as _;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(payload) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(None),
    };
    let plain = match unprotect(&bytes) {
        Ok(plain) => plain,
        Err(error) => {
            log::warn!("[secret] 无法解密 state secret：{error}");
            return Ok(None);
        }
    };
    String::from_utf8(plain)
        .map(Some)
        .map_err(|_| "解密内容不是合法文本。".to_string())
}
