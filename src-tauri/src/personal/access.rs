use crate::scheduler::model::{Task, TaskInput, TaskKind};

pub fn proposal_task(p: &super::store::Proposal) -> TaskInput {
    TaskInput {
        id: None,
        expected_revision: None,
        idempotency_key: format!("personal-proposal:{}:{}", p.id, p.revision),
        title: p.input.title.clone(),
        prompt: p.input.prompt.clone(),
        kind: TaskKind::Reminder,
        due_at: p.input.due_at,
        calendar: p.input.calendar.clone(),
        interval_minutes: p.input.interval_minutes,
        scope_key: "personal".into(),
        source_thread_id: Some(p.source_thread_id.clone()),
        execution_thread_id: None,
        cwd: None,
        agent: None,
        max_runs: 20,
        timeout_seconds: 300,
        quiet_hours: None,
    }
}

/// Fixed reminders share a personal space; execution-bound checks do not.
pub fn owns_task(task: &Task, thread: &str, personal_threads: &[String]) -> bool {
    task.input.source_thread_id.as_deref() == Some(thread)
        || (personal_threads.iter().any(|id| id == thread)
            && task.input.kind == TaskKind::Reminder
            && task
                .input
                .source_thread_id
                .as_ref()
                .is_some_and(|id| personal_threads.contains(id)))
}
