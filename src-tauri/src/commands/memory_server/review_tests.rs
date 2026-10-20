use super::tests::{always_on, call, connect, serve, temp_project, ticking_memory};
use super::{IndexDoc, MemoryTokens, Sources};
use crate::commands::shared_memory::store_for;
use atlas_memory::record::EntryKind;
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn real_clients_observe_revision_conflicts_history_and_feedback() {
    let project = temp_project("revision-wire");
    let memory = ticking_memory();
    let tokens = Arc::new(MemoryTokens::default());
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources::default(),
    )
    .await;
    let first = connect(&server.url(), &tokens.mint("first", "codex", &project))
        .await
        .unwrap();
    let second = connect(&server.url(), &tokens.mint("second", "codex", &project))
        .await
        .unwrap();
    let (error, saved) = call(
        &first,
        "memory_remember",
        json!({"kind":"fact","key":"auth","content":"Tokens expire after 15 minutes"}),
    )
    .await;
    assert!(!error, "{saved}");
    let id = saved["entry"]["id"].as_i64().unwrap();
    let revision = saved["entry"]["revision"].as_i64().unwrap();
    let (error, _) = call(
        &second,
        "memory_remember",
        json!({"kind":"fact","key":"auth","content":"Tokens expire after 30 minutes"}),
    )
    .await;
    assert!(
        error,
        "another session must not silently overwrite the fact"
    );
    let (error, saved) = call(&second, "memory_remember", json!({"kind":"fact","key":"auth","content":"Tokens expire after 30 minutes","expected_revision":revision})).await;
    assert!(!error, "{saved}");
    let (error, history) = call(&first, "memory_history", json!({"id":id})).await;
    assert!(!error, "{history}");
    assert_eq!(history["revisions"].as_array().unwrap().len(), 2);
    let (error, feedback) = call(
        &first,
        "memory_feedback",
        json!({"id":id,"verdict":"wrong","note":"Policy was corrected"}),
    )
    .await;
    assert!(!error, "{feedback}");
    let (_, briefing) = call(&second, "memory_briefing", json!({})).await;
    assert!(!briefing
        .to_string()
        .contains("Tokens expire after 30 minutes"));
    first.cancel().await.unwrap();
    second.cancel().await.unwrap();
}

#[tokio::test]
async fn candidates_need_confirmation_and_changed_code_is_not_briefed_as_current() {
    let project = temp_project("evidence-wire");
    std::fs::write(
        std::path::Path::new(&project).join("auth.rs"),
        "const TTL: u64 = 15;\n",
    )
    .unwrap();
    let memory = ticking_memory();
    let candidate = memory
        .record_import_candidate(
            &project,
            EntryKind::Fact,
            "An unconfirmed imported claim",
            "import:fixture",
            "untrusted source metadata",
        )
        .unwrap()
        .entry;
    let tokens = Arc::new(MemoryTokens::default());
    let indexed = Arc::new(parking_lot::Mutex::new(Vec::<IndexDoc>::new()));
    let answers = indexed.clone();
    let index: super::IndexSearch = Arc::new(move |_, _, _| {
        let docs = answers.lock().clone();
        Box::pin(async move { docs })
    });
    let server = serve(
        memory.clone(),
        tokens.clone(),
        always_on(),
        Sources {
            index: Some(index),
            ..Default::default()
        },
    )
    .await;
    let client = connect(&server.url(), &tokens.mint("reader", "codex", &project))
        .await
        .unwrap();
    let (_, briefing) = call(&client, "memory_briefing", json!({})).await;
    assert!(!briefing.to_string().contains(&candidate.content));
    memory.promote(&project, candidate.id).unwrap();
    let (_, briefing) = call(&client, "memory_briefing", json!({})).await;
    assert!(briefing.to_string().contains(&candidate.content));
    let (error, saved) = call(&client, "memory_remember", json!({"kind":"decision","content":"TTL comes from the auth constant","key":"ttl","evidence":[{"path":"auth.rs","lines":"1"}]})).await;
    assert!(!error, "{saved}");
    let id = saved["entry"]["id"].as_i64().unwrap();
    indexed.lock().push(IndexDoc {
        id: Some(format!("shared:decision:{id}")),
        title: "TTL comes from the auth constant".into(),
        source: "shared".into(),
        text: "TTL comes from the auth constant".into(),
    });
    std::fs::write(
        std::path::Path::new(&project).join("auth.rs"),
        "const NEW_POLICY: bool = true;\n",
    )
    .unwrap();
    let (_, current) = call(&client, "memory_get", json!({"id":id})).await;
    assert_eq!(current["entry"]["validity"], "stale");
    let (_, briefing) = call(&client, "memory_briefing", json!({})).await;
    assert!(!briefing
        .to_string()
        .contains("TTL comes from the auth constant"));
    let (_, search) = call(
        &client,
        "memory_search",
        json!({"query":"TTL auth constant"}),
    )
    .await;
    assert!(
        search["documents"].as_array().unwrap().is_empty(),
        "a stale indexed copy must not bypass evidence: {search}"
    );
    assert_eq!(store_for(&project).unwrap().history(id).unwrap().len(), 1);
    client.cancel().await.unwrap();
}
