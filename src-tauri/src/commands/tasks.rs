use super::agent_host::AgentHost;
use crate::scheduler::{model::*, now, Scheduler};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    tasks: Vec<Task>,
    notifications: Vec<TaskNotification>,
}

#[tauri::command]
pub async fn tasks_snapshot(app: AppHandle) -> Result<TaskSnapshot, String> {
    let scheduler = Scheduler::get(&app)?;
    scheduler
        .call(|s| {
            Ok(TaskSnapshot {
                tasks: s.list(None)?,
                notifications: s.notifications()?,
            })
        })
        .await
}

#[tauri::command]
pub async fn tasks_upsert(
    input: TaskInput,
    host: State<'_, Arc<AgentHost>>,
    app: AppHandle,
) -> Result<Task, String> {
    let scheduler = Scheduler::get(&app)?;
    let host = host.inner().clone();
    let input = tauri::async_runtime::spawn_blocking(move || {
        crate::scheduler::normalize_input(&host, input)
    })
    .await
    .map_err(|e| e.to_string())??;
    let result = scheduler.call(move |s| s.upsert(input, now())).await?;
    scheduler.changed();
    Ok(result)
}

#[tauri::command]
pub async fn tasks_control(
    id: String,
    revision: u64,
    action: TaskAction,
    at: Option<i64>,
    app: AppHandle,
) -> Result<Task, String> {
    let scheduler = Scheduler::get(&app)?;
    let task = scheduler
        .call(move |s| s.control(&id, revision, action, at, now()))
        .await?;
    scheduler.changed();
    Ok(task)
}

#[tauri::command]
pub async fn tasks_runs(id: String, app: AppHandle) -> Result<Vec<Run>, String> {
    let scheduler = Scheduler::get(&app)?;
    scheduler.call(move |s| s.runs(&id)).await
}

#[tauri::command]
pub async fn tasks_reopen(
    request: ReopenTask,
    host: State<'_, Arc<AgentHost>>,
    app: AppHandle,
) -> Result<Task, String> {
    let scheduler = Scheduler::get(&app)?;
    let host = host.inner().clone();
    let task = scheduler
        .call(move |s| s.reopen(request, &host.active_task_runs(), now()))
        .await?;
    scheduler.changed();
    Ok(task)
}

#[tauri::command]
pub async fn tasks_delete(
    id: String,
    revision: u64,
    host: State<'_, Arc<AgentHost>>,
    app: AppHandle,
) -> Result<(), String> {
    let scheduler = Scheduler::get(&app)?;
    let host = host.inner().clone();
    scheduler
        .call(move |s| s.delete(&id, revision, &host.active_task_runs()))
        .await?;
    scheduler.changed();
    Ok(())
}

#[tauri::command]
pub async fn tasks_mark_read(id: String, dismissed: bool, app: AppHandle) -> Result<(), String> {
    let scheduler = Scheduler::get(&app)?;
    scheduler.call(move |s| s.mark_read(&id, dismissed)).await?;
    scheduler.changed();
    Ok(())
}

#[tauri::command]
pub async fn tasks_calendar_preview(
    calendar: crate::scheduler::calendar::CalendarSpec,
    id: Option<String>,
    app: AppHandle,
) -> Result<crate::scheduler::calendar::CalendarPreview, String> {
    Scheduler::get(&app)?
        .call(move |s| s.calendar_preview(calendar, id.as_deref(), now()))
        .await
}
#[tauri::command]
pub async fn tasks_occurrences(
    id: String,
    before: Option<u64>,
    app: AppHandle,
) -> Result<Vec<Occurrence>, String> {
    Scheduler::get(&app)?
        .call(move |s| s.occurrences(&id, before, 50))
        .await
}
#[tauri::command]
pub async fn tasks_control_occurrence(
    task_id: String,
    task_revision: u64,
    id: String,
    revision: u64,
    action: OccurrenceAction,
    at: Option<i64>,
    app: AppHandle,
) -> Result<Occurrence, String> {
    let scheduler = Scheduler::get(&app)?;
    let result = scheduler
        .call(move |s| {
            s.control_occurrence(&task_id, task_revision, &id, revision, action, at, now())
        })
        .await?;
    scheduler.changed();
    Ok(result)
}
