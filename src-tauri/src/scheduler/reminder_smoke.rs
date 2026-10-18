//! Real vendor tool use against production schemas/calendar/store in an isolated profile.
use super::{calendar, model::TaskInput, store::Store};
use crate::commands::{memory_server, task_server};
use rmcp::{
    handler::server::ServerHandler,
    model::*,
    service::{RequestContext, RoleServer},
    transport::{
        streamable_http_server::session::local::LocalSessionManager, StreamableHttpServerConfig,
        StreamableHttpService,
    },
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

#[derive(Clone)]
struct Fixture {
    store: Arc<parking_lot::Mutex<Store>>,
    now: i64,
}
impl ServerHandler for Fixture {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, rmcp::ErrorData> {
        Ok(task_server::tools_list())
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, rmcp::ErrorData> {
        let mut args = Value::Object(request.arguments.unwrap_or_default());
        let result = (|| -> anyhow::Result<Value> {
            match request.name.as_ref() {
                "tasks_inspect" => Ok(json!({"tasks":self.store.lock().list(None)?})),
                "tasks_calendar_preview" => {
                    let spec = serde_json::from_value(args["calendar"].clone())?;
                    Ok(serde_json::to_value(calendar::preview(&spec,self.now)?)?)
                }
                "tasks_upsert" => {
                    // Scope is fixed by the fixture, never supplied by the model.
                    args["scopeKey"] = json!("personal-fixture");
                    args["sourceThreadId"] = json!("fixture-personal-thread");
                    let input: TaskInput = serde_json::from_value(args)?;
                    anyhow::ensure!(input.kind == super::model::TaskKind::Reminder,"Fixed reminders only");
                    Ok(serde_json::to_value(self.store.lock().upsert(input,self.now)?)?)
                }
                _ => anyhow::bail!("This isolated fixture only permits inspection, preview and reminder registration"),
            }
        })();
        Ok(match result {
            Ok(value) => CallToolResult::success(vec![ContentBlock::text(value.to_string())]),
            Err(error) => CallToolResult::error(vec![ContentBlock::text(error.to_string())]),
        }
        .into())
    }
}

#[tokio::test]
#[ignore = "requires ATLAS_CLAUDE_SDK_DIR; real billed model turn, temporary SQLite only"]
async fn claude_registers_a_default_weekly_reminder_in_temporary_sqlite() {
    let sdk = std::env::var("ATLAS_CLAUDE_SDK_DIR").expect("installed Claude Agent SDK directory");
    for (now_utc, human, expected_next) in [
        (
            "2026-10-18T00:00:00Z",
            "我每周四中午12点前需要写工作周报。",
            Some("2026-10-22T08:30:00Z"),
        ),
        (
            "2026-10-22T08:45:00Z",
            "我每周四中午12点前需要写工作周报。",
            Some("2026-10-29T08:30:00Z"),
        ),
        ("2026-10-22T08:45:00Z", "我今天中午12点前需要交报告。", None),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let db = directory.path().join("scheduler.sqlite");
        let store = Arc::new(parking_lot::Mutex::new(Store::open(&db).unwrap()));
        let now = chrono::DateTime::parse_from_rfc3339(now_utc)
            .unwrap()
            .timestamp_millis();
        let fixture = Fixture {
            store: store.clone(),
            now,
        };
        let tokens = Arc::new(memory_server::MemoryTokens::default());
        let token = tokens.mint(
            "fixture-personal-session",
            "fixture-agent",
            "isolated-profile",
        );
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let service = StreamableHttpService::new(
            move || Ok(fixture.clone()),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default(),
        );
        let router = axum::Router::new().nest_service("/mcp", service).layer(
            axum::middleware::from_fn_with_state(tokens, memory_server::require_token),
        );
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/personal-assistant/claude-reminder-smoke.mjs");
        let mut child = atlas_process::async_command("node")
            .arg(script)
            .arg(&sdk)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let context = json!({"nowUtc":now_utc,"taskToolsEnabled":true,"reminderDefaults":crate::personal::reminder_defaults(Some("Asia/Riyadh")).unwrap()});
        let mut stdin = child.stdin.take().unwrap();
        stdin.write_all(json!({"url":url,"token":token,"policy":crate::personal::REMINDER_POLICY,"context":context,"human":human,"requireSkipNotice":now_utc=="2026-10-22T08:45:00Z"}).to_string().as_bytes()).await.unwrap();
        drop(stdin);
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(180),
            child.wait_with_output(),
        )
        .await;
        server.abort();
        let output = result
            .expect("model turn completes within three minutes")
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr).replace(&token, "[REDACTED]")
        );
        let rows = store.lock().list(None).unwrap();
        let Some(expected_next) = expected_next else {
            assert!(
                rows.is_empty(),
                "expired one-off must not be registered as scheduled"
            );
            continue;
        };
        assert_eq!(rows.len(), 1, "one obligation creates one task");
        let task = &rows[0];
        assert_eq!(
            task.input.source_thread_id.as_deref(),
            Some("fixture-personal-thread")
        );
        assert_eq!(task.state, super::model::TaskState::Active);
        let cal = task.input.calendar.as_ref().expect("weekly calendar");
        assert_eq!(cal.frequency, calendar::Frequency::Weekly);
        assert_eq!(cal.local_time, "11:30");
        assert_eq!(cal.timezone, "Asia/Riyadh");
        assert_eq!(
            task.next_check_at,
            Some(
                chrono::DateTime::parse_from_rfc3339(expected_next)
                    .unwrap()
                    .timestamp_millis()
            )
        );
        let reopened = Store::open(&db).unwrap().list(None).unwrap();
        assert_eq!(
            reopened[0].id, task.id,
            "registration survives reopening SQLite"
        );
        println!("Real model registered one recurring reminder through MCP; temporary SQLite reopened with the same task ID.");
    }
}
