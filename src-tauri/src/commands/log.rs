//! Local activity logs. Project streams stay in `.atlas/logs.jsonl`.
//! Pins from former organisation folders are copied into the local pin file once;
//! original files are retained so migration never discards historical data.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

fn pinned_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    local_pinned_path(&atlas_profile::dir_in(&home).join("log"))
}

fn local_pinned_path(root: &Path) -> Result<PathBuf, String> {
    let target = root.join("pinned.jsonl");
    let marker = root.join("local-pins-migrated");
    if !marker.exists() {
        let mut body = if target.exists() {
            fs::read_to_string(&target).map_err(|e| e.to_string())?
        } else {
            String::new()
        };
        let orgs = root.join("orgs");
        if orgs.exists() {
            let mut paths = Vec::new();
            for entry in fs::read_dir(&orgs).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                // Only real directories below the legacy log root; never follow symlinks.
                if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                    let path = entry.path().join("pinned.jsonl");
                    if path.is_file() {
                        paths.push(path);
                    }
                }
            }
            paths.sort();
            let mut ids = std::collections::HashSet::new();
            for line in body.lines() {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                    if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                        ids.insert(id.to_owned());
                    }
                }
            }
            for path in paths {
                for line in fs::read_to_string(path).map_err(|e| e.to_string())?.lines() {
                    let value: serde_json::Value =
                        serde_json::from_str(line).map_err(|e| e.to_string())?;
                    if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                        if !ids.insert(id.to_owned()) {
                            continue;
                        }
                    }
                    if !body.is_empty() && !body.ends_with('\n') {
                        body.push('\n');
                    }
                    body.push_str(line);
                    body.push('\n');
                }
            }
        }
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        fs::write(&target, body).map_err(|e| e.to_string())?;
        fs::write(marker, "1").map_err(|e| e.to_string())?;
    }
    Ok(target)
}

fn ensure_dir(path: &PathBuf) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Local pinned entries.
#[tauri::command]
pub async fn load_pinned_log() -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let path = pinned_path()?;
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn append_pinned_log(entry_json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = pinned_path()?;
        ensure_dir(&path)?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;
        // Strip any newlines in the entry so each line is one entry.
        let single = entry_json.replace('\n', " ");
        writeln!(f, "{single}").map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Clear the local pin list.
#[tauri::command]
pub async fn clear_pinned_log() -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = pinned_path()?;
        if path.exists() {
            fs::write(&path, "").map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rewrite_pinned_log(entries_json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = pinned_path()?;
        ensure_dir(&path)?;
        // Caller passes the full body (each line one entry, newline separated).
        fs::write(&path, &entries_json).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Project-scoped activity log ──────────────────────────────────────────────
//
// The Log view's full activity stream is persisted PER PROJECT at
// `<project>/.atlas/logs.jsonl` (one JSON entry per line) so it survives app
// restarts and never bleeds across projects. The file is soft-capped so a
// long-lived project can't grow it without bound.

/// Keep the project log under this many bytes (trimmed from the front).
const PROJECT_LOG_CAP_BYTES: u64 = 1024 * 1024; // 1 MB

fn project_log_path(project: &str) -> PathBuf {
    atlas_profile::dir_in(PathBuf::from(project)).join("logs.jsonl")
}

#[tauri::command]
pub async fn load_project_log(project: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let path = project_log_path(&project);
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn append_project_log(project: String, entry_json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = project_log_path(&project);
        ensure_dir(&path)?;
        {
            let mut f = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            let single = entry_json.replace('\n', " ");
            writeln!(f, "{single}").map_err(|e| e.to_string())?;
        }
        // Soft-cap: if the file grew past the limit, keep the most recent bytes
        // starting at a line boundary.
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() > PROJECT_LOG_CAP_BYTES {
                if let Ok(content) = fs::read_to_string(&path) {
                    let keep_from = content
                        .len()
                        .saturating_sub((PROJECT_LOG_CAP_BYTES / 2) as usize);
                    let start = content[keep_from..]
                        .find('\n')
                        .map(|i| keep_from + i + 1)
                        .unwrap_or(keep_from);
                    let _ = fs::write(&path, &content[start..]);
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_project_log(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = project_log_path(&project);
        if path.exists() {
            fs::write(&path, "").map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_pins_merge_legacy_folders_once_and_keep_originals() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for org in ["a", "b"] {
            fs::create_dir_all(root.join("orgs").join(org)).unwrap();
        }
        fs::write(root.join("pinned.jsonl"), "{\"id\":\"local\"}\n").unwrap();
        let old = root.join("orgs/a/pinned.jsonl");
        fs::write(&old, "{\"id\":\"shared\"}\n").unwrap();
        fs::write(
            root.join("orgs/b/pinned.jsonl"),
            "{\"id\":\"shared\"}\n{\"id\":\"other\"}\n",
        )
        .unwrap();
        let path = local_pinned_path(root).unwrap();
        let merged = fs::read_to_string(&path).unwrap();
        assert_eq!(merged.lines().count(), 3);
        assert!(old.exists());
        assert_eq!(
            fs::read_to_string(local_pinned_path(root).unwrap()).unwrap(),
            merged
        );
    }
    #[test]
    fn malformed_legacy_pin_keeps_both_original_and_local_copy() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("orgs/a")).unwrap();
        fs::write(root.join("pinned.jsonl"), "{\"id\":\"local\"}\n").unwrap();
        fs::write(root.join("orgs/a/pinned.jsonl"), "not-json\n").unwrap();
        assert!(local_pinned_path(root).is_err());
        assert_eq!(
            fs::read_to_string(root.join("pinned.jsonl")).unwrap(),
            "{\"id\":\"local\"}\n"
        );
        assert!(!root.join("local-pins-migrated").exists());
    }
}
