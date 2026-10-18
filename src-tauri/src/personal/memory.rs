use super::store::*;
use anyhow::{ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};

pub(super) fn initialize(db: &mut Connection) -> Result<()> {
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let version: i64 = tx.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    ensure!(
        version <= 1,
        "Personal memory schema is newer than this application"
    );
    if version == 0 {
        tx.execute_batch(
            "ALTER TABLE personal_humans ADD COLUMN memory_epoch INTEGER NOT NULL DEFAULT 0;
            PRAGMA user_version=1;",
        )?;
    }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS personal_memory_keys(key_hash TEXT PRIMARY KEY,deleted INTEGER NOT NULL,last_changed_clock INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS personal_memory_candidates(id TEXT PRIMARY KEY,entry_key TEXT NOT NULL UNIQUE,key_hash TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS personal_memory_candidate_key ON personal_memory_candidates(key_hash);")?;
    tx.commit()?;
    Ok(())
}

pub(super) fn clock(db: &Connection) -> Result<i64> {
    let value: Option<String> = db
        .query_row(
            "SELECT value FROM personal_meta WHERE key='memory_clock'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    let clock = value.map(|s| s.parse::<i64>()).transpose()?.unwrap_or(0);
    ensure!(clock >= 0, "Invalid memory clock");
    Ok(clock)
}
fn key_hash(key: &str) -> String {
    format!("{:x}", Sha256::digest(key.as_bytes()))
}
fn stamp(db: &Connection, key: &str, deleted: bool) -> Result<()> {
    let next = clock(db)?
        .checked_add(1)
        .context("Memory clock exhausted")?;
    db.execute("INSERT INTO personal_meta VALUES('memory_clock',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [next.to_string()])?;
    db.execute("INSERT INTO personal_memory_keys VALUES(?1,?2,?3) ON CONFLICT(key_hash) DO UPDATE SET deleted=excluded.deleted,last_changed_clock=excluded.last_changed_clock",params![key_hash(key),deleted,next])?;
    db.execute(
        "DELETE FROM personal_memory_candidates WHERE key_hash=?1",
        [key_hash(key)],
    )?;
    Ok(())
}
fn barrier(db: &Connection, key: &str, epoch: i64, allow_relearn: bool) -> Result<bool> {
    let row: Option<(bool, i64)> = db
        .query_row(
            "SELECT deleted,last_changed_clock FROM personal_memory_keys WHERE key_hash=?1",
            [key_hash(key)],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((deleted, last)) = row {
        ensure!(last<=epoch,"Memory changed after this source was admitted; use a fresh message or the manual editor");
        ensure!(!deleted||allow_relearn,"This memory was forgotten; re-learning requires explicit confirmation in the manual editor");
        return Ok(deleted);
    }
    Ok(false)
}
fn source(db: &Connection, thread: &str, id: &str, latest: bool) -> Result<(String, i64)> {
    let row: Option<(String, i64)> = db
        .query_row(
            "SELECT text,memory_epoch FROM personal_humans WHERE id=?1 AND thread_id=?2",
            params![id, thread],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let row = row.context("No real human source in this personal conversation")?;
    if latest {
        let current: String = db.query_row(
            "SELECT id FROM personal_humans WHERE thread_id=?1 ORDER BY rowid DESC LIMIT 1",
            [thread],
            |r| r.get(0),
        )?;
        ensure!(
            current == id,
            "Source must be this conversation's current admitted human message"
        );
    }
    Ok(row)
}
fn validate(input: &MemoryInput) -> Result<()> {
    ensure!(
        matches!(input.kind.as_str(), "fact" | "preference"),
        "Unknown memory kind"
    );
    ensure!(
        !input.key.trim().is_empty() && input.key.len() <= 128,
        "Invalid memory key"
    );
    ensure!(
        !input.content.trim().is_empty() && input.content.len() <= 4096,
        "Invalid memory content"
    );
    ensure!(
        input.evidence_quote.chars().count() <= 512,
        "Evidence quote is too long"
    );
    ensure!(
        input
            .question
            .as_ref()
            .is_none_or(|q| q.chars().count() <= 256),
        "Clarification is too long"
    );
    Ok(())
}
fn old_memory(db: &Connection, input: &MemoryInput) -> Result<Option<Memory>> {
    let by_key: Option<String> = db
        .query_row(
            "SELECT data FROM personal_memories WHERE entry_key=?1",
            [&input.key],
            |r| r.get(0),
        )
        .optional()?;
    let by_key: Option<Memory> = by_key.map(|s| serde_json::from_str(&s)).transpose()?;
    if let Some(id) = &input.id {
        let data: Option<String> = db
            .query_row(
                "SELECT data FROM personal_memories WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()?;
        let old: Memory = serde_json::from_str(&data.context("Memory no longer exists")?)?;
        ensure!(
            input.expected_revision == Some(old.revision),
            "Memory revision conflict; inspect before editing"
        );
        ensure!(
            by_key.as_ref().is_none_or(|m| m.id == old.id),
            "Another memory already owns the destination key"
        );
        Ok(Some(old))
    } else {
        ensure!(input.expected_revision.is_none(), "Memory no longer exists");
        if let Some(old) = &by_key {
            ensure!(
                old.content == input.content
                    && old.kind == input.kind
                    && old.confirmed == input.confirmed
                    && input.core.is_none_or(|c| c == old.core),
                "Memory already exists; inspect its ID and revision before changing it"
            );
        }
        Ok(by_key)
    }
}

fn write(
    db: &Connection,
    thread: &str,
    input: MemoryInput,
    origin: &str,
    latest: bool,
    relearn: bool,
    automatic: bool,
) -> Result<Memory> {
    validate(&input)?;
    let (_, epoch) = source(db, thread, &input.source_message_id, latest)?;
    let deleted = barrier(db, &input.key, epoch, relearn)?;
    let old = old_memory(db, &input)?;
    if automatic {
        ensure!(!(old.as_ref().is_some_and(|m|m.core)&&input.core==Some(false)),"Existing core memory can only be unpinned in the manual editor; omit core to preserve it");
        ensure!(
            old.as_ref().is_none_or(|m| m.key == input.key),
            "Use the manual editor to rename a stable memory key"
        );
        ensure!(old.is_some()||epoch>=clock(db)?,"A memory was forgotten or renamed during this turn; new keys require a fresh message or manual save");
    }
    let core = input
        .core
        .unwrap_or_else(|| old.as_ref().is_some_and(|m| m.core));
    ensure!(
        !core || input.confirmed,
        "Only asserted memories can be pinned as core"
    );
    if core && !old.as_ref().is_some_and(|m| m.core) {
        let count: i64 = db.query_row(
            "SELECT count(*) FROM personal_memories WHERE json_extract(data,'$.core')=1",
            [],
            |r| r.get(0),
        )?;
        ensure!(
            count < 5,
            "At most five core memories can be pinned; unpin one or save this without core first"
        );
    }
    if old.is_none() {
        let count: i64 =
            db.query_row("SELECT count(*) FROM personal_memories", [], |r| r.get(0))?;
        ensure!(count < 500, "Personal memory limit reached");
    }
    if let Some(old) = &old {
        barrier(db, &old.key, epoch, false)?;
        if old.key != input.key {
            stamp(db, &old.key, true)?;
            stamp(db, &input.key, false)?;
        }
    }
    if deleted {
        stamp(db, &input.key, false)?;
    }
    let same = old.as_ref().is_some_and(|m| {
        m.key == input.key
            && m.content == input.content
            && m.kind == input.kind
            && m.confirmed == input.confirmed
            && m.core == core
    });
    let saved = Memory {
        id: old
            .as_ref()
            .map(|m| m.id.clone())
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        revision: old.as_ref().map_or(1, |m| m.revision + u64::from(!same)),
        key: input.key,
        kind: input.kind,
        content: input.content,
        confirmed: input.confirmed,
        source_message_id: input.source_message_id,
        source_thread_id: thread.into(),
        updated_at: chrono::Utc::now().timestamp_millis(),
        origin: origin.into(),
        evidence_quote: input.evidence_quote,
        core,
    };
    db.execute("INSERT INTO personal_memories VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET entry_key=excluded.entry_key,data=excluded.data",params![saved.id,saved.key,serde_json::to_string(&saved)?])?;
    db.execute(
        "DELETE FROM personal_memory_candidates WHERE key_hash=?1",
        [key_hash(&saved.key)],
    )?;
    Ok(saved)
}

impl Store {
    pub fn remember(&mut self, thread: &str, input: MemoryInput) -> Result<Memory> {
        self.save_manual(thread, input, false)
    }
    pub fn relearn(&mut self, thread: &str, input: MemoryInput) -> Result<Memory> {
        self.save_manual(thread, input, true)
    }
    fn save_manual(&mut self, thread: &str, input: MemoryInput, relearn: bool) -> Result<Memory> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let saved = write(&tx, thread, input, "manual", true, relearn, false)?;
        tx.commit()?;
        Ok(saved)
    }
    pub fn learn(&mut self, thread: &str, input: MemoryInput) -> Result<LearnReceipt> {
        validate(&input)?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (raw, epoch) = source(&tx, thread, &input.source_message_id, true)?;
        ensure!(
            !input.evidence_quote.trim().is_empty() && raw.contains(&input.evidence_quote),
            "Evidence must be a literal quote from the current raw human message"
        );
        barrier(&tx, &input.key, epoch, false)?;
        if input.confirmed {
            let staged: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM personal_memory_candidates WHERE entry_key=?1)",
                [format!(
                    "{}:{}",
                    input.source_message_id,
                    key_hash(&input.key)
                )],
                |r| r.get(0),
            )?;
            ensure!(!staged,"This source already has a pending candidate; confirm it in the UI or provide a fresh clear human assertion");
            let saved = write(&tx, thread, input, "automatic", true, false, true)?;
            tx.commit()?;
            return Ok(LearnReceipt {
                saved: Some(saved),
                candidate: None,
            });
        }
        let old = old_memory(&tx, &input)?;
        ensure!(
            !(old.as_ref().is_some_and(|m| m.core) && input.core == Some(false)),
            "Existing core memory can only be unpinned in the manual editor"
        );
        ensure!(
            old.as_ref().is_none_or(|m| m.key == input.key),
            "Candidate cannot rename a memory key"
        );
        ensure!(old.is_some()||epoch>=clock(&tx)?,"A memory was forgotten or renamed during this turn; submit new keys from a fresh message");
        let entry_key = format!("{}:{}", input.source_message_id, key_hash(&input.key));
        let previous: Option<String> = tx
            .query_row(
                "SELECT data FROM personal_memory_candidates WHERE entry_key=?1",
                [&entry_key],
                |r| r.get(0),
            )
            .optional()?;
        let previous: Option<MemoryCandidate> =
            previous.map(|s| serde_json::from_str(&s)).transpose()?;
        if let Some(p) = &previous {
            if serde_json::to_value(&p.input)? == serde_json::to_value(&input)? {
                return Ok(LearnReceipt {
                    saved: None,
                    candidate: Some(p.clone()),
                });
            }
        } else {
            let count: i64 =
                tx.query_row("SELECT count(*) FROM personal_memory_candidates", [], |r| {
                    r.get(0)
                })?;
            ensure!(count < 100, "Pending memory candidate limit reached");
        }
        let c = MemoryCandidate {
            id: previous
                .as_ref()
                .map(|p| p.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            revision: previous.as_ref().map_or(1, |p| p.revision + 1),
            input,
            source_thread_id: thread.into(),
            created_at: chrono::Utc::now().timestamp_millis(),
        };
        tx.execute("INSERT INTO personal_memory_candidates VALUES(?1,?2,?3,?4) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![c.id,entry_key,key_hash(&c.input.key),serde_json::to_string(&c)?])?;
        tx.commit()?;
        Ok(LearnReceipt {
            saved: None,
            candidate: Some(c),
        })
    }
    pub fn memory_candidates(&self) -> Result<Vec<MemoryCandidate>> {
        self.read_all("SELECT data FROM personal_memory_candidates ORDER BY rowid DESC")
    }
    pub fn confirm_memory(&mut self, id: &str, revision: u64) -> Result<Memory> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let data: String = tx.query_row(
            "SELECT data FROM personal_memory_candidates WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        let mut c: MemoryCandidate = serde_json::from_str(&data)?;
        ensure!(c.revision == revision, "Memory candidate revision conflict");
        ensure!(
            c.input
                .question
                .as_ref()
                .is_none_or(|q| q.trim().is_empty()),
            "Resolve the candidate's question in chat or edit its content before saving"
        );
        let (raw, _) = source(&tx, &c.source_thread_id, &c.input.source_message_id, false)?;
        ensure!(
            !c.input.evidence_quote.trim().is_empty() && raw.contains(&c.input.evidence_quote),
            "Candidate source no longer matches its literal evidence"
        );
        c.input.confirmed = true;
        let saved = write(
            &tx,
            &c.source_thread_id,
            c.input,
            "manual",
            false,
            false,
            false,
        )?;
        tx.execute("DELETE FROM personal_memory_candidates WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(saved)
    }
    pub fn dismiss_memory(&mut self, id: &str, revision: u64) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let data: String = tx.query_row(
            "SELECT data FROM personal_memory_candidates WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        let c: MemoryCandidate = serde_json::from_str(&data)?;
        ensure!(c.revision == revision, "Memory candidate revision conflict");
        tx.execute("DELETE FROM personal_memory_candidates WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }
    pub fn forget(&mut self, id: &str, revision: u64) -> Result<()> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let data: String = tx.query_row(
            "SELECT data FROM personal_memories WHERE id=?1",
            [id],
            |r| r.get(0),
        )?;
        let old: Memory = serde_json::from_str(&data)?;
        ensure!(old.revision == revision, "Memory revision conflict");
        stamp(&tx, &old.key, true)?;
        tx.execute("DELETE FROM personal_memories WHERE id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }
    pub fn memory_topic(&self, thread: &str, source_id: &str) -> Result<String> {
        self.require_source(thread, source_id)?;
        let mut q = self.db.prepare(
            "SELECT text FROM personal_humans WHERE thread_id=?1 ORDER BY rowid DESC LIMIT 3",
        )?;
        let rows = q
            .query_map([thread], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows
            .into_iter()
            .map(|s| s.chars().take(512).collect::<String>())
            .collect::<Vec<_>>()
            .join("\n"))
    }
}
