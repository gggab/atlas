pub mod client;
mod commands;
mod files;
pub mod invoke;
mod lifecycle;
#[cfg(debug_assertions)]
#[path = "../../tests/support/background_probe.rs"]
pub mod probe;
mod protocol;
mod server;
mod tls;

use serde::Serialize;
use std::{fs::File, path::PathBuf, sync::Arc};
use tauri::Manager;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Local,
    Client,
    Server,
}

pub struct Runtime {
    pub role: Role,
    pub config: files::Config,
    pub dir: PathBuf,
    _owner: Option<File>,
    _gui: Option<File>,
    quitting: std::sync::atomic::AtomicBool,
}

pub fn requested() -> bool {
    std::env::args().any(|arg| arg == "--background-service")
        || (cfg!(target_os = "macos")
            && std::env::current_exe()
                .is_ok_and(|p| p.file_name().is_some_and(|name| name == "atlas-background")))
}

pub fn prepare(app: &tauri::AppHandle) -> Result<Arc<Runtime>, String> {
    let dir = files::directory(&app.config().identifier)?;
    files::private_directory(&dir)?;
    let _configuration = files::lock_wait(&dir, "config.lock")?;
    let config = files::config(&dir)?;
    let role = if requested() {
        if !config.enabled {
            return Err("Background execution is disabled".into());
        }
        Role::Server
    } else if config.enabled {
        Role::Client
    } else {
        Role::Local
    };
    let owner = if role != Role::Client {
        Some(files::lock_owner(&dir)?)
    } else {
        None
    };
    let gui = if role == Role::Client {
        Some(files::lock_wait(&dir, "gui.lock")?)
    } else {
        None
    };
    Ok(Arc::new(Runtime {
        role,
        config,
        dir,
        _owner: owner,
        _gui: gui,
        quitting: false.into(),
    }))
}

pub fn mark_exiting(app: &tauri::AppHandle) {
    if let Some(runtime) = app.try_state::<Arc<Runtime>>() {
        runtime
            .quitting
            .store(true, std::sync::atomic::Ordering::Release);
    }
}

pub fn cleanup_endpoint(app: &tauri::AppHandle) {
    if let Some(server) = app.try_state::<Arc<server::Server>>() {
        server.cleanup_endpoint();
    }
}

pub fn client_window_destroyed(app: &tauri::AppHandle, label: &str) {
    if let Some(runtime) = app.try_state::<Arc<Runtime>>() {
        if runtime.role == Role::Client
            && label == "main"
            && !runtime
                .quitting
                .swap(true, std::sync::atomic::Ordering::AcqRel)
        {
            app.exit(0);
        }
    }
}

pub fn install_server(app: &tauri::AppHandle) -> Result<(), String> {
    install_exit_signal(app)?;
    let server = server::Server::prepare(app)?;
    app.manage(server);
    Ok(())
}

fn install_exit_signal(_app: &tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // launchd termination must use the normal Agent subprocess cleanup path.
        let mut terminate = tauri::async_runtime::block_on(async {
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        })
        .map_err(|error| format!("Could not install background termination handler: {error}"))?;
        let app = _app.clone();
        tauri::async_runtime::spawn(async move {
            if terminate.recv().await.is_some() {
                app.exit(0);
            }
        });
    }
    Ok(())
}

pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    let runtime = app.state::<Arc<Runtime>>();
    match runtime.role {
        Role::Client => {
            let client = client::Client::new(app, runtime.dir.clone());
            app.manage(client.clone());
            client.start();
        }
        Role::Server => {
            #[cfg(windows)]
            if !tauri::is_dev()
                && app.state::<Arc<crate::notifier::Notifier>>().info().backend != "windows-toast"
            {
                return Err("Windows background notifications or COM activation are unavailable; no scheduled work was started".into());
            }
            #[cfg(target_os = "macos")]
            if app.state::<Arc<crate::notifier::Notifier>>().info().backend != "macos-un" {
                return Err("macOS background notification identity is unavailable; no scheduled work was started".into());
            }
            invoke::create_context(app).map_err(|e| e.to_string())?;
            let server = app.state::<Arc<server::Server>>().inner().clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = server.start().await {
                    tracing::error!("background startup failed: {error}");
                    app.exit(1);
                }
            });
        }
        Role::Local => {}
    }
    Ok(())
}

pub fn remote(invoke: &tauri::ipc::Invoke) -> bool {
    commands::owns(invoke.message.command())
        && invoke
            .message
            .webview()
            .app_handle()
            .try_state::<Arc<client::Client>>()
            .is_some()
}

pub fn resource_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Some(runtime) = app.try_state::<Arc<Runtime>>() {
        if runtime.role == Role::Server {
            if !runtime.config.resources.is_dir() {
                return Err("The background service's application resources are missing; stop it before updating/reinstalling DeskMate".into());
            }
            return Ok(runtime.config.resources.clone());
        }
    }
    app.path().resource_dir().map_err(|e| e.to_string())
}

pub fn detached(app: &tauri::AppHandle) -> bool {
    app.try_state::<Arc<server::Server>>()
        .is_some_and(|server| !server.gui_present())
}

pub fn notification_clicked(app: &tauri::AppHandle) {
    if !detached(app) {
        return;
    }
    let Some(runtime) = app.try_state::<Arc<Runtime>>() else {
        return;
    };
    let mut command = atlas_process::command(&runtime.config.desktop);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if let Err(error) = command.spawn() {
        tracing::error!("could not open DeskMate for background notification: {error}");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    supported: bool,
    enabled: bool,
    role: &'static str,
    login: bool,
    error: Option<String>,
    needs_restart: bool,
    connected: bool,
}

#[tauri::command]
pub fn background_status(app: tauri::AppHandle) -> Result<Status, String> {
    let runtime = app.state::<Arc<Runtime>>();
    let config = files::config(&runtime.dir)?;
    Ok(Status {
        supported: cfg!(any(windows, target_os = "macos")),
        enabled: config.enabled,
        role: match runtime.role {
            Role::Local => "local",
            Role::Client => "client",
            Role::Server => "server",
        },
        login: config.login,
        error: app
            .try_state::<Arc<client::Client>>()
            .and_then(|client| client.error()),
        needs_restart: config.enabled != (runtime.role != Role::Local)
            || app
                .try_state::<Arc<client::Client>>()
                .is_some_and(|client| client.error().is_some()),
        connected: app
            .try_state::<Arc<client::Client>>()
            .is_some_and(|client| client.connected()),
    })
}

#[tauri::command]
pub async fn background_attach(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(client) = app
        .try_state::<Arc<client::Client>>()
        .map(|c| c.inner().clone())
    {
        client.attach().await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn background_configure(enabled: bool, app: tauri::AppHandle) -> Result<(), String> {
    if !cfg!(any(windows, target_os = "macos")) {
        return Err("Independent background execution supports Windows and macOS only".into());
    }
    if !enabled {
        if let Some(client) = app.try_state::<Arc<client::Client>>() {
            client.stopping();
        }
    }
    let dir = app.state::<Arc<Runtime>>().dir.clone();
    let _configuration =
        tauri::async_runtime::spawn_blocking(move || files::lock_wait(&dir, "config.lock"))
            .await
            .map_err(|e| e.to_string())??;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = handle.state::<Arc<Runtime>>();
        let mut config = files::config(&runtime.dir)?;
        if enabled {
            if config.enabled && (config.login || tauri::is_dev()) {
                return Ok::<_, String>(());
            }
            let previous = config.clone();
            config.desktop = std::env::current_exe().map_err(|e| e.to_string())?;
            config.executable = lifecycle::executable(&handle, &runtime.dir)?;
            config.resources = handle.path().resource_dir().map_err(|e| e.to_string())?;
            config.enabled = true;
            files::atomic_json(&runtime.dir, "config.json", &config)?;
            if !tauri::is_dev() {
                if let Err(error) = lifecycle::register(
                    &handle.config().identifier,
                    &runtime.dir,
                    &config.executable,
                ) {
                    let cleanup = lifecycle::unregister(&handle.config().identifier);
                    files::atomic_json(&runtime.dir, "config.json", &previous).map_err(
                        |rollback| {
                            format!("{error}; configuration rollback also failed: {rollback}")
                        },
                    )?;
                    cleanup.map_err(|cleanup| {
                        format!("{error}; registration cleanup also failed: {cleanup}")
                    })?;
                    return Err(error);
                }
                config.login = true;
            }
            files::atomic_json(&runtime.dir, "config.json", &config)?;
        } else {
            // Remove restart mechanisms before stopping the running backend.
            if !tauri::is_dev() || config.login || runtime.dir.join("login-task.xml").exists() {
                lifecycle::unregister(&handle.config().identifier)?;
            }
            config.login = false;
            files::atomic_json(&runtime.dir, "config.json", &config)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    if !enabled {
        let runtime = app.state::<Arc<Runtime>>();
        if runtime.role == Role::Client {
            stop(&app).await?;
        }
        let dir = runtime.dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut config = files::config(&dir)?;
            config.enabled = false;
            files::atomic_json(&dir, "config.json", &config)
        })
        .await
        .map_err(|e| e.to_string())??;
    }
    Ok(())
}

async fn stop(app: &tauri::AppHandle) -> Result<(), String> {
    stop_profile(&app.config().identifier).await
}

async fn stop_profile(profile: &str) -> Result<(), String> {
    let dir = files::directory(profile)?;
    if !files::held(&dir, "owner.lock") {
        return Ok(());
    }
    if let Ok(endpoint) = files::endpoint(&dir) {
        if endpoint.profile != profile {
            return Err("Background profile mismatch; nothing was stopped".into());
        }
        let shutdown = tls::transport(&endpoint)?
            .post(format!("https://127.0.0.1:{}/shutdown", endpoint.port))
            .bearer_auth(&endpoint.token)
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await
            .and_then(|response| response.error_for_status());
        for _ in 0..100 {
            if !files::held(&dir, "owner.lock") {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        return Err(match shutdown {
            Ok(_) => {
                "Background backend has not released ownership; restart was not attempted".into()
            }
            Err(error) => {
                format!("Could not stop background backend and ownership is still held: {error}")
            }
        });
    }
    Err("Background still owns the profile but has no ready endpoint. Retry stopping it before restarting the interface".into())
}

/// Explicit update/uninstall maintenance; never opens databases or an AgentHost.
pub fn maintenance(profile: &str) -> Option<Result<(), String>> {
    let remove = std::env::args().any(|arg| arg == "--background-service-remove");
    if !remove && !std::env::args().any(|arg| arg == "--background-service-stop") {
        return None;
    }
    Some((|| {
        let dir = files::directory(profile)?;
        files::private_directory(&dir)?;
        let _configuration = files::lock_wait(&dir, "config.lock")?;
        let mut config = files::config(&dir)?;
        if !tauri::is_dev() || config.login || dir.join("login-task.xml").exists() {
            lifecycle::unregister(profile)?;
        }
        config.login = false;
        files::atomic_json(&dir, "config.json", &config)?;
        tauri::async_runtime::block_on(stop_profile(profile))?;
        if remove {
            config.enabled = false;
            files::atomic_json(&dir, "config.json", &config)?;
        }
        Ok(())
    })())
}

#[tauri::command]
pub fn background_restart(app: tauri::AppHandle) {
    mark_exiting(&app);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        app.restart();
    });
}
