# Atlas local Agent workbench

Atlas is a Tauri 2 / React 19 desktop workbench for external ACP CLI agents. Open local projects and run several agent sessions in the same window. Atlas requires no Atlas account and provides no model gateway or built-in execution engine. Each CLI owns its vendor subscription, login and model availability.

## Retained features

- Agent installation, PATH detection, process launch, vendor authentication and ACP capability / model negotiation.
- Streaming chat, approvals, cancellation, independent parallel sessions, local transcripts and capability-dependent resume / load.
- Project files, terminal PTYs, Git, local session capture and checkpoint history.
- Shared local memory: SQLite storage, events, retrieval, import, policy controls, management UI and a session-authorized loopback MCP service.
- Browser Use: an opt-in Chrome/Edge extension managed from Settings > Browser control, with automatic native connection, persistent pause, grouped task tabs, a JavaScript REPL and session-authorized MCP tools. Completed task pages close except necessary handoffs; daily tabs and login remain. See [Browser Use](docs/reference/browser-use.md) and [extension publishing](docs/reference/browser-extension-publishing.md).

No agent is runnable on a fresh profile until installed. Detected CLIs are installation offers. A missing agent selection stays empty. Historical Atlas Agent records remain readable, but cannot launch the removed native engine.

## Memory and data

The thread catalog (`threads.db`), per-project recording (`.atlas/sessions.db` and blobs) and shared memory (`.atlas/memory/memory.sqlite`) have separate owners. Worktrees resolve shared memory to their main project. Agents offered HTTP MCP use session tokens to access that same memory service; those tokens are local access controls, not Atlas account tokens. An agent must advertise HTTP MCP support and memory sharing must be enabled.

Gateway-dependent automatic memory extraction is removed. Agents can still write memory explicitly through MCP. Existing optional BYOK research, session analysis and memory chat remain; they are not needed for CLI chat or ordinary memory storage and retrieval. Local embedding model downloads remain explicit network operations.

## Development

Use the versions pinned in `mise.toml`, `package.json` and `rust-toolchain.toml` (Bun 1.4.0 and Rust 1.99.0). Install platform prerequisites for Tauri: MSVC C++ build tools / WebView2 on Windows, Xcode on macOS, or GTK / WebKit development packages on Linux.

```sh
bun install --frozen-lockfile
bun run dev           # frontend; use an existing ?scenario= mock for browser UI work
bun run dev:app       # actual desktop backend and external CLIs
bun run typecheck
bun run test
bun run build
cargo check --locked -p atlas --lib
cargo test --locked -p atlas-agent-manager -p atlas-checkpoint -p atlas-memory
cargo test --locked -p atlas --lib
```

Real vendor authentication and end-to-end paid CLI turns require the user's vendor account. ACP support for model selection and session restoration varies by CLI and is negotiated rather than assumed.

## Removed scope

Atlas accounts / identity / organization permissions, cloud organization and member management, team chat and cloud Spaces, cloud recording synchronization, official model gateway, native Atlas Agent and its vendored engine, telemetry / analysis uploads / feedback uploads, and the PostHog-configured official updater are removed. Projects and recording bindings migrate to local ownership without deleting session rows, checkpoints or shared memory. Existing legacy schema columns are retained for data compatibility and have no remote uploader.

## Other features retained for review

Research papers, embedded browser, local canvas / notebook, knowledge graph, design/media extensions and optional BYOK analysis are still present. Removing these later can reduce bundle size and network surface but would remove their local documents, preview / mention integrations or analysis entry points. See `docs/reference/local-workbench.md` for scope and verification notes. This change introduces no quota fallback, model panel review or additional memory injection.

See [ARCHITECTURE.md](ARCHITECTURE.md), [CONTEXT.md](CONTEXT.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Existing historical ADRs describe previous versions; the local workbench scope supersedes their account, cloud and native-engine decisions.
