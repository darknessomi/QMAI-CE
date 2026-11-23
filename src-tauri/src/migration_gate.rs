//! Desktop-only coordination. The layout converter itself also runs without a WebView.
use crate::project_migration::{self, Mode};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex};
use tauri::{AppHandle, Emitter, Manager};

const BUSY: &str = "小说项目正在迁移，完成前无法操作或退出。";
const EVENT: &str = "novel-migration-state";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    path: PathBuf,
    phase: &'static str,
    stage: String,
    detail: String,
    completed: usize,
    total: usize,
    can_leave: bool,
    io_frozen: bool,
}

impl View {
    fn preparing(path: PathBuf) -> Self {
        Self {
            path,
            phase: "preparing",
            stage: "正在准备迁移".into(),
            detail: String::new(),
            completed: 0,
            total: 0,
            can_leave: false,
            io_frozen: false,
        }
    }
}

#[derive(Default)]
struct Gate {
    view: Option<View>,
    frozen: bool,
    requests: usize,
    worker_active: bool,
    exiting: bool,
}

static GATE: Mutex<Gate> = Mutex::new(Gate {
    view: None,
    frozen: false,
    requests: 0,
    worker_active: false,
    exiting: false,
});
static IDLE: Condvar = Condvar::new();
static SESSION: Mutex<Option<(PathBuf, fs::File)>> = Mutex::new(None);

pub fn retain_session(path: &Path) -> Result<(), String> {
    let path = fs::canonicalize(path).map_err(|e| format!("无法定位项目：{e}"))?;
    let mut current = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    if current.as_ref().is_some_and(|(old, _)| old == &path) {
        return crate::commands::project::validate_wiki_project_root(&path);
    }
    let lock = project_migration::acquire_project_session(&path)?;
    let state = project_migration::inspect(&path)?;
    if state.required || state.interrupted {
        return Err("此项目须先完成迁移。".into());
    }
    // Validation can initialize schema.md and QM. Keep both projects locked
    // until it succeeds, so a failed switch leaves the current book protected.
    crate::commands::project::validate_wiki_project_root(&path)?;
    // A Markdown folder opened as a new novel has no novel storage yet.
    if !path.join(".qmai/novel").exists() {
        project_migration::write_current_format(&path)?;
    }
    *current = Some((path, lock));
    Ok(())
}

pub fn rename_with_session(source: &Path, destination: &Path) -> Result<(), String> {
    let original = source
        .canonicalize()
        .map_err(|e| format!("无法定位原项目：{e}"))?;
    let parent = destination.parent().ok_or("项目路径无父目录")?;
    let name = destination.file_name().ok_or("新项目名无效")?;
    let target = parent
        .canonicalize()
        .map_err(|e| format!("无法定位项目父目录：{e}"))?
        .join(name);
    let mut session = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    let next = project_migration::reserve_session_destination(parent, name)?;
    fs::rename(&original, &target).map_err(|e| format!("重命名小说失败：{e}"))?;
    if session
        .as_ref()
        .is_some_and(|(active, _)| active == &original)
    {
        *session = Some((target, next));
    }
    Ok(())
}

#[tauri::command]
pub fn release_project_session() {
    SESSION.lock().unwrap_or_else(|e| e.into_inner()).take();
}

#[tauri::command]
pub fn reserve_window_exit() -> bool {
    let mut gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
    if gate.view.is_some() {
        return false;
    }
    gate.exiting = true;
    true
}

#[tauri::command]
pub fn cancel_window_exit() {
    GATE.lock().unwrap_or_else(|e| e.into_inner()).exiting = false;
}

pub fn locked() -> bool {
    GATE.lock()
        .unwrap_or_else(|e| e.into_inner())
        .view
        .is_some()
}

pub fn allow_command(name: &str) -> bool {
    let gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
    if gate.view.is_some()
        && matches!(
            name,
            "open_project"
                | "create_project"
                | "rename_project"
                | "move_project_to_system_trash"
                | "import_backup"
                | "export_backup"
                | "open_reader_window"
                | "plugins_set_project"
                | "release_project_session"
        )
    {
        return false;
    }
    !gate.frozen
        || matches!(
            name,
            "novel_migration_status"
                | "inspect_novel_migration"
                | "run_novel_migration"
                | "leave_novel_migration"
                | "fail_novel_migration_preparation"
                | "mcp_respond"
                | "log_error"
                | "log_diagnostic"
        )
}

pub struct IoLease;
impl Drop for IoLease {
    fn drop(&mut self) {
        let mut gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        gate.requests -= 1;
        if gate.requests == 0 {
            IDLE.notify_all()
        }
    }
}
pub fn enter_io() -> Result<IoLease, String> {
    let mut gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
    if gate.frozen {
        return Err(BUSY.into());
    }
    gate.requests += 1;
    Ok(IoLease)
}

fn marker(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("active-novel-migration.json"))
}

pub fn restore_on_start(app: &AppHandle) -> Result<(), String> {
    let bytes = match fs::read(marker(app)?) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(format!("无法读取迁移恢复记录：{e}")),
    };
    let path: PathBuf =
        serde_json::from_slice(&bytes).map_err(|e| format!("迁移恢复记录损坏：{e}"))?;
    GATE.lock().unwrap_or_else(|e| e.into_inner()).view = Some(View::preparing(path));
    Ok(())
}

#[tauri::command]
pub fn novel_migration_status() -> Option<View> {
    GATE.lock().unwrap_or_else(|e| e.into_inner()).view.clone()
}

fn publish(app: &AppHandle) {
    let _ = app.emit(EVENT, novel_migration_status());
}

pub fn warn_exit(app: &AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    let _ = app.emit("novel-migration-exit-blocked", BUSY);
}

#[tauri::command]
pub async fn inspect_novel_migration(
    app: AppHandle,
    path: PathBuf,
) -> Result<Option<View>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        if gate.exiting {
            return Err("应用正在退出。".into());
        }
        if let Some(view) = gate.view.as_ref() {
            return if view.path == path || fs::canonicalize(&path).is_ok_and(|p| p == view.path) {
                Ok(Some(view.clone()))
            } else {
                Err(BUSY.into())
            };
        }
        let path = fs::canonicalize(path).map_err(|e| format!("无法定位项目：{e}"))?;
        let inspection = project_migration::inspect(&path)?;
        if !inspection.interrupted && !inspection.required {
            return Ok(None);
        }
        let encoded = serde_json::to_vec(&path).map_err(|e| e.to_string())?;
        crate::atomic_file::write_bytes_atomically(&marker(&app)?, &encoded)?;
        let view = View::preparing(path);
        gate.view = Some(view.clone());
        drop(gate);
        for (label, window) in app.webview_windows() {
            if label != "main" {
                let _ = window.set_enabled(false);
            }
        }
        publish(&app);
        Ok(Some(view))
    })
    .await
    .map_err(|e| format!("迁移检查失败：{e}"))?
}

fn finish(app: &AppHandle) -> Result<(), String> {
    match fs::remove_file(marker(app)?) {
        Ok(()) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(format!("无法清除迁移恢复记录：{e}")),
    }
    for (label, window) in app.webview_windows() {
        if label != "main" {
            let _ = window.set_enabled(true);
        }
    }
    {
        let mut gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        gate.view = None;
        gate.frozen = false;
        gate.worker_active = false;
    }
    publish(app);
    Ok(())
}

fn failed(app: &AppHandle, message: String, can_leave: bool) {
    let mut gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
    gate.worker_active = false;
    if let Some(view) = gate.view.as_mut() {
        view.phase = "failed";
        view.stage = "迁移未完成".into();
        view.detail = message;
        view.can_leave = can_leave;
    }
    drop(gate);
    publish(app)
}

#[tauri::command]
pub fn fail_novel_migration_preparation(app: AppHandle, detail: String) -> Result<(), String> {
    let path = {
        let mut gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        if gate.worker_active || gate.frozen {
            return Err(BUSY.into());
        }
        let path = gate.view.as_ref().ok_or(BUSY)?.path.clone();
        gate.worker_active = true;
        path
    };
    let safe = project_migration::inspect(&path).is_ok_and(|s| !s.interrupted);
    failed(&app, detail, safe);
    Ok(())
}

#[tauri::command]
pub fn leave_novel_migration(app: AppHandle) -> Result<(), String> {
    let mut gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
    if gate.worker_active
        || !gate
            .view
            .as_ref()
            .is_some_and(|v| v.phase == "failed" && v.can_leave)
    {
        return Err(BUSY.into());
    }
    gate.worker_active = true;
    drop(gate);
    let result = finish(&app);
    if let Err(error) = &result {
        failed(&app, error.clone(), true);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejected_open_keeps_previous_project_locked() {
        let book = tempfile::tempdir().unwrap();
        fs::write(book.path().join("schema.md"), "# 小说").unwrap();
        project_migration::write_current_format(book.path()).unwrap();
        let empty = tempfile::tempdir().unwrap();
        retain_session(book.path()).unwrap();
        assert!(retain_session(empty.path()).is_err());
        let apply = || project_migration::run(book.path(), Mode::Apply, |_| (), |_| Ok(()));
        assert!(apply().is_err());
        release_project_session();
        assert!(apply().is_ok());
    }
}

#[tauri::command]
pub async fn run_novel_migration(app: AppHandle, rollback: bool) -> Result<Vec<String>, String> {
    let path = {
        let mut gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        if gate.worker_active {
            return Err(BUSY.into());
        }
        let view = gate.view.as_mut().ok_or("当前没有待迁移项目。")?;
        view.phase = "running";
        view.io_frozen = true;
        view.can_leave = false;
        view.detail.clear();
        view.stage = "正在等待已有读写完成".into();
        let path = view.path.clone();
        gate.worker_active = true;
        gate.frozen = true;
        path
    };
    publish(&app);
    let worker = app.clone();
    let target = path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<String>, String> {
        let gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        drop(
            IDLE.wait_while(gate, |g| g.requests != 0)
                .unwrap_or_else(|e| e.into_inner()),
        );
        let resource_dir = worker.path().resource_dir().map_err(|e| e.to_string())?;
        let run = |mode| {
            project_migration::run(
                &target,
                mode,
                |progress| {
                    let mut gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
                    if let Some(view) = gate.view.as_mut() {
                        view.stage = match progress.stage.as_str() {
                            "backup" => "备份原项目",
                            "cleanup" => "清理迁移临时数据",
                            "scanning" => "检查项目",
                            "staging" => "准备新版文件",
                            "rebuilding" => "重建记忆与检索",
                            "verifying" => "校验文件",
                            "switching" => "切换项目目录",
                            "restoring" => "恢复原项目",
                            "completed" => "迁移完成",
                            _ => "正在迁移",
                        }
                        .into();
                        view.detail = progress.detail;
                        view.completed = progress.completed;
                        view.total = progress.total;
                    }
                    drop(gate);
                    publish(&worker)
                },
                |staging| crate::migration_worker::refresh_bundled(staging, &resource_dir),
            )
            .map(|report| report.warnings)
        };
        let state = project_migration::inspect(&target)?;
        if rollback || state.interrupted {
            run(Mode::Rollback)?;
        }
        let warnings = if !rollback && project_migration::inspect(&target)?.required {
            run(Mode::Apply)?
        } else {
            Vec::new()
        };
        let verified = project_migration::inspect(&target)?;
        if verified.interrupted || (!rollback && verified.required) {
            return Err("项目结构尚未通过最终校验。".into());
        }
        Ok(warnings)
    })
    .await
    .map_err(|e| format!("迁移任务异常中断：{e}"))
    .and_then(|r| r)
    .and_then(|warnings| finish(&app).map(|()| warnings));
    if let Err(error) = &result {
        let safe = project_migration::inspect(&path).is_ok_and(|s| !s.interrupted);
        failed(&app, error.clone(), safe);
    }
    result
}
