//! agy ACP v1。每个写作请求使用独立会话；工具结果由同一会话的 HTTP MCP 请求接收。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::oneshot;
use tokio::time::timeout;

use super::antigravity_cli::{check_acp_version, configure_agy_command, find_agy_command, read_agy_version};
use super::antigravity_search::SearchEvidence;
use super::local_cli_config::resolve_home_dir;

// agy 1.5.16 的 ACP session/prompt 仍会在约 192,000 UTF-8 字节处裁掉单条模型输入。
const SINGLE_PROMPT_BYTES: usize = 180_000;
const PART_BYTES: usize = 128_000;
const SETUP_TIMEOUT: Duration = Duration::from_secs(60);
pub(super) const TOOL_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const TURN_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
pub(super) const MCP_NAME: &str = "qmai";

pub(super) struct SessionTools {
    pub url: String,
    pub token: String,
    pub names: HashSet<String>,
    pub enabled: Arc<AtomicBool>,
}

impl SessionTools {
    fn write_config(&self, home: &Path) -> std::io::Result<()> {
        // agy 1.5.16 忽略 ACP mcpServers 中的 timeoutSeconds，180 秒会切断尚在写章的工具。
        // 官方 MCP 配置支持按服务器设置超时；此回合的专用令牌随 TempDir 清理。
        let config = json!({"mcpServers":{MCP_NAME:{
            "serverUrl":self.url, "headers":{"Authorization":format!("Bearer {}",self.token)},
            "timeoutSeconds": TOOL_TIMEOUT.as_secs()
        }}});
        crate::mcp::paths::write_private_file(
            &home.join(".gemini/config/mcp_config.json"),
            &config.to_string(),
        )
    }
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub(super) struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    #[serde(alias = "cachedReadTokens")]
    pub cached_input_tokens: u64,
    #[serde(alias = "cachedWriteTokens")]
    pub cache_write_input_tokens: u64,
    #[serde(alias = "thoughtTokens")]
    pub reasoning_tokens: u64,
}

impl Usage {
    fn add(&mut self, other: Self) {
        self.input_tokens += other.input_tokens;
        self.output_tokens += other.output_tokens;
        self.total_tokens += other.total_tokens;
        self.cached_input_tokens += other.cached_input_tokens;
        self.cache_write_input_tokens += other.cache_write_input_tokens;
        self.reasoning_tokens += other.reasoning_tokens;
    }
}

fn prepare_home(root: &Path, real_home: &Path) -> Result<PathBuf, std::io::Error> {
    let relative = Path::new(".gemini").join("antigravity-cli");
    let dir = root.join(&relative);
    std::fs::create_dir_all(&dir)?;
    for name in ["antigravity-oauth-token", "installation_id"] {
        let src = real_home.join(&relative).join(name);
        if !src.is_file() {
            continue;
        }
        let dst = dir.join(name);
        #[cfg(unix)]
        if name == "antigravity-oauth-token" {
            std::os::unix::fs::symlink(src, dst)?;
            continue;
        }
        std::fs::copy(src, dst)?;
    }
    #[cfg(target_os = "macos")]
    for name in ["login.keychain-db", "login.keychain"] {
        let relative = Path::new("Library").join("Keychains");
        let src = real_home.join(&relative).join(name);
        if src.is_file() {
            std::fs::create_dir_all(root.join(&relative))?;
            std::os::unix::fs::symlink(src, root.join(relative).join(name))?;
            break;
        }
    }
    // 工具权限由 ACP 逐次确认。只让应用自己的回环 MCP 进入这个会话。
    std::fs::write(
        dir.join("settings.json"),
        json!({"permissions":{
            "deny":["read_file(*)","write_file(*)","command(*)","read_url(*)"]
        }})
        .to_string(),
    )?;
    let cwd = root.join("work");
    std::fs::create_dir(&cwd)?;
    Ok(cwd)
}

fn permission(
    params: &Value,
    session_id: Option<&str>,
    tools: Option<&SessionTools>,
    web_search: bool,
) -> Value {
    let call = &params["toolCall"];
    let tool = match call["name"].as_str() {
        Some("call_mcp_tool") => {
            let args = call.get("rawInput").unwrap_or(&call["args"]);
            if args["ServerName"] == MCP_NAME {
                args["ToolName"].as_str()
            } else {
                None
            }
        }
        Some(name) => name.strip_prefix("mcp_qmai_"),
        None => None,
    };
    let allowed = session_id.is_some()
        && params["sessionId"].as_str() == session_id
        && ((web_search && call["name"] == "search_web")
            || tools.is_some_and(|t| {
                t.enabled.load(Ordering::Acquire) && tool.is_some_and(|name| t.names.contains(name))
            }));
    let kind = if allowed { "allow_once" } else { "reject_once" };
    let option = params["options"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| item["kind"] == kind)
        .and_then(|item| item["optionId"].as_str());
    match option {
        Some(id) => json!({"outcome":{"outcome":"selected", "optionId":id}}),
        None => json!({"outcome":{"outcome":"cancelled"}}),
    }
}

struct Acp<'a> {
    search: Option<&'a mut SearchEvidence>,
    child: Child,
    stdin: ChildStdin,
    lines: Lines<BufReader<ChildStdout>>,
    // 在子进程退出后才清理临时工作区、登录链接和会话历史。
    _home: TempDir,
    cwd: PathBuf,
    id: u64,
    session: Option<String>,
    tools: Option<SessionTools>,
}

impl Acp<'_> {
    async fn start(agy: &Path, tools: Option<SessionTools>) -> Result<Self, String> {
        let mut builder = tempfile::Builder::new();
        builder.prefix("qmai-agy-acp-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let home = builder
            .tempdir()
            .map_err(|e| format!("无法创建 ACP 临时目录：{e}"))?;
        let real = resolve_home_dir().ok_or("无法确定 Antigravity 登录目录")?;
        let cwd =
            prepare_home(home.path(), &real).map_err(|e| format!("无法准备 ACP 工作区：{e}"))?;
        let mut cmd = Command::new(agy);
        configure_agy_command(&mut cmd).await;
        cmd.args(["acp", "--include-default-customizations=false"]);
        if let Some(tools) = &tools {
            tools
                .write_config(home.path())
                .map_err(|e| format!("无法设置会话 MCP 工具：{e}"))?;
        }
        let mut child = cmd
            .env("HOME", home.path())
            .env("USERPROFILE", home.path())
            .env("ANTIGRAVITY_BROWSER_TOOLS_ENABLED", "false")
            .current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("无法启动 agy acp：{e}"))?;
        let stdin = child.stdin.take().ok_or("ACP 缺少标准输入")?;
        let stdout = child.stdout.take().ok_or("ACP 缺少标准输出")?;
        Ok(Self {
            search: None,
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            _home: home,
            cwd,
            id: 0,
            session: None,
            tools,
        })
    }

    async fn write(&mut self, msg: Value) -> Result<(), String> {
        let mut bytes = msg.to_string().into_bytes();
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(|e| format!("写入 ACP 失败：{e}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|e| format!("刷新 ACP 输入失败：{e}"))
    }

    async fn request(
        &mut self,
        method: &str,
        params: Value,
        mut text: impl FnMut(&str),
    ) -> Result<Value, String> {
        self.id += 1;
        let id = self.id;
        self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        loop {
            let line = self
                .lines
                .next_line()
                .await
                .map_err(|e| format!("读取 ACP 失败：{e}"))?
                .ok_or_else(|| {
                    format!("agy acp 在 {method} 完成前退出，请检查 CLI 版本及登录状态。")
                })?;
            let msg: Value =
                serde_json::from_str(&line).map_err(|_| "agy acp 返回了无效的 JSON-RPC 消息")?;
            if let Some(server_method) = msg["method"].as_str() {
                if let Some(server_id) = msg.get("id") {
                    let response = if server_method == "session/request_permission" {
                        let result = permission(
                            &msg["params"],
                            self.session.as_deref(),
                            self.tools.as_ref(),
                            self.search.is_some(),
                        );
                        json!({"jsonrpc":"2.0","id":server_id,"result":result})
                    } else {
                        json!({"jsonrpc":"2.0","id":server_id,"error":{"code":-32601,"message":"青幕未提供此客户端能力"}})
                    };
                    self.write(response).await?;
                } else if server_method == "session/update"
                    && self.session.is_some()
                    && msg.pointer("/params/sessionId").and_then(Value::as_str)
                        == self.session.as_deref()
                {
                    let update = &msg["params"]["update"];
                    if let Some(search) = &mut self.search {
                        search.observe(update);
                    }
                    if update["sessionUpdate"] == "agent_message_chunk"
                        && update["content"]["type"] == "text"
                    {
                        if let Some(delta) =
                            update["content"]["text"].as_str().filter(|s| !s.is_empty())
                        {
                            text(delta);
                        }
                    }
                }
                continue;
            }
            if msg["id"].as_u64() != Some(id) {
                continue;
            }
            if let Some(error) = msg.get("error") {
                let reason = error["message"].as_str().unwrap_or("协议错误");
                if error["code"] == -32000
                    || reason
                        .to_ascii_lowercase()
                        .contains("authentication required")
                {
                    return Err("Antigravity CLI 需要登录，请在终端运行 agy 完成登录。".into());
                }
                return Err(format!("Antigravity ACP 调用 {method} 失败：{reason}"));
            }
            return msg
                .get("result")
                .cloned()
                .ok_or_else(|| format!("ACP 缺少 {method} 的结果"));
        }
    }

    async fn open(&mut self, model: &str) -> Result<Value, String> {
        let init = self
            .request(
                "initialize",
                json!({"protocolVersion":1,"clientCapabilities":{},
            "clientInfo":{"name":"QMAI","version":env!("CARGO_PKG_VERSION")}}),
                |_| {},
            )
            .await?;
        if init["protocolVersion"] != 1 {
            return Err("当前 agy 不支持 ACP v1，请更新 Antigravity CLI。".into());
        }
        let session = self
            .request(
                "session/new",
                json!({"cwd":self.cwd,"mcpServers":[]}),
                |_| {},
            )
            .await?;
        self.session = Some(
            session["sessionId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("ACP 未返回会话标识")?
                .to_owned(),
        );
        let model = model.trim();
        if !model.is_empty()
            && model != "default"
            && session
                .pointer("/models/currentModelId")
                .and_then(Value::as_str)
                != Some(model)
        {
            self.request(
                "session/set_model",
                json!({"sessionId":self.session,"modelId":model}),
                |_| {},
            )
            .await?;
        }
        Ok(session)
    }

    async fn prompt(
        &mut self,
        prompt: &str,
        text: impl FnMut(&str),
        usage: &mut Option<Usage>,
    ) -> Result<(), String> {
        let params = json!({"sessionId":self.session, "prompt":[{"type":"text","text":prompt}]});
        // 主 Agent 的一轮 ACP prompt 可跨越多次 QMAI 工具执行。每个挂起的工具有独立
        // 期限，HTTP 客户端断开也会取消会话；整轮计时会把已经用过的工具时间算到下一个工具。
        let waiting_for_tools = self
            .tools
            .as_ref()
            .is_some_and(|t| t.enabled.load(Ordering::Acquire));
        let pending = self.request("session/prompt", params, text);
        let reply = if waiting_for_tools {
            pending.await?
        } else {
            timeout(TURN_TIMEOUT, pending)
                .await
                .map_err(|_| "Antigravity ACP 回合超过 30 分钟")??
        };
        match reply["stopReason"].as_str() {
            Some("end_turn") => (),
            Some("max_tokens" | "max_turn_requests") => {
                return Err("Antigravity ACP 达到生成上限，本回合输出不完整。".into())
            }
            Some(reason) => return Err(format!("Antigravity ACP 提前结束了回合：{reason}")),
            None => return Err("Antigravity ACP 没有返回回合结束原因。".into()),
        }
        if let Some(next) = reply
            .get("usage")
            .and_then(|v| serde_json::from_value::<Usage>(v.clone()).ok())
        {
            usage.get_or_insert_with(Usage::default).add(next);
        }
        Ok(())
    }

    async fn close(mut self, cancel: bool) {
        if self.session.is_some() {
            let _ = timeout(CLOSE_TIMEOUT, async {
                if cancel {
                    self.write(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":self.session}})).await?;
                }
                self.request("session/close", json!({"sessionId":self.session}), |_| {}).await
            }).await;
        }
        drop(self.stdin);
        // 先关闭管道，让 agy 正常回收会话和子进程。
        if timeout(CLOSE_TIMEOUT, self.child.wait()).await.is_err() {
            let _ = self.child.kill().await;
        }
    }
}

fn input_parts(prompt: &str) -> Vec<&str> {
    if prompt.len() <= SINGLE_PROMPT_BYTES {
        return vec![prompt];
    }
    let mut rest = prompt;
    let mut result = Vec::new();
    while rest.len() > PART_BYTES {
        let mut end = PART_BYTES;
        while !rest.is_char_boundary(end) {
            end -= 1;
        }
        let (part, tail) = rest.split_at(end);
        result.push(part);
        rest = tail;
    }
    result.push(rest);
    result
}

pub(super) async fn complete(
    model: &str,
    prompt: &str,
    followup: Option<&str>,
    tools: Option<SessionTools>,
    cancel: oneshot::Receiver<()>,
    emit: impl FnMut(&str),
) -> Result<Option<Usage>, String> {
    complete_session(model, prompt, followup, tools, None, cancel, emit).await
}

pub(super) async fn web_search(
    model: &str,
    prompt: &str,
    limit: Duration,
) -> Result<SearchEvidence, String> {
    let mut evidence = SearchEvidence::default();
    let (stop, cancelled) = oneshot::channel();
    {
        let work = complete_session(
            model,
            prompt,
            None,
            None,
            Some(&mut evidence),
            cancelled,
            |_| {},
        );
        tokio::pin!(work);
        if let Ok(outcome) = timeout(limit, &mut work).await {
            outcome?;
        } else {
            let _ = stop.send(());
            let _ = work.await;
            return Err("反重力 CLI 搜索超时，已结束 ACP 会话。".into());
        }
    }
    Ok(evidence)
}

async fn complete_session(
    model: &str,
    prompt: &str,
    followup: Option<&str>,
    tools: Option<SessionTools>,
    search: Option<&mut SearchEvidence>,
    cancel: oneshot::Receiver<()>,
    mut emit: impl FnMut(&str),
) -> Result<Option<Usage>, String> {
    let started = Instant::now();
    let agy = find_agy_command()
        .await
        .map_err(|_| "未找到 agy，请先安装 Antigravity CLI。".to_string())?;
    check_acp_version(&read_agy_version(&agy).await?)?;
    let mut acp = Acp::start(&agy, tools).await?;
    let pid = acp.child.id().unwrap_or_default();
    let parts = input_parts(prompt);
    eprintln!(
        "[antigravity-acp] 进程={pid} 建立会话 模型={model} 输入字节={} 分段={} QMAI工具={} 联网搜索={}",
        prompt.len(),
        parts.len(),
        acp.tools.is_some(),
        search.is_some()
    );
    let run = async {
        timeout(SETUP_TIMEOUT, acp.open(model))
            .await
            .map_err(|_| "Antigravity ACP 建立会话超时")??;
        eprintln!(
            "[antigravity-acp] 进程={pid} 会话就绪 耗时毫秒={}",
            started.elapsed().as_millis()
        );
        let mut usage = None;
        for (i, part) in parts[..parts.len() - 1].iter().enumerate() {
            let receipt = format!("QMAI_CONTEXT_OK_{}", uuid::Uuid::new_v4().simple());
            let wrapped = format!("以下是同一请求的第 {}/{} 段资料。先接收，等最后一段再执行任务。不要调用工具。\n<request_part>\n{part}\n</request_part>\n本轮只回复确认码 {receipt}", i+1, parts.len());
            let mut ack = String::new();
            let sent = Instant::now();
            acp.prompt(&wrapped, |delta| ack.push_str(delta), &mut usage)
                .await?;
            if !ack.contains(&receipt) {
                return Err(format!(
                    "Antigravity ACP 未确认收到第 {}/{} 段资料，已停止执行。",
                    i + 1,
                    parts.len()
                ));
            }
            eprintln!(
                "[antigravity-acp] 进程={pid} 分段确认={}/{} 耗时毫秒={}",
                i + 1,
                parts.len(),
                sent.elapsed().as_millis()
            );
        }
        acp.search = search;
        if let Some(t) = &acp.tools {
            t.enabled.store(true, Ordering::Release);
        }
        let last = parts.last().unwrap();
        let wrapped;
        let final_prompt = if parts.len() == 1 {
            *last
        } else {
            wrapped = format!("这是同一个请求的最后一段。请按顺序合并之前收到的各段和本段。\n<request_part>\n{last}\n</request_part>\n资料已收齐，现在按完整请求执行任务。");
            &wrapped
        };
        let mut saw_text = false;
        let sent = Instant::now();
        eprintln!(
            "[antigravity-acp] 进程={pid} 已发送末段={}/{}",
            parts.len(),
            parts.len()
        );
        acp.prompt(
            final_prompt,
            |delta| {
                if !saw_text && !delta.trim().is_empty() {
                    eprintln!(
                        "[antigravity-acp] 进程={pid} 收到首段输出 耗时毫秒={}",
                        sent.elapsed().as_millis()
                    );
                }
                saw_text |= !delta.trim().is_empty();
                emit(delta);
            },
            &mut usage,
        )
        .await?;
        if !saw_text {
            if let Some(retry) = followup {
                acp.prompt(
                    retry,
                    |delta| {
                        saw_text |= !delta.trim().is_empty();
                        emit(delta);
                    },
                    &mut usage,
                )
                .await?;
                if !saw_text {
                    return Err("Antigravity ACP 没有返回正文。".into());
                }
            }
        }
        Ok(usage)
    };
    let outcome = tokio::select! {
        biased;
        _ = cancel => Err("已取消 Antigravity ACP 请求。".into()),
        result = run => result,
    };
    acp.close(outcome.is_err()).await;
    eprintln!(
        "[antigravity-acp] 进程={pid} 会话结束 成功={} 总耗时毫秒={}",
        outcome.is_ok(),
        started.elapsed().as_millis()
    );
    outcome
}

pub(super) async fn model_catalog(agy: &Path) -> Result<(Option<String>, Vec<String>), String> {
    let mut acp = Acp::start(agy, None).await?;
    let result = timeout(SETUP_TIMEOUT, acp.open("")).await;
    acp.close(false).await;
    let session = result.map_err(|_| "Antigravity ACP 获取模型列表超时")??;
    let catalog = &session["models"];
    let models: Vec<_> = catalog["availableModels"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| m["modelId"].as_str())
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
        .collect();
    if models.is_empty() {
        return Err("Antigravity ACP 没有返回可用模型，请检查登录状态。".into());
    }
    Ok((
        catalog["currentModelId"].as_str().map(str::to_owned),
        models,
    ))
}

#[cfg(test)]
pub(super) fn long_test_input() -> (String, [String; 3]) {
    let marks = std::array::from_fn(|_| uuid::Uuid::new_v4().simple().to_string());
    let stock = "登记本上记着纸张的颜色与册数。\n".repeat(3000);
    let input = format!(
        "首编号：{}\n{stock}中编号：{}\n{stock}末编号：{}",
        marks[0], marks[1], marks[2]
    );
    assert!(input.len() > 256_000);
    (input, marks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_only_long_prompts_and_round_trips_unicode_at_boundaries() {
        let short = "a".repeat(SINGLE_PROMPT_BYTES);
        assert_eq!(input_parts(&short), [short.as_str()]);
        let prompt = format!(
            "{}{}尾部",
            "a".repeat(PART_BYTES - 1),
            "📚中".repeat(40_000)
        );
        let parts = input_parts(&prompt);
        assert!(parts.len() > 2);
        assert!(parts.iter().all(|p| !p.is_empty() && p.len() <= PART_BYTES));
        assert_eq!(parts.concat(), prompt);
    }

    #[test]
    fn search_permission_is_limited_to_the_builtin_tool_and_own_session() {
        let mut request = json!({"sessionId":"search","toolCall":{"name":"search_web"},
            "options":[{"kind":"allow_once","optionId":"yes"},{"kind":"reject_once","optionId":"no"}]});
        let choice = |p: &Value, id, enabled| {
            permission(p, Some(id), None, enabled)["outcome"]["optionId"].clone()
        };
        assert_eq!(choice(&request, "search", true), "yes");
        assert_eq!(choice(&request, "other", true), "no");
        assert_eq!(choice(&request, "search", false), "no");
        request["toolCall"]["name"] = json!("run_command");
        assert_eq!(choice(&request, "search", true), "no");
    }

    #[test]
    fn only_the_active_sessions_registered_mcp_tools_can_get_one_shot_permission() {
        let tools = SessionTools {
            url: String::new(),
            token: String::new(),
            names: ["save_draft".into()].into(),
            enabled: Arc::new(AtomicBool::new(false)),
        };
        let mut params = json!({"sessionId":"our-session","toolCall":{"name":"mcp_qmai_save_draft"},
            "options":[{"kind":"allow_always","optionId":"always"},{"kind":"allow_once","optionId":"once"},{"kind":"reject_once","optionId":"deny"}]});
        let check = |p: &Value| {
            permission(p, Some("our-session"), Some(&tools), false)["outcome"]["optionId"].clone()
        };
        assert_eq!(check(&params), "deny");
        tools.enabled.store(true, Ordering::Release);
        assert_eq!(check(&params), "once");
        assert_eq!(
            permission(&params, Some("other-session"), Some(&tools), false)["outcome"]["optionId"],
            "deny"
        );
        assert_eq!(
            permission(&params, Some("our-session"), None, false)["outcome"]["optionId"],
            "deny"
        );
        params["toolCall"] = json!({"name":"call_mcp_tool","rawInput":{"ServerName":"qmai","ToolName":"save_draft"}});
        assert_eq!(check(&params), "once");
        params["toolCall"]["rawInput"]["ServerName"] = json!("external");
        assert_eq!(check(&params), "deny");
        params["toolCall"]["rawInput"] = json!({"ServerName":"qmai","ToolName":"unknown"});
        assert_eq!(check(&params), "deny");
        for name in ["mcp_qmai_unknown", "run_command", "mcp_other_save_draft"] {
            params["toolCall"]["name"] = json!(name);
            assert_eq!(check(&params), "deny");
        }
        params["options"] = json!([{"kind":"allow_always","optionId":"always"}]);
        assert_eq!(
            permission(&params, None, None, false)["outcome"]["outcome"],
            "cancelled"
        );
    }

    #[test]
    fn mcp_config_sets_a_private_per_server_tool_timeout() {
        let home = tempfile::tempdir().unwrap();
        let tools = SessionTools {
            url: "http://127.0.0.1:1/mcp/test".into(),
            token: "fixture".into(),
            names: HashSet::new(),
            enabled: Arc::new(AtomicBool::new(false)),
        };
        tools.write_config(home.path()).unwrap();
        let path = home.path().join(".gemini/config/mcp_config.json");
        let config: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        let server = &config["mcpServers"][MCP_NAME];
        assert_eq!(server["timeoutSeconds"], TOOL_TIMEOUT.as_secs());
        assert_eq!(server["headers"]["Authorization"], "Bearer fixture");
        assert_eq!(server["serverUrl"], tools.url);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn isolated_home_contains_only_session_rules_and_login_references() {
        let real = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let cli = Path::new(".gemini/antigravity-cli");
        std::fs::create_dir_all(real.path().join(cli)).unwrap();
        std::fs::write(
            real.path().join(cli).join("antigravity-oauth-token"),
            "fixture",
        )
        .unwrap();
        std::fs::write(real.path().join(cli).join("settings.json"), "global").unwrap();
        #[cfg(target_os = "macos")]
        {
            std::fs::create_dir_all(real.path().join("Library/Keychains")).unwrap();
            std::fs::write(
                real.path().join("Library/Keychains/login.keychain-db"),
                "fixture",
            )
            .unwrap();
        }
        let work = prepare_home(home.path(), real.path()).unwrap();
        assert!(work.read_dir().unwrap().next().is_none());
        assert_eq!(
            std::fs::read_to_string(home.path().join(cli).join("antigravity-oauth-token")).unwrap(),
            "fixture"
        );
        let rules: Value = serde_json::from_slice(
            &std::fs::read(home.path().join(cli).join("settings.json")).unwrap(),
        )
        .unwrap();
        assert!(rules["permissions"]["deny"]
            .as_array()
            .unwrap()
            .contains(&json!("command(*)")));
        assert!(!home.path().join(".gemini/config/mcp_config.json").exists());
        #[cfg(target_os = "macos")]
        assert_eq!(
            std::fs::read_link(home.path().join("Library/Keychains/login.keychain-db")).unwrap(),
            real.path().join("Library/Keychains/login.keychain-db")
        );
    }

    #[tokio::test]
    #[ignore = "使用已登录的 agy 实际发送长文本，消耗模型额度"]
    async fn live_acp_text_preserves_head_middle_and_tail() {
        let model = "gemini-4-hydrogen-high";
        let (context, marks) = long_test_input();
        let messages = serde_json::from_value::<Vec<super::super::antigravity_cli::AgyMessage>>(json!([
            {"role":"user","content": format!("{context}\n按首、中、末顺序原样输出三个编号，只输出编号。")}
        ])).unwrap();
        let prompt = super::super::antigravity_cli::flatten_antigravity_prompt(&messages).unwrap();
        let mut text = String::new();
        let (_stop, cancelled) = oneshot::channel();
        let usage = complete(model, &prompt, None, None, cancelled, |delta| {
            text.push_str(delta)
        })
        .await
        .unwrap();
        assert!(!text.contains("QMAI_CONTEXT_OK"));
        let mut remaining = text.as_str();
        for mark in &marks {
            remaining = remaining
                .split_once(mark)
                .expect("模型丢失编号或颠倒顺序")
                .1;
        }
        assert!(usage.unwrap().input_tokens > 0);
    }
}
