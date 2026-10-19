use std::path::Path;
use std::time::Duration;

use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};

use super::model::*;
#[path = "calendar_store.rs"]
mod calendar_store;

pub struct Store {
    db: Connection,
}
fn creation_hash(scope: &str, key: &str) -> Result<String> {
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(scope, key))?)
    ))
}
fn ensure_no_live_runs(db: &Connection, task: &str, active_runs: &[String]) -> Result<()> {
    for run in active_runs {
        let exists: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM runs WHERE id=?1 AND task_id=?2)",
            params![run, task],
            |r| r.get(0),
        )?;
        ensure!(
            !exists,
            "A previous execution is still finishing; retry afterwards"
        );
    }
    Ok(())
}
fn decode<T: DeserializeOwned>(text: String) -> Result<T> {
    Ok(serde_json::from_str(&text)?)
}
fn json(value: &impl Serialize) -> Result<String> {
    Ok(serde_json::to_string(value)?)
}
fn token(value: &impl Serialize) -> Result<String> {
    Ok(serde_json::to_value(value)?
        .as_str()
        .context("expected state token")?
        .into())
}
fn load_task(db: &Connection, id: &str) -> Result<Task> {
    decode(
        db.query_row("SELECT data FROM tasks WHERE id=?1", [id], |r| r.get(0))
            .context("task not found")?,
    )
}
fn load_run(db: &Connection, id: &str) -> Result<Run> {
    decode(
        db.query_row("SELECT data FROM runs WHERE id=?1", [id], |r| r.get(0))
            .context("run not found")?,
    )
}
fn save_task(db: &Connection, t: &Task) -> Result<()> {
    db.execute(
        "UPDATE tasks SET state=?2,revision=?3,next_check_at=?4,data=?5 WHERE id=?1",
        params![
            t.id,
            token(&t.state)?,
            i64::try_from(t.revision)?,
            t.next_check_at,
            json(t)?
        ],
    )?;
    Ok(())
}
fn save_run(db: &Connection, r: &Run) -> Result<()> {
    db.execute(
        "UPDATE runs SET state=?2,data=?3 WHERE id=?1",
        params![r.id, token(&r.state)?, json(r)?],
    )?;
    Ok(())
}
fn valid_run(db: &Connection, id: &str) -> Result<(Run, Task)> {
    let run = load_run(db, id)?;
    let task = load_task(db, &run.task_id)?;
    ensure!(
        matches!(run.state, RunState::Claimed | RunState::Dispatching),
        "run is no longer active"
    );
    ensure!(
        task.state == TaskState::Active && task.revision == run.revision,
        "task changed or is no longer active"
    );
    Ok((run, task))
}
fn notify(
    db: &Connection,
    t: &Task,
    r: &Run,
    body: String,
    attention: bool,
    now: i64,
) -> Result<()> {
    let n = TaskNotification {
        id: format!("task-run:{}", r.id),
        task_id: t.id.clone(),
        run_id: r.id.clone(),
        revision: t.revision,
        title: t.input.title.clone(),
        body,
        attention,
        created_at: now,
        native_state: "pending".into(),
        native_error: None,
        attempts: 0,
        next_attempt_at: now,
        read: false,
        dismissed: false,
        calendar: r.calendar,
    };
    db.execute("INSERT INTO notification_outbox(id,task_id,revision,created_at,native_state,next_attempt_at,data) VALUES(?1,?2,?3,?4,'pending',?4,?5)",params![n.id,n.task_id,i64::try_from(n.revision)?,now,json(&n)?])?;
    Ok(())
}
fn block(
    tx: &Transaction<'_>,
    t: &mut Task,
    r: &mut Run,
    state: RunState,
    reason: &str,
    now: i64,
) -> Result<()> {
    let reason: String = reason.chars().take(2000).collect();
    r.state = state;
    r.reason = Some(reason.clone());
    r.ended_at = Some(now);
    t.state = TaskState::Blocked;
    t.next_check_at = None;
    t.reason = Some(reason.clone());
    t.updated_at = now;
    notify(tx, t, r, reason, true, now)
}
fn invalidate(tx: &Transaction<'_>, id: &str, now: i64) -> Result<()> {
    let mut q = tx
        .prepare("SELECT data FROM runs WHERE task_id=?1 AND state IN ('claimed','dispatching')")?;
    let rows = q
        .query_map([id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for data in rows {
        let mut r: Run = decode(data)?;
        r.state = RunState::Cancelled;
        r.reason = Some("task_changed".into());
        r.ended_at = Some(now);
        save_run(tx, &r)?;
    }
    tx.execute("UPDATE notification_outbox SET native_state='suppressed' WHERE task_id=?1 AND native_state NOT IN ('accepted','suppressed','muted','exhausted')",[id])?;
    Ok(())
}

impl Store {
    pub fn change_count(&self) -> u64 {
        self.db.total_changes()
    }
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(p) = path.parent() {
            std::fs::create_dir_all(p)?;
        }
        Self::initialize(Connection::open(path)?)
    }
    #[cfg(test)]
    pub fn memory() -> Self {
        Self::initialize(Connection::open_in_memory().unwrap()).unwrap()
    }
    fn initialize(db: Connection) -> Result<Self> {
        db.busy_timeout(Duration::from_secs(5))?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;")?;
        let version: u32 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        ensure!(
            version <= 3,
            "scheduler database schema is newer than this app"
        );
        if version == 0 {
            db.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE tasks(id TEXT PRIMARY KEY,scope_key TEXT NOT NULL,creation_key TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,next_check_at INTEGER,data TEXT NOT NULL,UNIQUE(scope_key,creation_key));
            CREATE INDEX tasks_due ON tasks(state,next_check_at);
            CREATE INDEX tasks_scope_due ON tasks(scope_key,state,next_check_at);
            CREATE TABLE runs(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),state TEXT NOT NULL,started_at INTEGER NOT NULL,data TEXT NOT NULL);
            CREATE UNIQUE INDEX runs_active_task ON runs(task_id) WHERE state IN ('claimed','dispatching');
            CREATE INDEX runs_task ON runs(task_id,started_at DESC);
            CREATE INDEX runs_session ON runs(json_extract(data,'$.sessionId'));
            CREATE TABLE notification_outbox(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),revision INTEGER NOT NULL,created_at INTEGER NOT NULL,native_state TEXT NOT NULL,next_attempt_at INTEGER NOT NULL,data TEXT NOT NULL);
            CREATE INDEX notification_due ON notification_outbox(native_state,next_attempt_at);
            PRAGMA user_version=1; COMMIT;")?;
        }
        if version < 2 {
            db.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE calendar_occurrences(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id),period_index INTEGER NOT NULL,state TEXT NOT NULL,due_at INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(task_id,period_index));
            CREATE INDEX calendar_periods ON calendar_occurrences(task_id,period_index DESC);
            CREATE TABLE calendar_reminders(id TEXT PRIMARY KEY,occurrence_id TEXT NOT NULL REFERENCES calendar_occurrences(id),task_id TEXT NOT NULL REFERENCES tasks(id),state TEXT NOT NULL,fire_at INTEGER NOT NULL,nominal_local TEXT,timezone TEXT,run_id TEXT);
            CREATE INDEX calendar_reminders_due ON calendar_reminders(task_id,state,fire_at);
            CREATE INDEX calendar_reminders_run ON calendar_reminders(run_id,state);
            PRAGMA user_version=2; COMMIT;")?;
        }
        if version < 3 {
            db.execute_batch("BEGIN IMMEDIATE;
            CREATE TABLE deleted_task_keys(task_id TEXT PRIMARY KEY,creation_hash TEXT NOT NULL UNIQUE);
            PRAGMA user_version=3; COMMIT;")?;
        }
        Ok(Self { db })
    }
    pub fn get(&self, id: &str) -> Result<Task> {
        load_task(&self.db, id)
    }
    pub fn list(&self, scope: Option<&str>) -> Result<Vec<Task>> {
        let mut q=self.db.prepare("SELECT data FROM tasks WHERE (?1 IS NULL OR scope_key=?1) ORDER BY rowid DESC LIMIT 500")?;
        let rows = q.query_map([scope], |r| r.get::<_, String>(0))?;
        rows.map(|r| decode(r?)).collect()
    }
    pub fn runs(&self, id: &str) -> Result<Vec<Run>> {
        let mut q = self
            .db
            .prepare("SELECT data FROM runs WHERE task_id=?1 ORDER BY rowid DESC LIMIT 50")?;
        let rows = q.query_map([id], |r| r.get::<_, String>(0))?;
        rows.map(|r| decode(r?)).collect()
    }

    pub fn task_for_run(&self, id: &str) -> Result<Task> {
        self.get(&load_run(&self.db, id)?.task_id)
    }
    pub fn notifications(&self) -> Result<Vec<TaskNotification>> {
        let mut q=self.db.prepare("SELECT data FROM notification_outbox WHERE native_state!='suppressed' AND COALESCE(json_extract(data,'$.dismissed'),0)=0 ORDER BY created_at DESC,rowid DESC LIMIT 200")?;
        let rows = q.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| decode(r?)).collect()
    }
    pub fn upsert(&mut self, input: TaskInput, now: i64) -> Result<Task> {
        if input.id.is_some() && input.calendar.is_some() {
            self.prepare_calendars(now)?;
        }
        ensure!(
            !input.title.trim().is_empty() && input.title.len() <= 256,
            "title must contain 1–256 bytes"
        );
        ensure!(
            !input.prompt.trim().is_empty() && input.prompt.len() <= 16_000,
            "task content must contain 1–16000 bytes"
        );
        ensure!(
            !input.idempotency_key.is_empty() && input.idempotency_key.len() <= 128,
            "invalid idempotency key"
        );
        ensure!(
            !input.scope_key.is_empty() && input.scope_key.len() <= 4096,
            "invalid scope"
        );
        ensure!(
            (1..=100).contains(&input.max_runs) && (30..=3600).contains(&input.timeout_seconds),
            "invalid execution budget"
        );
        ensure!(
            input
                .quiet_hours
                .as_ref()
                .is_none_or(|q| q.start_minute < 1440
                    && q.end_minute < 1440
                    && q.start_minute != q.end_minute),
            "invalid local quiet hours"
        );
        if input.kind == TaskKind::AgentCheck {
            ensure!(
                [&input.execution_thread_id, &input.cwd, &input.agent]
                    .iter()
                    .all(|v| v.as_ref().is_some_and(|s| !s.is_empty() && s.len() <= 4096)),
                "Agent checks require a trusted thread, cwd and installed Agent"
            );
        }
        if let Some(minutes) = input.interval_minutes {
            ensure!(
                (1..=1440).contains(&minutes),
                "intervalMinutes must be between 1 and 1440"
            );
            ensure!(
                input.kind == TaskKind::Reminder && input.calendar.is_none(),
                "minute intervals require a fixed reminder without calendar rules"
            );
        }
        let tx = self.db.transaction()?;
        if input.id.is_none() {
            let deleted: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM deleted_task_keys WHERE creation_hash=?1)",
                [creation_hash(&input.scope_key, &input.idempotency_key)?],
                |r| r.get(0),
            )?;
            ensure!(
                !deleted,
                "This task was deleted; an intentional new task needs a new creation key"
            );
            let existing: Option<String> = tx
                .query_row(
                    "SELECT data FROM tasks WHERE scope_key=?1 AND creation_key=?2",
                    params![input.scope_key, input.idempotency_key],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some(data) = existing {
                let task: Task = decode(data)?;
                ensure!(
                    task.input == input,
                    "idempotency key already refers to another request"
                );
                return Ok(task);
            }
            let count: u32 = tx.query_row(
                "SELECT count(*) FROM tasks WHERE state NOT IN ('completed','cancelled')",
                [],
                |r| r.get(0),
            )?;
            ensure!(count < 500, "active task limit reached");
        }
        ensure!(
            input.calendar.is_some() || input.due_at > now,
            "dueAt must be a future UTC timestamp in milliseconds"
        );
        let mut task = if let Some(id) = &input.id {
            let t = load_task(&tx, id)?;
            ensure!(
                !matches!(t.state, TaskState::Completed | TaskState::Cancelled),
                "Use explicit re-enable for an ended task"
            );
            ensure!(
                input.expected_revision == Some(t.revision),
                "task revision conflict; inspect again"
            );
            ensure!(
                t.input.scope_key == input.scope_key,
                "task scope cannot change"
            );
            t
        } else {
            Task {
                id: uuid::Uuid::new_v4().to_string(),
                revision: 0,
                input: input.clone(),
                state: TaskState::Active,
                next_check_at: None,
                reason: None,
                run_count: 0,
                created_at: now,
                updated_at: now,
                calendar_progress: None,
                calendar_issues: Vec::new(),
            }
        };
        if input.calendar.is_some() || task.input.calendar.is_some() {
            calendar_store::prepare_edit(&tx, &task, &input, now)?;
        }
        invalidate(&tx, &task.id, now)?;
        task.revision += 1;
        task.next_check_at = Some(input.due_at);
        task.input = input;
        task.state = TaskState::Active;
        task.reason = None;
        task.updated_at = now;
        calendar_store::configure(&tx, &mut task, now)?;
        tx.execute("INSERT INTO tasks(id,scope_key,creation_key,state,revision,next_check_at,data) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET state=excluded.state,revision=excluded.revision,next_check_at=excluded.next_check_at,data=excluded.data",params![task.id,task.input.scope_key,task.input.idempotency_key,token(&task.state)?,i64::try_from(task.revision)?,task.next_check_at,json(&task)?])?;
        if task.input.calendar.is_some() && task.state == TaskState::Active {
            calendar_store::materialize(&tx, &mut task, now)?;
            save_task(&tx, &task)?;
        }
        tx.commit()?;
        Ok(task)
    }
    pub fn control(
        &mut self,
        id: &str,
        revision: u64,
        action: TaskAction,
        at: Option<i64>,
        now: i64,
    ) -> Result<Task> {
        let tx = self.db.transaction()?;
        let mut t = load_task(&tx, id)?;
        ensure!(
            t.revision == revision,
            "task revision conflict; refresh before changing it"
        );
        ensure!(
            !matches!(t.state, TaskState::Completed | TaskState::Cancelled),
            "Use explicit re-enable for an ended task"
        );
        if t.input.calendar.is_some() {
            let task = calendar_store::control_series(&tx, t, action, now)?;
            tx.commit()?;
            return Ok(task);
        }
        if matches!(action, TaskAction::Resume | TaskAction::Snooze) {
            ensure!(
                !matches!(t.state, TaskState::Completed | TaskState::Cancelled),
                "completed/cancelled tasks cannot resume"
            );
        }
        match action {
            TaskAction::Pause => {
                t.state = TaskState::Paused;
                t.reason = Some("user_paused".into());
            }
            TaskAction::Cancel => {
                t.state = TaskState::Cancelled;
                t.next_check_at = None;
                t.reason = Some("user_cancelled".into());
            }
            TaskAction::Complete => {
                t.state = TaskState::Completed;
                t.next_check_at = None;
                t.reason = None;
            }
            TaskAction::Resume | TaskAction::Snooze => {
                let due = match (at, t.input.interval_minutes) {
                    (None, Some(minutes)) if t.next_check_at.is_none_or(|at| at <= now) => now
                        .checked_add(i64::from(minutes) * 60_000)
                        .context("next reminder time exceeds supported timestamp")?,
                    _ => at.or(t.next_check_at).unwrap_or(t.input.due_at),
                };
                ensure!(due > now, "choose a new future time for this expired task");
                t.next_check_at = Some(due);
                t.state = TaskState::Active;
                t.reason = None;
            }
        }
        t.revision += 1;
        t.updated_at = now;
        invalidate(&tx, id, now)?;
        save_task(&tx, &t)?;
        tx.commit()?;
        Ok(t)
    }
    pub fn reopen(
        &mut self,
        request: ReopenTask,
        active_runs: &[String],
        now: i64,
    ) -> Result<Task> {
        let tx = self.db.transaction()?;
        let mut task = load_task(&tx, &request.id)?;
        ensure!(
            task.revision == request.revision,
            "task revision conflict; refresh before changing it"
        );
        ensure!(
            matches!(task.state, TaskState::Completed | TaskState::Cancelled),
            "Only completed or cancelled tasks can be re-enabled"
        );
        ensure_no_live_runs(&tx, &task.id, active_runs)?;
        let count: u32 = tx.query_row(
            "SELECT count(*) FROM tasks WHERE state NOT IN ('completed','cancelled')",
            [],
            |r| r.get(0),
        )?;
        ensure!(count < 500, "active task limit reached");
        if let Some(max) = request.max_runs {
            ensure!(
                task.input.kind == TaskKind::AgentCheck && (1..=100).contains(&max),
                "invalid Agent execution limit"
            );
            task.input.max_runs = max;
        }
        ensure!(task.input.kind!=TaskKind::AgentCheck || task.run_count<task.input.max_runs,"Execution limit exhausted; explicitly increase the limit (up to 100) or create a new task");
        if task.input.calendar.is_some() {
            ensure!(
                request.at.is_none(),
                "Calendar reminders use their saved local rules"
            );
            calendar_store::reopen(&tx, &mut task, request.calendar, now)?;
        } else {
            ensure!(
                request.calendar.is_none(),
                "Re-enable preserves the task's schedule type"
            );
            let due = if let Some(minutes) = task.input.interval_minutes {
                ensure!(
                    request.at.is_none(),
                    "Interval reminders start a fresh countdown"
                );
                now.checked_add(i64::from(minutes) * 60_000)
                    .context("next reminder time exceeds supported timestamp")?
            } else {
                request
                    .at
                    .context("Choose a new future time to re-enable this task")?
            };
            ensure!(due > now, "Choose a future time to re-enable this task");
            task.state = TaskState::Active;
            task.next_check_at = Some(due);
        }
        invalidate(&tx, &task.id, now)?;
        task.revision += 1;
        if task.state != TaskState::NeedsConfirmation {
            task.reason = None;
        }
        task.updated_at = now;
        save_task(&tx, &task)?;
        if task.input.calendar.is_some() && task.state == TaskState::Active {
            calendar_store::materialize(&tx, &mut task, now)?;
            ensure!(task.state==TaskState::Active,"Re-enable needs an unhandled future period; extend or remove the calendar end date");
        }
        tx.commit()?;
        Ok(task)
    }

    pub fn delete(&mut self, id: &str, revision: u64, active_runs: &[String]) -> Result<()> {
        let tx = self.db.transaction()?;
        let deleted: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM deleted_task_keys WHERE task_id=?1)",
            [id],
            |r| r.get(0),
        )?;
        if deleted {
            return Ok(());
        }
        let task = load_task(&tx, id)?;
        ensure!(
            task.revision == revision,
            "task revision conflict; refresh before deleting it"
        );
        ensure!(
            matches!(task.state, TaskState::Completed | TaskState::Cancelled),
            "Only completed or cancelled tasks can be deleted"
        );
        ensure_no_live_runs(&tx, id, active_runs)?;
        tx.execute(
            "INSERT INTO deleted_task_keys(task_id,creation_hash) VALUES(?1,?2)",
            params![
                id,
                creation_hash(&task.input.scope_key, &task.input.idempotency_key)?
            ],
        )?;
        for table in [
            "calendar_reminders",
            "calendar_occurrences",
            "notification_outbox",
            "runs",
            "tasks",
        ] {
            let column = if table == "tasks" { "id" } else { "task_id" };
            tx.execute(&format!("DELETE FROM {table} WHERE {column}=?1"), [id])?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn claim_due(&mut self, now: i64, boot: &str) -> Result<Option<Run>> {
        self.prepare_calendars(now)?;
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let data:Option<String>=tx.query_row("SELECT t.data FROM tasks t WHERE t.state='active' AND t.next_check_at<=?1 AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.task_id=t.id AND r.state IN ('claimed','dispatching')) ORDER BY t.next_check_at,t.rowid LIMIT 1",[now],|r|r.get(0)).optional()?;
        let Some(data) = data else { return Ok(None) };
        let mut t: Task = decode(data)?;
        if t.input.calendar.is_some() {
            let run = calendar_store::claim(&tx, &mut t, now, boot)?;
            tx.commit()?;
            return Ok(run);
        }
        let run = Run {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: t.id.clone(),
            revision: t.revision,
            state: RunState::Claimed,
            boot_id: boot.into(),
            due_at: t.next_check_at.context("missing due time")?,
            started_at: now,
            ended_at: None,
            session_id: None,
            turn_seq: None,
            report: None,
            reason: None,
            calendar: false,
        };
        t.next_check_at = None;
        save_task(&tx, &t)?;
        tx.execute(
            "INSERT INTO runs(id,task_id,state,started_at,data) VALUES(?1,?2,'claimed',?3,?4)",
            params![run.id, run.task_id, now, json(&run)?],
        )?;
        tx.commit()?;
        Ok(Some(run))
    }
    pub fn defer(&mut self, id: &str, now: i64) -> Result<()> {
        let tx = self.db.transaction()?;
        let (mut r, mut t) = valid_run(&tx, id)?;
        ensure!(r.state == RunState::Claimed, "dispatched work cannot defer");
        r.state = RunState::Cancelled;
        r.reason = Some("session_busy".into());
        r.ended_at = Some(now);
        t.next_check_at = Some(now + 30_000);
        t.reason = Some("session_busy".into());
        save_run(&tx, &r)?;
        save_task(&tx, &t)?;
        tx.commit()?;
        Ok(())
    }
    pub fn dispatch(&mut self, id: &str, session: &str, seq: u64, now: i64) -> Result<()> {
        let tx = self.db.transaction()?;
        let (mut r, mut t) = valid_run(&tx, id)?;
        ensure!(r.state == RunState::Claimed, "already dispatched");
        ensure!(
            t.run_count < t.input.max_runs,
            "task execution budget exhausted"
        );
        t.run_count += 1;
        t.reason = None;
        t.updated_at = now;
        r.state = RunState::Dispatching;
        r.session_id = Some(session.into());
        r.turn_seq = Some(seq);
        save_task(&tx, &t)?;
        save_run(&tx, &r)?;
        tx.commit()?;
        Ok(())
    }
    pub fn report(&mut self, id: &str, session: &str, report: RunReport, now: i64) -> Result<()> {
        let tx = self.db.transaction()?;
        let (mut r, _) = valid_run(&tx, id)?;
        ensure!(
            r.state == RunState::Dispatching && r.session_id.as_deref() == Some(session),
            "report does not belong to this admitted run/session"
        );
        ensure!(
            (report.done as u8)
                + (report.waiting_input as u8)
                + (report.next_check_at.is_some() as u8)
                == 1,
            "choose exactly one of done, waitingInput or nextCheckAt"
        );
        ensure!(
            report.next_check_at.is_none_or(|t| t >= now + 30_000),
            "nextCheckAt must be at least 30 seconds in the future"
        );
        ensure!(
            report.body.as_ref().is_none_or(|s| s.len() <= 8000),
            "report body too large"
        );
        ensure!(
            !report.notify || report.body.as_ref().is_some_and(|s| !s.trim().is_empty()),
            "notification body required"
        );
        r.report = Some(report);
        save_run(&tx, &r)?;
        tx.commit()?;
        Ok(())
    }
    pub fn finish_reminder(&mut self, id: &str, now: i64) -> Result<()> {
        let tx = self.db.transaction()?;
        let (mut r, mut t) = valid_run(&tx, id)?;
        if r.calendar {
            calendar_store::settle(&tx, &mut t, &mut r, now)?;
            tx.commit()?;
            return Ok(());
        }
        ensure!(
            t.input.kind == TaskKind::Reminder && r.state == RunState::Claimed,
            "not a pending reminder"
        );
        r.state = RunState::Succeeded;
        r.ended_at = Some(now);
        t.state = TaskState::WaitingInput;
        if let Some(minutes) = t.input.interval_minutes {
            let interval = i128::from(minutes) * 60_000;
            let due = i128::from(r.due_at);
            let next = due + ((i128::from(now) - due).max(0) / interval + 1) * interval;
            t.next_check_at = Some(
                i64::try_from(next).context("next reminder time exceeds supported timestamp")?,
            );
            t.state = TaskState::Active;
            // Replace older unsent ticks so quiet hours or outages never produce a burst.
            tx.execute("UPDATE notification_outbox SET native_state='suppressed' WHERE task_id=?1 AND native_state IN ('pending','failed','unknown')", [&t.id])?;
        }
        t.updated_at = now;
        notify(&tx, &t, &r, t.input.prompt.clone(), false, now)?;
        save_run(&tx, &r)?;
        save_task(&tx, &t)?;
        tx.commit()?;
        Ok(())
    }
    pub fn finish_agent(&mut self, id: &str, success: bool, reason: &str, now: i64) -> Result<()> {
        let tx = self.db.transaction()?;
        let (mut r, mut t) = valid_run(&tx, id)?;
        ensure!(r.state == RunState::Dispatching, "run not dispatched");
        if success {
            if let Some(report) = r.report.clone() {
                ensure!(
                    report.next_check_at.is_none_or(|at| at > now),
                    "reported next check is already expired"
                );
                r.state = RunState::Succeeded;
                t.state = if report.done {
                    TaskState::Completed
                } else if report.waiting_input {
                    TaskState::WaitingInput
                } else {
                    TaskState::Active
                };
                t.next_check_at = report.next_check_at;
                if report.notify {
                    notify(
                        &tx,
                        &t,
                        &r,
                        report.body.context("missing report body")?,
                        false,
                        now,
                    )?;
                }
            } else {
                block(
                    &tx,
                    &mut t,
                    &mut r,
                    RunState::NeedsAttention,
                    "Agent ended without a valid structured report",
                    now,
                )?;
            }
        } else {
            block(&tx, &mut t, &mut r, RunState::Failed, reason, now)?;
        }
        r.ended_at = Some(now);
        t.updated_at = now;
        save_task(&tx, &t)?;
        save_run(&tx, &r)?;
        tx.commit()?;
        Ok(())
    }
    pub fn fail_before_dispatch(&mut self, id: &str, reason: &str, now: i64) -> Result<()> {
        let tx = self.db.transaction()?;
        let (mut r, mut t) = valid_run(&tx, id)?;
        ensure!(r.state == RunState::Claimed, "already dispatched");
        block(&tx, &mut t, &mut r, RunState::NeedsAttention, reason, now)?;
        save_task(&tx, &t)?;
        save_run(&tx, &r)?;
        tx.commit()?;
        Ok(())
    }
    pub fn fail_execution(&mut self, id: &str, reason: &str, now: i64) -> Result<()> {
        if load_run(&self.db, id)?.state == RunState::Dispatching {
            self.finish_agent(id, false, reason, now)
        } else {
            self.fail_before_dispatch(id, reason, now)
        }
    }
    pub fn recover(&mut self, now: i64) -> Result<()> {
        let mut q = self
            .db
            .prepare("SELECT id FROM runs WHERE state IN ('claimed','dispatching')")?;
        let ids = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(q);
        for id in ids {
            if load_run(&self.db, &id)?.calendar {
                self.finish_reminder(&id, now)?;
                continue;
            }
            let tx = self.db.transaction()?;
            let (mut r, mut t) = valid_run(&tx, &id)?;
            if r.state == RunState::Claimed {
                r.state = RunState::Cancelled;
                r.reason = Some("reclaimed_before_dispatch".into());
                r.ended_at = Some(now);
                t.next_check_at = Some(r.due_at);
            } else {
                block(&tx,&mut t,&mut r,RunState::Unknown,"Execution was interrupted; inspect it before resuming. It will not be replayed automatically.",now)?;
            }
            save_task(&tx, &t)?;
            save_run(&tx, &r)?;
            tx.commit()?;
        }
        let mut q = self
            .db
            .prepare("SELECT id FROM notification_outbox WHERE native_state='submitting'")?;
        let ids = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(q);
        for id in ids {
            self.delivery_state(
                &id,
                "unknown",
                Some("Delivery acknowledgement interrupted".into()),
                now,
            )?;
        }
        Ok(())
    }
    pub fn pending_delivery(&self, now: i64) -> Result<Option<TaskNotification>> {
        for _ in 0..20 {
            let data:Option<String>=self.db.query_row("SELECT n.data FROM notification_outbox n JOIN tasks t ON t.id=n.task_id AND t.revision=n.revision WHERE n.native_state IN ('pending','failed','unknown') AND n.next_attempt_at<=?1 AND t.state NOT IN ('paused','cancelled') ORDER BY n.created_at LIMIT 1",[now],|r|r.get(0)).optional()?;
            let Some(data) = data else { return Ok(None) };
            let n: TaskNotification = decode(data)?;
            let id = n.id.clone();
            if let Some(n) = self.delivery_notification(n)? {
                return Ok(Some(n));
            }
            self.db.execute(
                "UPDATE notification_outbox SET native_state='suppressed' WHERE id=?1",
                [id],
            )?;
        }
        Ok(None)
    }
    pub fn delivery_state(
        &mut self,
        id: &str,
        state: &str,
        error: Option<String>,
        now: i64,
    ) -> Result<()> {
        let text: Option<String> = self
            .db
            .query_row(
                "SELECT data FROM notification_outbox WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        // A queued delivery acknowledgement may arrive after explicit deletion.
        let Some(text) = text else {
            return Ok(());
        };
        let mut n: TaskNotification = decode(text)?;
        n.native_state = state.into();
        n.native_error = error;
        if state == "failed" {
            n.attempts += 1;
        }
        n.next_attempt_at = now + 60_000;
        if n.attempts >= 3 && state == "failed" {
            n.native_state = "exhausted".into();
        }
        self.db.execute(
            "UPDATE notification_outbox SET native_state=?2,next_attempt_at=?3,data=?4 WHERE id=?1",
            params![id, n.native_state, n.next_attempt_at, json(&n)?],
        )?;
        Ok(())
    }
    pub fn mark_read(&mut self, id: &str, dismissed: bool) -> Result<()> {
        let text: Option<String> = self
            .db
            .query_row(
                "SELECT data FROM notification_outbox WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        // Notification-list synchronization can race task deletion.
        let Some(text) = text else {
            return Ok(());
        };
        let mut n: TaskNotification = decode(text)?;
        n.read = true;
        n.dismissed |= dismissed;
        self.db.execute(
            "UPDATE notification_outbox SET data=?2 WHERE id=?1",
            params![id, json(&n)?],
        )?;
        Ok(())
    }
    pub fn next_wake(&self, now: i64) -> Result<i64> {
        let at: Option<i64> = self.db.query_row(
            "SELECT min(next_check_at) FROM tasks WHERE state='active'",
            [],
            |r| r.get(0),
        )?;
        Ok(at
            .unwrap_or(now + 30_000)
            .saturating_sub(now)
            .clamp(250, 30_000))
    }
    pub fn explains_activity(&self, session: &str, at: i64) -> Result<bool> {
        Ok(self.db.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE json_extract(data,'$.sessionId')=?1 AND json_extract(data,'$.startedAt')<=?2 AND (json_extract(data,'$.endedAt') IS NULL OR json_extract(data,'$.endedAt')+5000>=?2))",params![session,at],|r|r.get(0))?)
    }
}
