# Local workbench scope

This build hosts installed external ACP CLIs using their vendor login. It has no DeskMate account or official model gateway.

Running tasks can accept [steering](steering.md) from queued message cards only
when the connected CLI explicitly advertises the ACP steering extension.

## Dependency boundary

- External CLI: `atlas-agent-store` → `atlas-agent-servers` → `atlas-agent-manager` → `AgentHost` / delta projector. Capability gates control authentication, models and session restoration. Tabs do not own process lifetime, so several sessions can run concurrently.
- History: global `atlas-thread-metadata` metadata, DeskMate transcripts, and per-project `atlas-checkpoint` recording / Git checkpoints remain separate from memory.
- Memory: `atlas-memory` record and index, `SharedMemoryStore`, scope resolver, indexer and loopback MCP remain. The main worktree is the scope for all worktrees. Session tokens prevent unbound callers from reading or writing it.
- Browser Use: HTTP-MCP-capable sessions receive a [local browser tool server](browser-use.md), independent of memory sharing. Once authorized, DeskMate Browser connects automatically and creates grouped task tabs. Completion closes Agent-created pages except necessary handoffs, removes groups, and preserves existing tabs/login.
- The gateway extraction orchestrator, jobs and UI entry points are removed. MCP active writes and local event capture remain. No replacement account, paid API or execution engine was introduced.
- Retained historical sync columns and native source tags support existing records only; no cloud client or native launcher remains.

## Source Control removal

The Source Control module, including Changes, commit history/graph, stashes,
branch/remote management and its GitHub sidebar, has been removed. Sidebar and
command-palette entries, the Review layout, Git-specific shortcut presets,
auto-fetch activation/settings and panel-specific notifications are removed too.
Use an external Git client or the terminal for repository writes.

The right panel now hosts Remote execution only and starts hidden. Existing
Source Control layouts close that slot on restore, preserving its width and
central tabs; saved Remote execution layouts retain their visibility.

The standalone **Git Diff** module is removed from the new-tab palette, split
menus and tab registry. Saved `diff` tabs are dropped during app/project layout
restoration while other tabs remain. File selection in the chat diff modal stays
inside that modal and cannot create a standalone tab. The standalone commit picker
and its unused history IPC/store loader are removed.

Shared Git plumbing remains for explorer decorations, editor blame, chat diffs,
project summaries, recorded branch metadata and checkpoints. GitHub search
and cloning from chat remain available. Legacy notification history and config
keys stay readable; old Git notification targets explain that the panel was removed.
Panel-only Git IPC commands, their mocks and the automatic fetch scheduler are
removed. Shared read-only commands remain; status snapshots no longer load branch
lists, stashes or in-progress operations. No repository, credential, transcript,
checkpoint or memory data is deleted.

## Embedded Browser removal

The built-in Browser tab, new-tab and command/context-menu entries, native
WebView commands and reader fetcher are removed. Saved `browser` tabs are dropped
when restoring app preferences and project editor state; other tabs remain.
The Research layout preset is removed. Zen mode now opens Knowledge and Chat in
two columns and restores the prior layout when toggled off.

Browser automation continues through the Chrome/Edge companion extension and
`atlas_browser` MCP. Browser control settings, website permissions, pause,
takeover, CLI vendor authentication and external links remain available.
Existing `browser-profile` data and saved knowledge notes are left on disk;
removing the module does not clear user data.

## Untitled Editor entry removal

The Untitled Editor module entry, command-palette action and `tabs.newUntitled`
shortcut are removed. The Develop layout reuses an open editor; without one,
it leaves the file column empty until the user opens a file. It does not create
an untitled buffer. Existing editor tabs and legacy untitled drafts remain
available, including their save-as flow. File-tree navigation, file editing and
saving remain unchanged. Stored keybinding overrides are preserved but no longer
resolve to the removed action.

## Other features: recommendations, not removals

The [task scheduler](task-scheduler.md) adds profile-local durable reminders and
bounded checks using installed ACP CLIs. Agent task tools are separately opt-in;
shared-memory availability does not authorize tasks. Conversation archive does not
pause tasks. No daemon, model gateway or mobile notification service is added.

| Feature | Potential later pruning | Impact |
|---|---|---|
| Research / papers | Search providers, imports, optional BYOK synthesis | Removes research search, PDF / mention / note integrations; retain local PDFs separately if approved. |
| Local canvas / notebook | Editors, media nodes, graph layout and assets | Removes local document views; stored documents need an export plan first. Cloud team Spaces are already removed. |
| Design / media extensions | SVG, image, PDF annotations and design integrations | Smaller UI and asset bundle, but removes previews / editing / export features. |
| BYOK analysis / memory chat | Existing configured-provider model chat | Removes optional analysis; ordinary ACP chat and local memory do not require it. |
| Knowledge / skills | Notes, graph, export server and skill marketplace | Removes document and CLI skill integrations; file / memory corpus dependencies need a separate audit. |

## Verification

Run frontend typechecks, Vitest contracts / chat / permissions / memory tests and production build; Rust app check plus manager, checkpoint and memory suites. Desktop tests in `memory_server/tests.rs` use the real loopback listener to check tokens and cross-agent access (`claude` writes alongside `codex`). Migration tests reopen old capture bindings and preserve data.

A browser mock validates UI and IPC wiring only. Real vendor subscription login, CLI streaming, approval, model selection and resume require installed CLIs and the user's vendor accounts. This build does not add automatic quota fallback, multi-model review or new memory injection.

### Windows Antigravity startup

The Antigravity 1.3.0 standalone server unpacks its bundled runtime before it can answer ACP initialization. A local probe took 63.56 seconds and then returned `Log in with Google`; the ordinary 60-second deadline interrupted it before authentication. Windows `antigravity-acp` initialization now has a bounded 120-second deadline. Other agents retain 60 seconds. An initialization timeout occurs before vendor login and does not establish an account or subscription failure.

### Chat scroll restoration

The Agent transcript retains its last valid scroll position while the window is
hidden or its viewport collapses. On visibility or native window wake, it restores
the position before sampling: a reader following the live edge returns to the
latest messages, including background arrivals; a reader browsing history keeps
their saved offset. Hidden geometry cannot change the follow state or trigger
history growth. These checks use simulated DOM geometry; native minimize/restore
verification remains a separate desktop check.

## Selected upstream fixes

The model picker selectively ports `6e910c7e`: search, favorites, provider
groups and keyboard controls. Rust snapshots and live ACP config updates keep
the Agent's stated group names; no provider is guessed from a model id.
Favorites use local `config.toml` preferences. See [Model picker](model-picker.md).
The same upstream commit also supplies the [basic history cards](history-cards.md):
title, live status, current-turn timing, Agent marks, project-name placement and
explicit history read errors. Existing session restoration and archive/delete
paths are retained. Timing is temporary frontend state. The approved branch
metadata port records the last observed Git branch and upgrades the history
catalog to named migrations at epoch 5, with verified pre-migration SQLite
snapshots. Completed V3 data cleanup is not replayed. See [History migrations](history-migrations.md)
for compatibility and rollback. PR lookup, a native agent and gateway model
refresh remain outside these selective ports.

The approved ports of `a335ec9c` and `bb8eb6ac` add
[terminal session discovery](session-discovery.md) and [local code search](code-search.md).
History discovery reads file metadata only; ACP still owns replay and capability
negotiation. The code service joins the existing session token and preserves
SSH / Browser Use permissions. New history tables are additive named migrations
at epoch 5. Code embeddings are downloaded explicitly and remain separate from
memory embeddings. No native engine, account, organization or gateway is restored.

Compatible low-priority upstream changes include US-English visible copy and
generic browser-mock recording / scenario hooks. The upstream company's landing
page address, cloud-organization Northwind demo and native-only plugin setting
do not match this fork. The architecture document stays at the root, preserving
the project's documented entry point.

The fork selectively carries these upstream fixes without restoring account,
organization or native-agent functionality:

- `b4729890`: Windows builds use usearch's distance kernels without NumKong;
  other targets retain NumKong. The Rust API and persisted memory remain intact.
- `f3d76e5e`: capture titles skip agent wrapper markup; Timeline also cleans
  previously stored titles when rendering, without rewriting the records.
- `9cea73fd` and `30a13b36`: flat PDF highlighter strokes snap to text in their
  own column. Annotations remain in the project's PDF annotation sidecar, not
  embedded into the PDF.
- `957d8027`: checkpoint and redaction documentation clarifies their rules.
- Selected parts of `3721dce4`: Open Folder shows its live shortcut, the command
  palette no longer offers the unimplemented Task Board, and About reads the
  bundled app version with explicit loading and unavailable states. Stored task
  tabs and the 同桌 DeskMate / 同桌 DeskMate Dev branding remain compatible.

Focused development checks:

```sh
bun run test -- src/features/artifacts/lib/board.test.ts src/features/pdf/lib/highlight-rect.test.ts src/features/app/components/welcome-screen.test.tsx src/features/settings/components/settings-panel.test.tsx
cargo test --locked -p atlas-checkpoint -p atlas-memory --lib
cargo check --locked -p atlas --lib
```

## Compatibility retained deliberately

Old native source labels, sync-state columns and organization attribution in stored records remain readable; they cannot launch an agent or send records to a server. Old organization projects and groups migrate into the local project registry, and old cloud capture bindings become local while session rows, checkpoint links and content-addressed blobs stay in place. Pinned logs merge into the local log once without deleting originals.

The local Usage view reads captured token totals and session records. It uploads no product analytics. Vendor registry/install downloads, explicit embedding downloads and the retained research/extension-browser/BYOK features can still use their own network services. Theme schema URLs and upstream project links are metadata, not cloud account/service clients.

The existing optional BYOK handoff summary remains available through MCP. Raw handoff is the default. The removed gateway extractor has no replacement, and the unimplemented Local selector and gateway-specific image request warning were removed.

## Validation result (2026-10-05, Windows)

| Check | Result |
|---|---|
| App and test TypeScript checks, oxlint, production Vite build | Passed |
| Vitest | 168 files, 1,703 passed, 1 existing skip; excluded the six POSIX `target-gc` cases on Windows |
| AgentManager + checkpoint | 414 passed, including binding migration, capture, imports, linkage and rewrite recovery |
| Actual ACP subprocess handshake / shutdown | 5 passed with a real Python stdio child; HTTP MCP capability negotiation, connecting-process cancellation and shutdown exercised |
| Memory + AgentServers + AgentStore + Process + thread metadata | 333 passed, 6 existing ignores, 6 platform cases excluded (listed below) |
| Desktop library compile / check | Passed |
| Desktop unit tests | 461 passed, 5 existing ignores; 14 Windows path/symlink cases excluded after an unfiltered run exposed them |
| Browser mock | No DeskMate login gate or cloud organization/team UI; external picker and chat stream, Memory Graph and Shared management loaded |
| IPC / event / configuration / workspace contracts, script syntax, diff whitespace | Passed |

The AgentServers exclusions are `a_dying_agent_reports_what_it_said_on_stderr`, `an_agent_that_exits_immediately_reports_its_exit_status`, `an_agent_that_never_answers_initialize_times_out_at_the_deadline`, `the_pump_stops_when_the_thread_is_gone` and `the_pump_turns_a_running_command_into_thread_events`: their fixtures invoke `/bin/sh`. AgentStore's `a_custom_command_path_expands_a_leading_tilde` expects Unix `HOME`; the unchanged product implementation correctly resolved the Windows home instead.

The desktop exclusions are `save_guard::ordinary_save_targets_pass`, `atlas_config::an_absolute_xdg_config_home_wins`, and these `skills` tests: `adopt_external_skill_makes_it_managed_for_all_agents`, `canonical_base_is_under_dot_agents`, `external_scan_follows_symlinked_skill_dirs`, `freeze_converts_symlink_projection_to_real_copy`, `pack_project_claude_links_agent_and_skill_and_records_ledger`, `pack_project_hook_exports_root_for_runtime_env_bootstrap`, `pack_project_hook_rewrites_plugin_root_to_store_dir`, `pack_project_skips_foreign_dir_conflict_unless_forced`, `project_refuses_pack_owned_target_without_force`, `project_symlinks_records_ledger_then_unproject_clears`, `skill_path_errors_when_missing` and `symlink_target_resolves_to_canonical`. These remain in the source and are not claimed as passing.

For the installed MSVC 2019 toolchain, local validation used `NK_TARGET_HASWELL=0` and `NK_TARGET_SKYLAKE=0` to compile numkong without unsupported SIMD intrinsics. No product dependency or implementation was substituted. The desktop test executable lacked Common Controls v6 activation and failed to load `TaskDialogIndirect`; a temporary copy under the validation directory was given that manifest with the Windows SDK `mt.exe`. The app source was not changed to hide this test-runner limitation.

Python-backed subprocess tests originally returned early because the fixtures look for an extensionless `python3`. Validation supplied a temporary Python entry point and its real standard library, then reran them. The two test-only process liveness helpers use Windows `tasklist` on Windows and retain `kill -0` elsewhere; successful spawn, permission streaming, model selection, cancellation and process teardown were then observed.

Not verified: real vendor subscription login / billed turns / vendor session restore, a native desktop GUI launch or installer, the ignored model-dependent/benchmark cases, the excluded platform cases, or runtime packet capture of a packaged app. No DeskMate account/service/upload endpoint or corresponding command registration remains in production source. This source/contract audit is separate from network capture. No commit, push, publishing or deployment was performed.
