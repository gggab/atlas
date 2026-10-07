use crate::Result;
use parking_lot::Mutex;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectionInput {
    pub id: Option<String>,
    pub name: String,
    pub purpose: String,
    pub host: String,
    pub port: u16,
    pub username: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub purpose: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub fingerprint: Option<String>,
    pub revision: String,
    pub has_password: bool,
    pub has_sudo_password: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Association {
    pub project: String,
    pub connection_id: String,
    pub excluded: bool,
    pub source: String,
    pub last_used_at: u64,
}

pub struct Store(Mutex<rusqlite::Connection>);

const PRUNE_JOBS: &str = "DELETE FROM jobs WHERE id IN (SELECT id FROM jobs WHERE json_extract(data,'$.status') != 'running' ORDER BY rowid DESC LIMIT -1 OFFSET 100)";

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let db = rusqlite::Connection::open(path).map_err(|_| "Cannot open SSH database")?;
        db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS connections(id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS associations(project TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, excluded INTEGER NOT NULL, source TEXT NOT NULL, last_used_at INTEGER NOT NULL, PRIMARY KEY(project,connection_id));
          CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, data TEXT NOT NULL);").map_err(|_| "Cannot initialize SSH database")?;
        db.execute("UPDATE jobs SET data=json_set(data,'$.status','interrupted_unknown','$.finished_at',?1) WHERE json_extract(data,'$.status')='running'", [now() as i64]).map_err(|_| "Cannot recover SSH history")?;
        db.execute_batch(PRUNE_JOBS)
            .map_err(|_| "Cannot prune SSH history")?;
        Ok(Self(Mutex::new(db)))
    }
    pub fn list(&self) -> Result<Vec<Connection>> {
        let db = self.0.lock();
        let mut query = db
            .prepare("SELECT data FROM connections ORDER BY id")
            .map_err(|_| "Cannot list SSH connections")?;
        let rows = query
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|_| "Cannot list SSH connections")?;
        rows.map(|row| {
            serde_json::from_str(&row.map_err(|_| "Cannot read SSH connection")?)
                .map_err(|_| "Invalid SSH connection record".into())
        })
        .collect()
    }
    pub fn get(&self, id: &str) -> Result<Connection> {
        let data: Option<String> = self
            .0
            .lock()
            .query_row("SELECT data FROM connections WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|_| "Cannot read SSH connection")?;
        serde_json::from_str(&data.ok_or("SSH connection no longer exists")?)
            .map_err(|_| "Invalid SSH connection record".into())
    }
    pub fn prepare(&self, input: ConnectionInput) -> Result<Connection> {
        let host = input.host.trim().to_string();
        if input.name.trim().is_empty()
            || input.username.trim().is_empty()
            || host.is_empty()
            || input.port == 0
            || host.chars().any(|c| c.is_whitespace() || c.is_control())
            || host.contains(['/', '@'])
        {
            return Err("Name, valid host, port and username are required".into());
        }
        let old = input.id.as_deref().map(|id| self.get(id)).transpose()?;
        let same_endpoint = old.as_ref().is_some_and(|c| {
            c.host == host && c.port == input.port && c.username == input.username.trim()
        });
        Ok(Connection {
            id: old
                .as_ref()
                .map(|c| c.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            name: input.name.trim().into(),
            purpose: input.purpose.trim().into(),
            host,
            port: input.port,
            username: input.username.trim().into(),
            fingerprint: old
                .as_ref()
                .filter(|_| same_endpoint)
                .and_then(|c| c.fingerprint.clone()),
            revision: uuid::Uuid::new_v4().to_string(),
            has_password: old.as_ref().is_some_and(|c| c.has_password),
            has_sudo_password: old.as_ref().is_some_and(|c| c.has_sudo_password),
        })
    }
    pub fn put(&self, connection: &Connection) -> Result<()> {
        let json = serde_json::to_string(connection).map_err(|_| "Cannot encode SSH connection")?;
        self.0.lock().execute("INSERT INTO connections VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data", params![connection.id, json]).map_err(|_| "Cannot save SSH connection")?;
        Ok(())
    }
    pub fn delete(&self, id: &str) -> Result<()> {
        self.0
            .lock()
            .execute("DELETE FROM connections WHERE id=?1", [id])
            .map_err(|_| "Cannot delete SSH connection")?;
        Ok(())
    }
    pub fn associate(&self, project: &str, id: &str, manual: bool, excluded: bool) -> Result<()> {
        if project.is_empty() {
            return Ok(());
        }
        let db = self.0.lock();
        if manual {
            db.execute("INSERT INTO associations VALUES(?1,?2,?3,'manual',0) ON CONFLICT(project,connection_id) DO UPDATE SET excluded=excluded.excluded,source='manual'", params![project,id,excluded]).map_err(|_| "Cannot update project association")?;
        } else {
            // Atomic upsert preserves manual exclusions, including in-flight connects.
            db.execute("INSERT INTO associations VALUES(?1,?2,0,'auto',?3) ON CONFLICT(project,connection_id) DO UPDATE SET last_used_at=excluded.last_used_at WHERE associations.excluded=0", params![project,id,now() as i64]).map_err(|_| "Cannot associate SSH connection")?;
        }
        Ok(())
    }
    pub fn associations(&self, project: &str) -> Result<Vec<Association>> {
        let db = self.0.lock();
        let mut query = db.prepare("SELECT project,connection_id,excluded,source,last_used_at FROM associations WHERE project=?1").map_err(|_| "Cannot list project associations")?;
        let rows = query
            .query_map([project], |r| {
                Ok(Association {
                    project: r.get(0)?,
                    connection_id: r.get(1)?,
                    excluded: r.get(2)?,
                    source: r.get(3)?,
                    last_used_at: r.get::<_, i64>(4)? as u64,
                })
            })
            .map_err(|_| "Cannot list project associations")?;
        rows.map(|r| r.map_err(|_| "Cannot read project association".into()))
            .collect()
    }
    pub fn save_job(&self, job: &crate::Job) -> Result<()> {
        let json = serde_json::to_string(job).map_err(|_| "Cannot encode SSH job")?;
        let db = self.0.lock();
        db.execute(
            "INSERT INTO jobs VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
            params![job.id, json],
        )
        .map_err(|_| "Cannot save SSH job")?;
        if job.finished_at.is_some() {
            db.execute_batch(PRUNE_JOBS)
                .map_err(|_| "Cannot prune SSH history")?;
        }
        Ok(())
    }
    pub fn clear_history(&self, remote_session: Option<&str>) -> Result<()> {
        self.0
            .lock()
            .execute(
                "DELETE FROM jobs WHERE json_extract(data,'$.status') != 'running' AND (?1 IS NULL OR json_extract(data,'$.remote_session') = ?1)",
                [remote_session],
            )
            .map_err(|_| "Cannot clear SSH history")?;
        Ok(())
    }
    pub fn history(&self) -> Result<Vec<crate::Job>> {
        let db = self.0.lock();
        let mut query = db
            .prepare("SELECT data FROM jobs ORDER BY rowid DESC LIMIT 100")
            .map_err(|_| "Cannot list SSH history")?;
        let rows = query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|_| "Cannot list SSH history")?;
        rows.map(|r| {
            let mut job: crate::Job = serde_json::from_str(&r.map_err(|_| "Cannot read SSH job")?)
                .map_err(|_| "Invalid SSH job")?;
            if job.status == "running" {
                job.status = "interrupted_unknown".into();
            }
            Ok(job)
        })
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> ConnectionInput {
        ConnectionInput {
            id: None,
            name: "Production".into(),
            purpose: "Alerts".into(),
            host: "192.0.2.10".into(),
            port: 22,
            username: "deploy".into(),
        }
    }
    #[test]
    fn exclusion_survives_repeated_success_and_can_be_restored() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let c = store.prepare(input()).unwrap();
        store.put(&c).unwrap();
        store.associate("project", &c.id, false, false).unwrap();
        store.associate("project", &c.id, true, true).unwrap();
        store.associate("project", &c.id, false, false).unwrap();
        assert!(store.associations("project").unwrap()[0].excluded);
        store.associate("project", &c.id, true, false).unwrap();
        store.associate("project", &c.id, false, false).unwrap();
        let rows = store.associations("project").unwrap();
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].excluded);
        assert_eq!(rows[0].source, "manual");
        store.delete(&c.id).unwrap();
        assert!(store.associations("project").unwrap().is_empty());
    }
    #[test]
    fn endpoint_changes_invalidate_fingerprint_and_revision() {
        let store = Store::open(Path::new(":memory:")).unwrap();
        let mut c = store.prepare(input()).unwrap();
        c.fingerprint = Some("SHA256:old".into());
        store.put(&c).unwrap();
        let mut next = input();
        next.id = Some(c.id.clone());
        next.host = "192.0.2.11".into();
        let changed = store.prepare(next).unwrap();
        assert!(changed.fingerprint.is_none());
        assert_ne!(changed.revision, c.revision);
        assert!(!serde_json::to_string(&changed)
            .unwrap()
            .contains("credential_ref"));
    }
    #[test]
    fn history_is_bounded_and_interrupted_commands_are_never_resumed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("ssh.sqlite");
        let store = Store::open(&path).unwrap();
        let mut job = crate::Job {
            id: String::new(),
            remote_session: "handle".into(),
            caller: crate::Identity {
                session_id: "session".into(),
                agent: "test".into(),
                project: "project".into(),
            },
            connection_name: "Test".into(),
            target: "deploy@192.0.2.10:22".into(),
            command: "echo hi".into(),
            sudo: false,
            started_at: 1,
            finished_at: Some(2),
            status: "succeeded".into(),
            exit_code: Some(0),
            output: "hi".into(),
            truncated: false,
        };
        for i in 0..105 {
            job.id = format!("job-{i}");
            store.save_job(&job).unwrap();
        }
        let count: i64 = store
            .0
            .lock()
            .query_row("SELECT count(*) FROM jobs", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 100);
        job.id = "interrupted".into();
        job.status = "running".into();
        job.finished_at = None;
        job.exit_code = None;
        store.save_job(&job).unwrap();
        drop(store);
        let reopened = Store::open(&path).unwrap();
        let history = reopened.history().unwrap();
        assert_eq!(history.len(), 100);
        assert_eq!(history[0].status, "interrupted_unknown");
        assert!(history[0].finished_at.is_some());
        assert!(history.iter().all(|j| j.status != "running"));
        reopened.clear_history(None).unwrap();
        drop(reopened);
        assert!(Store::open(&path).unwrap().history().unwrap().is_empty());
    }
}
