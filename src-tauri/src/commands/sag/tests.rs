// Frozen upstream fixture from tests/sag2_v10_oracle.json at b6940ac8 (MIT).
// Request hashes cover canonically sorted JSON including the decoded state string.
use super::*;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, path::Path};
const ORACLE: &str = include_str!("sag2_v10_oracle.json");

fn put(root: &Path, relative: &str, content: &str) -> String {
    let p = root.join(relative);
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(&p, content).unwrap();
    p.to_str().unwrap().to_owned()
}
fn source_version(path: String, content: &str) -> SourceVersion {
    SourceVersion {
        path,
        content_hash: format!("{:x}", Sha256::digest(content.as_bytes())),
    }
}
fn canon(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(canon),
        Value::Object(fields) => {
            for v in fields.values_mut() {
                canon(v);
            }
            fields.sort_keys();
        }
        _ => {}
    }
}

#[tokio::test]
async fn fixed_sag2_oracle_matches_tokens_requests_expansion_rounds_and_ranking() {
    let oracle: Value = serde_json::from_str(ORACLE).unwrap();
    for row in oracle["tokenizer"].as_array().unwrap() {
        assert_eq!(
            json!(text::tokenize(row["text"].as_str().unwrap())),
            row["tokens"]
        );
    }
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let files = oracle["corpus"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            put(
                &root,
                &format!("QM/{}.md", c[0].as_str().unwrap()),
                c[1].as_str().unwrap(),
            )
        })
        .collect();
    let token = CancellationToken::new();
    let store = store::Store::open(root.to_str().unwrap(), files, None, &token).unwrap();
    for case in oracle["cases"].as_array().unwrap() {
        let mut round = 0;
        let mut traced = 0;
        let query = case["query"].as_str().unwrap();
        let results = retrieval::retrieve(
            &store,
            query,
            10,
            serde_json::from_value(case["options"].clone()).unwrap(),
            &token,
            |mut candidates, evidence| {
                let keys: Vec<_> = evidence.iter().map(|c| c.title.as_str()).collect();
                let batches =
                    jev::jev_batches(query, candidates.clone(), &evidence, "jev-latest").unwrap();
                assert_eq!(batches.len(), 1);
                let mut request = batches.into_iter().next().unwrap().0;
                request["state"] =
                    serde_json::from_str(request["state"].as_str().unwrap()).unwrap();
                canon(&mut request);
                let hash = format!(
                    "{:x}",
                    Sha256::digest(serde_json::to_vec(&request).unwrap())
                );
                assert_eq!(
                    hash, case["requests"][round],
                    "{query} / 第 {round} 轮 Jev 请求"
                );
                round += 1;
                for c in &mut candidates {
                    c.score = match c.title.as_str() {
                        "Anchor" => 0.8,
                        "Multiple" if keys.contains(&"Anchor") => 0.95,
                        "Multiple" => 0.1,
                        "Bridge" if keys.contains(&"Multiple") => 0.99,
                        "Bridge" => 0.05,
                        "High" => 0.7,
                        "Series" => 0.08,
                        _ => 0.01,
                    };
                }
                std::future::ready(Ok(candidates))
            },
            |hop, candidates, terms| {
                assert_eq!(
                    json!(candidates.iter().map(|c| c.id).collect::<Vec<_>>()),
                    case["rounds"][hop]["ids"],
                    "{query} / 第 {hop} 轮候选"
                );
                assert_eq!(
                    json!(terms.iter().map(|t| &t.term).collect::<Vec<_>>()),
                    case["rounds"][hop]["terms"],
                    "{query} / 第 {hop} 轮扩展词"
                );
                traced += 1;
            },
        )
        .await
        .unwrap();
        assert_eq!(round, case["requests"].as_array().unwrap().len());
        assert_eq!(traced, round);
        let scores: HashMap<i64, f64> = case["ids"]
            .as_array()
            .unwrap()
            .iter()
            .zip(case["scores"].as_array().unwrap())
            .map(|(id, score)| (id.as_i64().unwrap(), score.as_f64().unwrap()))
            .collect();
        assert_eq!(results.len(), scores.len());
        assert!(results.windows(2).all(|p| p[0].score >= p[1].score));
        for hit in results {
            assert_eq!(scores[&hit.id], hit.score);
        }
    }
}

#[test]
fn writing_search_includes_the_previous_draft_without_unlocking_derived_pages() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let chapter = |n, status, body| {
        format!("---\nchapter_number: {n}\nchapter_status: {status}\n---\n{body}")
    };
    let first = put(
        &root,
        "QM/chapters/第一章.md",
        &chapter(1, "final", "通行许可。"),
    );
    let future = put(
        &root,
        "QM/chapters/第三章.md",
        &chapter(3, "final", "未来秘密。"),
    );
    let draft = put(
        &root,
        "QM/chapters/草稿.md",
        &chapter(2, "draft", "草稿秘密。"),
    );
    let excluded = put(
        &root,
        "QM/chapters/禁读.md",
        "---\nai_exclude: 'YES'\nchapter_number: 1\nchapter_status: final\n---\n被排除的秘密。",
    );
    let page = put(
        &root,
        "QM/entities/守卫.md",
        "---\nsource_sequence: 2\n---\n旧快照秘密。",
    );
    let files = vec![first.clone(), future, draft.clone(), excluded, page];
    let scope = store::fingerprint(root.to_str().unwrap(), files.clone(), Some(3)).unwrap();
    assert_eq!(scope.previous_draft_path.as_ref(), Some(&draft));
    assert_eq!(scope.chapters.len(), 1);
    assert!(scope.pages.is_empty());
    let later = store::fingerprint(root.to_str().unwrap(), files.clone(), Some(4)).unwrap();
    assert!(later.previous_draft_path.is_none());
    let token = CancellationToken::new();
    // Warm the persisted FTS with a wider scope first.
    drop(store::Store::open(root.to_str().unwrap(), files.clone(), None, &token).unwrap());
    let dbfile = root.join(".qmai/sag/index-v10.sqlite");
    let audit = rusqlite::Connection::open(&dbfile).unwrap();
    audit.execute_batch("CREATE TRIGGER changed BEFORE INSERT ON chunks BEGIN SELECT RAISE(ABORT,'hot query rebuilt chunks'); END;").unwrap();
    let limited =
        store::Store::open(root.to_str().unwrap(), files.clone(), Some(3), &token).unwrap();
    assert_eq!(limited.chunk_count().unwrap(), 2);
    let result = limited
        .candidates(&text::match_query("通行许可"), None, &[], 5)
        .unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].start_line, 5);
    let secret = limited
        .candidates(&text::match_query("秘密"), None, &[], 5)
        .unwrap();
    assert_eq!(secret.len(), 1);
    assert_eq!(secret[0].path, draft);
    fs::write(first, "---\nai_exclude: true\n---\n原文不可再发送").unwrap();
    assert!(limited.verify(&result, &token).is_err());
    drop(limited);
    assert_eq!(
        store::Store::open(root.to_str().unwrap(), files, Some(3), &token)
            .unwrap()
            .chunk_count()
            .unwrap(),
        1
    );
}

#[tokio::test]
#[ignore = "从临时评测项目读取语料并向指定 Jev 提交。由评测工具显式运行。"]
async fn sag_replay_project() {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Job {
        project_path: String,
        files: Vec<String>,
        query: String,
        top_k: usize,
        before_chapter: Option<u64>,
        config: Option<Config>,
    }
    let filename = std::env::var_os("QMAI_SAG_EVAL").expect("需要 QMAI_SAG_EVAL 临时任务路径");
    let job: Job = serde_json::from_slice(&fs::read(filename).unwrap()).unwrap();
    let mut config = job.config.unwrap_or_else(|| {
        let dir = std::path::PathBuf::from(
            std::env::var_os("QMAI_SAG_CONFIG_DIR").expect("需要 App 数据目录"),
        )
        .join("secrets/jev");
        let envelope = fs::read_to_string(dir.join("config.enc")).expect("尚未保存 Jev 设置");
        let bytes = crate::plugins::secret_box::open(&dir.join("key.bin"), &envelope)
            .expect("无法解密 Jev 设置");
        serde_json::from_slice(&bytes).expect("Jev 设置格式错误")
    });
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    config.http_calls = Some(calls.clone());
    let start = std::time::Instant::now();
    let result = sag_search(
        job.project_path,
        job.query,
        job.files,
        job.top_k,
        job.before_chapter,
        None,
        None,
        config,
        "oracle-replay".into(),
    )
    .await;
    println!(
        "QMAI_SAG_METRICS={}",
        json!({"elapsedMs":start.elapsed().as_millis(),"jevCalls":calls.load(std::sync::atomic::Ordering::Relaxed)})
    );
    let result = result.unwrap();
    println!(
        "QMAI_SAG_RESULT={}",
        serde_json::to_string(&result).unwrap()
    );
}

#[tokio::test]
async fn judge_accepts_scored_predicates_and_cancels_active_http() {
    use axum::{routing::post, Json, Router};
    use std::sync::Arc;
    use tokio::sync::Notify;
    let reached = Arc::new(Notify::new());
    let observe = reached.clone();
    let app = Router::new().route(
        "/v1/systemone",
        post(move |Json(payload): Json<Value>| {
            let entered = observe.clone();
            async move {
                let state: Value =
                    serde_json::from_str(payload["state"].as_str().unwrap()).unwrap();
                match state["left"].as_str() {
                    Some("等待") => {
                        entered.notify_one();
                        std::future::pending::<()>().await;
                    }
                    Some("错误格式") => {
                        return Json(json!({"answers":{"equivalent":{"type":"noul","noul":1.5}}}))
                    }
                    _ => {}
                };
                assert_eq!(payload["model"], "fixture");
                Json(json!({"answers":{"equivalent":{"type":"noul","noul":0.93}}}))
            }
        }),
    );
    let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1", socket.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(socket, app).await.unwrap() });
    let config = Config {
        endpoint,
        model: "fixture".into(),
        api_key: None,
        http_calls: None,
    };
    assert!(sag_test_jev(config.clone()).await.is_ok());
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let pair = |left: &str, id: &str| {
        sag_judge_pair(
            root.to_str().unwrap().into(),
            [
                source_version(put(&root, "QM/entities/left.md", left), left),
                source_version(put(&root, "QM/entities/right.md", "对照"), "对照"),
            ],
            config.clone(),
            left.into(),
            "对照".into(),
            Some("identity".into()),
            id.into(),
        )
    };
    assert_eq!(pair("甲", "pair-success").await.unwrap(), 0.93);
    assert!(pair("错误格式", "pair-error")
        .await
        .unwrap_err()
        .contains("无效概率"));
    let active = tokio::spawn(pair("等待", "pair-cancel"));
    tokio::time::timeout(std::time::Duration::from_secs(5), reached.notified())
        .await
        .unwrap();
    sag_cancel("pair-cancel".into());
    assert!(active.await.unwrap().unwrap_err().contains("已取消"));
    server.abort();
}

#[test]
fn fingerprint_uses_content_and_rejects_foreign_files_even_if_symlinked() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let one = put(&root, "QM/facts/abc.md", "abcXYZ");
    let alias = one.replace("/QM/", "/wiki/");
    let key = store::fingerprint(root.to_str().unwrap(), vec![alias.clone()], None)
        .unwrap()
        .fingerprint;
    let token = CancellationToken::new();
    let store =
        store::Store::open(root.to_str().unwrap(), vec![one.clone()], None, &token).unwrap();
    assert_eq!(key, store.fingerprint());
    fs::write(&one, "XYZabc").unwrap();
    assert_ne!(
        store::fingerprint(root.to_str().unwrap(), vec![one], None)
            .unwrap()
            .fingerprint,
        key
    );
    #[cfg(unix)]
    {
        let foreign = put(&root, "private.md", "private");
        let link = root.join("QM/symlink.md");
        std::os::unix::fs::symlink(foreign, &link).unwrap();
        assert!(store::fingerprint(
            root.to_str().unwrap(),
            vec![link.to_str().unwrap().into()],
            None
        )
        .is_err());
    }
}

#[tokio::test]
async fn dedup_checks_query_and_both_identity_sources_before_each_http_request() {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let project = root.to_str().unwrap();
    let left = source_version(put(&root, "QM/entities/left.md", "旧名"), "旧名");
    let right = source_version(put(&root, "QM/concepts/right.md", "同义"), "同义");
    let calls = Arc::new(AtomicUsize::new(0));
    let cfg = Config {
        endpoint: "http://127.0.0.1:1".into(),
        model: "fixture".into(),
        api_key: None,
        http_calls: Some(calls.clone()),
    };

    let mut running = jev::Judge::new(cfg.clone()).unwrap();
    running.guard_source(project, &left).unwrap();
    fs::write(&left.path, "新名").unwrap();
    let result = running
        .pair("旧名", "同义", "identity", &CancellationToken::new())
        .await;
    assert!(result.unwrap_err().to_string().contains("已变化"));
    // The query page is deliberately absent from the candidate allowlist.
    let result = sag_search(
        project.into(),
        "旧名".into(),
        vec![right.path.clone()],
        1,
        None,
        None,
        Some(left.clone()),
        cfg.clone(),
        "stale-query-source".into(),
    )
    .await;
    assert!(result.unwrap_err().contains("已变化"));

    fs::write(&left.path, "旧名").unwrap();
    let excluded = "---\nai_exclude: true\n---\n同义";
    fs::write(&right.path, excluded).unwrap();
    for proof in [right.clone(), source_version(right.path.clone(), excluded)] {
        let result = sag_judge_pair(
            project.into(),
            [left.clone(), proof],
            cfg.clone(),
            "旧名".into(),
            "同义".into(),
            Some("identity".into()),
            "private-pair-source".into(),
        )
        .await;
        assert!(result.unwrap_err().contains("已变化"));
    }
    assert_eq!(calls.load(Ordering::Relaxed), 0);
}

#[tokio::test]
async fn dedup_does_not_resend_an_excluded_query_on_batch_retry() {
    use axum::{http::StatusCode, routing::post, Router};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let original = "渡船 青石码头";
    let source = source_version(put(&root, "QM/entities/source.md", original), original);
    let candidates = (1..8)
        .map(|n| {
            put(
                &root,
                &format!("QM/entities/渡船{n}.md"),
                &format!("青石码头交接记录，渡船第{n}次停靠。"),
            )
        })
        .collect();
    let edited = source.path.clone();
    let app = Router::new().route(
        "/v1/systemone",
        post(move || {
            let path = edited.clone();
            async move {
                fs::write(path, "---\nai_exclude: true\n---\n渡船 青石码头").unwrap();
                StatusCode::PAYLOAD_TOO_LARGE
            }
        }),
    );
    let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1", socket.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(socket, app).await.unwrap() });
    let calls = Arc::new(AtomicUsize::new(0));
    let cfg = Config {
        endpoint,
        model: "fixture".into(),
        api_key: None,
        http_calls: Some(calls.clone()),
    };
    let result = sag_search(
        root.to_str().unwrap().into(),
        original.into(),
        candidates,
        3,
        None,
        None,
        Some(source),
        cfg,
        "dedup-retry-guard".into(),
    )
    .await;
    assert!(result.unwrap_err().contains("已变化"));
    assert_eq!(calls.load(Ordering::Relaxed), 1);
    server.abort();
}

#[test]
fn verbatim_quotes_survive_metadata_whitespace_and_incremental_rename() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let content = "---\r\ntitle: 原稿\r\n---\r\n# 正文\r\n\r\n第一段。\r\n\r\n\r\n   第二段。";
    let path = put(&root, "QM/第一章.md", content);
    let token = CancellationToken::new();
    let store =
        store::Store::open(root.to_str().unwrap(), vec![path.clone()], None, &token).unwrap();
    let raw = store
        .candidates(&text::match_query("第二段"), None, &[], 5)
        .unwrap();
    let quotes = store.quotations(raw, 5, &token).unwrap();
    assert!(!quotes.is_empty());
    assert!(quotes
        .iter()
        .all(|hit| content.contains(&hit.content) && hit.start_line >= 4 && hit.end_line <= 9));
    let updated = root.join("QM/迁移章节.md");
    fs::rename(&path, &updated).unwrap();
    assert!(store.verify(&quotes, &token).is_err());
    drop(store);
    fs::write(&updated, "改版正文").unwrap();
    let store = store::Store::open(
        root.to_str().unwrap(),
        vec![updated.to_str().unwrap().into()],
        None,
        &token,
    )
    .unwrap();
    assert_eq!(store.chunk_count().unwrap(), 1);
    assert!(!store
        .candidates(&text::match_query("改版"), None, &[], 5)
        .unwrap()
        .is_empty());
    assert!(store
        .candidates(&text::match_query("第二段"), None, &[], 5)
        .unwrap()
        .is_empty());
}

/// Persistent test-only IPC bridge for the TypeScript production dedup runner.
/// No credentials cross the child-process boundary; stdout contains results and usage only.
#[tokio::test]
#[ignore = "供显式启用的查重实测调用"]
async fn sag_dedup_bridge() {
    use std::io::{BufRead, Write};
    let mut config: Config = match std::env::var("QMAI_SAG_MOCK_URL") {
        Ok(endpoint) => {
            let url = url::Url::parse(&endpoint).unwrap();
            assert!(matches!(url.host_str(), Some("127.0.0.1" | "localhost")));
            serde_json::from_value(json!({"endpoint":endpoint,"model":"fixture"})).unwrap()
        }
        Err(_) => {
            let base = std::path::PathBuf::from(
                std::env::var_os("QMAI_SAG_CONFIG_DIR").expect("需要 App 数据目录"),
            )
            .join("secrets/jev");
            let bytes = crate::plugins::secret_box::open(
                &base.join("key.bin"),
                &fs::read_to_string(base.join("config.enc")).expect("尚未保存 Jev 配置"),
            )
            .expect("无法读取加密配置");
            serde_json::from_slice(&bytes).expect("配置格式无效")
        }
    };
    let counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    config.http_calls = Some(counter.clone());
    for line in std::io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let id = input["requestId"].as_str().unwrap().to_owned();
        let result: Result<Value, String> = match input["command"].as_str() {
            Some("sag_scope_fingerprint") => sag_scope_fingerprint(
                input["projectPath"].as_str().unwrap().into(),
                serde_json::from_value(input["files"].clone()).unwrap(),
                input["beforeChapter"].as_u64(),
            )
            .await
            .map(|value| json!(value)),
            Some("sag_search") => sag_search(
                input["projectPath"].as_str().unwrap().to_owned(),
                input["query"].as_str().unwrap().into(),
                serde_json::from_value(input["files"].clone()).unwrap(),
                input["topK"].as_u64().unwrap() as usize,
                input["beforeChapter"].as_u64(),
                input["scopeFingerprint"].as_str().map(str::to_owned),
                serde_json::from_value(input["querySource"].clone()).unwrap(),
                config.clone(),
                id,
            )
            .await
            .map(|hits| json!(hits)),
            Some("sag_judge_pair") => sag_judge_pair(
                input["projectPath"].as_str().unwrap().into(),
                serde_json::from_value(input["sources"].clone()).unwrap(),
                config.clone(),
                input["left"].as_str().unwrap().into(),
                input["right"].as_str().unwrap().into(),
                Some("identity".into()),
                id,
            )
            .await
            .map(|p| json!(p)),
            _ => Err("未知评测命令".into()),
        };
        let calls = counter.swap(0, std::sync::atomic::Ordering::Relaxed);
        let reply = match result {
            Ok(value) => json!({"value":value,"calls":calls}),
            Err(error) => json!({"error":error,"calls":calls}),
        };
        println!("QMAI_SAG_BRIDGE={reply}");
        std::io::stdout().flush().unwrap();
    }
}

#[test]
fn writing_excludes_unattributed_page_text_even_with_a_warm_general_index() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let project = root.to_str().unwrap();
    let chapter = |n, status, excluded| {
        put(&root, &format!("QM/chapters/第{n}章.md"),
        &format!("---\nchapter_status: {status}\nchapter_number: {n}\nai_exclude: {excluded}\n---\n正文记录。"))
    };
    let page = |file, header| {
        put(
            &root,
            file,
            &format!("---\n{header}\n---\n渡口凭证由守卫签发。"),
        )
    };
    let first = chapter(1, "final", false);
    let entity = page(
        "QM/entities/守卫.md",
        "source_sequence: 1\nsources: ['001.snapshot.json']",
    );
    let concept = put(
        &root,
        "QM/concepts/通行证.md",
        "\u{feff}---\nsources: ['001.snapshot.json']\n---\n渡口凭证由守卫签发。",
    );
    let files = vec![
        entity.clone(),
        concept.clone(),
        page(
            "QM/entities/混有未来.md",
            "source_sequence: 1\nsources: ['001.snapshot.json', '005.snapshot.json']",
        ),
        page(
            "QM/entities/混有禁读.md",
            "snapshot_id: chapter-1-r1\nsources: ['003.snapshot.json']",
        ),
        page("QM/concepts/来自草稿.md", "source_sequence: 2"),
        page("QM/concepts/未知.md", "type: concept"),
        page(
            "QM/entities/规划.md",
            "source_type: outline\nsource_sequence: 1",
        ),
        page(
            "QM/entities/历史.md",
            "is_historical: true\nsource_sequence: 1",
        ),
        page(
            "QM/entities/禁读.md",
            "ai_exclude: true\nsource_sequence: 1",
        ),
        first.clone(),
        chapter(2, "draft", false),
        chapter(3, "final", true),
        chapter(5, "final", false),
    ];
    let token = CancellationToken::new();
    drop(store::Store::open(project, files.clone(), None, &token).unwrap());
    let scope = store::fingerprint(project, files.clone(), Some(5)).unwrap();
    assert_eq!(scope.chapters.len(), 1);
    let expected_pages = [&entity, &concept]
        .into_iter()
        .map(|path| {
            let content = fs::read_to_string(path).unwrap();
            let hash = Sha256::digest(content.trim_start_matches('\u{feff}').as_bytes());
            (path.clone(), format!("{hash:x}"))
        })
        .collect();
    assert_eq!(scope.pages, expected_pages);
    let store = store::Store::open(project, files, Some(5), &token).unwrap();
    assert_eq!(scope.fingerprint, store.fingerprint());
    let hits = store
        .candidates(&text::match_query("渡口凭证"), None, &[], 50)
        .unwrap();
    let paths: std::collections::HashSet<_> = hits.iter().map(|hit| hit.path.clone()).collect();
    assert_eq!(paths, [entity, concept].into_iter().collect());
    store.verify(&hits, &token).unwrap();
    assert!(!store
        .quotations(hits.clone(), 5, &token)
        .unwrap()
        .is_empty());
    fs::write(first, "---\nai_exclude: true\n---\n正文记录。").unwrap();
    assert!(store.verify(&hits, &token).is_err());
    assert!(store.quotations(hits, 5, &token).is_err());
}

#[tokio::test]
async fn mixed_page_routes_an_alias_to_readable_chapter_quotes_only() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let project = root.to_str().unwrap();
    let chapter = |n, status, flag, line| {
        put(&root, &format!("QM/chapters/第{n}章.md"),
        &format!("---\nchapter_number: {n}\nchapter_status: {status}\nai_exclude: {flag}\n---\n陈远{line}。"))
    };
    let first = chapter(1, "final", false, "在渡口签收凭证");
    let mixed = put(&root, "QM/entities/陈远.md", "---\nsource_sequence: 4\nsnapshot_id: outline-4-r1\naliases: [北岸来客]\nsources: ['001.snapshot.json','002.snapshot.json','003.snapshot.json','005.snapshot.json','outline-004.snapshot.json', 'unknown']\n---\n混合摘要里的秘密。");
    let files = vec![
        mixed.clone(),
        first.clone(),
        chapter(2, "draft", false, "草稿秘密"),
        chapter(3, "final", true, "禁读秘密"),
        chapter(5, "final", false, "未来秘密"),
        chapter(4, "final", false, "无关来源秘密"),
    ];
    let token = CancellationToken::new();
    drop(store::Store::open(project, files.clone(), None, &token).unwrap());
    let scope = store::fingerprint(project, files.clone(), Some(5)).unwrap();
    let store = store::Store::open(project, files.clone(), Some(5), &token).unwrap();
    assert_eq!(store.fingerprint(), scope.fingerprint);
    assert!(store
        .candidates(&text::match_query("北岸来客"), None, &[], 10)
        .unwrap()
        .is_empty());
    let ranked = retrieval::retrieve(
        &store,
        "北岸来客",
        5,
        Default::default(),
        &token,
        |mut candidates, evidence| {
            for hit in candidates.iter().chain(&evidence) {
                assert!(!hit.content.contains("秘密") || hit.path.ends_with("第4章.md"));
                assert_ne!(hit.path, mixed);
            }
            for hit in &mut candidates {
                hit.score = if hit.path == first { 1. } else { 0. };
            }
            std::future::ready(Ok(candidates))
        },
        |_, _, _| {},
    )
    .await
    .unwrap();
    let linked: Vec<_> = ranked
        .into_iter()
        .filter(|hit| hit.via_page.as_ref() == Some(&mixed))
        .collect();
    assert!(!linked.is_empty());
    assert!(linked.iter().all(|hit| hit.path == first));
    let quotes = store.quotations(linked.clone(), 5, &token).unwrap();
    assert_eq!(quotes[0].content, "陈远在渡口签收凭证。");
    assert_eq!(quotes[0].start_line, 6);
    fs::write(&mixed, "---\nai_exclude: true\n---\n停用").unwrap();
    assert!(store.verify(&linked, &token).is_err());
    assert_ne!(
        store.fingerprint(),
        store::fingerprint(project, files, Some(5))
            .unwrap()
            .fingerprint
    );
}

#[test]
fn legacy_preambles_and_quoted_metadata_cannot_bypass_scope() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().canonicalize().unwrap();
    let mark = |name, header| {
        put(
            &root,
            &format!("QM/chapters/{name}.md"),
            &format!("{header}\n不能泄漏。"),
        )
    };
    let hidden = mark("第1章-旧资料", "```yaml\n---\nai_exclude: 1.0\n---\n```");
    let draft = mark("第1章-草稿", "---\nchapter_status: ' final '\n---");
    let fractional = mark(
        "第1章-章号不明",
        "---\nchapter_number: 0.5\nchapter_status: final\n---",
    );
    let token = CancellationToken::new();
    let general =
        store::Store::open(root.to_str().unwrap(), vec![hidden.clone()], None, &token).unwrap();
    assert_eq!(general.chunk_count().unwrap(), 0);
    let writing = store::fingerprint(
        root.to_str().unwrap(),
        vec![hidden, draft, fractional],
        Some(2),
    )
    .unwrap();
    assert!(writing.chapters.is_empty());
    assert!(writing.previous_draft_path.is_none());
    let legacy = mark("第1章-旧稿", "---\ntype: chapter\n---");
    let scope = store::fingerprint(root.to_str().unwrap(), vec![legacy.clone()], Some(2)).unwrap();
    assert_eq!(scope.previous_draft_path, Some(legacy));
}

#[test]
fn restoring_a_pre_sag_backup_builds_the_first_index_from_restored_markdown() {
    use crate::commands::backup::{do_import_backup, ImportParams, ImportStrategy};
    use std::io::Write;
    use zip::{write::SimpleFileOptions, ZipWriter};

    let temp = tempfile::tempdir().unwrap();
    let project = temp.path().join("book");
    let zip_path = temp.path().join("legacy.zip");
    let mut archive = ZipWriter::new(fs::File::create(&zip_path).unwrap());
    let manifest =
        json!({"backup_version":1,"created_at":"2026-01-01T00:00:00Z","app_version":"2.2.0",
        "projects":[{"id":"book","name":"旧项目","path":""}]})
        .to_string();
    let passage = "港口收到带有蓝色印章的交接单。";
    for (name, value) in [
        ("manifest.json", manifest.as_str()),
        ("projects/book/wiki/entities/港口.md", passage),
        ("projects/book/.qmai/lancedb/legacy", "old index"),
    ] {
        archive
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        archive.write_all(value.as_bytes()).unwrap();
    }
    archive.finish().unwrap();
    let restored = do_import_backup(
        ImportParams {
            zip_path: zip_path.to_string_lossy().into_owned(),
            strategy: ImportStrategy::Full,
            projects: None,
            project_path_overrides: Some(HashMap::from([(
                "book".into(),
                project.to_string_lossy().into_owned(),
            )])),
        },
        temp.path(),
        &temp.path().join("jev"),
        |_| {},
    )
    .unwrap();
    assert!(restored.projects[0].success);
    assert!(!project.join(".qmai/sag").exists());
    let path = project
        .join("wiki/entities/港口.md")
        .to_string_lossy()
        .into_owned();
    let store = store::Store::open(
        project.to_str().unwrap(),
        vec![path],
        None,
        &CancellationToken::new(),
    )
    .unwrap();
    assert!(store.chunk_count().unwrap() > 0);
    assert!(store.has_match(&text::match_query("交接单"), &[]).unwrap());
    assert_eq!(
        fs::read_to_string(project.join(".qmai/lancedb/legacy")).unwrap(),
        "old index"
    );
}
