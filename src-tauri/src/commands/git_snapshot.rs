//! Coalesced read-only repository status for explorer decorations and chat diffs.
//! A single porcelain-v2 call returns file status and branch metadata without
//! loading branch lists, stashes or merge state for the removed Source Control UI.

use atlas_git::{status as gstatus, GitCommand, GitErrorCode, GitErrorPayload};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// One changed path. `status` is a word ("modified", "added", "deleted",
/// "renamed", "untracked", "conflicted", "copied") — the UI routes badges
/// and revert semantics on substrings of it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotFile {
    pub path: String,
    pub status: String,
    pub staged: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orig_path: Option<String>,
    pub conflicted: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitSnapshot {
    pub is_repo: bool,
    pub branch: String,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<SnapshotFile>,
}

fn status_word(c: char) -> &'static str {
    match c {
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'M' | 'T' => "modified",
        '?' => "untracked",
        _ => "modified",
    }
}

/// Map porcelain-v2 entries to UI rows. A file changed in BOTH the index and
/// the worktree yields two rows (one staged, one not) — matching how GitHub
/// Desktop and the Changes view split the lists.
fn to_files(entries: &[gstatus::StatusEntry]) -> Vec<SnapshotFile> {
    let mut files = Vec::with_capacity(entries.len());
    for e in entries {
        if e.unmerged.is_some() {
            files.push(SnapshotFile {
                path: e.path.clone(),
                status: "conflicted".into(),
                staged: false,
                orig_path: None,
                conflicted: true,
            });
            continue;
        }
        if e.untracked {
            files.push(SnapshotFile {
                path: e.path.clone(),
                status: "untracked".into(),
                staged: false,
                orig_path: None,
                conflicted: false,
            });
            continue;
        }
        if e.index != '.' {
            files.push(SnapshotFile {
                path: e.path.clone(),
                status: status_word(e.index).into(),
                staged: true,
                orig_path: e.orig_path.clone(),
                conflicted: false,
            });
        }
        if e.worktree != '.' {
            files.push(SnapshotFile {
                path: e.path.clone(),
                status: status_word(e.worktree).into(),
                staged: false,
                orig_path: None,
                conflicted: false,
            });
        }
    }
    files
}

async fn compute(path: String) -> Result<GitSnapshot, GitErrorPayload> {
    let status_path = path.clone();
    let status_fut = tokio::task::spawn_blocking(move || {
        GitCommand::new(&status_path, &["status", "--porcelain=2", "--branch", "-z"])
            .read_only()
            .run()
    });
    let status_out = match status_fut
        .await
        .map_err(|e| GitErrorPayload::internal(e.to_string()))?
    {
        Ok(out) => out,
        // Not a work tree → the well-known empty shape, not an error.
        Err(e) if e.code == GitErrorCode::NotARepository => {
            return Ok(GitSnapshot::default());
        }
        Err(e) => return Err(e),
    };

    let parsed = gstatus::parse(status_out.stdout.as_bytes());
    Ok(GitSnapshot {
        is_repo: true,
        branch: parsed.branch.clone().unwrap_or_default(),
        detached: parsed.detached,
        upstream: parsed.upstream.clone(),
        ahead: parsed.ahead,
        behind: parsed.behind,
        files: to_files(&parsed.entries),
    })
}

type SnapshotCell = Arc<tokio::sync::OnceCell<Result<GitSnapshot, GitErrorPayload>>>;

fn inflight() -> &'static Mutex<HashMap<String, SnapshotCell>> {
    static MAP: OnceLock<Mutex<HashMap<String, SnapshotCell>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Shared repository status in one IPC call.
/// Concurrent calls for the same repo share one computation (the debounced
/// watcher, the store's own refresh and the project sidebar all land here
/// after a commit — only the first pays).
#[tauri::command]
pub async fn git_snapshot(path: String) -> Result<GitSnapshot, GitErrorPayload> {
    let (cell, owner) = {
        let mut map = inflight().lock().expect("snapshot inflight lock");
        match map.get(&path) {
            Some(c) => (c.clone(), false),
            None => {
                let c: SnapshotCell = Arc::new(tokio::sync::OnceCell::new());
                map.insert(path.clone(), c.clone());
                (c, true)
            }
        }
    };

    let result = cell.get_or_init(|| compute(path.clone())).await.clone();

    if owner {
        inflight()
            .lock()
            .expect("snapshot inflight lock")
            .remove(&path);
    }
    result
}
