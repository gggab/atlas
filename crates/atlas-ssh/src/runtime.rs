use crate::{Connection, CredentialStore, Result, Store};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::watch;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct Identity {
    pub session_id: String,
    pub agent: String,
    pub project: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Approval {
    pub id: String,
    pub caller: Identity,
    pub connection: Connection,
}

#[derive(Clone, Debug, Serialize)]
pub struct RemoteSession {
    pub id: String,
    pub caller: Identity,
    pub connection: Connection,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Job {
    pub id: String,
    pub remote_session: String,
    pub caller: Identity,
    pub connection_name: String,
    #[serde(default)]
    pub target: String,
    pub command: String,
    pub sudo: bool,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub status: String,
    pub exit_code: Option<u32>,
    pub output: String,
    pub truncated: bool,
}

#[derive(Serialize)]
pub struct Snapshot {
    pub connections: Vec<Connection>,
    pub approvals: Vec<Approval>,
    pub authorizations: Vec<Approval>,
    pub sessions: Vec<RemoteSession>,
    pub jobs: Vec<Job>,
}

struct LiveSession {
    info: RemoteSession,
    transport: Arc<tokio::sync::Mutex<crate::transport::Handle>>,
}

#[derive(Default)]
struct Live {
    approvals: HashMap<String, Approval>,
    allowed: HashSet<(Identity, String, String)>,
    denied: HashSet<(Identity, String, String)>,
    sessions: HashMap<String, LiveSession>,
    jobs: HashMap<String, Job>,
    stops: HashMap<String, watch::Sender<bool>>,
    ended: HashSet<String>,
    generations: HashMap<String, u64>,
}

pub struct Runtime {
    pub store: Arc<Store>,
    pub credentials: Arc<dyn CredentialStore>,
    // ponytail: serialize credential/config changes with connection setup;
    // use per-connection locks if concurrent setup becomes a bottleneck.
    pub management: tokio::sync::Mutex<()>,
    live: Mutex<Live>,
    approval_changes: watch::Sender<()>,
    changed: Arc<dyn Fn() + Send + Sync>,
}

fn key(caller: &Identity, connection: &Connection) -> (Identity, String, String) {
    (
        caller.clone(),
        connection.id.clone(),
        connection.revision.clone(),
    )
}

impl Runtime {
    pub fn new(
        store: Arc<Store>,
        credentials: Arc<dyn CredentialStore>,
        changed: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            store,
            credentials,
            management: tokio::sync::Mutex::new(()),
            live: Mutex::new(Live::default()),
            approval_changes: watch::channel(()).0,
            changed,
        }
    }
    pub fn changed(&self) {
        (self.changed)();
    }
    pub fn session_started(&self, session_id: &str) {
        let mut live = self.live.lock();
        if live.ended.remove(session_id) {
            live.denied.retain(|(s, _, _)| s.session_id != session_id);
        }
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        let live = self.live.lock();
        let mut jobs = self.store.history()?;
        let persisted: HashSet<_> = jobs.iter().map(|j| j.id.clone()).collect();
        jobs.retain(|j| !live.jobs.contains_key(&j.id));
        // Cleared results remain available to the agent, but not in the transcript.
        jobs.extend(
            live.jobs
                .values()
                .filter(|j| j.status == "running" || persisted.contains(&j.id))
                .cloned(),
        );
        jobs.sort_by_key(|j| std::cmp::Reverse(j.started_at));
        jobs.truncate(100);
        let authorizations = live
            .allowed
            .iter()
            .filter_map(|(caller, id, revision)| {
                self.store
                    .get(id)
                    .ok()
                    .filter(|c| &c.revision == revision)
                    .map(|connection| Approval {
                        id: id.clone(),
                        caller: caller.clone(),
                        connection,
                    })
            })
            .collect();
        Ok(Snapshot {
            connections: self.store.list()?,
            approvals: live.approvals.values().cloned().collect(),
            authorizations,
            sessions: live.sessions.values().map(|s| s.info.clone()).collect(),
            jobs,
        })
    }
    pub fn clear_history(&self, remote_session: Option<&str>) -> Result<()> {
        // Serialize with job start/finish so a running command is never removed.
        let live = self.live.lock();
        self.store.clear_history(remote_session)?;
        drop(live);
        self.changed();
        Ok(())
    }
    pub fn allowed(&self, caller: &Identity, connection: &Connection) -> bool {
        let live = self.live.lock();
        !live.ended.contains(&caller.session_id) && live.allowed.contains(&key(caller, connection))
    }
    pub fn decide(&self, id: &str, allow: bool) -> Result<()> {
        let mut live = self.live.lock();
        let approval = live
            .approvals
            .remove(id)
            .ok_or("This approval is no longer pending")?;
        self.approval_changes.send_replace(());
        let current = self.store.get(&approval.connection.id)?;
        if current.revision != approval.connection.revision
            || live.ended.contains(&approval.caller.session_id)
        {
            drop(live);
            self.changed();
            return Err("Connection or agent session changed; request again".into());
        }
        let k = key(&approval.caller, &current);
        if allow {
            live.allowed.insert(k);
        } else {
            live.denied.insert(k);
        }
        drop(live);
        self.changed();
        Ok(())
    }
    /// Keep the agent's tool call pending until Atlas has a user decision.
    pub async fn connect_after_approval(
        self: &Arc<Self>,
        caller: Identity,
        connection_id: &str,
    ) -> Result<serde_json::Value> {
        // Subscribe before requesting approval so even an immediate click is observed.
        let mut changes = self.approval_changes.subscribe();
        let connection = self.store.get(connection_id)?;
        let result = self.connect(caller.clone(), connection_id).await?;
        if result["status"] != "authorization_required" {
            return Ok(result);
        }
        let approval_id = result["approval_id"]
            .as_str()
            .ok_or("Missing SSH approval")?;
        loop {
            let allowed = {
                let live = self.live.lock();
                if live.ended.contains(&caller.session_id) {
                    return Err("Agent session ended while awaiting SSH authorization".into());
                }
                if self.store.get(connection_id)?.revision != connection.revision {
                    return Err("Connection configuration changed; request again".into());
                }
                if live.denied.contains(&key(&caller, &connection)) {
                    return Err("Connection access denied or revoked for this session".into());
                }
                let allowed = live.allowed.contains(&key(&caller, &connection));
                if !allowed && !live.approvals.contains_key(approval_id) {
                    return Err("SSH authorization request was cancelled; request again".into());
                }
                allowed
            };
            if allowed {
                let result = self.connect(caller.clone(), connection_id).await?;
                if result["status"] == "authorization_required" {
                    self.cancel_connection_request(&caller, connection_id);
                    return Err("Connection authorization changed; request again".into());
                }
                return Ok(result);
            }
            changes
                .changed()
                .await
                .map_err(|_| "SSH authorization wait ended")?;
        }
    }
    pub fn cancel_connection_request(&self, caller: &Identity, connection_id: &str) {
        self.live
            .lock()
            .approvals
            .retain(|_, a| !(a.caller == *caller && a.connection.id == connection_id));
        self.approval_changes.send_replace(());
        self.changed();
    }
    pub async fn connect(
        self: &Arc<Self>,
        caller: Identity,
        connection_id: &str,
    ) -> Result<serde_json::Value> {
        if caller.session_id.is_empty() {
            return Err("Agent session is not ready".into());
        }
        let c = self.store.get(connection_id)?;
        if c.fingerprint.is_none() {
            return Err(
                "Verify the server fingerprint in Remote connections before connecting".into(),
            );
        }
        let generation = {
            let mut live = self.live.lock();
            if live.ended.contains(&caller.session_id) {
                return Err("Agent session ended".into());
            }
            if live.denied.contains(&key(&caller, &c)) {
                return Err("Connection access denied or revoked for this session".into());
            }
            if !live.allowed.contains(&key(&caller, &c)) {
                let id = live
                    .approvals
                    .values()
                    .find(|a| {
                        a.caller == caller
                            && a.connection.id == c.id
                            && a.connection.revision == c.revision
                    })
                    .map(|a| a.id.clone())
                    .unwrap_or_else(|| {
                        let id = uuid::Uuid::new_v4().to_string();
                        live.approvals.insert(
                            id.clone(),
                            Approval {
                                id: id.clone(),
                                caller: caller.clone(),
                                connection: c.clone(),
                            },
                        );
                        id
                    });
                drop(live);
                self.changed();
                return Ok(
                    serde_json::json!({"status":"authorization_required","approval_id":id,"instruction":"Wait for the user to approve in Atlas, then call ssh_connect again. Do not retry a denied request."}),
                );
            }
            if let Some(s) = live.sessions.values().find(|s| {
                s.info.caller == caller
                    && s.info.connection.id == c.id
                    && s.info.connection.revision == c.revision
            }) {
                return Ok(serde_json::json!({"status":"connected","connection_handle":s.info.id}));
            }
            live.generations
                .get(&caller.session_id)
                .copied()
                .unwrap_or(0)
        };
        let _management = self.management.lock().await;
        if self.store.get(&c.id)?.revision != c.revision || !self.allowed(&caller, &c) {
            return Err("Connection authorization or configuration changed".into());
        }
        let credentials = self.credentials.clone();
        let id = c.id.clone();
        let password = tokio::task::spawn_blocking(move || credentials.get(&id, false))
            .await
            .map_err(|_| "Credential access failed")??;
        if !self.allowed(&caller, &c) {
            return Err("Connection authorization was revoked".into());
        }
        let transport = crate::transport::connect(&c, &password).await?;
        drop(password);
        let transport = Arc::new(tokio::sync::Mutex::new(transport));
        let handle = {
            let mut live = self.live.lock();
            let current = self.store.get(&c.id)?;
            if current.revision != c.revision
                || !live.allowed.contains(&key(&caller, &c))
                || live.ended.contains(&caller.session_id)
                || live
                    .generations
                    .get(&caller.session_id)
                    .copied()
                    .unwrap_or(0)
                    != generation
            {
                None
            } else {
                // Only successful authorized agent logins reach this write.
                self.store.associate(&caller.project, &c.id, false, false)?;
                let handle = uuid::Uuid::new_v4().to_string();
                live.sessions.insert(
                    handle.clone(),
                    LiveSession {
                        info: RemoteSession {
                            id: handle.clone(),
                            caller,
                            connection: c,
                        },
                        transport: transport.clone(),
                    },
                );
                Some(handle)
            }
        };
        if let Some(handle) = handle {
            self.changed();
            Ok(serde_json::json!({"status":"connected","connection_handle":handle}))
        } else {
            let _ = transport
                .lock()
                .await
                .disconnect(
                    russh::Disconnect::ByApplication,
                    "Authorization revoked",
                    "en",
                )
                .await;
            Err("Connection authorization was revoked or configuration changed".into())
        }
    }
    pub async fn test(&self, id: &str) -> Result<()> {
        let _management = self.management.lock().await;
        let c = self.store.get(id)?;
        let credentials = self.credentials.clone();
        let id = c.id.clone();
        let password = tokio::task::spawn_blocking(move || credentials.get(&id, false))
            .await
            .map_err(|_| "Credential access failed")??;
        let transport = crate::transport::connect(&c, &password).await?;
        let _ = transport
            .disconnect(
                russh::Disconnect::ByApplication,
                "Connection test complete",
                "en",
            )
            .await;
        Ok(())
    }
    fn session(
        &self,
        caller: &Identity,
        id: &str,
    ) -> Result<(
        RemoteSession,
        Arc<tokio::sync::Mutex<crate::transport::Handle>>,
    )> {
        let live = self.live.lock();
        let s = live.sessions.get(id).ok_or("SSH session not found")?;
        if &s.info.caller != caller
            || live.ended.contains(&caller.session_id)
            || !live.allowed.contains(&key(caller, &s.info.connection))
        {
            return Err("SSH session belongs to another caller or was revoked".into());
        }
        let current = self.store.get(&s.info.connection.id)?;
        if current.revision != s.info.connection.revision {
            return Err("SSH connection configuration changed".into());
        }
        Ok((s.info.clone(), s.transport.clone()))
    }
    pub async fn exec(
        self: &Arc<Self>,
        caller: &Identity,
        handle: &str,
        command: String,
        sudo: bool,
        timeout_seconds: u64,
    ) -> Result<Job> {
        if command.trim().is_empty() || command.len() > 64 * 1024 || command.contains('\0') {
            return Err("Command must be nonempty and at most 64 KiB".into());
        }
        if !(1..=86400).contains(&timeout_seconds) {
            return Err("Timeout must be 1–86400 seconds".into());
        }
        let _management = self.management.lock().await;
        let (session, transport) = self.session(caller, handle)?;
        let credentials = self.credentials.clone();
        let c = session.connection.clone();
        let secrets = tokio::task::spawn_blocking(move || {
            let login = credentials.get(&c.id, false)?;
            let elevation = if sudo {
                Some(if c.has_sudo_password {
                    credentials.get(&c.id, true)?
                } else {
                    zeroize::Zeroizing::new(login.to_string())
                })
            } else {
                None
            };
            Ok::<_, String>((login, elevation))
        })
        .await
        .map_err(|_| "Credential access failed")??;
        let channel = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            transport.lock().await.channel_open_session().await
        })
        .await
        .map_err(|_| "SSH command channel timed out; disconnect before reconnecting")?
        .map_err(|_| "Cannot open SSH command channel")?;
        let command = zeroize::Zeroizing::new(command);
        let job = Job {
            id: uuid::Uuid::new_v4().to_string(),
            remote_session: handle.into(),
            caller: caller.clone(),
            connection_name: session.connection.name.clone(),
            target: format!(
                "{}@{}:{}",
                session.connection.username, session.connection.host, session.connection.port
            ),
            command: crate::transport::redact(
                &command,
                &secrets.0,
                secrets.1.as_deref().map(|s| s.as_str()),
            ),
            sudo,
            started_at: crate::store::now(),
            finished_at: None,
            status: "running".into(),
            exit_code: None,
            output: String::new(),
            truncated: false,
        };
        let (stop, receiver) = watch::channel(false);
        {
            let mut live = self.live.lock();
            if !live.sessions.contains_key(handle)
                || !live.allowed.contains(&key(caller, &session.connection))
                || live.ended.contains(&caller.session_id)
            {
                return Err("SSH access revoked before execution".into());
            }
            self.store.save_job(&job)?;
            live.stops.insert(job.id.clone(), stop);
            live.jobs.insert(job.id.clone(), job.clone());
        }
        let runtime = self.clone();
        let id = job.id.clone();
        tokio::spawn(async move {
            crate::transport::run(
                runtime,
                id,
                channel,
                command,
                secrets,
                receiver,
                timeout_seconds,
            )
            .await;
        });
        self.changed();
        Ok(job)
    }
    pub fn job(&self, caller: &Identity, id: &str) -> Result<Job> {
        let live = self.live.lock();
        let job = live
            .jobs
            .get(id)
            .ok_or("SSH task not found in this app session")?;
        if &job.caller != caller || live.ended.contains(&caller.session_id) {
            return Err("SSH task belongs to another session".into());
        }
        Ok(job.clone())
    }
    pub fn cancel(&self, caller: Option<&Identity>, id: &str) -> Result<()> {
        let live = self.live.lock();
        let job = live.jobs.get(id).ok_or("SSH task not found")?;
        if caller.is_some_and(|c| &job.caller != c || live.ended.contains(&c.session_id)) {
            return Err("SSH task belongs to another session".into());
        }
        if let Some(stop) = live.stops.get(id) {
            let _ = stop.send(true);
        }
        Ok(())
    }
    pub async fn disconnect(&self, caller: Option<&Identity>, id: &str) -> Result<()> {
        let transport = {
            let mut live = self.live.lock();
            let s = live.sessions.get(id).ok_or("SSH session not found")?;
            if caller.is_some_and(|c| &s.info.caller != c) {
                return Err("SSH session belongs to another caller".into());
            }
            let s = live.sessions.remove(id).ok_or("SSH session not found")?;
            for (job_id, j) in &live.jobs {
                if j.remote_session == id {
                    if let Some(stop) = live.stops.get(job_id) {
                        let _ = stop.send(true);
                    }
                }
            }
            s.transport
        };
        let _ = transport
            .lock()
            .await
            .disconnect(russh::Disconnect::ByApplication, "Disconnected", "en")
            .await;
        self.changed();
        Ok(())
    }
    /// Authority and cancellation change synchronously. The returned future
    /// only closes detached transports, so UI threads need no Tokio context.
    pub fn revoke(
        self: &Arc<Self>,
        session_id: &str,
        connection_id: Option<&str>,
        ended: bool,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
        let transports = {
            let mut live = self.live.lock();
            *live.generations.entry(session_id.into()).or_default() += 1;
            if ended {
                live.ended.insert(session_id.into());
            }
            let keys: Vec<_> = live
                .allowed
                .iter()
                .filter(|(s, c, _)| {
                    s.session_id == session_id && connection_id.is_none_or(|id| c == id)
                })
                .cloned()
                .collect();
            for k in keys {
                live.allowed.remove(&k);
                live.denied.insert(k);
            }
            live.approvals.retain(|_, a| {
                !(a.caller.session_id == session_id
                    && connection_id.is_none_or(|id| a.connection.id == id))
            });
            let handles = live
                .sessions
                .values()
                .filter(|s| {
                    s.info.caller.session_id == session_id
                        && connection_id.is_none_or(|id| s.info.connection.id == id)
                })
                .map(|s| s.info.id.clone())
                .collect::<Vec<_>>();
            let mut transports = Vec::new();
            for handle in handles {
                if let Some(s) = live.sessions.remove(&handle) {
                    transports.push(s.transport);
                }
                for (id, job) in &live.jobs {
                    if job.remote_session == handle {
                        if let Some(stop) = live.stops.get(id) {
                            let _ = stop.send(true);
                        }
                    }
                }
            }
            transports
        };
        self.approval_changes.send_replace(());
        self.changed();
        async move {
            for transport in transports {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    let _ = transport
                        .lock()
                        .await
                        .disconnect(
                            russh::Disconnect::ByApplication,
                            "Authorization revoked",
                            "en",
                        )
                        .await;
                })
                .await;
            }
        }
    }
    pub fn invalidate(
        self: &Arc<Self>,
        connection_id: &str,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
        let sessions = {
            let mut live = self.live.lock();
            live.approvals
                .retain(|_, a| a.connection.id != connection_id);
            live.allowed
                .iter()
                .filter(|(_, c, _)| c == connection_id)
                .map(|(s, _, _)| s.session_id.clone())
                .collect::<Vec<_>>()
        };
        let cleanup: Vec<_> = sessions
            .iter()
            .map(|s| self.revoke(s, Some(connection_id), false))
            .collect();
        self.approval_changes.send_replace(());
        async move {
            for close in cleanup {
                close.await;
            }
        }
    }
    pub(crate) fn output(&self, id: &str, text: &str) {
        let mut live = self.live.lock();
        if let Some(job) = live.jobs.get_mut(id) {
            const MAX_OUTPUT: usize = 1024 * 1024;
            if job.output.len() + text.len() <= MAX_OUTPUT {
                job.output.push_str(text);
            } else {
                job.truncated = true;
            }
        }
        drop(live);
        self.changed();
    }
    pub(crate) fn finish(&self, id: &str, status: &str, exit_code: Option<u32>) {
        let mut live = self.live.lock();
        live.stops.remove(id);
        if let Some(job) = live.jobs.get_mut(id) {
            job.status = status.into();
            job.exit_code = exit_code;
            job.finished_at = Some(crate::store::now());
            let _ = self.store.save_job(job);
        }
        // ponytail: retain the last 100 completed jobs; add pagination only if needed.
        if live.jobs.len() > 100 {
            if let Some(old) = live
                .jobs
                .values()
                .filter(|j| j.status != "running")
                .min_by_key(|j| j.started_at)
                .map(|j| j.id.clone())
            {
                live.jobs.remove(&old);
            }
        }
        drop(live);
        self.changed();
    }
}
