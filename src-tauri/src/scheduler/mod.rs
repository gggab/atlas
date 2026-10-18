pub mod calendar;
#[cfg(test)]
mod calendar_tests;
#[cfg(test)]
mod lifecycle_tests;
pub mod model;
#[cfg(test)]
mod reminder_smoke;
mod runner;
mod store;
#[cfg(test)]
mod tests;

use parking_lot::Mutex;
use std::collections::HashSet;
use std::fs::{File, OpenOptions};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Emitter, Manager};

pub const CHANGED: &str = "atlas:tasks-changed";

pub struct SchedulerUnavailable(pub String);

pub struct Scheduler {
    store: Arc<Mutex<store::Store>>,
    wake: tokio::sync::Notify,
    stopped: AtomicBool,
    boot: String,
    offered: Mutex<HashSet<String>>,
    app: AppHandle,
    _lock: File,
}

impl Scheduler {
    pub fn install(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let dir = app.path().app_config_dir()?;
        std::fs::create_dir_all(&dir)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(dir.join("scheduler.lock"))?;
        lock.try_lock()
            .map_err(|e| format!("Another process owns this profile's task scheduler: {e}"))?;
        let mut store = store::Store::open(&dir.join("scheduler.sqlite"))?;
        store.refresh_calendar_timezones(now())?;
        store.recover(now())?;
        app.manage(Arc::new(Self {
            store: Arc::new(Mutex::new(store)),
            wake: tokio::sync::Notify::new(),
            stopped: AtomicBool::new(false),
            boot: uuid::Uuid::new_v4().to_string(),
            offered: Mutex::default(),
            app: app.clone(),
            _lock: lock,
        }));
        Ok(())
    }

    pub fn start(app: &AppHandle) {
        let Ok(state) = Self::get(app) else {
            return;
        };
        tauri::async_runtime::spawn(async move {
            state.run().await;
        });
    }

    pub fn get(app: &AppHandle) -> Result<Arc<Self>, String> {
        app.try_state::<Arc<Self>>()
            .map(|s| s.inner().clone())
            .ok_or_else(|| {
                app.try_state::<SchedulerUnavailable>()
                    .map(|s| s.0.clone())
                    .unwrap_or_else(|| "Task scheduler is not initialized".into())
            })
    }

    pub async fn call<T, F>(&self, job: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&mut store::Store) -> anyhow::Result<T> + Send + 'static,
    {
        let store = self.store.clone();
        tauri::async_runtime::spawn_blocking(move || {
            job(&mut store.lock()).map_err(|e| format!("{e:#}"))
        })
        .await
        .map_err(|e| e.to_string())?
    }

    pub fn changed(&self) {
        self.wake.notify_one();
        if let Err(e) = self.app.emit(CHANGED, ()) {
            tracing::warn!("task projection failed: {e}");
        }
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        self.wake.notify_one();
    }
    pub fn note_offer(&self, session: &str) {
        self.offered.lock().insert(session.into());
    }
    pub fn forget_offer(&self, session: &str) {
        self.offered.lock().remove(session);
    }
    pub fn explains_activity(&self, session: &str, at: chrono::DateTime<chrono::Utc>) -> bool {
        match self
            .store
            .lock()
            .explains_activity(session, at.timestamp_millis())
        {
            Ok(yes) => yes,
            Err(e) => {
                tracing::error!("cannot attribute scheduled activity: {e:#}");
                false
            }
        }
    }
}

pub fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub fn agent_tools_enabled(app: &AppHandle) -> bool {
    Scheduler::get(app).is_ok()
        && app
            .try_state::<crate::state::AtlasConfigHandle>()
            .is_some_and(|c| c.lock().effective().agent_task_tools)
}

pub fn normalize_input(
    host: &crate::commands::agent_host::AgentHost,
    mut input: model::TaskInput,
) -> Result<model::TaskInput, String> {
    if input.kind == model::TaskKind::AgentCheck {
        let id: atlas_thread_metadata::ThreadId = input
            .execution_thread_id
            .as_deref()
            .ok_or("execution thread required")?
            .parse()
            .map_err(|_| "invalid thread id")?;
        let thread = host
            .history()
            .and_then(|h| h.store().thread(id))
            .ok_or("execution conversation no longer exists")?;
        if thread.session_id.is_none() {
            return Err(
                "Send a message in the execution conversation before scheduling an Agent check"
                    .into(),
            );
        }
        let cwd = thread
            .folder_paths()
            .paths()
            .first()
            .cloned()
            .ok_or("execution directory missing")?;
        if !cwd.is_dir() {
            return Err("execution directory no longer exists".into());
        }
        input.scope_key = atlas_checkpoint::git::scope_root(&cwd)
            .to_string_lossy()
            .into_owned();
        input.cwd = Some(cwd.to_string_lossy().into_owned());
        input.agent = Some(thread.agent_id.to_string());
    } else {
        input.scope_key = "personal".into();
        input.execution_thread_id = None;
        input.cwd = None;
        input.agent = None;
    }
    Ok(input)
}
