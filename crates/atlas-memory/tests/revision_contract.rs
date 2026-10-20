use atlas_memory::record::{EntryKind, NewEntry, RecordStore, DB_FILE};

fn fact(session: &str, content: &str, at: i64) -> NewEntry {
    NewEntry {
        kind: EntryKind::Fact,
        key: "auth".into(),
        content: content.into(),
        source: "codex".into(),
        agent: "codex".into(),
        session_id: session.into(),
        confidence: 1.0,
        at,
    }
}

#[test]
fn another_session_must_read_the_revision_before_replacing_a_fact() {
    let root = tempfile::tempdir().unwrap();
    let store = RecordStore::open(root.path()).unwrap();
    let original = store
        .remember_guarded(
            fact("first", "Tokens expire after 15 minutes", 1),
            1,
            None,
            &[],
        )
        .unwrap()
        .entry;
    assert!(store
        .remember_guarded(
            fact("second", "Tokens expire after 30 minutes", 2),
            2,
            None,
            &[]
        )
        .is_err());
    let edited = store
        .remember_guarded(
            fact("second", "Tokens expire after 30 minutes", 3),
            3,
            Some(original.rev),
            &[],
        )
        .unwrap()
        .entry;
    assert!(edited.rev > original.rev);
    assert_eq!(store.history(original.id).unwrap().len(), 2);
    assert!(store
        .remember_guarded(
            fact("first", "An obsolete write", 4),
            4,
            Some(original.rev),
            &[]
        )
        .is_err());
}

#[test]
fn a_future_database_is_refused_without_quarantining_or_replacing_it() {
    let root = tempfile::tempdir().unwrap();
    let dir = atlas_memory::record::memory_dir(root.path());
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(DB_FILE);
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep'); PRAGMA user_version=999;").unwrap();
    }
    assert!(RecordStore::open(root.path()).is_err());
    let conn = rusqlite::Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row("SELECT value FROM future_data", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "keep"
    );
    assert!(!std::fs::read_dir(dir)
        .unwrap()
        .filter_map(Result::ok)
        .any(|e| e.file_name().to_string_lossy().contains("corrupt")));
}

#[test]
fn chinese_keywords_are_retrievable_without_an_embedding_model() {
    let root = tempfile::tempdir().unwrap();
    let store = RecordStore::open(root.path()).unwrap();
    let entry = store
        .remember(fact("first", "项目权限必须由用户确认", 1), 1)
        .unwrap()
        .entry;
    let hits = store.search("权限", &[], 10, 2).unwrap();
    assert!(hits.iter().any(|h| h.id == entry.id));
}

#[test]
fn upgrading_v4_preserves_ids_tombstones_and_a_consistent_backup() {
    let root = tempfile::tempdir().unwrap();
    let dir = atlas_memory::record::memory_dir(root.path());
    std::fs::create_dir_all(&dir).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.join(DB_FILE)).unwrap();
        conn.execute_batch(include_str!("fixtures/v4.sql")).unwrap();
    }
    let store = RecordStore::open(root.path()).unwrap();
    let entry = store.peek(41).unwrap().unwrap();
    assert_eq!(entry.content, "Legacy fact survives");
    assert_eq!(store.history(41).unwrap().len(), 1);
    assert_eq!(
        store.change_snapshot(0, "reader", 8).unwrap().forgotten,
        vec![(99, 900)]
    );
    let backup = dir.join("memory.pre-v4.sqlite");
    {
        let conn = rusqlite::Connection::open(&backup).unwrap();
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
        assert_eq!(
            conn.query_row("SELECT content FROM entries WHERE id=41", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            entry.content
        );
    }
    store.forget(41, 2000, "reader").unwrap();
    std::fs::write(dir.join("memory.sqlite.corrupt-123"), "old recovery text").unwrap();
    std::fs::write(dir.join("user-notes.sqlite"), "unrelated").unwrap();
    store.purge(41).unwrap();
    assert!(
        !backup.exists(),
        "purged words must not survive in the migration backup"
    );
    assert!(!dir.join("memory.sqlite.corrupt-123").exists());
    assert!(dir.join("user-notes.sqlite").exists());
}

#[test]
fn a_timestamp_boundary_keeps_all_tied_entries() {
    let root = tempfile::tempdir().unwrap();
    let store = RecordStore::open(root.path()).unwrap();
    for i in 0..32 {
        let mut entry = fact("writer", &format!("Distinct fact {i}"), 1000);
        entry.key = format!("fact-{i}");
        store.remember(entry, 1000).unwrap();
    }
    let snapshot = store.change_snapshot(0, "reader", 8).unwrap();
    assert_eq!(snapshot.groups.iter().map(Vec::len).sum::<usize>(), 32);
}

#[test]
fn the_corpus_has_chinese_lexical_recall_without_a_model() {
    let root = tempfile::tempdir().unwrap();
    let mut engine = atlas_memory::MemoryEngine::try_open(root.path().to_path_buf()).unwrap();
    engine
        .index_documents(&[atlas_memory::CorpusDoc {
            id: "note:auth".into(),
            text: "项目权限必须由用户确认".into(),
            content_hash: "auth-v1".into(),
            corpus: "note".into(),
        }])
        .unwrap();
    assert_eq!(
        engine.retrieve_lexical("权限", 5).unwrap()[0].id,
        "note:auth"
    );
}

#[test]
fn a_retry_keeps_the_old_snapshot_and_takes_a_fresh_one() {
    let root = tempfile::tempdir().unwrap();
    let dir = atlas_memory::record::memory_dir(root.path());
    std::fs::create_dir_all(&dir).unwrap();
    {
        let conn = rusqlite::Connection::open(dir.join(DB_FILE)).unwrap();
        conn.execute_batch(include_str!("fixtures/v4.sql")).unwrap();
    }
    std::fs::write(
        dir.join("memory.pre-v4.sqlite"),
        b"earlier recovery evidence",
    )
    .unwrap();
    let store = RecordStore::open(root.path()).unwrap();
    assert_eq!(
        std::fs::read(dir.join("memory.pre-v4.sqlite")).unwrap(),
        b"earlier recovery evidence"
    );
    let fresh = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(Result::ok)
        .find(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("memory.pre-v4-")
        })
        .unwrap()
        .path();
    {
        let conn = rusqlite::Connection::open(&fresh).unwrap();
        assert_eq!(
            conn.query_row("SELECT content FROM entries WHERE id=41", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "Legacy fact survives"
        );
    }
    store.clear().unwrap();
    assert!(!fresh.exists());
    assert!(!dir.join("memory.pre-v4.sqlite").exists());
}
