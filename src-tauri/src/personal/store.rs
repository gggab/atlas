use anyhow::{bail, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub thread_id: String,
    pub session_id: String,
    pub agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub id: String,
    pub revision: u64,
    pub key: String,
    pub kind: String,
    pub content: String,
    pub confirmed: bool,
    pub source_message_id: String,
    pub source_thread_id: String,
    pub updated_at: i64,
    #[serde(default = "manual_origin")]
    pub origin: String,
    #[serde(default)]
    pub evidence_quote: String,
    #[serde(default)]
    pub core: bool,
}

fn manual_origin() -> String {
    "manual".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryInput {
    pub id: Option<String>,
    pub expected_revision: Option<u64>,
    pub key: String,
    pub kind: String,
    pub content: String,
    pub confirmed: bool,
    pub source_message_id: String,
    #[serde(default)]
    pub evidence_quote: String,
    #[serde(default)]
    pub core: Option<bool>,
    #[serde(default)]
    pub question: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCandidate {
    pub id: String,
    pub revision: u64,
    pub input: MemoryInput,
    pub source_thread_id: String,
    pub created_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearnReceipt {
    pub saved: Option<Memory>,
    pub candidate: Option<MemoryCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProposalInput {
    pub id: Option<String>,
    pub expected_revision: Option<u64>,
    #[serde(rename = "idempotencyKey")]
    pub key: String,
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub due_at: i64,
    pub calendar: Option<crate::scheduler::calendar::CalendarSpec>,
    pub interval_minutes: Option<u16>,
    #[serde(default)]
    pub questions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub revision: u64,
    pub input: ProposalInput,
    pub source_thread_id: String,
    pub source_message_id: String,
    pub state: String,
    pub task_id: Option<String>,
}

pub struct Store {
    pub(super) db: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::initialize(Connection::open(path)?)
    }
    #[cfg(test)]
    pub fn open_memory() -> Result<Self> {
        Self::initialize(Connection::open_in_memory()?)
    }
    fn initialize(mut db: Connection) -> Result<Self> {
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS personal_sessions(thread_id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE,agent TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS personal_transcripts(session_id TEXT PRIMARY KEY);
            INSERT OR IGNORE INTO personal_transcripts SELECT session_id FROM personal_sessions;
            CREATE TABLE IF NOT EXISTS personal_humans(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,text TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS personal_humans_thread ON personal_humans(thread_id);
            CREATE TABLE IF NOT EXISTS personal_memories(id TEXT PRIMARY KEY,entry_key TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS personal_proposals(id TEXT PRIMARY KEY,entry_key TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS personal_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);")?;
        super::memory::initialize(&mut db)?;
        Ok(Self { db })
    }
    pub fn bindings(&self) -> Result<Vec<Binding>> {
        let mut q = self
            .db
            .prepare("SELECT thread_id,session_id,agent FROM personal_sessions ORDER BY rowid")?;
        let rows = q
            .query_map([], |r| {
                Ok(Binding {
                    thread_id: r.get(0)?,
                    session_id: r.get(1)?,
                    agent: r.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }
    pub fn bind(&mut self, thread: &str, session: &str, agent: &str) -> Result<()> {
        if let Some(old) = self.bindings()?.into_iter().find(|b| b.thread_id == thread) {
            ensure!(
                old.agent == agent,
                "Personal conversation agent cannot change"
            );
        }
        let tx = self.db.transaction()?;
        tx.execute(
            "INSERT OR IGNORE INTO personal_transcripts VALUES(?1)",
            [session],
        )?;
        tx.execute("INSERT INTO personal_sessions VALUES(?1,?2,?3) ON CONFLICT(thread_id) DO UPDATE SET session_id=excluded.session_id", params![thread,session,agent])?;
        tx.execute("INSERT INTO personal_meta VALUES('current',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [thread])?;
        tx.commit()?;
        Ok(())
    }
    pub fn transcript_sessions(&self) -> Result<Vec<String>> {
        let mut q = self
            .db
            .prepare("SELECT session_id FROM personal_transcripts ORDER BY rowid")?;
        let sessions = q
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(sessions)
    }
    pub fn current(&self) -> Result<Option<String>> {
        Ok(self
            .db
            .query_row(
                "SELECT value FROM personal_meta WHERE key='current'",
                [],
                |r| r.get(0),
            )
            .optional()?)
    }
    pub fn note_human(&mut self, thread: &str, id: &str, text: &str) -> Result<()> {
        ensure!(
            thread == "ui" || self.bindings()?.iter().any(|b| b.thread_id == thread),
            "Not a personal conversation"
        );
        ensure!(
            !text.trim().is_empty() && text.len() <= 256_000,
            "Personal message is empty or too large"
        );
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let epoch = super::memory::clock(&tx)?;
        tx.execute(
            "INSERT INTO personal_humans(id,thread_id,text,memory_epoch) VALUES(?1,?2,?3,?4)",
            params![id, thread, text, epoch],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn human(&self, thread: &str) -> Result<Option<(String, String)>> {
        Ok(self.db.query_row("SELECT id,text FROM personal_humans WHERE thread_id=?1 ORDER BY rowid DESC LIMIT 1", [thread], |r| Ok((r.get(0)?, r.get(1)?))).optional()?)
    }
    pub fn human_sources(&self, thread: &str) -> Result<std::collections::HashMap<String, String>> {
        let mut q = self
            .db
            .prepare("SELECT id,text FROM personal_humans WHERE thread_id=?1")?;
        let rows = q
            .query_map([thread], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }
    pub fn require_source(&self, thread: &str, source: &str) -> Result<()> {
        ensure!(
            self.human(thread)?.is_some_and(|(id, _)| id == source),
            "Source must be this conversation's current admitted human message"
        );
        Ok(())
    }
    pub fn memories(&self) -> Result<Vec<Memory>> {
        let mut memories: Vec<Memory> = self.read_all("SELECT data FROM personal_memories")?;
        memories.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(a.id.cmp(&b.id)));
        Ok(memories)
    }
    pub(super) fn read_all<T: serde::de::DeserializeOwned>(&self, sql: &str) -> Result<Vec<T>> {
        let mut q = self.db.prepare(sql)?;
        let rows = q
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|row| Ok(serde_json::from_str(&row)?))
            .collect()
    }
    pub fn proposals(&self) -> Result<Vec<Proposal>> {
        Ok(self
            .read_all::<Proposal>("SELECT data FROM personal_proposals ORDER BY rowid DESC")?
            .into_iter()
            .filter(|p| p.state != "registered" && p.state != "dismissed")
            .collect())
    }
    pub fn propose(
        &mut self,
        thread: &str,
        source: &str,
        input: ProposalInput,
    ) -> Result<Proposal> {
        self.require_source(thread, source)?;
        ensure!(
            !input.key.is_empty()
                && input.key.len() <= 128
                && !input.title.trim().is_empty()
                && input.title.len() <= 200
                && !input.prompt.trim().is_empty()
                && input.prompt.len() <= 8192,
            "Invalid proposal"
        );
        ensure!(
            input.questions.len() <= 8
                && input
                    .questions
                    .iter()
                    .all(|q| !q.trim().is_empty() && q.len() <= 500),
            "Invalid clarification questions"
        );
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let old: Option<String> = tx
            .query_row(
                "SELECT data FROM personal_proposals WHERE id=?1 OR entry_key=?2",
                params![input.id, input.key],
                |r| r.get(0),
            )
            .optional()?;
        let old: Option<Proposal> = old.map(|s| serde_json::from_str(&s)).transpose()?;
        if let Some(old) = &old {
            if input.id.is_none()
                && serde_json::to_value(&old.input)? == serde_json::to_value(&input)?
            {
                return Ok(old.clone());
            }
            ensure!(
                old.state == "pending"
                    && input.id.as_deref() == Some(&old.id)
                    && input.expected_revision == Some(old.revision),
                "Proposal revision conflict or registration already started"
            );
        } else {
            ensure!(
                input.id.is_none() && input.expected_revision.is_none(),
                "Proposal no longer exists"
            );
            let count: i64 = tx.query_row("SELECT count(*) FROM personal_proposals WHERE json_extract(data,'$.state') IN ('pending','registering')", [], |r|r.get(0))?;
            ensure!(count < 100, "Proposal limit reached");
        }
        let saved = Proposal {
            id: old
                .as_ref()
                .map(|p| p.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            revision: old.map_or(1, |p| p.revision + 1),
            input,
            source_thread_id: thread.into(),
            source_message_id: source.into(),
            state: "pending".into(),
            task_id: None,
        };
        tx.execute("INSERT INTO personal_proposals VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET entry_key=excluded.entry_key,data=excluded.data", params![saved.id,saved.input.key,serde_json::to_string(&saved)?])?;
        tx.commit()?;
        Ok(saved)
    }
    pub fn proposal_for_confirmation(&self, id: &str, revision: u64) -> Result<Proposal> {
        Self::checked_proposal(&self.db, id, revision)
    }
    fn checked_proposal(db: &Connection, id: &str, revision: u64) -> Result<Proposal> {
        let data: String = db.query_row(
            "SELECT data FROM personal_proposals WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        let p: Proposal = serde_json::from_str(&data)?;
        ensure!(
            p.revision == revision
                && matches!(p.state.as_str(), "pending" | "registering" | "registered"),
            "Proposal revision conflict or already handled"
        );
        ensure!(
            p.input.questions.is_empty(),
            "Answer the proposal's clarification questions first"
        );
        Ok(p)
    }
    pub fn claim_proposal(&mut self, id: &str, revision: u64) -> Result<Proposal> {
        // Hold a write transaction across the read/freeze boundary, including
        // when another window is editing the same persistent draft.
        let tx = self
            .db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut p = Self::checked_proposal(&tx, id, revision)?;
        if p.state == "registered" {
            return Ok(p);
        }
        p.state = "registering".into();
        tx.execute(
            "UPDATE personal_proposals SET data=?2 WHERE id=?1",
            params![p.id, serde_json::to_string(&p)?],
        )?;
        tx.commit()?;
        Ok(p)
    }
    pub fn settle_proposal(&mut self, id: &str, revision: u64, task: Option<&str>) -> Result<()> {
        let mut p = self.proposal_for_confirmation(id, revision)?;
        if p.state == "registered" {
            ensure!(p.task_id.as_deref() == task, "Proposal already registered");
            return Ok(());
        }
        p.state = if task.is_some() {
            "registered"
        } else {
            "pending"
        }
        .into();
        p.task_id = task.map(str::to_owned);
        self.save_proposal(&p)
    }
    pub fn dismiss_proposal(&mut self, id: &str, revision: u64) -> Result<()> {
        let data: String = self.db.query_row(
            "SELECT data FROM personal_proposals WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        let mut p: Proposal = serde_json::from_str(&data)?;
        if p.revision != revision || p.state != "pending" {
            bail!("Proposal revision conflict or registration already started");
        }
        p.state = "dismissed".into();
        self.save_proposal(&p)
    }
    fn save_proposal(&mut self, p: &Proposal) -> Result<()> {
        self.db.execute(
            "UPDATE personal_proposals SET data=?2 WHERE id=?1",
            params![p.id, serde_json::to_string(p)?],
        )?;
        Ok(())
    }
}
