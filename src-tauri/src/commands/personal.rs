use super::agent_host::{AgentHost, SessionKey};
use crate::personal::{store::*, PersonalState};
use crate::scheduler::{model::*, Scheduler};
use atlas_agent_wire::AgentId;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalSnapshot {
    pub directory: String,
    pub current_thread_id: Option<String>,
    pub conversations: Vec<Binding>,
    pub history: Vec<PersonalHistory>,
    pub memories: Vec<Memory>,
    pub memory_candidates: Vec<MemoryCandidate>,
    pub proposals: Vec<Proposal>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalHistory {
    session_id: String,
    messages: Vec<atlas_agent_wire::Message>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalSession {
    key: SessionKey,
    directory: String,
    context_restarted: bool,
    tools_available: bool,
    snapshot: super::agent_host::SessionSnapshot,
}

#[tauri::command]
pub async fn personal_snapshot(app: AppHandle) -> Result<PersonalSnapshot, String> {
    let state = app.state::<PersonalState>();
    let directory = state.directory.to_string_lossy().into_owned();
    let (mut snapshot, transcript_sessions) = state
        .call(move |s| {
            Ok((
                PersonalSnapshot {
                    directory,
                    current_thread_id: s.current()?,
                    conversations: s.bindings()?,
                    history: Vec::new(),
                    memories: s.memories()?,
                    memory_candidates: s.memory_candidates()?,
                    proposals: s.proposals()?,
                },
                s.transcript_sessions()?,
            ))
        })
        .await?;
    let transcripts = app
        .state::<Arc<super::agent_transcript::TranscriptState>>()
        .inner()
        .clone();
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let cwd = snapshot.directory.clone();
    snapshot.history = tauri::async_runtime::spawn_blocking(move || {
        transcript_sessions
            .into_iter()
            .map(|session_id| {
                let transcript = match transcripts.snapshot(&session_id) {
                    Some(live) => Some(live),
                    None => super::agent_transcript::read_checked(&config, &cwd, &session_id)
                        .map_err(|e| format!("Personal chat history could not be read: {e}"))?,
                };
                Ok(PersonalHistory {
                    session_id,
                    messages: transcript
                        .map(super::agents::transcript_to_messages)
                        .unwrap_or_default(),
                })
            })
            .collect::<Result<Vec<_>, String>>()
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(snapshot)
}

#[tauri::command]
pub async fn personal_session(
    agent_id: Option<AgentId>,
    thread_id: Option<String>,
    app: AppHandle,
) -> Result<PersonalSession, String> {
    let state = app.state::<PersonalState>();
    // Surface initialization failure before starting a vendor session.
    state.call(|_| Ok(())).await?;
    let host = app.state::<Arc<AgentHost>>();
    let (key, context_restarted) = if let Some(thread_id) = thread_id {
        if !state.owns_thread(&thread_id) {
            return Err("Not a personal conversation".into());
        }
        let binding = state
            .call(move |s| {
                s.bindings()?
                    .into_iter()
                    .find(|b| b.thread_id == thread_id)
                    .ok_or_else(|| anyhow::anyhow!("Personal binding no longer exists"))
            })
            .await?;
        let agent = host
            .spawn(&binding.agent)
            .await
            .map_err(|e| e.to_string())?;
        let key = SessionKey {
            agent_id: agent.agent_id,
            session_id: binding.session_id.clone(),
        };
        if host.snapshot_meta(&key).is_err() {
            let capabilities = host.capabilities(&binding.agent);
            if capabilities.supports_load_session || capabilities.supports_resume_session {
                let resumed = host
                    .resume_thread(
                        binding
                            .thread_id
                            .parse()
                            .map_err(|e| format!("Invalid personal binding: {e}"))?,
                    )
                    .await
                    .map_err(|e| e.to_string())?;
                (resumed.key, false)
            } else {
                // The fixed chat owns its history; this only replaces an unsupported CLI execution context.
                let created = host
                    .new_session(agent.agent_id, state.directory.clone(), Vec::new())
                    .await
                    .map_err(|e| e.to_string())?;
                (created.key, true)
            }
        } else {
            (key, false)
        }
    } else {
        let agent_id = agent_id.ok_or("Choose an installed Agent")?;
        let created = host
            .new_session(agent_id, state.directory.clone(), Vec::new())
            .await
            .map_err(|e| e.to_string())?;
        (created.key, false)
    };
    let meta = host.snapshot_meta(&key).map_err(|e| e.to_string())?;
    if !state.is_directory(&meta.cwd) {
        return Err("Personal conversation directory mismatch".into());
    }
    let thread = host
        .history()
        .and_then(|h| {
            h.thread_for_session(&agent_client_protocol::schema::v1::SessionId::new(
                key.session_id.as_str(),
            ))
        })
        .ok_or("Personal conversation was not recorded")?;
    let personal_thread = thread.thread_id.to_string();
    state
        .bind(Binding {
            thread_id: thread.thread_id.to_string(),
            session_id: key.session_id.clone(),
            agent: meta.plugin_id,
        })
        .await?;
    let tools_available = state.tools_available(&key.session_id);
    let sources = state
        .call(move |s| s.human_sources(&personal_thread))
        .await?;
    let originals = sources
        .values()
        .map(String::as_str)
        .collect::<std::collections::HashSet<_>>();
    let mut snapshot = host.snapshot(&key).map_err(|e| e.to_string())?;
    for message in &mut snapshot.messages {
        if message.role == atlas_agent_wire::MessageRole::User {
            if let Some(prose) =
                crate::personal::replay::human_prose(&message.content, &sources, &originals)
            {
                message.content = prose.to_owned();
            }
        }
    }
    Ok(PersonalSession {
        key,
        directory: meta.cwd,
        context_restarted,
        tools_available,
        snapshot,
    })
}

#[tauri::command]
pub async fn personal_save_memory(
    mut input: MemoryInput,
    relearn: Option<bool>,
    app: AppHandle,
) -> Result<Memory, String> {
    let source = uuid::Uuid::new_v4().to_string();
    input.source_message_id = source.clone();
    input.evidence_quote = input.content.chars().take(512).collect();
    let result = app
        .state::<PersonalState>()
        .call(move |s| {
            s.note_human("ui", &source, &input.content)?;
            if relearn.unwrap_or(false) {
                s.relearn("ui", input)
            } else {
                s.remember("ui", input)
            }
        })
        .await?;
    changed(&app);
    Ok(result)
}

#[tauri::command]
pub async fn personal_confirm_memory(
    id: String,
    revision: u64,
    app: AppHandle,
) -> Result<Memory, String> {
    let saved = app
        .state::<PersonalState>()
        .call(move |s| s.confirm_memory(&id, revision))
        .await?;
    changed(&app);
    Ok(saved)
}

#[tauri::command]
pub async fn personal_dismiss_memory(
    id: String,
    revision: u64,
    app: AppHandle,
) -> Result<(), String> {
    app.state::<PersonalState>()
        .call(move |s| s.dismiss_memory(&id, revision))
        .await?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn personal_forget_memory(
    id: String,
    revision: u64,
    app: AppHandle,
) -> Result<(), String> {
    app.state::<PersonalState>()
        .call(move |s| s.forget(&id, revision))
        .await?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn personal_confirm_proposal(
    id: String,
    revision: u64,
    app: AppHandle,
) -> Result<Task, String> {
    let scheduler = Scheduler::get(&app)?;
    let state = app.state::<PersonalState>();
    let _confirmation = state.confirmations.lock().await;
    let proposal_id = id.clone();
    let proposal = app
        .state::<PersonalState>()
        .call(move |s| s.claim_proposal(&proposal_id, revision))
        .await?;
    if let Some(task_id) = proposal.task_id {
        return scheduler.call(move |s| s.get(&task_id)).await;
    }
    let input = crate::personal::proposal_task(&proposal);
    let result = scheduler
        .call(move |s| s.upsert(input, crate::scheduler::now()))
        .await;
    match result {
        Ok(task) => {
            scheduler.changed();
            let task_id = task.id.clone();
            app.state::<PersonalState>().call(move |s|s.settle_proposal(&id,revision,Some(&task_id))).await.map_err(|e|format!("Reminder registered; proposal receipt update failed: {e}. Retry confirmation to reconcile."))?;
            changed(&app);
            Ok(task)
        }
        Err(error) => {
            app.state::<PersonalState>()
                .call(move |s| s.settle_proposal(&id, revision, None))
                .await
                .map_err(|e| format!("Registration failed: {error}; draft recovery failed: {e}"))?;
            changed(&app);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn personal_dismiss_proposal(
    id: String,
    revision: u64,
    app: AppHandle,
) -> Result<(), String> {
    app.state::<PersonalState>()
        .call(move |s| s.dismiss_proposal(&id, revision))
        .await?;
    changed(&app);
    Ok(())
}

pub fn changed(app: &AppHandle) {
    use tauri::Emitter;
    let _ = app.emit("atlas:personal-changed", ());
}
