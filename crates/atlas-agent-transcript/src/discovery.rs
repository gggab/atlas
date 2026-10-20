//! Finding which Claude Code sessions exist for a project, from file names and
//! modification times, with bounded conversation metadata reads for liveness.
//!
//! This is *discovery* in the sense of the ADR-0001 amendment ("discovery is
//! not replay", 2026-10-05, ATL-423): Atlas may look at an agent's on-disk
//! storage to learn that a session exists and when it last moved. Directory
//! discovery uses file metadata; [`activity_time`] may read a bounded tail to
//! distinguish conversation activity from bookkeeping. Replay remains ACP.

use std::borrow::Cow;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};

use crate::encode_cwd;

/// One session transcript found on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredSession {
    /// The file stem, which is the session id.
    pub session_id: String,
    pub path: PathBuf,
    /// Raw file time for discovery; conversation liveness is separate.
    pub modified: DateTime<Utc>,
    /// Size at discovery, also used to invalidate cached activity metadata.
    pub len: u64,
}

/// The directory Claude Code keeps this project's transcripts in; `None`
/// without a home dir.
///
/// This is `~/.claude/projects/<slug>`, exactly as the checkpoint importer
/// resolves it. Claude Code's `CLAUDE_CONFIG_DIR` is deliberately *not*
/// honoured here, because the importer does not either, and the two must agree
/// about where a project's transcripts are.
pub fn claude_sessions_dir(cwd: &Path) -> Option<PathBuf> {
    let projects = dirs::home_dir()?.join(".claude").join("projects");
    Some(sessions_dir_in(&projects, cwd))
}

/// Same, under an explicit projects root (the `~/.claude/projects` equivalent).
pub fn sessions_dir_in(root: &Path, cwd: &Path) -> PathBuf {
    root.join(encode_cwd(&cwd.to_string_lossy()))
}

/// Top-level `<uuid>.jsonl` files only. Subdirectories and non-UUID names are
/// ignored. File contents are never read. A missing or unreadable directory is
/// an empty list, never an error.
pub fn scan_sessions(dir: &Path) -> Vec<DiscoveredSession> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| session_at(entry.ok()?.path()))
        .collect()
}

/// Stat only one bound UUID session, without scanning unrelated transcripts.
pub fn find_session(dir: &Path, session_id: &str) -> Option<DiscoveredSession> {
    uuid::Uuid::parse_str(session_id).ok()?;
    session_at(dir.join(format!("{session_id}.jsonl")))
}

fn session_at(path: PathBuf) -> Option<DiscoveredSession> {
    if path.extension()?.to_str()? != "jsonl" {
        return None;
    }
    let session_id = path.file_stem()?.to_str()?.to_owned();
    uuid::Uuid::parse_str(&session_id).ok()?;
    let meta = std::fs::metadata(&path).ok()?;
    meta.is_file().then_some(DiscoveredSession {
        session_id,
        modified: DateTime::<Utc>::from(meta.modified().ok()?),
        len: meta.len(),
        path,
    })
}

/// Conversation time for liveness only; raw mtime still drives discovery.
///
/// Adapted from upstream 16d69e1d (Adib Mohsin). An SDK entrypoint is not
/// process identity: every writer remains subject to the host's turn tracking.
/// Unknown, unreadable or changing records explicitly fall back to file time.
pub fn activity_time(session: &DiscoveredSession, now: DateTime<Utc>) -> DateTime<Utc> {
    if !is_live(session.modified, now) {
        return session.modified;
    }
    let read = || -> Option<DateTime<Utc>> {
        let mut file = std::fs::File::open(&session.path).ok()?;
        let before = file.metadata().ok()?;
        let before_at = DateTime::<Utc>::from(before.modified().ok()?);
        if before.len() != session.len || before_at != session.modified {
            return Some(before_at.max(session.modified));
        }
        let at = read_conversation_time(&mut file, session.len, session.modified);
        let after = std::fs::metadata(&session.path).ok()?;
        let after_at = DateTime::<Utc>::from(after.modified().ok()?);
        if after.len() != session.len || after_at != session.modified {
            return Some(after_at.max(session.modified));
        }
        at
    };
    read().unwrap_or(session.modified)
}

#[derive(serde::Deserialize)]
struct ConversationMetadata<'a> {
    #[serde(rename = "type", borrow)]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow)]
    entrypoint: Option<Cow<'a, str>>,
    #[serde(borrow)]
    timestamp: Option<Cow<'a, str>>,
}

fn read_conversation_time(
    reader: &mut (impl Read + Seek),
    len: u64,
    modified: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    // Each window includes one boundary byte; appends cannot extend this read.
    for window in [64 * 1024, 2 * 1024 * 1024] {
        let start = len.saturating_sub(window);
        let read_start = start.saturating_sub(1);
        let expected = len - read_start;
        reader.seek(SeekFrom::Start(read_start)).ok()?;
        let mut tail = Vec::with_capacity(expected as usize);
        reader.take(expected).read_to_end(&mut tail).ok()?;
        if tail.len() as u64 != expected || tail.last() != Some(&b'\n') {
            return None;
        }
        let complete = if start == 0 {
            tail.as_slice()
        } else {
            // Discard only a leading fragment, preserving an exact boundary.
            let first_end = tail.iter().position(|b| *b == b'\n')?;
            &tail[first_end + 1..]
        };
        for line in complete.rsplit(|b| *b == b'\n') {
            let line = line.trim_ascii();
            if line.is_empty() {
                continue;
            }
            // Ignored serde fields still require UTF-8 validation.
            std::str::from_utf8(line).ok()?;
            if line.first() != Some(&b'{') {
                return None;
            }
            let metadata: ConversationMetadata<'_> = serde_json::from_slice(line).ok()?;
            if let Some(entrypoint) = metadata.entrypoint {
                if entrypoint.is_empty() {
                    return None;
                }
                let at = DateTime::parse_from_rfc3339(metadata.timestamp.as_deref()?)
                    .ok()?
                    .with_timezone(&Utc);
                // Allow filesystem timestamp granularity, never future activity.
                return (at <= modified + chrono::Duration::seconds(2)).then_some(at.min(modified));
            }
            // Only known inert records can be skipped; new formats stay guarded.
            if !matches!(
                metadata.kind.as_deref(),
                Some("ai-title" | "last-prompt" | "cost-state" | "mode")
            ) {
                return None;
            }
        }
        if start == 0 {
            break;
        }
    }
    None
}

/// How recently a transcript must have been written for its session to count
/// as running in another process (ADR-0001 amendment, Rule 7).
pub const LIVE_WINDOW: std::time::Duration = std::time::Duration::from_secs(90);

/// Whether a session last written at `modified` is live at `now`. A modified
/// time in the future (clock skew) counts as live.
pub fn is_live(modified: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    match (now - modified).to_std() {
        Ok(age) => age < LIVE_WINDOW,
        // Negative age: the file is from the future.
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(text: &[u8]) -> (TempDir, DiscoveredSession) {
        let dir = TempDir::new();
        let id = uuid::Uuid::new_v4().to_string();
        std::fs::write(dir.0.join(format!("{id}.jsonl")), text).unwrap();
        let session = scan_sessions(&dir.0).pop().unwrap();
        (dir, session)
    }

    fn line(entrypoint: &str, at: DateTime<Utc>) -> String {
        format!("{{\"type\":\"assistant\",\"entrypoint\":\"{entrypoint}\",\"timestamp\":\"{}\",\"message\":{{\"content\":\"ignored\"}}}}\n", at.to_rfc3339())
    }

    #[test]
    fn exit_bookkeeping_does_not_renew_conversation_activity() {
        let at = Utc::now() - chrono::Duration::seconds(130);
        let text = line("cli", at)
            + "{\"type\":\"cost-state\"}\n{\"type\":\"last-prompt\",\"prompt\":\"ignored\"}\n";
        let (_dir, session) = fixture(text.as_bytes());
        assert!(!is_live(activity_time(&session, Utc::now()), Utc::now()));
        assert!(is_live(session.modified, Utc::now()));
    }

    #[test]
    fn sdk_entrypoints_are_activity_not_process_identity() {
        let at = Utc::now() - chrono::Duration::seconds(10);
        for entrypoint in ["cli", "sdk-cli", "sdk-ts", "another-host"] {
            let (_dir, session) = fixture(line(entrypoint, at).as_bytes());
            assert_eq!(activity_time(&session, Utc::now()), at);
        }
    }

    #[test]
    fn uncertain_newer_records_fall_back_to_file_time() {
        let at = Utc::now() - chrono::Duration::seconds(130);
        for last in [
            "{\"type\":\"assistant\",\"entrypoint\":\"cli\"}\n",
            "{\"type\":\"user\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
            "{\"type\":\"user\",\"entrypoint\":null}\n",
            "{\"entrypoint\":\"cli\",\"timestamp\":\"bad\"}\n",
            "{\"entrypoint\":\"cli\",\"timestamp\":\"2999-01-01T00:00:00Z\"}\n",
            "{\"entrypoint\":\"cli\",\"entrypoint\":\"sdk-ts\"}\n",
            "{unfinished\n",
            "{\"type\":\"cost-state\"}",
            "[]\n",
            "{\"type\":\"tool-progress\"}\n",
            "{\"type\":\"future-record\"}\n",
            "{}\n",
            "{\"type\":\"system\"}\n",
            "{\"ignored\":\"unknown\"}\n",
        ] {
            let text = line("sdk-cli", at) + last;
            let (_dir, session) = fixture(text.as_bytes());
            assert_eq!(
                activity_time(&session, Utc::now()),
                session.modified,
                "{last}"
            );
        }
        let mut bytes = line("sdk-cli", at).into_bytes();
        bytes.extend_from_slice(b"{\"type\":\"cost-state\",\"ignored\":\"\xff\"}\n");
        let (_dir, session) = fixture(&bytes);
        assert_eq!(activity_time(&session, Utc::now()), session.modified);
    }

    #[test]
    fn empty_unreadable_and_bookkeeping_only_files_use_file_time() {
        for text in ["".to_owned(), "{\"type\":\"mode\"}\n".repeat(6_000)] {
            let (_dir, session) = fixture(text.as_bytes());
            assert_eq!(activity_time(&session, Utc::now()), session.modified);
            std::fs::remove_file(&session.path).unwrap();
            assert_eq!(activity_time(&session, Utc::now()), session.modified);
        }
    }

    #[test]
    fn wider_windows_crlf_and_escaped_metadata_are_supported() {
        let at = Utc::now() - chrono::Duration::seconds(10);
        let mut text = line("sdk-cli", at)
            .replace("sdk-cli", "sdk-\\u0063li")
            .replace('\n', "\r\n");
        text.push_str(&format!(
            "{{\"type\":\"cost-state\",\"ignored\":\"{}\"}}\r\n",
            "x".repeat(200 * 1024)
        ));
        let (_dir, session) = fixture(text.as_bytes());
        assert_eq!(activity_time(&session, Utc::now()), at);
        let huge = format!(
            "{{\"entrypoint\":\"cli\",\"timestamp\":\"{}\",\"ignored\":\"{}\"}}\n",
            at.to_rfc3339(),
            "x".repeat(3 * 1024 * 1024)
        );
        let (_dir, session) = fixture(huge.as_bytes());
        assert_eq!(activity_time(&session, Utc::now()), session.modified);
    }

    #[test]
    fn metadata_times_are_clamped_to_file_time() {
        let modified = Utc::now();
        let text = line("cli", modified + chrono::Duration::seconds(1));
        let mut reader = std::io::Cursor::new(text.as_bytes());
        assert_eq!(
            read_conversation_time(&mut reader, text.len() as u64, modified),
            Some(modified)
        );
    }

    #[test]
    fn reads_are_bounded_to_the_original_length_and_short_reads_are_unknown() {
        let modified = Utc::now();
        let text = line("cli", modified - chrono::Duration::seconds(10));
        let original_len = text.len() as u64;
        let mut growing = std::io::Cursor::new((text + "{unfinished").into_bytes());
        assert!(read_conversation_time(&mut growing, original_len, modified).is_some());
        assert_eq!(
            growing.position(),
            original_len,
            "later appends are outside this snapshot"
        );
        let mut truncated = std::io::Cursor::new(b"{}\n".to_vec());
        assert_eq!(
            read_conversation_time(&mut truncated, original_len, modified),
            None
        );
    }

    #[test]
    fn a_file_changed_since_discovery_uses_its_new_file_time() {
        let at = Utc::now() - chrono::Duration::seconds(130);
        let (_dir, session) = fixture(line("sdk-cli", at).as_bytes());
        std::fs::write(&session.path, line("cli", Utc::now())).unwrap();
        let current = DateTime::<Utc>::from(
            std::fs::metadata(&session.path)
                .unwrap()
                .modified()
                .unwrap(),
        );
        assert_eq!(
            activity_time(&session, Utc::now()),
            current.max(session.modified)
        );
    }

    #[test]
    fn even_an_oversized_record_cannot_exceed_the_probe_read_budget() {
        struct Meter {
            inner: std::io::Cursor<Vec<u8>>,
            read: u64,
        }
        impl Read for Meter {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let count = self.inner.read(buf)?;
                self.read += count as u64;
                Ok(count)
            }
        }
        impl Seek for Meter {
            fn seek(&mut self, pos: SeekFrom) -> std::io::Result<u64> {
                self.inner.seek(pos)
            }
        }
        let mut bytes = vec![b'x'; 3 * 1024 * 1024];
        bytes.push(b'\n');
        let len = bytes.len() as u64;
        let mut reader = Meter {
            inner: std::io::Cursor::new(bytes),
            read: 0,
        };
        assert_eq!(read_conversation_time(&mut reader, len, Utc::now()), None);
        assert!(reader.read <= 2 * 1024 * 1024 + 64 * 1024 + 2);
    }

    #[test]
    fn a_record_exactly_at_the_small_window_boundary_is_not_discarded() {
        let modified = Utc::now();
        let at = modified - chrono::Duration::seconds(10);
        let mut tail = line("cli", at);
        let overhead = "{\"type\":\"cost-state\",\"ignored\":\"\"}\n".len();
        let padding = 64 * 1024 - tail.len() - overhead;
        let bookkeeping = format!(
            "{{\"type\":\"cost-state\",\"ignored\":\"{}\"}}\n",
            "x".repeat(padding)
        );
        tail.push_str(&bookkeeping);
        assert_eq!(tail.len(), 64 * 1024);
        for suffix in ["", " \n"] {
            let text = "{}\n".to_owned() + &tail + suffix;
            let mut reader = std::io::Cursor::new(text.as_bytes());
            assert_eq!(
                read_conversation_time(&mut reader, text.len() as u64, modified),
                Some(at)
            );
        }
    }

    #[test]
    fn bound_session_lookup_validates_ids_and_returns_only_that_file() {
        let (dir, session) = fixture(b"{}\n");
        assert_eq!(find_session(&dir.0, &session.session_id), Some(session));
        assert!(find_session(&dir.0, "../outside").is_none());
        assert!(find_session(&dir.0, &uuid::Uuid::new_v4().to_string()).is_none());
    }

    #[test]
    fn liveness_window() {
        let now = Utc::now();
        let ago = |s: i64| now - chrono::Duration::seconds(s);
        assert!(is_live(ago(0), now));
        assert!(is_live(ago(89), now));
        assert!(!is_live(ago(90), now));
        assert!(!is_live(ago(3600), now));
        assert!(is_live(now + chrono::Duration::seconds(30), now));
    }

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("atlas-discovery-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn lists_only_top_level_uuid_jsonl_files() {
        let tmp = TempDir::new();
        let a = uuid::Uuid::new_v4().to_string();
        let b = uuid::Uuid::new_v4().to_string();
        std::fs::write(tmp.0.join(format!("{a}.jsonl")), "not read").unwrap();
        std::fs::write(tmp.0.join(format!("{b}.jsonl")), "").unwrap();
        std::fs::write(tmp.0.join("notes.jsonl"), "").unwrap();
        std::fs::write(tmp.0.join(format!("{}.txt", uuid::Uuid::new_v4())), "").unwrap();
        let nested = tmp.0.join("subagents");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join(format!("{}.jsonl", uuid::Uuid::new_v4())), "").unwrap();
        // A directory named like a session is not one.
        std::fs::create_dir_all(tmp.0.join(format!("{}.jsonl", uuid::Uuid::new_v4()))).unwrap();

        let mut ids: Vec<String> = scan_sessions(&tmp.0)
            .into_iter()
            .map(|s| s.session_id)
            .collect();
        ids.sort();
        let mut want = vec![a, b];
        want.sort();
        assert_eq!(ids, want);
    }

    #[test]
    fn a_missing_directory_is_empty() {
        let tmp = TempDir::new();
        assert!(scan_sessions(&tmp.0.join("absent")).is_empty());
    }

    #[test]
    fn the_sessions_dir_uses_the_cwd_slug() {
        let dir = sessions_dir_in(Path::new("/r"), Path::new("/Users/a/Test DeskMate"));
        assert_eq!(dir, Path::new("/r/-Users-a-Test-DeskMate"));
    }
}
