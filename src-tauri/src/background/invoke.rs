use serde_json::Value;
use tauri::{
    ipc::{CallbackFn, InvokeBody, InvokeResponse},
    Manager,
};

pub const CONTEXT: &str = "background-context";

fn context_url(url: &url::Url) -> bool {
    matches!(
        url.as_str(),
        "deskmate-runtime://localhost/"
            | "http://deskmate-runtime.localhost/"
            | "https://deskmate-runtime.localhost/"
    )
}

pub async fn ready(app: &tauri::AppHandle) -> Result<(), String> {
    for _ in 0..250 {
        if app
            .get_webview_window(CONTEXT)
            .and_then(|w| w.url().ok())
            .is_some_and(|url| context_url(&url))
        {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    let location = app
        .get_webview_window(CONTEXT)
        .map(|window| window.url().map(|url| url.to_string()));
    Err(format!(
        "Background WebView context did not become ready (location: {location:?})"
    ))
}

/// Reuse the pinned Tauri command decoder without exposing a scriptable RPC page.
pub async fn dispatch(
    app: &tauri::AppHandle,
    command: String,
    args: Value,
) -> Result<Value, Value> {
    let webview = app
        .get_webview_window(CONTEXT)
        .ok_or_else(|| Value::String("Background command context is unavailable".into()))?;
    let url = webview.url().map_err(|e| Value::String(e.to_string()))?;
    if !context_url(&url) {
        return Err(Value::String(
            "Background command context is not ready".into(),
        ));
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    webview.on_message(
        tauri::webview::InvokeRequest {
            cmd: command,
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url,
            body: InvokeBody::Json(args),
            headers: Default::default(),
            invoke_key: app.invoke_key().to_owned(),
        },
        Box::new(move |_, _, response, _, _| {
            let result = match response {
                InvokeResponse::Ok(body) => body
                    .deserialize::<Value>()
                    .map_err(|e| Value::String(e.to_string())),
                InvokeResponse::Err(error) => Err(error.0),
            };
            let _ = sender.send(result);
        }),
    );
    receiver.await.map_err(|_| {
        Value::String("Background response was interrupted; inspect state before retrying".into())
    })?
}

pub fn create_context(app: &tauri::AppHandle) -> tauri::Result<()> {
    create_context_at(
        app,
        app.path().app_local_data_dir()?.join("background-webview"),
    )
}

pub fn create_context_at(app: &tauri::AppHandle, data: std::path::PathBuf) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(
        app,
        CONTEXT,
        tauri::WebviewUrl::CustomProtocol("deskmate-runtime://localhost/".parse().unwrap()),
    )
    .visible(false)
    .skip_taskbar(true)
    .data_directory(data)
    .on_navigation(context_url)
    .build()?;
    Ok(())
}
