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

use serde_json::{json, Value};
use tempfile::tempdir;

#[cfg(windows)]
use crate::cache::IndexCache;

use super::{
    compact, delete_jsonl_message, delete_legacy_session, describe_inherited_sources,
    describe_protected_source_roots, describe_sources, existing_watch_root,
    existing_watch_root_within, generic_conversation_message, is_synthetic_context, local_date_key,
    matches_filters, opencode_event_matches, parse_detail, parse_summary, resolve_kind,
    search_query_matches, sources_from_paths, split_path_list, timestamp_of, watch_roots_for,
    DetailCache, HeadTail, ScanDiagnostics, SessionStore, Source, SourceFormat, DETAIL_CACHE_BYTES,
    DETAIL_EVENT_LIMIT, DETAIL_MESSAGE_LIMIT,
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
        gemini: Some(Vec::new()),
        pi: Some(Vec::new()),
        kimi: Some(Vec::new()),
        opencode: Some(Vec::new()),
        kilo: Some(Vec::new()),
        zcode: Some(Vec::new()),
        cursor: Some(Vec::new()),
        devin: Some(Vec::new()),
        copilot: Some(Vec::new()),
        hermes: Some(Vec::new()),
        vscode_copilot: Some(Vec::new()),
    }
}

#[test]
fn summary_text_has_limit() {
    assert_eq!(compact("abcdefgh", 6), "abc...");
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
    assert!(context["conversation_messages"]
        .as_array()
        .unwrap()
        .iter()
        .any(|m| m["text"].as_str().unwrap().contains("HTTP_404")));
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
fn 统计按_agent_归并归档和兼容来源() {
    let store = SessionStore {
        summaries: vec![
            json!({ "source_kind": "codex", "archived": false, "message_count": 8, "tool_count": 3 }),
            json!({ "source_kind": "codex_archived", "archived": true, "message_count": 5, "tool_count": 2 }),
            json!({ "source_kind": "claude_code", "archived": false, "message_count": 4, "tool_count": 1 }),
            json!({ "source_kind": "opencode", "archived": false, "message_count": 7, "tool_count": 4 }),
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
            gemini: Some(Vec::new()),
            pi: Some(Vec::new()),
            kimi: Some(Vec::new()),
            opencode: Some(Vec::new()),
            kilo: Some(Vec::new()),
            zcode: Some(Vec::new()),
            cursor: Some(Vec::new()),
            devin: Some(Vec::new()),
            copilot: Some(Vec::new()),
            hermes: Some(Vec::new()),
            vscode_copilot: Some(Vec::new()),
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
            codex: Some(Vec::new()),
            codex_archived: Some(Vec::new()),
            gemini: Some(Vec::new()),
            pi: Some(Vec::new()),
            kimi: Some(Vec::new()),
            opencode: Some(Vec::new()),
            kilo: Some(Vec::new()),
            zcode: Some(Vec::new()),
            cursor: Some(Vec::new()),
            devin: Some(Vec::new()),
            copilot: Some(Vec::new()),
            hermes: Some(Vec::new()),
            vscode_copilot: Some(Vec::new()),
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
            gemini: Some(Vec::new()),
            pi: Some(Vec::new()),
            kimi: Some(Vec::new()),
            opencode: Some(vec![database.to_string_lossy().into_owned()]),
            kilo: Some(Vec::new()),
            zcode: Some(Vec::new()),
            cursor: Some(Vec::new()),
            devin: Some(Vec::new()),
            copilot: Some(Vec::new()),
            hermes: Some(Vec::new()),
            vscode_copilot: Some(Vec::new()),
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
            codex: Some(Vec::new()),
            codex_archived: Some(Vec::new()),
            gemini: Some(Vec::new()),
            pi: Some(Vec::new()),
            kimi: Some(Vec::new()),
            opencode: Some(Vec::new()),
            kilo: Some(Vec::new()),
            zcode: Some(Vec::new()),
            cursor: Some(Vec::new()),
            devin: Some(Vec::new()),
            copilot: Some(Vec::new()),
            hermes: Some(Vec::new()),
            vscode_copilot: Some(Vec::new()),
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
    assert!(store.records["codex:first"]
        .search_text
        .contains("new first"));
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
            codex: Some(Vec::new()),
            codex_archived: Some(Vec::new()),
            gemini: Some(Vec::new()),
            pi: Some(Vec::new()),
            kimi: Some(Vec::new()),
            opencode: Some(Vec::new()),
            kilo: Some(Vec::new()),
            zcode: Some(Vec::new()),
            cursor: Some(Vec::new()),
            devin: Some(Vec::new()),
            copilot: Some(Vec::new()),
            hermes: Some(Vec::new()),
            vscode_copilot: Some(Vec::new()),
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
    let facets = store.facets();
    let sources = facets["sources"].as_array().unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0]["kind"], "codex");
    assert_eq!(facets["session_roots"].as_array().unwrap().len(), 2);
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
