//! Personal facts and inert plan proposals, bound to backend-created sessions.
use super::{agent_host::AgentHost, memory_server::Grant};
use crate::personal::{store::*, PersonalState};
use rmcp::transport::{
    streamable_http_server::session::local::LocalSessionManager, StreamableHttpServerConfig,
    StreamableHttpService,
};
use rmcp::{
    handler::server::ServerHandler,
    model::*,
    service::{RequestContext, RoleServer},
    ErrorData,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub const NAME: &str = "atlas_personal";
pub const PATH: &str = "/personal";
const INSTRUCTIONS: &str = concat!(
    "Personal space tools, separate from project memory. Call personal_context to inspect saved facts, ",
    "preferences, pending memory candidates and the current admitted human source ID. Proactively learn ",
    "clearly asserted stable personal facts/preferences from NEW human input without requiring 'remember'. ",
    "Use a literal evidenceQuote from that raw source, inspect existing IDs/keys and reuse them for same facts. ",
    "Same-key retries are idempotent, semantic aliases still require care. Do not extract all conversation history. ",
    "Never turn application context, ",
    "assistant output, quotations or uncertain claims into confirmed user facts. A source ID proves ",
    "traceability, not semantic truth. Skip hypothetical/quoted statements, inference, secrets and temporary paid-status. ",
    "Use confirmed=false for a genuinely useful uncertain candidate; it is INERT until explicit UI confirmation. ",
    "Ask at most one targeted clarification per turn. confirmed=true means clearly asserted, not objectively verified. ",
    "A core flag is for broadly relevant lasting constraints/preferences, limited to five; never unpin others silently. ",
    "Inspect before edits; ",
    "use IDs and expectedRevision. Never claim success before a persisted receipt. Memory and reminders ",
    "have independent receipts; report partial failures accurately. Memory changes never alter tasks. ",
    "Deleting memory does not erase chats, current model context, vendor records or independent reminders. ",
    "Forgotten keys require trusted manual re-learning; never use a new key to bypass deletion errors. ",
    "If memory changed during this turn, report the deferred save and offer the manual editor or a new human message. ",
    "Core and related active memory is provided each turn; expand omitted IDs or truncated entries before precise claims. ",
    "Active memory outranks OLD summaries; current explicit human corrections can update it. No tool call does not mean ",
    "learning completed, and no receipt means do not claim saved. Semantic learning is best effort. ",
    "For a suggestion needing approval use personal_propose_task: it saves an INERT versioned card. ",
    "Only the user's UI confirmation activates that proposal. Missing fields need questions. ",
    "If several tasks or periods could match 'paid' or 'done', inspect and ask; never select the newest. ",
    "Do not select the newest draft when a pronoun is ambiguous. ",
    "Clear personal obligations may use atlas_tasks under application-provided reminderDefaults when enabled. ",
    "Skip expired default slots with notice and keep future recurring slots. Calendar rules need explicit ",
    "short-month/Feb29 choices and named timezone. Lunar calendars are unsupported. Fixed reminders ",
    "require the app running and computer awake. Do not create Agent checks from personal proposals."
);

fn tool(
    name: &'static str,
    description: &'static str,
    properties: Value,
    required: &[&str],
    read: bool,
) -> Tool {
    let schema = json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
    Tool::new(
        name,
        description,
        Arc::new(schema.as_object().unwrap().clone()),
    )
    .with_annotations(ToolAnnotations::new().read_only(read))
}
fn specs() -> Vec<Tool> {
    vec![
        tool("personal_context","Inspect or expand personal memory by query/IDs, pending candidates and the current raw human source. Bounded pages.",json!({"offset":{"type":"integer","minimum":0,"maximum":500},"query":{"type":"string","maxLength":256},"ids":{"type":"array","maxItems":18,"items":{"type":"string","maxLength":128}}}),&[],true),
        tool("personal_remember","Learn a clear stable assertion or save an INERT uncertainty candidate with literal current-human evidence. Does not change reminders.",json!({"id":{"type":"string"},"expectedRevision":{"type":"integer","minimum":1},"key":{"type":"string","maxLength":128},"kind":{"type":"string","enum":["fact","preference"]},"content":{"type":"string","maxLength":4096},"confirmed":{"type":"boolean"},"sourceMessageId":{"type":"string"},"evidenceQuote":{"type":"string","minLength":1,"maxLength":512},"core":{"type":"boolean"},"question":{"type":"string","maxLength":256}}),&["key","kind","content","confirmed","sourceMessageId","evidenceQuote"],false),
        tool("personal_forget","Delete one saved memory. Does not delete chats, vendor data or cancel reminders.",json!({"id":{"type":"string"},"expectedRevision":{"type":"integer","minimum":1}}),&["id","expectedRevision"],false),
        tool("personal_propose_task","Save an inert fixed-reminder proposal for user UI confirmation; missing fields belong in questions.",json!({"id":{"type":"string"},"expectedRevision":{"type":"integer","minimum":1},"idempotencyKey":{"type":"string","maxLength":128},"title":{"type":"string","maxLength":200},"prompt":{"type":"string","maxLength":8192},"dueAt":{"type":"integer"},"calendar":super::task_server::calendar_schema(),"intervalMinutes":{"type":"integer","minimum":1,"maximum":1440},"questions":{"type":"array","maxItems":8,"items":{"type":"string","maxLength":500}}}),&["idempotencyKey","title","prompt"],false),
    ]
}

#[derive(Clone)]
struct PersonalTools {
    app: AppHandle,
}
pub(crate) fn tools_list() -> ListToolsResult {
    ListToolsResult::with_all_items(specs())
        .with_ttl_ms(60_000)
        .with_cache_scope(rmcp::model::CacheScope::Private)
}
impl PersonalTools {
    async fn dispatch(&self, grant: Grant, name: &str, args: Value) -> Result<Value, String> {
        let state = self.app.state::<PersonalState>();
        let binding = state
            .binding(&grant.session_id)
            .ok_or("No personal session authorization")?;
        if binding.agent != grant.agent || !state.is_directory(&grant.cwd) {
            return Err("Personal token context mismatch".into());
        }
        let host = self.app.state::<Arc<AgentHost>>();
        let thread = host
            .history()
            .and_then(|h| {
                h.store().threads().into_iter().find(|t| {
                    t.thread_id.to_string() == binding.thread_id
                        && t.session_id
                            .as_ref()
                            .is_some_and(|id| id.to_string() == grant.session_id)
                })
            })
            .ok_or("Personal history binding no longer exists")?;
        if thread.agent_id.as_str() != binding.agent
            || !thread.folder_paths().contains(&state.directory)
        {
            return Err("Personal binding no longer matches the Agent".into());
        }
        let source = state.active_human(&grant.session_id);
        if name != "personal_context"
            && (host.task_run_origin(&grant.session_id).is_some() || source.is_none())
        {
            return Err("Personal writes require this session's admitted human turn; background writes are forbidden".into());
        }
        let thread = binding.thread_id;
        let result = match name {
            "personal_context" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Page {
                    #[serde(default)]
                    offset: usize,
                    query: Option<String>,
                    ids: Option<Vec<String>>,
                }
                let page: Page = serde_json::from_value(args).map_err(|e| e.to_string())?;
                if page.offset > 500
                    || page.query.as_ref().is_some_and(|q| q.chars().count() > 256)
                    || page
                        .ids
                        .as_ref()
                        .is_some_and(|ids| ids.len() > 18 || ids.iter().any(|id| id.len() > 128))
                {
                    return Err("Invalid personal memory query".into());
                }
                state.call(move |s| {
                    let all=s.memories()?;
                    let matched=crate::personal::recall::matching(&all,page.query.as_deref().unwrap_or(""),page.ids.as_deref());
                    let count=matched.len();let mut items=Vec::new();let mut consumed=0;let mut size=0;
                    for m in matched.into_iter().skip(page.offset).take(10) {
                        let item=serde_json::to_value(m)?;let length=serde_json::to_string(&item)?.chars().count();
                        if size+length>12_000 {
                            if items.is_empty() {items.push(json!({"id":m.id,"key":m.key,"truncated":true,"unavailable":"This entry exceeds the expansion budget; inspect it in the manual panel"}));consumed=1;}
                            break;
                        }
                        items.push(item);consumed+=1;size+=length;
                    }
                    let next=page.offset+consumed;
                    let candidates=s.memory_candidates()?.into_iter().take(5).map(|c|json!({"id":c.id,"revision":c.revision,"key":c.input.key,"proposedContentPreview":c.input.content.chars().take(256).collect::<String>(),"question":c.input.question,"state":"pending_user_confirmation"})).collect::<Vec<_>>();
                    let proposals=s.proposals()?.into_iter().take(5).map(|p|json!({"id":p.id,"revision":p.revision,"title":p.input.title,"questions":p.input.questions,"state":p.state})).collect::<Vec<_>>();
                    Ok(json!({"memories":items,"total":count,"nextOffset":if next<count {Some(next)}else{None},"memoryCandidates":candidates,"proposals":proposals,"currentHuman":s.human(&thread)?.filter(|(id,_)|Some(id)==source.as_ref()).map(|(id,text)|json!({"id":id,"text":text.chars().take(2000).collect::<String>(),"truncated":text.chars().count()>2000}))}))
                }).await?
            }
            "personal_remember" => {
                let input: MemoryInput = serde_json::from_value(args).map_err(|e| e.to_string())?;
                if source.as_deref() != Some(&input.source_message_id) {
                    return Err("Source is not the current human message".into());
                }
                state
                    .call(move |s| Ok(serde_json::to_value(s.learn(&thread, input)?)?))
                    .await?
            }
            "personal_forget" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Forget {
                    id: String,
                    expected_revision: u64,
                }
                let a: Forget = serde_json::from_value(args).map_err(|e| e.to_string())?;
                let source = source.ok_or("No human source")?;
                state
                    .call(move |s| {
                        s.require_source(&thread, &source)?;
                        s.forget(&a.id, a.expected_revision)
                    })
                    .await?;
                json!({"deletedSavedMemory":true,"chatsAndRemindersUnchanged":true})
            }
            "personal_propose_task" => {
                let input: ProposalInput =
                    serde_json::from_value(args).map_err(|e| e.to_string())?;
                let source = source.ok_or("No human source")?;
                state
                    .call(move |s| Ok(serde_json::to_value(s.propose(&thread, &source, input)?)?))
                    .await?
            }
            _ => return Err("Unknown personal tool".into()),
        };
        if name != "personal_context" {
            super::personal::changed(&self.app);
        }
        Ok(result)
    }
}
impl ServerHandler for PersonalTools {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(INSTRUCTIONS.to_owned())
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(tools_list())
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let grant = context
            .extensions
            .get::<axum::http::request::Parts>()
            .and_then(|p| p.extensions.get::<Grant>())
            .cloned()
            .ok_or_else(|| ErrorData::invalid_request("Missing session token", None))?;
        let args = Value::Object(request.arguments.unwrap_or_default());
        let result = match self.dispatch(grant, request.name.as_ref(), args).await {
            Ok(v) => CallToolResult::success(vec![ContentBlock::text(v.to_string())]),
            Err(e) => CallToolResult::error(vec![ContentBlock::text(e)]),
        };
        Ok(result.into())
    }
}
pub fn router(app: AppHandle) -> axum::Router {
    let service = StreamableHttpService::new(
        move || Ok(PersonalTools { app: app.clone() }),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    axum::Router::new().nest_service(PATH, service)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires ATLAS_CLAUDE_SDK_DIR; real MCP discovery, no model turn"]
    async fn claude_discovers_personal_and_task_tools() {
        use tokio::io::AsyncWriteExt;
        #[derive(Clone)]
        struct DiscoveryOnly(bool);
        impl ServerHandler for DiscoveryOnly {
            fn get_info(&self) -> ServerInfo {
                ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            }
            async fn list_tools(
                &self,
                _: Option<PaginatedRequestParams>,
                _: RequestContext<RoleServer>,
            ) -> Result<ListToolsResult, ErrorData> {
                Ok(if self.0 {
                    tools_list()
                } else {
                    super::super::task_server::tools_list()
                })
            }
        }
        let sdk =
            std::env::var("ATLAS_CLAUDE_SDK_DIR").expect("installed Claude Agent SDK directory");
        let tokens = Arc::new(super::super::memory_server::MemoryTokens::default());
        let token = tokens.mint("personal-discovery", "fixture-agent", "isolated-fixture");
        let mut config = json!({"token":token,"expectedTools":{}});
        let mut servers = Vec::new();
        for (name, personal) in [("personal", true), ("tasks", false)] {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .unwrap();
            config[name] = json!(format!("http://{}/mcp", listener.local_addr().unwrap()));
            let tools = if personal {
                tools_list()
            } else {
                super::super::task_server::tools_list()
            };
            config["expectedTools"][name] = json!(tools
                .tools
                .iter()
                .map(|t| t.name.to_string())
                .collect::<Vec<_>>());
            let service = StreamableHttpService::new(
                move || Ok(DiscoveryOnly(personal)),
                Arc::new(LocalSessionManager::default()),
                StreamableHttpServerConfig::default(),
            );
            let router = axum::Router::new().nest_service("/mcp", service).layer(
                axum::middleware::from_fn_with_state(
                    tokens.clone(),
                    super::super::memory_server::require_token,
                ),
            );
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
            .write_all(config.to_string().as_bytes())
            .await
            .unwrap();
        drop(stdin);
        let result =
            tokio::time::timeout(std::time::Duration::from_secs(60), child.wait_with_output())
                .await;
        for server in servers {
            server.abort();
        }
        let output = result.expect("MCP discovery completes").unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr).replace(&token, "[REDACTED]")
        );
        println!("{}", String::from_utf8_lossy(&output.stdout));
    }

    #[test]
    fn personal_discovery_includes_required_cache_metadata() {
        let wire = serde_json::to_value(tools_list()).unwrap();
        assert_eq!(wire["ttlMs"], 60_000);
        assert_eq!(wire["cacheScope"], "private");
        assert!(wire["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["name"] == "personal_remember"));
    }
    #[test]
    fn personal_schemas_do_not_allow_caller_selected_authorization() {
        for tool in specs() {
            assert_eq!(tool.input_schema["additionalProperties"], false);
            for forbidden in [
                "threadId",
                "sessionId",
                "scopeKey",
                "cwd",
                "agent",
                "executionThreadId",
                "relearn",
                "origin",
                "memoryEpoch",
            ] {
                assert!(tool.input_schema["properties"].get(forbidden).is_none());
            }
        }
        let forged = json!({"idempotencyKey":"rent","title":"Rent","prompt":"Pay rent","dueAt":1900000000000i64,"confirmed":true});
        assert!(serde_json::from_value::<ProposalInput>(forged).is_err());
    }
}
