use std::io::Write;

#[test]
fn 普通来源保留旧搜索指纹并复用已有索引() {
    let summary = serde_json::json!({"id":"s", "title":"测试"});
    let stamps = vec!["file:100:mtime".to_string()];
    let old = super::json_fingerprint(&serde_json::json!([summary, "正文", stamps]));
    let current = super::search_fingerprint(&summary, "正文", &stamps, None);
    assert_eq!(old, current);
    let index = crate::search::SearchIndex::open(None).unwrap();
    index
        .refresh("s", &old, |visit| {
            visit(&serde_json::json!({"text":"正文"}));
            Ok(())
        })
        .unwrap();
    index
        .refresh("s", &current, |_| panic!("未变化的来源不应重新解析"))
        .unwrap();
    assert_ne!(
        current,
        super::search_fingerprint(&summary, "新正文", &stamps, None)
    );
}

#[test]
fn 数据库来源保留四元素内容指纹() {
    let summary = serde_json::json!({"id":"s"});
    let stamps = Vec::<String>::new();
    let current = super::search_fingerprint(&summary, "正文", &stamps, Some("hash1"));
    assert_eq!(
        current,
        super::json_fingerprint(&serde_json::json!([summary, "正文", stamps, "hash1"]))
    );
    assert_ne!(
        current,
        super::search_fingerprint(&summary, "正文", &stamps, Some("hash2"))
    );
}

use serde_json::{Value, json};
use tempfile::tempdir;

#[cfg(windows)]
use crate::cache::IndexCache;

use super::{
    DETAIL_CACHE_BYTES, DETAIL_EVENT_LIMIT, DETAIL_MESSAGE_LIMIT, DetailCache, HeadTail,
    ScanDiagnostics, SessionStore, Source, SourceFormat, compact, configured_sources,
    delete_jsonl_message, delete_legacy_session, describe_inherited_sources,
    describe_protected_source_roots, describe_sources, existing_watch_root,
    existing_watch_root_within, generic_conversation_message, is_synthetic_context, local_date_key,
    matches_filters, opencode_event_matches, parse_detail, parse_summary, resolve_kind,
    search_query_matches, sources_from_paths, split_path_list, timestamp_of, watch_roots_for,
};
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

fn codex_roots_config(roots: &[PathBuf]) -> crate::config::SourceRoots {
    crate::config::SourceRoots {
        codex: Some(
            roots
                .iter()
                .map(|root| root.to_string_lossy().into_owned())
                .collect(),
        ),
        // 显式停用其余来源：否则会回退到默认目录，把测试机上真实存在的
        // ~/.claude、~/.gemini 会话扫进测试。
        codex_archived: Some(Vec::new()),
        claude: Some(Vec::new()),
        claude_cowork: Some(Vec::new()),
        gemini: Some(Vec::new()),
        grok: Some(Vec::new()),
        pi: Some(Vec::new()),
        omp: Some(Vec::new()),
        kimi: Some(Vec::new()),
        opencode: Some(Vec::new()),
        kilo: Some(Vec::new()),
        zcode: Some(Vec::new()),
        cursor: Some(Vec::new()),
        devin: Some(Vec::new()),
        copilot: Some(Vec::new()),
        hermes: Some(Vec::new()),
        vscode_copilot: Some(Vec::new()),
        deepseek: Some(Vec::new()),
    }
}

#[test]
fn summary_text_has_limit() {
    assert_eq!(compact("abcdefgh", 6), "abc...");
}

#[test]
fn 详情读取失败保留原因并允许修复后重试() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("read-error.jsonl");
    let content = json!({"type":"session_meta","payload":{"id":"read-error"}}).to_string();
    std::fs::write(&path, &content).unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[directory.path().to_path_buf()]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    std::fs::remove_file(&path).unwrap();
    let error = store.detail("codex:read-error").unwrap_err();
    assert_eq!(error.code, crate::error::ApiError::SESSION_READ_FAILED);
    assert!(!error.message.is_empty());
    assert_eq!(
        store.detail("codex:missing").unwrap_err().code,
        crate::error::ApiError::SESSION_NOT_FOUND
    );
    std::fs::write(&path, content).unwrap();
    assert!(store.detail("codex:read-error").is_ok());
}

#[test]
fn 全文搜索覆盖中间消息并合并备注标签和排序() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("long.jsonl");
    let mut lines = vec![json!({"type":"session_meta","payload":{"id":"long","cwd":"/project"},"timestamp":"2026-01-01T00:00:00Z"}).to_string()];
    for i in 0..1200 {
        lines.push(json!({"type":"event_msg","payload":{"type":"user_message","message":if i==600 {"HTTP_404 更新 useEffect(".to_string()}else{"普通正文".repeat(40)}}}).to_string());
    }
    std::fs::write(&path, lines.join("\n")).unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[directory.path().to_path_buf()]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    let mut workspace = crate::workspace::WorkspaceSnapshot::default();
    let query = HashMap::from([("q".into(), "HTTP_404 更新".into())]);
    let result = store.search(&query, &workspace).unwrap();
    assert_eq!(result["total"], 1);
    let hit = &result["sessions"][0]["search_hits"][0];
    let context = store
        .search_context(
            "codex:long",
            hit["ordinal"].as_i64().unwrap(),
            hit["message_key"].as_str(),
            "HTTP_404",
        )
        .unwrap();
    assert!(
        context["conversation_messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["text"].as_str().unwrap().contains("HTTP_404"))
    );
    assert!(
        !store.detail("codex:long").unwrap()["conversation_messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["text"].as_str().unwrap_or_default().contains("HTTP_404"))
    );
    workspace.sessions.insert(
        "codex:long".into(),
        crate::workspace::SessionWorkspace {
            note: "特别备注".into(),
            ..Default::default()
        },
    );
    assert_eq!(
        store
            .search(
                &HashMap::from([("q".into(), "特别备注 更新".into())]),
                &workspace
            )
            .unwrap()["total"],
        1
    );
    assert_eq!(
        store
            .search(&HashMap::from([("q".into(), "不存在".into())]), &workspace)
            .unwrap()["total"],
        0
    );
    std::fs::remove_file(&path).unwrap();
    store.refresh().unwrap();
    assert_eq!(store.search(&query, &workspace).unwrap()["total"], 0);
}

fn structured_search_store() -> (tempfile::TempDir, SessionStore) {
    let directory = tempdir().unwrap();
    let path = directory.path().join("structured.jsonl");
    let lines = [
        json!({"type":"session_meta","payload":{"id":"structured","cwd":"/project"},"timestamp":"2026-02-01T00:00:00Z"}).to_string(),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"帮我查错误码 E4002 的含义"},"timestamp":"2026-02-01T00:00:01Z"}).to_string(),
        json!({"type":"response_item","payload":{"type":"tool_use","name":"read_file","call_id":"c1","arguments":"{\"path\":\"a.txt\"}"},"timestamp":"2026-02-01T00:00:02Z"}).to_string(),
        json!({"type":"response_item","payload":{"type":"tool_result","call_id":"c1","output":"错误码表：客服热线 400-1234"},"timestamp":"2026-02-01T00:00:03Z"}).to_string(),
        json!({"type":"response_item","payload":{"type":"agent_message","message":"E4002 表示参数缺失，可参考 400-1234 获取帮助"},"timestamp":"2026-02-01T00:00:04Z"}).to_string(),
    ];
    std::fs::write(&path, lines.join("\n")).unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[directory.path().to_path_buf()]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    (directory, store)
}

#[test]
fn 结构化搜索按角色过滤消息() {
    let (_directory, store) = structured_search_store();
    let workspace = crate::workspace::WorkspaceSnapshot::default();
    let result = store
        .search(
            &HashMap::from([
                ("q".into(), "E4002".into()),
                ("role".into(), "assistant".into()),
            ]),
            &workspace,
        )
        .unwrap();
    assert_eq!(result["total"], 1);
    let hits = &result["sessions"][0]["search_hits"];
    assert!(
        hits.as_array()
            .unwrap()
            .iter()
            .all(|hit| hit["field"].as_str().unwrap() != "tool")
    );

    // 角色限定为 tool 时，assistant 正文命中被排除，工具结果仍然命中。
    let result = store
        .search(
            &HashMap::from([("q".into(), "E4002".into()), ("role".into(), "tool".into())]),
            &workspace,
        )
        .unwrap();
    assert_eq!(result["total"], 0);

    let result = store
        .search(
            &HashMap::from([
                ("q".into(), "400-1234".into()),
                ("role".into(), "user".into()),
            ]),
            &workspace,
        )
        .unwrap();
    assert_eq!(result["total"], 0);
}

#[test]
fn 结构化搜索按工具名过滤消息() {
    let (_directory, store) = structured_search_store();
    let workspace = crate::workspace::WorkspaceSnapshot::default();
    let result = store
        .search(
            &HashMap::from([
                ("q".into(), "错误码表".into()),
                ("tool".into(), "read_file".into()),
            ]),
            &workspace,
        )
        .unwrap();
    assert_eq!(result["total"], 1);
    // 工具名大小写不敏感。
    let result = store
        .search(
            &HashMap::from([
                ("q".into(), "错误码表".into()),
                ("tool".into(), "READ_FILE".into()),
            ]),
            &workspace,
        )
        .unwrap();
    assert_eq!(result["total"], 1);
    let result = store
        .search(
            &HashMap::from([
                ("q".into(), "错误码表".into()),
                ("tool".into(), "write_file".into()),
            ]),
            &workspace,
        )
        .unwrap();
    assert_eq!(result["total"], 0);
}

#[test]
fn 结构化搜索支持正则模式() {
    let (_directory, store) = structured_search_store();
    let workspace = crate::workspace::WorkspaceSnapshot::default();
    let result = store
        .search(
            &HashMap::from([
                ("q".into(), r"\d{3}-\d{4}".into()),
                ("regex".into(), "1".into()),
                ("role".into(), "assistant".into()),
            ]),
            &workspace,
        )
        .unwrap();
    assert_eq!(result["total"], 1);
    let snippet = result["sessions"][0]["search_snippet"]
        .as_str()
        .unwrap_or_default();
    assert!(snippet.contains("400-1234"));

    // 无效正则返回明确错误，不静默当作普通文本。
    let error = store
        .search(
            &HashMap::from([("q".into(), "(未闭合".into()), ("regex".into(), "1".into())]),
            &workspace,
        )
        .unwrap_err();
    assert!(error.contains("正则表达式无效"));
}

#[test]
fn 结构化搜索按会话时间范围过滤() {
    let directory = tempdir().unwrap();
    for (name, id, timestamp) in [
        ("early.jsonl", "early", "2026-01-10T00:00:00Z"),
        ("late.jsonl", "late", "2026-03-10T00:00:00Z"),
    ] {
        let path = directory.path().join(name);
        let lines = [
            json!({"type":"session_meta","payload":{"id":id},"timestamp":timestamp}).to_string(),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"共有关键词仪表盘"},"timestamp":timestamp}).to_string(),
        ];
        std::fs::write(&path, lines.join("\n")).unwrap();
    }
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[directory.path().to_path_buf()]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    let workspace = crate::workspace::WorkspaceSnapshot::default();
    let in_range = store
        .search(
            &HashMap::from([
                ("q".into(), "仪表盘".into()),
                ("from".into(), "2026-02-01".into()),
                ("to".into(), "2026-04-01".into()),
            ]),
            &workspace,
        )
        .unwrap();
    assert_eq!(in_range["total"], 1);
    assert_eq!(in_range["sessions"][0]["id"], "late");
    let outside = store
        .search(
            &HashMap::from([
                ("q".into(), "仪表盘".into()),
                ("from".into(), "2026-02-01".into()),
            ]),
            &workspace,
        )
        .unwrap();
    assert_eq!(outside["total"], 1);
    let all = store
        .search(&HashMap::from([("q".into(), "仪表盘".into())]), &workspace)
        .unwrap();
    assert_eq!(all["total"], 2);
}

#[test]
fn 工作台筛选默认隐藏归档移除并支持收藏标签() {
    let summary = json!({
        "workspace": {
            "archived": true,
            "removed": true,
            "favorite": true,
            "tags": ["重要", "工作"]
        }
    });
    assert!(!matches_filters(&summary, &HashMap::new()));

    let mut query = HashMap::from([
        ("show_archived".to_string(), "true".to_string()),
        ("show_removed".to_string(), "true".to_string()),
        ("favorite".to_string(), "true".to_string()),
        ("tag".to_string(), "重要".to_string()),
    ]);
    assert!(matches_filters(&summary, &query));
    query.insert("tag".to_string(), "不存在".to_string());
    assert!(!matches_filters(&summary, &query));
}

#[test]
fn 来源筛选按来源栏分组匹配归档与_copilot_chat() {
    let codex = json!({ "source_kind": "codex", "archived": false });
    let archived = json!({ "source_kind": "codex_archived", "archived": true });
    let copilot = json!({ "source_kind": "copilot" });
    let vscode = json!({ "source_kind": "vscode_copilot" });
    let claude = json!({ "source_kind": "claude_code" });

    let codex_query = HashMap::from([("source_kind".to_string(), "codex".to_string())]);
    assert!(matches_filters(&codex, &codex_query));
    // 归档会话仍受显示开关约束，与来源栏计数口径一致。
    assert!(!matches_filters(&archived, &codex_query));
    let mut with_archived = codex_query.clone();
    with_archived.insert("show_codex_archived".to_string(), "true".to_string());
    assert!(matches_filters(&archived, &with_archived));

    let copilot_query = HashMap::from([("source_kind".to_string(), "copilot".to_string())]);
    assert!(matches_filters(&copilot, &copilot_query));
    assert!(matches_filters(&vscode, &copilot_query));
    assert!(!matches_filters(&claude, &copilot_query));
    assert!(!matches_filters(&codex, &copilot_query));
}

#[test]
fn 统计按_agent_归并归档和兼容来源() {
    let store = SessionStore {
        summaries: vec![
            json!({ "source_kind": "codex", "archived": false, "message_count": 8, "tool_count": 3, "input_tokens": 100, "output_tokens": 20, "cached_input_tokens": 50 }),
            json!({ "source_kind": "codex_archived", "archived": true, "message_count": 5, "tool_count": 2, "input_tokens": 30, "output_tokens": 5, "cached_input_tokens": 0 }),
            json!({ "source_kind": "claude_code", "archived": false, "message_count": 4, "tool_count": 1 }),
            json!({ "source_kind": "opencode", "archived": false, "message_count": 7, "tool_count": 4, "input_tokens": 10, "output_tokens": 0, "cached_input_tokens": 0 }),
        ],
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    let query = HashMap::from([("show_codex_archived".into(), "true".into())]);

    let stats = store.stats(&query, &crate::workspace::WorkspaceSnapshot::default());

    assert_eq!(
        stats["by_agent"],
        json!([
            { "label": "codex", "count": 2 },
            { "label": "claude", "count": 1 },
            { "label": "opencode", "count": 1 }
        ])
    );
    // token 维度同样按 agent 归并(输入+输出+缓存),无 token 数据的来源计 0。
    assert_eq!(
        stats["by_agent_tokens"],
        json!([
            { "label": "codex", "count": 205 },
            { "label": "opencode", "count": 10 }
        ])
    );
    assert_eq!(stats["total_tokens"], 215);
    assert_eq!(stats["total_messages"], 24);
    assert_eq!(stats["total_tools"], 10);
}

#[test]
fn refresh_discovers_source_directory_created_after_startup() {
    let base = tempdir().unwrap();
    let root = base.path().join("sessions");
    let session = format!(
        "{}\n{}\n",
        json!({ "type": "session_meta", "payload": { "id": "late", "model_provider": "custom" } }),
        json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "created later" } })
    );
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(std::slice::from_ref(&root)),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    assert!(store.summaries.is_empty());

    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("a.jsonl"), session).unwrap();
    store.refresh().unwrap();
    assert!(store.records.contains_key("codex:late"));
}

#[test]
fn refresh_after_mutation_drops_removed_file_without_full_rescan() {
    let base = tempdir().unwrap();
    let root = base.path().join("codex");
    std::fs::create_dir_all(&root).unwrap();
    for id in ["first", "second"] {
        std::fs::write(
            root.join(format!("{id}.jsonl")),
            format!(
                "{}\n",
                json!({ "type": "session_meta", "payload": { "id": id } })
            ),
        )
        .unwrap();
    }
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(std::slice::from_ref(&root)),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    let record = store.records["codex:first"].clone();
    // 模拟另一个进程写入新文件：增量刷新不应扫描到它
    std::fs::write(
        root.join("third.jsonl"),
        format!(
            "{}\n",
            json!({ "type": "session_meta", "payload": { "id": "third" } })
        ),
    )
    .unwrap();
    std::fs::remove_file(&record.path).unwrap();

    store.refresh_after_mutation(&record, Vec::new()).unwrap();

    assert!(!store.records.contains_key("codex:first"));
    assert!(store.records.contains_key("codex:second"));
    assert!(!store.records.contains_key("codex:third"));
    assert_eq!(store.summaries.len(), 1);
}

#[test]
fn refresh_records_source_errors_without_blocking_valid_sessions() {
    let base = tempdir().unwrap();
    let codex_root = base.path().join("codex");
    let claude_root = base.path().join("claude");
    std::fs::create_dir_all(&codex_root).unwrap();
    std::fs::create_dir_all(claude_root.join("sessions")).unwrap();
    std::fs::write(
        codex_root.join("valid.jsonl"),
        format!(
            "{}\n",
            json!({ "type": "session_meta", "payload": { "id": "valid" } })
        ),
    )
    .unwrap();
    std::fs::write(claude_root.join("sessions").join("broken.json"), "{broken").unwrap();
    std::fs::write(codex_root.join("healthy.jsonl"),format!("{}\n{}\n",
            json!({"type":"session_meta","payload":{"id":"healthy"}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"healthy-search-token"}})
        )).unwrap();

    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: crate::config::SourceRoots {
            codex: Some(vec![codex_root.to_string_lossy().into_owned()]),
            codex_archived: Some(Vec::new()),
            claude: Some(vec![claude_root.to_string_lossy().into_owned()]),
            claude_cowork: Some(Vec::new()),
            gemini: Some(Vec::new()),
            grok: Some(Vec::new()),
            pi: Some(Vec::new()),
            omp: Some(Vec::new()),
            kimi: Some(Vec::new()),
            opencode: Some(Vec::new()),
            kilo: Some(Vec::new()),
            zcode: Some(Vec::new()),
            cursor: Some(Vec::new()),
            devin: Some(Vec::new()),
            copilot: Some(Vec::new()),
            hermes: Some(Vec::new()),
            vscode_copilot: Some(Vec::new()),
            deepseek: Some(Vec::new()),
        },
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };

    store.refresh().unwrap();

    assert!(store.records.contains_key("codex:valid"));
    let diagnostics = store.diagnostics();
    assert_eq!(diagnostics["sources"]["codex"]["indexed_sessions"], 2);
    assert_eq!(diagnostics["sources"]["claude"]["error_count"], 1);
    assert!(diagnostics["sources"]["claude"]["last_error"].is_string());
    // 逐条原因带路径进入诊断；暂不支持桶默认为空。
    let entries = diagnostics["sources"]["claude"]["error_entries"]
        .as_array()
        .unwrap();
    assert_eq!(entries.len(), 1);
    assert!(entries[0]["path"].as_str().unwrap().contains("broken.json"));
    assert!(entries[0]["message"].as_str().is_some());
    assert_eq!(diagnostics["sources"]["claude"]["unsupported_count"], 0);
    assert_eq!(
        diagnostics["sources"]["claude"]["unsupported_entries"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    // 模拟摘要扫描完成后，来源文件在详情索引前消失。
    std::fs::remove_file(codex_root.join("valid.jsonl")).unwrap();
    assert!(store.rebuild_summaries().is_ok());
    assert_eq!(store.diagnostics()["sources"]["codex"]["error_count"], 1);
    assert_eq!(
        store
            .search(
                &HashMap::from([("q".into(), "healthy-search-token".into())]),
                &crate::workspace::WorkspaceSnapshot::default()
            )
            .unwrap()["total"],
        1
    );
}

#[test]
fn 索引未完成时会话列表仍可读取() {
    let directory = tempdir().unwrap();
    std::fs::write(
            directory.path().join("s.jsonl"),
            format!(
                "{}\n{}\n{}\n",
                json!({ "type": "session_meta", "payload": { "id": "s1" } }),
                json!({ "type": "event_msg", "payload": { "type": "user_message", "message": "普通提问" } }),
                json!({ "type": "event_msg", "payload": { "type": "agent_message", "message": "needle-token" } })
            ),
        )
        .unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[directory.path().to_path_buf()]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    // 首次扫描分两步：摘要发布后列表立即可读（scanning 结束），
    // 全文索引可以仍在构建。
    store.refresh_metadata().unwrap();
    let workspace = crate::workspace::WorkspaceSnapshot::default();
    let list = store.list(&HashMap::new(), &workspace);
    assert_eq!(list["sessions"].as_array().unwrap().len(), 1);
    assert_eq!(list["scanning"], false);
    // 索引未建成时搜索不阻塞也不报错，只是暂时没有消息命中。
    let query = HashMap::from([("q".into(), "needle-token".into())]);
    assert_eq!(store.search(&query, &workspace).unwrap()["total"], 0);
    for _ in 0..2 {
        let mut progress = Vec::new();
        store
            .rebuild_search_index_with_progress(|done, total| {
                progress.push((done, total));
                Ok(())
            })
            .unwrap();
        assert_eq!(progress, vec![(0, 1), (1, 1)]);
    }
    assert_eq!(store.search(&query, &workspace).unwrap()["total"], 1);
}

#[test]
fn codex会话摘要取最后一次token_count的累计值并扣除缓存() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("rollout.jsonl");
    std::fs::write(
        &path,
        format!(
            "{}\n{}\n{}\n",
            json!({ "type": "session_meta", "payload": { "id": "s1", "cwd": "/work" } }),
            json!({ "timestamp": "2026-09-01T10:00:00Z", "type": "event_msg", "payload": { "type": "token_count", "info": { "total_token_usage": { "input_tokens": 1000, "cached_input_tokens": 400, "output_tokens": 100, "total_tokens": 1100 } } } }),
            json!({ "timestamp": "2026-09-01T10:01:00Z", "type": "event_msg", "payload": { "type": "token_count", "info": { "total_token_usage": { "input_tokens": 3000, "cached_input_tokens": 2400, "output_tokens": 260, "total_tokens": 3260 } } } })
        ),
    )
    .unwrap();
    let source = Source {
        kind: "codex",
        display_name: "Codex",
        root: directory.path().to_path_buf(),
        format: SourceFormat::Codex,
        archived: false,
    };
    let (summary, _) = parse_summary(&path, &source).unwrap();
    // 累计值覆盖而不是累加；input 扣除已含的 cached 后单列。
    assert_eq!(summary["input_tokens"], 600);
    assert_eq!(summary["cached_input_tokens"], 2400);
    assert_eq!(summary["output_tokens"], 260);
}

#[test]
fn claude会话usage按响应id去重累加() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("c.jsonl");
    let assistant = |id: &str, input: u64, cache_read: u64, output: u64| {
        json!({
            "type": "assistant",
            "message": {
                "id": id,
                "role": "assistant",
                "content": [{ "type": "text", "text": "回答" }],
                "usage": {
                    "input_tokens": input,
                    "cache_read_input_tokens": cache_read,
                    "cache_creation_input_tokens": 0,
                    "output_tokens": output
                }
            }
        })
    };
    // 同一响应 id 写三行（流式重复，usage 完全相同），只能计一次。
    std::fs::write(
        &path,
        format!(
            "{}\n{}\n{}\n{}\n{}\n",
            json!({ "type": "user", "message": { "role": "user", "content": "问题" } }),
            assistant("msg_a", 100, 700, 20),
            assistant("msg_a", 100, 700, 20),
            assistant("msg_a", 100, 700, 20),
            assistant("msg_b", 50, 0, 10)
        ),
    )
    .unwrap();
    let source = Source {
        kind: "claude_code",
        display_name: "Claude Code",
        root: directory.path().join("projects"),
        format: SourceFormat::Claude,
        archived: false,
    };
    let (summary, _) = parse_summary(&path, &source).unwrap();
    assert_eq!(summary["input_tokens"], 150);
    assert_eq!(summary["cached_input_tokens"], 700);
    assert_eq!(summary["output_tokens"], 30);
}

#[test]
fn 增量刷新单文件失败不丢弃同批其他变更() {
    let directory = tempdir().unwrap();
    let claude_root = directory.path().join("claude-home");
    let projects = claude_root.join("projects");
    let sessions = claude_root.join("sessions");
    std::fs::create_dir_all(&projects).unwrap();
    std::fs::create_dir_all(&sessions).unwrap();
    let keep = projects.join("keep.jsonl");
    let broken = sessions.join("broken.json");
    let session = |message: &str| {
        format!(
            "{}\n{}\n",
            json!({ "type": "session_meta", "payload": { "id": "keep" } }),
            json!({ "type": "event_msg", "payload": { "type": "user_message", "message": message } })
        )
    };
    std::fs::write(&keep, session("v1")).unwrap();
    std::fs::write(
            &broken,
            json!({ "sessionId": "broken", "prompt": "完整", "cwd": "/x", "startedAt": 1_766_016_000_000_i64 })
                .to_string(),
        )
        .unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: crate::config::SourceRoots {
            claude: Some(vec![claude_root.to_string_lossy().into_owned()]),
            claude_cowork: Some(Vec::new()),
            codex: Some(Vec::new()),
            codex_archived: Some(Vec::new()),
            gemini: Some(Vec::new()),
            grok: Some(Vec::new()),
            pi: Some(Vec::new()),
            omp: Some(Vec::new()),
            kimi: Some(Vec::new()),
            opencode: Some(Vec::new()),
            kilo: Some(Vec::new()),
            zcode: Some(Vec::new()),
            cursor: Some(Vec::new()),
            devin: Some(Vec::new()),
            copilot: Some(Vec::new()),
            hermes: Some(Vec::new()),
            vscode_copilot: Some(Vec::new()),
            deepseek: Some(Vec::new()),
        },
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    assert!(store.records.contains_key("claude_code:broken"));

    // 同一批事件里 keep 正常更新、broken 被写坏（写入到一半触发监听）。
    // Claude 来源回退到全量刷新：单个损坏文件只记录诊断，
    // 不能让同批次其他文件的更新一起丢失。
    std::fs::write(&keep, session("v2")).unwrap();
    std::fs::write(&broken, "{broken").unwrap();
    let changed = store
        .refresh_paths(&BTreeSet::from([keep.clone(), broken.clone()]))
        .unwrap();

    assert!(changed);
    assert!(store.records["claude_code:keep"].search_text.contains("v2"));
    assert!(!store.records.contains_key("claude_code:broken"));
    assert_eq!(store.diagnostics()["sources"]["claude"]["error_count"], 1);

    // 下次事件恢复正常后错误清除、记录恢复。
    std::fs::write(
            &broken,
            json!({ "sessionId": "broken", "prompt": "重写完整", "cwd": "/x", "startedAt": 1_766_016_000_000_i64 })
                .to_string(),
        )
        .unwrap();
    store
        .refresh_paths(&BTreeSet::from([broken.clone()]))
        .unwrap();
    assert!(store.records.contains_key("claude_code:broken"));
    assert_eq!(store.diagnostics()["sources"]["claude"]["error_count"], 0);
}

#[test]
fn 缺失的_opencode_数据库属于不可用而不是扫描错误() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("opencode.db");
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: crate::config::SourceRoots {
            codex: Some(Vec::new()),
            codex_archived: Some(Vec::new()),
            claude: Some(Vec::new()),
            claude_cowork: Some(Vec::new()),
            gemini: Some(Vec::new()),
            grok: Some(Vec::new()),
            pi: Some(Vec::new()),
            omp: Some(Vec::new()),
            kimi: Some(Vec::new()),
            opencode: Some(vec![database.to_string_lossy().into_owned()]),
            kilo: Some(Vec::new()),
            zcode: Some(Vec::new()),
            cursor: Some(Vec::new()),
            devin: Some(Vec::new()),
            copilot: Some(Vec::new()),
            hermes: Some(Vec::new()),
            vscode_copilot: Some(Vec::new()),
            deepseek: Some(Vec::new()),
        },
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };

    store.refresh().unwrap();

    let diagnostic = &store.diagnostics()["sources"]["opencode"];
    assert_eq!(diagnostic["available_roots"], 0);
    assert_eq!(diagnostic["error_count"], 0);
    assert!(diagnostic["last_error"].is_null());
}

#[test]
fn refresh_paths_rebuilds_claude_priority_after_layout_change() {
    let base = tempdir().unwrap();
    let claude_root = base.path().join("claude-home");
    let projects = claude_root.join("projects");
    let sessions = claude_root.join("sessions");
    std::fs::create_dir_all(&projects).unwrap();
    std::fs::create_dir_all(&sessions).unwrap();
    let session_file = projects.join("s1.jsonl");
    std::fs::write(
        &session_file,
        concat!(
            "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello\"},",
            "\"timestamp\":\"2026-08-20T01:00:00.000Z\",\"cwd\":\"/proj\",\"sessionId\":\"s1\"}\n"
        ),
    )
    .unwrap();
    let legacy_file = sessions.join("s1.json");
    std::fs::write(
        &legacy_file,
        json!({
            "sessionId": "s1",
            "prompt": "legacy fallback",
            "cwd": "/legacy",
            "startedAt": 1_766_016_000_000_i64
        })
        .to_string(),
    )
    .unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: crate::config::SourceRoots {
            claude: Some(vec![claude_root.to_string_lossy().into_owned()]),
            claude_cowork: Some(Vec::new()),
            codex: Some(Vec::new()),
            codex_archived: Some(Vec::new()),
            gemini: Some(Vec::new()),
            grok: Some(Vec::new()),
            pi: Some(Vec::new()),
            omp: Some(Vec::new()),
            kimi: Some(Vec::new()),
            opencode: Some(Vec::new()),
            kilo: Some(Vec::new()),
            zcode: Some(Vec::new()),
            cursor: Some(Vec::new()),
            devin: Some(Vec::new()),
            copilot: Some(Vec::new()),
            hermes: Some(Vec::new()),
            vscode_copilot: Some(Vec::new()),
            deepseek: Some(Vec::new()),
        },
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    assert!(store.records.contains_key("claude_code:s1"));
    assert_eq!(store.records["claude_code:s1"].path, session_file);

    // projects 目录被删除后，应重新选择旧版记录，而不是残留幽灵会话或丢失回退记录。
    std::fs::remove_dir_all(&projects).unwrap();
    let changed = store
        .refresh_paths(&BTreeSet::from([session_file.clone()]))
        .unwrap();
    assert!(changed);
    assert_eq!(store.records["claude_code:s1"].path, legacy_file);
}

#[test]
fn watch_roots_fall_back_to_parent_but_never_home() {
    let base = tempdir().unwrap();
    let child = base.path().join("sessions");
    // 目录不存在时回溯到最近的现有父目录
    assert_eq!(existing_watch_root(&child), Some(base.path().into()));
    // 爬到用户主目录或文件系统根仍找不到时就放弃，避免递归监听整个主目录
    let home = dirs::home_dir().unwrap();
    assert_eq!(
        existing_watch_root(&home.join(".never-exists-all-sessions")),
        None
    );

    assert_eq!(
        watch_roots_for(&codex_roots_config(std::slice::from_ref(&child))),
        vec![base.path()]
    );
}

#[test]
fn watch_root_within_stops_at_blocked_boundary() {
    let base = tempdir().unwrap();
    let app = base.path().join("app");
    let blocked = vec![base.path().to_path_buf()];
    // base 在 blocked 中：回溯越过边界则放弃。
    assert_eq!(
        existing_watch_root_within(&app.join("User"), &blocked),
        None
    );
    // 边界内存在目录时正常返回。
    std::fs::create_dir(&app).unwrap();
    assert_eq!(
        existing_watch_root_within(&app.join("User"), &blocked),
        Some(app)
    );
}

#[test]
fn vscode_copilot_占位会话被过滤且_jsonl_取代同名_json() {
    let directory = tempdir().unwrap();
    let user_dir = directory.path();
    let chat = user_dir
        .join("workspaceStorage")
        .join("h1")
        .join("chatSessions");
    std::fs::create_dir_all(&chat).unwrap();
    let flat = chat.join("s-1.json");
    std::fs::write(
            &flat,
            r#"{"version":3,"sessionId":"s-1","creationDate":1760514473246,"customTitle":"平铺标题","requests":[{"requestId":"r1","message":"你好","timestamp":1760514475000,"response":[]}]}"#,
        )
        .unwrap();
    std::fs::write(
        chat.join("empty.json"),
        r#"{"version":3,"sessionId":"empty","creationDate":1760514473246,"requests":[]}"#,
    )
    .unwrap();
    let mut sources_config = codex_roots_config(&[]);
    sources_config.vscode_copilot = Some(vec![user_dir.to_string_lossy().into_owned()]);
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config,
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh_metadata().unwrap();
    // 空会话是占位会话，不进入列表。
    assert_eq!(store.records.len(), 1);
    assert!(store.records.contains_key("vscode_copilot:s-1"));

    // 写入同 id 的 .jsonl 后增量刷新：旧 .json 记录被取代而不是并存。
    let log = chat.join("s-1.jsonl");
    std::fs::write(
            &log,
            r#"{"kind":0,"v":{"version":3,"sessionId":"s-1","creationDate":1760514473246,"customTitle":"日志标题","requests":[{"requestId":"r1","message":"你好","timestamp":1760514475000,"response":[]}]}}"#,
        )
        .unwrap();
    store.refresh_paths(&BTreeSet::from([log.clone()])).unwrap();
    assert_eq!(store.records.len(), 1);
    let record = &store.records["vscode_copilot:s-1"];
    assert_eq!(record.path, log);
    assert_eq!(record.summary["title"], "日志标题");
}

#[test]
fn opencode_数据库及_wal_变化都会匹配来源() {
    let directory = tempdir().unwrap();
    let database = directory.path().join("opencode.db");
    assert!(opencode_event_matches(&database, &database));
    assert!(opencode_event_matches(
        &database,
        &directory.path().join("opencode.db-wal")
    ));
    assert!(!opencode_event_matches(
        &database,
        &directory.path().join("opencode.db-shm")
    ));
    assert!(!opencode_event_matches(
        &database,
        &directory.path().join("other.db-wal")
    ));
}

#[test]
fn local_date_key_converts_to_local_timezone() {
    // 本地日期键必须来自本地时区换算，而不是直接取 UTC 字符串前缀
    for timestamp in [
        "2026-08-20T00:30:00.000Z",
        "2026-08-20T23:30:00+08:00",
        "2026-08-19T18:00:00Z",
    ] {
        let expected = chrono::DateTime::parse_from_rfc3339(timestamp)
            .unwrap()
            .with_timezone(&chrono::Local)
            .format("%Y-%m-%d")
            .to_string();
        assert_eq!(
            local_date_key(timestamp).as_deref(),
            Some(expected.as_str())
        );
    }
    // 无法解析时回退到字符串前 10 位
    assert_eq!(
        local_date_key("2026-08-19 自定义"),
        Some("2026-08-19".into())
    );
    assert_eq!(local_date_key(""), None);
}

#[test]
fn session_ordering_uses_latest_activity_timestamp() {
    let summary = json!({
        "timestamp": "2026-08-20T12:53:50Z",
        "last_timestamp": "2026-08-24T14:51:00Z"
    });
    assert_eq!(timestamp_of(&summary), "2026-08-24T14:51:00Z");

    let legacy = json!({ "timestamp": "2026-08-20T12:53:50Z" });
    assert_eq!(timestamp_of(&legacy), "2026-08-20T12:53:50Z");
}

#[test]
fn 配置根目录优先于环境变量并展开波浪线() {
    let configured = vec!["~/custom-codex".to_string()];
    let (roots, origin) = resolve_kind(
        Some(&configured),
        &["CODEX_SESSIONS_DIR"],
        vec![PathBuf::from("/fallback")],
    );
    assert_eq!(origin, "config");
    assert_eq!(roots, vec![dirs::home_dir().unwrap().join("custom-codex")]);
}

#[test]
fn 继承来源描述不会采用用户配置() {
    let config = crate::config::SourceRoots {
        codex: Some(vec!["/custom-codex".to_string()]),
        ..Default::default()
    };

    assert_eq!(describe_sources(&config)["codex"]["origin"], "config");
    assert_ne!(describe_inherited_sources()["codex"]["origin"], "config");
}

#[test]
fn omp来源声明独立于pi且根目录可配置() {
    let config = crate::config::SourceRoots {
        omp: Some(vec!["~/omp-custom".to_string()]),
        ..Default::default()
    };

    assert_eq!(describe_sources(&config)["omp"]["origin"], "config");

    let omp_sources: Vec<_> = configured_sources(&config)
        .into_iter()
        .filter(|source| source.kind == "omp")
        .collect();
    assert_eq!(omp_sources.len(), 1);
    assert_eq!(omp_sources[0].display_name, "Oh My Pi");
    assert_eq!(
        omp_sources[0].root,
        dirs::home_dir().unwrap().join("omp-custom")
    );
    assert!(matches!(omp_sources[0].format, SourceFormat::Omp));
    // 同配置下 Pi 来源保留默认根，不受 omp 配置影响。
    let pi_sources: Vec<_> = configured_sources(&config)
        .into_iter()
        .filter(|source| source.kind == "pi")
        .collect();
    assert_eq!(pi_sources.len(), 1);
    assert_eq!(
        pi_sources[0].root,
        dirs::home_dir()
            .unwrap()
            .join(".pi")
            .join("agent")
            .join("sessions")
    );
}

#[test]
fn 受保护来源使用规范化后的路径身份匹配() {
    let home = dirs::home_dir().unwrap();
    let inherited = home.join(".codex").join("sessions");
    let configured = vec!["~/.codex/sessions".to_string(), "/custom-codex".to_string()];

    assert_eq!(
        describe_protected_source_roots(&configured, &[inherited]),
        vec!["~/.codex/sessions".to_string()]
    );

    let relative_name = "allsessions-protected-root-that-does-not-exist";
    let relative = vec![format!("./{relative_name}")];
    let absolute = std::env::current_dir().unwrap().join(relative_name);
    assert_eq!(
        describe_protected_source_roots(&relative, &[absolute]),
        relative
    );
}

#[test]
fn 配置空数组会停用对应来源() {
    let (roots, origin) = resolve_kind(
        Some(&Vec::new()),
        &["CODEX_SESSIONS_DIR"],
        vec![PathBuf::from("/fallback")],
    );
    assert_eq!(origin, "config");
    assert!(roots.is_empty());
}
#[test]
fn injected_context_is_detected() {
    assert!(is_synthetic_context("<environment_context>test"));
    assert!(is_synthetic_context("<apps_instructions>test"));
    assert!(is_synthetic_context("<plugins_instructions>test"));
    assert!(!is_synthetic_context("正常用户消息"));
}
#[test]
fn head_tail_keeps_boundaries() {
    let mut values = HeadTail::new(4);
    for value in 0..8 {
        values.push(value);
    }
    let (values, omitted, total) = values.finish(99);
    assert_eq!(values, vec![0, 1, 99, 6, 7]);
    assert_eq!((omitted, total), (4, 8));
}

#[test]
fn codex_summary_and_detail_are_streamed() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let mut file = std::fs::File::create(&path).unwrap();
    for record in [
        json!({ "timestamp": "2026-01-01T00:00:00Z", "type": "session_meta", "payload": { "id": "codex-1", "cwd": "/tmp/project", "model_provider": "custom" } }),
        json!({ "timestamp": "2026-01-01T00:00:01Z", "type": "event_msg", "payload": { "type": "user_message", "message": "修复问题" } }),
        json!({ "timestamp": "2026-01-01T00:00:02Z", "type": "event_msg", "payload": { "type": "agent_message", "message": "已经完成" } }),
    ] {
        writeln!(file, "{}", record).unwrap();
    }
    let source = Source {
        kind: "codex",
        display_name: "Codex",
        root: directory.path().into(),
        format: SourceFormat::Codex,
        archived: false,
    };
    let (summary, search) = parse_summary(&path, &source).unwrap();
    assert_eq!(summary["id"], "codex-1");
    assert_eq!(summary["message_count"], 2);
    assert!(search.contains("已经完成"));
    let detail = parse_detail(&path, &source).unwrap();
    assert_eq!(detail["conversation_messages"].as_array().unwrap().len(), 2);
}

#[test]
fn 永久删除单条消息只移除对应原始记录() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let records = [
        json!({ "timestamp": "2026-01-01T00:00:00Z", "type": "session_meta", "payload": { "id": "codex-1", "cwd": "/tmp/project" } }),
        json!({ "timestamp": "2026-01-01T00:00:01Z", "type": "event_msg", "payload": { "type": "user_message", "message": "删除我" } }),
        json!({ "timestamp": "2026-01-01T00:00:02Z", "type": "event_msg", "payload": { "type": "agent_message", "message": "保留我" } }),
    ];
    std::fs::write(
        &path,
        records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
    let source = Source {
        kind: "codex",
        display_name: "Codex",
        root: directory.path().into(),
        format: SourceFormat::Codex,
        archived: false,
    };
    let detail = parse_detail(&path, &source).unwrap();
    let delete_ref = detail["conversation_messages"][0]["_delete_ref"].clone();
    let retained_message_key = detail["conversation_messages"][1]["_message_key"].clone();

    delete_jsonl_message(&path, &delete_ref).unwrap();

    let updated = std::fs::read_to_string(&path).unwrap();
    assert!(!updated.contains("删除我"));
    assert!(updated.contains("保留我"));
    assert!(updated.contains("session_meta"));
    let reparsed = parse_detail(&path, &source).unwrap();
    assert_eq!(
        reparsed["conversation_messages"][0]["_message_key"],
        retained_message_key
    );
}

#[test]
fn 原始记录变化后拒绝使用旧消息标识删除() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("session.jsonl");
    let source = Source {
        kind: "codex",
        display_name: "Codex",
        root: directory.path().into(),
        format: SourceFormat::Codex,
        archived: false,
    };
    std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-1\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"旧内容\"}}\n"
            ),
        )
        .unwrap();
    let detail = parse_detail(&path, &source).unwrap();
    let delete_ref = detail["conversation_messages"][0]["_delete_ref"].clone();
    std::fs::write(
            &path,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"codex-1\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"新内容\"}}\n"
            ),
        )
        .unwrap();

    assert!(delete_jsonl_message(&path, &delete_ref).is_err());
    assert!(std::fs::read_to_string(&path).unwrap().contains("新内容"));
}

#[test]
fn claude_tool_blocks_keep_tool_semantics() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("claude.jsonl");
    let record = json!({
        "timestamp": "2026-01-01T00:00:00Z", "type": "assistant", "sessionId": "claude-1", "cwd": "/tmp/project",
        "message": { "role": "assistant", "content": [
            { "type": "thinking", "thinking": "内部推理" },
            { "type": "tool_use", "id": "tool-1", "name": "Read", "input": { "path": "a.rs" } }
        ] }
    });
    std::fs::write(&path, format!("{record}\n")).unwrap();
    let source = Source {
        kind: "claude_code",
        display_name: "Claude Code",
        root: directory.path().into(),
        format: SourceFormat::Claude,
        archived: false,
    };
    let detail = parse_detail(&path, &source).unwrap();
    assert_eq!(detail["summary"]["model_provider"], "anthropic");
    assert_eq!(detail["summary"]["tool_count"], 1);
    assert_eq!(detail["conversation_messages"][1]["tool_name"], "Read");
    assert_eq!(
        detail["conversation_messages"][0]["synthetic_context"],
        true
    );
}

#[test]
fn 删除混合记录中的文本时同步移除关联工具结果() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("claude.jsonl");
    let records = [
        json!({
            "timestamp": "2026-01-01T00:00:00Z", "type": "assistant", "sessionId": "claude-1",
            "message": { "role": "assistant", "content": [
                { "type": "text", "text": "删除这段说明" },
                { "type": "tool_use", "id": "tool-1", "name": "Read", "input": { "path": "a.rs" } }
            ] }
        }),
        json!({
            "timestamp": "2026-01-01T00:00:01Z", "type": "user", "sessionId": "claude-1",
            "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "tool-1", "content": "文件内容" }
            ] }
        }),
    ];
    std::fs::write(
        &path,
        records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();
    let source = Source {
        kind: "claude_code",
        display_name: "Claude Code",
        root: directory.path().into(),
        format: SourceFormat::Claude,
        archived: false,
    };
    let detail = parse_detail(&path, &source).unwrap();
    let delete_ref = detail["conversation_messages"][0]["_delete_ref"].clone();

    delete_jsonl_message(&path, &delete_ref).unwrap();

    let updated = std::fs::read_to_string(&path).unwrap();
    assert!(!updated.contains("删除这段说明"));
    assert!(!updated.contains("tool-1"));
    assert!(!updated.contains("文件内容"));
}

#[test]
fn legacy_claude_metadata_reads_history() {
    let directory = tempdir().unwrap();
    let claude_root = directory.path().join(".claude");
    let sessions_root = claude_root.join("sessions");
    std::fs::create_dir_all(&sessions_root).unwrap();
    let path = sessions_root.join("s1.json");
    std::fs::write(
        &path,
        json!({
            "sessionId": "s1",
            "cwd": "/tmp/project",
            "startedAt": 1_767_225_600_000_i64
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
            claude_root.join("history.jsonl"),
            concat!(
                "{\"sessionId\":\"other\",\"display\":\"ignore\"}\n",
                "{\"sessionId\":\"s1\",\"timestamp\":1767225601000,\"display\":\"legacy prompt\",\"project\":\"/tmp/project\"}\n"
            ),
        )
        .unwrap();
    let source = Source {
        kind: "claude_code",
        display_name: "Claude Code",
        root: sessions_root,
        format: SourceFormat::Claude,
        archived: false,
    };

    let detail = parse_detail(&path, &source).unwrap();
    assert_eq!(detail["summary"]["legacy_format"], true);
    assert_eq!(detail["summary"]["timestamp"], "2026-01-01T00:00:00.000Z");
    assert_eq!(detail["summary"]["event_count"], 2);
    assert_eq!(detail["conversation_messages"][0]["text"], "legacy prompt");
    assert_eq!(detail["raw_events"].as_array().unwrap().len(), 2);

    assert_eq!(delete_legacy_session(&path, "s1").unwrap(), 2);
    assert!(!path.exists());
    let history = std::fs::read_to_string(claude_root.join("history.jsonl")).unwrap();
    assert!(history.contains("other"));
    assert!(!history.contains("legacy prompt"));
}

#[test]
fn large_detail_keeps_bounded_head_and_tail() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("large.jsonl");
    let mut file = std::fs::File::create(&path).unwrap();
    writeln!(
        file,
        "{}",
        json!({ "type": "session_meta", "payload": { "id": "large", "model_provider": "custom" } })
    )
    .unwrap();
    for index in 0..(DETAIL_EVENT_LIMIT + 200) {
        writeln!(file, "{}", json!({ "type": "event_msg", "payload": { "type": "user_message", "message": format!("message-{index}") } })).unwrap();
    }
    let source = Source {
        kind: "codex",
        display_name: "Codex",
        root: directory.path().into(),
        format: SourceFormat::Codex,
        archived: false,
    };
    let detail = parse_detail(&path, &source).unwrap();
    assert!(detail["conversation_messages"].as_array().unwrap().len() <= DETAIL_MESSAGE_LIMIT + 1);
    assert!(detail["raw_events"].as_array().unwrap().len() <= DETAIL_EVENT_LIMIT + 1);
    assert_eq!(detail["summary"]["detail_truncated"], true);
}

#[test]
fn search_matches_separated_terms() {
    assert!(search_query_matches(
        "Repair provider history safely",
        "repair safely"
    ));
    assert!(search_query_matches("请分析隐藏的子代理会话", "隐藏 会话"));
    assert!(!search_query_matches(
        "Repair history safely",
        "repair provider"
    ));
}

#[test]
fn error_and_result_records_keep_system_semantics() {
    let mut tools = HashMap::new();
    let codex_error = generic_conversation_message(
        &json!({ "type": "event_msg", "payload": { "type": "error", "message": "failed" } }),
        "",
        &mut tools,
    )
    .unwrap();
    assert_eq!(codex_error["role"], "system");
    assert_eq!(codex_error["is_error"], true);

    let claude_result = generic_conversation_message(
        &json!({ "type": "result", "subtype": "error_during_execution", "error": "boom" }),
        "",
        &mut tools,
    )
    .unwrap();
    assert_eq!(claude_result["role"], "system");
    assert_eq!(claude_result["text"], "boom");
    assert_eq!(claude_result["is_error"], true);
}

#[test]
fn file_change_refreshes_only_the_affected_session() {
    let directory = tempdir().unwrap();
    let first = directory.path().join("first.jsonl");
    let second = directory.path().join("second.jsonl");
    let session = |id: &str, message: &str| {
        format!(
            "{}\n{}\n",
            json!({ "type": "session_meta", "payload": { "id": id, "model_provider": "custom" } }),
            json!({ "type": "event_msg", "payload": { "type": "user_message", "message": message } })
        )
    };
    std::fs::write(&first, session("first", "old first")).unwrap();
    std::fs::write(&second, session("second", "keep second")).unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[directory.path().into()]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    std::fs::write(&second, "not valid json\n").unwrap();
    std::fs::write(&first, session("first", "new first")).unwrap();

    store
        .refresh_paths(&BTreeSet::from([first.clone()]))
        .unwrap();

    assert!(store.records.contains_key("codex:second"));
    assert!(
        store.records["codex:first"]
            .search_text
            .contains("new first")
    );
}

#[test]
fn incremental_refresh_keeps_source_diagnostics_current() {
    let directory = tempdir().unwrap();
    let first = directory.path().join("first.jsonl");
    let second = directory.path().join("second.jsonl");
    let session = |id: &str| {
        format!(
            "{}\n",
            json!({ "type": "session_meta", "payload": { "id": id } })
        )
    };
    std::fs::write(&first, session("first")).unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[directory.path().into()]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    assert_eq!(
        store.diagnostics()["sources"]["codex"]["discovered_files"],
        1
    );

    std::fs::write(&second, session("second")).unwrap();
    store
        .refresh_paths(&BTreeSet::from([second.clone()]))
        .unwrap();
    assert_eq!(
        store.diagnostics()["sources"]["codex"]["discovered_files"],
        2
    );

    std::fs::remove_file(&first).unwrap();
    store
        .refresh_paths(&BTreeSet::from([first.clone()]))
        .unwrap();
    let diagnostics = store.diagnostics();
    assert_eq!(diagnostics["sources"]["codex"]["discovered_files"], 1);
    assert_eq!(diagnostics["sources"]["codex"]["error_count"], 0);

    store
        .refresh_paths(&BTreeSet::from([directory.path().to_path_buf()]))
        .unwrap();
    assert_eq!(
        store.diagnostics()["sources"]["codex"]["discovered_files"],
        1
    );
}

#[test]
fn split_path_list_drops_empty_segments() {
    let joined = std::env::join_paths(["/a/b", "", "/c/d"]).unwrap();
    let paths = split_path_list(joined.as_os_str());
    let expected = vec![PathBuf::from("/a/b"), PathBuf::from("/c/d")];
    assert_eq!(paths, expected);

    let single = std::env::join_paths(["/only/one"]).unwrap();
    assert_eq!(split_path_list(single.as_os_str()).len(), 1);
}

#[test]
fn tilde_segments_expand_to_home() {
    let joined = std::env::join_paths(["~/codex/sessions"]).unwrap();
    let paths = split_path_list(joined.as_os_str());
    let home = dirs::home_dir().unwrap();
    assert_eq!(paths, vec![home.join("codex").join("sessions")]);
}

#[cfg(windows)]
#[test]
fn windows_backslash_tilde_expands_to_home() {
    let joined = std::env::join_paths(["~\\.codex"]).unwrap();
    let paths = split_path_list(joined.as_os_str());
    let home = dirs::home_dir().unwrap();
    assert_eq!(paths, vec![home.join(".codex")]);
}

#[cfg(windows)]
#[test]
fn same_file_with_different_path_case_is_indexed_once() {
    let first = tempdir().unwrap();
    std::fs::write(first.path().join("session.jsonl"), "{}\n").unwrap();
    let alternate = PathBuf::from(first.path().to_string_lossy().to_uppercase());
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[first.path().into(), alternate]),
        index_cache: IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };

    store.refresh().unwrap();

    assert_eq!(store.summaries.len(), 1);
}

#[test]
fn sources_from_paths_builds_one_source_per_root_in_order() {
    let first = tempdir().unwrap();
    let second = tempdir().unwrap();
    let missing = first.path().join("missing");
    let sources = sources_from_paths(
        &[first.path().into(), second.path().into(), missing.clone()],
        &[],
        &[],
        &[],
    );
    // 尚未创建的目录也要保留，等它出现后 refresh 才能重新发现
    assert_eq!(sources.len(), 3);
    assert_eq!(sources[0].root, first.path());
    assert_eq!(sources[1].root, second.path());
    assert_eq!(sources[2].root, missing);
    assert!(sources.iter().all(|source| source.kind == "codex"));
    assert!(sources.iter().all(|source| !source.archived));

    let archived_sources = sources_from_paths(&[], &[second.path().into()], &[], &[]);
    assert_eq!(archived_sources.len(), 1);
    assert_eq!(archived_sources[0].kind, "codex_archived");
    assert!(archived_sources[0].archived);
}

#[test]
fn sources_from_paths_registers_both_claude_layouts_per_root() {
    let with_projects = tempdir().unwrap();
    let projects = with_projects.path().join("projects");
    std::fs::create_dir_all(&projects).unwrap();
    let legacy = tempdir().unwrap();
    let legacy_sessions = legacy.path().join("sessions");
    std::fs::create_dir_all(&legacy_sessions).unwrap();

    let sources = sources_from_paths(
        &[],
        &[],
        &[with_projects.path().into(), legacy.path().into()],
        &[],
    );
    assert_eq!(sources.len(), 4);
    assert_eq!(sources[0].root, projects);
    assert_eq!(sources[1].root, with_projects.path().join("sessions"));
    assert_eq!(sources[2].root, legacy.path().join("projects"));
    assert_eq!(sources[3].root, legacy_sessions);
    assert!(sources.iter().all(|source| {
        source.kind == "claude_code" && matches!(source.format, SourceFormat::Claude)
    }));
}

#[test]
fn claude_modern_and_legacy_sessions_are_scanned_together() {
    let directory = tempdir().unwrap();
    let claude_root = directory.path().join(".claude");
    let projects_root = claude_root.join("projects");
    let sessions_root = claude_root.join("sessions");
    std::fs::create_dir_all(&projects_root).unwrap();
    std::fs::create_dir_all(&sessions_root).unwrap();
    std::fs::write(
            projects_root.join("modern.jsonl"),
            concat!(
                "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"modern\"},",
                "\"timestamp\":\"2026-08-20T01:00:00.000Z\",\"cwd\":\"/modern\",\"sessionId\":\"modern\"}\n"
            ),
        )
        .unwrap();
    std::fs::write(
        sessions_root.join("legacy.json"),
        json!({
            "sessionId": "legacy",
            "prompt": "legacy",
            "cwd": "/legacy",
            "startedAt": 1_766_016_000_000_i64
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(
        sessions_root.join("modern.json"),
        json!({
            "sessionId": "modern",
            "prompt": "legacy duplicate",
            "cwd": "/legacy",
            "startedAt": 1_766_016_000_000_i64
        })
        .to_string(),
    )
    .unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: crate::config::SourceRoots {
            claude: Some(vec![claude_root.to_string_lossy().into_owned()]),
            claude_cowork: Some(Vec::new()),
            codex: Some(Vec::new()),
            codex_archived: Some(Vec::new()),
            gemini: Some(Vec::new()),
            grok: Some(Vec::new()),
            pi: Some(Vec::new()),
            omp: Some(Vec::new()),
            kimi: Some(Vec::new()),
            opencode: Some(Vec::new()),
            kilo: Some(Vec::new()),
            zcode: Some(Vec::new()),
            cursor: Some(Vec::new()),
            devin: Some(Vec::new()),
            copilot: Some(Vec::new()),
            hermes: Some(Vec::new()),
            vscode_copilot: Some(Vec::new()),
            deepseek: Some(Vec::new()),
        },
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };

    store.refresh().unwrap();

    assert!(store.records.contains_key("claude_code:modern"));
    assert!(store.records.contains_key("claude_code:legacy"));
    assert_eq!(store.records.len(), 2);
    assert_eq!(
        store.records["claude_code:modern"].path,
        projects_root.join("modern.jsonl")
    );
}

#[test]
fn duplicate_session_id_across_roots_keeps_first_root() {
    let first = tempdir().unwrap();
    let second = tempdir().unwrap();
    let session = |message: &str| {
        format!(
            "{}\n{}\n",
            json!({ "type": "session_meta", "payload": { "id": "dup", "model_provider": "custom" } }),
            json!({ "type": "event_msg", "payload": { "type": "user_message", "message": message } })
        )
    };
    std::fs::write(first.path().join("a.jsonl"), session("first root only")).unwrap();
    std::fs::write(second.path().join("b.jsonl"), session("second root copy")).unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[first.path().into(), second.path().into()]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    assert_eq!(store.records.len(), 1);
    let record = &store.records["codex:dup"];
    assert_eq!(record.source.root, first.path());
    assert!(record.search_text.contains("first root only"));
    assert!(!record.search_text.contains("second root copy"));
}

#[test]
fn 新版kimi读取回退历史并刷新元数据及去重迁移副本() {
    let directory = tempdir().unwrap();
    let modern = directory.path().join("new");
    let legacy = directory.path().join("old");
    let session = modern.join("sessions/wd_demo/ses_old-1");
    let agent = session.join("agents/main");
    std::fs::create_dir_all(&agent).unwrap();
    let old_session = legacy.join("sessions/hash/old-1");
    std::fs::create_dir_all(&old_session).unwrap();
    std::fs::write(old_session.join("wire.jsonl"),
        json!({"timestamp": 1787184000, "message": {"type": "TurnBegin", "payload": {"user_input": "旧副本"}}}).to_string()).unwrap();
    let state_path = session.join("state.json");
    let mut metadata = json!({"title": "新版会话", "custom": {"imported_from_kimi_cli": true, "kimi_cli_session_id": "old-1"}});
    std::fs::write(&state_path, metadata.to_string()).unwrap();
    let index_path = modern.join("session_index.jsonl");
    std::fs::write(
        &index_path,
        json!({"sessionId":"ses_old-1","workDir":"/work/kimi"}).to_string(),
    )
    .unwrap();
    let records = vec![
        json!({"type":"metadata","protocol_version":"1.5","created_at":1787184000000_i64}),
        json!({"type":"llm.request","provider":"moonshot","model":"kimi-test"}),
        json!({"type":"context.append_message","message":{"role":"user","id":"u1","content":[{"type":"text","text":"检查项目"}],"toolCalls":[]}}),
        json!({"type":"context.append_loop_event","event":{"type":"step.begin","uuid":"step1"}}),
        json!({"type":"context.append_loop_event","event":{"type":"content.part","stepUuid":"step1","part":{"type":"think","think":"先检查"}}}),
        json!({"type":"context.append_loop_event","event":{"type":"content.part","stepUuid":"step1","part":{"type":"text","text":"正在"}}}),
        json!({"type":"context.append_loop_event","event":{"type":"content.part","stepUuid":"step1","part":{"type":"text","text":"检查"}}}),
        json!({"type":"context.append_loop_event","event":{"type":"tool.call","stepUuid":"step1","toolCallId":"c1","name":"Bash","args":{"command":"pwd"}}}),
        json!({"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"c1","result":{"output":"命令失败","isError":true}}}),
        json!({"type":"context.append_loop_event","event":{"type":"step.end","uuid":"step1","finishReason":"stop"}}),
        json!({"type":"context.append_message","message":{"role":"assistant","content":[{"type":"text","text":"第一条完整回复"}],"toolCalls":[]}}),
        json!({"type":"context.append_message","message":{"role":"assistant","content":[{"type":"text","text":"第二条完整回复"}],"toolCalls":[]}}),
        json!({"type":"context.append_message","message":{"role":"user","origin":{"kind":"injection","ownerPromptId":"u2"},"content":[{"type":"text","text":"撤回附带上下文"}],"toolCalls":[]}}),
        json!({"type":"context.append_message","message":{"role":"user","id":"u2","content":[{"type":"text","text":"撤回的问题"}],"toolCalls":[]}}),
        json!({"type":"context.append_message","message":{"role":"assistant","content":[{"type":"text","text":"撤回的回答"}],"toolCalls":[]}}),
        json!({"type":"context.undo","count":1}),
        json!({"type":"context.apply_compaction","summary":"历史摘要","compactedCount":4,"keptUserMessageCount":1}),
        json!({"type":"context.clear"}),
        json!({"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"清空后撤回"}],"toolCalls":[]}}),
        json!({"type":"context.undo","count":1}),
        json!({"type":"context.append_message","message":{"role":"user","content":[{"type":"text","text":"继续工作"},{"type":"image_url","imageUrl":{"url":"blob:fixture"}}],"toolCalls":[]}}),
    ];
    let wire = records
        .into_iter()
        .enumerate()
        .map(|(i, mut record)| {
            record["time"] = json!(1787184000000_i64 + i as i64 * 1000);
            record.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    let path = agent.join("wire.jsonl");
    std::fs::write(&path, &wire).unwrap();
    let child = session.join("agents/agent-0");
    std::fs::create_dir_all(&child).unwrap();
    std::fs::write(child.join("wire.jsonl"), &wire).unwrap();
    let mut config = codex_roots_config(&[]);
    config.kimi = Some(vec![
        modern.to_string_lossy().into_owned(),
        legacy.to_string_lossy().into_owned(),
    ]);
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: config,
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    assert_eq!(store.records.len(), 2);
    let record = &store.records["kimi:old-1"];
    assert_eq!(record.path, path);
    assert_eq!(record.summary["id"], "ses_old-1");
    assert_eq!(record.summary["cwd"], "/work/kimi");
    assert_eq!(record.summary["title"], "新版会话");
    assert_eq!(record.summary["model_provider"], "moonshot");
    assert!(record.search_text.contains("正在检查"));
    assert!(!record.search_text.contains("撤回"));
    assert_eq!(
        store.records["kimi:ses_old-1:subagent:agent-0"].summary["hidden"],
        true
    );
    let mut exported = Vec::new();
    let detail = super::kimi::visit_detail(&path, &record.source, &mut |message| {
        exported.push(message.clone())
    })
    .unwrap();
    let messages = detail["conversation_messages"].as_array().unwrap();
    assert_eq!(&exported, messages);
    assert!(
        messages
            .iter()
            .any(|message| message["text"] == "第一条完整回复")
    );
    assert!(
        messages
            .iter()
            .any(|message| message["text"] == "第二条完整回复")
    );
    assert!(messages.iter().any(|message| message["text"] == "检查项目"));
    assert!(
        messages
            .iter()
            .any(|message| message["text"] == "历史摘要" && message["synthetic_context"] == true)
    );
    assert!(
        messages.last().unwrap()["text"]
            .as_str()
            .unwrap()
            .contains("[image]")
    );
    let result = messages
        .iter()
        .find(|message| message["tool_kind"] == "tool_result")
        .unwrap();
    assert_eq!(result["tool_name"], "Bash");
    assert_eq!(result["is_error"], true);
    assert!(
        messages
            .iter()
            .all(|message| message["_delete_ref"].is_null())
    );
    assert!(
        detail["raw_events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|event| event["type"] == "context.undo")
    );
    metadata["title"] = json!("改名后");
    std::fs::write(&state_path, metadata.to_string()).unwrap();
    std::fs::write(
        &index_path,
        json!({"sessionId":"ses_old-1","workDir":"/work/moved"}).to_string(),
    )
    .unwrap();
    store
        .refresh_paths(&BTreeSet::from([state_path, index_path]))
        .unwrap();
    let refreshed = store.summary_for_key("kimi:old-1").unwrap();
    assert_eq!(refreshed["title"], "改名后");
    assert_eq!(refreshed["cwd"], "/work/moved");
    assert_eq!(std::fs::read_to_string(path).unwrap(), wire);
}

#[test]
fn grok展示回放接入搜索刷新并保持只读() {
    let directory = tempdir().unwrap();
    let session = directory.path().join("sessions/encoded-project/grok-main");
    std::fs::create_dir_all(&session).unwrap();
    let meta_path = session.join("summary.json");
    let mut metadata = json!({"info":{"id":"grok-main","cwd":"/work/grok"},"generated_title":"Grok 项目检查","created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:01:00Z","current_model_id":"grok-code","session_kind":"fork","parent_session_id":"parent"});
    std::fs::write(&meta_path, metadata.to_string()).unwrap();
    let acp = |update: Value| json!({"timestamp":1790812800,"method":"session/update","params":{"sessionId":"grok-main","update":update}});
    let xai = |update: Value| json!({"timestamp":1790812800,"method":"_x.ai/session/update","params":{"sessionId":"grok-main","update":update}});
    let chunk =
        |tag: &str, text: &str| json!({"sessionUpdate":tag,"content":{"type":"text","text":text}});
    let records = vec![
        acp(
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"检查"},"_meta":{"promptIndex":0}}),
        ),
        acp(
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"项目"},"_meta":{"promptIndex":0}}),
        ),
        acp(chunk("agent_thought_chunk", "先查看目录")),
        acp(chunk("agent_message_chunk", "正在")),
        acp(chunk("agent_message_chunk", "检查")),
        acp(
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"后台上下文"},"_meta":{"hostTurn":true}}),
        ),
        acp(
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"撤回的问题"},"_meta":{"promptIndex":1}}),
        ),
        acp(chunk("agent_message_chunk", "撤回的回复")),
        xai(
            json!({"sessionUpdate":"rewind_marker","target_prompt_index":1,"created_at":"2026-10-01T00:00:00Z"}),
        ),
        acp(
            json!({"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"执行命令"},"_meta":{"promptIndex":1}}),
        ),
        acp(
            json!({"sessionUpdate":"tool_call","toolCallId":"call-1","title":"Bash","status":"pending","rawInput":{"command":"pwd"}}),
        ),
        acp(
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"in_progress","rawOutput":"中间输出"}),
        ),
        acp(
            json!({"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"failed","rawOutput":"权限不足"}),
        ),
        acp(chunk("agent_message_chunk", "命令失败")),
        xai(json!({"sessionUpdate":"turn_completed","prompt_id":"p1","stop_reason":"end_turn"})),
        acp(chunk("agent_message_chunk", "新的回复")),
        acp(
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"image","data":"unused","mimeType":"image/png"}}),
        ),
        xai(
            json!({"sessionUpdate":"compaction_checkpoint","checkpoint_id":"c1","prompt_index_at_compaction":2}),
        ),
    ];
    let wire = records
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    let path = session.join("updates.jsonl");
    std::fs::write(&path, &wire).unwrap();
    // 模型上下文不作为第二份会话，子代理仍在正常会话目录内。
    std::fs::write(session.join("chat_history.jsonl"), "不应读取").unwrap();
    let child = session.parent().unwrap().join("grok-child");
    std::fs::create_dir_all(&child).unwrap();
    std::fs::write(child.join("summary.json"), json!({"info":{"id":"grok-child","cwd":"/work/grok"},"session_kind":"subagent","parent_session_id":"grok-main"}).to_string()).unwrap();
    std::fs::write(
        child.join("updates.jsonl"),
        json!({"sessionId":"grok-child","update":chunk("user_message_chunk","子任务")}).to_string(),
    )
    .unwrap();
    let mut config = codex_roots_config(&[]);
    config.grok = Some(vec![directory.path().to_string_lossy().into_owned()]);
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: config,
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    assert_eq!(store.records.len(), 2);
    assert_eq!(store.records["grok:grok-main"].summary["hidden"], false);
    assert_eq!(store.records["grok:grok-child"].summary["hidden"], true);
    assert_eq!(store.records["grok:grok-main"].summary["cwd"], "/work/grok");
    assert_eq!(
        store.records["grok:grok-main"].summary["model_provider"],
        "unknown"
    );
    let detail = store.detail("grok:grok-main").unwrap();
    let messages = detail["conversation_messages"].as_array().unwrap();
    assert!(messages.iter().any(|m| m["text"] == "检查项目"));
    assert!(messages.iter().any(|m| m["text"] == "正在检查"));
    assert!(messages.iter().any(|m| m["source_subtype"] == "thinking"));
    assert!(
        messages
            .iter()
            .any(|m| m["text"] == "后台上下文" && m["synthetic_context"] == true)
    );
    assert!(messages.iter().any(|m| m["text"] == "新的回复[image]"));
    assert!(
        !messages
            .iter()
            .any(|m| m["text"].as_str().unwrap_or_default().contains("撤回"))
    );
    let tools = messages
        .iter()
        .filter(|m| m["tool_call_id"] == "call-1")
        .collect::<Vec<_>>();
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[1]["text"], "权限不足");
    assert_eq!(tools[1]["tool_name"], "Bash");
    assert_eq!(tools[1]["is_error"], true);
    assert!(
        messages
            .iter()
            .all(|m| m["_message_key"].is_string() && m["_delete_ref"].is_null())
    );
    assert!(
        detail["raw_events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["type"] == "rewind_marker")
    );
    let workspace = crate::workspace::WorkspaceSnapshot::default();
    let hits = store
        .search(
            &HashMap::from([("q".into(), "正在检查".into())]),
            &workspace,
        )
        .unwrap();
    assert_eq!(hits["sessions"].as_array().unwrap().len(), 1);
    let removed = store
        .search(&HashMap::from([("q".into(), "撤回".into())]), &workspace)
        .unwrap();
    assert!(removed["sessions"].as_array().unwrap().is_empty());
    assert!(store.delete_session("grok:grok-main").is_err());
    metadata["generated_title"] = json!("改名后的 Grok");
    metadata["info"]["cwd"] = json!("/work/moved");
    std::fs::write(&meta_path, metadata.to_string()).unwrap();
    store.refresh_paths(&BTreeSet::from([meta_path])).unwrap();
    let refreshed = store.detail("grok:grok-main").unwrap();
    assert_eq!(refreshed["summary"]["title"], "改名后的 Grok");
    assert_eq!(refreshed["summary"]["cwd"], "/work/moved");
    assert_eq!(std::fs::read_to_string(&path).unwrap(), wire);
}

#[test]
fn nested_roots_index_shared_file_once() {
    let outer = tempdir().unwrap();
    let nested = outer.path().join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let shared = nested.join("shared.jsonl");
    std::fs::write(
            &shared,
            concat!(
                "{\"type\":\"session_meta\",\"payload\":{\"id\":\"shared\",\"model_provider\":\"custom\"}}\n",
                "{\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"hello\"}}\n"
            ),
        )
        .unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[outer.path().into(), nested]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    assert_eq!(store.records.len(), 1);
    assert_eq!(store.records["codex:shared"].source.root, outer.path());
}

#[test]
fn facets_sources_dedupe_kinds_but_keep_all_roots() {
    let first = tempdir().unwrap();
    let second = tempdir().unwrap();
    let session = |id: &str| {
        format!(
            "{}\n",
            json!({ "type": "session_meta", "payload": { "id": id, "model_provider": "custom" } })
        )
    };
    std::fs::write(first.path().join("a.jsonl"), session("a")).unwrap();
    std::fs::write(second.path().join("b.jsonl"), session("b")).unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[first.path().into(), second.path().into()]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    let facets = store.facets(
        &HashMap::new(),
        &crate::workspace::WorkspaceSnapshot::default(),
    );
    let sources = facets["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["kind"], "codex");
    assert_eq!(facets["session_roots"].as_array().unwrap().len(), 2);
}

#[test]
fn 项目计数随显示开关变化() {
    let store = SessionStore {
        summaries: vec![
            json!({ "source_kind": "codex", "cwd": "/work/a", "last_timestamp": "2026-10-01T00:00:00Z" }),
            json!({ "source_kind": "codex", "cwd": "/work/a", "hidden": true, "hidden_reason": "subagent", "last_timestamp": "2026-10-02T00:00:00Z" }),
            json!({ "source_kind": "codex_archived", "cwd": "/work/a", "archived": true, "last_timestamp": "2026-10-03T00:00:00Z" }),
            json!({ "source_kind": "claude_code", "cwd": "/work/b", "last_timestamp": "2026-10-04T00:00:00Z" }),
        ],
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    let workspace = crate::workspace::WorkspaceSnapshot::default();

    let visible = store.facets(&HashMap::new(), &workspace);
    // 来源栏与项目计数同口径：默认不含隐藏、归档会话；
    // claude_code 归一为诊断使用的 claude 键。
    assert_eq!(visible["source_counts"]["codex"], 1);
    assert_eq!(visible["source_counts"]["claude"], 1);
    assert!(visible["source_counts"].get("codex_archived").is_none());
    let alpha = visible["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|project| project["path"] == "/work/a")
        .unwrap();
    assert_eq!(alpha["count"], 1);
    assert_eq!(alpha["source_counts"]["codex"], 1);
    assert_eq!(
        alpha["source_last_timestamps"]["codex"],
        "2026-10-01T00:00:00Z"
    );

    let all = store.facets(
        &HashMap::from([
            ("show_hidden".to_string(), "true".to_string()),
            ("show_codex_archived".to_string(), "true".to_string()),
        ]),
        &workspace,
    );
    assert_eq!(all["source_counts"]["codex"], 2);
    assert_eq!(all["source_counts"]["codex_archived"], 1);
    let alpha = all["projects"]
        .as_array()
        .unwrap()
        .iter()
        .find(|project| project["path"] == "/work/a")
        .unwrap();
    assert_eq!(alpha["count"], 3);
    assert_eq!(alpha["source_counts"]["codex"], 2);
    assert_eq!(alpha["source_counts"]["codex_archived"], 1);
    assert_eq!(
        alpha["source_last_timestamps"]["codex"],
        "2026-10-02T00:00:00Z"
    );
}

#[test]
fn refresh_paths_attributes_shared_file_to_first_declared_root() {
    let outer = tempdir().unwrap();
    let nested = outer.path().join("nested");
    std::fs::create_dir_all(&nested).unwrap();
    let shared = nested.join("shared.jsonl");
    let session = |message: &str| {
        format!(
            "{}\n{}\n",
            json!({ "type": "session_meta", "payload": { "id": "shared", "model_provider": "custom" } }),
            json!({ "type": "event_msg", "payload": { "type": "user_message", "message": message } })
        )
    };
    std::fs::write(&shared, session("before")).unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[outer.path().into(), nested.clone()]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    std::fs::write(&shared, session("after")).unwrap();
    store
        .refresh_paths(&BTreeSet::from([shared.clone()]))
        .unwrap();
    assert_eq!(store.records.len(), 1);
    let record = &store.records["codex:shared"];
    assert_eq!(record.source.root, outer.path());
    assert!(record.search_text.contains("after"));
}

#[test]
fn 热启动直接装载上次扫描留下的会话列表() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("warm.jsonl");
    std::fs::write(
        &path,
        json!({"type":"session_meta","payload":{"id":"warm","cwd":"/p"},"timestamp":"2026-01-01T00:00:00Z"}).to_string(),
    )
    .unwrap();
    let cache_directory = tempdir().unwrap();
    let cache_path = cache_directory.path().join("cache.sqlite");
    let build_store = || SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[directory.path().to_path_buf()]),
        index_cache: crate::cache::IndexCache::open_at(&cache_path),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    let mut store = build_store();
    store.refresh().unwrap();
    assert_eq!(store.summaries.len(), 1);

    // 模拟重启：同缓存库上的全新 store，热启动应立即有列表，
    // 且 scanning() 仍为 true（首次全量扫描尚未完成）。
    let mut warmed = build_store();
    warmed.warm_from_cache();
    assert_eq!(warmed.summaries.len(), 1);
    assert!(warmed.scanning());
    assert_eq!(warmed.summaries[0]["_key"], json!("codex:warm"));
    // 热记录携带来源与路径，详情可按需读取。
    assert!(warmed.detail("codex:warm").is_ok());

    // 上次运行后删除的文件不进热列表。
    std::fs::remove_file(&path).unwrap();
    let mut after_delete = build_store();
    after_delete.warm_from_cache();
    assert!(after_delete.summaries.is_empty());
}

#[test]
fn 热启动按当前根目录过滤缓存并保留来源归属() {
    let first = tempdir().unwrap();
    let second = tempdir().unwrap();
    let empty = tempdir().unwrap();
    let cache_directory = tempdir().unwrap();
    let cache_path = cache_directory.path().join("cache.sqlite");
    for (root, id) in [(first.path(), "first"), (second.path(), "second")] {
        std::fs::write(
            root.join("warm.jsonl"),
            json!({"type":"session_meta","payload":{"id":id,"cwd":"/p"},"timestamp":"2026-01-01T00:00:00Z"}).to_string(),
        )
        .unwrap();
    }
    let build_store = |roots: &[PathBuf]| SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(roots),
        index_cache: crate::cache::IndexCache::open_at(&cache_path),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    let roots = [first.path().to_path_buf(), second.path().to_path_buf()];
    let mut initial = build_store(&roots);
    initial.refresh_metadata().unwrap();

    let mut warmed = build_store(&roots);
    warmed.warm_from_cache();
    assert_eq!(warmed.records.len(), 2);
    assert_eq!(warmed.records["codex:first"].source.root, first.path());
    assert_eq!(warmed.records["codex:second"].source.root, second.path());

    let mut changed = build_store(&[second.path().to_path_buf()]);
    changed.warm_from_cache();
    assert_eq!(changed.records.len(), 1);
    assert!(changed.records.contains_key("codex:second"));

    let mut replaced = build_store(&[empty.path().to_path_buf()]);
    replaced.warm_from_cache();
    assert!(replaced.records.is_empty());

    #[cfg(unix)]
    {
        let alias = empty.path().join("alias");
        std::os::unix::fs::symlink(second.path(), &alias).unwrap();
        let mut aliased = build_store(std::slice::from_ref(&alias));
        aliased.warm_from_cache();
        assert_eq!(aliased.records.len(), 1);
        assert_eq!(aliased.records["codex:second"].source.root, alias);
    }
}

#[test]
fn 媒体内容块使用占位而不是原始_json() {
    let claude = json!({"type":"user","message":{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAA"}}]}});
    let messages = super::parse::conversation_messages(&claude, "", &mut HashMap::new());
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["role"], "user");
    assert_eq!(messages[0]["text"], "[image]");

    let codex = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,AAA"}]}});
    let messages = super::parse::conversation_messages(&codex, "", &mut HashMap::new());
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0]["text"], "[image]");

    assert_eq!(
        super::parse::extract_text(&json!({"inlineData":{"mimeType":"image/png","data":"AAA"}}))
            .as_deref(),
        Some("[image]")
    );
    assert_eq!(
        super::parse::extract_text(&json!({"fileData":{"fileUri":"file:///a.pdf"}})).as_deref(),
        Some("[file] file:///a.pdf")
    );
}

#[test]
fn 图片附件只保留定位信息并按需读取() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("image.jsonl");
    let png = "QUJD";
    let content = [
        json!({"type":"session_meta","payload":{"id":"image-session"}}).to_string(),
        json!({"type":"user","message":{"role":"user","content":[
            {"type":"text","text":"看这张图"},
            {"type":"image","source":{"type":"base64","media_type":"image/png","data":png}}
        ]}})
        .to_string(),
    ]
    .join("\n");
    std::fs::write(&path, content).unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[directory.path().to_path_buf()]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    let detail = store.detail("codex:image-session").unwrap();
    let messages = detail["conversation_messages"].as_array().unwrap();
    assert_eq!(messages[0]["text"], "看这张图");
    let image = messages
        .iter()
        .find(|message| message["text"] == "[image]")
        .unwrap();
    let attachment = &image["attachments"][0];
    assert_eq!(attachment["kind"], "image");
    let locator = &attachment["locator"];
    assert_eq!(locator["line_number"], 2);
    assert_eq!(locator["path"], json!(["message", "content", 1]));

    let result = store
        .read_attachment("codex:image-session", locator)
        .unwrap();
    assert_eq!(result["media_type"], "image/png");
    assert_eq!(result["data_url"], format!("data:image/png;base64,{png}"));
    assert_eq!(result["bytes"], 3);

    // 搜索索引只含占位，不包含 base64。
    let search = super::search_text_from_detail(&detail);
    assert!(search.contains("[image]"));
    assert!(!search.contains(png));

    // 原文变化后拒绝旧定位。
    let mut stale = locator.clone();
    stale["record_fingerprint"] = json!("stale");
    assert!(
        store
            .read_attachment("codex:image-session", &stale)
            .unwrap_err()
            .message
            .contains("变化")
    );

    // 体积上限在解码前按 base64 长度计算。
    let record = store.records.get("codex:image-session").unwrap();
    assert!(
        super::attachment::read_image_with_limit(record, locator, 2)
            .unwrap_err()
            .contains("上限")
    );
}

#[test]
fn 新版kimi图片按真实记录定位并回读() {
    let directory = tempdir().unwrap();
    let agent = directory
        .path()
        .join("sessions/work/image-session/agents/main");
    std::fs::create_dir_all(&agent).unwrap();
    let data_url = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
    let image = json!({"type":"image_url","imageUrl":{"url":data_url}});
    let records = [
        json!({"type":"metadata","protocol_version":"1.5"}),
        json!({"type":"context.append_message","message":{"role":"user","content":[image.clone()]}}),
        json!({"type":"context.append_message","message":{"role":"assistant","content":[image.clone()]}}),
        json!({"type":"context.append_message","message":{"role":"tool","content":[image.clone()],"toolCallId":"old-call"}}),
        json!({"type":"context.append_loop_event","event":{"type":"step.begin","uuid":"step1"}}),
        json!({"type":"context.append_loop_event","event":{"type":"content.part","stepUuid":"step1","part":image.clone()}}),
        json!({"type":"context.append_loop_event","event":{"type":"tool.call","stepUuid":"step1","toolCallId":"c1","name":"Image","args":{}}}),
        json!({"type":"context.append_loop_event","event":{"type":"tool.result","toolCallId":"c1","result":{"output":[image]}}}),
        json!({"type":"context.append_loop_event","event":{"type":"step.end","uuid":"step1","finishReason":"stop"}}),
    ];
    let path = agent.join("wire.jsonl");
    std::fs::write(
        &path,
        records
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    let mut config = codex_roots_config(&[]);
    config.kimi = Some(vec![directory.path().to_string_lossy().into_owned()]);
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: config,
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    let key = "kimi:image-session";
    let detail = store.detail(key).unwrap();
    let locators = detail["conversation_messages"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|message| message["attachments"].as_array().into_iter().flatten())
        .map(|attachment| &attachment["locator"])
        .collect::<Vec<_>>();
    let expected = [
        (2, json!(["message", "content", 0])),
        (3, json!(["message", "content", 0])),
        (4, json!(["message", "content", 0])),
        (6, json!(["event", "part"])),
        (8, json!(["event", "result", "output", 0])),
    ];
    assert_eq!(locators.len(), expected.len());
    for (locator, (line, content_path)) in locators.iter().zip(expected) {
        assert_eq!(locator["line_number"], line);
        assert_eq!(locator["path"], content_path);
        assert_eq!(
            locator["record_fingerprint"],
            super::json_fingerprint(&records[line as usize - 1])
        );
        let result = store.read_attachment(key, locator).unwrap();
        assert_eq!(result["data_url"], data_url);
        let mut stale = (*locator).clone();
        stale["record_fingerprint"] = json!("stale");
        assert!(
            store
                .read_attachment(key, &stale)
                .unwrap_err()
                .message
                .contains("变化")
        );
    }
}

#[test]
fn 图片附件拒绝_svg_与远程地址() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("unsafe.jsonl");
    let content = [
        json!({"type":"session_meta","payload":{"id":"unsafe-image"}}).to_string(),
        json!({"type":"user","message":{"role":"user","content":[
            {"type":"image","source":{"type":"base64","media_type":"image/svg+xml","data":"QUJD"}}
        ]}})
        .to_string(),
        json!({"type":"user","message":{"role":"user","content":[
            {"type":"input_image","image_url":"https://example.com/a.png"}
        ]}})
        .to_string(),
    ]
    .join("\n");
    std::fs::write(&path, content).unwrap();
    let mut store = SessionStore {
        summaries: Vec::new(),
        records: HashMap::new(),
        sources: Vec::new(),
        sources_config: codex_roots_config(&[directory.path().to_path_buf()]),
        index_cache: crate::cache::IndexCache::disabled(),
        detail_cache: DetailCache::new(DETAIL_CACHE_BYTES),
        scan_diagnostics: ScanDiagnostics::default(),
    };
    store.refresh().unwrap();
    let detail = store.detail("codex:unsafe-image").unwrap();
    let messages = detail["conversation_messages"].as_array().unwrap();
    let svg = messages
        .iter()
        .find(|message| message["attachments"][0]["locator"]["line_number"] == 2)
        .unwrap();
    assert!(
        store
            .read_attachment("codex:unsafe-image", &svg["attachments"][0]["locator"])
            .unwrap_err()
            .message
            .contains("SVG")
    );
    let remote = messages
        .iter()
        .find(|message| message["attachments"][0]["locator"]["line_number"] == 3)
        .unwrap();
    assert!(
        store
            .read_attachment("codex:unsafe-image", &remote["attachments"][0]["locator"])
            .unwrap_err()
            .message
            .contains("内嵌")
    );
}

#[test]
fn 旧版_claude_详情截断但索引保留完整消息() {
    let directory = tempdir().unwrap();
    let path = directory.path().join("legacy.json");
    let entries = (0..810)
        .map(|index| {
            json!({
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": format!("消息 {index}")}]
                }
            })
        })
        .collect::<Vec<_>>();
    let value = json!({"sessionId": "legacy-1", "entries": entries});
    std::fs::write(&path, value.to_string()).unwrap();
    let source = Source {
        kind: "claude_code",
        display_name: "Claude Code",
        root: directory.path().into(),
        format: SourceFormat::Claude,
        archived: false,
    };

    let detail = super::claude_legacy::parse_legacy_claude_detail(&path, &source, value).unwrap();
    let messages = detail["conversation_messages"].as_array().unwrap();
    assert!(messages.len() <= DETAIL_MESSAGE_LIMIT + 1);
    assert!(
        detail["truncation"]["messages"]["omitted"]
            .as_u64()
            .unwrap()
            > 0
    );
    assert!(
        messages
            .iter()
            .any(|message| message["is_truncation_marker"] == true)
    );

    let (_, search) = super::claude_legacy::parse_legacy_claude_summary(&path, &source).unwrap();
    assert!(search.contains("消息 400"));
}

#[test]
fn 系统与开发者角色统一按上下文处理() {
    for role in ["system", "developer"] {
        let message = super::message_value(role, "指令", "", "test", "text", false);
        assert_eq!(message["synthetic_context"], true, "{role}");
    }
    let user = super::message_value("user", "普通消息", "", "test", "text", false);
    assert_eq!(user["synthetic_context"], false);
    let assistant = super::message_value("assistant", "回答", "", "test", "text", false);
    assert_eq!(assistant["synthetic_context"], false);
}
