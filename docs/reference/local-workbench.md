# Local workbench scope

This build hosts installed external ACP CLIs using their vendor login. It has no Atlas account or official model gateway.

## Dependency boundary

- External CLI: `atlas-agent-store` → `atlas-agent-servers` → `atlas-agent-manager` → `AgentHost` / delta projector. Capability gates control authentication, models and session restoration. Tabs do not own process lifetime, so several sessions can run concurrently.
- History: global `atlas-thread-metadata` metadata, Atlas transcripts, and per-project `atlas-checkpoint` recording / Git checkpoints remain separate from memory.
- Memory: `atlas-memory` record and index, `SharedMemoryStore`, scope resolver, indexer and loopback MCP remain. The main worktree is the scope for all worktrees. Session tokens prevent unbound callers from reading or writing it.
- The gateway extraction orchestrator, jobs and UI entry points are removed. MCP active writes and local event capture remain. No replacement account, paid API or execution engine was introduced.
- Retained historical sync columns and native source tags support existing records only; no cloud client or native launcher remains.

## Other features: recommendations, not removals

| Feature | Potential later pruning | Impact |
|---|---|---|
| Research / papers | Search providers, imports, optional BYOK synthesis | Removes research search, PDF / mention / note integrations; retain local PDFs separately if approved. |
| Embedded browser | Webview, reader and cookie-backed browsing | Removes in-app browsing and related page actions; vendor CLI browser login must still work. |
| Local canvas / notebook | Editors, media nodes, graph layout and assets | Removes local document views; stored documents need an export plan first. Cloud team Spaces are already removed. |
| Design / media extensions | SVG, image, PDF annotations and design integrations | Smaller UI and asset bundle, but removes previews / editing / export features. |
| BYOK analysis / memory chat | Existing configured-provider model chat | Removes optional analysis; ordinary ACP chat and local memory do not require it. |
| Knowledge / skills | Notes, graph, export server and skill marketplace | Removes document and CLI skill integrations; file / memory corpus dependencies need a separate audit. |

## Verification

Run frontend typechecks, Vitest contracts / chat / permissions / memory tests and production build; Rust app check plus manager, checkpoint and memory suites. Desktop tests in `memory_server/tests.rs` use the real loopback listener to check tokens and cross-agent access (`claude` writes alongside `codex`). Migration tests reopen old capture bindings and preserve data.

A browser mock validates UI and IPC wiring only. Real vendor subscription login, CLI streaming, approval, model selection and resume require installed CLIs and the user's vendor accounts. This build does not add automatic quota fallback, multi-model review or new memory injection.

## Compatibility retained deliberately

Old native source labels, sync-state columns and organization attribution in stored records remain readable; they cannot launch an agent or send records to a server. Old organization projects and groups migrate into the local project registry, and old cloud capture bindings become local while session rows, checkpoint links and content-addressed blobs stay in place. Pinned logs merge into the local log once without deleting originals.

The local Usage view reads captured token totals and session records. It uploads no product analytics. Vendor registry/install downloads, explicit embedding downloads and the retained research/browser/BYOK features can still use their own network services. Theme schema URLs and upstream project links are metadata, not cloud account/service clients.

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
| Browser mock | No Atlas login gate or cloud organization/team UI; external picker and chat stream, Memory Graph and Shared management loaded |
| IPC / event / configuration / workspace contracts, script syntax, diff whitespace | Passed |

The AgentServers exclusions are `a_dying_agent_reports_what_it_said_on_stderr`, `an_agent_that_exits_immediately_reports_its_exit_status`, `an_agent_that_never_answers_initialize_times_out_at_the_deadline`, `the_pump_stops_when_the_thread_is_gone` and `the_pump_turns_a_running_command_into_thread_events`: their fixtures invoke `/bin/sh`. AgentStore's `a_custom_command_path_expands_a_leading_tilde` expects Unix `HOME`; the unchanged product implementation correctly resolved the Windows home instead.

The desktop exclusions are `save_guard::ordinary_save_targets_pass`, `atlas_config::an_absolute_xdg_config_home_wins`, and these `skills` tests: `adopt_external_skill_makes_it_managed_for_all_agents`, `canonical_base_is_under_dot_agents`, `external_scan_follows_symlinked_skill_dirs`, `freeze_converts_symlink_projection_to_real_copy`, `pack_project_claude_links_agent_and_skill_and_records_ledger`, `pack_project_hook_exports_root_for_runtime_env_bootstrap`, `pack_project_hook_rewrites_plugin_root_to_store_dir`, `pack_project_skips_foreign_dir_conflict_unless_forced`, `project_refuses_pack_owned_target_without_force`, `project_symlinks_records_ledger_then_unproject_clears`, `skill_path_errors_when_missing` and `symlink_target_resolves_to_canonical`. These remain in the source and are not claimed as passing.

For the installed MSVC 2019 toolchain, local validation used `NK_TARGET_HASWELL=0` and `NK_TARGET_SKYLAKE=0` to compile numkong without unsupported SIMD intrinsics. No product dependency or implementation was substituted. The desktop test executable lacked Common Controls v6 activation and failed to load `TaskDialogIndirect`; a temporary copy under the validation directory was given that manifest with the Windows SDK `mt.exe`. The app source was not changed to hide this test-runner limitation.

Python-backed subprocess tests originally returned early because the fixtures look for an extensionless `python3`. Validation supplied a temporary Python entry point and its real standard library, then reran them. The two test-only process liveness helpers use Windows `tasklist` on Windows and retain `kill -0` elsewhere; successful spawn, permission streaming, model selection, cancellation and process teardown were then observed.

Not verified: real vendor subscription login / billed turns / vendor session restore, a native desktop GUI launch or installer, the ignored model-dependent/benchmark cases, the excluded platform cases, or runtime packet capture of a packaged app. No Atlas account/service/upload endpoint or corresponding command registration remains in production source. This source/contract audit is separate from network capture. No commit, push, publishing or deployment was performed.
