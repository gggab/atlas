use super::{calendar::CalendarSpec, model::*, store::Store};
use serde_json::json;

fn at(s: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(s)
        .unwrap()
        .timestamp_millis()
}
fn input(key: &str, calendar: Option<CalendarSpec>) -> TaskInput {
    serde_json::from_value(json!({"idempotencyKey":key,"title":"Fictional reminder","prompt":"Check it","kind":"reminder","scopeKey":"personal","dueAt":2000,"calendar":calendar})).unwrap()
}
fn reopen(t: &Task, at: Option<i64>) -> ReopenTask {
    ReopenTask {
        id: t.id.clone(),
        revision: t.revision,
        at,
        calendar: None,
        max_runs: None,
    }
}
fn spec() -> CalendarSpec {
    serde_json::from_value(json!({"frequency":"daily","startDate":"2026-01-01","localTime":"09:00","timezone":"UTC","reminderDays":[0],"untilDate":"2026-01-03","trackCompletion":true})).unwrap()
}

#[test]
fn terminal_tasks_need_explicit_reopen_and_keep_their_identity() {
    for action in [TaskAction::Cancel, TaskAction::Complete] {
        let mut s = Store::memory();
        let original = s.upsert(input("one", None), 1000).unwrap();
        let ended = s
            .control(&original.id, original.revision, action, None, 1500)
            .unwrap();
        let mut edit = ended.input.clone();
        edit.id = Some(ended.id.clone());
        edit.expected_revision = Some(ended.revision);
        assert!(s.upsert(edit, 1600).is_err());
        for action in [TaskAction::Pause, TaskAction::Resume, TaskAction::Snooze] {
            assert!(s
                .control(&ended.id, ended.revision, action, None, 1600)
                .is_err());
        }
        assert!(s.reopen(reopen(&ended, Some(1600)), &[], 1700).is_err());
        let active = s.reopen(reopen(&ended, Some(3000)), &[], 1700).unwrap();
        assert_eq!(active.id, original.id);
        assert_eq!(active.created_at, original.created_at);
        assert_eq!(active.input, original.input);
        assert_eq!(active.revision, ended.revision + 1);
        assert_eq!(active.next_check_at, Some(3000));
        assert!(s.delete(&active.id, ended.revision, &[]).is_err());
        assert!(s.reopen(reopen(&ended, Some(4000)), &[], 1800).is_err());
        let ended_again = s
            .control(&active.id, active.revision, action, None, 1900)
            .unwrap();
        s.delete(&ended_again.id, ended_again.revision, &[])
            .unwrap();
        assert!(s.get(&active.id).is_err());
    }
}

#[test]
fn agent_reopen_preserves_budget_and_rejects_live_old_runs() {
    let mut s = Store::memory();
    let mut i = input("agent", None);
    i.kind = TaskKind::AgentCheck;
    i.max_runs = 1;
    i.execution_thread_id = Some("thread".into());
    i.agent = Some("installed-agent".into());
    i.cwd = Some("/fixture".into());
    let t = s.upsert(i, 1000).unwrap();
    let r = s.claim_due(2000, "boot").unwrap().unwrap();
    s.dispatch(&r.id, "session", 1, 2001).unwrap();
    let ended = s
        .control(&t.id, t.revision, TaskAction::Cancel, None, 2002)
        .unwrap();
    let mut request = reopen(&ended, Some(4000));
    request.max_runs = Some(2);
    assert!(s.reopen(request.clone(), &[r.id.clone()], 2100).is_err());
    assert!(s.delete(&t.id, ended.revision, &[r.id.clone()]).is_err());
    assert!(s.reopen(reopen(&ended, Some(4000)), &[], 2100).is_err());
    let active = s.reopen(request, &[], 2100).unwrap();
    assert_eq!(active.run_count, 1);
    assert_eq!(active.input.max_runs, 2);
    assert!(s.finish_agent(&r.id, true, "old result", 2200).is_err());
    assert_eq!(s.get(&t.id).unwrap().revision, active.revision);
}

#[test]
fn interval_reopen_starts_a_fresh_countdown() {
    let mut s = Store::memory();
    let mut i = input("interval", None);
    i.interval_minutes = Some(5);
    let t = s.upsert(i, 1000).unwrap();
    let ended = s
        .control(&t.id, t.revision, TaskAction::Cancel, None, 1500)
        .unwrap();
    let active = s.reopen(reopen(&ended, None), &[], 900000).unwrap();
    assert_eq!(active.next_check_at, Some(1200000));
    assert!(s.claim_due(900000, "boot").unwrap().is_none());
}

#[test]
fn calendar_reopen_retains_periods_and_suppresses_all_old_slots() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scheduler.sqlite");
    let mut s = Store::open(&path).unwrap();
    let t = s
        .upsert(input("calendar", Some(spec())), at("2026-01-01T00:00:00Z"))
        .unwrap();
    let r = s
        .claim_due(at("2026-01-01T09:00:00Z"), "boot")
        .unwrap()
        .unwrap();
    s.finish_reminder(&r.id, at("2026-01-01T09:00:01Z"))
        .unwrap();
    let p = s
        .occurrences(&t.id, None, 50)
        .unwrap()
        .into_iter()
        .find(|p| p.period_index == 0)
        .unwrap();
    let done = s
        .control_occurrence(
            &t.id,
            t.revision,
            &p.id,
            p.revision,
            OccurrenceAction::Complete,
            None,
            at("2026-01-01T09:01:00Z"),
        )
        .unwrap();
    let ended = s
        .control(
            &t.id,
            t.revision,
            TaskAction::Cancel,
            None,
            at("2026-01-01T10:00:00Z"),
        )
        .unwrap();
    let now = at("2026-01-05T10:00:00Z");
    assert!(s.reopen(reopen(&ended, None), &[], now).is_err());
    let mut req = reopen(&ended, None);
    let mut cal = spec();
    cal.until_date = Some("2026-01-08".into());
    req.calendar = Some(cal);
    let active = s.reopen(req, &[], now).unwrap();
    assert_eq!(active.id, t.id);
    drop(s);
    let mut s = Store::open(&path).unwrap();
    assert_eq!(
        s.get(&t.id).unwrap().calendar_progress.unwrap().reopened_at,
        Some(now)
    );
    assert!(s.claim_due(now, "boot").unwrap().is_none());
    let periods = s.occurrences(&t.id, None, 50).unwrap();
    let same = periods.iter().find(|p| p.id == done.id).unwrap();
    assert_eq!(same.state, OccurrenceState::Completed);
    assert_eq!(same.revision, done.revision);
    assert!(periods
        .iter()
        .any(|p| p.local_date == "2026-01-04" && p.state == OccurrenceState::Pending));
    assert_eq!(
        s.get(&t.id).unwrap().next_check_at,
        Some(at("2026-01-06T09:00:00Z"))
    );
    assert!(s.pending_delivery(now).unwrap().is_none());
}

#[test]
fn cancelled_ambiguous_calendar_reopens_only_as_a_draft() {
    let mut s = Store::memory();
    let mut cal = spec();
    cal.timezone = String::new();
    let t = s.upsert(input("draft", Some(cal)), 1000).unwrap();
    let ended = s
        .control(&t.id, t.revision, TaskAction::Cancel, None, 1500)
        .unwrap();
    let draft = s.reopen(reopen(&ended, None), &[], 2000).unwrap();
    assert_eq!(draft.state, TaskState::NeedsConfirmation);
    assert!(draft.next_check_at.is_none());
    assert!(s.occurrences(&t.id, None, 50).unwrap().is_empty());
}

#[test]
fn completed_calendar_needs_a_new_unhandled_future_period() {
    let mut s = Store::memory();
    let mut cal = spec();
    cal.until_date = Some("2026-01-01".into());
    let t = s
        .upsert(
            input("completed-calendar", Some(cal.clone())),
            at("2026-01-01T00:00:00Z"),
        )
        .unwrap();
    for period in s.occurrences(&t.id, None, 50).unwrap() {
        s.control_occurrence(
            &t.id,
            t.revision,
            &period.id,
            period.revision,
            OccurrenceAction::Complete,
            None,
            at("2026-01-01T01:00:00Z"),
        )
        .unwrap();
    }
    let ended = s.get(&t.id).unwrap();
    assert_eq!(ended.state, TaskState::Completed);
    let now = at("2026-01-01T02:00:00Z");
    assert!(s.reopen(reopen(&ended, None), &[], now).is_err());
    assert_eq!(s.get(&t.id).unwrap().revision, ended.revision);
    let mut req = reopen(&ended, None);
    cal.until_date = Some("2026-01-02".into());
    req.calendar = Some(cal);
    let active = s.reopen(req, &[], now).unwrap();
    assert_eq!(active.state, TaskState::Active);
    assert_eq!(active.next_check_at, Some(at("2026-01-02T09:00:00Z")));
}

#[test]
fn v2_upgrade_keeps_normal_offline_catchup_without_a_reopen_marker() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scheduler.sqlite");
    let mut s = Store::open(&path).unwrap();
    let t = s
        .upsert(input("legacy", Some(spec())), at("2026-01-01T00:00:00Z"))
        .unwrap();
    drop(s);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP TABLE deleted_task_keys; UPDATE tasks SET data=json_remove(data,'$.calendarProgress.reopenedAt'); PRAGMA user_version=2;").unwrap();
    drop(conn);
    let mut s = Store::open(&path).unwrap();
    assert!(s
        .get(&t.id)
        .unwrap()
        .calendar_progress
        .unwrap()
        .reopened_at
        .is_none());
    assert!(s
        .claim_due(at("2026-01-01T10:00:00Z"), "boot")
        .unwrap()
        .is_some());
}

#[test]
fn deletion_is_atomic_persistent_scoped_and_fences_old_retries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scheduler.sqlite");
    let mut s = Store::open(&path).unwrap();
    let original = input("calendar", Some(spec()));
    let t = s
        .upsert(original.clone(), at("2026-01-01T00:00:00Z"))
        .unwrap();
    let r = s
        .claim_due(at("2026-01-01T09:00:00Z"), "boot")
        .unwrap()
        .unwrap();
    s.finish_reminder(&r.id, at("2026-01-01T09:00:01Z"))
        .unwrap();
    let notification = s.notifications().unwrap().remove(0);
    let other = s.upsert(input("other", None), 1000).unwrap();
    assert!(s.delete(&t.id, t.revision, &[]).is_err());
    let ended = s
        .control(
            &t.id,
            t.revision,
            TaskAction::Cancel,
            None,
            at("2026-01-01T10:00:00Z"),
        )
        .unwrap();
    assert!(s.delete(&t.id, t.revision, &[]).is_err());
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("CREATE TRIGGER refuse_delete BEFORE DELETE ON tasks BEGIN SELECT RAISE(ABORT,'fixture failure'); END;").unwrap();
    assert!(s.delete(&t.id, ended.revision, &[]).is_err());
    assert!(s.get(&t.id).is_ok());
    assert!(!s.runs(&t.id).unwrap().is_empty());
    conn.execute_batch("DROP TRIGGER refuse_delete;").unwrap();
    s.delete(&t.id, ended.revision, &[]).unwrap();
    assert!(s.get(&t.id).is_err());
    assert!(s.get(&other.id).is_ok());
    for table in [
        "runs",
        "notification_outbox",
        "calendar_occurrences",
        "calendar_reminders",
    ] {
        let count: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM {table} WHERE task_id=?1"),
                [&t.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }
    assert!(s
        .finish_reminder(&r.id, at("2026-01-02T09:00:00Z"))
        .is_err());
    assert!(s
        .delivery_notification(notification.clone())
        .unwrap()
        .is_none());
    s.mark_read(&notification.id, true).unwrap();
    s.delivery_state(&notification.id, "accepted", None, 9000)
        .unwrap();
    s.delete(&t.id, ended.revision, &[]).unwrap();
    assert!(s.delete("unknown", 1, &[]).is_err());
    drop(s);
    let mut s = Store::open(&path).unwrap();
    assert!(s.upsert(original, 1000).is_err());
    let mut fresh = input("fresh-key", Some(spec()));
    fresh.title = t.input.title.clone();
    assert_ne!(
        s.upsert(fresh, at("2026-01-02T00:00:00Z")).unwrap().id,
        t.id
    );
}
