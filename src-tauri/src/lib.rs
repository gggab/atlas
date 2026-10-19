mod app_icon;
mod background;
pub mod browser_native;
mod commands;
mod keep_awake;
mod logging;
#[cfg(target_os = "macos")]
mod menu;
mod notifier;
mod personal;
mod scheduler;
mod state;
mod window_background;

use std::sync::Arc;

use commands::cli::CliLaunchState;
use commands::fileindex::FileIndexState;
use commands::git_watcher::GitWatcherState;
use commands::knowledge_links::KnowledgeLinksState;
use commands::knowledge_meta::KnowledgeMetaState;
use commands::mention_search::MentionCacheState;
use commands::recent_files::RecentFilesState;
use commands::terminal::TerminalState;
use parking_lot::Mutex;
use state::{AppState, AppStateHandle};
use tauri::Manager;

// The old SDK UTF-8 patch guard is gone with the SDK it guarded
// (#54). What it protected against — a decoder that corrupts multi-byte
// characters split across HTTP chunk boundaries — is now covered inside the
// engine's own dialect, by a fixture that splits a frame at every byte position
// (`atlas_chat::sse`, acceptance bar item 6). Same failure, checked by a test
// that exercises the decoder rather than by a const that only proves a patch
// still applies.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(debug_assertions)]
    if std::env::args().any(|arg| {
        matches!(
            arg.as_str(),
            "--background-probe-server" | "--background-probe-client"
        )
    }) {
        background::probe::run(tauri::generate_context!());
        return;
    }
    // Whose data this process owns, fixed before ANYTHING resolves a path —
    // the log file below is the first thing that does. The profile is read
    // off the identifier this binary was built with: `dev:app` builds with
    // `tauri.dev.conf.json`'s `dev.atlas.ide.dev`, which moves the app config
    // dir by itself and, through `atlas-profile`, every `.atlas` directory and
    // `~/.config/atlas` with it. A release build's identifier is
    // `dev.atlas.ide`, so it is the default profile and nothing here can make
    // it otherwise. See `crates/atlas-profile`.
    let mut context = tauri::generate_context!();
    let service = background::requested();
    if service {
        context.config_mut().app.windows.clear();
    }
    atlas_profile::init(atlas_profile::Profile::from_identifier(
        &context.config().identifier,
    ));
    if browser_native::run_if_requested(&context.config().identifier) {
        return;
    }

    // Pick the rustls crypto provider, once, before anything can open a TLS
    // connection.
    //
    // rustls 0.23 refuses to guess when more than one provider is compiled in,
    // and this graph has two: `ring` (via sqlx, through the vendored engine
    // state store) and `aws-lc-rs` (via rama-tls / aws-smithy, through the
    // vendored network proxy). Neither is removable, and cargo's feature
    // unification turns "two dependencies each chose one" into "rustls sees
    // both and panics at the first handshake" — on a background worker, far
    // from anything that looks related.
    //
    // It was dormant until team chat opened the first rustls socket at runtime.
    // Installing explicitly is the documented remedy and it is process-global,
    // so it belongs here rather than in whichever subsystem happens to connect
    // first. `aws-lc-rs` is rustls's own default of the two.
    if rustls::crypto::aws_lc_rs::default_provider()
        .install_default()
        .is_err()
    {
        // Already installed — only possible if something ran earlier than this.
        tracing::debug!("rustls crypto provider was already installed");
    }

    // Install a tracing subscriber that prints `tracing::info!` etc. to
    // stderr. Verbosity is controlled by `RUST_LOG`; see `logging.rs`.
    logging::init();

    if let Some(result) = background::maintenance(&context.config().identifier) {
        match result {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                tracing::error!("background maintenance failed: {error}");
                std::process::exit(1);
            }
        }
    }

    // Strip CLAUDECODE so child ACP agents (canonical claude-code-acp) don't
    // refuse to start when Atlas was launched from a parent Claude Code shell.
    atlas_agent_servers::sanitize_host_env();

    // Parse argv for an initial project path BEFORE tauri::Builder starts
    // so the webview boot path can read it via `cli_take_initial_project_path`.
    // Triggered by the `atlas <path>` shell helper at ~/.local/bin/atlas.
    let initial_project = commands::cli::parse_initial_project();

    let builder = tauri::Builder::default();
    let builder = if service {
        builder
            .invoke_system("")
            .register_uri_scheme_protocol("deskmate-runtime", |_, _| {
                tauri::http::Response::builder()
                    .header("Content-Type", "text/html")
                    .header(
                        "Content-Security-Policy",
                        "default-src 'none'; frame-src 'none'; script-src 'none'",
                    )
                    .body(b"<!doctype html><title>DeskMate Background</title>".to_vec())
                    .unwrap()
            })
    } else {
        builder
    };

    // Single-instance — RELEASE ONLY. When the user runs `atlas <path>` while
    // Atlas is already open, the shell helper's `open -n` spawns a fresh
    // process; this plugin forwards that process's argv to the running
    // instance (firing this callback) and the duplicate exits.
    //
    // It is intentionally NOT registered in debug builds: otherwise
    // `tauri dev` is killed the instant it starts whenever the installed
    // /Applications/Atlas.app is running — the dev process is treated as the
    // "second instance", forwards its (empty) argv, and exits. Skipping it in
    // debug lets dev and the installed app coexist.
    #[cfg(not(debug_assertions))]
    let builder = if !service {
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Emitter;
            tracing::info!(target: "atlas::cli", "second-instance argv: {argv:?}");
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            // argv[0] is the executable path — strip it before parsing.
            let positional = argv.get(1..).unwrap_or(&[]);
            if let Some(path) = commands::cli::parse_project_path(positional) {
                let _ = app.emit("atlas:cli-open-project", path);
            }
        }))
    } else {
        builder
    };

    // Custom menu: replaces the default Window ▸ Close (Cmd+W) with a
    // "Close Tab" item so Cmd+W in a focused embedded browser webview closes
    // the tab instead of tearing down the window. See `menu.rs`.
    //
    // macOS only. Elsewhere a menu is a Win32/GTK menu bar drawn inside the
    // window under Atlas's own titlebar, and the key-equivalent fallthrough it
    // exists to catch is AppKit behaviour.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(|app, event| {
        if event.id() == menu::CLOSE_TAB_ID {
            use tauri::Emitter;
            let _ = app.emit("atlas:close-active-tab", ());
        }
    });

    builder
        .setup(|app| {
            let runtime = background::prepare(app.handle()).map_err(std::io::Error::other)?;
            let client = runtime.role == background::Role::Client;
            let server = runtime.role == background::Role::Server;
            app.manage(runtime);
            if server {
                background::install_server(app.handle()).map_err(std::io::Error::other)?;
            }
            // Pre-load the Rust-owned `AppState` (currentProject + recents)
            // before the webview starts loading — paid in parallel with the
            // WebView framework init, ~1ms on warm cache. `legacy_settings_raw`
            // is the old `settings` object exactly as it appeared in a
            // pre-#64 `state.json`, if any — `AppState` no longer has that
            // field, so it's carried separately for the one-time migration
            // below rather than being silently dropped by serde.
            let (mut loaded, legacy_settings_raw) = AppState::load(app.handle());
            // `config.toml` (issue #64): user preferences move out of
            // `state.json.settings` into their own validated, human-editable
            // file. `bootstrap` imports the legacy settings exactly once,
            // guarded by `settings_config_migrated` so a user who later
            // deletes `config.toml` on purpose never gets it silently
            // resurrected from stale `state.json` data.
            let migration = state::atlas_config::bootstrap(
                loaded.settings_config_migrated,
                legacy_settings_raw,
            );
            let migration_marker_changed =
                migration.mark_migrated && !loaded.settings_config_migrated;
            if migration_marker_changed {
                loaded.settings_config_migrated = true;
            }
            // The engine reads this gate on its first connect, which happens
            // after setup — so it must be in the environment before then.
            // Opaque window background, in the theme the user actually chose.
            // Fills the brief gap between window-shown and first React paint
            // with the theme's own background instead of the WebKit default
            // white — and, since PR 2, instead of a black frame that a
            // non-black theme then jumped away from. `index.html` replays the
            // same colour from localStorage for the gap after that.
            //
            // Deliberately AFTER `bootstrap`: the colour is a config read, and
            // config.toml is parsed a few microseconds into a setup that runs
            // in parallel with the WebView framework init. The window is still
            // not on screen.
            //
            // The window is opaque rather than a transparent NSWindow + HudWindow
            // NSVisualEffectView blur (window_vibrancy). Removed: the live
            // backdrop blur forced the macOS WindowServer to recomposite the
            // whole window against everything behind it every frame, which made
            // Mission Control / Spaces transitions lag system-wide whenever
            // Atlas was the focused window. An opaque window can be snapshotted
            // as a flat texture, so the OS animation stays smooth.
            if let Some(window) = app.get_webview_window("main") {
                let settings = migration.manager.effective();
                let system_is_light = matches!(window.theme(), Ok(tauri::Theme::Light));
                let color = window_background::window_background(
                    &settings.theme,
                    settings.theme_mode,
                    system_is_light,
                );
                let _ = window.set_background_color(Some(color));
            }
            // The app icon, before the window shows. Later changes arrive
            // through `notify_settings_changed`.
            app_icon::apply(app.handle(), &migration.manager.effective().app_icon);
            // Whether `instructionSync` is on as Atlas starts, so switching it
            // off before any project opens still takes the mirrored blocks out.
            app.state::<commands::instruction_sync::InstructionSyncState>()
                .init(migration.manager.effective().instruction_sync);
            let atlas_config: state::AtlasConfigHandle = Arc::new(Mutex::new(migration.manager));
            app.manage(atlas_config.clone());
            let keep_awake = Arc::new(keep_awake::KeepAwakeManager::new(
                atlas_config.lock().effective().keep_awake_while_running,
            ));
            app.manage(keep_awake);
            commands::atlas_config::start_watcher(app.handle(), atlas_config);
            commands::themes::start_watcher(app.handle());

            // Mirror the (possibly updated) telemetry id + migration marker
            // back into `state.json` so both agree and a downgrade still
            // finds them. `AppStatePatch` stops the frontend wiping either.
            if migration_marker_changed {
                let _ = AppState::save(app.handle(), &loaded);
            }
            let app_state: AppStateHandle = Arc::new(Mutex::new(loaded));
            app.manage(app_state);

            // Bundled skills (`atlas-self-configure`, issue #64; `remember`):
            // install/upgrade them into the canonical global skills store so
            // they're discoverable the same way any other managed skill is.
            // The dev profile seeds its own `atlas-dev-self-configure`
            // beside the released app's, and never overwrites a shared one:
            // that store (`~/.agents/skills`) is shared with the released app.
            commands::skills::ensure_bundled_skills();

            if !client {
                commands::ssh::SshState::install(app.handle())?;
            }
            if !client {
                commands::browser_use::BrowserUseState::install(app.handle());
            }
            // The code index: one SQLite index + worker per open project,
            // fed by the file and git watchers. Managed before
            // `install_manager`, whose code tool server reads it. The
            // observer tells the window a job finished; the status pill
            // re-reads `codebase_index_status` on it.
            {
                use tauri::Emitter;
                let code_app = app.handle().clone();
                let code_index = Arc::new(commands::code_index::CodeIndexRegistry::new(Some(
                    Arc::new(
                        move |project: &str, job: &'static str, result: &Result<bool, String>| {
                            let _ = code_app.emit(
                                "atlas:codebase-index:progress",
                                serde_json::json!({
                                    "phase": if result.is_ok() { "done" } else { "error" },
                                    "current": 0,
                                    "total": 0,
                                    "project": project,
                                    "job": job,
                                }),
                            );
                        },
                    ),
                )));
                app.manage(code_index);
                // Load the selected code embedding model in the background;
                // until it is ready, semantic search is keyword + symbol.
                let embed_app = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    commands::code_index::embed::refresh(&embed_app).await;
                });
            }

            if !client {
                if let Err(error) = scheduler::Scheduler::install(app.handle()) {
                    let message = format!("Task scheduler unavailable: {error}");
                    tracing::error!("{message}");
                    app.manage(scheduler::SchedulerUnavailable(message));
                }
                app.manage(personal::PersonalState::open(app.path().app_config_dir()?));
                commands::agents::install_manager(app.handle());
            }
            // Silent background refresh of model pricing from models.dev — first
            // launch populates the cache; later launches update only on change.
            commands::models_pricing::refresh_in_background(app.handle());
            if !client {
                app.state::<commands::capture::CaptureState>()
                    .install_notifier(app.handle().clone());

                app.manage(Arc::new(notifier::Notifier::new(app.handle())));
            }

            // Background memory indexer (Step 4): a single owned Tokio task drains
            // a bounded queue and indexes each open project's corpus into its
            // per-project `atlas_memory::MemoryEngine`, off the chat hot path. The
            // `MemoryRegistry` is the cwd-keyed owner of every engine, shared by
            // the indexer (write lock) and — later — the retrieve closure (read
            // lock). Wired here so the queue + registry outlive every window.
            let (job_tx, job_rx) = tokio::sync::mpsc::channel::<commands::memory_indexer::Job>(
                commands::memory_indexer::QUEUE_CAPACITY,
            );
            let registry = Arc::new(commands::memory_indexer::MemoryRegistry::new(job_tx));
            app.manage(registry.clone());
            let indexer_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                commands::memory_indexer::MemoryIndexer::run(indexer_app, registry, job_rx).await;
            });
            background::start(app.handle()).map_err(std::io::Error::other)?;
            if !server {
                scheduler::Scheduler::start(app.handle());
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(commands::browser::BrowserState::new())
        .manage(TerminalState::new())
        .manage(commands::modelchat::ModelChatState::new())
        .manage(FileIndexState::new())
        .manage(GitWatcherState::new())
        .manage(commands::instruction_sync::InstructionSyncState::new())
        .manage(RecentFilesState::new())
        .manage(MentionCacheState::new())
        .manage(Arc::new(KnowledgeMetaState::new()))
        .manage(Arc::new(KnowledgeLinksState::new()))
        .manage(CliLaunchState::new(initial_project))
        .manage(commands::memory_sharing::MemorySharingState::new())
        .manage(commands::shared_memory::SharedMemoryStore::new())
        // Owns the per-Project session stores and the capture worker
        // thread. Managed before `install_manager` runs its pipeline so a
        // delta arriving early finds it.
        .manage(commands::capture::CaptureState::new())
        // Drop a window's per-window index + mention caches when it closes, so
        // its file watcher stops and memory is freed (these states are keyed by
        // webview label for multi-window project scoping).
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Destroyed => {
                let label = window.label();
                background::client_window_destroyed(window.app_handle(), label);
                if let Some(root) = window.state::<FileIndexState>().drop_window(label) {
                    commands::fileindex::close_code_index(window.app_handle(), &root);
                }
                window.state::<MentionCacheState>().drop_window(label);
                window
                    .state::<commands::instruction_sync::InstructionSyncState>()
                    .drop_window(label);
            }
            _ => {}
        })
        .invoke_handler({
            let handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
                background::background_status,
                background::background_attach,
                background::background_configure,
                background::background_restart,
                commands::tasks::tasks_snapshot,
                commands::tasks::tasks_upsert,
                commands::personal::personal_snapshot,
                commands::personal::personal_session,
                commands::personal::personal_save_memory,
                commands::personal::personal_forget_memory,
                commands::personal::personal_confirm_memory,
                commands::personal::personal_dismiss_memory,
                commands::personal::personal_confirm_proposal,
                commands::personal::personal_dismiss_proposal,
                commands::tasks::tasks_control,
                commands::tasks::tasks_reopen,
                commands::tasks::tasks_delete,
                commands::tasks::tasks_runs,
                commands::tasks::tasks_mark_read,
                commands::tasks::tasks_calendar_preview,
                commands::tasks::tasks_occurrences,
                commands::tasks::tasks_control_occurrence,
                commands::ssh::ssh_snapshot,
                commands::ssh::ssh_clear_history,
                commands::ssh::ssh_save,
                commands::ssh::ssh_delete,
                commands::ssh::ssh_probe,
                commands::ssh::ssh_trust,
                commands::ssh::ssh_test,
                commands::ssh::ssh_decide,
                commands::ssh::ssh_revoke,
                commands::ssh::ssh_disconnect,
                commands::ssh::ssh_cancel,
                commands::ssh::ssh_associations,
                commands::ssh::ssh_associate,
                commands::notifier::notifier_init,
                commands::notifier::notifier_request_authorization,
                commands::notifier::notifier_show,
                commands::notifier::notifier_remove,
                commands::notifier::notifier_remove_group,
                commands::notifier::notifier_icon_lookup,
                commands::notifier::notifier_icon_store,
                commands::window::window_zoom,
                commands::clipboard::clipboard_file_paths,
                commands::clipboard::clipboard_write_text,
                commands::clipboard::scratch_write_bytes,
                commands::window::set_window_title,
                commands::browser::browser_open_window,
                commands::browser::browser_embed_create,
                commands::browser::browser_embed_navigate,
                commands::browser::browser_embed_back,
                commands::browser::browser_embed_forward,
                commands::browser::browser_embed_reload,
                commands::browser::browser_embed_set_bounds,
                commands::browser::browser_embed_set_visible,
                commands::browser::browser_embed_destroy,
                commands::browser_use::browser_use_snapshot,
                commands::browser_use::browser_use_manage,
                commands::browser_use::browser_use_forget,
                commands::browser_use::browser_use_connect,
                commands::browser_use::browser_use_pause,
                commands::browser_use::browser_use_stop,
                commands::terminal::terminal_create,
                commands::terminal::terminal_zsh_dir,
                commands::terminal::terminal_write,
                commands::terminal::terminal_write_text,
                commands::terminal::terminal_resize,
                commands::terminal::terminal_kill_foreground,
                commands::terminal::terminal_close,
                commands::terminal::terminal_ack,
                commands::terminal::terminal_resolve_path,
                commands::terminal::resolve_path,
                commands::terminal::terminal_path_complete,
                commands::terminal::terminal_list_commands,
                commands::fs::read_directory,
                commands::fs::read_file_content,
                commands::fs::read_file_base64,
                commands::fs::capture_screenshot,
                commands::fs::is_text_file,
                commands::fs::file_mtime_ms,
                commands::fs::asset_allow_dir,
                commands::fs::write_file_content,
                commands::fs::write_file_base64,
                commands::fs::ensure_atlas_gitignore,
                commands::fs::fs_create_file,
                commands::fs::fs_create_dir,
                commands::fs::fs_rename,
                commands::fs::fs_delete,
                commands::fs::fs_copy,
                commands::fs::fs_duplicate,
                commands::fs::fs_open_in_terminal,
                commands::fs::fs_add_to_gitignore,
                commands::git::git_status_fresh,
                commands::git::git_workspace_summary,
                commands::usage_dashboard::usage_dashboard,
                commands::capture::capture_session_summary,
                commands::usage_dashboard::usage_export_markdown,
                commands::usage_dashboard::usage_write_file,
                commands::git::git_blame_file,
                commands::git_snapshot::git_snapshot,
                commands::git_watcher::git_watch_start,
                commands::git_watcher::git_watch_stop,
                commands::instruction_sync::instruction_sync_start,
                commands::instruction_sync::instruction_sync_stop,
                commands::capture::capture_detect,
                commands::capture::capture_binding,
                commands::capture::capture_enable,
                commands::capture::capture_disable,
                commands::capture::capture_git_init,
                commands::capture::capture_git_available,
                commands::capture::capture_health,
                commands::capture::capture_import_preview,
                commands::capture::capture_import_confirm,
                commands::capture::capture_activate,
                commands::capture::capture_retry_watcher,
                commands::capture::artifacts_session,
                commands::capture::artifacts_payload,
                commands::capture::artifacts_board,
                commands::capture::artifacts_checkpoints,
                commands::mention_search::mention_search,
                commands::mention_search::mention_cache_set_knowledge,
                commands::mention_search::mention_cache_clear,
                commands::recent_files::recent_files_open_project,
                commands::recent_files::recent_files_close_project,
                commands::recent_files::recent_files_push,
                commands::recent_files::recent_files_rename,
                commands::recent_files::recent_files_clear,
                commands::github::search_github,
                commands::github::clone_github_repo,
                commands::github::list_cloned_repos,
                commands::github::read_repo_readme,
                commands::github::delete_cloned_repo,
                // Legacy Claude-CLI subprocess commands (claude_run/stream/stop/check/version)
                // were replaced by ACP. Session-history readers below are still in use.
                commands::gitdiff::git_diff_structured,
                commands::gitdiff::diff_structured_text,
                commands::gitdiff::git_commit_changed_files,
                commands::gitdiff::git_diff_line_status,
                commands::code_server::code_grep,
                commands::project_session::save_project_session,
                commands::project_session::load_project_session,
                commands::knowledge::list_knowledge,
                commands::knowledge::save_knowledge_note,
                commands::knowledge::import_into_knowledge,
                commands::knowledge::delete_knowledge_note,
                commands::knowledge::create_knowledge_dir,
                commands::knowledge::log_interaction,
                commands::knowledge::save_editor_state,
                commands::knowledge::load_editor_state,
                commands::knowledge::fetch_readable,
                commands::knowledge::knowledge_cover_upload,
                commands::knowledge::knowledge_cover_data_url,
                commands::knowledge_meta::knowledge_meta_load,
                commands::knowledge_meta::knowledge_meta_patch,
                commands::knowledge_meta::knowledge_meta_delete,
                commands::knowledge_links::knowledge_backlinks,
                commands::knowledge_links::knowledge_link_counts,
                commands::knowledge_links::knowledge_links_invalidate,
                commands::knowledge_links::knowledge_links_graph,
                commands::knowledge_export::knowledge_export_note_md,
                commands::knowledge_export::knowledge_export_note_html,
                commands::knowledge_export::knowledge_export_workspace_md,
                commands::knowledge_export::knowledge_export_workspace_html,
                commands::knowledge_export::knowledge_export_server,
                commands::knowledge_graph_layout::knowledge_graph_layout_load,
                commands::knowledge_graph_layout::knowledge_graph_layout_save,
                commands::canvas::load_canvas,
                commands::canvas::save_canvas,
                commands::canvas::canvas_media_upload,
                commands::canvas::canvas_media_data_url,
                commands::log::load_pinned_log,
                commands::log::append_pinned_log,
                commands::log::clear_pinned_log,
                commands::log::rewrite_pinned_log,
                commands::log::load_project_log,
                commands::log::append_project_log,
                commands::log::clear_project_log,
                commands::app_state::bootstrap_app_state,
                commands::app_state::save_app_state,
                commands::app_state::app_profile,
                commands::atlas_config::get_atlas_config_info,
                commands::atlas_config::update_atlas_settings,
                commands::atlas_config::reset_atlas_config,
                commands::atlas_config::open_atlas_config,
                commands::themes::list_themes,
                commands::themes::get_theme,
                commands::theme_import::preview_theme_import,
                commands::theme_import::commit_theme_import,
                commands::theme_import::export_theme_shadcn,
                commands::icon_themes::list_icon_themes,
                commands::icon_themes::resolve_icons,
                commands::icon_themes::get_icon_theme_assets,
                commands::icon_themes::get_icon_theme_fonts,
                commands::icon_themes::search_icon_themes,
                commands::icon_themes::install_icon_theme,
                commands::icon_themes::remove_icon_theme,
                commands::compose_prompt::compose_prompt,
                commands::cli::cli_status,
                commands::cli::cli_install_helper,
                commands::cli::cli_take_initial_project_path,
                commands::registry::acp_registry_list,
                commands::registry::acp_registry_refresh,
                commands::registry::acp_registry_install,
                commands::registry::acp_registry_install_detected,
                commands::registry::acp_registry_uninstall,
                commands::registry::acp_registry_update,
                commands::registry::acp_registry_metadata,
                // The unified read surface. `agents_list_plugins` /
                // `acp_registry_list` stay registered and delegating for one
                // release so a stale frontend keeps working.
                commands::catalog::agents_catalog,
                commands::catalog::agents_catalog_refresh,
                commands::agents::agents_list_running,
                commands::agents::agents_spawn,
                commands::agents::agents_kill,
                commands::agents::agents_kill_plugin,
                commands::diagnostics::agents_start_diagnostics,
                commands::agents::agents_new_session,
                commands::agents::agents_load_session,
                commands::agents::agents_replay_transcript,
                commands::agents::agent_transcripts_list,
                commands::agents::agent_transcripts_read,
                commands::agents::threads_resume,
                commands::agents::threads_delete,
                commands::agents::threads_import_candidates,
                commands::agents::threads_import,
                commands::agents::threads_sync_project,
                commands::agents::threads_projects,
                commands::agents::threads_history,
                commands::agents::threads_archive,
                commands::agents::agents_snapshot,
                commands::agents::agents_snapshot_meta,
                commands::agents::agents_send,
                commands::agents::agents_steer,
                commands::agents::agents_cancel,
                commands::agents::agents_set_mode,
                commands::agents::agents_set_model,
                commands::models_pricing::models_pricing_get,
                commands::models_pricing::models_pricing_refresh,
                commands::agents::agents_respond_permission,
                commands::agents::agents_list_auth_methods,
                commands::agents::agents_auth_env_status,
                commands::agents::agents_logout,
                commands::agents::agents_set_config_option,
                commands::agents::agents_respond_elicitation,
                commands::agents::agents_rewind_last_turn,
                commands::agents::agents_run_auth_method,
                commands::agents::agents_authenticate,
                commands::agents::agents_drop_session,
                commands::byok::byok_env_list,
                commands::byok::byok_env_entries,
                commands::byok::byok_env_reveal,
                commands::byok::byok_env_set,
                commands::byok::byok_env_unset,
                commands::byok::byok_profile_info,
                commands::modelchat::modelchat_models,
                commands::modelchat::modelchat_stream,
                commands::modelchat::modelchat_cancel,
                commands::fileindex::fileindex_open_project,
                commands::fileindex::fileindex_close_project,
                commands::fileindex::fileindex_search,
                commands::fileindex::fileindex_search_dirs,
                commands::fileindex::fileindex_status,
                commands::plans::plans_load,
                commands::plans::plans_append,
                commands::keybindings::keybindings_load,
                commands::keybindings::keybindings_save,
                commands::keybindings::keybindings_open,
                commands::keybindings::keybindings_set_close_tab_accelerator,
                commands::memory_graph::memory_embed_status,
                commands::memory_graph::memory_embed_download,
                commands::memory_graph::memory_index_build,
                commands::memory_graph::memory_index_query,
                commands::memory_graph::memory_graph_layout_load,
                commands::memory_graph::memory_graph_layout_save,
                commands::memory_policy::memory_policies,
                commands::memory_policy::memory_policy_update,
                commands::memory_sharing::memory_sharing_get,
                commands::memory_sharing::memory_sharing_set,
                commands::memory_sharing::memory_summarizer_get,
                commands::memory_sharing::memory_summarizer_set,
                commands::shared_memory::memory_get_state,
                commands::shared_memory::memory_query,
                commands::shared_memory::memory_list_events,
                commands::shared_memory::memory_clear_project,
                commands::shared_memory::memory_append_event,
                commands::shared_memory::memory_list_entries,
                commands::shared_memory::memory_edit_entry,
                commands::shared_memory::memory_forget_entry,
                commands::claude_memory_import::memory_claude_import_preview,
                commands::claude_memory_import::memory_claude_import_confirm,
                commands::memory_indexer::force_reindex,
                commands::memory_indexer::memory_indexer_close_project,
                commands::models::models_list,
                commands::models::model_download,
                commands::models::model_remove,
                commands::models::model_select,
                commands::code_index::codebase_index_status,
                commands::code_index::codebase_index_build,
                commands::session_chat::session_chat_retrieve,
                commands::session_chat_sessions::session_chat_threads_list,
                commands::session_chat_sessions::session_chat_thread_get,
                commands::session_chat_sessions::session_chat_thread_save,
                commands::session_chat_sessions::session_chat_thread_delete,
                commands::pdf_annotations::pdf_annotations_load,
                commands::pdf_annotations::pdf_annotations_save,
                commands::skills::skills_list,
                commands::skills::skills_read,
                commands::skills::skills_set_enabled,
                commands::skills::skills_delete,
                commands::skills::skills_path,
                commands::skills::skills_adopt,
                commands::skills::agents_list_skill_targets,
                commands::skills::tools_list,
                commands::skills::skills_reconcile,
                commands::skills::skills_project,
                commands::skills::skills_unproject,
                commands::skills::skills_promote,
                commands::skills::skills_freeze,
                commands::skills::pack_inspect,
                commands::skills::pack_search,
                commands::skills::pack_remote_preview,
                commands::skills::pack_install_remote,
                commands::skills::pack_install_skill,
                commands::skills::pack_list,
                commands::skills::pack_check_update,
                commands::skills::pack_project,
                commands::skills::pack_unproject,
                commands::skills::pack_uninstall,
                commands::skills::pack_projections,
                commands::skills::pack_components_list,
            ];
            move |invoke: tauri::ipc::Invoke| {
                if background::remote(&invoke) {
                    background::client::forward(invoke)
                } else {
                    handler(invoke)
                }
            }
        })
        .build(context)
        .expect("error while building DeskMate")
        .run(|app_handle, event| {
            match event {
                tauri::RunEvent::ExitRequested { .. } => {
                    background::mark_exiting(app_handle);
                    background::cleanup_endpoint(app_handle);
                    if let Some(scheduler) = app_handle.try_state::<Arc<scheduler::Scheduler>>() {
                        scheduler.stop();
                    }
                    if let Some(browser) =
                        app_handle.try_state::<Arc<commands::browser_use::BrowserUseState>>()
                    {
                        browser.shutdown_and_wait();
                    }
                    // Quit sweep: tear down every ACP subprocess
                    // (dropping each driver's shutdown channel closes the
                    // child's stdin; the SDK reaps it). `process::exit` skips
                    // Drop impls, so this must happen before the exit — with a
                    // short bounded grace for the async teardown to run.
                    if let Some(host) =
                        app_handle.try_state::<Arc<commands::agent_host::AgentHost>>()
                    {
                        host.shutdown();
                        std::thread::sleep(std::time::Duration::from_millis(500));
                    }
                }
                tauri::RunEvent::Exit => {}
                _ => {}
            }
        });
}
