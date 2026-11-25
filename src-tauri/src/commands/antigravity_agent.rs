//! 通过 agy ACP 会话向主 Agent 提供本机 OpenAI 兼容接口。
//! 每个隔离会话通过 HTTP MCP 公开当前请求的工具。只有经过参数校验的 tools/call
//! 会挂起交给 QMAI 执行，后续请求按 tool_call_id 把结果交回原会话。

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Map, Value};
use tokio::sync::oneshot;
use uuid::Uuid;

use super::antigravity_acp::{self, SessionTools, Usage, MCP_NAME as MCP_SERVER_NAME};

/// 主 Agent 默认模型：用户没选模型时用 medium 档。
pub const DEFAULT_AGENT_MODEL: &str = "gemini-3.8-flash-medium";
/// 挂起的工具调用最多等多久（与 Cursor CLI 的 30 分钟兜底一致）。
const PENDING_TOOL_TIMEOUT: Duration = antigravity_acp::TOOL_TIMEOUT;
/// 同一批并行工具调用的合并窗口。
const TOOL_BATCH_WINDOW: Duration = Duration::from_millis(200);
const SSE_KEEPALIVE: Duration = Duration::from_secs(5);
const CALL_PREFIX: &str = "call_agy_";
static PROXY: OnceLock<Mutex<Option<Arc<Proxy>>>> = OnceLock::new();

fn proxy_slot() -> &'static Mutex<Option<Arc<Proxy>>> {
    PROXY.get_or_init(|| Mutex::new(None))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProxyStatus {
    pub base_url: String,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq)]
struct PendingCall {
    id: String,
    name: String,
    arguments: Value,
}

#[derive(Debug, Clone, PartialEq)]
enum Event {
    Text(String),
    ToolCalls(Vec<PendingCall>),
    Done {
        usage: Option<Usage>,
        error: Option<String>,
    },
}

struct Session {
    id: String,
    mcp_token: String,
    model: String,
    tools: HashMap<String, Value>,
    tool_defs: Vec<Value>,
    events: Mutex<VecDeque<Event>>,
    signal: Condvar,
    pending: Mutex<HashMap<String, Sender<Result<String, String>>>>,
    batch: Mutex<Vec<PendingCall>>,
    batch_generation: AtomicU64,
    cancel: Mutex<Option<oneshot::Sender<()>>>,
    tools_enabled: Arc<AtomicBool>,
    closed: AtomicBool,
}

impl Session {
    fn push(&self, event: Event) {
        if let Ok(mut events) = self.events.lock() {
            events.push_back(event);
        }
        self.signal.notify_all();
    }

    fn next_event(&self, wait: Duration) -> Option<Event> {
        let mut events = self.events.lock().ok()?;
        if events.is_empty() {
            let (guard, _) = self.signal.wait_timeout(events, wait).ok()?;
            events = guard;
        }
        events.pop_front()
    }

    fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        if let Ok(mut cancel) = self.cancel.lock() {
            if let Some(stop) = cancel.take() {
                let _ = stop.send(());
            }
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err("青幕写作已取消本次工具调用。".to_string()));
            }
        }
        self.signal.notify_all();
    }
}

struct Proxy {
    port: u16,
    token: String,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    call_index: Mutex<HashMap<String, String>>,
    stop: AtomicBool,
}

impl Proxy {
    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().ok()?.get(id).cloned()
    }

    fn drop_session(&self, session: &Session) {
        session.close();
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.remove(&session.id);
        }
        if let Ok(mut index) = self.call_index.lock() {
            index.retain(|_, sid| sid != &session.id);
        }
    }

    fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        let sessions: Vec<Arc<Session>> = self
            .sessions
            .lock()
            .map(|mut map| map.drain().map(|(_, s)| s).collect())
            .unwrap_or_default();
        for session in sessions {
            session.close();
        }
        let _ = TcpStream::connect_timeout(
            &SocketAddr::from((Ipv4Addr::LOCALHOST, self.port)),
            Duration::from_millis(200),
        );
    }
}

// ---------------------------------------------------------------------------
// 纯函数：参数校验、提示词、SSE 片段（有单元测试）
// ---------------------------------------------------------------------------

fn type_matches(expected: &str, value: &Value) -> bool {
    match expected {
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" => value.is_boolean(),
        "array" => value.is_array(),
        "object" => value.is_object(),
        "null" => value.is_null(),
        _ => true,
    }
}

/// 按工具的 JSON Schema 校验 agy 传来的参数，返回中文错误列表（空表示通过）。
pub(crate) fn validate_tool_arguments(schema: &Value, args: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    let Some(args) = args.as_object() else {
        return vec!["参数必须是 JSON 对象".to_string()];
    };
    let empty = Map::new();
    let props = schema
        .get("properties")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if args.get(key).map_or(true, Value::is_null) {
                errors.push(format!("缺少必填参数 \"{key}\""));
            }
        }
    }
    for (key, value) in args {
        let Some(prop) = props.get(key) else {
            errors.push(format!("未知参数 \"{key}\""));
            continue;
        };
        if value.is_null() {
            continue;
        }
        let type_ok = match prop.get("type") {
            Some(Value::String(t)) => type_matches(t, value),
            Some(Value::Array(types)) => types
                .iter()
                .filter_map(Value::as_str)
                .any(|t| type_matches(t, value)),
            _ => true,
        };
        if !type_ok {
            errors.push(format!(
                "参数 \"{key}\" 类型应为 {}",
                prop.get("type").cloned().unwrap_or(Value::Null)
            ));
        }
        if let Some(options) = prop.get("enum").and_then(Value::as_array) {
            if !options.contains(value) {
                errors.push(format!(
                    "参数 \"{key}\" 只能是 {}",
                    Value::Array(options.clone())
                ));
            }
        }
    }
    errors
}

fn tool_error_text(name: &str, errors: &[String], schema: Option<&Value>) -> String {
    match schema {
        Some(schema) => format!(
            "参数错误：{}。请严格按以下 JSON Schema 重新调用 {MCP_SERVER_NAME}/{name}：{schema}",
            errors.join("；")
        ),
        None => format!("没有名为 {name} 的工具。只能调用 {MCP_SERVER_NAME} 服务器列出的工具。"),
    }
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// 把 OpenAI 消息历史和工具 schema 拼成一段给 agy 的提示词。
/// 实测把 schema 直接写进提示词后，agy 不再先试探调用或去读工具定义文件，参数错误率从约 25% 降到 0。
pub(crate) fn build_agent_prompt(messages: &[Value], tool_defs: &[Value]) -> String {
    let mut parts = Vec::new();
    for message in messages {
        let role = message
            .get("role")
            .and_then(Value::as_str)
            .unwrap_or("user");
        let text = content_text(message.get("content").unwrap_or(&Value::Null));
        match role {
            "system" | "developer" => parts.push(format!("<system>\n{text}\n</system>")),
            "tool" => {
                let id = message
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                parts.push(format!("<tool_result id=\"{id}\">\n{text}\n</tool_result>"));
            }
            "assistant" => {
                let calls = message
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .map(|calls| {
                        calls
                            .iter()
                            .map(|call| {
                                json!({
                                    "id": call.get("id"),
                                    "name": call.pointer("/function/name"),
                                    "arguments": call.pointer("/function/arguments"),
                                })
                            })
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                if calls.is_empty() {
                    parts.push(format!("<assistant>\n{text}\n</assistant>"));
                } else {
                    parts.push(format!(
                        "<assistant>\n{text}\n<tool_calls>{}</tool_calls>\n</assistant>",
                        Value::Array(calls)
                    ));
                }
            }
            _ => parts.push(format!("<user>\n{text}\n</user>")),
        }
    }
    if tool_defs.is_empty() {
        return format!(
            "以下是青幕写作的对话记录。请直接完成最后一条用户请求，本轮只返回文本。\n\n{}",
            parts.join("\n\n")
        );
    }
    let schemas = tool_defs
        .iter()
        .map(|tool| {
            format!(
                "- {MCP_SERVER_NAME}/{}: {}",
                tool.get("name").and_then(Value::as_str).unwrap_or(""),
                tool.get("inputSchema").cloned().unwrap_or(json!({}))
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "以下是青幕写作（QMAI）的对话记录。你是其中的 assistant，请继续完成最后一条用户请求。\n\n{}\n\n\
【工具规则】只能通过 MCP 服务器 `{MCP_SERVER_NAME}` 的工具读取或修改项目内容；不要读写本地文件，不要执行命令。\
各工具参数的 JSON Schema 如下，直接按它调用，参数名必须完全一致，不要先读取工具定义文件或做试探调用：\n{}",
        parts.join("\n\n"),
        schemas
    )
}

fn openai_tools_to_mcp(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|tool| {
            let function = tool.get("function").unwrap_or(tool);
            let name = function
                .get("name")
                .and_then(Value::as_str)?
                .trim()
                .to_string();
            if name.is_empty() {
                return None;
            }
            Some(json!({
                "name": name,
                "description": function.get("description").and_then(Value::as_str).unwrap_or(""),
                "inputSchema": function
                    .get("parameters")
                    .cloned()
                    .unwrap_or_else(|| json!({"type": "object", "properties": {}})),
            }))
        })
        .collect()
}

fn openai_usage(usage: &Usage) -> Value {
    json!({
        "prompt_tokens": usage.input_tokens,
        "completion_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "prompt_tokens_details": { "cached_tokens": usage.cached_input_tokens },
        "completion_tokens_details": { "reasoning_tokens": usage.reasoning_tokens },
    })
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn chunk(
    id: &str,
    model: &str,
    delta: Value,
    finish: Option<&str>,
    usage: Option<Value>,
) -> String {
    let mut body = json!({
        "id": id,
        "object": "chat.completion.chunk",
        "created": unix_now(),
        "model": model,
        "choices": [{ "index": 0, "delta": delta, "finish_reason": finish }],
    });
    if let Some(usage) = usage {
        body["usage"] = usage;
    }
    format!("data: {body}\n\n")
}

fn tool_calls_delta(calls: &[PendingCall]) -> Value {
    json!({
        "role": "assistant",
        "tool_calls": calls.iter().enumerate().map(|(index, call)| json!({
            "index": index,
            "id": call.id,
            "type": "function",
            "function": { "name": call.name, "arguments": call.arguments.to_string() },
        })).collect::<Vec<_>>(),
    })
}

// ---------------------------------------------------------------------------
// 隔离的 HOME
// ---------------------------------------------------------------------------

// HTTP
// ---------------------------------------------------------------------------

struct HttpRequest {
    method: String,
    path: String,
    headers: String,
    body: Vec<u8>,
}

fn read_request(stream: &mut TcpStream) -> Result<HttpRequest, String> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(60)));
    let mut buf = Vec::new();
    let mut tmp = [0_u8; 8192];
    let header_end = loop {
        let read = stream
            .read(&mut tmp)
            .map_err(|e| format!("读取请求失败：{e}"))?;
        if read == 0 {
            return Err("连接已关闭".to_string());
        }
        buf.extend_from_slice(&tmp[..read]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > 65_536 {
            return Err("请求头过大".to_string());
        }
    };
    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.lines();
    let first = lines.next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("/").to_string();
    let headers = lines.collect::<Vec<_>>().join("\n");
    let length = header_value(&headers, "content-length")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(0);
    if length > 64 * 1024 * 1024 {
        return Err("请求体过大".to_string());
    }
    let mut body = buf[header_end + 4..].to_vec();
    while body.len() < length {
        let read = stream
            .read(&mut tmp)
            .map_err(|e| format!("读取请求失败：{e}"))?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..read]);
    }
    body.truncate(length);
    Ok(HttpRequest {
        method,
        path,
        headers,
        body,
    })
}

fn header_value<'a>(headers: &'a str, name: &str) -> Option<&'a str> {
    headers.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &str) {
    let reason = match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes());
}

fn write_json(stream: &mut TcpStream, status: u16, body: &Value) {
    write_response(stream, status, "application/json", &body.to_string());
}

fn start_proxy() -> Result<Arc<Proxy>, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|e| format!("无法监听 Antigravity 代理端口：{e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("无法读取代理端口：{e}"))?
        .port();
    let proxy = Arc::new(Proxy {
        port,
        token: format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()),
        sessions: Mutex::new(HashMap::new()),
        call_index: Mutex::new(HashMap::new()),
        stop: AtomicBool::new(false),
    });
    let accept = proxy.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            if accept.stop.load(Ordering::SeqCst) {
                break;
            }
            let Ok(stream) = stream else { continue };
            let proxy = accept.clone();
            thread::spawn(move || handle_connection(proxy, stream));
        }
    });
    Ok(proxy)
}

fn handle_connection(proxy: Arc<Proxy>, mut stream: TcpStream) {
    let loopback = stream
        .peer_addr()
        .map(|addr| addr.ip().is_loopback())
        .unwrap_or(false);
    if !loopback {
        write_response(&mut stream, 403, "text/plain", "Forbidden");
        return;
    }
    let request = match read_request(&mut stream) {
        Ok(request) => request,
        Err(_) => return,
    };
    let path = request.path.split('?').next().unwrap_or("").to_string();
    if path == "/health" {
        write_json(&mut stream, 200, &json!({"ok": true}));
        return;
    }
    let session_id = path.strip_prefix("/mcp/");
    let session = session_id.and_then(|id| proxy.session(id));
    let expected = match (session_id, &session) {
        (Some(_), Some(session)) => Some(&session.mcp_token),
        (None, _) => Some(&proxy.token),
        _ => None,
    };
    let supplied = header_value(&request.headers, "authorization")
        .and_then(|value| value.strip_prefix("Bearer "));
    if expected.is_none() || expected.map(String::as_str) != supplied {
        write_json(
            &mut stream,
            401,
            &json!({"error": {"message": "Antigravity 代理令牌无效"}}),
        );
        return;
    }
    if let Some(session) = session {
        handle_mcp(&proxy, &session, &request, &mut stream);
        return;
    }
    match (request.method.as_str(), path.as_str()) {
        ("POST", "/v1/chat/completions") => handle_chat(&proxy, &request, stream),
        ("GET", "/v1/models") => write_json(
            &mut stream,
            200,
            &json!({"object": "list", "data": [{"id": DEFAULT_AGENT_MODEL, "object": "model"}]}),
        ),
        _ => write_json(
            &mut stream,
            404,
            &json!({"error": {"message": "not found"}}),
        ),
    }
}

fn handle_mcp(
    proxy: &Arc<Proxy>,
    session: &Arc<Session>,
    request: &HttpRequest,
    stream: &mut TcpStream,
) {
    if request.method == "GET" {
        write_response(stream, 405, "text/plain", "");
        return;
    }
    if request.method == "DELETE" {
        write_response(stream, 200, "application/json", "{}");
        return;
    }
    let message: Value = serde_json::from_slice(&request.body).unwrap_or(json!({}));
    let Some(id) = message.get("id").cloned() else {
        write_response(stream, 202, "application/json", "");
        return;
    };
    let reply = |result: Value| json!({"jsonrpc": "2.0", "id": id, "result": result});
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    let response = match method {
        "initialize" => reply(json!({
            "protocolVersion": message.pointer("/params/protocolVersion").cloned().unwrap_or(json!("2025-06-18")),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": MCP_SERVER_NAME, "version": "1.0.0" },
        })),
        "tools/list" => reply(json!({ "tools": session.tool_defs })),
        "tools/call" => {
            let name = message
                .pointer("/params/name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let args = message
                .pointer("/params/arguments")
                .cloned()
                .unwrap_or(json!({}));
            reply(call_tool(proxy, session, &name, args))
        }
        "ping" => reply(json!({})),
        _ => reply(json!({})),
    };
    write_json(stream, 200, &response);
}

fn tool_result(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

/// 校验并挂起一次工具调用，直到 QMAI 带着工具结果回来。
fn call_tool(proxy: &Arc<Proxy>, session: &Arc<Session>, name: &str, args: Value) -> Value {
    if !session.tools_enabled.load(Ordering::Acquire) {
        return tool_result("青幕尚在接收分段资料，此时不能执行工具。".into(), true);
    }
    let schema = session.tools.get(name);
    let errors = match schema {
        Some(schema) => validate_tool_arguments(schema, &args),
        None => vec![format!("未知工具 {name}")],
    };
    if !errors.is_empty() {
        eprintln!(
            "[antigravity-agent] 参数校验失败 {name}: {}",
            errors.join("; ")
        );
        return tool_result(tool_error_text(name, &errors, schema), true);
    }
    let call_id = format!("{CALL_PREFIX}{}", Uuid::new_v4().simple());
    let (sender, receiver) = mpsc::channel();
    if let Ok(mut pending) = session.pending.lock() {
        if session.closed.load(Ordering::Acquire) {
            return tool_result("此工具会话已结束。".into(), true);
        }
        pending.insert(call_id.clone(), sender);
    }
    if let Ok(mut index) = proxy.call_index.lock() {
        index.insert(call_id.clone(), session.id.clone());
    }
    if let Ok(mut batch) = session.batch.lock() {
        batch.push(PendingCall {
            id: call_id.clone(),
            name: name.to_string(),
            arguments: args,
        });
    }
    let generation = session.batch_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let flush_session = session.clone();
    thread::spawn(move || {
        thread::sleep(TOOL_BATCH_WINDOW);
        if flush_session.batch_generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let calls: Vec<PendingCall> = flush_session
            .batch
            .lock()
            .map(|mut batch| std::mem::take(&mut *batch))
            .unwrap_or_default();
        if !calls.is_empty() {
            flush_session.push(Event::ToolCalls(calls));
        }
    });
    let started = Instant::now();
    eprintln!("[antigravity-acp] 工具={name} 调用={call_id} 等待青幕执行");
    let outcome = receiver.recv_timeout(PENDING_TOOL_TIMEOUT);
    eprintln!(
        "[antigravity-acp] 工具={name} 调用={call_id} 回填成功={} 等待毫秒={}",
        matches!(&outcome, Ok(Ok(_))),
        started.elapsed().as_millis()
    );
    if let Ok(mut index) = proxy.call_index.lock() {
        index.remove(&call_id);
    }
    match outcome {
        Ok(Ok(text)) => tool_result(text, false),
        Ok(Err(message)) => tool_result(message, true),
        Err(_) => {
            // 30 分钟没有等到结果：认为 QMAI 已经放弃这一回合，结束 agy。
            let proxy = proxy.clone();
            let session = session.clone();
            thread::spawn(move || proxy.drop_session(&session));
            tool_result(
                "等待青幕写作返回工具结果超时，本回合已结束。".to_string(),
                true,
            )
        }
    }
}

fn trailing_tool_results(messages: &[Value]) -> Vec<(String, String)> {
    let mut results = Vec::new();
    for message in messages.iter().rev() {
        if message.get("role").and_then(Value::as_str) != Some("tool") {
            break;
        }
        let id = message
            .get("tool_call_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        results.push((
            id,
            content_text(message.get("content").unwrap_or(&Value::Null)),
        ));
    }
    results.reverse();
    results
}

/// 本轮生成的调用只能交回原会话。连接失效时重开会话可能使模型重复执行已经成功的工具。
fn resume_session(proxy: &Proxy, messages: &[Value]) -> Result<Option<Arc<Session>>, String> {
    let results = trailing_tool_results(messages);
    let Some((first, _)) = results.first() else {
        return Ok(None);
    };
    let session_id = proxy
        .call_index
        .lock()
        .map_err(|_| "工具调用索引不可用")?
        .get(first)
        .cloned();
    let Some(session) = session_id.and_then(|id| proxy.session(&id)) else {
        if results.iter().any(|(id, _)| id.starts_with(CALL_PREFIX)) {
            return Err("原 ACP 工具会话已结束，无法回填结果。".into());
        }
        // 来自历史对话或其它后端的工具结果仍可作为上下文。
        return Ok(None);
    };
    let mut pending = session.pending.lock().map_err(|_| "工具调用状态不可用")?;
    let mut seen = std::collections::HashSet::new();
    if results
        .iter()
        .any(|(id, _)| !pending.contains_key(id) || !seen.insert(id))
    {
        return Err("工具结果重复或不属于此 ACP 会话。".into());
    }
    for (id, text) in results {
        if let Some(sender) = pending.remove(&id) {
            sender
                .send(Ok(text))
                .map_err(|_| "ACP 工具已结束等待，无法回填结果。")?;
        }
    }
    drop(pending);
    Ok(Some(session))
}

fn spawn_session(proxy: &Arc<Proxy>, body: &Value) -> Result<Arc<Session>, String> {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tools = body
        .get("tools")
        .and_then(Value::as_array)
        .filter(|_| body["tool_choice"] != "none")
        .map(Vec::as_slice)
        .unwrap_or_default();
    let tool_defs = openai_tools_to_mcp(tools);
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|m| !m.is_empty() && *m != "default")
        .unwrap_or(DEFAULT_AGENT_MODEL)
        .to_string();
    let session_id = Uuid::new_v4().simple().to_string();
    let (stop, cancelled) = oneshot::channel();
    let tools_enabled = Arc::new(AtomicBool::new(false));
    let prompt = build_agent_prompt(&messages, &tool_defs);
    let session = Arc::new(Session {
        id: session_id.clone(),
        mcp_token: Uuid::new_v4().simple().to_string(),
        model: model.clone(),
        tools: tool_defs
            .iter()
            .filter_map(|tool| {
                Some((
                    tool.get("name")?.as_str()?.to_string(),
                    tool.get("inputSchema")?.clone(),
                ))
            })
            .collect(),
        tool_defs,
        events: Mutex::new(VecDeque::new()),
        signal: Condvar::new(),
        pending: Mutex::new(HashMap::new()),
        batch: Mutex::new(Vec::new()),
        batch_generation: AtomicU64::new(0),
        cancel: Mutex::new(Some(stop)),
        tools_enabled: tools_enabled.clone(),
        closed: AtomicBool::new(false),
    });
    let acp_tools = (!session.tools.is_empty()).then(|| SessionTools {
        url: format!("{}/mcp/{session_id}", proxy.base_url()),
        token: session.mcp_token.clone(),
        names: session.tools.keys().cloned().collect(),
        enabled: tools_enabled,
    });
    proxy
        .sessions
        .lock()
        .map_err(|_| "代理状态不可用".to_string())?
        .insert(session_id, session.clone());

    let task_session = session.clone();
    let task_proxy = proxy.clone();
    tauri::async_runtime::spawn(async move {
        let result =
            antigravity_acp::complete(&model, &prompt, None, acp_tools, cancelled, |text| {
                task_session.push(Event::Text(text.to_string()));
            })
            .await;
        let event = match result {
            Ok(usage) => Event::Done { usage, error: None },
            Err(error) => Event::Done {
                usage: None,
                error: Some(error),
            },
        };
        task_session.push(event);
        // 断开的客户端可能收不到终态；给当前响应留出排空事件的时间。
        tokio::time::sleep(Duration::from_secs(2)).await;
        task_proxy.drop_session(&task_session);
    });
    Ok(session)
}

fn handle_chat(proxy: &Arc<Proxy>, request: &HttpRequest, mut stream: TcpStream) {
    let body: Value = match serde_json::from_slice(&request.body) {
        Ok(body) => body,
        Err(e) => {
            write_json(
                &mut stream,
                400,
                &json!({"error": {"message": format!("请求不是合法 JSON：{e}")}}),
            );
            return;
        }
    };
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let streaming = body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let session = match resume_session(proxy, &messages) {
        Ok(Some(session)) => session,
        Ok(None) => match spawn_session(proxy, &body) {
            Ok(session) => session,
            Err(error) => {
                write_json(&mut stream, 500, &json!({"error": {"message": error}}));
                return;
            }
        },
        Err(error) => {
            write_json(&mut stream, 409, &json!({"error": {"message": error}}));
            return;
        }
    };
    let completion_id = format!("chatcmpl-{}", Uuid::new_v4().simple());
    if streaming {
        stream_events(proxy, &session, &completion_id, stream);
    } else {
        collect_events(proxy, &session, &completion_id, stream);
    }
}

fn client_gone(stream: &TcpStream) -> bool {
    let _ = stream.set_nonblocking(true);
    let mut probe = [0_u8; 1];
    let gone = matches!(stream.peek(&mut probe), Ok(0));
    let _ = stream.set_nonblocking(false);
    gone
}

fn stream_events(proxy: &Arc<Proxy>, session: &Arc<Session>, id: &str, mut stream: TcpStream) {
    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
    if stream.write_all(head.as_bytes()).is_err() {
        proxy.drop_session(session);
        return;
    }
    let model = session.model.clone();
    let mut sent_role = false;
    loop {
        let event = session.next_event(SSE_KEEPALIVE);
        let payload = match event {
            None => {
                if session.closed.load(Ordering::SeqCst) {
                    let error = json!({"error": {"message": "Antigravity 会话已结束"}});
                    let _ =
                        stream.write_all(format!("data: {error}\n\ndata: [DONE]\n\n").as_bytes());
                    return;
                }
                // 保活；写失败或对端已关闭说明 QMAI 取消了请求，结束 agy。
                if stream.write_all(b": keepalive\n\n").is_err() || client_gone(&stream) {
                    proxy.drop_session(session);
                    return;
                }
                continue;
            }
            Some(Event::Text(text)) => {
                let delta = if sent_role {
                    json!({"content": text})
                } else {
                    json!({"role": "assistant", "content": text})
                };
                sent_role = true;
                chunk(id, &model, delta, None, None)
            }
            Some(Event::ToolCalls(calls)) => {
                let mut out = chunk(id, &model, tool_calls_delta(&calls), None, None);
                out.push_str(&chunk(id, &model, json!({}), Some("tool_calls"), None));
                out.push_str("data: [DONE]\n\n");
                if stream.write_all(out.as_bytes()).is_err() {
                    proxy.drop_session(session);
                }
                return;
            }
            Some(Event::Done { usage, error }) => {
                let out = match error {
                    Some(message) => format!(
                        "data: {}\n\ndata: [DONE]\n\n",
                        json!({"error": {"message": message}})
                    ),
                    None => {
                        let mut out = chunk(
                            id,
                            &model,
                            json!({}),
                            Some("stop"),
                            usage.as_ref().map(openai_usage),
                        );
                        out.push_str("data: [DONE]\n\n");
                        out
                    }
                };
                let _ = stream.write_all(out.as_bytes());
                proxy.drop_session(session);
                return;
            }
        };
        if stream.write_all(payload.as_bytes()).is_err() {
            proxy.drop_session(session);
            return;
        }
    }
}

fn collect_events(proxy: &Arc<Proxy>, session: &Arc<Session>, id: &str, mut stream: TcpStream) {
    let mut text = String::new();
    let started = Instant::now();
    loop {
        match session.next_event(SSE_KEEPALIVE) {
            None => {
                if session.closed.load(Ordering::SeqCst)
                    || client_gone(&stream)
                    || started.elapsed() > PENDING_TOOL_TIMEOUT
                {
                    proxy.drop_session(session);
                    return;
                }
            }
            Some(Event::Text(delta)) => text.push_str(&delta),
            Some(Event::ToolCalls(calls)) => {
                let message = json!({
                    "role": "assistant",
                    "content": if text.trim().is_empty() { Value::Null } else { json!(text) },
                    "tool_calls": tool_calls_delta(&calls)["tool_calls"].as_array().map(|calls| calls.iter().map(|c| {
                        let mut c = c.clone();
                        if let Some(obj) = c.as_object_mut() { obj.remove("index"); }
                        c
                    }).collect::<Vec<_>>()),
                });
                write_json(
                    &mut stream,
                    200,
                    &json!({
                        "id": id, "object": "chat.completion", "created": unix_now(), "model": session.model,
                        "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls"}],
                    }),
                );
                return;
            }
            Some(Event::Done { usage, error }) => {
                proxy.drop_session(session);
                if let Some(message) = error {
                    write_json(&mut stream, 502, &json!({"error": {"message": message}}));
                } else {
                    write_json(
                        &mut stream,
                        200,
                        &json!({
                            "id": id, "object": "chat.completion", "created": unix_now(), "model": session.model,
                            "choices": [{"index": 0, "message": {"role": "assistant", "content": text.trim()}, "finish_reason": "stop"}],
                            "usage": usage.as_ref().map(openai_usage),
                        }),
                    );
                }
                return;
            }
        }
    }
}

fn ensure_proxy() -> Result<Arc<Proxy>, String> {
    let mut slot = proxy_slot()
        .lock()
        .map_err(|_| "Antigravity 代理状态不可用".to_string())?;
    if let Some(proxy) = slot.as_ref() {
        if !proxy.stop.load(Ordering::SeqCst) {
            return Ok(proxy.clone());
        }
    }
    let proxy = start_proxy()?;
    *slot = Some(proxy.clone());
    Ok(proxy)
}

/// 启动（或复用）主 Agent 代理，返回 OpenAI 兼容地址和令牌。
#[tauri::command]
pub async fn antigravity_agent_proxy_ensure() -> Result<AgentProxyStatus, String> {
    let proxy = ensure_proxy()?;
    Ok(AgentProxyStatus {
        base_url: format!("{}/v1", proxy.base_url()),
        token: proxy.token.clone(),
    })
}

/// 取消挂起这些工具调用的 agy 会话（Agent 被用户停止时调用）。
#[tauri::command]
pub async fn antigravity_agent_cancel(tool_call_ids: Vec<String>) -> Result<usize, String> {
    let Some(proxy) = proxy_slot().lock().ok().and_then(|slot| slot.clone()) else {
        return Ok(0);
    };
    let session_ids: std::collections::HashSet<String> = {
        let index = proxy
            .call_index
            .lock()
            .map_err(|_| "代理状态不可用".to_string())?;
        tool_call_ids
            .iter()
            .filter_map(|id| index.get(id).cloned())
            .collect()
    };
    let mut cancelled = 0;
    for session_id in session_ids {
        if let Some(session) = proxy.session(&session_id) {
            proxy.drop_session(&session);
            cancelled += 1;
        }
    }
    Ok(cancelled)
}

/// 应用退出时结束所有 agy 进程。
pub fn shutdown_antigravity_agent_proxy() {
    if let Some(proxy) = proxy_slot().lock().ok().and_then(|mut slot| slot.take()) {
        proxy.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Value {
        json!({"type": "object", "properties": {"name": {"type": "string"}, "count": {"type": "number"}, "mode": {"type": "string", "enum": ["a", "b"]}}, "required": ["name"]})
    }

    #[test]
    fn validation_reports_missing_unknown_and_wrong_types() {
        assert!(validate_tool_arguments(&schema(), &json!({"name": "第3章"})).is_empty());
        let errors = validate_tool_arguments(&schema(), &json!({"chapter_number": 3}));
        assert!(errors.iter().any(|e| e.contains("缺少必填参数 \"name\"")));
        assert!(errors
            .iter()
            .any(|e| e.contains("未知参数 \"chapter_number\"")));
        let errors =
            validate_tool_arguments(&schema(), &json!({"name": 1, "count": "x", "mode": "c"}));
        assert_eq!(errors.len(), 3);
        assert_eq!(
            validate_tool_arguments(&schema(), &json!([1])),
            vec!["参数必须是 JSON 对象".to_string()]
        );
        assert!(
            validate_tool_arguments(&json!({"type": "object", "properties": {}}), &json!({}))
                .is_empty()
        );
    }

    #[test]
    fn error_text_includes_schema_for_retry() {
        let text = tool_error_text(
            "read_chapter",
            &["缺少必填参数 \"name\"".into()],
            Some(&schema()),
        );
        assert!(text.contains("qmai/read_chapter") && text.contains("\"required\":[\"name\"]"));
        assert!(tool_error_text("nope", &[], None).contains("没有名为 nope 的工具"));
    }

    #[test]
    fn prompt_carries_history_tool_results_and_schemas() {
        let tools = openai_tools_to_mcp(&[
            json!({"type": "function", "function": {"name": "read_chapter", "description": "读章节", "parameters": schema()}}),
        ]);
        let prompt = build_agent_prompt(
            &[
                json!({"role": "system", "content": "你是调度器"}),
                json!({"role": "user", "content": [{"type": "text", "text": "看第3章"}]}),
                json!({"role": "assistant", "content": null, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "read_chapter", "arguments": "{\"name\":\"第3章\"}"}}]}),
                json!({"role": "tool", "tool_call_id": "call_1", "content": "正文"}),
            ],
            &tools,
        );
        assert!(prompt.contains("<system>\n你是调度器"));
        assert!(prompt.contains("<user>\n看第3章"));
        assert!(prompt.contains("call_1") && prompt.contains("<tool_result id=\"call_1\">\n正文"));
        assert!(prompt.contains("- qmai/read_chapter: {"));
    }

    #[test]
    fn tool_call_chunks_follow_openai_shape() {
        let calls = vec![
            PendingCall {
                id: "call_a".into(),
                name: "read_chapter".into(),
                arguments: json!({"name": "第3章"}),
            },
            PendingCall {
                id: "call_b".into(),
                name: "list_chapters".into(),
                arguments: json!({}),
            },
        ];
        let delta = tool_calls_delta(&calls);
        assert_eq!(delta["tool_calls"][1]["index"], 1);
        assert_eq!(
            delta["tool_calls"][0]["function"]["arguments"],
            "{\"name\":\"第3章\"}"
        );
        let sse = chunk("c", "m", delta, Some("tool_calls"), None);
        assert!(sse.starts_with("data: {") && sse.ends_with("\n\n"));
    }

    #[test]
    fn proxy_rejects_bad_token_and_resumes_parked_calls() {
        let proxy = start_proxy().unwrap();
        let send = |path: &str, token: &str, body: &str| -> String {
            let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, proxy.port)).unwrap();
            let req = format!("POST {path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            s.write_all(req.as_bytes()).unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        };
        assert!(send("/v1/chat/completions", "bad", "{}").contains("401"));
        // 手工放一个会话，模拟 agy 通过 MCP 调工具。
        let session = Arc::new(Session {
            id: "s1".into(),
            mcp_token: "session-test-token".into(),
            model: "m".into(),
            tools: [("read_chapter".to_string(), schema())]
                .into_iter()
                .collect(),
            tool_defs: vec![],
            events: Mutex::new(VecDeque::new()),
            signal: Condvar::new(),
            pending: Mutex::new(HashMap::new()),
            batch: Mutex::new(Vec::new()),
            batch_generation: AtomicU64::new(0),
            cancel: Mutex::new(None),
            tools_enabled: Arc::new(AtomicBool::new(true)),
            closed: AtomicBool::new(false),
        });
        proxy
            .sessions
            .lock()
            .unwrap()
            .insert("s1".into(), session.clone());
        assert!(send("/v1/chat/completions", &session.mcp_token, "{}").contains("401"));
        assert!(send("/mcp/s1", &proxy.token, "{}").contains("401"));
        let token = session.mcp_token.clone();
        let bad = send(
            "/mcp/s1",
            &token,
            r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_chapter","arguments":{"chapter":3}}}"#,
        );
        assert!(bad.contains("isError\":true") && bad.contains("未知参数"));
        let port = proxy.port;
        let caller = thread::spawn(move || {
            let mut s = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
            let body = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"read_chapter","arguments":{"name":"第3章"}}}"#;
            let req = format!("POST /mcp/s1 HTTP/1.1\r\nAuthorization: Bearer {token}\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            s.write_all(req.as_bytes()).unwrap();
            let mut out = String::new();
            let _ = s.read_to_string(&mut out);
            out
        });
        let Some(Event::ToolCalls(calls)) = session.next_event(Duration::from_secs(3)) else {
            panic!("no tool call")
        };
        assert_eq!(calls[0].name, "read_chapter");
        let messages =
            vec![json!({"role": "tool", "tool_call_id": calls[0].id, "content": "第三章正文"})];
        let mut mixed = messages.clone();
        mixed.push(
            json!({"role":"tool","tool_call_id":"call_agy_unknown","content":"另一轮的结果"}),
        );
        assert!(resume_session(&proxy, &mixed).is_err());
        assert!(resume_session(&proxy, &messages).unwrap().is_some());
        assert!(resume_session(&proxy, &messages).is_err());
        let mcp_reply = caller.join().unwrap();
        assert!(mcp_reply.contains("第三章正文") && mcp_reply.contains("isError\":false"));
        proxy.shutdown();
    }
    #[tokio::test]
    #[ignore = "使用已登录的 agy 验证长输入及超过 3 分钟的 MCP 工具，消耗模型额度"]
    async fn live_acp_tool_preserves_long_input_and_returns_the_result_once() {
        let proxy = start_proxy().unwrap();
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(240))
            .build()
            .unwrap();
        let endpoint = format!("{}/v1/chat/completions", proxy.base_url());
        let (context, marks) = antigravity_acp::long_test_input();
        let messages = vec![
            json!({"role":"user","content": format!("{context}\n请恰好调用一次 read_ticket，三个参数依次填入首、中、末编号。工具返回一个随机票号。读取后只回复该票号。")}),
        ];
        let mut body = json!({"model":"gemini-4-hydrogen-high","messages":messages,"tools":[{"type":"function","function":{
            "name":"read_ticket","description":"核对登记本中的三个编号，返回当天票号",
            "parameters":{"type":"object","properties":{"first":{"type":"string"},"middle":{"type":"string"},"last":{"type":"string"}},"required":["first","middle","last"]}
        }}]});
        let call = |body: Value| {
            client
                .post(&endpoint)
                .bearer_auth(&proxy.token)
                .json(&body)
                .send()
        };
        let reply: Value = call(body.clone()).await.unwrap().json().await.unwrap();
        let msg = reply.pointer("/choices/0/message").expect("缺少助手消息");
        let calls = msg["tool_calls"].as_array().expect("未调用 MCP 工具");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["function"]["name"], "read_ticket");
        let args: Value =
            serde_json::from_str(calls[0]["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(
            args,
            json!({"first":marks[0],"middle":marks[1],"last":marks[2]})
        );
        // 故意跨过 agy 默认 180 秒工具期限。随机结果只在回填时交给模型。
        tokio::time::sleep(Duration::from_secs(190)).await;
        assert_eq!(proxy.call_index.lock().unwrap().len(), 1);
        let ticket = Uuid::new_v4().simple().to_string();
        let history = body["messages"].as_array_mut().unwrap();
        history.push(msg.clone());
        history.push(json!({"role":"tool","tool_call_id":calls[0]["id"],"content":ticket}));
        let reply: Value = call(body).await.unwrap().json().await.unwrap();
        assert_eq!(
            reply
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str),
            Some("stop")
        );
        assert!(reply
            .pointer("/choices/0/message/content")
            .and_then(Value::as_str)
            .unwrap()
            .contains(&ticket));
        assert!(proxy.call_index.lock().unwrap().is_empty());
        proxy.shutdown();
    }
}
