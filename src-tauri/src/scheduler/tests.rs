use super::model::*;
use super::store::Store;

fn input(key: &str, kind: TaskKind) -> TaskInput {
    TaskInput {
        id: None,
        expected_revision: None,
        idempotency_key: key.into(),
        title: "Pay the bill".into(),
        prompt: "Remind me to confirm payment".into(),
        kind,
        due_at: 2_000,
        calendar: None,
        interval_minutes: None,
        scope_key: "personal".into(),
        source_thread_id: Some("source-thread".into()),
        execution_thread_id: (kind == TaskKind::AgentCheck).then(|| "execution-thread".into()),
        cwd: (kind == TaskKind::AgentCheck).then(|| "test-directory".into()),
        agent: (kind == TaskKind::AgentCheck).then(|| "test-agent".into()),
        max_runs: 10,
        timeout_seconds: 300,
        quiet_hours: None,
    }
}

#[test]
fn interval_reminders_survive_restart_skip_missed_ticks_and_stop_explicitly() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scheduler.sqlite");
    let mut store = Store::open(&path).unwrap();
    let mut request = input("every-five-minutes", TaskKind::Reminder);
    request.interval_minutes = Some(5);
    let task = store.upsert(request, 1_000).unwrap();
    let run = store.claim_due(2_000, "boot-1").unwrap().unwrap();
    store.finish_reminder(&run.id, 2_005).unwrap();
    assert_eq!(store.get(&task.id).unwrap().next_check_at, Some(302_000));
    assert_eq!(store.get(&task.id).unwrap().state, TaskState::Active);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    let run = store.claim_due(1_000_000, "boot-2").unwrap().unwrap();
    store.finish_reminder(&run.id, 1_000_000).unwrap();
    assert_eq!(store.get(&task.id).unwrap().next_check_at, Some(1_202_000));
    assert!(store.claim_due(1_000_000, "boot-2").unwrap().is_none());
    let current = store.get(&task.id).unwrap();
    let paused = store
        .control(
            &task.id,
            current.revision,
            TaskAction::Pause,
            None,
            1_000_001,
        )
        .unwrap();
    assert!(store.claim_due(2_000_000, "boot-2").unwrap().is_none());
    let resumed = store
        .control(
            &task.id,
            paused.revision,
            TaskAction::Resume,
            None,
            2_000_000,
        )
        .unwrap();
    assert_eq!(resumed.next_check_at, Some(2_300_000));
    let ended = store
        .control(
            &task.id,
            resumed.revision,
            TaskAction::Complete,
            None,
            2_000_001,
        )
        .unwrap();
    assert_eq!(ended.state, TaskState::Completed);
    assert!(store.claim_due(3_000_000, "boot-2").unwrap().is_none());
}

#[test]
fn interval_reminders_validate_the_kind_and_keep_only_the_latest_unsent_tick() {
    let mut store = Store::memory();
    for minutes in [0, 1441] {
        let mut request = input("invalid-interval", TaskKind::Reminder);
        request.interval_minutes = Some(minutes);
        assert!(store.upsert(request, 1_000).is_err());
    }
    let mut agent = input("invalid-agent-interval", TaskKind::AgentCheck);
    agent.interval_minutes = Some(5);
    assert!(store.upsert(agent, 1_000).is_err());
    let mut request = input("latest-tick", TaskKind::Reminder);
    request.interval_minutes = Some(5);
    store.upsert(request, 1_000).unwrap();
    let first = store.claim_due(2_000, "boot").unwrap().unwrap();
    store.finish_reminder(&first.id, 2_000).unwrap();
    let second = store.claim_due(302_000, "boot").unwrap().unwrap();
    store.finish_reminder(&second.id, 302_000).unwrap();
    let notifications = store.notifications().unwrap();
    assert_eq!(notifications.len(), 1);
    assert_eq!(notifications[0].run_id, second.id);
    store
        .delivery_state(&notifications[0].id, "accepted", None, 302_001)
        .unwrap();
    for tick in 2..=12 {
        let now = 2_000 + tick * 300_000;
        let run = store.claim_due(now, "boot").unwrap().unwrap();
        store.finish_reminder(&run.id, now).unwrap();
    }
    let notifications = store.notifications().unwrap();
    assert_eq!(notifications.len(), 2);
    assert!(notifications
        .iter()
        .any(|n| n.run_id == second.id && n.native_state == "accepted"));
}

#[test]
fn registration_is_durable_idempotent_and_revision_checked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scheduler.sqlite");
    let mut store = Store::open(&path).unwrap();
    let request = input("receipt-1", TaskKind::Reminder);
    let task = store.upsert(request.clone(), 1_000).unwrap();
    assert_eq!(store.upsert(request, 1_000).unwrap().id, task.id);
    drop(store);
    let mut store = Store::open(&path).unwrap();
    assert_eq!(store.list(None).unwrap()[0].id, task.id);
    assert!(store
        .control(&task.id, 99, TaskAction::Cancel, None, 1_500)
        .is_err());
    assert_eq!(store.get(&task.id).unwrap().state, TaskState::Active);
}

#[test]
fn claim_is_once_and_does_not_publish_a_notification() {
    let mut store = Store::memory();
    let task = store
        .upsert(input("claim", TaskKind::Reminder), 1_000)
        .unwrap();
    assert!(store.claim_due(1_999, "boot").unwrap().is_none());
    let run = store.claim_due(2_000, "boot").unwrap().unwrap();
    assert_eq!(run.task_id, task.id);
    assert!(store.claim_due(2_000, "boot").unwrap().is_none());
    assert!(store.notifications().unwrap().is_empty());
    store.finish_reminder(&run.id, 2_000).unwrap();
    assert_eq!(store.notifications().unwrap().len(), 1);
    assert_eq!(store.get(&task.id).unwrap().state, TaskState::WaitingInput);
    assert!(store.finish_reminder(&run.id, 2_001).is_err());
}

#[test]
fn pause_and_cancel_fence_claimed_work_and_outbox() {
    let mut store = Store::memory();
    let task = store
        .upsert(input("pause", TaskKind::Reminder), 1_000)
        .unwrap();
    let run = store.claim_due(2_000, "boot").unwrap().unwrap();
    let paused = store
        .control(&task.id, task.revision, TaskAction::Pause, None, 2_001)
        .unwrap();
    assert!(store.finish_reminder(&run.id, 2_002).is_err());
    assert!(store.notifications().unwrap().is_empty());
    store
        .control(
            &task.id,
            paused.revision,
            TaskAction::Snooze,
            Some(3_000),
            2_002,
        )
        .unwrap();
    let next = store.claim_due(3_000, "boot").unwrap().unwrap();
    store.finish_reminder(&next.id, 3_000).unwrap();
    let current = store.get(&task.id).unwrap();
    store
        .control(&task.id, current.revision, TaskAction::Cancel, None, 3_001)
        .unwrap();
    assert!(store.pending_delivery(3_001).unwrap().is_none());
}

#[test]
fn reports_require_the_owned_run_and_successful_terminal_result() {
    let mut store = Store::memory();
    let task = store
        .upsert(input("agent", TaskKind::AgentCheck), 1_000)
        .unwrap();
    let run = store.claim_due(2_000, "boot").unwrap().unwrap();
    store.dispatch(&run.id, "session", 3, 2_000).unwrap();
    let report = RunReport {
        done: false,
        waiting_input: false,
        next_check_at: Some(40_000),
        notify: true,
        body: Some("Update".into()),
    };
    assert!(store
        .report(&run.id, "other-session", report.clone(), 2_001)
        .is_err());
    store.report(&run.id, "session", report, 2_001).unwrap();
    assert!(store.notifications().unwrap().is_empty());
    store
        .finish_agent(&run.id, false, "cancelled", 2_002)
        .unwrap();
    let current = store.get(&task.id).unwrap();
    assert_eq!(current.state, TaskState::Blocked);
    assert!(current.next_check_at.is_none());
    assert!(!store
        .notifications()
        .unwrap()
        .iter()
        .any(|n| n.body == "Update"));
}

#[test]
fn successful_report_schedules_next_check_in_the_same_app_boot() {
    let mut store = Store::memory();
    store
        .upsert(input("repeat", TaskKind::AgentCheck), 1_000)
        .unwrap();
    let run = store.claim_due(2_000, "boot").unwrap().unwrap();
    store.dispatch(&run.id, "session", 7, 2_000).unwrap();
    store
        .report(
            &run.id,
            "session",
            RunReport {
                done: false,
                waiting_input: false,
                next_check_at: Some(40_000),
                notify: false,
                body: None,
            },
            2_001,
        )
        .unwrap();
    store
        .finish_agent(&run.id, true, "end_turn", 2_002)
        .unwrap();
    assert!(store.notifications().unwrap().is_empty());
    assert!(store.claim_due(40_000, "boot").unwrap().is_some());
}

#[test]
fn restart_reclaims_undispatched_work_but_never_replays_dispatched_work() {
    let mut store = Store::memory();
    let first = store
        .upsert(input("before-dispatch", TaskKind::AgentCheck), 1_000)
        .unwrap();
    store.claim_due(2_000, "old-boot").unwrap().unwrap();
    store.recover(2_001).unwrap();
    let run = store.claim_due(2_001, "new-boot").unwrap().unwrap();
    assert_eq!(run.task_id, first.id);
    store.dispatch(&run.id, "session", 1, 2_001).unwrap();
    store.recover(2_002).unwrap();
    assert_eq!(store.get(&first.id).unwrap().state, TaskState::Blocked);
    assert!(store.claim_due(3_000, "third-boot").unwrap().is_none());
    assert_eq!(store.runs(&first.id).unwrap()[0].state, RunState::Unknown);
}

#[test]
fn fixed_reminder_is_independent_of_source_and_execution_conversations() {
    let mut store = Store::memory();
    let mut request = input("independent", TaskKind::Reminder);
    request.execution_thread_id = None;
    let task = store.upsert(request, 1_000).unwrap();
    // No thread lookup or archive state participates in the durable due query.
    let run = store.claim_due(9_000, "boot").unwrap().unwrap();
    store.finish_reminder(&run.id, 9_000).unwrap();
    assert_eq!(store.notifications().unwrap()[0].task_id, task.id);
    assert_eq!(store.get(&task.id).unwrap().state, TaskState::WaitingInput);
}

#[test]
fn local_quiet_hours_cross_midnight_and_end_at_the_configured_minute() {
    let quiet = QuietHours {
        start_minute: 1320,
        end_minute: 480,
    };
    assert!(quiet.contains(1320));
    assert!(quiet.contains(0));
    assert!(quiet.contains(479));
    assert!(!quiet.contains(480));
    assert!(!quiet.contains(1000));
}

#[test]
fn notification_read_and_dismiss_do_not_complete_the_business_task() {
    let mut store = Store::memory();
    let task = store
        .upsert(input("dismiss", TaskKind::Reminder), 1_000)
        .unwrap();
    let run = store.claim_due(2_000, "boot").unwrap().unwrap();
    store.finish_reminder(&run.id, 2_000).unwrap();
    let n = store.notifications().unwrap()[0].clone();
    store.mark_read(&n.id, true).unwrap();
    assert!(store.notifications().unwrap().is_empty());
    assert_eq!(store.get(&task.id).unwrap().state, TaskState::WaitingInput);
}

#[test]
fn ambiguous_native_delivery_recovers_with_the_same_notification_identity() {
    let mut store = Store::memory();
    store
        .upsert(input("delivery", TaskKind::Reminder), 1_000)
        .unwrap();
    let run = store.claim_due(2_000, "boot").unwrap().unwrap();
    store.finish_reminder(&run.id, 2_000).unwrap();
    let n = store.pending_delivery(2_000).unwrap().unwrap();
    store
        .delivery_state(&n.id, "submitting", None, 2_001)
        .unwrap();
    store.recover(2_002).unwrap();
    let retry = store.pending_delivery(70_000).unwrap().unwrap();
    assert_eq!(retry.id, n.id);
    assert_eq!(retry.native_state, "unknown");
}
