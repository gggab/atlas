use std::path::Path;
use std::time::Duration;

use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{de::DeserializeOwned, Serialize};

use super::model::*;

pub struct Store {
    db: Connection,
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
    tx.execute("UPDATE notification_outbox SET native_state='suppressed' WHERE task_id=?1 AND native_state NOT IN ('accepted','suppressed')",[id])?;
    Ok(())
}

impl Store {
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
            version <= 1,
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
    pub fn notifications(&self) -> Result<Vec<TaskNotification>> {
        let mut q=self.db.prepare("SELECT data FROM notification_outbox WHERE native_state!='suppressed' AND COALESCE(json_extract(data,'$.dismissed'),0)=0 ORDER BY created_at DESC,rowid DESC LIMIT 200")?;
        let rows = q.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| decode(r?)).collect()
    }
    pub fn upsert(&mut self, input: TaskInput, now: i64) -> Result<Task> {
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
        let tx = self.db.transaction()?;
        if input.id.is_none() {
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
            input.due_at > now,
            "dueAt must be a future UTC timestamp in milliseconds"
        );
        let mut task = if let Some(id) = &input.id {
            let t = load_task(&tx, id)?;
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
            }
        };
        invalidate(&tx, &task.id, now)?;
        task.revision += 1;
        task.next_check_at = Some(input.due_at);
        task.input = input;
        task.state = TaskState::Active;
        task.reason = None;
        task.updated_at = now;
        tx.execute("INSERT INTO tasks(id,scope_key,creation_key,state,revision,next_check_at,data) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET state=excluded.state,revision=excluded.revision,next_check_at=excluded.next_check_at,data=excluded.data",params![task.id,task.input.scope_key,task.input.idempotency_key,token(&task.state)?,i64::try_from(task.revision)?,task.next_check_at,json(&task)?])?;
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
                let due = at.or(t.next_check_at).unwrap_or(t.input.due_at);
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
    pub fn claim_due(&mut self, now: i64, boot: &str) -> Result<Option<Run>> {
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let data:Option<String>=tx.query_row("SELECT t.data FROM tasks t WHERE t.state='active' AND t.next_check_at<=?1 AND NOT EXISTS(SELECT 1 FROM runs r WHERE r.task_id=t.id AND r.state IN ('claimed','dispatching')) ORDER BY t.next_check_at,t.rowid LIMIT 1",[now],|r|r.get(0)).optional()?;
        let Some(data) = data else { return Ok(None) };
        let mut t: Task = decode(data)?;
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
        ensure!(
            t.input.kind == TaskKind::Reminder && r.state == RunState::Claimed,
            "not a pending reminder"
        );
        r.state = RunState::Succeeded;
        r.ended_at = Some(now);
        t.state = TaskState::WaitingInput;
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
        let data:Option<String>=self.db.query_row("SELECT n.data FROM notification_outbox n JOIN tasks t ON t.id=n.task_id AND t.revision=n.revision WHERE n.native_state IN ('pending','failed','unknown') AND n.next_attempt_at<=?1 AND t.state NOT IN ('paused','cancelled') ORDER BY n.created_at LIMIT 1",[now],|r|r.get(0)).optional()?;
        data.map(decode).transpose()
    }
    pub fn delivery_state(
        &mut self,
        id: &str,
        state: &str,
        error: Option<String>,
        now: i64,
    ) -> Result<()> {
        let text: String = self.db.query_row(
            "SELECT data FROM notification_outbox WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
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
        let text: String = self.db.query_row(
            "SELECT data FROM notification_outbox WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
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
