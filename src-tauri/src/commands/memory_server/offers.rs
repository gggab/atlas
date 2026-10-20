//! Handing the server to sessions.
//!
//! Every agent that can take the server is handed it on each session request
//! ([`MemorySessionOffers`]): ACP sessions receive a credential-free stdio
//! entry forwarding to the local HTTP service (ADR-0020). The
//! token is minted for the *request*, before a new session's id exists, and
//! bound to the id once the agent answers; an offer that never binds is
//! revoked. Each decision is logged, one line per session request.

use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_agent_servers::{SessionMcpOffer, SessionMcpRequest, SessionMcpServers};

use super::host::{MemoryServerHost, SharingGate};
use super::MEMORY_SERVER_NAME;
use crate::commands::code_server::{CodeOffer, CodeOfferDecision, CODE_PATH, CODE_SERVER_NAME};
use crate::commands::memory_bridge::TokenFiles;

/// Whether one session request is handed the memory tool server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OfferDecision {
    /// Included as a stdio server through `atlas mcp-bridge`: the agent runs
    /// in another process (ADR-0020).
    IncludedViaBridge,
    /// Left out, and why.
    Omitted(&'static str),
}

impl OfferDecision {
    /// The one log line per session request: the agent, whether it advertised
    /// HTTP MCP, and whether the server was included (and if not, why).
    pub fn log_line(self, agent: &str, http_mcp: bool) -> String {
        match self {
            Self::IncludedViaBridge => format!(
                "memory tool server offer: agent={agent} http_mcp={http_mcp} memory_server=included_via_bridge"
            ),
            Self::Omitted(reason) => format!(
                "memory tool server offer: agent={agent} http_mcp={http_mcp} memory_server=omitted reason=\"{reason}\""
            ),
        }
    }

    /// Included through the mandatory ACP stdio transport when sharing and the server are available.
    pub fn decide(sharing_on: bool, server_running: bool) -> Self {
        if !sharing_on {
            Self::Omitted("shared memory is off for this project")
        } else if !server_running {
            Self::Omitted("memory tool server is not running")
        } else {
            Self::IncludedViaBridge
        }
    }
}

/// The argument that makes the Atlas binary the stdio bridge.
pub const BRIDGE_ARG: &str = "mcp-bridge";

/// `name` at `url` as a stdio server: `<this binary> mcp-bridge <url> <token
/// file>`. Nothing in the entry is secret: an adapter may put all of it,
/// `env` included, on a command line (ADR-0020).
fn bridge_entry(
    exe: &std::path::Path,
    name: &str,
    url: String,
    token_file: &std::path::Path,
) -> acp::McpServer {
    acp::McpServer::Stdio(acp::McpServerStdio::new(name, exe.to_path_buf()).args(vec![
        BRIDGE_ARG.to_string(),
        url,
        token_file.to_string_lossy().into_owned(),
    ]))
}

impl OfferDecision {
    fn includes(self) -> bool {
        matches!(self, Self::IncludedViaBridge)
    }
}

/// Offers shared memory when enabled, with SSH and Browser Use independently
/// of that setting. Every entry shares one session token:
/// separately minted tokens would revoke each other.
pub struct MemorySessionOffers {
    host: Arc<MemoryServerHost>,
    token_files: Arc<TokenFiles>,
    bridge_exe: Option<std::path::PathBuf>,
    gate: SharingGate,
    ssh: Option<Arc<crate::commands::ssh::SshState>>,
    browser: Option<Arc<crate::commands::browser_use::BrowserUseState>>,
    code: Option<CodeOffer>,
    tasks: Option<(
        Arc<crate::scheduler::Scheduler>,
        Arc<dyn Fn() -> bool + Send + Sync>,
    )>,
    personal_directory: Option<std::path::PathBuf>,
    personal_offers: Option<Arc<std::sync::Mutex<std::collections::HashSet<String>>>>,
}

impl MemorySessionOffers {
    pub fn new(host: Arc<MemoryServerHost>, gate: SharingGate) -> Self {
        Self {
            host,
            token_files: Arc::new(TokenFiles::in_temp()),
            bridge_exe: std::env::current_exe().ok(),
            gate,
            ssh: None,
            browser: None,
            code: None,
            tasks: None,
            personal_directory: None,
            personal_offers: None,
        }
    }

    pub fn with_token_files(mut self, files: Arc<TokenFiles>) -> Self {
        self.token_files = files;
        self
    }

    #[cfg(test)]
    pub fn with_bridge_exe(mut self, exe: Option<std::path::PathBuf>) -> Self {
        self.bridge_exe = exe;
        self
    }

    pub fn with_ssh(mut self, ssh: Arc<crate::commands::ssh::SshState>) -> Self {
        self.ssh = Some(ssh);
        self
    }

    pub fn with_browser(
        mut self,
        browser: Arc<crate::commands::browser_use::BrowserUseState>,
    ) -> Self {
        self.browser = Some(browser);
        self
    }

    /// Also offer the code tool server, mounted on this host at `/code`
    /// (ADR-0015). Its own setting decides, never the sharing gate.
    pub fn with_code(mut self, code: CodeOffer) -> Self {
        self.code = Some(code);
        self
    }

    pub fn with_tasks(
        mut self,
        scheduler: Arc<crate::scheduler::Scheduler>,
        gate: Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Self {
        self.tasks = Some((scheduler, gate));
        self
    }

    pub fn with_personal(
        mut self,
        directory: std::path::PathBuf,
        offers: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    ) -> Self {
        self.personal_directory = Some(directory);
        self.personal_offers = Some(offers);
        self
    }
}

impl SessionMcpServers for MemorySessionOffers {
    fn offer(&self, request: &SessionMcpRequest) -> SessionMcpOffer {
        let cwd = request.cwd.to_string_lossy().into_owned();
        let agent = request.agent_id.as_str().to_string();
        let personal = self
            .personal_directory
            .as_ref()
            .is_some_and(|dir| dir == &request.cwd);
        if personal {
            if let (Some(offers), Some(id)) = (&self.personal_offers, &request.session_id) {
                offers
                    .lock()
                    .expect("personal offers")
                    .remove(&id.to_string());
            }
        }
        // The gate reads the sharing file; only asked when it can matter.
        let sharing_on = !personal && (self.gate)(&cwd);
        let url = self.host.url();
        let decision = OfferDecision::decide(sharing_on, url.is_some());
        tracing::info!(
            target: "atlas::memory_server",
            session = request.session_id.as_ref().map(ToString::to_string).unwrap_or_default(),
            "{}",
            decision.log_line(&agent, request.http_mcp),
        );
        let code_url = self.host.url_at(CODE_PATH);
        let code = self.code.as_ref().map(|code| {
            let decision = code.decide(code_url.is_some());
            tracing::info!(
                target: "atlas::code_server",
                session = request.session_id.as_ref().map(ToString::to_string).unwrap_or_default(),
                "{}",
                decision.log_line(&agent, request.http_mcp),
            );
            decision
        });

        let mut entries: Vec<(&str, String)> = Vec::new();
        if let (true, Some(url)) = (decision.includes(), url) {
            entries.push((MEMORY_SERVER_NAME, url));
        }
        // SSH is offered even when shared memory is disabled.
        if !personal {
            if let Some(url) = self.ssh.as_ref().and_then(|ssh| ssh.url()) {
                entries.push(("atlas_ssh", url));
            }
            if let Some(url) = self.browser.as_ref().and_then(|browser| browser.url()) {
                entries.push(("atlas_browser", url));
            }
        }
        if let (false, Some(CodeOfferDecision::Included), Some(url)) = (personal, code, code_url) {
            entries.push((CODE_SERVER_NAME, url));
        }
        if personal {
            if let Some(url) = self.host.url_at(crate::commands::personal_server::PATH) {
                entries.push((crate::commands::personal_server::NAME, url));
            }
        }
        let task_url = self.host.url_at(crate::commands::task_server::PATH);
        let tasks_included =
            task_url.is_some() && self.tasks.as_ref().is_some_and(|(_, gate)| gate());
        if tasks_included {
            if let Some(url) = task_url {
                entries.push((crate::commands::task_server::NAME, url));
            }
        }
        if entries.is_empty() {
            return SessionMcpOffer::none();
        }
        // Mint once for all included servers, then bind to the actual session.
        let tokens = self.host.tokens().clone();
        let token = tokens.mint_unbound(&agent, &cwd);
        let Some(exe) = &self.bridge_exe else {
            tokens.revoke_token(&token);
            tracing::warn!("MCP tools unavailable: cannot locate the bridge executable");
            return SessionMcpOffer::none();
        };
        let token_file = match self
            .token_files
            .write(&token, |t| tokens.grant(t).is_some())
        {
            Ok(file) => file,
            Err(error) => {
                tokens.revoke_token(&token);
                tracing::warn!(
                    "MCP tools unavailable: cannot create private token file: {error:#}"
                );
                return SessionMcpOffer::none();
            }
        };
        let servers = entries
            .into_iter()
            .map(|(name, url)| bridge_entry(exe, name, url, &token_file))
            .collect();
        let token_files = self.token_files.clone();
        let scheduler = self.tasks.as_ref().map(|(scheduler, _)| scheduler.clone());
        let personal_offers = self.personal_offers.clone();
        let personal_included = personal
            && self
                .host
                .url_at(crate::commands::personal_server::PATH)
                .is_some();
        SessionMcpOffer::new(servers, move |session| match session {
            Some(id) => {
                tokens.bind(&token, &id.to_string());
                token_files.bind(&token_file, &id.to_string());
                if personal_included {
                    if let Some(offers) = &personal_offers {
                        offers
                            .lock()
                            .expect("personal offers")
                            .insert(id.to_string());
                    }
                }
                if let Some(scheduler) = &scheduler {
                    if tasks_included {
                        scheduler.note_offer(&id.to_string());
                    } else {
                        scheduler.forget_offer(&id.to_string());
                    }
                }
            }
            None => {
                tokens.revoke_token(&token);
                token_files.remove(&token_file);
            }
        })
    }
}
