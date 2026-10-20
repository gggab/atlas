// Only application commands without Window, Channel or plugin arguments cross processes.
pub fn owns(command: &str) -> bool {
    matches!(
        command,
        "tasks_snapshot"
            | "tasks_upsert"
            | "tasks_control"
            | "tasks_runs"
            | "tasks_reopen"
            | "tasks_delete"
            | "tasks_mark_read"
            | "tasks_calendar_preview"
            | "tasks_occurrences"
            | "tasks_control_occurrence"
            | "personal_snapshot"
            | "personal_session"
            | "personal_save_memory"
            | "personal_forget_memory"
            | "personal_confirm_memory"
            | "personal_dismiss_memory"
            | "personal_confirm_proposal"
            | "personal_dismiss_proposal"
            | "agents_list_running"
            | "agents_spawn"
            | "agents_kill"
            | "agents_kill_plugin"
            | "agents_new_session"
            | "agents_authenticate"
            | "agents_respond_elicitation"
            | "agents_rewind_last_turn"
            | "agents_set_config_option"
            | "agents_logout"
            | "agents_replay_transcript"
            | "agent_transcripts_list"
            | "agent_transcripts_read"
            | "agents_load_session"
            | "threads_resume"
            | "threads_delete"
            | "threads_projects"
            | "threads_history"
            | "threads_archive"
            | "threads_import_candidates"
            | "threads_import"
            | "threads_sync_project"
            | "agents_snapshot"
            | "agents_snapshot_meta"
            | "agents_send"
            | "agents_steer"
            | "agents_cancel"
            | "agents_drop_session"
            | "agents_set_mode"
            | "agents_set_model"
            | "agents_respond_permission"
            | "agents_auth_env_status"
            | "agents_list_auth_methods"
            | "agents_run_auth_method"
            | "agents_start_diagnostics"
            | "agents_catalog"
            | "agents_catalog_refresh"
            | "acp_registry_list"
            | "acp_registry_refresh"
            | "acp_registry_update"
            | "acp_registry_install"
            | "acp_registry_install_detected"
            | "acp_registry_uninstall"
            | "acp_registry_metadata"
            | "byok_env_list"
            | "byok_profile_info"
            | "byok_env_entries"
            | "byok_env_reveal"
            | "byok_env_set"
            | "byok_env_unset"
            | "notifier_init"
            | "notifier_request_authorization"
            | "notifier_show"
            | "notifier_remove"
            | "notifier_remove_group"
            | "notifier_icon_lookup"
            | "notifier_icon_store"
            | "capture_detect"
            | "capture_binding"
            | "capture_enable"
            | "capture_disable"
            | "capture_import_preview"
            | "capture_import_confirm"
            | "capture_git_init"
            | "capture_activate"
            | "capture_health"
            | "capture_retry_watcher"
            | "artifacts_session"
            | "capture_session_summary"
            | "artifacts_board"
            | "artifacts_checkpoints"
            | "capture_commit_sessions"
            | "artifacts_payload"
            | "capture_git_available"
            | "browser_use_snapshot"
            | "browser_use_manage"
            | "browser_use_forget"
            | "browser_use_connect"
            | "browser_use_pause"
            | "browser_use_stop"
            | "bootstrap_app_state"
            | "save_app_state"
            | "get_atlas_config_info"
            | "update_atlas_settings"
            | "reset_atlas_config"
            | "memory_sharing_get"
            | "memory_sharing_set"
            | "memory_summarizer_get"
            | "memory_summarizer_set"
            | "memory_policies"
            | "memory_policy_update"
            | "memory_get_state"
            | "memory_query"
            | "memory_list_events"
            | "memory_clear_project"
            | "memory_append_event"
            | "memory_list_entries"
            | "memory_purge_entry"
            | "memory_accept_history"
            | "memory_entry_provenance"
            | "memory_entry_history"
            | "memory_feedback_entry"
            | "memory_session_writes"
            | "memory_review"
            | "memory_promote"
            | "memory_archive"
            | "memory_merge"
            | "memory_resolve_conflict"
            | "memory_edit_entry"
            | "memory_forget_entry"
            | "force_reindex"
            | "memory_health_status"
            | "memory_indexer_close_project"
            | "codebase_index_status"
            | "codebase_index_build"
            | "memory_embed_status"
            | "memory_embed_download"
            | "memory_index_build"
            | "memory_index_query"
            | "memory_graph_layout_load"
            | "memory_graph_layout_save"
            | "memory_claude_import_preview"
            | "memory_claude_import_confirm"
            | "models_list"
            | "model_download"
            | "model_remove"
            | "model_select"
            | "ssh_snapshot"
            | "ssh_clear_history"
            | "ssh_save"
            | "ssh_delete"
            | "ssh_probe"
            | "ssh_trust"
            | "ssh_test"
            | "ssh_decide"
            | "ssh_revoke"
            | "ssh_disconnect"
            | "ssh_cancel"
            | "ssh_associations"
            | "ssh_associate"
    )
}

pub const EVENTS: &[&str] = &[
    "atlas:agents",
    "atlas:threads-changed",
    "atlas:agent-elicitation",
    "atlas:agent-elicitation-resolved",
    "atlas:agent-catalog:changed",
    "atlas:auth-run:stdout",
    "atlas:auth-run:stderr",
    "atlas:auth-run:done",
    "atlas:tasks-changed",
    "atlas:personal-changed",
    "atlas:notification-response",
    "atlas:config-changed",
    "atlas:config-error",
    "atlas:browser-use-changed",
    "atlas:memory-changed",
    "atlas:memory-health",
    "atlas:capture-changed",
    "atlas:registry-install:progress",
    "ssh-changed",
    "atlas:codebase-index:progress",
    "atlas:memory-embed:progress",
    "atlas:memory-embed:done",
    "atlas:models-changed",
    "atlas:model-download:progress",
    "atlas:model-download:done",
];

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_boundary_rejects_native_windows_plugins_and_unknown_commands() {
        for name in [
            "tasks_delete",
            "agents_send",
            "agents_respond_permission",
            "personal_session",
            "threads_resume",
        ] {
            assert!(owns(name));
        }
        for name in [
            "plugin:window|close",
            "window_zoom",
            "fileindex_open_project",
            "capture_screenshot",
            "agents_invented",
        ] {
            assert!(!owns(name));
        }
    }

    #[test]
    fn every_agent_owner_command_is_forwarded_and_has_no_window_or_channel_argument() {
        let registry = include_str!("../lib.rs")
            .split_once("tauri::generate_handler![")
            .unwrap()
            .1
            .split_once("];")
            .unwrap()
            .0;
        let modules = [
            ("agents", include_str!("../commands/agents.rs")),
            ("catalog", include_str!("../commands/catalog.rs")),
            ("registry", include_str!("../commands/registry.rs")),
            ("personal", include_str!("../commands/personal.rs")),
            ("tasks", include_str!("../commands/tasks.rs")),
            ("browser_use", include_str!("../commands/browser_use.rs")),
            ("byok", include_str!("../commands/byok.rs")),
            ("notifier", include_str!("../commands/notifier.rs")),
            ("capture", include_str!("../commands/capture.rs")),
            (
                "memory_sharing",
                include_str!("../commands/memory_sharing.rs"),
            ),
            ("ssh", include_str!("../commands/ssh.rs")),
            (
                "memory_indexer",
                include_str!("../commands/memory_indexer.rs"),
            ),
            (
                "shared_memory",
                include_str!("../commands/shared_memory.rs"),
            ),
            (
                "memory_policy",
                include_str!("../commands/memory_policy.rs"),
            ),
            ("code_index", include_str!("../commands/code_index/mod.rs")),
            ("memory_graph", include_str!("../commands/memory_graph.rs")),
            (
                "claude_memory_import",
                include_str!("../commands/claude_memory_import.rs"),
            ),
            ("models", include_str!("../commands/models.rs")),
        ];
        for (module, source) in modules {
            let prefix = format!("commands::{module}::");
            for item in registry.split(&prefix).skip(1) {
                let name: String = item
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                assert!(
                    owns(&name),
                    "{module}::{name} would execute against a missing/stale GUI owner"
                );
                let signature = source
                    .split_once(&format!("fn {name}("))
                    .unwrap()
                    .1
                    .split('{')
                    .next()
                    .unwrap();
                for forbidden in ["Webview", "Window", "Channel<", "ipc::Request"] {
                    assert!(
                        !signature.contains(forbidden),
                        "{name} cannot cross processes with {forbidden}"
                    );
                }
            }
        }
    }

    #[test]
    fn allowlist_contains_only_registered_application_commands() {
        let registry = include_str!("../lib.rs");
        for value in include_str!("commands.rs")
            .split("#[cfg(test)]")
            .next()
            .unwrap()
            .split('"')
            .skip(1)
            .step_by(2)
        {
            if owns(value) {
                assert!(
                    registry.contains(&format!("::{value},")),
                    "unregistered remote command {value}"
                );
            }
        }
    }
}
