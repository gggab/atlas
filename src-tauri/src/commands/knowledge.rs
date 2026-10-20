use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct KnowledgeEntry {
    pub id: String,
    pub title: String,
    pub content: String,
    pub source: String, // "note", "paper", "chat", "interaction"
    pub file_path: String,
    pub updated_at: String,
}

/// List all knowledge entries recursively from .atlas/knowledge/
///
/// IMPORTANT: every `#[tauri::command]` in this module is declared `async`
/// and dispatches its I/O through `tokio::task::spawn_blocking`. Sync
/// commands run on the NSApp main thread; doing real filesystem work there
/// freezes the entire app while the syscall blocks. Boot cascade members
/// (`list_knowledge`, `load_editor_state`) were the chief offenders.
#[tauri::command]
pub async fn list_knowledge(project_path: String) -> Result<Vec<KnowledgeEntry>, String> {
    tokio::task::spawn_blocking(move || list_knowledge_sync(&project_path))
        .await
        .map_err(|e| e.to_string())?
}

pub(crate) fn list_knowledge_sync(project_path: &str) -> Result<Vec<KnowledgeEntry>, String> {
    let kb_dir = atlas_profile::dir_in(Path::new(project_path)).join("knowledge");
    if !kb_dir.exists() {
        return Ok(vec![]);
    }

    let mut entries = Vec::new();
    walk_knowledge(&kb_dir, &kb_dir, &mut entries);
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(entries)
}

fn walk_knowledge(dir: &Path, root: &Path, entries: &mut Vec<KnowledgeEntry>) {
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };

    for entry in read.flatten() {
        let path = entry.path();

        if path.is_dir() {
            walk_knowledge(&path, root, entries);
            continue;
        }

        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Use relative path (without .md) as the ID so nested notes work
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let id = rel.with_extension("").to_string_lossy().to_string();

        let filename = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();

        // Use only the filename as the wire-side title fallback. The
        // user-edited page-header title lives in `_meta.json` and is
        // merged client-side; deriving a title from the first `#` line
        // here meant the tree label drifted to the body's first heading
        // (often a content paragraph after a markdown auto-shortcut),
        // which was confusing and inconsistent with the page header.
        let title = filename.clone();

        let source = if filename.starts_with("paper-") {
            "paper"
        } else if filename.starts_with("chat-") {
            "chat"
        } else {
            "note"
        };

        let updated_at = fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339())
                    .unwrap_or_default()
            })
            .unwrap_or_default();

        entries.push(KnowledgeEntry {
            id,
            title,
            content,
            source: source.to_string(),
            file_path: path.to_string_lossy().to_string(),
            updated_at,
        });
    }
}

/// A renderer-supplied path fragment, held inside the knowledge root.
///
/// Nested ids ("Adib/note-123") are legitimate, so `/` is allowed — what is
/// not is anything that climbs or escapes: absolute paths, `..` anywhere,
/// backslashes, or empty input. Every KB command that joins renderer input
/// under `.atlas/knowledge` goes through here; before it, `id =
/// "../../../../.zshrc"` was an arbitrary write and `cover =
/// "../../../.ssh/id_rsa"` an arbitrary read handed back as a data URL.
/// Same rule as `log.rs::org_log_dir`, extended for nesting.
fn kb_rel(fragment: &str) -> Result<&str, String> {
    let f = fragment;
    // No trimming: `"/etc/passwd".trim_matches('/')` would come out RELATIVE
    // and sail through — an absolute path is rejected, not laundered.
    if f.is_empty()
        || f.contains('\\')
        || Path::new(f).is_absolute()
        || Path::new(f)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("invalid knowledge path".to_string());
    }
    Ok(f)
}

/// Save a knowledge note (supports nested paths like "Adib/note-123")
#[tauri::command]
pub async fn save_knowledge_note(
    project_path: String,
    id: String,
    content: String,
) -> Result<String, String> {
    let id = kb_rel(&id)?.to_string();
    tokio::task::spawn_blocking(move || {
        let kb_dir = atlas_profile::dir_in(Path::new(&project_path)).join("knowledge");
        let filepath = kb_dir.join(format!("{id}.md"));
        if let Some(parent) = filepath.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&filepath, &content).map_err(|e| e.to_string())?;
        Ok(filepath.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Debug, Serialize, Default)]
pub struct KbImportResult {
    pub notes_imported: usize,
    pub files_copied: usize,
}

/// A destination path that doesn't clobber an existing file — appends `-1`,
/// `-2`, … before the extension. Import must never overwrite existing notes.
fn unique_dest(dest: &Path) -> std::path::PathBuf {
    if !dest.exists() {
        return dest.to_path_buf();
    }
    let stem = dest
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = dest.extension().map(|e| e.to_string_lossy().to_string());
    let parent = dest
        .parent()
        .map(std::path::Path::to_path_buf)
        .unwrap_or_default();
    for n in 1.. {
        let name = match &ext {
            Some(e) => format!("{stem}-{n}.{e}"),
            None => format!("{stem}-{n}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// Recursively copy `src` (relative to `rel` under `kb`) into the KB dir. `.md`
/// files become notes; other files (images, code, attachments) are copied so an
/// imported vault stays intact. Hidden entries (`.obsidian`, `.git`, …) skipped.
fn import_path(src: &Path, rel: &Path, kb: &Path, res: &mut KbImportResult) -> Result<(), String> {
    if src.is_dir() {
        for entry in fs::read_dir(src).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
            import_path(&entry.path(), &rel.join(&name), kb, res)?;
        }
        Ok(())
    } else if src.is_file() {
        let dest = unique_dest(&kb.join(rel));
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(src, &dest).map_err(|e| e.to_string())?;
        let is_md = src
            .extension()
            .map(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"))
            .unwrap_or(false);
        if is_md {
            res.notes_imported += 1;
        } else {
            res.files_copied += 1;
        }
        Ok(())
    } else {
        Ok(())
    }
}

/// Import external `.md` files and/or folders (e.g. an Obsidian vault) into the
/// project KB at `.atlas/knowledge/`, preserving folder structure. Folder
/// sources are namespaced under their own name so the vault layout is kept.
#[tauri::command]
pub async fn import_into_knowledge(
    project_path: String,
    sources: Vec<String>,
) -> Result<KbImportResult, String> {
    tokio::task::spawn_blocking(move || -> Result<KbImportResult, String> {
        let kb = atlas_profile::dir_in(Path::new(&project_path)).join("knowledge");
        fs::create_dir_all(&kb).map_err(|e| e.to_string())?;
        let mut res = KbImportResult::default();
        for src in &sources {
            let p = Path::new(src);
            let Some(name) = p.file_name() else { continue };
            import_path(p, Path::new(name), &kb, &mut res)?;
        }
        Ok(res)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete a knowledge note
#[tauri::command]
pub async fn delete_knowledge_note(project_path: String, id: String) -> Result<(), String> {
    let id = kb_rel(&id)?.to_string();
    tokio::task::spawn_blocking(move || {
        let filepath = atlas_profile::dir_in(Path::new(&project_path))
            .join("knowledge")
            .join(format!("{id}.md"));
        if filepath.exists() {
            fs::remove_file(&filepath).map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create a directory inside .atlas/knowledge/
#[tauri::command]
pub async fn create_knowledge_dir(project_path: String, dir_name: String) -> Result<(), String> {
    let dir_name = kb_rel(&dir_name)?.to_string();
    tokio::task::spawn_blocking(move || {
        let dir = atlas_profile::dir_in(Path::new(&project_path))
            .join("knowledge")
            .join(&dir_name);
        fs::create_dir_all(&dir).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy a chosen image into `<project>/.atlas/knowledge/covers/` so the
/// cover ships with the project and survives moves. Returns the new
/// path relative to `.atlas/knowledge/` (e.g. `covers/<entryId>.jpg`)
/// suitable for storing in `_meta.json::pages[id].cover`.
#[tauri::command]
pub async fn knowledge_cover_upload(
    project_path: String,
    entry_id: String,
    src_path: String,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let src = Path::new(&src_path);
        if !src.exists() {
            return Err("source file not found".to_string());
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("jpg")
            .to_lowercase();
        // Flatten the entry id so a nested note (`folder/note-123`) still
        // gets a flat filename safe for the covers directory.
        let safe_name = entry_id.replace('/', "__");
        if !safe_name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ' '))
            || safe_name.contains("..")
        {
            return Err("invalid entry id".to_string());
        }
        let rel = format!("covers/{safe_name}.{ext}");
        let dest = atlas_profile::dir_in(Path::new(&project_path))
            .join("knowledge")
            .join(&rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(src, &dest).map_err(|e| e.to_string())?;
        Ok(rel)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a cover image and return it as a `data:` URL (base64). Covers live
/// under the hidden `.atlas/` directory, which Tauri's asset-protocol scope
/// won't serve (the webview 403s the `asset://` request). A data URL embeds
/// the bytes directly so the cover renders identically in dev and bundled
/// builds without depending on the asset protocol or its scope globs.
/// Gradient refs (`gradient:*`) are returned untouched — they're CSS, not files.
#[tauri::command]
pub async fn knowledge_cover_data_url(
    project_path: String,
    cover: String,
) -> Result<String, String> {
    use base64::Engine;
    if cover.starts_with("gradient:") {
        return Ok(cover);
    }
    let cover = kb_rel(&cover)?.to_string();
    tokio::task::spawn_blocking(move || {
        // Cap before reading into a data URL: a 6MB PNG becomes an 8MB JS
        // string crossing IPC, retained in the store, and re-serialized into
        // any snapshot that captures it. Covers are decorative; 2MiB is
        // generous.
        const MAX_COVER_BYTES: u64 = 2 * 1024 * 1024;
        let abs = atlas_profile::dir_in(Path::new(&project_path))
            .join("knowledge")
            .join(&cover);
        let meta = fs::metadata(&abs).map_err(|e| e.to_string())?;
        if meta.len() > MAX_COVER_BYTES {
            return Err("cover image is too large to inline (2MB max)".to_string());
        }
        let bytes = fs::read(&abs).map_err(|e| e.to_string())?;
        let mime = match abs
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_lowercase)
            .as_deref()
        {
            Some("png") => "image/png",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            Some("svg") => "image/svg+xml",
            Some("avif") => "image/avif",
            _ => "image/jpeg",
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(format!("data:{mime};base64,{b64}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Append an interaction log entry for context building
#[tauri::command]
pub async fn log_interaction(
    project_path: String,
    interaction_type: String,
    summary: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let atlas_dir = atlas_profile::dir_in(Path::new(&project_path));
        fs::create_dir_all(&atlas_dir).map_err(|e| e.to_string())?;

        let log_path = atlas_dir.join("interactions.jsonl");
        let entry = serde_json::json!({
            "type": interaction_type,
            "summary": summary,
            "timestamp": chrono::Utc::now().to_rfc3339(),
        });

        let mut line = serde_json::to_string(&entry).unwrap_or_default();
        line.push('\n');

        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .and_then(|mut f| {
                use std::io::Write;
                f.write_all(line.as_bytes())
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Save editor state (open tabs, active file) per project
#[tauri::command]
pub async fn save_editor_state(project_path: String, state_json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let atlas_dir = atlas_profile::dir_in(Path::new(&project_path));
        fs::create_dir_all(&atlas_dir).map_err(|e| e.to_string())?;
        let state_path = atlas_dir.join("editor-state.json");
        fs::write(&state_path, &state_json).map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Load editor state for a project
#[tauri::command]
pub async fn load_editor_state(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let state_path = atlas_profile::dir_in(Path::new(&project_path)).join("editor-state.json");
        if state_path.exists() {
            fs::read_to_string(&state_path).map_err(|e| e.to_string())
        } else {
            Ok("{}".to_string())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod kb_rel_tests {
    use super::*;

    #[test]
    fn nested_ids_pass_and_climbs_fail() {
        assert_eq!(kb_rel("note-1").unwrap(), "note-1");
        assert_eq!(kb_rel("Adib/note-123").unwrap(), "Adib/note-123");
        assert_eq!(kb_rel("covers/x.png").unwrap(), "covers/x.png");
        // The two shapes the audit exploited: arbitrary write via note id,
        // arbitrary read via cover path.
        assert!(kb_rel("../../../../.zshrc").is_err());
        assert!(kb_rel("a/../../b").is_err());
        assert!(kb_rel("/etc/passwd").is_err());
        assert!(kb_rel("a\\..\\b").is_err());
        assert!(kb_rel("").is_err());
        assert!(kb_rel("./note").is_err());
    }
}

#[cfg(test)]
mod cover_guard_tests {
    use super::knowledge_cover_data_url;

    #[tokio::test]
    async fn covers_are_bounded_and_cannot_climb() {
        let dir = std::env::temp_dir().join(format!("atlas-cover-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".atlas/knowledge/covers")).unwrap();
        std::fs::write(dir.join(".atlas/knowledge/covers/c.png"), b"png").unwrap();
        let root = dir.to_string_lossy().to_string();

        let ok = knowledge_cover_data_url(root.clone(), "covers/c.png".into())
            .await
            .unwrap();
        assert!(ok.starts_with("data:image/png;base64,"));

        // Gradient refs pass through untouched — CSS, not files.
        assert_eq!(
            knowledge_cover_data_url(root.clone(), "gradient:a,b".into())
                .await
                .unwrap(),
            "gradient:a,b"
        );

        // The audit's exfil shape.
        assert!(
            knowledge_cover_data_url(root.clone(), "../../../.ssh/id_rsa".into())
                .await
                .is_err()
        );

        // Size cap: decorative images do not get to be 8MB IPC strings.
        let big = vec![0u8; 3 * 1024 * 1024];
        std::fs::write(dir.join(".atlas/knowledge/covers/big.png"), &big).unwrap();
        let err = knowledge_cover_data_url(root, "covers/big.png".into())
            .await
            .unwrap_err();
        assert!(err.contains("too large"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
