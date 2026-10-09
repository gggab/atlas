use std::sync::Arc;

use atlas_thread_metadata::{PathList, ThreadId, ThreadMetadata, ThreadMetadataStore};
use rusqlite::Connection;

/// A V3 fixture built from the public store, then restored to the legacy shape.
fn legacy_v3(path: &std::path::Path) {
    let store = ThreadMetadataStore::open(path).unwrap();
    let mut row = ThreadMetadata::new(
        ThreadId::new(),
        "codex-acp".into(),
        PathList::new(&["/repo"]),
    );
    row.session_id = Some("session-1".into());
    row.title = Some("Keep my history".into());
    store.save_all(vec![row]);
    store.flush().unwrap();
    drop(store);
    let conn = Connection::open(path).unwrap();
    if conn.prepare("SELECT branch FROM threads").is_ok() {
        conn.execute_batch("ALTER TABLE threads DROP COLUMN branch")
            .unwrap();
    }
    conn.execute_batch("DROP TABLE IF EXISTS schema_migrations; PRAGMA user_version = 3;")
        .unwrap();
}

#[test]
fn an_invalid_existing_backup_blocks_migration_and_leaves_the_database_at_v3() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    legacy_v3(&path);
    let backup = dir.path().join("threads.db.bak-v3");
    std::fs::write(&backup, "interrupted backup").unwrap();
    assert!(ThreadMetadataStore::open(&path).is_err());
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        std::fs::read_to_string(backup).unwrap(),
        "interrupted backup"
    );
}

#[test]
fn opening_a_newer_epoch_refuses_it_before_changing_journal_mode() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    legacy_v3(&path);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=DELETE; PRAGMA user_version=6;")
        .unwrap();
    drop(conn);
    let before = std::fs::read(&path).unwrap();
    assert!(ThreadMetadataStore::open(&path).is_err());
    assert!(
        std::fs::read(&path).unwrap() == before,
        "a newer catalog must remain byte-for-byte unchanged"
    );
    assert!(!dir.path().join("threads.db-wal").exists());
    assert!(!dir.path().join("threads.db.bak-v6").exists());
}

#[test]
fn simultaneous_store_opens_publish_one_complete_backup_without_temporary_residue() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    legacy_v3(&path);
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let workers = (0..2)
        .map(|_| {
            let barrier = barrier.clone();
            let path = path.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let store = ThreadMetadataStore::open(&path).unwrap();
                assert_eq!(store.threads().len(), 1);
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap();
    }
    let backup = Connection::open(dir.path().join("threads.db.bak-v3")).unwrap();
    assert_eq!(
        backup
            .query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        backup
            .query_row("SELECT COUNT(*) FROM threads", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert!(!std::fs::read_dir(dir.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .contains(".tmp-")));
}

#[test]
fn migration_backup_includes_uncheckpointed_wal_rows_and_can_restore_a_v3_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    legacy_v3(&path);
    let conn = Connection::open(&path).unwrap();
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    conn.execute("UPDATE threads SET title = 'Still in WAL'", [])
        .unwrap();
    let store = ThreadMetadataStore::open(&path).unwrap();
    assert_eq!(store.threads()[0].title.as_deref(), Some("Still in WAL"));
    let backup = dir.path().join("threads.db.bak-v3");
    let old = Connection::open(&backup).unwrap();
    assert_eq!(
        old.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert!(old.prepare("SELECT branch FROM threads").is_err());
    assert_eq!(
        old.query_row("SELECT title FROM threads", [], |r| r.get::<_, String>(0))
            .unwrap(),
        "Still in WAL"
    );
    drop(old);
    drop(store);
    drop(conn);
    let restored = dir.path().join("restored.db");
    std::fs::copy(&backup, &restored).unwrap();
    let old = Connection::open(&restored).unwrap();
    assert_eq!(
        old.query_row("SELECT COUNT(*) FROM threads", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        old.query_row("PRAGMA user_version", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        3
    );
}

#[test]
fn moving_from_v3_to_named_migrations_does_not_replay_its_completed_data_cleanup() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    legacy_v3(&path);
    let conn = Connection::open(&path).unwrap();
    // This row arrived after that old version's cleanup had already completed.
    let retired = [b'c', b'e', b'r', b's', b'e', b'i']
        .map(char::from)
        .iter()
        .collect::<String>();
    conn.execute("UPDATE threads SET agent_id = ?1", [&retired])
        .unwrap();
    drop(conn);
    let store = ThreadMetadataStore::open(&path).unwrap();
    assert_eq!(store.threads().len(), 1);
    assert_eq!(store.threads()[0].agent_id.as_str(), retired);
    assert_eq!(store.threads()[0].title.as_deref(), Some("Keep my history"));
    let old = Connection::open(dir.path().join("threads.db.bak-v3")).unwrap();
    assert_eq!(
        old.query_row("SELECT agent_id FROM threads", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        retired
    );
    let row = store.threads()[0].clone();
    store.update_branch(row.thread_id, Some(Arc::from("develop")));
    store.flush().unwrap();
    drop(store);
    let reopened = ThreadMetadataStore::open(&path).unwrap();
    assert_eq!(reopened.threads()[0].branch.as_deref(), Some("develop"));
}
