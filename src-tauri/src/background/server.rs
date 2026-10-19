use super::{
    commands, files, invoke,
    protocol::{Batch, Endpoint, Events, PROTOCOL},
};
use axum::{
    extract::{DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Listener, Manager};

pub struct Server {
    pub endpoint: Endpoint,
    events: Mutex<Events>,
    wake: tokio::sync::Notify,
    app: tauri::AppHandle,
    slots: Arc<tokio::sync::Semaphore>,
    tls: Mutex<Option<rustls::ServerConfig>>,
    directory: Mutex<Option<std::path::PathBuf>>,
}

#[derive(Deserialize, Serialize)]
pub struct Request {
    pub command: String,
    pub args: Value,
}
#[derive(Deserialize, Serialize)]
pub struct Reply {
    pub ok: bool,
    pub value: Value,
}
#[derive(Deserialize)]
struct Cursor {
    after: u64,
}

impl Server {
    pub fn prepare(app: &tauri::AppHandle) -> Result<Arc<Self>, String> {
        let (certificate, tls) = super::tls::identity()?;
        let server = Arc::new(Self {
            endpoint: Endpoint {
                protocol: PROTOCOL,
                profile: app.config().identifier.clone(),
                version: env!("CARGO_PKG_VERSION").into(),
                build: env!("ATLAS_BACKGROUND_BUILD").into(),
                boot: uuid::Uuid::new_v4().to_string(),
                pid: std::process::id(),
                port: 0,
                token: format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                ),
                certificate,
            },
            events: Mutex::new(Events::default()),
            wake: Default::default(),
            app: app.clone(),
            slots: Arc::new(tokio::sync::Semaphore::new(128)),
            tls: Mutex::new(Some(tls)),
            directory: Mutex::new(None),
        });
        for name in commands::EVENTS {
            let weak = Arc::downgrade(&server);
            let name = *name;
            app.listen_any(name, move |event| {
                if let Some(server) = weak.upgrade() {
                    if let Ok(payload) = serde_json::from_str::<Value>(event.payload()) {
                        let attention = (name == "atlas:agents"
                            && matches!(
                                payload["kind"].as_str(),
                                Some("permission_request" | "elicitation_requested")
                            ))
                            || name == "atlas:agent-elicitation";
                        if attention && !server.gui_present() {
                            server.attention(payload.clone());
                        }
                        server.events.lock().push(name, payload);
                        server.wake.notify_one();
                    }
                }
            });
        }
        Ok(server)
    }

    pub async fn start(self: Arc<Self>) -> Result<(), String> {
        let dir = files::directory(&self.endpoint.profile)?;
        self.start_at(dir).await
    }

    pub async fn start_at(self: Arc<Self>, dir: std::path::PathBuf) -> Result<(), String> {
        invoke::ready(&self.app).await?;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let mut endpoint = self.endpoint.clone();
        endpoint.port = listener.local_addr().map_err(|e| e.to_string())?.port();
        let port = endpoint.port;
        *self.directory.lock() = Some(dir.clone());
        files::atomic_json(&dir, "endpoint.json", &endpoint)?;
        let state = self.clone();
        let router = Router::new()
            .route("/health", get(health))
            .route("/invoke", post(call))
            .route("/events", get(events))
            .route("/pending", get(pending).post(replay_pending))
            .route("/shutdown", post(shutdown))
            .layer(DefaultBodyLimit::max(64 * 1024 * 1024))
            .layer(middleware::from_fn_with_state(
                (self.clone(), port),
                authenticate,
            ))
            .with_state(state);
        tracing::info!("background service ready, pid={}", self.endpoint.pid);
        crate::scheduler::Scheduler::start(&self.app);
        let tls = self
            .tls
            .lock()
            .take()
            .ok_or("Background listener was already started")?;
        let listener = super::tls::Listener {
            socket: listener,
            acceptor: tokio_rustls::TlsAcceptor::from(Arc::new(tls)),
        };
        let result = axum::serve(listener, router)
            .await
            .map_err(|e| e.to_string());
        self.cleanup_endpoint();
        result
    }

    pub fn cleanup_endpoint(&self) {
        // Runtime still holds owner.lock, so no replacement can publish during this check/delete.
        if let Some(dir) = self.directory.lock().as_ref() {
            if files::endpoint(dir).is_ok_and(|e| e.boot == self.endpoint.boot) {
                if let Err(error) = std::fs::remove_file(dir.join("endpoint.json")) {
                    tracing::warn!("could not remove stopped background endpoint: {error}");
                }
            }
        }
    }

    pub fn gui_present(&self) -> bool {
        files::directory(&self.endpoint.profile).is_ok_and(|dir| files::held(&dir, "gui.lock"))
    }

    fn attention(&self, payload: Value) {
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            let Some(settings) = app
                .try_state::<crate::state::AtlasConfigHandle>()
                .map(|s| s.lock().effective().clone())
            else {
                return;
            };
            if !settings.notifications_enabled || !settings.notify_needs_you_native {
                return;
            }
            let mut target = None;
            if let Some(run) = payload["task_run_id"].as_str() {
                let run = run.to_owned();
                if let Ok(scheduler) = crate::scheduler::Scheduler::get(&app) {
                    if let Ok(task) = scheduler.call(move |store| store.task_for_run(&run)).await {
                        target = Some(
                            json!({"v":1,"target":{"type":"task","taskId":task.id}}).to_string(),
                        );
                    }
                }
            }
            if let Some(notifier) = app
                .try_state::<Arc<crate::notifier::Notifier>>()
                .map(|n| n.inner().clone())
            {
                let result = tauri::async_runtime::spawn_blocking(move || notifier.backend().show(crate::notifier::Notification {
                    tag: format!("approval:{}", payload["request_id"].as_str().or_else(|| payload["requestId"].as_str()).unwrap_or("connection")),
                    group: "background-approvals".into(), title: "DeskMate 后台任务需要确认".into(), subtitle: None,
                    body: "Agent 正在等待权限、登录或补充信息。打开 DeskMate 后处理；后台不会自动批准。".into(),
                    image_path: None, sound: settings.notify_needs_you_sound.then(|| "Ping".into()), urgency: crate::notifier::Urgency::High,
                    actions: vec![], payload: target,
                })).await;
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => {
                        tracing::error!("background approval notification failed: {error}")
                    }
                    Err(error) => {
                        tracing::error!("background approval notification worker failed: {error}")
                    }
                }
            }
        });
    }
}

async fn authenticate(
    State((server, port)): State<(Arc<Server>, u16)>,
    request: axum::extract::Request,
    next: Next,
) -> Result<Response, StatusCode> {
    if !authorized(&server.endpoint, port, request.headers()) {
        return Err(StatusCode::UNAUTHORIZED);
    }
    Ok(next.run(request).await)
}

fn authorized(endpoint: &Endpoint, port: u16, headers: &HeaderMap) -> bool {
    !headers.contains_key("origin")
        && headers.get("host").and_then(|h| h.to_str().ok())
            == Some(format!("127.0.0.1:{port}").as_str())
        && headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .is_some_and(|token| endpoint.authenticates(token))
}

async fn health(State(server): State<Arc<Server>>) -> Json<Value> {
    Json(
        json!({"protocol":PROTOCOL,"profile":server.endpoint.profile,"version":server.endpoint.version,"build":server.endpoint.build,"boot":server.endpoint.boot,"pid":server.endpoint.pid,"cursor":server.events.lock().batch(&server.endpoint.boot, 0).cursor}),
    )
}

async fn call(
    State(server): State<Arc<Server>>,
    Json(request): Json<Request>,
) -> Result<Json<Reply>, StatusCode> {
    if !commands::owns(&request.command) {
        return Err(StatusCode::FORBIDDEN);
    }
    let _slot = server
        .slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::TOO_MANY_REQUESTS)?;
    let result = invoke::dispatch(&server.app, request.command.clone(), request.args.clone()).await;
    if result.is_ok()
        && matches!(
            request.command.as_str(),
            "agents_respond_permission" | "agents_respond_elicitation"
        )
    {
        if let Some(request) = request.args["requestId"].as_str() {
            server.events.lock().resolve(request);
        }
    }
    Ok(Json(match result {
        Ok(value) => Reply { ok: true, value },
        Err(value) => Reply { ok: false, value },
    }))
}

async fn events(State(server): State<Arc<Server>>, Query(cursor): Query<Cursor>) -> Json<Batch> {
    let batch = server
        .events
        .lock()
        .batch(&server.endpoint.boot, cursor.after);
    if batch.events.is_empty() && !batch.gap {
        tokio::select! { _ = server.wake.notified() => {}, _ = tokio::time::sleep(std::time::Duration::from_secs(20)) => {} }
    }
    Json(
        server
            .events
            .lock()
            .batch(&server.endpoint.boot, cursor.after),
    )
}

async fn pending(State(server): State<Arc<Server>>) -> Json<Value> {
    Json(json!({"boot":server.endpoint.boot,"events":server.events.lock().pending()}))
}

async fn replay_pending(State(server): State<Arc<Server>>) -> Json<Value> {
    // Replay in the same ordered stream; a later resolution cannot be overtaken by a snapshot.
    let count = server.events.lock().replay_pending();
    server.wake.notify_one();
    Json(json!({"boot":server.endpoint.boot,"replayed":count}))
}

async fn shutdown(State(server): State<Arc<Server>>) -> Json<Value> {
    let app = server.app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        app.exit(0);
    });
    Json(json!({"stopping":true}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn browser_origins_rebinding_and_wrong_capabilities_are_rejected() {
        let endpoint = Endpoint {
            protocol: 1,
            profile: "p".into(),
            version: "v".into(),
            build: "build".into(),
            boot: "b".into(),
            pid: 1,
            port: 42,
            token: "secret-fixture".into(),
            certificate: "fixture".into(),
        };
        let mut headers = HeaderMap::new();
        headers.insert("host", "127.0.0.1:42".parse().unwrap());
        headers.insert("authorization", "Bearer secret-fixture".parse().unwrap());
        assert!(authorized(&endpoint, 42, &headers));
        headers.insert("origin", "http://localhost".parse().unwrap());
        assert!(!authorized(&endpoint, 42, &headers));
        headers.remove("origin");
        headers.insert("host", "evil.example:42".parse().unwrap());
        assert!(!authorized(&endpoint, 42, &headers));
    }
}
