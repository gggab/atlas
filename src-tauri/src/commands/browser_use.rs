//! Persistent browser REPL for external ACP agents. Each worker controls
//! user-selected Chrome/Edge tabs through the Atlas Browser extension.
use super::memory_server::{Grant, MemoryTokens};
use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock as Content,
    ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerInfo, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, watch};

const INSTRUCTIONS: &str = include_str!("../../resources/browser-use-instructions.md");

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSession {
    pub session_id: String,
    pub agent: String,
    pub browser: String,
    pub pairing_url: Option<String>,
    pub title: String,
    pub status: String,
    pub tabs: Value,
}
struct Execution {
    grant: Grant,
    code: String,
    cleanup: bool,
    timeout_ms: u64,
    answer: oneshot::Sender<Result<Value, String>>,
}
#[derive(Clone)]
struct WorkerHandle {
    requests: mpsc::Sender<Execution>,
    stop: watch::Sender<bool>,
    finished: watch::Sender<u64>,
    cleaned: watch::Receiver<u64>,
}
#[derive(Default)]
struct Registry {
    paused: bool,
    sessions: HashMap<String, BrowserSession>,
}
impl Registry {
    fn release(&mut self, session: &str) {
        self.sessions.remove(session);
    }
}

pub struct BrowserUseState {
    app: AppHandle,
    registry: parking_lot::Mutex<Registry>,
    workers: parking_lot::Mutex<HashMap<String, WorkerHandle>>,
    url: OnceLock<String>,
    tokens: OnceLock<Arc<MemoryTokens>>,
    bridge: Arc<super::browser_bridge::BrowserBridge>,
}
impl BrowserUseState {
    pub fn install(app: &AppHandle) {
        app.manage(Arc::new(Self {
            app: app.clone(),
            registry: Default::default(),
            workers: Default::default(),
            url: OnceLock::new(),
            tokens: OnceLock::new(),
            bridge: super::browser_bridge::BrowserBridge::new(app),
        }));
    }
    pub fn url(&self) -> Option<String> {
        self.url.get().cloned()
    }
    fn changed(&self) {
        let _ = self.app.emit("atlas:browser-use-changed", ());
    }
    fn live(&self, grant: &Grant) -> Result<(), String> {
        if grant.session_id.is_empty()
            || !self
                .tokens
                .get()
                .is_some_and(|tokens| tokens.is_live(grant))
        {
            return Err("Agent session ended or is not yet bound".into());
        }
        if self.registry.lock().paused || self.bridge.paused() {
            return Err("Browser automation paused by the user".into());
        }
        Ok(())
    }
    pub fn stop(&self, session: &str) {
        if let Some(worker) = self.workers.lock().get(session) {
            let _ = worker.stop.send(true);
        }
        // The worker releases extension control before removing session state.
        if let Some(info) = self.registry.lock().sessions.get_mut(session) {
            info.status = "stopping".into();
        }
        self.changed();
    }
    pub fn finish_turn(&self, session: &str, turn_seq: u64) {
        if turn_seq != 0
            && self
                .app
                .try_state::<Arc<super::agent_host::AgentHost>>()
                .is_some_and(|host| !host.is_current_turn(session, turn_seq))
        {
            return;
        }
        if let Some(worker) = self.workers.lock().get(session) {
            // The actor handles cleanup before any following tool request.
            worker
                .finished
                .send_modify(|epoch| *epoch = epoch.wrapping_add(1));
        }
        if let Some(info) = self.registry.lock().sessions.get_mut(session) {
            info.status = "cleaning".into();
        }
        self.changed();
    }
    pub fn shutdown(&self) {
        for worker in self.workers.lock().values() {
            let _ = worker.stop.send(true);
        }
    }
    pub fn shutdown_and_wait(&self) {
        self.registry.lock().paused = true;
        self.shutdown();
        // Tauri exits the process after this callback; allow parallel worker
        // teardown to finish so extension control is released before exit.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
        while !self.workers.lock().is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    fn session_snapshot(&self, session: &str) -> Value {
        let registry = self.registry.lock();
        let mut session =
            serde_json::to_value(registry.sessions.get(session)).unwrap_or(Value::Null);
        if let Some(object) = session.as_object_mut() {
            object.remove("pairingUrl");
        }
        json!({"paused":registry.paused || self.bridge.paused(),"session":session,"documentation":INSTRUCTIONS})
    }
    pub fn start(self: &Arc<Self>, tokens: Arc<MemoryTokens>) {
        let _ = self.tokens.set(tokens.clone());
        if let Err(error) = self
            .runtime_dir()
            .and_then(|dir| self.bridge.prepare_extension(&dir.join("extension")))
        {
            self.bridge.report_error(&error);
        }
        self.bridge.start();
        // Bind before offers are installed so the first ACP session sees the
        // browser server even when it starts immediately after app setup.
        let listener = match std::net::TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => listener,
            Err(error) => {
                tracing::error!(%error, "Browser tool server could not bind");
                return;
            }
        };
        if let Err(error) = listener.set_nonblocking(true) {
            tracing::error!(%error, "Browser tool listener could not become nonblocking");
            return;
        }
        let Ok(addr) = listener.local_addr() else {
            return;
        };
        let _ = self.url.set(format!("http://{addr}/mcp"));
        let state = self.clone();
        tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    tracing::error!(%error,"Browser tool server could not bind");
                    return;
                }
            };
            let tools = BrowserTools {
                state: state.clone(),
                tokens: tokens.clone(),
            };
            let service=rmcp::transport::StreamableHttpService::new(move||Ok(tools.clone()),Arc::new(rmcp::transport::streamable_http_server::session::local::LocalSessionManager::default()),rmcp::transport::StreamableHttpServerConfig::default());
            let router = axum::Router::new()
                .nest_service("/mcp", service)
                .layer(axum::middleware::from_fn_with_state(
                    tokens,
                    super::memory_server::require_token,
                ))
                .layer(axum::middleware::from_fn(super::ssh::loopback_only));
            if let Err(error) = axum::serve(listener, router).await {
                tracing::error!(%error,"Browser tool server stopped");
            }
        });
    }
    pub async fn execute(
        self: &Arc<Self>,
        grant: Grant,
        code: String,
        timeout_ms: u64,
        title: String,
    ) -> Result<Value, String> {
        self.live(&grant)?;
        if code.len() > 64_000 {
            return Err("Browser code exceeds 64 KB".into());
        }
        let previous = self.workers.lock().get(&grant.session_id).cloned();
        if let Some(worker) = previous {
            let mut cleaned = worker.cleaned.clone();
            tokio::time::timeout(std::time::Duration::from_secs(70), async {
                while *worker.finished.borrow() != *cleaned.borrow() {
                    // A closed channel means teardown removed the old worker
                    // and released control; the next request may start anew.
                    if cleaned.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await
            .map_err(|_| "Browser cleanup is still running; inspect its status before retrying")?;
            self.live(&grant)?;
        }
        let worker = {
            let mut workers = self.workers.lock();
            self.live(&grant)?;
            if let Some(worker) = workers.get(&grant.session_id) {
                if *worker.stop.borrow() {
                    return Err("Browser is disconnecting; wait before sharing again".into());
                }
                worker.clone()
            } else {
                let (requests, receiver) = mpsc::channel(1);
                let (stop, stopped) = watch::channel(false);
                let (finished, completion) = watch::channel(0);
                let (cleanup_done, cleaned) = watch::channel(0);
                let worker = WorkerHandle {
                    requests,
                    stop,
                    finished,
                    cleaned,
                };
                workers.insert(grant.session_id.clone(), worker.clone());
                self.registry.lock().sessions.insert(
                    grant.session_id.clone(),
                    BrowserSession {
                        session_id: grant.session_id.clone(),
                        agent: grant.agent.clone(),
                        browser: "extension".into(),
                        pairing_url: None,
                        title: String::new(),
                        status: "starting".into(),
                        tabs: json!([]),
                    },
                );
                let state = self.clone();
                let owner = grant.session_id.clone();
                let owner_grant = grant.clone();
                tauri::async_runtime::spawn(async move {
                    state
                        .run_worker(
                            owner,
                            owner_grant,
                            receiver,
                            stopped,
                            completion,
                            cleanup_done,
                        )
                        .await;
                });
                worker
            }
        };
        if let Some(info) = self.registry.lock().sessions.get_mut(&grant.session_id) {
            info.title = title;
            info.status = "running".into();
        }
        self.changed();
        let (answer, result) = oneshot::channel();
        worker
            .requests
            .try_send(Execution {
                grant,
                code,
                cleanup: false,
                timeout_ms,
                answer,
            })
            .map_err(|_| "Browser runtime busy or stopped; inspect its status before retrying")?;
        result
            .await
            .map_err(|_| "Browser runtime stopped; inspect the page before retrying".to_string())?
    }
    fn runtime_dir(&self) -> Result<std::path::PathBuf, String> {
        let path = self
            .app
            .path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("resources/browser-use");
        #[cfg(debug_assertions)]
        let path = if path.join("worker.mjs").exists() {
            path
        } else {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/browser-use")
        };
        if !path.join("worker.mjs").is_file() {
            return Err(
                "Browser runtime missing: run bun run browser:bundle before building Atlas".into(),
            );
        }
        Ok(path)
    }
    async fn run_worker(
        self: Arc<Self>,
        owner: String,
        owner_grant: Grant,
        mut receiver: mpsc::Receiver<Execution>,
        mut stopped: watch::Receiver<bool>,
        mut completed: watch::Receiver<u64>,
        cleanup_done: watch::Sender<u64>,
    ) {
        let result:Result<(),String>=async {
            let dir=self.runtime_dir()?;
            let data=self.app.path().app_data_dir().map_err(|e|e.to_string())?.join("browser-automation");
            let config=json!({"browser":"extension","artifactsDir":data.join("artifacts").join(uuid::Uuid::new_v4().to_string())});
            let mut child=atlas_process::async_command(dir.join(if cfg!(windows){"node.exe"}else{"node"})).arg(dir.join("worker.mjs")).current_dir(&dir).env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
                .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null()).kill_on_drop(true).spawn().map_err(|e|format!("Start browser runtime: {e}"))?;
            let mut input=child.stdin.take().ok_or("Browser stdin missing")?;
            let mut output=BufReader::new(child.stdout.take().ok_or("Browser stdout missing")?).lines();
            loop {
                if *stopped.borrow(){break;}
                let request=tokio::select!{
                    biased;
                    _=stopped.changed()=>break,
                    line=output.next_line()=>{
                        let line=line.map_err(|e|e.to_string())?.ok_or("Browser runtime exited")?;
                        if line.len()>16*1024*1024{return Err("Browser response exceeds 16 MiB".into());}
                        let message:Value=serde_json::from_str(&line).map_err(|_|"Invalid browser worker response")?;
                        if message["disconnected"].as_bool()==Some(true){break;}
                        if let Some(tabs)=message.get("tabs") {
                            if let Some(info)=self.registry.lock().sessions.get_mut(&owner){info.tabs=tabs.clone();}self.changed();
                        } else if message["connected"].as_bool()==Some(true) {
                            if let Some(info)=self.registry.lock().sessions.get_mut(&owner){info.status="shared".into();}self.changed();
                        } else {return Err("Unexpected browser worker message while idle".into());}
                        continue;
                    },
                    changed=completed.changed()=>{
                        if changed.is_err(){break;}
                        let (answer, _)=oneshot::channel();
                        // Cleanup closes task-owned pages except required handoffs.
                        Execution { grant: owner_grant.clone(), code: String::new(), cleanup: true, timeout_ms: 60_000, answer }
                    },
                    request=receiver.recv()=>match request{Some(request)=>request,None=>break}
                };
                if let Err(error)=self.live(&request.grant){let _=request.answer.send(Err(error));continue;}
                let cleanup_epoch=*completed.borrow();
                let operation=async {
                    let call_id=uuid::Uuid::new_v4().to_string();
                    input.write_all(format!("{}\n",json!({"code":request.code,"cleanup":request.cleanup,"config":config,"call_id":call_id})).as_bytes()).await.map_err(|e|e.to_string())?; input.flush().await.map_err(|e|e.to_string())?;
                    loop {
                        let line=output.next_line().await.map_err(|e|e.to_string())?.ok_or("Browser runtime exited")?;
                        if line.len()>16*1024*1024{return Err("Browser response exceeds 16 MiB".into());}
                        let message:Value=serde_json::from_str(&line).map_err(|_|"Invalid browser worker response")?;
                        if let Some(rpc)=message.get("rpc") {
                            if message["call_id"].as_str()!=Some(&call_id){return Err("Browser action belongs to a completed call; await all actions".into());}
                            let reply=match self.live(&request.grant){Ok(())=>json!({"rpc":rpc,"result":true}),Err(error)=>json!({"rpc":rpc,"error":error})};
                            input.write_all(format!("{reply}\n").as_bytes()).await.map_err(|e|e.to_string())?;input.flush().await.map_err(|e|e.to_string())?;
                        } else if let Some(pairing)=message["pairing"].as_str() {
                            if let Some(info)=self.registry.lock().sessions.get_mut(&owner){info.pairing_url=Some(pairing.to_string());}self.changed();
                            self.live(&request.grant)?;
                            let title = self.registry.lock().sessions.get(&owner).map(|info|info.title.clone()).unwrap_or_default();
                            self.bridge.open_task(pairing, &title, &owner).await?;
                        } else if let Some(tabs)=message.get("tabs") {
                            if let Some(info)=self.registry.lock().sessions.get_mut(&owner){info.tabs=tabs.clone();}self.changed();
                        } else if message["connected"].as_bool()==Some(true) {
                            if let Some(info)=self.registry.lock().sessions.get_mut(&owner){info.status="shared".into();}self.changed();
                        } else if let Some(result)=message.get("result"){return Ok(result.clone());}
                        else if message["disconnected"].as_bool()==Some(true){
                            if !request.cleanup{return Err("Browser extension disconnected; prepare and share the tab again".into());}
                        }
                        else{return Err(message["fatal"].as_str().unwrap_or("Invalid browser worker message").to_string());}
                    }
                };
                let outcome=tokio::select!{biased;_=stopped.changed()=>Err("Browser stopped; an already sent action may have taken effect".into()),outcome=tokio::time::timeout(std::time::Duration::from_millis(request.timeout_ms),operation)=>outcome.unwrap_or_else(|_|Err("Browser timed out and was stopped; inspect the result before retrying".into()))};
                let cleanup_failed=request.cleanup && outcome.as_ref().is_ok_and(|value|value["isError"].as_bool()==Some(true));
                if cleanup_failed { self.bridge.report_error("Task page cleanup failed. Inspect Atlas Browser and release its task pages before continuing."); }
                let fatal=outcome.is_err() || cleanup_failed;
                let empty_after_cleanup=request.cleanup && outcome.as_ref().is_ok_and(|value|value["keepAlive"].as_bool()==Some(false));
                if let Some(info)=self.registry.lock().sessions.get_mut(&owner){info.status=if fatal{"stopping"}else if info.pairing_url.is_some() && info.tabs.as_array().is_some_and(|tabs|tabs.is_empty()){"waiting"}else{"idle"}.into();}self.changed();
                let _=request.answer.send(outcome); if fatal || empty_after_cleanup{break;}
                if request.cleanup { cleanup_done.send_replace(cleanup_epoch); }
            }
            // Close task-owned pages and detach; existing user pages stay open.
            let _=input.write_all(b"{\"shutdown\":true}\n").await;let _=input.flush().await;
            if tokio::time::timeout(std::time::Duration::from_secs(3),child.wait()).await.is_err(){
                #[cfg(windows)]
                if let Some(pid)=child.id(){let _=atlas_process::async_command("taskkill.exe").args(["/PID",&pid.to_string(),"/T","/F"]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).status().await;}
                let _=child.kill().await; let _=child.wait().await;
            }
            Ok(())
        }.await;
        if let Err(error) = result {
            while let Ok(request) = receiver.try_recv() {
                let _ = request.answer.send(Err(error.clone()));
            }
            tracing::error!(%error,"Browser runtime stopped");
        }
        let mut workers = self.workers.lock();
        workers.remove(&owner);
        self.registry.lock().release(&owner);
        drop(workers);
        self.changed();
        // Drop only after control teardown and registry release, waking callers
        // waiting to start the next browser task.
        drop(cleanup_done);
    }
}

#[tauri::command]
pub fn browser_use_snapshot(state: State<'_, Arc<BrowserUseState>>) -> Value {
    let registry = state.registry.lock();
    json!({"paused":registry.paused || state.bridge.paused(),"sessions":registry.sessions.values().collect::<Vec<_>>(),"extensionPath":state.bridge.extension_path().ok(),"connection":state.bridge.snapshot()})
}

#[tauri::command]
pub async fn browser_use_manage(
    state: State<'_, Arc<BrowserUseState>>,
    browser: String,
    action: String,
) -> Result<(), String> {
    if !["chrome", "edge"].contains(&browser.as_str())
        || !["install", "manage", "reconnect"].contains(&action.as_str())
    {
        return Err("Unsupported browser management action".into());
    }
    if action != "manage" {
        state.shutdown();
    }
    state
        .bridge
        .prepare_extension(&state.runtime_dir()?.join("extension"))?;
    let bridge = state.bridge.clone();
    tauri::async_runtime::spawn_blocking(move || bridge.manage(&browser, &action))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn browser_use_forget(state: State<'_, Arc<BrowserUseState>>) -> Result<(), String> {
    state.shutdown();
    state.bridge.forget()
}
#[tauri::command]
pub async fn browser_use_connect(
    state: State<'_, Arc<BrowserUseState>>,
    session_id: String,
) -> Result<Value, String> {
    let grant = state
        .tokens
        .get()
        .and_then(|tokens| tokens.grant_for_session(&session_id))
        .ok_or("This Agent session has no live browser tool grant")?;
    let result = state
        .inner()
        .clone()
        .execute(grant, String::new(), 60_000, "Agent task".into())
        .await?;
    if result["isError"].as_bool() == Some(true) {
        return Err(result["content"][0]["text"]
            .as_str()
            .unwrap_or("Extension connection failed")
            .into());
    }
    Ok(result)
}
#[tauri::command]
pub fn browser_use_pause(
    state: State<'_, Arc<BrowserUseState>>,
    paused: bool,
) -> Result<(), String> {
    state.bridge.set_paused(paused)?;
    state.registry.lock().paused = paused;
    if paused {
        state.shutdown();
    }
    state.changed();
    Ok(())
}
#[tauri::command]
pub fn browser_use_stop(state: State<'_, Arc<BrowserUseState>>, session_id: String) {
    state.stop(&session_id);
}

#[derive(Clone)]
struct BrowserTools {
    state: Arc<BrowserUseState>,
    tokens: Arc<MemoryTokens>,
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Args {
    code: Option<String>,
    title: Option<String>,
    timeout_ms: Option<u64>,
}
fn tools_list() -> ListToolsResult {
    let tools=[
            ("browser_status","Read this session's browser status and Browser Use documentation. Does not launch a browser.",json!({}),vec![]),
            ("browser_start","Automatically connect the authorized Chrome/Edge extension and open a new grouped task tab. First-time setup requires installing and authorizing Atlas Browser. Never copy login profiles.",json!({}),vec![]),
            ("browser_repl","Execute persistent JavaScript using cua/browser/agent and nodeRepl. Reuse handles across calls. Emit observations explicitly. Errors do not roll back browser actions; inspect before retrying. Trusted local code execution, not a security sandbox.",json!({"code":{"type":"string","maxLength":64000},"title":{"type":"string","maxLength":120},"timeout_ms":{"type":"integer","minimum":1000,"maximum":120000}}),vec!["code"]),
            ("browser_reset","Close Agent-created task tabs except necessary handoffs, remove empty groups, release debugging and clear handles. Preserve existing user tabs and browser login.",json!({}),vec![]),
        ].into_iter().map(|(name,description,properties,required)|Tool::new(name,description,Arc::new(json!({"type":"object","properties":properties,"required":required,"additionalProperties":false}).as_object().cloned().unwrap_or_default()))).collect();
    ListToolsResult::with_all_items(tools)
        .with_ttl_ms(60_000)
        .with_cache_scope(rmcp::model::CacheScope::Private)
}

impl ServerHandler for BrowserTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(INSTRUCTIONS)
    }
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        Ok(tools_list())
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let grant = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|parts| parts.extensions.get::<Grant>())
            .cloned()
            .ok_or_else(|| McpError::invalid_request("No session identity", None))?;
        if grant.session_id.is_empty() || !self.tokens.is_live(&grant) {
            return Err(McpError::invalid_request(
                "Agent session ended or is not yet bound",
                None,
            ));
        }
        let args: Args =
            serde_json::from_value(Value::Object(request.arguments.clone().unwrap_or_default()))
                .map_err(|_| McpError::invalid_params("Invalid browser arguments", None))?;
        let is_repl = matches!(request.name.as_ref(), "browser_start" | "browser_repl");
        let result = match request.name.as_ref() {
            "browser_status" => Ok(self.state.session_snapshot(&grant.session_id)),
            "browser_reset" => {
                self.state.stop(&grant.session_id);
                Ok(json!({"stopping":true}))
            }
            "browser_start" | "browser_repl" => {
                let timeout = args.timeout_ms.unwrap_or(60_000);
                if !(1000..=120_000).contains(&timeout) {
                    return Err(McpError::invalid_params(
                        "timeout_ms must be 1000..120000",
                        None,
                    ));
                }
                let title = args.title.unwrap_or_else(|| "Browser automation".into());
                if title.len() > 120 {
                    return Err(McpError::invalid_params("title exceeds 120 bytes", None));
                }
                let code = if request.name == "browser_start" {
                    String::new()
                } else {
                    args.code
                        .ok_or_else(|| McpError::invalid_params("code required", None))?
                };
                tokio::select! {biased;_=context.ct.cancelled()=>{self.state.stop(&grant.session_id);Err("Browser operation cancelled; inspect before retrying".into())},result=self.state.execute(grant.clone(),code,timeout,title)=>result}
            }
            _ => return Err(McpError::invalid_params("Unknown browser tool", None)),
        };
        let result = match result {
            Ok(value) if is_repl => {
                let content = value["content"]
                    .as_array()
                    .ok_or_else(|| McpError::internal_error("Invalid browser response", None))?
                    .iter()
                    .map(|item| match item["type"].as_str() {
                        Some("image") => Content::image(
                            item["data"].as_str().unwrap_or_default(),
                            item["mimeType"].as_str().unwrap_or("image/png"),
                        ),
                        _ => Content::text(item["text"].as_str().unwrap_or_default()),
                    })
                    .collect();
                if value["isError"].as_bool().unwrap_or(false) {
                    CallToolResult::error(content)
                } else {
                    CallToolResult::success(content)
                }
            }
            Ok(value) => CallToolResult::success(vec![Content::text(value.to_string())]),
            Err(error) => CallToolResult::error(vec![Content::text(error)]),
        };
        Ok(result.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_pairing_requires_a_live_session_grant() {
        let tokens = MemoryTokens::default();
        assert!(tokens.grant_for_session("own").is_none());
        let token = tokens.mint("own", "agent", "fixture");
        assert_eq!(tokens.grant_for_session("own"), tokens.grant(&token));
        assert!(tokens.grant_for_session("other").is_none());
        tokens.revoke("own");
        assert!(tokens.grant_for_session("own").is_none());
    }
    #[tokio::test]
    #[ignore = "requires ATLAS_CLAUDE_SDK_DIR; MCP control handshake only, no model turn"]
    async fn claude_loads_browser_tools_over_http_and_rejects_missing_metadata() {
        #[derive(Clone)]
        struct DiscoveryOnly {
            missing_metadata: bool,
        }
        impl ServerHandler for DiscoveryOnly {
            fn get_info(&self) -> ServerInfo {
                ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
                    .with_instructions(INSTRUCTIONS)
            }
            async fn list_tools(
                &self,
                _: Option<PaginatedRequestParams>,
                _: RequestContext<RoleServer>,
            ) -> Result<ListToolsResult, McpError> {
                let mut result = tools_list();
                if self.missing_metadata {
                    result.ttl_ms = None;
                    result.cache_scope = None;
                }
                Ok(result)
            }
        }
        let sdk = std::env::var("ATLAS_CLAUDE_SDK_DIR")
            .expect("set the installed Claude Agent SDK directory");
        let tokens = Arc::new(MemoryTokens::default());
        let token = tokens.mint(
            "browser-discovery-smoke",
            "claude",
            "isolated-discovery-fixture",
        );
        let mut urls = Vec::new();
        let mut servers = Vec::new();
        for missing_metadata in [false, true] {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            urls.push(format!("http://{}/mcp", listener.local_addr().unwrap()));
            let service = rmcp::transport::StreamableHttpService::new(
                move || Ok(DiscoveryOnly { missing_metadata }),
                Arc::new(rmcp::transport::streamable_http_server::session::local::LocalSessionManager::default()),
                rmcp::transport::StreamableHttpServerConfig::default(),
            );
            let router = axum::Router::new()
                .nest_service("/mcp", service)
                .layer(axum::middleware::from_fn_with_state(
                    tokens.clone(),
                    super::super::memory_server::require_token,
                ))
                .layer(axum::middleware::from_fn(super::super::ssh::loopback_only));
            servers.push(tokio::spawn(async move {
                axum::serve(listener, router).await.unwrap();
            }));
        }
        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../scripts/browser-use/claude-discovery-smoke.mjs");
        let mut child = atlas_process::async_command("node")
            .arg(script)
            .arg(sdk)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        stdin
            .write_all(
                json!({"fixed":urls[0],"missing_metadata":urls[1],"token":token})
                    .to_string()
                    .as_bytes(),
            )
            .await
            .unwrap();
        drop(stdin);
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(60), child.wait_with_output())
                .await;
        for server in servers {
            server.abort();
        }
        let output = result
            .expect("Claude discovery completes within one minute")
            .unwrap();
        assert!(
            output.status.success(),
            "Claude discovery failed: {}",
            String::from_utf8_lossy(&output.stderr).replace(&token, "[REDACTED]")
        );
        println!("{}", String::from_utf8_lossy(&output.stdout));
    }
    #[test]
    fn discovery_serializes_cache_metadata_and_all_browser_tools() {
        let wire = serde_json::to_value(tools_list()).unwrap();
        assert_eq!(wire["resultType"], "complete");
        assert!(
            wire["ttlMs"].as_u64().is_some(),
            "tools/list must include ttlMs"
        );
        assert_eq!(wire["cacheScope"], "private");
        let names: Vec<_> = wire["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        assert_eq!(
            names,
            [
                "browser_status",
                "browser_start",
                "browser_repl",
                "browser_reset"
            ]
        );
    }
    #[test]
    fn extension_start_exposes_no_browser_launch_or_profile_arguments() {
        let wire = serde_json::to_value(tools_list()).unwrap();
        let start = wire["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "browser_start")
            .unwrap();
        assert_eq!(start["inputSchema"]["properties"], json!({}));
    }
}
