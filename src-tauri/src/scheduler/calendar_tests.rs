use super::calendar::*;
use super::model::*;
use super::store::Store;
use chrono::{TimeZone, Utc};

fn at(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value)
        .unwrap()
        .timestamp_millis()
}
fn spec() -> CalendarSpec {
    serde_json::from_value(serde_json::json!({
        "frequency":"monthly", "startDate":"2024-01-31", "localTime":"09:00",
        "timezone":"Asia/Shanghai", "missingDayPolicy":"last_day",
        "reminderDays":[3,1,0], "trackCompletion":true
    }))
    .unwrap()
}
fn request(key: &str, calendar: CalendarSpec) -> TaskInput {
    serde_json::from_value(serde_json::json!({
        "idempotencyKey":key,"title":"Rent","prompt":"Check rent payment",
        "kind":"reminder","dueAt":0,"scopeKey":"personal","calendar":calendar
    }))
    .unwrap()
}

#[test]
fn calendar_and_minute_interval_rules_cannot_be_combined() {
    let mut store = Store::memory();
    let mut input = request("mixed-rules", spec());
    input.interval_minutes = Some(5);
    assert!(store.upsert(input, 1_000).is_err());
}

#[test]
fn monthly_clamping_does_not_drift_and_skip_keeps_nominal_indices() {
    let mut s = spec();
    assert_eq!(s.period(1).unwrap().unwrap().local_date, "2024-02-29");
    assert_eq!(s.period(2).unwrap().unwrap().local_date, "2024-03-31");
    s.missing_day_policy = Some(MissingDayPolicy::Skip);
    let next = s.period(1).unwrap().unwrap();
    assert_eq!(next.index, 2);
    assert_eq!(next.local_date, "2024-03-31");
}

#[test]
fn annual_leap_policies_are_explicit_and_skip_century_non_leap_years() {
    let mut s = spec();
    s.frequency = Frequency::Yearly;
    s.start_date = "2096-02-29".into();
    s.missing_day_policy = Some(MissingDayPolicy::NextDay);
    assert_eq!(s.period(4).unwrap().unwrap().local_date, "2100-03-01");
    s.missing_day_policy = Some(MissingDayPolicy::LastDay);
    assert_eq!(s.period(4).unwrap().unwrap().local_date, "2100-02-28");
    s.missing_day_policy = Some(MissingDayPolicy::Skip);
    assert_eq!(s.period(4).unwrap().unwrap().index, 8);
}

#[test]
fn dst_gap_fold_and_calendar_day_leads_use_the_named_zone() {
    let mut s = spec();
    s.frequency = Frequency::Daily;
    s.start_date = "2027-03-14".into();
    s.local_time = "02:30".into();
    s.timezone = "America/New_York".into();
    s.reminder_days = vec![0];
    assert_eq!(
        s.period(0).unwrap().unwrap().reminders[0].at,
        at("2027-03-14T07:00:00Z")
    );
    s.start_date = "2027-11-07".into();
    s.local_time = "01:30".into();
    assert_eq!(
        s.period(0).unwrap().unwrap().reminders[0].at,
        at("2027-11-07T05:30:00Z")
    );
    s.frequency = Frequency::Weekly;
    s.start_date = "2027-03-15".into();
    s.local_time = "09:00".into();
    s.reminder_days = vec![2, 0];
    let p = s.period(0).unwrap().unwrap();
    assert_eq!(p.reminders[1].at - p.reminders[0].at, 47 * 3_600_000);
    s.timezone = "Australia/Lord_Howe".into();
    s.frequency = Frequency::Daily;
    s.start_date = "2027-10-03".into();
    s.local_time = "02:15".into();
    s.reminder_days = vec![0];
    assert_eq!(
        s.period(0).unwrap().unwrap().reminders[0].at,
        at("2027-10-02T15:30:00Z")
    );
}

#[test]
fn ambiguous_rules_are_drafts_without_any_executable_rows() {
    let mut s = spec();
    s.missing_day_policy = None;
    s.timezone = String::new();
    let p = preview(&s, at("2026-01-01T00:00:00Z")).unwrap();
    assert_eq!(p.issues.len(), 2);
    let mut db = Store::memory();
    let task = db
        .upsert(request("draft", s), at("2026-01-01T00:00:00Z"))
        .unwrap();
    assert_eq!(task.state, TaskState::NeedsConfirmation);
    assert!(db.occurrences(&task.id, None, 50).unwrap().is_empty());
    assert!(db
        .claim_due(at("2027-01-01T00:00:00Z"), "boot")
        .unwrap()
        .is_none());
    assert!(db.notifications().unwrap().is_empty());
    assert!(db
        .control(
            &task.id,
            task.revision,
            TaskAction::Resume,
            None,
            at("2027-01-01T00:00:00Z")
        )
        .is_err());
    assert_eq!(
        db.control(
            &task.id,
            task.revision,
            TaskAction::Cancel,
            None,
            at("2027-01-01T00:00:00Z")
        )
        .unwrap()
        .state,
        TaskState::Cancelled
    );
}

#[test]
fn preview_has_no_pre_creation_backfill_and_until_is_inclusive() {
    let mut s = spec();
    s.until_date = Some("2026-02-28".into());
    let p = preview(&s, at("2026-01-30T00:00:00Z")).unwrap();
    assert_eq!(p.periods.len(), 2);
    assert_eq!(p.periods[0].local_date, "2026-01-31");
    assert_eq!(p.periods[1].local_date, "2026-02-28");
    s.frequency = Frequency::Daily;
    assert!(!preview(&s, 0).unwrap().issues.is_empty());
}

#[test]
fn completing_a_period_keeps_the_series_and_other_unpaid_periods() {
    let mut db = Store::memory();
    let task = db
        .upsert(request("rent", spec()), at("2026-01-01T00:00:00Z"))
        .unwrap();
    let run = db
        .claim_due(at("2026-01-31T02:00:00Z"), "boot")
        .unwrap()
        .unwrap();
    db.finish_reminder(&run.id, at("2026-01-31T02:00:00Z"))
        .unwrap();
    let jan = db
        .occurrences(&task.id, None, 50)
        .unwrap()
        .into_iter()
        .find(|o| o.local_date == "2026-01-31")
        .unwrap();
    db.control_occurrence(
        &task.id,
        task.revision,
        &jan.id,
        jan.revision,
        OccurrenceAction::Complete,
        None,
        at("2026-02-01T00:00:00Z"),
    )
    .unwrap();
    assert_eq!(db.get(&task.id).unwrap().state, TaskState::Active);
    let next = db
        .claim_due(at("2026-02-28T02:00:00Z"), "boot")
        .unwrap()
        .unwrap();
    db.finish_reminder(&next.id, at("2026-02-28T02:00:00Z"))
        .unwrap();
    assert!(db
        .pending_delivery(at("2026-02-28T02:00:00Z"))
        .unwrap()
        .is_some());
    assert!(db
        .control(
            &task.id,
            task.revision,
            TaskAction::Complete,
            None,
            at("2026-03-01T00:00:00Z")
        )
        .is_err());
}

#[test]
fn multi_year_catchup_is_batched_and_restart_settles_one_fixed_run() {
    let mut db = Store::memory();
    let mut s = spec();
    s.frequency = Frequency::Daily;
    s.reminder_days = vec![0];
    db.upsert(request("daily", s), at("2026-01-01T00:00:00Z"))
        .unwrap();
    let now = at("2031-01-01T12:00:00Z");
    let mut claimed = None;
    for _ in 0..30 {
        claimed = db.claim_due(now, "boot").unwrap();
        if claimed.is_some() {
            break;
        }
        assert!(db.notifications().unwrap().is_empty());
    }
    let run = claimed.unwrap();
    db.recover(now).unwrap();
    assert_eq!(db.notifications().unwrap().len(), 1);
    assert_eq!(db.notifications().unwrap()[0].run_id, run.id);
    assert!(db.claim_due(now, "reboot").unwrap().is_none());
}

#[test]
fn mixed_digest_filters_completed_period_and_repeated_snooze_is_independent() {
    let mut db = Store::memory();
    let task = db
        .upsert(request("digest", spec()), at("2026-01-01T00:00:00Z"))
        .unwrap();
    let now = at("2026-03-31T02:00:00Z");
    let run = db.claim_due(now, "boot").unwrap().unwrap();
    db.finish_reminder(&run.id, now).unwrap();
    let jan = db
        .occurrences(&task.id, None, 50)
        .unwrap()
        .into_iter()
        .find(|o| o.local_date == "2026-01-31")
        .unwrap();
    let jan = db
        .control_occurrence(
            &task.id,
            task.revision,
            &jan.id,
            jan.revision,
            OccurrenceAction::Snooze,
            Some(now + 3_600_000),
            now,
        )
        .unwrap();
    db.control_occurrence(
        &task.id,
        task.revision,
        &jan.id,
        jan.revision,
        OccurrenceAction::Snooze,
        Some(now + 7_200_000),
        now,
    )
    .unwrap();
    let n = db.pending_delivery(now).unwrap().unwrap();
    assert!(!n.body.contains("2026-01-31"));
    assert!(n.body.contains("2026-03-31"));
    assert!(db.claim_due(now + 3_600_000, "boot").unwrap().is_none());
    assert!(db.claim_due(now + 7_200_000, "boot").unwrap().is_some());
}

#[test]
fn edits_keep_period_identity_and_paid_state_and_freeze_started_periods() {
    let mut db = Store::memory();
    let now = at("2026-01-01T00:00:00Z");
    let task = db.upsert(request("edit", spec()), now).unwrap();
    let before = db.occurrences(&task.id, None, 50).unwrap();
    let mut edit = task.input.clone();
    edit.id = Some(task.id.clone());
    edit.expected_revision = Some(task.revision);
    edit.calendar.as_mut().unwrap().local_time = "10:00".into();
    let edited = db.upsert(edit, now + 1).unwrap();
    let after = db.occurrences(&task.id, None, 50).unwrap();
    assert_eq!(before[0].id, after[0].id);
    let mut bad = edited.input.clone();
    bad.id = Some(edited.id.clone());
    bad.expected_revision = Some(edited.revision);
    bad.calendar.as_mut().unwrap().start_date = "2024-01-30".into();
    assert!(db.upsert(bad, now + 2).is_err());
}

#[test]
fn pause_preserves_unpaid_periods_without_replaying_paused_slots() {
    let mut db = Store::memory();
    let task = db
        .upsert(
            request("pause-calendar", spec()),
            at("2026-01-01T00:00:00Z"),
        )
        .unwrap();
    let paused = db
        .control(
            &task.id,
            task.revision,
            TaskAction::Pause,
            None,
            at("2026-01-02T00:00:00Z"),
        )
        .unwrap();
    db.control(
        &task.id,
        paused.revision,
        TaskAction::Resume,
        None,
        at("2026-04-02T00:00:00Z"),
    )
    .unwrap();
    assert!(db
        .claim_due(at("2026-04-02T00:00:00Z"), "boot")
        .unwrap()
        .is_none());
    let past = db.occurrences(&task.id, None, 50).unwrap();
    assert!(past
        .iter()
        .any(|o| o.local_date == "2026-01-31" && o.state == OccurrenceState::Pending));
    assert!(db.notifications().unwrap().is_empty());
}

#[test]
fn old_json_without_calendar_fields_remains_a_one_shot() {
    let request: TaskInput = serde_json::from_value(serde_json::json!({
        "idempotencyKey":"old", "title":"Old", "prompt":"Still works", "kind":"reminder",
        "dueAt":Utc.with_ymd_and_hms(2030,1,1,0,0,0).unwrap().timestamp_millis(),"scopeKey":"personal"
    })).unwrap();
    assert!(request.calendar.is_none());
    let mut db = Store::memory();
    let task = db.upsert(request, 0).unwrap();
    assert!(db.occurrences(&task.id, None, 50).unwrap().is_empty());
}

#[test]
fn v1_migration_preserves_old_task_and_notification_records() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scheduler.sqlite");
    let mut db = Store::open(&path).unwrap();
    let mut old = request("old-schema", spec());
    old.calendar = None;
    old.due_at = 2000;
    let task = db.upsert(old, 1000).unwrap();
    let run = db.claim_due(2000, "boot").unwrap().unwrap();
    db.finish_reminder(&run.id, 2000).unwrap();
    let notification = db.notifications().unwrap()[0].id.clone();
    drop(db);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute_batch("DROP TABLE calendar_reminders; DROP TABLE calendar_occurrences; PRAGMA user_version=1;
        UPDATE tasks SET data=json_remove(data,'$.calendarProgress','$.calendarIssues','$.input.calendar');
        UPDATE runs SET data=json_remove(data,'$.calendar');
        UPDATE notification_outbox SET data=json_remove(data,'$.calendar');").unwrap();
    drop(conn);
    let db = Store::open(&path).unwrap();
    assert_eq!(db.get(&task.id).unwrap().state, TaskState::WaitingInput);
    assert_eq!(db.notifications().unwrap()[0].id, notification);
    assert!(db.occurrences(&task.id, None, 50).unwrap().is_empty());
}

#[test]
fn a_completed_reserved_period_cannot_publish_a_late_notification() {
    let mut db = Store::memory();
    let task = db
        .upsert(request("reserved", spec()), at("2026-01-01T00:00:00Z"))
        .unwrap();
    let now = at("2026-01-28T02:00:00Z");
    let run = db.claim_due(now, "boot").unwrap().unwrap();
    let jan = db
        .occurrences(&task.id, None, 50)
        .unwrap()
        .into_iter()
        .find(|o| o.local_date == "2026-01-31")
        .unwrap();
    db.control_occurrence(
        &task.id,
        task.revision,
        &jan.id,
        jan.revision,
        OccurrenceAction::Complete,
        None,
        now,
    )
    .unwrap();
    db.finish_reminder(&run.id, now).unwrap();
    assert!(db.pending_delivery(now).unwrap().is_none());
    assert!(db.notifications().unwrap().is_empty());
}

#[test]
fn editing_does_not_rearm_an_accepted_reminder_or_change_a_started_period() {
    let mut db = Store::memory();
    let task = db
        .upsert(request("freeze", spec()), at("2026-01-01T00:00:00Z"))
        .unwrap();
    let now = at("2026-01-28T02:00:00Z");
    let run = db.claim_due(now, "boot").unwrap().unwrap();
    db.finish_reminder(&run.id, now).unwrap();
    let n = db.pending_delivery(now).unwrap().unwrap();
    db.delivery_state(&n.id, "accepted", None, now).unwrap();
    let jan = db
        .occurrences(&task.id, None, 50)
        .unwrap()
        .into_iter()
        .find(|o| o.local_date == "2026-01-31")
        .unwrap();
    let mut edit = task.input.clone();
    edit.id = Some(task.id.clone());
    edit.expected_revision = Some(task.revision);
    edit.calendar.as_mut().unwrap().local_time = "15:00".into();
    let preview = db
        .calendar_preview(edit.calendar.clone().unwrap(), Some(&task.id), now)
        .unwrap();
    assert!(preview.frozen_periods.contains(&jan.local_date));
    assert_eq!(
        preview
            .periods
            .iter()
            .find(|p| p.local_date == jan.local_date)
            .unwrap()
            .due_at,
        jan.due_at
    );
    db.upsert(edit, now + 1).unwrap();
    let current = db
        .occurrences(&task.id, None, 50)
        .unwrap()
        .into_iter()
        .find(|o| o.id == jan.id)
        .unwrap();
    assert_eq!(current.due_at, jan.due_at);
    assert!(db.claim_due(now + 2, "boot").unwrap().is_none());
    assert!(db.pending_delivery(now + 2).unwrap().is_none());
}

#[test]
fn draft_resolution_and_rejected_edit_cannot_bypass_backend_validation() {
    let mut db = Store::memory();
    let now = at("2026-01-01T00:00:00Z");
    let mut s = spec();
    s.missing_day_policy = None;
    let draft = db.upsert(request("resolve", s), now).unwrap();
    let mut edit = draft.input.clone();
    edit.id = Some(draft.id.clone());
    edit.expected_revision = Some(draft.revision);
    edit.calendar.as_mut().unwrap().missing_day_policy = Some(MissingDayPolicy::LastDay);
    let task = db.upsert(edit, now + 1).unwrap();
    assert_eq!(task.state, TaskState::Active);
    let mut bad = task.input.clone();
    bad.expected_revision = Some(task.revision);
    bad.calendar.as_mut().unwrap().timezone = "Unknown/Zone".into();
    assert!(db.upsert(bad, now + 2).is_err());
    assert_eq!(db.get(&task.id).unwrap().revision, task.revision);
    assert_eq!(db.get(&task.id).unwrap().state, TaskState::Active);
    let paused = db
        .control(&task.id, task.revision, TaskAction::Pause, None, now + 3)
        .unwrap();
    let mut edit = paused.input.clone();
    edit.expected_revision = Some(paused.revision);
    assert!(db.upsert(edit, now + 4).is_err());
    assert_eq!(db.get(&task.id).unwrap().state, TaskState::Paused);
}

#[test]
fn ended_informational_calendar_elapses_without_claiming_payment() {
    let mut db = Store::memory();
    let mut s = spec();
    s.track_completion = false;
    s.until_date = Some("2026-01-31".into());
    let task = db
        .upsert(request("birthday", s), at("2026-01-01T00:00:00Z"))
        .unwrap();
    let now = at("2026-02-01T00:00:00Z");
    let run = db.claim_due(now, "boot").unwrap().unwrap();
    db.finish_reminder(&run.id, now).unwrap();
    assert!(db
        .occurrences(&task.id, None, 50)
        .unwrap()
        .iter()
        .all(|o| o.state == OccurrenceState::Elapsed));
    assert_eq!(db.get(&task.id).unwrap().state, TaskState::Completed);
    assert!(db.pending_delivery(now).unwrap().is_some());
}

#[test]
fn timezone_refresh_changes_only_unclaimed_future_calendar_slots() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scheduler.sqlite");
    let mut db = Store::open(&path).unwrap();
    let task = db
        .upsert(request("tzdb", spec()), at("2026-01-01T00:00:00Z"))
        .unwrap();
    let now = at("2026-01-28T02:00:00Z");
    let run = db.claim_due(now, "boot").unwrap().unwrap();
    db.finish_reminder(&run.id, now).unwrap();
    let n = db.pending_delivery(now).unwrap().unwrap();
    db.delivery_state(&n.id, "accepted", None, now).unwrap();
    drop(db);
    let conn = rusqlite::Connection::open(&path).unwrap();
    conn.execute("UPDATE tasks SET data=json_set(data,'$.calendarProgress.timezoneVersion','old') WHERE id=?1",[&task.id]).unwrap();
    conn.execute(
        "UPDATE calendar_reminders SET fire_at=fire_at+3600000 WHERE state='pending'",
        [],
    )
    .unwrap();
    drop(conn);
    let mut db = Store::open(&path).unwrap();
    db.refresh_calendar_timezones(now).unwrap();
    assert!(db.claim_due(now, "boot").unwrap().is_none());
    assert!(db
        .claim_due(at("2026-01-30T01:00:00Z"), "boot")
        .unwrap()
        .is_some());
}
