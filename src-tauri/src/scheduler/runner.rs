use agent_client_protocol::schema::v1 as acp;
use chrono::Timelike;
use std::sync::{atomic::Ordering, Arc};
use std::time::Duration;
use tauri::Manager;

use super::{agent_tools_enabled, model::*, now, Scheduler};
use crate::commands::agent_host::AgentHost;

impl Scheduler {
    pub(super) async fn run(self: Arc<Self>) {
        let slots = Arc::new(tokio::sync::Semaphore::new(2));
        while !self.stopped.load(Ordering::Acquire) {
            for _ in 0..20 {
                if self.stopped.load(Ordering::Acquire) {
                    break;
                }
                let boot = self.boot.clone();
                let run = match self
                    .call(move |s| {
                        let before = s.change_count();
                        let run = s.claim_due(now(), &boot)?;
                        Ok((run, s.change_count() != before))
                    })
                    .await
                {
                    Ok((run, changed)) => {
                        if changed {
                            self.changed();
                        }
                        let Some(run) = run else { break };
                        run
                    }
                    Err(e) => {
                        tracing::error!("scheduler claim failed: {e}");
                        break;
                    }
                };
                let id = run.task_id.clone();
                let task = match self.call(move |s| s.get(&id)).await {
                    Ok(t) => t,
                    Err(e) => {
                        tracing::error!("claimed task unavailable: {e}");
                        continue;
                    }
                };
                if task.input.kind == TaskKind::Reminder {
                    let id = run.id.clone();
                    if let Err(e) = self.call(move |s| s.finish_reminder(&id, now())).await {
                        tracing::warn!("reminder settlement rejected: {e}");
                    }
                    self.changed();
                } else if let Ok(slot) = slots.clone().try_acquire_owned() {
                    let this = self.clone();
                    tauri::async_runtime::spawn(async move {
                        let _slot = slot;
                        this.execute(run, task).await;
                        this.changed();
                    });
                } else {
                    let id = run.id.clone();
                    if let Err(e) = self.call(move |s| s.defer(&id, now())).await {
                        tracing::warn!("cannot defer task: {e}");
                    }
                }
            }
            if let Err(e) = self.deliver().await {
                tracing::error!("task notification delivery failed: {e}");
            }
            let delay = self.call(|s| s.next_wake(now())).await.unwrap_or_else(|e| {
                tracing::error!("scheduler timer failed: {e}");
                30_000
            });
            tokio::select! {_=self.wake.notified()=>{},_=tokio::time::sleep(Duration::from_millis(delay as u64))=>{}}
        }
    }

    async fn execute(&self, run: Run, task: Task) {
        let result = self.dispatch_agent(&run, &task).await;
        if let Err(reason) = result {
            let id = run.id.clone();
            let reason = reason.clone();
            if let Err(e) = self
                .call(move |s| s.fail_execution(&id, &reason, now()))
                .await
            {
                tracing::warn!(run=%run.id,"task changed or could not record pre-dispatch failure: {e}");
            }
        }
    }

    async fn dispatch_agent(&self, run: &Run, task: &Task) -> Result<(), String> {
        if !agent_tools_enabled(&self.app) {
            return Err("Agent task tools are disabled; enable them in the task center".into());
        }
        if self.stopped.load(Ordering::Acquire) {
            return Err("Application is shutting down".into());
        }
        let host = self.app.state::<Arc<AgentHost>>().inner().clone();
        let input = task.input.clone();
        let checker = host.clone();
        let input =
            tauri::async_runtime::spawn_blocking(move || super::normalize_input(&checker, input))
                .await
                .map_err(|e| e.to_string())??;
        if input.cwd != task.input.cwd
            || input.agent != task.input.agent
            || input.scope_key != task.input.scope_key
        {
            return Err("Execution binding changed; review and rebind this task".into());
        }
        let thread_id = input
            .execution_thread_id
            .as_deref()
            .ok_or("missing execution thread")?
            .parse()
            .map_err(|_| "invalid execution thread")?;
        let thread = host
            .history()
            .and_then(|h| h.store().thread(thread_id))
            .ok_or("execution_context_deleted")?;
        let cwd = input
            .cwd
            .as_deref()
            .ok_or("missing execution directory")?
            .to_string();
        let modified = tauri::async_runtime::spawn_blocking(move || {
            use atlas_agent_transcript::discovery::{claude_sessions_dir, scan_sessions};
            claude_sessions_dir(std::path::Path::new(&cwd))
                .map(|dir| scan_sessions(&dir))
                .unwrap_or_default()
        })
        .await
        .map_err(|e| e.to_string())?;
        if let Some(session) = thread.session_id.as_ref() {
            let last = modified
                .iter()
                .find(|m| m.session_id == session.to_string())
                .map(|m| m.modified);
            if crate::commands::agent_host::live_elsewhere(
                last,
                host.atlas_activity().get(&session.to_string()),
                chrono::Utc::now(),
            ) {
                let id = run.id.clone();
                self.call(move |s| s.defer(&id, now())).await?;
                return Ok(());
            }
        }
        let restored = host
            .resume_thread_background(thread_id)
            .await
            .map_err(|e| e.to_string())?;
        if self.stopped.load(Ordering::Acquire) || !agent_tools_enabled(&self.app) {
            return Err(
                "Background task execution stopped or its authorization was revoked".into(),
            );
        }
        if restored.resumed_without_history {
            return Err("Agent could not restore usable conversation history".into());
        }
        if !self.offered.lock().contains(&restored.key.session_id) {
            return Err("This conversation was not offered task tools. Reopen it after enabling Agent task tools.".into());
        }
        let prepared = match host.prepare_turn(&restored.key, Some(run.id.clone())) {
            Ok(p) => p,
            Err(e) if e.to_string().contains("busy") => {
                let id = run.id.clone();
                self.call(move |s| s.defer(&id, now())).await?;
                return Ok(());
            }
            Err(e) => return Err(e.to_string()),
        };
        let id = run.id.clone();
        let session = restored.key.session_id.clone();
        let seq = prepared.turn_seq;
        self.call(move |s| s.dispatch(&id, &session, seq, now()))
            .await?;
        let prompt=format!("[DeskMate scheduled task; system-authored, not a new human request]\nTask: {}\nRun: {}\nGoal: {}\nStay within this task's existing authorization. Before ending this turn, call atlas_tasks.tasks_report_run with runId={}, and exactly one of done, waitingInput, or nextCheckAt (UTC milliseconds, at least 30 seconds ahead). Set notify=false when nothing useful changed. Do not claim completion without reporting. Notification delivery is handled by DeskMate after successful execution.",task.input.title,run.id,task.input.prompt,run.id);
        crate::commands::agents::record_scheduled_prompt(
            &self.app,
            &restored.key,
            &prompt,
            &run.id,
        )?;
        let result = host.start_prepared(
            prepared,
            vec![acp::ContentBlock::Text(acp::TextContent::new(prompt))],
        );
        self.changed();
        let outcome =
            tokio::time::timeout(Duration::from_secs(task.input.timeout_seconds), result).await;
        let (success, reason) = match outcome {
            Ok(Ok(Ok(acp::StopReason::EndTurn))) => (true, "end_turn".into()),
            Ok(Ok(Ok(other))) => (
                false,
                format!("Agent stopped with {other:?}; the task was not completed"),
            ),
            Ok(Ok(Err(e))) => (false, e),
            Ok(Err(e)) => (false, e.to_string()),
            Err(_) => {
                if let Err(e) = host.cancel(&restored.key) {
                    tracing::warn!("timed-out task could not stop its turn: {e}");
                }
                (false,"Execution timed out. Inspect tool effects before resuming; no automatic replay.".into())
            }
        };
        let id = run.id.clone();
        let settled = self
            .call(move |s| s.finish_agent(&id, success, &reason, now()))
            .await;
        if let Err(e) = settled {
            let id = run.id.clone();
            let reason = format!("Result rejected: {e}");
            if let Err(e) = self
                .call(move |s| s.finish_agent(&id, false, &reason, now()))
                .await
            {
                tracing::warn!("task settlement fenced: {e}");
            }
        }
        Ok(())
    }

    async fn deliver(&self) -> Result<(), String> {
        for _ in 0..20 {
            if self.stopped.load(Ordering::Acquire) {
                break;
            }
            let Some(n) = self.call(|s| s.pending_delivery(now())).await? else {
                break;
            };
            let task_id = n.task_id.clone();
            let task = self.call(move |s| s.get(&task_id)).await?;
            let local = chrono::Local::now();
            if task
                .input
                .quiet_hours
                .as_ref()
                .is_some_and(|q| q.contains((local.hour() * 60 + local.minute()) as u16))
            {
                let id = n.id.clone();
                self.call(move |s| s.delivery_state(&id, "pending", None, now()))
                    .await?;
                continue;
            }
            let settings = self
                .app
                .state::<crate::state::AtlasConfigHandle>()
                .lock()
                .effective()
                .clone();
            let kind = if n.attention {
                "task-attention"
            } else {
                "task-reminder"
            };
            let native = if n.attention {
                settings.notify_needs_you_native
            } else {
                settings.notify_outcome_native
            };
            if !settings.notifications_enabled
                || !native
                || settings.notify_disabled_kinds.iter().any(|k| k == kind)
            {
                let id = n.id.clone();
                self.call(move |s| s.delivery_state(&id, "muted", None, now()))
                    .await?;
                self.changed();
                continue;
            }
            let notifier = self
                .app
                .state::<Arc<crate::notifier::Notifier>>()
                .inner()
                .clone();
            let id = n.id.clone();
            self.call(move |s| s.delivery_state(&id, "submitting", None, now()))
                .await?;
            let sound = if if n.attention {
                settings.notify_needs_you_sound
            } else {
                settings.notify_outcome_sound
            } {
                Some("Ping".into())
            } else {
                None
            };
            let delivery_check = n.clone();
            let mut notification = crate::notifier::Notification {
                tag: n.id.clone(),
                group: format!("task:{}", n.task_id),
                title: n.title,
                subtitle: None,
                body: n.body,
                image_path: None,
                sound,
                urgency: if n.attention {
                    crate::notifier::Urgency::High
                } else {
                    crate::notifier::Urgency::Normal
                },
                actions: vec![],
                payload: Some(
                    serde_json::json!({"v":1,"target":{"type":"task","taskId":n.task_id}})
                        .to_string(),
                ),
            };
            // Serialize the final task-state check with submission. Pause/cancel
            // cannot acknowledge success and then have this old banner sent.
            let store = self.store.clone();
            let id = n.id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let mut store = store.lock();
                let current = store
                    .delivery_notification(delivery_check)
                    .map_err(|e| e.to_string())?;
                let Some(current) = current else {
                    store
                        .delivery_state(&id, "suppressed", None, now())
                        .map_err(|e| e.to_string())?;
                    return Ok::<_, String>(());
                };
                notification.body = current.body;
                let result = notifier.backend().show(notification);
                store
                    .delivery_state(
                        &id,
                        if result.is_ok() { "accepted" } else { "failed" },
                        result.err(),
                        now(),
                    )
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())??;
            self.changed();
        }
        Ok(())
    }
}
