# Atlas改

**Atlas改** is a local Agent workbench maintained in [gggab/atlas](https://github.com/gggab/atlas), based on [upstream Atlas](https://github.com/pacifio/atlas). Built with Tauri 2, React 19 and Rust, it lets you open local projects and run several external ACP CLI Agent sessions in the same window. Each CLI owns its vendor subscription, login and model availability. No Atlas account, official model gateway or built-in execution engine is required.

`develop` is this fork's primary development and default branch. Start new work from `develop` and target it when opening pull requests in this repository. Upstream's version-branch workflow applies only when contributing to `pacifio/atlas`.

## Getting started

```sh
git clone --branch develop https://github.com/gggab/atlas.git
cd atlas
bun install --frozen-lockfile
bun run dev:app
```

Install the [platform prerequisites](#development) first. The source build appears as **Atlas改 Dev** and uses its separate development data profile. Install an external Agent in the app, or accept a detected CLI, then complete that CLI's vendor authentication before starting a chat.

The display-name change preserves existing application identifiers, `.atlas/` and `.atlas-dev/` directories, configuration, sessions, checkpoints and memory. Internal package names and CLI commands remain `atlas`. This build shares the corresponding data profile with earlier Atlas builds; use `dev:app` for isolated source development.

## Retained features

- Agent installation, PATH detection, process launch, vendor authentication and ACP capability / model negotiation.
- Streaming chat, approvals, cancellation, independent parallel sessions, local transcripts and capability-dependent resume / load.
- Project files, terminal PTYs, Git, local session capture and checkpoint history.
- Managed SSH connections, project associations and remote execution history, with credentials kept in OS credential storage. See [SSH](docs/reference/ssh.md).
- Shared local memory: SQLite storage, events, retrieval, import, policy controls, management UI and a session-authorized loopback MCP service.
- Browser Use: an opt-in Chrome/Edge extension managed from Settings > Browser control, with automatic native connection, persistent pause, grouped task tabs, a JavaScript REPL and session-authorized MCP tools. Completed task pages close except necessary handoffs; daily tabs and login remain. See [Browser Use](docs/reference/browser-use.md) and [extension publishing](docs/reference/browser-extension-publishing.md).

The [Atlas Browser privacy policy](PRIVACY.md) describes browser-task data handling, external Agent/model providers, retention, and user controls.

The companion extension keeps the store name **Atlas Browser** and its existing Chrome/Edge IDs. Install it through **Settings > Browser control**; the extension connects to the app through native messaging. Store availability depends on approval, and local builds can load the prepared extension folder. The desktop app must be running to use browser tasks.

No agent is runnable on a fresh profile until installed. Detected CLIs are installation offers. A missing agent selection stays empty. Historical Atlas Agent records remain readable, but cannot launch the removed native engine.

## Memory and data

The thread catalog (`threads.db`), per-project recording (`.atlas/sessions.db` and blobs) and shared memory (`.atlas/memory/memory.sqlite`) have separate owners. Worktrees resolve shared memory to their main project. Agents offered HTTP MCP use session tokens to access that same memory service; those tokens are local access controls, not Atlas account tokens. An agent must advertise HTTP MCP support and memory sharing must be enabled.

Gateway-dependent automatic memory extraction is removed. Agents can still write memory explicitly through MCP. Existing optional BYOK research, session analysis and memory chat remain; they are not needed for CLI chat or ordinary memory storage and retrieval. Local embedding model downloads remain explicit network operations.

## Development

Use `develop` for ongoing work in this fork:

```sh
git switch develop
git pull --ff-only
```

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

For Windows MSI packaging and GitHub publication, see the [release guide](docs/reference/releases.md). The **Build Windows Release** workflow produces a verified x64 MSI, checksums and source-commit metadata; publication and desktop testing remain separate steps.

## Removed scope

Atlas accounts / identity / organization permissions, cloud organization and member management, team chat and cloud Spaces, cloud recording synchronization, official model gateway, native Atlas Agent and its vendored engine, telemetry / analysis uploads / feedback uploads, and the PostHog-configured official updater are removed. Projects and recording bindings migrate to local ownership without deleting session rows, checkpoints or shared memory. Existing legacy schema columns are retained for data compatibility and have no remote uploader.

## Other features retained for review

Research papers, embedded browser, local canvas / notebook, knowledge graph, design/media extensions and optional BYOK analysis are still present. Removing these later can reduce bundle size and network surface but would remove their local documents, preview / mention integrations or analysis entry points. See `docs/reference/local-workbench.md` for scope and verification notes. This change introduces no quota fallback, model panel review or additional memory injection.

See [ARCHITECTURE.md](ARCHITECTURE.md), [CONTEXT.md](CONTEXT.md) and [CONTRIBUTING.md](CONTRIBUTING.md). Existing historical ADRs describe previous versions; the local workbench scope supersedes their account, cloud and native-engine decisions.
