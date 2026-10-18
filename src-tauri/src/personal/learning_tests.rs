use super::store::*;

fn input(source: &str, key: &str, text: &str) -> MemoryInput {
    serde_json::from_value(serde_json::json!({
        "key":key,"kind":"fact","content":text,"confirmed":true,
        "sourceMessageId":source,"evidenceQuote":text,
    }))
    .unwrap()
}
fn setup() -> Store {
    let mut s = Store::open_memory().unwrap();
    s.bind("chat", "session", "agent").unwrap();
    s
}
#[test]
fn ordinary_assertions_need_real_literal_evidence_and_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("memory.sqlite");
    let mut s = Store::open(&path).unwrap();
    s.bind("chat", "session", "agent").unwrap();
    s.note_human("chat", "h", "Rent is due on the fifteenth")
        .unwrap();
    assert!(s
        .learn("chat", input("h", "rent", "Made up by the assistant"))
        .is_err());
    let saved = s
        .learn("chat", input("h", "rent", "Rent is due on the fifteenth"))
        .unwrap()
        .saved
        .unwrap();
    assert_eq!(saved.origin, "automatic");
    let retry = s
        .learn("chat", input("h", "rent", "Rent is due on the fifteenth"))
        .unwrap()
        .saved
        .unwrap();
    assert_eq!(
        (saved.id.clone(), saved.revision),
        (retry.id, retry.revision)
    );
    drop(s);
    let s = Store::open(&path).unwrap();
    assert_eq!(
        s.memories().unwrap()[0].evidence_quote,
        "Rent is due on the fifteenth"
    );
}
#[test]
fn candidates_remain_inert_and_confirm_the_stored_payload_after_the_turn() {
    let mut s = setup();
    s.note_human("chat", "h", "Alex birthday May twentieth")
        .unwrap();
    let mut i = input("h", "alex/birthday", "Alex birthday May twentieth");
    i.confirmed = false;
    i.question = None;
    let c = s.learn("chat", i).unwrap().candidate.unwrap();
    assert!(s.memories().unwrap().is_empty());
    assert!(s
        .learn(
            "chat",
            input("h", "alex/birthday", "Alex birthday May twentieth")
        )
        .is_err());
    s.note_human("chat", "next", "Another topic").unwrap();
    assert!(s.confirm_memory(&c.id, c.revision + 1).is_err());
    let saved = s.confirm_memory(&c.id, c.revision).unwrap();
    assert!(saved.confirmed);
    assert_eq!(saved.origin, "manual");
    assert_eq!(saved.source_message_id, "h");
    assert!(s.memory_candidates().unwrap().is_empty());
}
#[test]
fn deletion_blocks_stale_alias_creation_but_not_unrelated_existing_updates() {
    let mut s = setup();
    s.note_human("chat", "h", "Rent ten; language Chinese")
        .unwrap();
    let rent = s
        .learn("chat", input("h", "rent", "Rent ten"))
        .unwrap()
        .saved
        .unwrap();
    let lang = s
        .learn("chat", input("h", "language", "language Chinese"))
        .unwrap()
        .saved
        .unwrap();
    s.note_human("chat", "old", "Rent ten; language English; city Riyadh")
        .unwrap();
    s.forget(&rent.id, rent.revision).unwrap();
    assert!(s.learn("chat", input("old", "rent", "Rent ten")).is_err());
    assert!(s
        .learn("chat", input("old", "rent-alias", "Rent ten"))
        .is_err());
    let mut change = input("old", "language", "language English");
    change.id = Some(lang.id);
    change.expected_revision = Some(lang.revision);
    assert!(s.learn("chat", change).is_ok());
    assert!(s
        .learn("chat", input("old", "city", "city Riyadh"))
        .is_err());
    s.note_human("chat", "fresh", "city Riyadh").unwrap();
    assert!(s
        .learn("chat", input("fresh", "city", "city Riyadh"))
        .is_ok());
}
#[test]
fn relearning_requires_trusted_confirmation_and_retains_the_old_turn_barrier() {
    let mut s = setup();
    s.note_human("chat", "h", "Rent ten").unwrap();
    let rent = s
        .learn("chat", input("h", "rent", "Rent ten"))
        .unwrap()
        .saved
        .unwrap();
    s.forget(&rent.id, rent.revision).unwrap();
    s.note_human("chat", "fresh", "Rent fifteen").unwrap();
    assert!(s
        .learn("chat", input("fresh", "rent", "Rent fifteen"))
        .is_err());
    s.note_human("ui", "ui-h", "Rent fifteen").unwrap();
    assert!(s
        .remember("ui", input("ui-h", "rent", "Rent fifteen"))
        .is_err());
    let rebuilt = s
        .relearn("ui", input("ui-h", "rent", "Rent fifteen"))
        .unwrap();
    assert_ne!(rebuilt.id, rent.id);
    assert!(s
        .learn("chat", input("fresh", "rent", "Rent fifteen"))
        .is_err());
}
#[test]
fn rename_and_forget_purge_candidates_and_protect_both_keys() {
    let mut s = setup();
    s.note_human("chat", "h", "Rent ten; maybe Rent twenty")
        .unwrap();
    let rent = s
        .learn("chat", input("h", "rent", "Rent ten"))
        .unwrap()
        .saved
        .unwrap();
    let mut c = input("h", "rent", "Rent twenty");
    c.id = Some(rent.id.clone());
    c.expected_revision = Some(rent.revision);
    c.confirmed = false;
    let candidate = s.learn("chat", c).unwrap().candidate.unwrap();
    s.note_human("ui", "ui-h", "Rent ten").unwrap();
    let mut rename = input("ui-h", "housing/rent", "Rent ten");
    rename.id = Some(rent.id.clone());
    rename.expected_revision = Some(rent.revision);
    let renamed = s.remember("ui", rename).unwrap();
    assert!(s.confirm_memory(&candidate.id, candidate.revision).is_err());
    assert!(s.learn("chat", input("h", "rent", "Rent ten")).is_err());
    assert!(s
        .learn("chat", input("h", "housing/rent", "Rent ten"))
        .is_err());
    s.forget(&renamed.id, renamed.revision).unwrap();
    assert!(s.memories().unwrap().is_empty());
    assert!(s.memory_candidates().unwrap().is_empty());
}
#[test]
fn concurrent_candidate_and_existing_value_changes_are_revision_checked() {
    let mut s = setup();
    s.note_human("chat", "h", "Rent ten or fifteen").unwrap();
    let old = s
        .learn("chat", input("h", "rent", "Rent ten"))
        .unwrap()
        .saved
        .unwrap();
    let mut c = input("h", "rent", "fifteen");
    c.id = Some(old.id.clone());
    c.expected_revision = Some(old.revision);
    c.confirmed = false;
    let c = s.learn("chat", c).unwrap().candidate.unwrap();
    s.note_human("ui", "edit", "Rent twenty").unwrap();
    let mut edit = input("edit", "rent", "Rent twenty");
    edit.id = Some(old.id);
    edit.expected_revision = Some(old.revision);
    s.remember("ui", edit).unwrap();
    assert!(s.confirm_memory(&c.id, c.revision).is_err());
}
#[test]
fn old_database_json_and_human_rows_migrate_without_rewriting_user_facts() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("old.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE personal_humans(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,text TEXT NOT NULL); CREATE TABLE personal_memories(id TEXT PRIMARY KEY,entry_key TEXT NOT NULL UNIQUE,data TEXT NOT NULL);").unwrap();
    db.execute("INSERT INTO personal_memories VALUES('old','rent',?1)",[serde_json::json!({"id":"old","key":"rent","kind":"fact","content":"Rent ten","confirmed":true,"revision":1,"sourceMessageId":"old-human","sourceThreadId":"old-chat","updatedAt":1}).to_string()]).unwrap();
    drop(db);
    let mut s = Store::open(&path).unwrap();
    let old = &s.memories().unwrap()[0];
    assert_eq!(old.content, "Rent ten");
    assert_eq!(old.origin, "manual");
    assert!(!old.core);
    s.bind("chat", "session", "agent").unwrap();
    s.note_human("chat", "new", "City Riyadh").unwrap();
    assert!(s.learn("chat", input("new", "city", "City Riyadh")).is_ok());
    drop(s);
    assert_eq!(Store::open(&path).unwrap().memories().unwrap().len(), 2);
}

#[test]
fn core_limit_is_explicit_and_never_unpins_existing_constraints() {
    let mut s = setup();
    s.note_human("chat","h","Preference one; Preference two; Preference three; Preference four; Preference five; Preference six").unwrap();
    for (i, text) in [
        "Preference one",
        "Preference two",
        "Preference three",
        "Preference four",
        "Preference five",
    ]
    .iter()
    .enumerate()
    {
        let mut p = input("h", &format!("core-{i}"), text);
        p.core = Some(true);
        s.learn("chat", p).unwrap();
    }
    let mut sixth = input("h", "six", "Preference six");
    sixth.core = Some(true);
    assert!(s
        .learn("chat", sixth.clone())
        .unwrap_err()
        .to_string()
        .contains("five core"));
    assert_eq!(s.memories().unwrap().iter().filter(|m| m.core).count(), 5);
    let pinned = s
        .memories()
        .unwrap()
        .into_iter()
        .find(|m| m.key == "core-0")
        .unwrap();
    let mut unpin = input("h", "core-0", "Preference one");
    unpin.id = Some(pinned.id);
    unpin.expected_revision = Some(pinned.revision);
    unpin.core = Some(false);
    assert!(s.learn("chat", unpin).is_err());
    sixth.core = Some(false);
    assert!(s.learn("chat", sixth).is_ok());
}

#[test]
fn unresolved_identity_cannot_be_accepted_with_a_generic_confirm_click() {
    let mut s = setup();
    s.note_human("chat", "h", "Alex birthday May twentieth")
        .unwrap();
    let mut i = input("h", "alex/birthday", "Alex birthday May twentieth");
    i.confirmed = false;
    i.question = Some("Which Alex?".into());
    let c = s.learn("chat", i).unwrap().candidate.unwrap();
    assert!(s
        .confirm_memory(&c.id, c.revision)
        .unwrap_err()
        .to_string()
        .contains("Resolve"));
    assert!(s.memories().unwrap().is_empty());
}

#[test]
fn two_connections_recheck_deletion_at_commit_and_purge_candidate_values() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("shared.sqlite");
    let mut a = Store::open(&file).unwrap();
    a.bind("chat", "session", "agent").unwrap();
    a.note_human("chat", "h", "Rent ten; Rent twenty").unwrap();
    let rent = a
        .learn("chat", input("h", "rent", "Rent ten"))
        .unwrap()
        .saved
        .unwrap();
    let mut pending = input("h", "rent", "Rent twenty");
    pending.id = Some(rent.id.clone());
    pending.expected_revision = Some(rent.revision);
    pending.confirmed = false;
    let candidate = a.learn("chat", pending).unwrap().candidate.unwrap();
    let mut b = Store::open(&file).unwrap();
    b.forget(&rent.id, rent.revision).unwrap();
    assert!(a.confirm_memory(&candidate.id, candidate.revision).is_err());
    assert!(a
        .learn("chat", input("h", "different-rent-key", "Rent ten"))
        .is_err());
    assert!(a.memory_candidates().unwrap().is_empty());
    assert!(a.memories().unwrap().is_empty());
}
