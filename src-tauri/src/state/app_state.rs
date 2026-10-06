//! `AppState` — the small Rust-owned struct that mirrors what `useProjectStore`
//! used to persist via zustand's localStorage middleware. Shape matches the
//! JS side via `#[serde(rename_all = "camelCase")]` so the frontend can use
//! the deserialized payload verbatim.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// Current schema version. Bump and migrate (or reset) when fields change
/// shape. Older payloads with a smaller `version` are loadable as long as
/// the missing fields default to sensible values.
///
/// v2 introduced the multi-project model (`projects`/`groups`/
/// `active_workspace_id`); `current_project` is retained only as a
/// migration source for v1 payloads.
///
/// v3 introduced the Organisation layer above projects
/// (`organisations`/`active_organisation_id`, plus `org_id` on each
/// project/group). v2 payloads are migrated by wrapping all existing
/// projects in a default local "Personal" org.
///
/// v4 removed `AppSettings` from this struct entirely (issue #64) — user
/// preferences now live in their own validated `config.toml`
/// (`crate::state::atlas_config`). `settings_config_migrated` records whether
/// that one-time export already happened, so a user who deletes `config.toml`
/// afterward gets fresh defaults rather than a silent re-import of whatever
/// was last in `state.json`.
pub const SCHEMA_VERSION: u32 = 5;

/// Just enough to name a project: the {name, path} pair the legacy v1
/// `current_project` field and the recents list carry. `Project` proper is
/// below.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub name: String,
    pub path: String,
    /// ISO-8601 timestamp; the frontend reads this verbatim.
    pub last_opened: String,
    /// The Organisation this was opened under.
    ///
    /// `None` on every entry written before recents were scoped. The frontend
    /// backfills those from the project list by path rather than showing them
    /// everywhere: orgs are the tenant boundary, and an unscoped recents list
    /// put one org's project names and absolute paths in front of every other
    /// org, one click away from being forked into the wrong one.
    #[serde(default)]
    pub org_id: Option<String>,
}

/// A single open project = one project plus its UI state identity. The
/// `id` is the stable key that replaces `webview.label()` everywhere Rust
/// state used to be keyed per-window (file index, git watcher, mention
/// cache, recent files).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub group_id: Option<String>,
    /// Owning Organisation. `None` on pre-v3 payloads — `migrate()` backfills
    /// it to the default org. The sidebar filters projects by the active org.
    #[serde(default)]
    pub org_id: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// Optional git remote. The ONLY field (besides id/name) that syncs to the
    /// server (`workspace_refs.git_url`) for one-click clone; the source tree
    /// itself never syncs. `None` for local-only projects.
    #[serde(default)]
    pub git_url: Option<String>,
    /// Pinned to the top of the sidebar and kept out of the hot-set LRU.
    /// Frontend-owned; Rust only stores it. Absent from this struct until
    /// `tests/state-payload-contract.test.ts` found it: `pin()` scheduled a
    /// save and serde dropped the field, so a pin never survived a restart.
    #[serde(default)]
    pub pinned: bool,
    /// ISO-8601 timestamp of the last time this project was the active
    /// one; used to order the sidebar / pick a fallback on close.
    #[serde(default)]
    pub last_active_at: Option<String>,
}

/// A user-defined collapsible folder that groups projects in the sidebar.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectGroup {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub order: u32,
    /// Owning Organisation (mirrors `Project::org_id`). `None` on pre-v3
    /// payloads — `migrate()` backfills it to the default org.
    #[serde(default)]
    pub org_id: Option<String>,
    /// Pinned groups float to the top of the Recent tier. See `Project::pinned`
    /// for why this was missing.
    #[serde(default)]
    pub pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    /// Legacy single-project field. Kept for migration from v1 `state.json`;
    /// the frontend now derives "current project" from
    /// `active_workspace_id`. New writes leave this `None`.
    #[serde(default)]
    pub current_project: Option<ProjectRef>,
    #[serde(default)]
    pub recent_projects: Vec<RecentProject>,
    /// STORAGE KEYS, not concepts: `workspaces` and `active_workspace_id` are
    /// what `state.json` has held since v2, so renaming them would need a data
    /// migration and break every existing install. These are projects.
    #[serde(default)]
    pub workspaces: Vec<Project>,
    #[serde(default)]
    pub groups: Vec<ProjectGroup>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
    /// Whether the one-time `state.json.settings` → `config.toml` export
    /// (issue #64) has already run. See the `SCHEMA_VERSION` doc for why this
    /// can't just be "does config.toml exist".
    #[serde(default)]
    pub settings_config_migrated: bool,
    #[serde(default = "default_version")]
    pub version: u32,
}

fn default_version() -> u32 {
    SCHEMA_VERSION
}

/// The slice of [`AppState`] the **frontend** is allowed to write.
///
/// Deliberately a distinct type. `save_app_state` used to take a whole
/// `AppState` and do `*guard = payload`, so every Rust-owned field was silently
/// destroyed by any settings change: the frontend's `buildAppStatePayload()`
/// never sent `telemetryAnonId`, it deserialized to `None`, persisted as null,
/// and the next launch minted a fresh id. One device became a new analytics
/// person on every settings save.
///
/// Listing the frontend-owned fields here — rather than special-casing the one
/// field that got bitten — means the next Rust-owned field added to `AppState`
/// is safe by construction instead of by remembering.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatePatch {
    #[serde(default)]
    pub recent_projects: Vec<RecentProject>,
    /// STORAGE KEYS, not concepts: `workspaces` and `active_workspace_id` are
    /// what `state.json` has held since v2, so renaming them would need a data
    /// migration and break every existing install. These are projects.
    #[serde(default)]
    pub workspaces: Vec<Project>,
    #[serde(default)]
    pub groups: Vec<ProjectGroup>,
    #[serde(default)]
    pub active_workspace_id: Option<String>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            current_project: None,
            recent_projects: Vec::new(),
            workspaces: Vec::new(),
            groups: Vec::new(),
            active_workspace_id: None,
            settings_config_migrated: false,
            version: SCHEMA_VERSION,
        }
    }
}

impl AppState {
    /// Migrate a freshly-deserialized older payload in place. Idempotent —
    /// re-running on an already-migrated state is a no-op.
    ///
    /// v1 → v2: if no projects exist yet but a legacy `current_project` is
    /// present, synthesize a single project from it and make it active.
    ///
    /// v2 → v3: if no organisations exist yet, wrap every project/group in a
    /// default local "Personal" org and make it active.
    fn migrate(&mut self) {
        if self.workspaces.is_empty() {
            if let Some(project) = self.current_project.take() {
                let id = uuid::Uuid::new_v4().to_string();
                self.active_workspace_id = Some(id.clone());
                self.workspaces.push(Project {
                    id,
                    name: project.name,
                    path: project.path,
                    group_id: None,
                    org_id: None,
                    color: None,
                    git_url: None,
                    pinned: false,
                    last_active_at: None,
                });
            }
        }
        self.current_project = None;
        // Retire tenant ownership without dropping projects, groups or their UI ids.
        for project in &mut self.workspaces {
            project.org_id = None;
        }
        for group in &mut self.groups {
            group.org_id = None;
        }
        for recent in &mut self.recent_projects {
            recent.org_id = None;
        }

        self.version = SCHEMA_VERSION;
    }
}

/// Thread-safe handle registered as Tauri managed state.
pub type AppStateHandle = Arc<Mutex<AppState>>;

impl AppState {
    /// Apply a frontend save, preserving every Rust-owned field.
    ///
    /// The counterpart to [`AppStatePatch`]: what is absent from the patch is
    /// absent because Rust owns it, and stays untouched here.
    pub fn apply_patch(&mut self, p: AppStatePatch) {
        // Legacy v1 field — the frontend already sends `null` and derives the
        // current project from `active_workspace_id`. Never re-adopted.
        self.current_project = None;
        self.recent_projects = p.recent_projects;
        self.workspaces = p.workspaces;
        self.groups = p.groups;
        self.active_workspace_id = p.active_workspace_id;
        self.version = SCHEMA_VERSION;
        // `telemetry_anon_id` (and anything Rust adds later) is deliberately
        // NOT assigned here. See the `AppStatePatch` doc.
    }

    /// `<app_data_dir>/state.json`. Returns `None` if the data dir can't be
    /// resolved (no $HOME / no `APPDATA`, etc.) — caller falls back to
    /// `AppState::default()`.
    fn path(app: &AppHandle) -> Option<PathBuf> {
        app.path().app_data_dir().ok().map(|d| d.join("state.json"))
    }

    /// Read from disk synchronously. Designed to be called from `setup()`
    /// before the webview opens — the cost is one `fs::read_to_string` of a
    /// few-KB JSON file (~1 ms on warm cache). Falls back to `Self::default()`
    /// on any I/O or parse failure so a corrupt file never blocks app launch —
    /// and, like every other input, that fallback is still migrated (see
    /// [`Self::from_raw`]).
    ///
    /// Also returns the raw `settings` object, if any, exactly as it appeared
    /// in the file — the typed `AppState` no longer has a `settings` field
    /// (issue #64) so `serde_json` would otherwise silently drop it on the
    /// floor as an unrecognized key. The caller feeds this to
    /// `atlas_config::bootstrap` for the one-time `config.toml` export.
    pub fn load(app: &AppHandle) -> (Self, Option<serde_json::Value>) {
        let raw = Self::path(app).and_then(|path| std::fs::read_to_string(&path).ok());
        Self::from_raw(raw.as_deref())
    }

    /// The parse+migrate half of [`Self::load`], split out so it is reachable
    /// without an `AppHandle`.
    ///
    /// `None` is a FIRST RUN (no `state.json` yet, or no resolvable app data
    /// dir) and MUST still migrate. `load` used to return `Self::default()`
    /// straight from its early returns, which skipped `migrate()` and left
    /// `organisations` empty on a fresh install — the one input every other
    /// path seeds a "Personal" org for. The frontend filters every render
    /// surface by the active org and refuses to create a project without
    /// one, so the visible symptom was "Open Folder" picking a directory and
    /// doing nothing at all until the second launch, by which point the
    /// boot-time save in `setup()` had written a `state.json` for this path
    /// to parse and migrate.
    fn from_raw(raw: Option<&str>) -> (Self, Option<serde_json::Value>) {
        let legacy_settings = raw
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|v| v.get("settings").cloned());
        let mut state: AppState = raw
            .map(|raw| serde_json::from_str(raw).unwrap_or_default())
            .unwrap_or_default();
        state.migrate();
        (state, legacy_settings)
    }

    /// Merge `state` over whatever `state.json` already holds, rather than
    /// replacing the file wholesale.
    ///
    /// The typed `AppState` deliberately has no `settings` field any more
    /// (issue #64), so `to_string_pretty(state)` DROPS the legacy `settings`
    /// object — the very thing `atlas_config::bootstrap` still needs whenever
    /// migration hasn't succeeded yet. A save triggered for some unrelated
    /// reason (a rotated telemetry id, say) would then destroy the user's only
    /// surviving copy of their preferences. Merging preserves it, and any
    /// other key an older or newer build writes, for exactly the reason
    /// `config.toml` patches preserve unknown TOML keys.
    ///
    /// Once migration IS recorded as done the legacy copy has served its
    /// purpose and is dropped, so `state.json` doesn't carry a stale shadow of
    /// `config.toml` forever.
    fn merged_for_save(path: &Path, state: &AppState) -> serde_json::Result<serde_json::Value> {
        let mut merged = std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .filter(serde_json::Value::is_object)
            .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));

        let fresh = serde_json::to_value(state)?;
        if let (Some(dst), Some(src)) = (merged.as_object_mut(), fresh.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
            for key in [
                "organisations",
                "active_organisation_id",
                "activeOrganisationId",
                "telemetry_anon_id",
            ] {
                dst.remove(key);
            }
            if state.settings_config_migrated {
                dst.remove("settings");
            }
        }
        Ok(merged)
    }

    /// Atomic write — a uniquely-named temp file then `rename`, so a crash
    /// mid-write can never leave a torn JSON file behind.
    ///
    /// The temp name carries a UUID rather than being the fixed
    /// `state.json.tmp`: saves overlap in practice (the boot-time telemetry-id
    /// / migration-marker write against the frontend's debounced flush), and
    /// two of them sharing one temp path can interleave into exactly the torn
    /// file the rename is supposed to prevent. That matters more since
    /// [`Self::merged_for_save`] made this a read-modify-write, and because
    /// this file holds the only copy of the legacy settings until migration
    /// succeeds. `sync_all` before the rename is what makes the atomicity
    /// real — otherwise the rename can reach disk ahead of its bytes.
    pub fn save(app: &AppHandle, state: &AppState) -> std::io::Result<()> {
        use std::io::Write;

        let Some(path) = Self::path(app) else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "could not resolve app_data_dir",
            ));
        };
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension(format!("json.tmp.{}", uuid::Uuid::new_v4()));
        let merged = Self::merged_for_save(&path, state)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        let raw = serde_json::to_string_pretty(&merged)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        let written = (|| -> std::io::Result<()> {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(raw.as_bytes())?;
            f.sync_all()
        })();
        if let Err(e) = written {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        if let Err(e) = std::fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `state.json` path in its own temp directory. Keep the `TempDir` alive
    /// for the test: dropping it deletes the directory.
    fn tmp_state_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        (dir, path)
    }

    fn state_file_with_legacy_settings(path: &Path) {
        std::fs::write(
            path,
            serde_json::json!({
                "version": 1,
                "recentProjects": [],
                "settings": { "enterToSend": false, "gitBlameInline": false },
            })
            .to_string(),
        )
        .unwrap();
    }

    /// The typed `AppState` has no `settings` field any more (issue #64), so
    /// serializing it over `state.json` wholesale silently DELETES the legacy
    /// settings object. While `settings_config_migrated` is still false that
    /// object is the only surviving copy of the user's preferences —
    /// `config.toml` either doesn't exist yet or couldn't be read — and a save
    /// fired for an entirely unrelated reason (a rotated telemetry id) must
    /// not destroy it.
    #[test]
    fn a_save_before_migration_preserves_the_legacy_settings() {
        let (_dir, path) = tmp_state_path();
        state_file_with_legacy_settings(&path);

        let state = AppState {
            settings_config_migrated: false,
            ..AppState::default()
        };
        let merged = AppState::merged_for_save(&path, &state).unwrap();

        assert_eq!(
            merged.get("settings").and_then(|s| s.get("enterToSend")),
            Some(&serde_json::json!(false)),
            "the legacy settings must survive a save made for an unrelated reason"
        );
    }

    /// ...and once migration IS recorded, the legacy copy has served its
    /// purpose: drop it rather than carrying a stale shadow of `config.toml`
    /// in `state.json` forever.
    #[test]
    fn a_save_after_migration_drops_the_legacy_settings() {
        let (_dir, path) = tmp_state_path();
        state_file_with_legacy_settings(&path);

        let state = AppState {
            settings_config_migrated: true,
            ..AppState::default()
        };
        let merged = AppState::merged_for_save(&path, &state).unwrap();

        assert!(
            merged.get("settings").is_none(),
            "a migrated state.json keeps no settings shadow"
        );
    }

    /// Merging must not resurrect stale values for keys the struct owns — the
    /// fresh state always wins on its own fields.
    #[test]
    fn merging_lets_the_live_state_win_on_its_own_fields() {
        let (_dir, path) = tmp_state_path();
        std::fs::write(
            &path,
            serde_json::json!({ "version": 1, "settingsConfigMigrated": false, "recentProjects": [
                { "name": "old", "path": "/old", "lastOpened": "then" }
            ]})
            .to_string(),
        )
        .unwrap();

        let state = AppState {
            settings_config_migrated: true,
            ..AppState::default()
        };
        let merged = AppState::merged_for_save(&path, &state).unwrap();

        assert_eq!(merged["settingsConfigMigrated"], serde_json::json!(true));
        assert_eq!(merged["recentProjects"], serde_json::json!([]));
    }

    /// Exactly the payload `buildAppStatePayload()` sends — note the absence of
    /// `telemetryAnonId`, which is the whole point.
    ///
    /// `activeWorkspaceId` is the FROZEN wire key (see `AppStatePatch`): the
    /// rename to "project" stopped at the storage boundary. This fixture used
    /// to say `activeProjectId`, which `AppStatePatch` — no
    /// `deny_unknown_fields` — silently dropped, so every assertion below ran
    /// against a field the frontend had never actually set.
    fn frontend_payload() -> AppStatePatch {
        serde_json::from_value(serde_json::json!({
            "currentProject": null,
            "recentProjects": [],
            "workspaces": [],
            "groups": [],
            "activeWorkspaceId": "proj-1",
            "organisations": [],
            "activeOrganisationId": null,
            "version": 4,
        }))
        .expect("frontend payload deserializes as a patch")
    }

    /// Guards the fixture itself: if the frozen key is ever mistyped again, the
    /// payload deserializes to `None` and this fails instead of passing quietly.
    #[test]
    fn frontend_payload_carries_the_frozen_active_project_key() {
        assert_eq!(
            frontend_payload().active_workspace_id.as_deref(),
            Some("proj-1")
        );
    }

    /// `pinned` was frontend-only: `pin()` scheduled a save and serde threw the
    /// field away, so a pinned project or group came back unpinned on the next
    /// launch. Found by `tests/state-payload-contract.test.ts`.
    #[test]
    fn a_project_and_a_group_keep_their_pin() {
        let patch: AppStatePatch = serde_json::from_value(serde_json::json!({
            "workspaces": [{ "id": "p1", "name": "a", "path": "/a", "pinned": true }],
            "groups": [{ "id": "g1", "name": "g", "pinned": true }],
        }))
        .expect("patch deserializes");
        assert!(patch.workspaces[0].pinned);
        assert!(patch.groups[0].pinned);
    }

    /// A patch with unknown/extra keys (an older or newer frontend) still parses,
    /// and absent keys fall back to their defaults rather than failing the save.
    #[test]
    fn patch_tolerates_partial_payloads() {
        let patch: AppStatePatch =
            serde_json::from_value(serde_json::json!({ "recentProjects": [] }))
                .expect("partial payload");
        let mut state = AppState {
            ..AppState::default()
        };
        state.apply_patch(patch);
        assert_eq!(state.version, SCHEMA_VERSION);
    }

    /// `AppState` no longer has a `settings` field at all (issue #64) — user
    /// preferences live in `config.toml` now. A `state.json` written by an
    /// older Atlas build still carries a `settings` object; `serde_json`
    /// silently drops unrecognized keys for structs without
    /// `deny_unknown_fields`, so this must parse cleanly and leave every other
    /// field intact rather than erroring or resetting anything. What happens
    /// to that dropped value is `AppState::load`'s job (it re-parses the raw
    /// JSON separately to recover it for migration) and
    /// `atlas_config::settings_from_legacy_json`'s job (extracting it into
    /// `AppSettings`) — both tested on their own.
    #[test]
    fn a_legacy_settings_key_in_state_json_does_not_break_parsing() {
        let state: AppState = serde_json::from_value(serde_json::json!({
            "settings": { "disabledBuiltinAgents": ["kilo"], "enterToSend": false },
            "recentProjects": [
                { "name": "demo", "path": "/tmp/demo", "lastOpened": "2024-01-01T00:00:00Z" }
            ],
        }))
        .expect("an older state file parses even with the retired settings key present");
        assert_eq!(state.recent_projects.len(), 1);
    }
    #[test]
    fn fresh_profile_and_old_organization_projects_work_locally() {
        let (fresh, _) = AppState::from_raw(None);
        assert_eq!(fresh.version, SCHEMA_VERSION);
        assert!(fresh.workspaces.is_empty());
        let raw = serde_json::json!({
            "version": 4, "organisations": [{"id":"org-old"}], "activeOrganisationId":"org-old",
            "workspaces":[{"id":"p1","name":"Project","path":"/tmp/project","orgId":"org-old","groupId":"g1","pinned":true}],
            "groups":[{"id":"g1","name":"Group","orgId":"org-old"}],
            "activeWorkspaceId":"p1",
            "recentProjects":[{"name":"Project","path":"/tmp/project","lastOpened":"now","orgId":"org-old"}]
        }).to_string();
        let (state, _) = AppState::from_raw(Some(&raw));
        assert_eq!(state.workspaces[0].id, "p1");
        assert_eq!(state.workspaces[0].group_id.as_deref(), Some("g1"));
        assert!(state.workspaces[0].pinned);
        assert_eq!(state.workspaces[0].org_id, None);
        assert_eq!(state.groups[0].org_id, None);
        assert_eq!(state.recent_projects[0].org_id, None);
        assert_eq!(state.active_workspace_id.as_deref(), Some("p1"));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, raw).unwrap();
        let saved = AppState::merged_for_save(&path, &state).unwrap();
        assert!(saved.get("organisations").is_none());
        assert!(saved.get("activeOrganisationId").is_none());
    }
}
