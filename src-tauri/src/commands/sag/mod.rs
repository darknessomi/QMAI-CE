//! QMAI adapter for the embedded SAG-Wiki V10 retrieval engine.
//! Upstream Zleap-AI/SAG-Wiki, b6940ac834b3b1ec651c0b49dc1b0c45d4d74c4a, MIT.
mod jev;
mod retrieval;
mod sag2_v10;
mod store;
mod text;

use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, PartialEq)]
struct SourceSpan {
    start_byte: usize,
    end_byte: usize,
    start_line: usize,
    end_line: usize,
    start_column: usize,
    end_column: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    #[serde(skip)]
    id: i64,
    pub path: String,
    title: String,
    #[serde(skip)]
    heading: String,
    pub content: String,
    start_line: usize,
    end_line: usize,
    score: f64,
    #[serde(skip)]
    order: usize,
    #[serde(skip)]
    previous_score: Option<f64>,
    #[serde(skip)]
    via_page: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    endpoint: String,
    model: String,
    #[serde(default)]
    api_key: Option<String>,
    #[cfg(test)]
    #[serde(skip)]
    http_calls: Option<std::sync::Arc<std::sync::atomic::AtomicUsize>>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceVersion {
    path: String,
    content_hash: String,
}

static REQUESTS: LazyLock<Mutex<HashMap<String, CancellationToken>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct Request(String);
impl Request {
    fn start(id: String) -> Result<(Self, CancellationToken)> {
        ensure!(!id.is_empty() && id.len() <= 256, "检索请求标识无效");
        let mut requests = REQUESTS.lock().unwrap_or_else(|e| e.into_inner());
        ensure!(!requests.contains_key(&id), "检索请求标识重复");
        let token = CancellationToken::new();
        requests.insert(id.clone(), token.clone());
        Ok((Self(id), token))
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        REQUESTS
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.0);
    }
}

#[tauri::command]
pub fn sag_cancel(request_id: String) {
    if let Some(token) = REQUESTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&request_id)
    {
        token.cancel();
    }
}

#[tauri::command]
pub async fn sag_scope_fingerprint(
    project_path: String,
    files: Vec<String>,
    before_chapter: Option<u64>,
) -> Result<store::Fingerprint, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = crate::migration_gate::enter_io().map_err(anyhow::Error::msg)?;
        store::fingerprint(&project_path, files, before_chapter)
    })
    .await
    .map_err(|_| "校验检索资料失败".to_owned())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sag_search(
    project_path: String,
    query: String,
    files: Vec<String>,
    top_k: usize,
    before_chapter: Option<u64>,
    scope_fingerprint: Option<String>,
    query_source: Option<SourceVersion>,
    config: Config,
    request_id: String,
) -> Result<Vec<Candidate>, String> {
    let (request, cancel) = Request::start(request_id).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        let _request = request;
        let _lease = crate::migration_gate::enter_io().map_err(anyhow::Error::msg)?;
        ensure!(
            !query.trim().is_empty() && query.chars().count() <= 2000,
            "检索问题须为 1 至 2000 个字符"
        );
        ensure!((1..=100).contains(&top_k), "结果数量须为 1 至 100");
        ensure!(before_chapter != Some(0), "写作章号必须大于零");
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let mut client = jev::Judge::new(config)?;
        if let Some(source) = query_source {
            client.guard_source(&project_path, &source)?;
        }
        let store = store::Store::open(&project_path, files, before_chapter, &cancel)?;
        if let Some(expected) = scope_fingerprint {
            ensure!(
                expected == store.fingerprint(),
                "检索资料已变化，请重新检索"
            );
        }
        tauri::async_runtime::block_on(async {
            let score = |items, evidence| client.score(&store, &query, items, evidence, &cancel);
            let result = retrieval::retrieve(
                &store,
                &query,
                top_k,
                Default::default(),
                &cancel,
                score,
                |_, _, _| {},
            )
            .await?;
            client.verify_sources()?;
            store.quotations(result, top_k, &cancel)
        })
    })
    .await
    .map_err(|_| "检索任务异常终止".to_string())?
    .map_err(|e| format!("SAG2 检索失败：{e}"))
}

#[tauri::command]
pub async fn sag_test_jev(config: Config) -> Result<(), String> {
    let judge = jev::Judge::new(config).map_err(|e| e.to_string())?;
    judge
        .pair("测试连接", "测试连接", "fact", &CancellationToken::new())
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sag_judge_pair(
    project_path: String,
    sources: [SourceVersion; 2],
    config: Config,
    left: String,
    right: String,
    purpose: Option<String>,
    request_id: String,
) -> Result<f64, String> {
    let (request, token) = Request::start(request_id).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<_> {
        let _request = request;
        let _lease = crate::migration_gate::enter_io().map_err(anyhow::Error::msg)?;
        let mut judge = jev::Judge::new(config)?;
        for version in sources {
            judge.guard_source(&project_path, &version)?;
        }
        tauri::async_runtime::block_on(judge.pair(
            &left,
            &right,
            purpose.as_deref().unwrap_or("fact"),
            &token,
        ))
    })
    .await
    .map_err(|_| "查重判定异常终止".to_owned())?
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests;
