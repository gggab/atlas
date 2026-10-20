//! `memory_indexer` — the decoupled background indexing infrastructure (Step 4).
//!
//! Two pieces live here, both in the Tauri app layer (never in `atlas-memory`,
//! which stays Tauri-free):
//!
//! - [`MemoryRegistry`] — a `cwd → Arc<RwLock<MemoryEngine>>` map stored as a
//!   Tauri managed `State`. It is the **single owner** of each project's engine:
//!   the retrieve closure (Step 6, read lock) and the indexer (write lock) both
//!   reach the right engine through it. Opening a project for the first time
//!   loads its persisted index, starts an FS watcher, and enqueues an initial
//!   cold [`Job::IndexCorpus`].
//! - [`MemoryIndexer`] — one owned Tokio task draining a **bounded** `mpsc` queue.
//!   Every [`Job`] carries a `cwd` so projects stay isolated: corpus indexing,
//!   explicit local index nudges and global promotion (`Compact`).
//!
//! Heavy work (corpus gather + embed + persist) runs off the IPC thread on the
//! async runtime / blocking pool; the FS watcher coalesces bursts via a ~2s
//! debounce into a single `IndexCorpus` per project.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use atlas_memory::{CorpusDoc, MemoryEngine, MiniLmProvider};
use dashmap::DashMap;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::mpsc;
use tokio::sync::RwLock;

use super::agent_memory::{collect_corpus, MemoryDoc};
use super::memory_graph::{model_dir, MODEL_FILES};

/// Bound on the indexer's job queue — back-pressure so HNSW persistence never
/// races a flood of enqueues. Full-channel jobs are coalesced outside it and retried.
pub const QUEUE_CAPACITY: usize = 256;

/// Debounce window: FS events within this window collapse into one `IndexCorpus`.
const DEBOUNCE_WINDOW: Duration = Duration::from_millis(2000);

/// A unit of background indexing work. **Every variant carries `cwd`** so the
/// worker looks up exactly one project's engine and never touches another's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Job {
    /// (Re)index a project's whole corpus into its HNSW store. Step 4.
    IndexCorpus {
        cwd: String,
    },
    /// Offer the repository's high-confidence Facts to global memory
    /// (`atlas_memory::global`): run once when a project opens and after an
    /// MCP write stores entries.
    Compact {
        cwd: String,
    },
    Health {
        cwd: String,
    },
    RewoundCheck {
        cwd: String,
        session: String,
        retried: bool,
    },
}

/// `cwd`-keyed owner of every open project's [`MemoryEngine`] plus its FS watcher.
/// Stored as a Tauri managed `State<Arc<MemoryRegistry>>`.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    pub checked_at: i64,
    pub record: atlas_memory::health::Report,
    pub corpus: atlas_memory::CorpusHealth,
    pub restored: Option<(i64, bool)>,
    pub error: Option<String>,
}

pub const MEMORY_HEALTH_EVENT: &str = "atlas:memory-health";

pub struct MemoryRegistry {
    /// One engine per project root, shared (read by retrieve, written by indexer).
    engines: DashMap<String, Arc<RwLock<MemoryEngine>>>,
    /// Keep each project's `notify` watcher alive (dropping it stops watching).
    watchers: DashMap<String, notify::RecommendedWatcher>,
    /// Producer end of the indexer's bounded queue.
    job_tx: mpsc::Sender<Job>,
    overflow: parking_lot::Mutex<Vec<Job>>,
    health: DashMap<String, HealthStatus>,
    /// Debounce coalesce window (overridable in tests).
    debounce_window: Duration,
    /// The shared on-device MiniLM provider, loaded **once** and reused by BOTH
    /// the indexer (write path) and retrieve (read path) so the model never loads
    /// twice. `None` until the first successful load; a failed load (model not yet
    /// downloaded) leaves it `None` so a later call retries.
    provider: tokio::sync::Mutex<Option<Arc<MiniLmProvider>>>,
}

impl MemoryRegistry {
    /// Build a registry feeding `job_tx` (the [`MemoryIndexer`] holds the matching
    /// receiver). Uses the default 2s debounce window.
    pub fn new(job_tx: mpsc::Sender<Job>) -> Self {
        Self {
            engines: DashMap::new(),
            watchers: DashMap::new(),
            job_tx,
            overflow: parking_lot::Mutex::new(Vec::new()),
            health: DashMap::new(),
            debounce_window: DEBOUNCE_WINDOW,
            provider: tokio::sync::Mutex::new(None),
        }
    }

    /// The shared [`MiniLmProvider`], loaded lazily on first use and cached. Both
    /// the indexer's `IndexCorpus` worker and the retrieve path (Step 6) call this
    /// so the MiniLM model is only ever loaded once per app. Returns `None` (with a
    /// log inside [`load_provider`]) when the model isn't downloaded yet — the next
    /// call retries.
    #[expect(
        clippy::await_holding_invalid_type,
        reason = "double-checked lazy load: the guard must span load_provider so the model loads once"
    )]
    pub async fn provider(&self, app: &AppHandle) -> Option<Arc<MiniLmProvider>> {
        let mut guard = self.provider.lock().await;
        if let Some(p) = guard.as_ref() {
            return Some(p.clone());
        }
        let loaded = load_provider(app).await?;
        *guard = Some(loaded.clone());
        Some(loaded)
    }

    /// The provider if it is already loaded, without waiting or loading.
    pub fn loaded_provider(&self) -> Option<Arc<MiniLmProvider>> {
        self.provider.try_lock().ok().and_then(|p| p.clone())
    }

    /// Drop the cached embedding provider so the next [`provider`](Self::provider)
    /// call reloads from disk. Called when the user selects a different embedding
    /// model (its dir / dim / vector space changed).
    pub async fn invalidate_provider(&self) {
        *self.provider.lock().await = None;
        for cwd in self
            .engines
            .iter()
            .map(|e| e.key().clone())
            .collect::<Vec<_>>()
        {
            let _ = self.enqueue(Job::Health { cwd });
        }
    }

    /// Test hook: a registry with a custom debounce window.
    #[cfg(test)]
    fn with_window(job_tx: mpsc::Sender<Job>, window: Duration) -> Self {
        let mut r = Self::new(job_tx);
        r.debounce_window = window;
        r
    }

    /// Open-or-return the engine for `cwd`. On the **first** open it starts the FS
    /// watcher, and enqueues an initial cold `IndexCorpus{cwd}` — so a freshly
    /// opened project is indexed even before the watcher fires. Subsequent calls
    /// just clone the existing handle (no re-enqueue, no second watcher).
    #[cfg(test)]
    pub fn engine_for(&self, cwd: &str) -> Arc<RwLock<MemoryEngine>> {
        self.try_engine_for(cwd).expect("open test memory corpus")
    }

    pub fn try_engine_for(&self, cwd: &str) -> Result<Arc<RwLock<MemoryEngine>>, String> {
        if let Some(existing) = self.engines.get(cwd) {
            return Ok(existing.value().clone());
        }

        // Build outside the map so the shard lock isn't held across the index
        // load I/O. A lost race is harmless: `or_insert_with` keeps whoever
        // won and `ptr_eq` tells us if *we* were the inserter.
        let fresh = Arc::new(RwLock::new(
            MemoryEngine::try_open(PathBuf::from(cwd))
                .map_err(|e| format!("open memory corpus: {e:#}"))?,
        ));
        let inserted = self
            .engines
            .entry(cwd.to_string())
            .or_insert_with(|| fresh.clone())
            .value()
            .clone();

        if Arc::ptr_eq(&inserted, &fresh) {
            self.start_watcher(cwd);
            // Cold index, promotion and health are retained for retry on queue overflow.
            let _ = self.enqueue(Job::IndexCorpus {
                cwd: cwd.to_string(),
            });
            // One global-promotion pass per open: it only reads the record's
            // Facts and the small global ledger, so it is cheap; drop-on-full
            // is fine (the next open or MCP write re-enqueues).
            let _ = self.enqueue(Job::Compact {
                cwd: cwd.to_string(),
            });
        }
        if Arc::ptr_eq(&inserted, &fresh) {
            let _ = self.enqueue(Job::Health {
                cwd: cwd.to_string(),
            });
        }
        Ok(inserted)
    }

    /// Enqueue without blocking the IPC thread; retain distinct jobs for retry.
    pub fn enqueue(&self, job: Job) -> Result<(), String> {
        match self.job_tx.try_send(job) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(job)) => {
                let mut waiting = self.overflow.lock();
                if !waiting.contains(&job) {
                    waiting.push(job);
                }
                Ok(())
            }
            Err(mpsc::error::TrySendError::Closed(_)) => Err("memory indexer has stopped".into()),
        }
    }

    pub fn health_status(&self, cwd: &str) -> Option<HealthStatus> {
        self.health.get(cwd).map(|v| v.clone())
    }

    fn retry_overflow(&self) {
        let jobs = std::mem::take(&mut *self.overflow.lock());
        for job in jobs {
            if let Err(e) = self.enqueue(job) {
                tracing::warn!("{e}");
            }
        }
    }

    /// Fire-and-forget background reindex nudge for `cwd` (Step 5). Designed to
    /// be called from the hot `TauriDeltaSink::emit` path on `TurnFinished`: it
    /// **never blocks and never `.await`s**. A full queue is dropped with a
    /// `debug` log (a later FS-watcher tick or `force_reindex` re-enqueues);
    /// a closed queue (app shutting down) is likewise a silent drop.
    pub fn enqueue_index(&self, cwd: &str) {
        if let Err(e) = self.enqueue(Job::IndexCorpus {
            cwd: cwd.to_string(),
        }) {
            tracing::warn!("{e}");
        }
    }

    /// Queue one `IndexCorpus` pass for `cwd`, the pass that embeds the whole
    /// corpus. If the project's engine is not open yet, opening it queues its
    /// own cold pass, so this never queues two. Non-blocking, like
    /// [`enqueue_index`](Self::enqueue_index).
    pub fn request_reindex(&self, cwd: &str) {
        if self.open_engine(cwd).is_some() {
            self.enqueue_index(cwd);
        } else {
            if let Err(e) = self.try_engine_for(cwd) {
                tracing::warn!("{e}");
            }
        }
    }

    /// Get-only lookup: the engine if this project is currently open, `None`
    /// otherwise. Background jobs (index/promotion) use this instead of
    /// [`engine_for`](Self::engine_for) so a stale queued job for a closed
    /// project skips instead of resurrecting the engine + watcher.
    pub fn open_engine(&self, cwd: &str) -> Option<Arc<RwLock<MemoryEngine>>> {
        self.engines.get(cwd).map(|e| e.value().clone())
    }

    /// Release everything held for `cwd`: dropping the watcher stops the OS watch
    /// and drops the callback's `sig_tx`, which ends the debounce task; dropping
    /// the engine frees its in-RAM HNSW/docstore. No persist needed — the indexer
    /// persists at the end of every `IndexCorpus` pass, so the on-disk state is
    /// already current. Reopening the project re-runs `engine_for` from scratch.
    pub fn close_project(&self, cwd: &str) {
        self.watchers.remove(cwd);
        self.engines.remove(cwd);
        self.health.remove(cwd);
        self.overflow.lock().retain(|j| match j {
            Job::IndexCorpus { cwd: p }
            | Job::Compact { cwd: p }
            | Job::Health { cwd: p }
            | Job::RewoundCheck { cwd: p, .. } => p != cwd,
        });
    }

    /// Start one `notify` watcher for `cwd`'s corpus roots, filtering to
    /// corpus-relevant paths and coalescing bursts into a single
    /// `IndexCorpus{cwd}` via [`debounce_loop`].
    ///
    /// SCOPED, not a recursive watch of the whole cwd — that was the same
    /// class of mistake the fileindex watcher already paid for (its unscoped
    /// recursive root watch covered ~350k paths of target/ + node_modules).
    /// Here the damage was smaller (raw watcher, no per-event stat storm) but
    /// still real: every `cargo build`/`npm install` woke the callback
    /// repo-wide, and the thousands of README/CHANGELOG `.md` files under
    /// node_modules passed `is_corpus_path` and enqueued spurious IndexCorpus
    /// jobs for the duration of a build. Worse, the watch was misaimed: most
    /// of the corpus lives in `~/.claude/projects/<cwd>/memory`, which the
    /// cwd watch never saw at all. `collect_corpus` reads exactly:
    ///  - `~/.claude/projects/<encoded>/memory/*.md` → watched recursively,
    ///  - `<cwd>/CLAUDE.md` + `<cwd>/AGENTS.md` → cwd watched NON-recursively,
    ///  - Codex sqlite under `~/.codex` → not watchable meaningfully (WAL
    ///    churn); its content rides the debounced reindexes above.
    fn start_watcher(&self, cwd: &str) {
        // Lightweight "something changed" signals from the (sync) notify callback
        // into the async debounce task.
        let (sig_tx, sig_rx) = mpsc::channel::<()>(64);

        tauri::async_runtime::spawn(debounce_loop(
            sig_rx,
            self.job_tx.clone(),
            cwd.to_string(),
            self.debounce_window,
        ));

        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(event) = res {
                if event.paths.iter().any(|p| is_corpus_path(p)) {
                    // Non-blocking; a dropped signal just means the debounce already
                    // has a pending tick.
                    let _ = sig_tx.try_send(());
                }
            }
        });

        match watcher {
            Ok(mut w) => {
                use notify::Watcher;
                let mut watched_any = false;

                // Project root, NON-recursive: only CLAUDE.md / AGENTS.md at
                // the top level are corpus.
                match w.watch(Path::new(cwd), notify::RecursiveMode::NonRecursive) {
                    Ok(()) => watched_any = true,
                    Err(e) => {
                        tracing::warn!(target: "atlas::memory_indexer", "watch {cwd} failed: {e}");
                    }
                }

                // The Claude memory dir — the bulk of the corpus. Created
                // eagerly so the watch can attach before the first memory is
                // ever written.
                let mem_dir = super::agent_memory::claude_memory_dir(cwd);
                let _ = std::fs::create_dir_all(&mem_dir);
                match w.watch(&mem_dir, notify::RecursiveMode::Recursive) {
                    Ok(()) => watched_any = true,
                    Err(e) => {
                        tracing::warn!(
                            target: "atlas::memory_indexer",
                            "watch {} failed: {e}", mem_dir.display()
                        );
                    }
                }

                if watched_any {
                    self.watchers.insert(cwd.to_string(), w);
                }
            }
            Err(e) => {
                tracing::warn!(target: "atlas::memory_indexer", "watcher init failed for {cwd}: {e}");
            }
        }
    }
}

/// True for paths the corpus is built from: any `*.md`, `CLAUDE.md` and
/// `AGENTS.md`. Dependency/build trees
/// are rejected outright — the scoped roots in `start_watcher` shouldn't
/// deliver them, but a top-level rename can surface such paths in an event
/// batch, and node_modules is full of README/CHANGELOG `.md` files that would
/// otherwise trigger a pointless reindex.
fn is_corpus_path(path: &Path) -> bool {
    if path.components().any(|c| {
        matches!(
            c.as_os_str().to_str(),
            Some("node_modules") | Some("target") | Some(".git")
        )
    }) {
        return false;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name == "CLAUDE.md" || name == "AGENTS.md" {
        return true;
    }
    if path.extension().and_then(|e| e.to_str()) == Some("md") {
        return true;
    }
    false
}

/// Coalesce a stream of FS signals into one `IndexCorpus{cwd}` per quiet window.
/// Waits for the first signal, then keeps resetting until no signal arrives for
/// `window`, then enqueues exactly one job. N rapid events → 1 job.
async fn debounce_loop(
    mut sig_rx: mpsc::Receiver<()>,
    job_tx: mpsc::Sender<Job>,
    cwd: String,
    window: Duration,
) {
    loop {
        // Block until the first event of a burst (or channel close → exit).
        if sig_rx.recv().await.is_none() {
            return;
        }
        // Drain follow-up events until it's been quiet for `window`.
        let mut channel_closed = false;
        loop {
            match tokio::time::timeout(window, sig_rx.recv()).await {
                Ok(Some(())) => continue, // more activity, keep coalescing
                Ok(None) => {
                    channel_closed = true; // channel closed → flush a final job, then exit
                    break;
                }
                Err(_) => break, // quiet for `window` → flush
            }
        }
        if job_tx
            .send(Job::IndexCorpus { cwd: cwd.clone() })
            .await
            .is_err()
        {
            return;
        }
        if channel_closed {
            return;
        }
    }
}

/// The single background indexer task. Owns the queue receiver and the lazily
/// loaded [`MiniLmProvider`] (loaded ONCE, on the first `IndexCorpus` that finds
/// the model installed).
pub struct MemoryIndexer;

impl MemoryIndexer {
    /// Drain the queue forever. Spawned once from `lib.rs` with the matching
    /// receiver; returns only when every `job_tx` is dropped (app shutdown).
    pub async fn run(app: AppHandle, registry: Arc<MemoryRegistry>, mut rx: mpsc::Receiver<Job>) {
        let mut health_tick = tokio::time::interval(Duration::from_secs(30 * 60));
        health_tick.tick().await;
        loop {
            registry.retry_overflow();
            let job = tokio::select! {
                job = rx.recv() => { let Some(job) = job else { break }; job },
                _ = health_tick.tick() => {
                    for cwd in registry.engines.iter().map(|e| e.key().clone()).collect::<Vec<_>>() { let _ = registry.enqueue(Job::Health { cwd }); }
                    continue;
                }
            };
            match job {
                Job::RewoundCheck {
                    cwd,
                    session,
                    retried,
                } => {
                    rewound_check(&app, &cwd, &session).await;
                    if !retried {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(Duration::from_secs(2)).await;
                            if let Some(registry) = app.try_state::<Arc<MemoryRegistry>>() {
                                let _ = registry.enqueue(Job::RewoundCheck {
                                    cwd,
                                    session,
                                    retried: true,
                                });
                            }
                        });
                    }
                }
                Job::Health { cwd } => {
                    health_one(&app, &registry, &cwd).await;
                }
                Job::IndexCorpus { cwd } => {
                    // Shared provider — loaded once, reused by retrieve too.
                    let Some(prov) = registry.provider(&app).await else {
                        if let Some(engine) = registry.open_engine(&cwd) {
                            let docs: Vec<CorpusDoc> = collect_corpus(&cwd)
                                .await
                                .iter()
                                .map(to_corpus_doc)
                                .collect();
                            if let Err(e) = engine.write().await.index_documents(&docs) {
                                tracing::warn!(target: "atlas::memory_indexer", "lexical indexing {cwd} failed: {e:#}");
                            }
                        }
                        continue;
                    };
                    if let Err(e) = index_one(&registry, &cwd, &prov).await {
                        tracing::warn!(target: "atlas::memory_indexer", "IndexCorpus {cwd} failed: {e}");
                    }
                }
                Job::Compact { cwd } => {
                    if let Err(e) = compact_one(&registry, &cwd).await {
                        tracing::warn!(
                            target: "atlas::memory_indexer",
                            "Compact {cwd} failed: {e}"
                        );
                    }
                }
            }
        }
    }
}

async fn rewound_check(app: &AppHandle, cwd: &str, session: &str) {
    let memory = app
        .state::<super::shared_memory::SharedMemoryStore>()
        .inner()
        .clone();
    let cwd = cwd.to_string();
    let session = session.to_string();
    let _ = tokio::task::spawn_blocking(move || {
        if let Some(windows) = super::memory_capture::rewound_windows_for(
            &super::memory_capture::CaptureReader::default(),
            &cwd,
            &session,
            memory.now(),
        ) {
            if let Err(e) = memory.demote_rewound(&cwd, &session, &windows) {
                tracing::warn!("memory rewind check failed: {e}");
            }
        }
    })
    .await;
}

async fn health_one(app: &AppHandle, registry: &MemoryRegistry, cwd: &str) {
    let Some(engine) = registry.open_engine(cwd) else {
        return;
    };
    let now = chrono::Utc::now().timestamp_millis();
    let scope = cwd.to_string();
    let memory = app
        .state::<super::shared_memory::SharedMemoryStore>()
        .inner()
        .clone();
    let checked = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let reader = super::memory_capture::CaptureReader::default();
        for writer in reader
            .stores(&scope)
            .recent_sessions(now.saturating_sub(24 * 3600 * 1000), now)
            .into_iter()
            .take(100)
        {
            if let Some(windows) =
                super::memory_capture::rewound_windows_for(&reader, &scope, &writer.session_id, now)
            {
                memory.demote_rewound(&scope, &writer.session_id, &windows)?;
            }
        }
        let store = super::shared_memory::store_for(&scope)?;
        let report = store.heal(now).map_err(|e| format!("{e:#}"))?;
        let restored = atlas_memory::record::RecordStore::restored_marker(store.root());
        let corpus = engine
            .blocking_write()
            .heal()
            .map_err(|e| format!("{e:#}"))?;
        Ok((report, restored, corpus))
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    let status = match checked {
        Ok((record, restored, corpus)) => HealthStatus {
            checked_at: now,
            record,
            corpus,
            restored: restored.or_else(|| registry.health_status(cwd).and_then(|s| s.restored)),
            error: None,
        },
        Err(error) => HealthStatus {
            checked_at: now,
            record: Default::default(),
            corpus: Default::default(),
            restored: None,
            error: Some(error),
        },
    };
    registry.health.insert(cwd.to_string(), status);
    let _ = app.emit(MEMORY_HEALTH_EVENT, serde_json::json!({ "cwd": cwd }));
}

#[tauri::command]
pub fn memory_health_status(
    project_path: String,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Option<HealthStatus> {
    registry.health_status(&project_path)
}

/// Gather the corpus for `cwd`, diff+embed it into that project's engine under
/// the **write lock**, and persist. Reuses `agent_memory::collect_corpus` so the
/// indexer sees exactly what the old build path saw.
#[expect(
    clippy::await_holding_invalid_type,
    reason = "the write lock must span index_corpus: reset + re-embed + persist is one atomic pass"
)]
async fn index_one(
    registry: &MemoryRegistry,
    cwd: &str,
    provider: &MiniLmProvider,
) -> Result<(), String> {
    // Get-only: a job that outlived its project's close is a skip, not a
    // resurrection (engine_for here would re-open the engine AND restart the
    // watcher). Never-opened projects get their cold index at first memory use
    // (engine_for enqueues one on open).
    let Some(engine) = registry.open_engine(cwd) else {
        return Ok(());
    };
    let corpus = collect_corpus(cwd).await;
    let docs: Vec<CorpusDoc> = corpus.iter().map(to_corpus_doc).collect();

    let mut guard = engine.write().await;
    // If the selected embedding model changed since this project was last indexed
    // (different model id or dim), wipe + rebuild — old vectors live in a different
    // space and can't be mixed with the new model's.
    if !guard.index_params_match(provider) {
        guard
            .reset_index(provider.provider_name(), provider.dim())
            .map_err(|e| e.to_string())?;
    }
    let stats = guard
        .index_corpus(&docs, provider)
        .await
        .map_err(|e| e.to_string())?;
    drop(guard);

    tracing::info!(
        target: "atlas::memory_indexer",
        "indexed {cwd}: +{} ~{} -{} ={}",
        stats.added, stats.updated, stats.deleted, stats.unchanged
    );
    Ok(())
}

/// Global promotion for `cwd`'s repository, off the hot path: its Facts at
/// confidence ≥ 0.8 are recorded in the global candidates ledger, and any seen
/// in two or more repositories are promoted to `~/.atlas/memory`
/// (`atlas_memory::global`). Idempotent, so running it on every open and after
/// every explicit memory write is safe.
async fn compact_one(registry: &MemoryRegistry, cwd: &str) -> Result<(), String> {
    // Get-only for the same reason as `index_one`: don't resurrect a closed
    // project. Its promotion runs again next open.
    if registry.open_engine(cwd).is_none() {
        return Ok(());
    }
    let cwd = cwd.to_string();
    let promoted = tokio::task::spawn_blocking(move || -> Result<usize, String> {
        let store = super::shared_memory::store_for(&cwd)?;
        atlas_memory::promote_facts(&store).map_err(|e| format!("{e:#}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    if promoted > 0 {
        tracing::info!(target: "atlas::memory_indexer", "promoted {promoted} facts to global memory");
    }
    Ok(())
}

/// Text actually embedded for a doc — title prepended for short-doc signal.
/// Memory ▸ Graph embeds through [`to_corpus_doc`] too, so the vectors it hands
/// to the index hash identically and the next index pass skips them.
fn embed_text(doc: &MemoryDoc) -> String {
    if doc.text.trim().is_empty() {
        doc.title.clone()
    } else {
        format!("{}\n\n{}", doc.title, doc.text)
    }
}

/// SHA-256 hex of `s`.
fn hash_text(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

/// Map an `agent_memory::MemoryDoc` onto the neutral `atlas_memory::CorpusDoc`.
pub(crate) fn to_corpus_doc(doc: &MemoryDoc) -> CorpusDoc {
    let text = embed_text(doc);
    let content_hash = hash_text(&text);
    CorpusDoc {
        id: doc.id.clone(),
        text,
        content_hash,
        corpus: doc.source.clone(),
    }
}

/// The vectors `cwd`'s retrieval index already holds for `docs`, by doc id —
/// only for docs whose content is unchanged since they were indexed, and none
/// when the index was built with a different embedding model. Memory ▸ Graph
/// and the Policy view reuse these instead of re-embedding.
pub(crate) async fn indexed_vectors(
    registry: &MemoryRegistry,
    provider: &MiniLmProvider,
    cwd: &str,
    docs: &[MemoryDoc],
) -> std::collections::HashMap<String, Vec<f32>> {
    let Ok(engine) = registry.try_engine_for(cwd) else {
        return std::collections::HashMap::new();
    };
    let guard = engine.read().await;
    if !guard.index_params_match(provider) {
        return std::collections::HashMap::new();
    }
    docs.iter()
        .filter_map(|d| {
            let c = to_corpus_doc(d);
            guard
                .cached_vector(&c.id, &c.content_hash)
                .map(|v| (c.id, v))
        })
        .collect()
}

/// The shared-memory record's embedder (near-duplicate merge, search): the
/// on-device model when it is loaded, else no vector — the record then
/// dedups by key and content hash only. Never loads the model inline (a
/// record write must not wait on it); a miss asks for a background load so a
/// later write has it.
pub struct ModelEmbedder {
    app: AppHandle,
    /// A background load is in flight; cleared when it finishes, loaded or
    /// not (the model may not be downloaded yet), so a later miss asks again.
    loading: Arc<std::sync::atomic::AtomicBool>,
}

impl ModelEmbedder {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            loading: Arc::default(),
        }
    }
}

impl atlas_memory::record::Embedder for ModelEmbedder {
    fn embed(&self, text: &str) -> Option<atlas_memory::record::Embedding> {
        use std::sync::atomic::Ordering;
        let registry = self.app.try_state::<Arc<MemoryRegistry>>()?;
        let Some(provider) = registry.loaded_provider() else {
            if !self.loading.swap(true, Ordering::SeqCst) {
                let app = self.app.clone();
                let loading = self.loading.clone();
                tauri::async_runtime::spawn(async move {
                    let registry = app.state::<Arc<MemoryRegistry>>();
                    let _ = registry.provider(&app).await;
                    loading.store(false, Ordering::SeqCst);
                });
            }
            return None;
        };
        let vector = provider.embedder().embed_one(text).ok()?;
        Some(atlas_memory::record::Embedding {
            model: provider.provider_name().to_string(),
            vector,
        })
    }
}

/// Load the on-device MiniLM provider ONCE, reusing `memory_graph`'s model-dir
/// resolution. `None` (with a log) when the model isn't downloaded — the indexer
/// then skips index jobs until it is.
async fn load_provider(app: &AppHandle) -> Option<Arc<MiniLmProvider>> {
    let dir = match model_dir(app) {
        Ok(d) => d,
        Err(e) => {
            tracing::warn!(target: "atlas::memory_indexer", "no model dir: {e}");
            return None;
        }
    };
    if !MODEL_FILES.iter().all(|f| dir.join(f).exists()) {
        return None;
    }
    // Tag the provider with the selected model id so the manifest can detect a
    // model switch (and rebuild the index).
    let model_id = super::models::selected_embedding_id(app);
    // Embedder::load is blocking candle work — keep it off the async runtime.
    let embedder = tokio::task::spawn_blocking(move || atlas_embed::Embedder::load(&dir))
        .await
        .ok()?
        .map_err(|e| tracing::warn!(target: "atlas::memory_indexer", "embedder load failed: {e}"))
        .ok()?;
    Some(Arc::new(MiniLmProvider::new(Arc::new(embedder), model_id)))
}

/// Force a full (re)index of `cwd`'s memory corpus off the hot path. Replaces the
/// old manual "Memory Graph" rebuild trigger. Ensures the engine is open (so a
/// cold project also gets its watcher + initial pass) then enqueues `IndexCorpus`.
#[tauri::command]
pub async fn force_reindex(
    cwd: String,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<(), String> {
    let cwd = cwd.trim_end_matches('/').to_string();
    // Opening also enqueues an initial IndexCorpus on first open; the explicit
    // enqueue below covers the already-open case.
    registry.try_engine_for(&cwd)?;
    registry.enqueue(Job::IndexCorpus { cwd })
}

/// Project-close teardown: release `cwd`'s engine, FS watcher and debounce
/// task. Counterpart of `fileindex_close_project`/`git_watch_stop` — without it
/// every project ever opened kept a recursive FSEvents stream + an in-RAM
/// index for the life of the process.
#[tauri::command]
pub async fn memory_indexer_close_project(
    cwd: String,
    registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<(), String> {
    registry.close_project(cwd.trim_end_matches('/'));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_root(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "atlas-indexer-{}-{}-{}",
            std::process::id(),
            name,
            uuid::Uuid::new_v4()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn is_corpus_path_matches_md_and_known_files() {
        assert!(is_corpus_path(Path::new("/p/NOTES.md")));
        assert!(is_corpus_path(Path::new("/p/CLAUDE.md")));
        assert!(is_corpus_path(Path::new("/p/sub/AGENTS.md")));
        assert!(!is_corpus_path(Path::new("/p/main.rs")));
        assert!(!is_corpus_path(Path::new("/p/other/docs.json")));
        assert!(!is_corpus_path(Path::new("/p/data.json")));
    }

    /// `enqueue_index` (the hot-path `TurnFinished` nudge) must NEVER block and
    /// must drop gracefully when the queue is full. The queue here has capacity 1
    /// and is never drained, so a blocking send would hang this test forever —
    /// completing at all proves it is non-blocking.
    #[test]
    fn enqueue_index_never_blocks_and_retries_every_distinct_job() {
        let (job_tx, mut job_rx) = mpsc::channel::<Job>(1);
        let registry = MemoryRegistry::new(job_tx);

        // First nudge fills the single slot.
        registry.enqueue_index("/proj/a");
        // Queue is now full — these overflow nudges must be DROPPED, not block.
        registry.enqueue_index("/proj/a");
        registry.enqueue_index("/proj/b");

        // Exactly one job made it in; the overflow was dropped gracefully.
        match job_rx.try_recv() {
            Ok(Job::IndexCorpus { cwd }) => assert_eq!(cwd, "/proj/a"),
            other => panic!("expected exactly one IndexCorpus, got {other:?}"),
        }
        assert!(
            job_rx.try_recv().is_err(),
            "overflow jobs wait outside the bounded channel"
        );
        registry.retry_overflow();
        assert!(matches!(job_rx.try_recv(), Ok(Job::IndexCorpus { cwd }) if cwd == "/proj/a"));
        registry.retry_overflow();
        assert!(matches!(job_rx.try_recv(), Ok(Job::IndexCorpus { cwd }) if cwd == "/proj/b"));
        assert!(registry.overflow.lock().is_empty());
    }

    /// N rapid FS signals collapse into exactly ONE `IndexCorpus` job.
    #[tokio::test]
    async fn debounce_coalesces_burst_into_one_job() {
        let (sig_tx, sig_rx) = mpsc::channel::<()>(64);
        let (job_tx, mut job_rx) = mpsc::channel::<Job>(16);
        let window = Duration::from_millis(80);

        let handle = tokio::spawn(debounce_loop(sig_rx, job_tx, "/proj/a".to_string(), window));

        // Fire a burst well within the window.
        for _ in 0..20 {
            sig_tx.try_send(()).unwrap();
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        // After the quiet window, exactly one job should appear.
        let job = tokio::time::timeout(Duration::from_millis(400), job_rx.recv())
            .await
            .expect("a job within timeout")
            .expect("job present");
        match job {
            Job::IndexCorpus { cwd } => assert_eq!(cwd, "/proj/a"),
            other => panic!("expected IndexCorpus, got {other:?}"),
        }

        // No second job from the same burst.
        assert!(
            tokio::time::timeout(Duration::from_millis(200), job_rx.recv())
                .await
                .is_err(),
            "burst should coalesce into a single job"
        );

        // Closing the signal channel ends the loop.
        drop(sig_tx);
        let _ = tokio::time::timeout(Duration::from_millis(300), handle).await;
    }

    /// Opening a project enqueues an initial `IndexCorpus`, and re-opening the
    /// same project does NOT enqueue a second one.
    #[test]
    fn engine_for_enqueues_initial_index_once() {
        let (job_tx, mut job_rx) = mpsc::channel::<Job>(16);
        let registry = MemoryRegistry::with_window(job_tx, Duration::from_millis(50));

        let root = tmp_root("cold");
        let cwd = root.to_string_lossy().to_string();

        let _e1 = registry.engine_for(&cwd);
        // First open enqueues an initial IndexCorpus then a one-time Compact.
        match job_rx.try_recv() {
            Ok(Job::IndexCorpus { cwd: c }) => assert_eq!(c, cwd),
            other => panic!("expected initial IndexCorpus, got {other:?}"),
        }
        match job_rx.try_recv() {
            Ok(Job::Compact { cwd: c }) => assert_eq!(c, cwd),
            other => panic!("expected one-time Compact, got {other:?}"),
        }
        assert!(matches!(job_rx.try_recv(), Ok(Job::Health { cwd: c }) if c == cwd));
        assert!(
            job_rx.try_recv().is_err(),
            "first open enqueues exactly IndexCorpus + Compact + Health"
        );

        // Second open of the same project: same engine handle, no new jobs.
        let _e2 = registry.engine_for(&cwd);
        assert!(
            job_rx.try_recv().is_err(),
            "re-opening must not re-enqueue any job"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    /// `request_reindex` asks for exactly one corpus pass. A never-opened
    /// project gets the cold pass its open queues; an open one gets the
    /// nudge. Neither ever blocks.
    #[test]
    fn request_reindex_queues_exactly_one_index_corpus() {
        let (job_tx, mut job_rx) = mpsc::channel::<Job>(16);
        let registry = MemoryRegistry::with_window(job_tx, Duration::from_millis(50));
        let root = tmp_root("reindex");
        let cwd = root.to_string_lossy().to_string();

        // Not open yet: opening queues the cold IndexCorpus + one-time Compact.
        registry.request_reindex(&cwd);
        assert!(matches!(job_rx.try_recv(), Ok(Job::IndexCorpus { cwd: c }) if c == cwd));
        assert!(matches!(job_rx.try_recv(), Ok(Job::Compact { cwd: c }) if c == cwd));
        assert!(matches!(job_rx.try_recv(), Ok(Job::Health { cwd: c }) if c == cwd));
        assert!(
            job_rx.try_recv().is_err(),
            "no second IndexCorpus on first open"
        );

        // Open: exactly one IndexCorpus, no further Compact.
        registry.request_reindex(&cwd);
        assert!(matches!(job_rx.try_recv(), Ok(Job::IndexCorpus { cwd: c }) if c == cwd));
        assert!(job_rx.try_recv().is_err());

        std::fs::remove_dir_all(&root).ok();
    }

    /// A job for cwd-A only ever touches cwd-A's `.atlas/memory/`; cwd-B's engine
    /// is a distinct handle under a distinct directory — the registry never
    /// cross-wires two projects.
    #[tokio::test]
    async fn projects_are_isolated_by_cwd() {
        let (job_tx, _job_rx) = mpsc::channel::<Job>(64);
        let registry = MemoryRegistry::with_window(job_tx, Duration::from_millis(50));

        let root_a = tmp_root("iso-a");
        let root_b = tmp_root("iso-b");
        let cwd_a = root_a.to_string_lossy().to_string();
        let cwd_b = root_b.to_string_lossy().to_string();

        let engine_a = registry.engine_for(&cwd_a);
        let engine_b = registry.engine_for(&cwd_b);

        // Distinct engine handles.
        assert!(!Arc::ptr_eq(&engine_a, &engine_b));

        // Each engine's memory dir is under its own cwd, never the other's.
        let dir_a = engine_a.read().await.memory_dir().to_path_buf();
        let dir_b = engine_b.read().await.memory_dir().to_path_buf();
        assert!(
            dir_a.starts_with(&root_a),
            "A dir {dir_a:?} not under {root_a:?}"
        );
        assert!(
            dir_b.starts_with(&root_b),
            "B dir {dir_b:?} not under {root_b:?}"
        );
        assert!(!dir_a.starts_with(&root_b));
        assert!(!dir_b.starts_with(&root_a));

        std::fs::remove_dir_all(&root_a).ok();
        std::fs::remove_dir_all(&root_b).ok();
    }
}
