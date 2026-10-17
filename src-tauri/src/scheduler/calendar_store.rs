//! Calendar persistence shares the scheduler's single writer and transactions.
use super::*;
use crate::scheduler::calendar::{self, CalendarPreview, CalendarSpec};
use anyhow::bail;

fn save_occurrence(db: &Connection, o: &Occurrence) -> Result<()> {
    db.execute("INSERT INTO calendar_occurrences(id,task_id,period_index,state,due_at,data) VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(id) DO UPDATE SET state=excluded.state,due_at=excluded.due_at,data=excluded.data",params![o.id,o.task_id,i64::try_from(o.period_index)?,token(&o.state)?,o.due_at,json(o)?])?;
    Ok(())
}
fn occurrence(db: &Connection, id: &str) -> Result<Occurrence> {
    decode(
        db.query_row(
            "SELECT data FROM calendar_occurrences WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .context("period not found")?,
    )
}
fn next_wake(db: &Connection, t: &Task) -> Result<Option<i64>> {
    let pending: Option<i64> = db.query_row(
        "SELECT min(fire_at) FROM calendar_reminders WHERE task_id=?1 AND state='pending'",
        [&t.id],
        |r| r.get(0),
    )?;
    let progress = t
        .calendar_progress
        .as_ref()
        .context("missing calendar progress")?;
    let next = t
        .input
        .calendar
        .as_ref()
        .context("missing calendar")?
        .period(progress.cursor)?
        .and_then(|p| p.reminders.first().map(|r| r.at));
    Ok(pending.into_iter().chain(next).min())
}
fn rearm_unsubmitted(db: &Connection, id: &str) -> Result<()> {
    db.execute("UPDATE calendar_reminders SET state='pending',run_id=NULL WHERE task_id=?1 AND state IN ('claimed','queued') AND EXISTS(SELECT 1 FROM calendar_occurrences o WHERE o.id=occurrence_id AND o.state IN ('pending','elapsed')) AND NOT EXISTS(SELECT 1 FROM notification_outbox n WHERE n.id='task-run:'||run_id AND n.native_state IN ('accepted','muted','exhausted'))",[id])?;
    Ok(())
}
pub(super) fn prepare_edit(db: &Connection, old: &Task, input: &TaskInput, now: i64) -> Result<()> {
    if old.calendar_progress.is_some() {
        ensure!(
            !matches!(
                old.state,
                TaskState::Paused | TaskState::Cancelled | TaskState::Completed
            ),
            "Resume the calendar before editing; ended calendars require a new series"
        );
        let previous = old
            .input
            .calendar
            .as_ref()
            .context("missing previous calendar")?;
        let next = input.calendar.as_ref().context(
            "An activated calendar cannot become a one-shot; cancel it and create another task",
        )?;
        ensure!(previous.start_date == next.start_date && previous.frequency == next.frequency,"Activated calendars keep their anchor date and frequency; create a new series to change them");
        ensure!(calendar::preview(next,now)?.issues.is_empty(),"Resolve calendar questions before changing an active series; the current plan was not changed");
        ensure!(
            !old.calendar_progress
                .as_ref()
                .is_some_and(|p| p.cutoff.is_some() && !p.ready),
            "Calendar history is catching up; retry after the scheduler finishes"
        );
        let running: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE task_id=?1 AND state IN ('claimed','dispatching'))",[&old.id],|r|r.get(0))?;
        ensure!(
            !running,
            "A reminder is settling; retry the edit afterwards"
        );
        rearm_unsubmitted(db, &old.id)?;
        // Frozen periods keep their original snapshots; only untouched future periods rebuild.
        let mut q=db.prepare("SELECT data FROM calendar_occurrences WHERE task_id=?1 AND state='pending' AND due_at>?2 AND json_extract(data,'$.started')=0")?;
        let rows = q
            .query_map(params![old.id, now], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for text in rows {
            let mut o: Occurrence = decode(text)?;
            o.state = OccurrenceState::Superseded;
            o.revision += 1;
            save_occurrence(db, &o)?;
            db.execute("UPDATE calendar_reminders SET state='suppressed' WHERE occurrence_id=?1 AND state='pending'",[o.id])?;
        }
    }
    Ok(())
}
pub(super) fn configure(_db: &Connection, t: &mut Task, now: i64) -> Result<()> {
    let Some(spec) = &t.input.calendar else {
        return Ok(());
    };
    ensure!(t.input.kind==TaskKind::Reminder,"Calendar recurrence currently supports fixed reminders only; Agent checks use explicit nextCheckAt");
    t.calendar_issues = calendar::preview(spec, now)?.issues;
    if !t.calendar_issues.is_empty() {
        t.state = TaskState::NeedsConfirmation;
        t.next_check_at = None;
        t.reason = Some("请补充周期规则，计划尚未启用。".into());
        return Ok(());
    }
    let previous = t.calendar_progress.take();
    t.calendar_progress = Some(CalendarProgress {
        cursor: spec.first_index(now)?,
        activated_at: previous.as_ref().map_or(now, |p| p.activated_at),
        cutoff: None,
        ready: false,
        paused_at: None,
        pause_windows: previous.map_or_else(Vec::new, |p| p.pause_windows),
        timezone_version: chrono_tz::IANA_TZDB_VERSION.into(),
    });
    t.next_check_at = Some(now);
    Ok(())
}
pub(super) fn materialize(db: &Connection, t: &mut Task, now: i64) -> Result<()> {
    let spec = t
        .input
        .calendar
        .as_ref()
        .context("missing calendar")?
        .clone();
    let p = t
        .calendar_progress
        .as_mut()
        .context("missing calendar progress")?;
    if p.ready {
        return Ok(());
    }
    let cutoff = *p.cutoff.get_or_insert(now);
    for _ in 0..64 {
        let Some(plan) = spec.period(p.cursor)? else {
            p.ready = true;
            break;
        };
        p.cursor = plan.index + 1;
        let id = format!("{}:period:{}", t.id, plan.index);
        let existing: Option<String> = db
            .query_row(
                "SELECT data FROM calendar_occurrences WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        let old = existing.map(decode::<Occurrence>).transpose()?;
        if old
            .as_ref()
            .is_none_or(|o| o.state == OccurrenceState::Superseded)
        {
            let o = Occurrence {
                id: id.clone(),
                task_id: t.id.clone(),
                period_index: plan.index,
                revision: old.map_or(1, |o| o.revision + 1),
                local_date: plan.local_date.clone(),
                due_at: plan.due_at,
                state: if !spec.track_completion && plan.due_at <= cutoff {
                    OccurrenceState::Elapsed
                } else {
                    OccurrenceState::Pending
                },
                track_completion: spec.track_completion,
                started: false,
                timezone: spec.timezone.clone(),
                updated_at: now,
            };
            save_occurrence(db, &o)?;
            for reminder in &plan.reminders {
                let suppressed = reminder.at < p.activated_at
                    || p.pause_windows
                        .iter()
                        .any(|(from, to)| reminder.at >= *from && reminder.at < *to);
                let key = format!("{id}:lead:{}", reminder.lead_days);
                db.execute("INSERT INTO calendar_reminders(id,occurrence_id,task_id,state,fire_at,nominal_local,timezone) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET state=excluded.state,fire_at=excluded.fire_at,nominal_local=excluded.nominal_local,timezone=excluded.timezone,run_id=NULL",params![key,id,t.id,if suppressed{"suppressed"}else{"pending"},reminder.at,reminder.nominal_local,spec.timezone])?;
            }
        }
        if plan.reminders.first().is_some_and(|r| r.at > cutoff) {
            p.ready = true;
            break;
        }
    }
    if p.ready {
        p.pause_windows.retain(|(_, end)| *end > cutoff);
        let eligible:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM calendar_reminders WHERE task_id=?1 AND state='pending' AND fire_at<=?2)",params![t.id,cutoff],|r|r.get(0))?;
        if !eligible {
            p.cutoff = None;
            p.ready = false;
        }
        t.next_check_at = next_wake(db, t)?;
    } else {
        t.next_check_at = Some(now);
    }
    db.execute("UPDATE calendar_occurrences SET state='elapsed',data=json_set(data,'$.state','elapsed') WHERE task_id=?1 AND state='pending' AND due_at<=?2 AND json_extract(data,'$.trackCompletion')=0",params![t.id,now])?;
    if t.next_check_at.is_none() {
        let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM calendar_occurrences WHERE task_id=?1 AND state='pending')",[&t.id],|r|r.get(0))?;
        t.state = if pending {
            TaskState::WaitingInput
        } else {
            TaskState::Completed
        };
    }
    save_task(db, t)?;
    Ok(())
}
pub(super) fn claim(db: &Connection, t: &mut Task, now: i64, boot: &str) -> Result<Option<Run>> {
    let p = t
        .calendar_progress
        .as_mut()
        .context("missing calendar progress")?;
    if !p.ready {
        return Ok(None);
    }
    let cutoff = p.cutoff.context("missing catch-up cutoff")?;
    let run = Run {
        id: uuid::Uuid::new_v4().to_string(),
        task_id: t.id.clone(),
        revision: t.revision,
        state: RunState::Claimed,
        boot_id: boot.into(),
        due_at: cutoff,
        started_at: now,
        ended_at: None,
        session_id: None,
        turn_seq: None,
        report: None,
        reason: None,
        calendar: true,
    };
    let changed=db.execute("UPDATE calendar_reminders SET state='claimed',run_id=?3 WHERE task_id=?1 AND state='pending' AND fire_at<=?2",params![t.id,cutoff,run.id])?;
    p.cutoff = None;
    p.ready = false;
    t.next_check_at = next_wake(db, t)?;
    save_task(db, t)?;
    if changed == 0 {
        return Ok(None);
    }
    db.execute("UPDATE calendar_occurrences SET data=json_set(data,'$.started',json('true')) WHERE id IN (SELECT occurrence_id FROM calendar_reminders WHERE run_id=?1)",[&run.id])?;
    db.execute(
        "INSERT INTO runs(id,task_id,state,started_at,data) VALUES(?1,?2,'claimed',?3,?4)",
        params![run.id, run.task_id, now, json(&run)?],
    )?;
    Ok(Some(run))
}
fn digest(db: &Connection, t: &Task, run: &str) -> Result<Option<String>> {
    let count:u32=db.query_row("SELECT count(DISTINCT o.id) FROM calendar_occurrences o JOIN calendar_reminders r ON r.occurrence_id=o.id WHERE r.run_id=?1 AND r.state='queued' AND o.state IN ('pending','elapsed')",[run],|r|r.get(0))?;
    if count == 0 {
        return Ok(None);
    }
    let mut q=db.prepare("SELECT DISTINCT json_extract(o.data,'$.localDate') FROM calendar_occurrences o JOIN calendar_reminders r ON r.occurrence_id=o.id WHERE r.run_id=?1 AND r.state='queued' AND o.state IN ('pending','elapsed') ORDER BY o.due_at DESC LIMIT 3")?;
    let dates = q
        .query_map([run], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Some(format!(
        "{}\n涉及 {} 期：{}{}。请在任务中心查看；提醒不代表已经完成。",
        t.input.prompt,
        count,
        dates.join("、"),
        if count > 3 { " 等" } else { "" }
    )))
}
pub(super) fn settle(db: &Connection, t: &mut Task, r: &mut Run, now: i64) -> Result<()> {
    ensure!(
        r.state == RunState::Claimed,
        "calendar reminder already settled"
    );
    db.execute(
        "UPDATE calendar_reminders SET state='queued' WHERE run_id=?1 AND state='claimed'",
        [&r.id],
    )?;
    r.ended_at = Some(now);
    if let Some(body) = digest(db, t, &r.id)? {
        r.state = RunState::Succeeded;
        notify(db, t, r, body, false, now)?;
    } else {
        r.state = RunState::Cancelled;
    }
    db.execute("UPDATE calendar_occurrences SET state='elapsed',data=json_set(data,'$.state','elapsed') WHERE task_id=?1 AND state='pending' AND due_at<=?2 AND json_extract(data,'$.trackCompletion')=0",params![t.id,now])?;
    t.next_check_at = next_wake(db, t)?;
    if t.next_check_at.is_none() {
        let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM calendar_occurrences WHERE task_id=?1 AND state='pending')",[&t.id],|r|r.get(0))?;
        t.state = if pending {
            TaskState::WaitingInput
        } else {
            TaskState::Completed
        };
    }
    t.updated_at = now;
    save_run(db, r)?;
    save_task(db, t)?;
    Ok(())
}
pub(super) fn control_series(
    db: &Transaction<'_>,
    mut t: Task,
    action: TaskAction,
    now: i64,
) -> Result<Task> {
    if t.state == TaskState::NeedsConfirmation {
        ensure!(
            matches!(action, TaskAction::Cancel),
            "Resolve the calendar questions by editing the draft before enabling it"
        );
        t.state = TaskState::Cancelled;
        t.next_check_at = None;
        t.revision += 1;
        t.updated_at = now;
        t.reason = None;
        save_task(db, &t)?;
        return Ok(t);
    }
    ensure!(
        !matches!(t.state, TaskState::Completed | TaskState::Cancelled),
        "This calendar has ended"
    );
    let p = t
        .calendar_progress
        .as_mut()
        .context("missing calendar progress")?;
    match action {
        TaskAction::Complete | TaskAction::Snooze => {
            bail!("Complete or snooze a named period; use cancel to end the whole series")
        }
        TaskAction::Pause => {
            ensure!(t.state != TaskState::Paused, "Calendar is already paused");
            p.paused_at = Some(now);
            t.state = TaskState::Paused;
            t.next_check_at = None;
        }
        TaskAction::Cancel => {
            t.state = TaskState::Cancelled;
            t.next_check_at = None;
        }
        TaskAction::Resume => {
            ensure!(
                t.state == TaskState::Paused,
                "Only a paused calendar can resume"
            );
            let from = p.paused_at.take().context("missing pause start")?;
            rearm_unsubmitted(db, &t.id)?;
            p.pause_windows.push((from, now));
            p.cutoff = None;
            p.ready = false;
            db.execute("UPDATE calendar_reminders SET state='suppressed' WHERE task_id=?1 AND state='pending' AND fire_at>=?2 AND fire_at<?3",params![t.id,from,now])?;
            t.state = TaskState::Active;
            t.next_check_at = Some(now);
        }
    }
    t.revision += 1;
    t.updated_at = now;
    t.reason = None;
    invalidate(db, &t.id, now)?;
    save_task(db, &t)?;
    Ok(t)
}
impl Store {
    pub fn calendar_preview(
        &self,
        spec: CalendarSpec,
        id: Option<&str>,
        now: i64,
    ) -> Result<CalendarPreview> {
        let mut p = calendar::preview(&spec, now)?;
        if let Some(id) = id {
            let mut q=self.db.prepare("SELECT json_extract(data,'$.localDate') FROM calendar_occurrences WHERE task_id=?1 AND (due_at<=?2 OR json_extract(data,'$.started')=1 OR state IN ('completed','skipped')) ORDER BY period_index DESC LIMIT 20")?;
            p.frozen_periods = q
                .query_map(params![id, now], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            for plan in &mut p.periods {
                let key = format!("{id}:period:{}", plan.index);
                let existing: Option<String> = self
                    .db
                    .query_row(
                        "SELECT data FROM calendar_occurrences WHERE id=?1",
                        [&key],
                        |r| r.get(0),
                    )
                    .optional()?;
                if let Some(text) = existing {
                    let o: Occurrence = decode(text)?;
                    if o.started
                        || o.due_at <= now
                        || matches!(
                            o.state,
                            OccurrenceState::Completed | OccurrenceState::Skipped
                        )
                    {
                        plan.due_at = o.due_at;
                        plan.local_date = o.local_date;
                        plan.timezone = o.timezone;
                        let mut reminders=self.db.prepare("SELECT id,nominal_local,fire_at FROM calendar_reminders WHERE occurrence_id=?1 AND nominal_local IS NOT NULL AND state='pending' AND fire_at>?2 ORDER BY fire_at")?;
                        plan.reminders = reminders
                            .query_map(params![key, now], |r| {
                                Ok((
                                    r.get::<_, String>(0)?,
                                    r.get::<_, String>(1)?,
                                    r.get::<_, i64>(2)?,
                                ))
                            })?
                            .map(|row| {
                                let (key, local, at) = row?;
                                Ok(calendar::CalendarReminder {
                                    lead_days: key
                                        .rsplit(':')
                                        .next()
                                        .context("missing lead value")?
                                        .parse()?,
                                    nominal_local: local,
                                    at,
                                })
                            })
                            .collect::<Result<Vec<_>>>()?;
                    }
                }
            }
        }
        Ok(p)
    }
    pub fn occurrences(
        &self,
        id: &str,
        before: Option<u64>,
        limit: u32,
    ) -> Result<Vec<Occurrence>> {
        let mut q=self.db.prepare("SELECT data FROM calendar_occurrences WHERE task_id=?1 AND (?2 IS NULL OR period_index<?2) AND state!='superseded' ORDER BY period_index DESC LIMIT ?3")?;
        let rows = q.query_map(
            params![
                id,
                before.map(i64::try_from).transpose()?,
                limit.clamp(1, 100)
            ],
            |r| r.get::<_, String>(0),
        )?;
        rows.map(|r| decode(r?)).collect()
    }
    #[allow(clippy::too_many_arguments)]
    pub fn control_occurrence(
        &mut self,
        task_id: &str,
        task_revision: u64,
        id: &str,
        revision: u64,
        action: OccurrenceAction,
        at: Option<i64>,
        now: i64,
    ) -> Result<Occurrence> {
        let tx = self.db.transaction()?;
        let mut t = load_task(&tx, task_id)?;
        ensure!(
            t.revision == task_revision,
            "task revision conflict; refresh first"
        );
        let mut o = occurrence(&tx, id)?;
        ensure!(
            o.task_id == task_id && o.revision == revision,
            "period ownership or revision conflict; refresh first"
        );
        ensure!(
            o.state == OccurrenceState::Pending,
            "This period is no longer pending"
        );
        o.revision += 1;
        o.updated_at = now;
        match action {
            OccurrenceAction::Complete => o.state = OccurrenceState::Completed,
            OccurrenceAction::Skip => o.state = OccurrenceState::Skipped,
            OccurrenceAction::Snooze => {
                ensure!(
                    t.state == TaskState::Active || t.state == TaskState::WaitingInput,
                    "Resume the series before snoozing a period"
                );
                let at = at.context("snooze time required")?;
                ensure!(at > now, "choose a future snooze time");
                tx.execute("UPDATE calendar_reminders SET state='suppressed' WHERE occurrence_id=?1 AND state IN ('pending','claimed','queued') AND fire_at<=?2",params![id,at])?;
                tx.execute("INSERT INTO calendar_reminders(id,occurrence_id,task_id,state,fire_at) VALUES(?1,?2,?3,'pending',?4)",params![format!("{id}:snooze:{}",o.revision),id,task_id,at])?;
                t.state = TaskState::Active;
            }
        }
        if o.state != OccurrenceState::Pending {
            tx.execute("UPDATE calendar_reminders SET state='suppressed' WHERE occurrence_id=?1 AND state IN ('pending','claimed','queued')",[id])?;
        }
        save_occurrence(&tx, &o)?;
        if matches!(t.state, TaskState::Active | TaskState::WaitingInput) {
            t.next_check_at = next_wake(&tx, &t)?;
            if t.next_check_at.is_none() {
                let pending:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM calendar_occurrences WHERE task_id=?1 AND state='pending')",[task_id],|r|r.get(0))?;
                if !pending {
                    t.state = TaskState::Completed;
                }
            }
        }
        save_task(&tx, &t)?;
        tx.commit()?;
        Ok(o)
    }
    pub fn prepare_calendars(&mut self, now: i64) -> Result<()> {
        let mut q=self.db.prepare("SELECT data FROM tasks WHERE state='active' AND json_extract(data,'$.input.calendar') IS NOT NULL AND next_check_at<=?1 AND NOT EXISTS(SELECT 1 FROM runs WHERE task_id=tasks.id AND state IN ('claimed','dispatching')) ORDER BY next_check_at LIMIT 4")?;
        let tasks = q
            .query_map([now], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(q);
        for text in tasks {
            let tx = self.db.transaction()?;
            let mut t: Task = decode(text)?;
            materialize(&tx, &mut t, now)?;
            tx.commit()?;
        }
        Ok(())
    }
    pub fn delivery_notification(
        &self,
        mut n: TaskNotification,
    ) -> Result<Option<TaskNotification>> {
        let task = load_task(&self.db, &n.task_id)?;
        if task.revision != n.revision
            || matches!(
                task.state,
                TaskState::Paused | TaskState::Cancelled | TaskState::NeedsConfirmation
            )
        {
            return Ok(None);
        }
        if n.calendar {
            let Some(body) = digest(&self.db, &task, &n.run_id)? else {
                return Ok(None);
            };
            n.body = body;
        }
        Ok(Some(n))
    }
    pub fn refresh_calendar_timezones(&mut self, now: i64) -> Result<()> {
        let mut q = self.db.prepare(
            "SELECT data FROM tasks WHERE json_extract(data,'$.calendarProgress') IS NOT NULL",
        )?;
        let tasks = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(q);
        for text in tasks {
            let mut t: Task = decode(text)?;
            if t.calendar_progress
                .as_ref()
                .is_some_and(|p| p.timezone_version == chrono_tz::IANA_TZDB_VERSION)
            {
                continue;
            }
            let tx = self.db.transaction()?;
            let mut q=tx.prepare("SELECT id,nominal_local,timezone,occurrence_id FROM calendar_reminders WHERE task_id=?1 AND state='pending' AND fire_at>?2 AND nominal_local IS NOT NULL")?;
            let rows = q
                .query_map(params![t.id, now], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(q);
            for (id, local, zone, occurrence_id) in rows {
                let at = calendar::resolve_local(
                    zone.parse()?,
                    chrono::NaiveDateTime::parse_from_str(&local, "%Y-%m-%dT%H:%M")?,
                )?;
                tx.execute(
                    "UPDATE calendar_reminders SET fire_at=?2 WHERE id=?1",
                    params![id, at],
                )?;
                if id.ends_with(":lead:0") {
                    let mut o = occurrence(&tx, &occurrence_id)?;
                    if !o.started && o.due_at > now {
                        o.due_at = at;
                        save_occurrence(&tx, &o)?;
                    }
                }
            }
            if let Some(p) = &mut t.calendar_progress {
                p.timezone_version = chrono_tz::IANA_TZDB_VERSION.into();
            }
            if t.state == TaskState::Active {
                t.next_check_at = next_wake(&tx, &t)?;
            }
            save_task(&tx, &t)?;
            tx.commit()?;
        }
        Ok(())
    }
}
