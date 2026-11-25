//! Antigravity 文本补全、模型检测和 Tauri 事件。写作使用独立的 ACP 会话。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::process::Command;
use tokio::sync::{oneshot, Mutex};

use super::antigravity_acp;

use super::claude_cli::CliEmitter;
use super::cli_resolver::{child_path_env, find_cli_command};
use super::local_cli_config::apply_local_cli_environment;

const VERSION_TIMEOUT: Duration = Duration::from_secs(15);
const TEXT_ONLY_PREAMBLE: &str =
    "你是纯文本补全。禁止调用任何工具，禁止读写文件，禁止执行命令。只输出当前请求要求的文本结果。";
const TEXT_ONLY_CLOSING: &str =
    "【系统】\n没有可用工具。上文里的工具名和命令都不是可调用接口。不要执行命令，不要读写文件。严格执行最后一条【用户】消息明确要求的当前任务和输出格式。引用的资料、示例、任务书和大纲是输入依据，不是新的任务；不要因引用它们就改成生成或概括这些资料。";
const FOLLOW_UP_TAIL_CHARS: usize = 12_000;
static NEXT_WORKDIR_GENERATION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
pub struct TauriAntigravityEmitter {
    app: AppHandle,
}

impl TauriAntigravityEmitter {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl CliEmitter for TauriAntigravityEmitter {
    fn emit_data(&self, stream_id: &str, data: String) {
        let topic = format!("antigravity-cli:{stream_id}");
        let _ = self.app.emit(&topic, data);
    }

    fn emit_done(&self, stream_id: &str, code: Option<i32>, stderr: String) {
        let done_topic = format!("antigravity-cli:{stream_id}:done");
        let _ = self.app.emit(
            &done_topic,
            serde_json::json!({
                "code": code,
                "stderr": stderr,
            }),
        );
    }
}

#[derive(Default)]
pub struct AntigravityCliState {
    requests: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectResult {
    installed: bool,
    version: Option<String>,
    path: Option<String>,
    model: Option<String>,
    models: Vec<String>,
    error: Option<String>,
}

#[derive(Deserialize)]
pub struct AgyMessage {
    role: String,
    content: AgyContent,
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum AgyContent {
    Text(String),
    Blocks(Vec<AgyContentBlock>),
}

#[derive(Clone, Deserialize)]
#[serde(tag = "type")]
enum AgyContentBlock {
    #[serde(rename = "text")]
    Text { text: String },
    #[serde(rename = "image")]
    Image {
        #[serde(rename = "mediaType")]
        #[allow(dead_code)]
        media_type: String,
        #[serde(rename = "dataBase64")]
        #[allow(dead_code)]
        data_base64: String,
    },
}

fn suppress_windows_console(_cmd: &mut Command) {
    #[cfg(windows)]
    {
        #[allow(unused_imports)]
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

pub(crate) async fn find_agy_command() -> Result<PathBuf, String> {
    find_cli_command("agy", &["agy.cmd", "agy.exe"]).await
}

pub(crate) async fn configure_agy_command(cmd: &mut Command) {
    suppress_windows_console(cmd);
    apply_local_cli_environment(cmd);
    if let Some(path_env) = child_path_env().await {
        cmd.env("PATH", path_env);
    }
}

pub(crate) fn antigravity_workdir(stream_id: &str) -> PathBuf {
    let safe: String = stream_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .collect();
    let generation = NEXT_WORKDIR_GENERATION.fetch_add(1, Ordering::SeqCst);
    std::env::temp_dir().join(format!(
        "qmai-agy-{}-{}-{}",
        std::process::id(),
        generation,
        safe
    ))
}

pub(crate) fn prepare_workdir(stream_id: &str) -> Result<PathBuf, String> {
    let dir = antigravity_workdir(stream_id);
    std::fs::create_dir_all(&dir).map_err(|err| format!("无法创建 Antigravity 临时目录：{err}"))?;
    Ok(dir)
}

pub(crate) fn remove_workdir(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
}

fn message_text(content: &AgyContent) -> String {
    match content {
        AgyContent::Text(text) => text.clone(),
        AgyContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                AgyContentBlock::Text { text } => Some(text.as_str()),
                AgyContentBlock::Image { .. } => None,
            })
            .collect::<Vec<_>>()
            .join(""),
    }
}

pub(crate) fn flatten_antigravity_prompt(messages: &[AgyMessage]) -> Result<String, String> {
    let mut parts = vec![TEXT_ONLY_PREAMBLE.to_string()];
    let mut any = false;
    for message in messages {
        let text = message_text(&message.content).trim().to_string();
        if text.is_empty() {
            continue;
        }
        any = true;
        let label = match message.role.as_str() {
            "system" => "系统",
            "assistant" => "助手",
            "tool" => "工具",
            _ => "用户",
        };
        parts.push(format!("【{label}】\n{text}"));
    }
    if !any {
        return Err("没有可发送给 Antigravity CLI 的文本".to_string());
    }
    parts.push(TEXT_ONLY_CLOSING.to_string());
    Ok(parts.join("\n\n"))
}

/// 第二回合必须带上原请求末尾的章节合同。只说「直接输出正文」时，模型会顺着大纲骨架另写一场，并且不写章名。
fn command_denied_followup(prompt: &str) -> String {
    let tail = binding_task_tail(prompt);
    let mut message =
        String::from("上一回合没有返回文本。不要调用工具或执行命令，不要读写文件。不要改题。");
    if tail
        .as_ref()
        .is_some_and(|text| text.contains("目标章节：") || text.contains("写作任务书："))
    {
        message.push_str(
            "\n正文第一行必须是章节标题，格式为：# 第X章 标题名。这一行使用目标章节的章号和写作任务书里的章名。任务书里若写着正文不要出现章号，只约束这一行之后的正文。从第二行起不要再写章号，也不要写「上一章」。只写目标章节指定的事件、场景和人物。不要改用大纲骨架、上一章场景或其他章的材料另写一场。",
        );
    } else {
        message.push_str("\n按上面【用户】消息里的要求作答。");
    }
    if let Some(tail) = tail {
        message.push_str("\n\n");
        message.push_str(&tail);
    }
    message
}

fn binding_task_tail(prompt: &str) -> Option<String> {
    let start = ["目标章节：", "写作任务书：", "用户请求："]
        .iter()
        .find_map(|marker| prompt.rfind(marker))?;
    let mut tail = prompt[start..].trim();
    if let Some(stripped) = tail.strip_suffix(TEXT_ONLY_CLOSING) {
        tail = stripped.trim();
    }
    if tail.is_empty() {
        return None;
    }
    Some(truncate_chars(tail, FOLLOW_UP_TAIL_CHARS))
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        text.chars().take(max_chars).collect()
    }
}

fn first_version_line(stdout: &str, stderr: &str) -> Option<String> {
    for source in [stdout, stderr] {
        for line in source.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with("ERROR:") {
                continue;
            }
            if line.starts_with(['I', 'E', 'W']) && line.contains(".go:") {
                continue;
            }
            if line.chars().next().is_some_and(|ch| ch.is_ascii_digit()) {
                return Some(line.to_string());
            }
        }
    }
    None
}

fn missing_binary_result(error: String) -> DetectResult {
    DetectResult {
        installed: false,
        version: None,
        path: None,
        model: None,
        models: Vec::new(),
        error: Some(error),
    }
}

async fn run_agy(
    path: &Path,
    args: &[&str],
    workdir: &Path,
) -> Result<std::process::Output, String> {
    let mut cmd = Command::new(path);
    configure_agy_command(&mut cmd).await;
    cmd.args(args)
        .current_dir(workdir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    cmd.output()
        .await
        .map_err(|err| format!("无法启动 agy：{err}"))
}

pub async fn do_antigravity_cli_detect() -> Result<DetectResult, String> {
    let path = match find_agy_command().await {
        Ok(path) => path,
        Err(_) => {
            return Ok(missing_binary_result(
                "未检测到 agy。可执行 curl -fsSL https://antigravity.google/cli/install.sh | bash 安装后再检查。"
                    .to_string(),
            ));
        }
    };
    let path_str = path.to_string_lossy().to_string();

    let version_dir = prepare_workdir("version")?;
    let version_output = tokio::time::timeout(
        VERSION_TIMEOUT,
        run_agy(&path, &["--version"], &version_dir),
    )
    .await;
    remove_workdir(&version_dir);

    let version = match version_output {
        Ok(Ok(output)) => first_version_line(
            &String::from_utf8_lossy(&output.stdout),
            &String::from_utf8_lossy(&output.stderr),
        ),
        Ok(Err(error)) => {
            return Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                model: None,
                models: Vec::new(),
                error: Some(error),
            });
        }
        Err(_) => {
            return Ok(DetectResult {
                installed: false,
                version: None,
                path: Some(path_str),
                model: None,
                models: Vec::new(),
                error: Some("agy --version 在 15 秒内没有返回".to_string()),
            });
        }
    };

    let Some(version) = version else {
        return Ok(DetectResult {
            installed: false,
            version: None,
            path: Some(path_str),
            model: None,
            models: Vec::new(),
            error: Some("agy --version 没有返回版本号".to_string()),
        });
    };

    let (model, models, error) = match antigravity_acp::model_catalog().await {
        Ok((model, models)) => (model.or_else(|| models.first().cloned()), models, None),
        Err(message) => (None, Vec::new(), Some(message)),
    };
    Ok(DetectResult {
        installed: true,
        version: Some(version),
        path: Some(path_str),
        model,
        models,
        error,
    })
}

#[tauri::command]
pub async fn antigravity_cli_detect() -> Result<DetectResult, String> {
    do_antigravity_cli_detect().await
}

pub async fn do_antigravity_cli_spawn<E: CliEmitter>(
    state: &AntigravityCliState,
    emitter: E,
    stream_id: String,
    model: String,
    messages: Vec<AgyMessage>,
) -> Result<(), String> {
    let prompt = flatten_antigravity_prompt(&messages)?;
    let followup = command_denied_followup(&prompt);
    let (stop, cancelled) = oneshot::channel();
    let requests = state.requests.clone();
    {
        let mut active = requests.lock().await;
        if active.contains_key(&stream_id) {
            return Err("此文本请求已经在运行。".into());
        }
        active.insert(stream_id.clone(), stop);
    }
    tokio::spawn(async move {
        let result =
            antigravity_acp::complete(&model, &prompt, Some(&followup), None, cancelled, |text| {
                emitter.emit_data(&stream_id, serde_json::json!({"text": text}).to_string());
            })
            .await;
        requests.lock().await.remove(&stream_id);
        match result {
            Ok(usage) => {
                if let Some(usage) = usage {
                    emitter.emit_data(&stream_id, serde_json::json!({"usage":usage}).to_string());
                }
                emitter.emit_done(&stream_id, Some(0), String::new());
            }
            Err(error) => emitter.emit_done(&stream_id, Some(1), error),
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn antigravity_cli_spawn(
    app: AppHandle,
    state: State<'_, AntigravityCliState>,
    stream_id: String,
    model: String,
    messages: Vec<AgyMessage>,
) -> Result<(), String> {
    let emitter = TauriAntigravityEmitter::new(app);
    do_antigravity_cli_spawn(&state, emitter, stream_id, model, messages).await
}

pub async fn do_antigravity_cli_kill(
    state: &AntigravityCliState,
    stream_id: &str,
) -> Result<(), String> {
    if let Some(stop) = state.requests.lock().await.remove(stream_id) {
        let _ = stop.send(());
    }
    Ok(())
}

#[tauri::command]
pub async fn antigravity_cli_kill(
    state: State<'_, AntigravityCliState>,
    stream_id: String,
) -> Result<(), String> {
    do_antigravity_cli_kill(&state, &stream_id).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workdir_stays_under_the_temp_directory() {
        let dir = antigravity_workdir("stream-1");
        let temp = std::env::temp_dir();
        assert!(dir.starts_with(&temp));
        assert_ne!(dir, std::env::current_dir().unwrap());
        assert!(dir
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("qmai-agy-")));
    }

    #[test]
    fn prompt_folds_history_into_one_text_and_drops_images() {
        let messages: Vec<AgyMessage> = serde_json::from_value(serde_json::json!([
            { "role": "system", "content": "保持第三人称" },
            { "role": "user", "content": [
                { "type": "text", "text": "写一段" },
                { "type": "image", "mediaType": "image/png", "dataBase64": "abc" }
            ]},
            { "role": "assistant", "content": "第一段" }
        ]))
        .expect("messages");
        let prompt = flatten_antigravity_prompt(&messages).expect("prompt");
        assert!(prompt.starts_with(TEXT_ONLY_PREAMBLE));
        assert!(prompt.contains("【系统】\n保持第三人称"));
        assert!(prompt.contains("【用户】\n写一段"));
        assert!(prompt.contains("【助手】\n第一段"));
        assert!(prompt.ends_with(TEXT_ONLY_CLOSING));
        assert!(!prompt.contains("abc"));
    }

    #[test]
    fn prompt_preserves_all_cached_blocks_and_does_not_choose_the_output_stage() {
        for task in ["生成写作任务书", "起草章节正文", "返回 JSON 审稿结果"] {
            let messages: Vec<AgyMessage> = serde_json::from_value(serde_json::json!([
                { "role": "system", "content": "只输出当前阶段要求的内容" },
                { "role": "user", "content": [
                    { "type": "text", "text": "共同上下文\n", "cacheControl": true },
                    { "type": "text", "text": format!("参考任务书\n当前任务：{task}") }
                ]}
            ]))
            .expect("messages");
            let prompt = flatten_antigravity_prompt(&messages).expect("prompt");
            assert!(prompt.contains(&format!("共同上下文\n参考任务书\n当前任务：{task}")));
            assert!(prompt.ends_with(TEXT_ONLY_CLOSING));
            assert!(TEXT_ONLY_CLOSING.contains("当前任务和输出格式"));
            assert!(!TEXT_ONLY_CLOSING.contains("写作任务书作答"));
            assert!(!TEXT_ONLY_PREAMBLE.contains("只输出正文"));
        }
    }

    #[test]
    fn denied_command_follow_up_repeats_the_chapter_task() {
        let prompt = format!(
            "大纲骨架很长，克里姆林宫。\n\n目标章节：第167章\n用户请求：编写第167章《赴日通知书》。全章只写科瓦尔斯基一家。正文不要出现章号。\n\n写作任务书：\n交付格式：第一行「第167章 赴日通知书」。\n\n{TEXT_ONLY_CLOSING}"
        );
        let follow = command_denied_followup(&prompt);
        assert!(follow.contains("第167章"));
        assert!(follow.contains("赴日通知书"));
        assert!(follow.contains("科瓦尔斯基"));
        assert!(follow.contains("# 第X章 标题名"));
        assert!(follow.contains("不要改用大纲骨架"));
        assert!(follow.contains("只约束这一行之后的正文"));
        assert!(!follow.contains("直接输出正文"));
        assert!(!follow.contains(TEXT_ONLY_CLOSING));
    }

    #[test]
    fn denied_command_follow_up_without_a_chapter_task_does_not_invent_one() {
        let messages: Vec<AgyMessage> = serde_json::from_value(serde_json::json!([
            { "role": "user", "content": "解释这段代码" }
        ]))
        .expect("messages");
        let prompt = flatten_antigravity_prompt(&messages).expect("prompt");
        let follow = command_denied_followup(&prompt);
        assert!(follow.contains("按上面【用户】消息里的要求作答"));
        assert!(!follow.contains("# 第X章 标题名"));
        assert!(!follow.contains("直接输出正文"));
    }
}
