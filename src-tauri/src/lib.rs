mod app_state;
mod atomic_file;
mod ce_import;
mod commands;
mod mcp;
mod migration_gate;
mod migration_worker;
pub mod project_migration;
mod plugins;
#[cfg(target_os = "macos")]
mod macos_window;
mod panic_guard;
mod platform_guard;
mod proxy;
mod secret_store;
mod types;
// 启动前确认系统 WebView2 运行时可用（缺失时中文提示并引导安装）。
// 必须由 `main` 在 `run()` 之前调用：进入 `tauri::Builder` 之后缺失只会变成
// wry 内部一条日志，用户看到的是「双击没反应」。
mod webview2_check;

pub use platform_guard::assert_supported_platform;
#[cfg(windows)]
pub use webview2_check::ensure_webview2_or_guide;

#[tauri::command]
fn set_proxy_env(config: proxy::ProxyConfig) -> String {
    let summary = proxy::apply_proxy_env(&config);
    eprintln!("[proxy] live update: {summary}");
    summary
}

#[tauri::command]
fn log_error(message: String, stack: String, component_stack: String) {
    eprintln!("[frontend-error] message: {}", message);
    if !stack.is_empty() {
        eprintln!("[frontend-error] stack: {}", stack);
    }
    if !component_stack.is_empty() {
        eprintln!("[frontend-error] component-stack: {}", component_stack);
    }
}

#[tauri::command]
fn log_diagnostic(message: String) {
    eprintln!("[frontend-diagnostic] message: {}", message);
}

#[tauri::command]
fn restore_macos_window_frame(window: tauri::WebviewWindow) {
    #[cfg(not(target_os = "macos"))]
    let _ = window;
    #[cfg(target_os = "macos")]
    {
        let cloned = window.clone();
        if let Err(error) = window.run_on_main_thread(move || {
            if let Ok(ptr) = cloned.ns_window() {
                macos_window::restore_overlay_frame(ptr);
            }
        }) {
            eprintln!("[window] 恢复 macOS 圆角失败：{error}");
        }
    }
}

#[cfg(target_os = "macos")]
fn macos_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{AboutMetadata, Menu, MenuItemKind, PredefinedMenuItem};

    let menu = Menu::default(app)?;
    // Tauri 默认菜单的第一项是应用菜单，首项为原生「关于」。
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.first() {
        // Tauri 生成运行时配置时会省略 bundle.copyright。
        let macos_config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.macos.conf.json"))?;
        let icon = image::load_from_memory(include_bytes!("../icons/128x128@2x.png"))
            .map_err(std::io::Error::other)?
            .into_rgba8();
        let (width, height) = icon.dimensions();
        let package = app.package_info();
        let about = PredefinedMenuItem::about(
            app,
            Some(&format!("关于 {}", package.name)),
            Some(AboutMetadata {
                name: Some(package.name.clone()),
                version: Some(package.version.to_string()),
                copyright: macos_config["bundle"]["copyright"].as_str().map(str::to_owned),
                icon: Some(tauri::image::Image::new_owned(icon.into_raw(), width, height)),
                ..Default::default()
            }),
        )?;
        app_menu.remove_at(0)?;
        app_menu.insert(&about, 0)?;
    }
    Ok(menu)
}

pub fn run() {
    if mcp::stdio_requested() {
        mcp::run_stdio();
        return;
    }
    // 必须在 build() 之前：wry 建窗失败只走 log::error!，不装接收器就永远查不到原因。
    commands::reader_window::init_diagnostics();
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(macos_menu);
    builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::Manager;
            if let Some(window) = app.get_webview_window("main") {
                #[cfg(target_os = "macos")]
                if let Ok(ptr) = window.ns_window() {
                    macos_window::restore_overlay_frame(ptr);
                }
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // 单实例检查之后、任何窗口或配置存储打开之前完成首次导入。
        .plugin(tauri::plugin::Builder::<_, ()>::new("ce-import")
            .setup(|app, _| {
                use tauri::Manager;
                let paths = app.path();
                let original_id = &app.config().identifier;
                ce_import::import_once(
                    &paths.data_dir()?.join(original_id),
                    &paths.local_data_dir()?.join(original_id),
                    &paths.app_data_dir()?,
                    &paths.app_local_data_dir()?,
                ).map_err(|e| format!("首次导入全局配置失败：{e}"))?;
                Ok(())
            }).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            use tauri::Manager;
            if let Ok(dir) = app.path().resource_dir() {
                commands::fs::set_resource_dir_hint(dir);
            }
            migration_gate::restore_on_start(app.handle()).map_err(std::io::Error::other)?;
            app_state::prepare_app_state_store(app.handle());
            if let Ok(dir) = app.path().app_data_dir() {
                let store_path = dir.join("app-state.json");
                eprintln!("[proxy] reading from {}", store_path.display());
                let summary = proxy::apply_proxy_env_from_store(&store_path);
                eprintln!("[proxy] {summary}");
            } else {
                eprintln!("[proxy] could not resolve app_data_dir");
            }
            app.manage(commands::antigravity_cli::AntigravityCliState::default());
            app.manage(commands::claude_cli::ClaudeCliState::default());
            app.manage(commands::codex_cli::CodexAppServerState::default());
            app.manage(commands::cursor_cli::CursorProxyState::default());
            app.manage(commands::file_sync::FileSyncState::default());
            app.manage(commands::writing_wake_lock::WritingWakeLockManager::default());
            app.manage(mcp::McpState::default());
            app.manage(plugins::PluginsState::default());
            // 已启用的插件要在启动后自动拉起；放后台任务，不阻塞窗口显示。
            {
                let handle = app.handle().clone();
                // 根目录在同步上下文里取好，任务里只做读注册表 + 起进程。
                let root = plugins::paths::plugins_root();
                tauri::async_runtime::spawn(async move {
                    if let Some(state) = handle.try_state::<plugins::PluginsState>() {
                        if let Err(error) = plugins::autostart_all(state.inner(), &root).await {
                            eprintln!("[plugins] 自动启动失败：{error}");
                        }
                    }
                });
            }
            #[cfg(target_os = "macos")]
            if let Some(window) = app.get_webview_window("main") {
                if let Ok(ptr) = window.ns_window() {
                    macos_window::restore_overlay_frame(ptr);
                }
            }
            // 只有设了 QMAI_READER_SELFTEST 才会真的建窗，平时是空操作。
            commands::reader_window::maybe_run_selftest(app.handle());
            Ok(())
        })
        .invoke_handler({
            let dispatch: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> = Box::new(tauri::generate_handler![
            migration_gate::reserve_window_exit,
            migration_gate::cancel_window_exit,
            migration_gate::inspect_novel_migration,
            migration_gate::novel_migration_status,
            migration_gate::run_novel_migration,
            migration_gate::release_project_session,
            migration_gate::fail_novel_migration_preparation,
            migration_gate::leave_novel_migration,
            commands::fs::read_file,
            commands::fs::read_markdown_batch,
            commands::fs::write_file,
            commands::fs::write_file_if_absent,
            commands::fs::write_export_file,
            commands::fs::write_file_atomic,
            commands::fs::list_directory,
            commands::fs::copy_file,
            commands::fs::copy_directory,
            commands::fs::delete_file,
            commands::fs::move_path_if_absent,
            commands::fs::remove_empty_directory,
            commands::fs::find_related_wiki_pages,
            commands::fs::create_directory,
            commands::fs::file_exists,
            commands::fs::get_file_modified_time,
            commands::fs::get_file_size,
            commands::fs::get_file_md5,
            commands::fs::get_executable_dir,
            commands::fs::get_resource_dir,
            commands::project::create_project,
            commands::project::open_project,
            commands::project::open_project_folder,
            commands::project::rename_project,
            commands::project::move_project_to_system_trash,
            commands::project::save_project_cover,
            commands::project::open_file_location,
            commands::sag::sag_search,
            commands::sag::sag_cancel,
            commands::legacy_retrieval::clear_legacy_project_retrieval,
            commands::legacy_retrieval::clear_legacy_community_summaries,
            app_state::clear_legacy_retrieval_credentials,
            commands::sag::sag_scope_fingerprint,
            commands::sag::sag_test_jev,
            commands::sag::sag_judge_pair,
            commands::reader_window::open_reader_window,
            commands::reader_window::reader_window_log,
            commands::reader_window::reader_window_ready,
            commands::antigravity_agent::antigravity_agent_proxy_ensure,
            commands::antigravity_agent::antigravity_agent_cancel,
            commands::antigravity_cli::antigravity_cli_detect,
            commands::antigravity_cli::antigravity_cli_spawn,
            commands::antigravity_cli::antigravity_cli_kill,
            commands::antigravity_search::antigravity_cli_search,
            commands::claude_cli::claude_cli_detect,
            commands::claude_cli::claude_cli_spawn,
            commands::claude_cli::claude_cli_kill,
            commands::codex_cli::codex_cli_detect,
            commands::codex_cli::codex_app_server_start,
            commands::codex_cli::codex_app_server_write,
            commands::codex_cli::codex_app_server_stop,
            commands::cursor_cli::cursor_cli_detect,
            commands::cursor_cli::cursor_cli_about,
            commands::cursor_cli::cursor_cli_update,
            commands::cursor_cli::cursor_cli_apply_acp_model,
            commands::cursor_cli::cursor_cli_acp_models,
            commands::cursor_cli::cursor_proxy_status,
            commands::cursor_cli::cursor_proxy_ensure,
            commands::cursor_cli::cursor_proxy_stop,
            commands::file_sync::start_project_file_watcher,
            commands::file_sync::stop_project_file_watcher,
            commands::file_sync::rescan_project_files,
            commands::file_sync::get_file_change_queue,
            commands::file_sync::retry_file_change_task,
            commands::file_sync::ignore_file_change_task,
            commands::backup::export_backup,
            commands::backup::import_backup,
            commands::backup::read_backup_manifest,
            app_state::write_app_state_atomic,
            commands::writing_wake_lock::acquire_writing_wake_lock,
            commands::writing_wake_lock::release_writing_wake_lock,
    // 模型配置的本地加密存储（系统凭据加密，替代明文的 app-state.json 副本）。
    secret_store::jev_config_save,
    secret_store::jev_config_load,
    secret_store::model_configs_save,
    secret_store::model_configs_load,
    secret_store::model_configs_clear,
    // app-state 里敏感配置（API Key / WebDAV 密码）的透明加密：磁盘上只留密文。
    secret_store::state_secret_encrypt,
    secret_store::state_secret_decrypt,
            set_proxy_env,
            log_error,
            log_diagnostic,
            restore_macos_window_frame,
            mcp::mcp_set_enabled,
            mcp::mcp_status,
            mcp::mcp_respond,
            mcp::mcp_stdio_executable,
            mcp::resolve_qmai_mcp_skill_dir,
            // 插件管理：列表/安装/启停/卸载，以及运行期工具清单与调用。
            plugins::plugins_list,
            plugins::plugins_install,
            // 从本地目录安装：插件作者在本机迭代、验收时手工装测试插件都走这条。
            plugins::plugins_install_local,
            plugins::plugins_enable,
            plugins::plugins_disable,
            plugins::plugins_uninstall,
            plugins::plugins_tools,
            plugins::plugins_invoke_tool,
            plugins::plugins_shutdown_all,
            // 插件 provider：列表不含 token，token 只在请求前由前端现取。
            plugins::plugins_providers,
            plugins::plugins_provider_auth,
            plugins::plugins_provider_refresh_models,
            // 受控登录窗口（设计 5.1/5.2）：白名单来自清单 authDomains，关窗后自动刷新模型。
            plugins::plugins_provider_open_login,
          plugins::plugins_provider_close_login, // 插件登录完成 → 关窗（触发自动刷新）
            // capabilities 端点代理（设计 4.4）：endpoint 走白名单，不开放任意 URL。
            plugins::plugins_provider_call,
            // 凭据中转（设计 5.3）：paste-token / import-file 都走这里，
            // 插件侧端点固定为 POST /login/credential；QMAI 不落盘、不缓存、不写日志。
            plugins::plugins_provider_submit_credential,
            // 插件配置（设计 §6.3）：读/写按 configSchema 校验；
            // 密钥只写内存（盘上留占位符），读接口永不返回真值。
            plugins::plugins_config_get,
            plugins::plugins_config_set,
            plugins::plugins_config_secret_set,
            plugins::plugins_config_secret_has,
            // 内容包（设计 §4，Tier 1）：纯磁盘数据，宿主自己读、自己校验，
            // 两条命令都不 spawn 插件进程。
            plugins::plugins_content_packs,
            plugins::plugins_content_pack_items,
            // 声明式 action（设计 §3，Tier 1）：同样只读清单，不 spawn 进程。
            // 前端 6 个插槽靠它渲染按钮。
            plugins::plugins_actions,
            // 钩子清单（设计 §5，Phase 3）：结构化契约 + 只读查询，同样不 spawn 进程。
            // 前端要靠它把「这个事件上有哪些钩子在改我的内容」讲清楚。
            plugins::plugins_hooks,
            // 项目读写地基（设计 §7）：前端在「打开/切换/关闭项目」时登记项目根，
            // 插件通过 /host/project/* 读到的是这个动态值（不是启动时固化进会话的值）。
            plugins::plugins_set_project,
            ]);
            move |invoke: tauri::ipc::Invoke<tauri::Wry>| {
                if !migration_gate::allow_command(invoke.message.command()) {
                    invoke.resolver.reject("小说项目正在迁移，完成前无法操作。");
                    return true;
                }
                dispatch(invoke)
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if migration_gate::locked() {
                    use tauri::Manager;
                    api.prevent_close();
                    migration_gate::warn_exit(window.app_handle());
                    return;
                }
            }
            // 独立窗口（label 前缀 reader-）的生死要留痕：用户反馈的是
            // "点开弹一下就没"，光看界面分不出是建窗失败、页面没起来，
            // 还是起来之后被谁关掉了。日志与建窗命令共用一个文件。
            if window.label().starts_with("reader-") {
                let marker = match event {
                    tauri::WindowEvent::CloseRequested { .. } => Some("event CloseRequested"),
                    tauri::WindowEvent::Destroyed => Some("event Destroyed"),
                    _ => None,
                };
                if let Some(marker) = marker {
                    commands::reader_window::log_line(&format!(
                        "{marker} label={}",
                        window.label()
                    ));
                }
            }

            #[cfg(target_os = "macos")]
            if matches!(
                event,
                tauri::WindowEvent::Focused(_)
                    | tauri::WindowEvent::Resized(_)
                    | tauri::WindowEvent::ThemeChanged(_)
                    | tauri::WindowEvent::ScaleFactorChanged { .. }
            ) {
                if let Ok(ptr) = window.ns_window() {
                    macos_window::restore_overlay_frame(ptr);
                }
            }

            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                #[cfg(target_os = "macos")]
                {
                    let _ = window.hide();
                    api.prevent_close();
                }

                #[cfg(not(target_os = "macos"))]
                {
                    use tauri::Manager;
                    // 退出确认与保存统一由前端 onCloseRequested 负责：Tauri 检测到前端注册了
                    // close-requested 监听后会自行 prevent_close，前端确认通过后销毁窗口。
                    // 这里不能再 prevent_close / 弹原生确认框 / destroy，
                    // 否则同一次关闭会先后弹出两个确认框（前端手动 close() 会再次触发本回调）。
                    let _ = api;
                    app_state::persist_app_state_before_exit(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            let msg = format!("应用程序启动失败: {e}");
            eprintln!("{msg}");
            #[cfg(windows)]
            {
                use std::ffi::OsStr;
                use std::os::windows::ffi::OsStrExt;
                extern "system" {
                    fn MessageBoxW(
                        hwnd: *mut std::ffi::c_void,
                        lp_text: *const u16,
                        lp_caption: *const u16,
                        u_type: u32,
                    ) -> i32;
                }
                fn to_wide(s: &str) -> Vec<u16> {
                    OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
                }
                let text = to_wide(&msg);
                let caption = to_wide("启动错误");
                unsafe {
                    MessageBoxW(
                        std::ptr::null_mut(),
                        text.as_ptr(),
                        caption.as_ptr(),
                        0x10,
                    );
                }
            }
            std::process::exit(1);
        })
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = &event {
                if !has_visible_windows {
                    use tauri::Manager;
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            // macOS 红叉只 hide；真正退出（Cmd+Q）必须在这里落盘。
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !migration_gate::reserve_window_exit() {
                    api.prevent_exit();
                    migration_gate::warn_exit(app);
                    return;
                }
                app_state::persist_app_state_before_exit(app);

                // 插件是常驻子进程，必须在进程退出前显式停掉：虽然 Child 设了
                // kill_on_drop，但 App 进程退出时析构顺序不可依赖，漏一个就是孤儿进程。
                use tauri::Manager;
                if let Some(state) = app.try_state::<plugins::PluginsState>() {
                    if let Err(error) =
                        tauri::async_runtime::block_on(plugins::shutdown_all(state.inner()))
                    {
                        eprintln!("[plugins] 退出清理失败：{error}");
                    }
                }
                commands::antigravity_agent::shutdown_antigravity_agent_proxy();
            }
        });
}
