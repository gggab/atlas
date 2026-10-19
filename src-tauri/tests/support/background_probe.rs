//! Debug-only native fixtures: no vendor CLI, user databases or OS login registration.
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tauri::{Emitter, Manager, State};

struct Fixture {
    store: Mutex<crate::scheduler::store::Store>,
    started: AtomicUsize,
    finished: AtomicUsize,
}

#[tauri::command]
async fn tasks_snapshot(
    state: State<'_, Arc<Fixture>>,
    fail: Option<bool>,
) -> Result<Value, Value> {
    if fail == Some(true) {
        return Err(json!({"kind":"auth","message":"fictional authentication required"}));
    }
    let store = state.store.lock();
    Ok(
        json!({"tasks":store.list(None).map_err(|e|json!(e.to_string()))?,"notifications":store.notifications().map_err(|e|json!(e.to_string()))?,"started":state.started.load(Ordering::SeqCst),"finished":state.finished.load(Ordering::SeqCst)}),
    )
}

#[tauri::command]
async fn tasks_upsert(
    input: crate::scheduler::model::TaskInput,
    state: State<'_, Arc<Fixture>>,
) -> Result<Value, String> {
    if input.kind != crate::scheduler::model::TaskKind::Reminder {
        return Err("The native fixture never runs model tasks".into());
    }
    state
        .store
        .lock()
        .upsert(input, crate::scheduler::now())
        .and_then(|t| Ok(serde_json::to_value(t)?))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn agents_send(state: State<'_, Arc<Fixture>>, app: tauri::AppHandle) -> Result<(), String> {
    let state = state.inner().clone();
    state.started.fetch_add(1, Ordering::SeqCst);
    app.emit("atlas:agents", json!({"kind":"permission_request","request_id":"probe-request","session_id":"probe-session"})).map_err(|e|e.to_string())?;
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    state.finished.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
fn agents_respond_permission(request_id: String) -> Result<(), String> {
    if request_id != "probe-request" {
        return Err("Unknown fixture approval".into());
    }
    Ok(())
}

pub fn run(mut context: tauri::Context<tauri::Wry>) {
    let args: Vec<_> = std::env::args().collect();
    let dir = args
        .windows(2)
        .find(|p| p[0] == "--probe-dir")
        .map(|p| PathBuf::from(&p[1]))
        .expect("isolated --probe-dir is required");
    assert!(
        dir.is_absolute()
            && dir.file_name().is_some_and(|name| name
                .to_string_lossy()
                .starts_with("deskmate-background-native-"))
    );
    if args.iter().any(|arg| arg == "--background-probe-client") {
        run_client(context, dir);
        return;
    }
    context.config_mut().identifier = format!("dev.atlas.background-probe.{}", std::process::id());
    context.config_mut().app.windows.clear();
    tauri::Builder::default()
        .invoke_system("")
        .register_uri_scheme_protocol("deskmate-runtime", |_, _| {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html")
                .header(
                    "Content-Security-Policy",
                    "default-src 'none'; frame-src 'none'; script-src 'none'",
                )
                .body(b"<!doctype html><title>Background fixture</title>".to_vec())
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            tasks_snapshot,
            tasks_upsert,
            agents_send,
            agents_respond_permission
        ])
        .setup(move |app| {
            let watchdog = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(60));
                watchdog.exit(1);
            });
            super::files::private_directory(&dir).map_err(std::io::Error::other)?;
            app.manage(super::files::lock_owner(&dir).map_err(std::io::Error::other)?);
            super::install_exit_signal(app.handle()).map_err(std::io::Error::other)?;
            let fixture = Arc::new(Fixture {
                store: Mutex::new(crate::scheduler::store::Store::open(
                    &dir.join("scheduler.sqlite"),
                )?),
                started: AtomicUsize::new(0),
                finished: AtomicUsize::new(0),
            });
            app.manage(fixture.clone());
            super::invoke::create_context_at(app.handle(), dir.join("webview"))?;
            let server =
                super::server::Server::prepare(app.handle()).map_err(std::io::Error::other)?;
            app.manage(server.clone());
            let app = app.handle().clone();
            let dir = dir.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = server.start_at(dir).await {
                    eprintln!("native fixture failed: {error}");
                    app.exit(1);
                }
            });
            tauri::async_runtime::spawn(async move {
                loop {
                    {
                        let mut store = fixture.store.lock();
                        if let Some(run) = store
                            .claim_due(crate::scheduler::now(), "native-fixture")
                            .expect("claim fixture reminder")
                        {
                            store
                                .finish_reminder(&run.id, crate::scheduler::now())
                                .expect("settle fixture reminder");
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            });
            Ok(())
        })
        .build(context)
        .expect("build isolated native background fixture")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                super::cleanup_endpoint(app);
            }
        });
}

fn run_client(mut context: tauri::Context<tauri::Wry>, dir: PathBuf) {
    let lifecycle = dir.join("client-lifecycle.log");
    let endpoint = super::files::endpoint(&dir).expect("isolated backend endpoint");
    context.config_mut().identifier = endpoint.profile;
    // A client uses a declarative frontend window, unlike the backend's dynamic context.
    context.config_mut().app.windows = vec![tauri::utils::config::WindowConfig {
        label: super::invoke::CONTEXT.into(),
        url: tauri::WebviewUrl::CustomProtocol("deskmate-runtime://localhost/".parse().unwrap()),
        visible: false,
        skip_taskbar: true,
        data_directory: Some(dir.join("client-webview")),
        ..Default::default()
    }];
    tauri::Builder::default()
        .invoke_system("")
        .register_uri_scheme_protocol("deskmate-runtime", |_, _| {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html")
                .header(
                    "Content-Security-Policy",
                    "default-src 'none'; script-src 'none'",
                )
                .body(b"<!doctype html><title>Client fixture</title>".to_vec())
                .unwrap()
        })
        .invoke_handler(|invoke| {
            if super::remote(&invoke) {
                super::client::forward(invoke)
            } else {
                false
            }
        })
        .setup(move |app| {
            app.manage(super::files::lock_wait(&dir, "gui.lock").map_err(std::io::Error::other)?);
            let client = super::client::Client::new(app.handle(), dir.clone());
            app.manage(client.clone());
            let app = app.handle().clone();
            let receipt_dir = dir.clone();
            tauri::async_runtime::spawn(async move {
                let result = tokio::time::timeout(std::time::Duration::from_secs(20), async {
                    super::invoke::ready(&app).await?;
                    app.state::<Arc<super::client::Client>>().attach().await?;
                    let value = super::invoke::dispatch(&app, "tasks_snapshot".into(), json!({}))
                        .await
                        .map_err(|e| e.to_string())?;
                    if value["tasks"]
                        .as_array()
                        .is_none_or(|tasks| tasks.len() != 1)
                        || value["finished"] != 1
                    {
                        return Err("Client did not hydrate the existing backend".to_string());
                    }
                    let failure = super::invoke::dispatch(
                        &app,
                        "tasks_snapshot".into(),
                        json!({"fail":true}),
                    )
                    .await;
                    if failure
                        != Err(json!({"kind":"auth","message":"fictional authentication required"}))
                    {
                        return Err("Client lost structured native errors".into());
                    }
                    Ok::<_, String>(())
                })
                .await;
                match result {
                    Ok(Ok(())) => {
                        super::files::atomic_json(
                            &receipt_dir,
                            "client-result.json",
                            &json!({"ok":true}),
                        )
                        .expect("write isolated native client receipt");
                        app.exit(0);
                    }
                    error => {
                        let _ = super::files::atomic_json(
                            &receipt_dir,
                            "client-result.json",
                            &json!({"ok":false,"error":format!("{error:?}")}),
                        );
                        eprintln!("native client fixture failed: {error:?}");
                        app.exit(1);
                    }
                }
            });
            Ok(())
        })
        .build(context)
        .expect("build isolated native client fixture")
        .run(move |app, event| {
            if matches!(event, tauri::RunEvent::Ready) {
                if let Some(window) = app.get_webview_window(super::invoke::CONTEXT) {
                    let _ = std::fs::write(
                        lifecycle.with_extension("state"),
                        format!("url={:?} title={:?}", window.url(), window.title()),
                    );
                }
                app.state::<Arc<super::client::Client>>()
                    .inner()
                    .clone()
                    .start();
            }
            if matches!(
                event,
                tauri::RunEvent::Ready
                    | tauri::RunEvent::Exit
                    | tauri::RunEvent::ExitRequested { .. }
                    | tauri::RunEvent::WindowEvent { .. }
            ) {
                use std::io::Write;
                if let Ok(mut file) = std::fs::OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&lifecycle)
                {
                    let _ = writeln!(file, "{event:?}");
                }
            }
        });
}
