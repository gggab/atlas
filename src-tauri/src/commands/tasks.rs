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
pub async fn tasks_mark_read(id: String, dismissed: bool, app: AppHandle) -> Result<(), String> {
    let scheduler = Scheduler::get(&app)?;
    scheduler.call(move |s| s.mark_read(&id, dismissed)).await?;
    scheduler.changed();
    Ok(())
}
