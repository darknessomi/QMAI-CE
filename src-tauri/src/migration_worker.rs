use serde::Deserialize;
use std::{
    ffi::OsString,
    fs,
    io::Write,
    path::{Component, Path},
    process::{Command, Stdio},
};

#[derive(Deserialize)]
struct Projection {
    files: Vec<ProjectedFile>,
}
#[derive(Deserialize)]
struct ProjectedFile {
    path: String,
    contents: Option<String>,
}

fn valid_projection_path(path: &str, removal: bool) -> bool {
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 3
        || Path::new(path)
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return false;
    }
    let leaf = parts[2];
    let volume = leaf
        .strip_prefix("volume-")
        .and_then(|v| v.strip_suffix(".md"))
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|d| d.is_ascii_digit()));
    match (parts[0], parts[1]) {
        (".qmai", "retrieval") => volume || (!removal && leaf == "index.md"),
        (".qmai", "novel") if !removal => matches!(
            leaf,
            "cognition-state.json"
                | "character-states.json"
                | "foreshadowing-tracker.json"
                | "timeline.json"
        ),
        ("QM", "memory") if !removal => matches!(
            leaf,
            "character-states.md"
                | "chapter-snapshots.md"
                | "character-cognition.md"
                | "foreshadowing-tracker.md"
                | "timeline.md"
                | "canon-facts.md"
                | "conflicts.md"
                | "writing-progress.md"
        ),
        _ => false,
    }
}

fn apply_projection(project: &Path, projection: Projection) -> Result<(), String> {
    for file in projection.files {
        if !valid_projection_path(&file.path, file.contents.is_none()) {
            return Err(format!("迁移工具返回了意外的文件路径：{}", file.path));
        }
        let destination = project.join(file.path);
        let parent = destination.parent().ok_or("暂存路径无父目录")?;
        let mut directory = project.to_path_buf();
        for part in parent
            .strip_prefix(project)
            .map_err(|_| "迁移目标超出暂存目录")?
        {
            directory.push(part);
            match fs::symlink_metadata(&directory) {
                Ok(entry) if entry.is_dir() => (),
                Ok(_) => return Err(format!("迁移目标不是普通目录：{}", directory.display())),
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                    fs::create_dir(&directory).map_err(|e| format!("无法准备暂存目录：{e}"))?;
                }
                Err(err) => return Err(format!("读取暂存目录失败：{err}")),
            }
        }
        if let Some(contents) = file.contents {
            let mut builder = tempfile::Builder::new();
            #[cfg(unix)]
            builder.permissions(std::os::unix::fs::PermissionsExt::from_mode(0o666));
            let mut tmp = builder.tempfile_in(parent).map_err(|e| e.to_string())?;
            tmp.write_all(contents.as_bytes())
                .map_err(|e| e.to_string())?;
            #[cfg(unix)]
            match fs::symlink_metadata(&destination) {
                Ok(existing) if existing.is_file() => tmp
                    .as_file()
                    .set_permissions(existing.permissions())
                    .map_err(|e| e.to_string())?,
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => (),
                Ok(_) => return Err(format!("暂存文件类型无效：{}", destination.display())),
                Err(err) => return Err(format!("读取暂存文件权限失败：{err}")),
            }
            tmp.as_file().sync_all().map_err(|e| e.to_string())?;
            tmp.persist(&destination)
                .map_err(|e| format!("写入暂存文件失败：{e}"))?;
        } else {
            fs::remove_file(destination).map_err(|e| format!("移除旧检索分卷失败：{e}"))?;
        }
    }
    Ok(())
}

fn read_permission(path: &Path) -> OsString {
    let mut argument = OsString::from("--allow-fs-read=");
    argument.push(path);
    argument
}

fn run_worker(project: &Path, runtime: &Path) -> Result<(), String> {
    let project = project
        .canonicalize()
        .map_err(|e| format!("暂存目录无效：{e}"))?;
    let runtime = runtime
        .canonicalize()
        .map_err(|e| format!("无法定位迁移计算工具：{e}"))?;
    let executable = runtime.join(if cfg!(windows) { "node.exe" } else { "node" });
    let mut command = Command::new(&executable);
    // Only the Rust process holding the project migration lock may publish
    // writes. Even SIGKILL between spawn and wait cannot leave a writing child.
    command
        .arg("--permission")
        .arg(read_permission(&runtime))
        .arg(read_permission(&project))
        .arg(runtime.join("run.mjs"))
        .arg(&project)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("NODE_V8_COVERAGE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Node installs its own signal handlers at startup. A separate group
        // keeps terminal shortcuts from terminating the projection midway.
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动迁移计算工具 {}：{e}", executable.display()))?;
    // wait_with_output normally closes stdin. Keeping our end alive gives the
    // worker a parent-death signal, including Task Manager and Force Quit.
    let lifetime = child.stdin.take();
    let output = child
        .wait_with_output()
        .map_err(|e| format!("读取迁移计算结果失败：{e}"))?;
    drop(lifetime);
    if !output.status.success() {
        return Err(format!(
            "重建记忆与检索失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let result: Projection =
        serde_json::from_slice(&output.stdout).map_err(|e| format!("无法解析迁移计算结果：{e}"))?;
    apply_projection(&project, result)
}

pub fn refresh_bundled(project: &Path, resource_dir: &Path) -> Result<(), String> {
    run_worker(project, &resource_dir.join("migration/runtime"))
}

// 命令行工具也可从已安装的资源目录运行。
#[allow(dead_code)]
pub fn refresh(project: &Path) -> Result<(), String> {
    let binary = std::env::current_exe().map_err(|e| format!("无法定位迁移命令：{e}"))?;
    let bin = binary.parent().ok_or("迁移命令没有父目录")?;
    let candidates = [
        bin.to_path_buf(),
        bin.join("../Resources"),
        bin.join("../lib/qmai-ce"),
    ];
    for dir in candidates {
        if dir.join("migration/runtime/worker.mjs").is_file() {
            return refresh_bundled(project, &dir);
        }
    }
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"));
        if dev.join("migration/runtime/worker.mjs").is_file() {
            return refresh_bundled(project, dev);
        }
    }
    Err("缺少迁移工作程序，请使用完整安装包或通过项目的迁移脚本运行。".into())
}
