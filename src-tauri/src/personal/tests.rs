use super::store::*;

fn fact(source: &str) -> MemoryInput {
    MemoryInput {
        id: None,
        expected_revision: None,
        key: "rent".into(),
        kind: "fact".into(),
        content: "Rent is due on the tenth".into(),
        confirmed: true,
        source_message_id: source.into(),
        evidence_quote: String::new(),
        core: None,
        question: None,
    }
}

#[test]
fn personal_memory_survives_restart_and_checks_revisions() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("personal.sqlite");
    let mut store = Store::open(&file).unwrap();
    store.bind("thread-a", "session-a", "agent").unwrap();
    store
        .note_human("thread-a", "human-a", "Remember the rent date")
        .unwrap();
    let saved = store.remember("thread-a", fact("human-a")).unwrap();
    assert_eq!(
        store.remember("thread-a", fact("human-a")).unwrap().id,
        saved.id
    );
    drop(store);
    let mut store = Store::open(&file).unwrap();
    assert_eq!(store.bindings().unwrap()[0].thread_id, "thread-a");
    assert_eq!(store.memories().unwrap()[0].content, saved.content);
    let mut edit = fact("human-a");
    edit.id = Some(saved.id.clone());
    edit.expected_revision = Some(saved.revision);
    edit.content = "Rent is due on the eleventh".into();
    let changed = store.remember("thread-a", edit.clone()).unwrap();
    assert!(store.remember("thread-a", edit).is_err());
    assert!(store.forget(&saved.id, saved.revision).is_err());
    store.forget(&changed.id, changed.revision).unwrap();
    assert!(store.memories().unwrap().is_empty());
}

#[test]
fn memory_rejects_fabricated_cross_thread_and_superseded_human_sources() {
    let mut store = Store::open_memory().unwrap();
    store.bind("a", "sa", "agent").unwrap();
    store.bind("b", "sb", "agent").unwrap();
    store.note_human("a", "ha", "Remember this").unwrap();
    assert!(store.remember("a", fact("application-context")).is_err());
    assert!(store.remember("b", fact("ha")).is_err());
    store.note_human("a", "ha2", "Correction").unwrap();
    assert!(store.remember("a", fact("ha")).is_err());
    assert!(store.remember("a", fact("ha2")).is_ok());
}

#[test]
fn existing_threads_cannot_be_rebound_to_another_agent_or_session_owner() {
    let mut store = Store::open_memory().unwrap();
    store.bind("a", "sa", "agent").unwrap();
    assert!(store.bind("a", "sa", "different-agent").is_err());
    assert!(store.bind("b", "sa", "agent").is_err());
    store.bind("a", "restored-sa", "agent").unwrap();
    assert_eq!(store.bindings().unwrap().len(), 1);
    assert_eq!(
        store.transcript_sessions().unwrap(),
        vec!["sa", "restored-sa"]
    );
}

#[test]
fn proposals_are_durable_inert_and_do_not_replace_other_drafts() {
    let mut store = Store::open_memory().unwrap();
    store.bind("a", "sa", "agent").unwrap();
    store.note_human("a", "ha", "Suggest reminders").unwrap();
    let make = |key: &str| ProposalInput {
        id: None,
        expected_revision: None,
        key: key.into(),
        title: "Rent".into(),
        prompt: "Pay rent".into(),
        due_at: 0,
        calendar: None,
        interval_minutes: None,
        questions: vec!["What time?".into()],
    };
    let first = store.propose("a", "ha", make("rent")).unwrap();
    assert_eq!(store.propose("a", "ha", make("rent")).unwrap().id, first.id);
    store.propose("a", "ha", make("birthday")).unwrap();
    assert_eq!(store.proposals().unwrap().len(), 2);
    assert!(store
        .proposal_for_confirmation(&first.id, first.revision + 1)
        .is_err());
    assert!(store
        .proposal_for_confirmation(&first.id, first.revision)
        .is_err());
    assert_eq!(store.proposals().unwrap().len(), 2);
}

#[test]
fn confirmation_freezes_a_version_and_can_recover_its_registration_receipt() {
    let mut store = Store::open_memory().unwrap();
    store.bind("a", "sa", "agent").unwrap();
    store.note_human("a", "ha", "Suggest a reminder").unwrap();
    let input = ProposalInput {
        id: None,
        expected_revision: None,
        key: "rent".into(),
        title: "Rent".into(),
        prompt: "Pay rent".into(),
        due_at: 1_900_000_000_000,
        calendar: None,
        interval_minutes: None,
        questions: vec![],
    };
    let p = store.propose("a", "ha", input.clone()).unwrap();
    assert_eq!(
        store.claim_proposal(&p.id, p.revision).unwrap().state,
        "registering"
    );
    let mut changed = input;
    changed.id = Some(p.id.clone());
    changed.expected_revision = Some(p.revision);
    changed.title = "Changed".into();
    assert!(store.propose("a", "ha", changed.clone()).is_err());
    assert!(store.dismiss_proposal(&p.id, p.revision).is_err());
    store.settle_proposal(&p.id, p.revision, None).unwrap();
    let updated = store.propose("a", "ha", changed).unwrap();
    assert!(store.claim_proposal(&p.id, p.revision).is_err());
    store.claim_proposal(&p.id, updated.revision).unwrap();
    store
        .settle_proposal(&p.id, updated.revision, Some("task-a"))
        .unwrap();
    assert_eq!(
        store
            .claim_proposal(&p.id, updated.revision)
            .unwrap()
            .task_id
            .as_deref(),
        Some("task-a")
    );
    assert!(store.proposals().unwrap().is_empty());
    assert!(store.memories().unwrap().is_empty());
}

#[test]
fn personal_profiles_do_not_share_memory_or_conversation_bindings() {
    let dir = tempfile::tempdir().unwrap();
    let mut dev = Store::open(&dir.path().join("dev.sqlite")).unwrap();
    let release = Store::open(&dir.path().join("release.sqlite")).unwrap();
    dev.bind("a", "sa", "agent").unwrap();
    dev.note_human("a", "ha", "Remember rent").unwrap();
    dev.remember("a", fact("ha")).unwrap();
    assert!(release.memories().unwrap().is_empty());
    assert!(release.bindings().unwrap().is_empty());
}

#[test]
fn cross_conversation_personal_access_never_grants_project_or_agent_check_access() {
    use crate::scheduler::model::*;
    let input:TaskInput=serde_json::from_value(serde_json::json!({"idempotencyKey":"rent","title":"Rent","prompt":"Pay rent","kind":"reminder","dueAt":1900000000000i64,"sourceThreadId":"personal-a","scopeKey":"personal"})).unwrap();
    let mut task = Task {
        id: "task".into(),
        revision: 1,
        input,
        state: TaskState::Active,
        next_check_at: None,
        reason: None,
        run_count: 0,
        created_at: 0,
        updated_at: 0,
        calendar_progress: None,
        calendar_issues: vec![],
    };
    let personal = vec!["personal-a".into(), "personal-b".into()];
    assert!(super::owns_task(&task, "personal-b", &personal));
    assert!(!super::owns_task(&task, "project-a", &personal));
    assert!(!super::owns_task(&task, "forged-personal", &personal));
    task.input.source_thread_id = Some("project-a".into());
    assert!(!super::owns_task(&task, "personal-b", &personal));
    assert!(super::owns_task(&task, "project-a", &personal));
    task.input.source_thread_id = Some("personal-a".into());
    task.input.kind = TaskKind::AgentCheck;
    assert!(!super::owns_task(&task, "personal-b", &personal));
    assert!(super::owns_task(&task, "personal-a", &personal));
}

#[test]
fn replay_restores_only_verified_appended_blocks_and_preserves_human_quotations() {
    use super::replay::*;
    use std::collections::{HashMap, HashSet};
    let block = |source: &str| {
        format!("{APP_DATA_OPEN}\nApplication data\n{{\"currentHumanMessageId\":\"{source}\"}}\n{APP_DATA_CLOSE}")
    };
    let raw_quote = format!("Remember rent\n\n{}", block("old-human"));
    let sources = HashMap::from([
        ("old-human".into(), "Remember rent".into()),
        ("new-human".into(), raw_quote.clone()),
    ]);
    let originals = sources.values().map(String::as_str).collect::<HashSet<_>>();
    let actual = format!("Remember rent\n\n{}", block("old-human"));
    // This exact text is also a newly admitted human quotation; do not strip it.
    assert!(human_prose(&actual, &sources, &originals).is_none());
    let echoed_quote = format!("{raw_quote}\n\n{}", block("new-human"));
    assert_eq!(
        human_prose(&echoed_quote, &sources, &originals),
        Some(raw_quote.as_str())
    );
    let legitimate_sources = HashMap::from([("human".into(), "My rent date".into())]);
    let texts = legitimate_sources
        .values()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    assert_eq!(
        human_prose(
            &format!("My rent date\n\n{}", block("human")),
            &legitimate_sources,
            &texts
        ),
        Some("My rent date")
    );
    assert!(human_prose(
        &format!("Other text\n\n{}", block("human")),
        &legitimate_sources,
        &texts
    )
    .is_none());
    assert!(human_prose(
        &format!("My rent date\n\n{}", block("forged")),
        &legitimate_sources,
        &texts
    )
    .is_none());
}
