#[path = "../migration_worker.rs"]
mod migration_worker;
#[path = "../project_migration.rs"]
mod project_migration;

use project_migration::{run, Mode};
use std::path::PathBuf;

#[cfg(unix)]
fn protect_terminal_migration() -> Result<(), String> {
    for signal in [libc::SIGINT, libc::SIGQUIT] {
        // SIG_IGN is a fixed POSIX disposition. No Rust code runs in a signal handler.
        if unsafe { libc::signal(signal, libc::SIG_IGN) } == libc::SIG_ERR {
            return Err(format!(
                "无法锁定终端退出：{}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}

#[cfg(windows)]
fn protect_terminal_migration() -> Result<(), String> {
    use windows_sys::Win32::Foundation::ERROR_INVALID_HANDLE;
    use windows_sys::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_C_EVENT,
    };
    unsafe extern "system" fn handle(event: u32) -> i32 {
        i32::from(matches!(event, CTRL_C_EVENT | CTRL_BREAK_EVENT))
    }
    if unsafe { SetConsoleCtrlHandler(Some(handle), 1) } == 0 {
        let err = std::io::Error::last_os_error();
        // A process started without a console cannot receive console Ctrl+C.
        if err.raw_os_error() != Some(ERROR_INVALID_HANDLE as i32) {
            return Err(format!("无法锁定终端退出：{err}"));
        }
    }
    Ok(())
}

fn main() {
    let result = execute();
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn execute() -> Result<(), String> {
    let mut args = std::env::args_os().skip(1);
    let first = args
        .next()
        .ok_or("用法：qmai-migrate [--dry-run|--apply|--rollback] 小说项目目录")?;
    let (mode, path) = match first.to_str() {
        Some("--apply") => (Mode::Apply, args.next()),
        Some("--rollback") => (Mode::Rollback, args.next()),
        Some("--dry-run") => (Mode::DryRun, args.next()),
        Some(flag) if flag.starts_with('-') => {
            return Err("未知选项，请使用 --dry-run、--apply 或 --rollback".into())
        }
        _ => (Mode::DryRun, Some(first)),
    };
    let project = PathBuf::from(path.ok_or("请指定小说项目目录")?);
    if args.next().is_some() {
        return Err("每次迁移只接受一个项目目录".into());
    }
    if mode != Mode::DryRun {
        protect_terminal_migration()?;
        eprintln!("迁移或恢复完成前已锁定正常退出。请勿强制退出、关机或移动项目文件，否则可能导致内容损坏。意外中断后请重新打开项目，或使用 --rollback 恢复。");
    }
    let report = run(
        &project,
        mode,
        |event| {
            if event.total > 0 {
                eprintln!("{}（{}/{}）", event.detail, event.completed, event.total);
            } else {
                eprintln!("{}", event.detail);
            }
        },
        migration_worker::refresh,
    )?;
    println!(
        "{}",
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
    );
    Ok(())
}
