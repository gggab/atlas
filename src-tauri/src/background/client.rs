use super::{
    commands, files,
    protocol::{Batch, Endpoint},
    server::{Reply, Request},
};
use parking_lot::Mutex;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tauri::{Emitter, Manager};

pub struct Client {
    endpoint: Mutex<Option<Result<Endpoint, String>>>,
    fault: Mutex<Option<String>>,
    ready: tokio::sync::Notify,
    http: Mutex<Option<reqwest::Client>>,
    stopping: std::sync::atomic::AtomicBool,
    app: tauri::AppHandle,
    directory: std::path::PathBuf,
}

impl Client {
    pub fn new(app: &tauri::AppHandle, directory: std::path::PathBuf) -> Arc<Self> {
        Arc::new(Self {
            endpoint: Mutex::new(None),
            fault: Mutex::new(None),
            ready: Default::default(),
            http: Mutex::new(None),
            stopping: false.into(),
            app: app.clone(),
            directory,
        })
    }
    pub fn start(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            let connected = self.connect().await;
            let start = connected.as_ref().ok().map(|(_, cursor)| *cursor);
            *self.endpoint.lock() = Some(connected.map(|(endpoint, _)| endpoint));
            self.ready.notify_waiters();
            if let Some(cursor) = start {
                if let Err(error) = self.events(cursor).await {
                    *self.fault.lock() = Some(error.clone());
                    if !self.stopping.load(std::sync::atomic::Ordering::Acquire) {
                        let _ = self.app.emit("atlas:background-error", error);
                    }
                }
            }
        });
    }
    pub fn error(&self) -> Option<String> {
        self.fault.lock().clone().or_else(|| {
            self.endpoint
                .lock()
                .as_ref()
                .and_then(|e| e.as_ref().err().cloned())
        })
    }
    pub fn connected(&self) -> bool {
        self.fault.lock().is_none()
            && self
                .endpoint
                .lock()
                .as_ref()
                .is_some_and(|result| result.is_ok())
    }
    pub fn stopping(&self) {
        self.stopping
            .store(true, std::sync::atomic::Ordering::Release);
        *self.fault.lock() =
            Some("Background shutdown was requested; restart the interface to reconnect".into());
    }
    fn http(&self) -> Result<reqwest::Client, String> {
        self.http
            .lock()
            .clone()
            .ok_or("Background transport is not ready".into())
    }
    async fn endpoint(&self) -> Result<Endpoint, String> {
        loop {
            let notified = self.ready.notified();
            if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
                return Err(
                    "Background shutdown is in progress; restart the interface after it finishes"
                        .into(),
                );
            }
            if let Some(error) = self.fault.lock().clone() {
                return Err(error);
            }
            if let Some(result) = self.endpoint.lock().clone() {
                return result;
            }
            tokio::time::timeout(Duration::from_secs(50), notified)
                .await
                .map_err(|_| {
                    "Background startup timed out; no local execution fallback was started"
                        .to_string()
                })?;
        }
    }
    async fn connect(self: &Arc<Self>) -> Result<(Endpoint, u64), String> {
        let profile = &self.app.config().identifier;
        let dir = self.directory.clone();
        let mut launched = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(45);
        while tokio::time::Instant::now() < deadline {
            if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
                return Err("Background shutdown was requested during connection".into());
            }
            if let Some(endpoint) = files::endpoint(&dir)
                .ok()
                .filter(|_| files::held(&dir, "owner.lock"))
            {
                let http = super::tls::transport(&endpoint)?;
                if let Ok(response) = http
                    .get(format!("https://127.0.0.1:{}/health", endpoint.port))
                    .bearer_auth(&endpoint.token)
                    .timeout(Duration::from_millis(600))
                    .send()
                    .await
                {
                    if response.status().is_success() {
                        let health: Value = response.json().await.map_err(|e| e.to_string())?;
                        if !endpoint.compatible(profile)
                            || health["boot"] != endpoint.boot
                            || health["profile"] != *profile
                            || health["version"] != env!("CARGO_PKG_VERSION")
                            || health["protocol"] != super::protocol::PROTOCOL
                            || health["build"] != env!("ATLAS_BACKGROUND_BUILD")
                        {
                            return Err("Background version/profile differs from this app. Stop the old backend explicitly before restarting; active Agent turns were not terminated".into());
                        }
                        *self.http.lock() = Some(http);
                        return Ok((
                            endpoint,
                            health["cursor"]
                                .as_u64()
                                .ok_or("Invalid background handshake")?,
                        ));
                    }
                }
            }
            if !launched && !files::held(&dir, "owner.lock") {
                let app = self.app.clone();
                let dir = dir.clone();
                let client = self.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _configuration = files::lock_wait(&dir, "config.lock")?;
                    let mut config = files::config(&dir)?;
                    if !config.enabled || client.stopping.load(std::sync::atomic::Ordering::Acquire)
                    {
                        return Err("Background was disabled during connection".into());
                    }
                    config.desktop = std::env::current_exe().map_err(|e| e.to_string())?;
                    config.executable = super::lifecycle::executable(&app, &dir)?;
                    config.resources = app.path().resource_dir().map_err(|e| e.to_string())?;
                    config.login = !tauri::is_dev();
                    if config.login {
                        super::lifecycle::register(
                            &app.config().identifier,
                            &dir,
                            &config.executable,
                        )?;
                    }
                    files::atomic_json(&dir, "config.json", &config)?;
                    if !client.stopping.load(std::sync::atomic::Ordering::Acquire) {
                        if config.login {
                            super::lifecycle::start_registered(&app.config().identifier)?;
                        } else {
                            atlas_process::command(&config.executable)
                                .arg("--background-service")
                                .stdin(std::process::Stdio::null())
                                .stdout(std::process::Stdio::null())
                                .stderr(std::process::Stdio::null())
                                .spawn()
                                .map_err(|e| format!("Could not start background backend: {e}"))?;
                        }
                    }
                    Ok::<_, String>(())
                })
                .await
                .map_err(|e| e.to_string())??;
                launched = true;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
        Err("Background backend did not become ready. Check its logs and WebView runtime; no second backend was started".into())
    }
    pub async fn call(&self, command: String, args: Value) -> Result<Value, Value> {
        let endpoint = self.endpoint().await.map_err(Value::String)?;
        let response = self.http().map_err(Value::String)?.post(format!("https://127.0.0.1:{}/invoke", endpoint.port)).bearer_auth(&endpoint.token).json(&Request { command, args }).send().await
            .map_err(|_| Value::String("Background connection interrupted. Inspect state before retrying; this command was not automatically replayed".into()))?;
        if !response.status().is_success() {
            return Err(Value::String(format!(
                "Background rejected command: {}",
                response.status()
            )));
        }
        let reply: Reply = response
            .json()
            .await
            .map_err(|e| Value::String(e.to_string()))?;
        if reply.ok {
            Ok(reply.value)
        } else {
            Err(reply.value)
        }
    }
    pub async fn attach(&self) -> Result<(), String> {
        let endpoint = self.endpoint().await?;
        let reply: Value = self
            .http()?
            .post(format!("https://127.0.0.1:{}/pending", endpoint.port))
            .bearer_auth(&endpoint.token)
            .timeout(Duration::from_secs(5))
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        if reply["boot"] != endpoint.boot {
            return Err(
                "Background restarted; restart the interface to reload its live state".into(),
            );
        }
        Ok(())
    }
    async fn events(&self, mut cursor: u64) -> Result<(), String> {
        let endpoint = self.endpoint().await?;
        loop {
            let response = self.http()?.get(format!("https://127.0.0.1:{}/events?after={cursor}", endpoint.port)).bearer_auth(&endpoint.token).timeout(Duration::from_secs(25)).send().await.map_err(|_| "Background event connection interrupted. Restart the DeskMate interface to reload live state; backend tasks continue".to_string())?;
            let batch: Batch = response
                .error_for_status()
                .map_err(|e| e.to_string())?
                .json()
                .await
                .map_err(|e| e.to_string())?;
            // shortcut: a gap requires an interface restart; add fenced in-place snapshots when seamless reconnect is needed.
            if batch.boot != endpoint.boot || batch.gap {
                return Err("Background event history changed or overflowed. Restart the DeskMate interface to reload full snapshots; no partial stream was replayed".into());
            }
            for event in batch.events {
                if commands::EVENTS.contains(&event.name.as_str()) {
                    let _ = self.app.emit(&event.name, event.payload);
                }
            }
            cursor = batch.cursor;
        }
    }
}

pub fn forward(invoke: tauri::ipc::Invoke) -> bool {
    let app = invoke.message.webview().app_handle().clone();
    let Some(client) = app.try_state::<Arc<Client>>().map(|s| s.inner().clone()) else {
        return false;
    };
    let command = invoke.message.command().to_owned();
    if !commands::owns(&command) {
        return false;
    }
    let args = match invoke.message.payload() {
        tauri::ipc::InvokeBody::Json(args) => args.clone(),
        _ => {
            invoke
                .resolver
                .reject("Background commands require JSON arguments");
            return true;
        }
    };
    tauri::async_runtime::spawn(async move {
        match client.call(command, args).await {
            Ok(value) => invoke.resolver.resolve(value),
            Err(error) => invoke.resolver.reject(error),
        }
    });
    true
}
