# Contributing to DeskMate

DeskMate (同桌) is the local Agent workbench maintained in [gggab/atlas](https://github.com/gggab/atlas), based on [upstream Atlas](https://github.com/pacifio/atlas). Read [README.md](README.md) first, then the relevant [reference docs](docs/reference/), [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTEXT.md](CONTEXT.md). The current local-workbench scope supersedes historical account, cloud and native-engine guidance.

## Workflow

Use `develop` as the starting and PR target branch for this fork. Inspect the branch and existing changes before working; preserve unrelated edits. Propose the approach, test observable behavior, implement it, then review and run focused checks. For a bug, reproduce and identify the root cause before editing. Requirement changes also update reference/development docs and tests.

Keep external Agent behavior capability-driven through ACP negotiation. Preserve vendor CLI authentication, local configuration, sessions, checkpoints and memory. MCP availability is not proof of retrieval or automatic context injection. Do not hide errors or introduce silent fallbacks.

For [steering](docs/reference/steering.md), verify both the queued-message UI and
the negotiated transport. Run `cargo test --locked -p atlas-agent-servers --test steering`
and `cargo test --locked -p atlas-agent-manager --test steering`; the stdio suite
requires Node.js on PATH or `ATLAS_TEST_NODE`. Mock/browser checks do not establish
real desktop or vendor-task verification.

For local-file browser changes, run `bun run browser:test` and the Chrome/Edge
`browser:extension-smoke` fixtures. In their isolated profiles, verify the native
file-access switch appears, disabled access blocks local navigation and uploads,
enabled access supports local pages and a website file chooser, and revocation
blocks subsequent operations. Keep website approval, pause and tab ownership
checks. Never change a developer's daily browser file-access setting in tests.

For browser handoff changes, run `bun run browser:test` and the Chrome/Edge
`browser:native-smoke` fixtures. Verify takeover releases debugging and the
original session reconnects without chat-phrase authorization, including legacy
ready=false records. Website denial and global pause must still block access;
another session must not inherit handoff pages. Fixtures do not establish real
login/CAPTCHA or vendor-Agent behavior.
Set `ATLAS_BROWSER_SMOKE_OUTPUT` to a separate directory to preserve existing
popup captures when running the native fixtures.

## Setup and commands

Use repository-pinned Bun, Node and Rust versions from `mise.toml`, `package.json` and `rust-toolchain.toml`, plus the Tauri prerequisites listed in the README.

```sh
git clone --branch develop https://github.com/gggab/atlas.git
cd atlas
bun install --frozen-lockfile
bun run dev:app
```

`dev:app` uses the isolated **同桌 DeskMate Dev** data profile. `bun run dev` runs the frontend only; existing `?scenario=` fixtures are browser mocks, not desktop or vendor CLI verification.

Windows debug native messaging uses a versioned copy of the desktop executable
to keep browser reconnections from locking Cargo's output. For changes to host
registration, run the `browser_native::tests::dev_host` regression and verify
`bun run dev:app` rebuilds while the installed extension remains enabled.

```sh
bun run typecheck
bun run lint
bun run test
bun run build
bun run browser:test
cargo check --locked -p atlas --lib
cargo test --locked -p atlas-profile -p atlas-agent-manager -p atlas-checkpoint -p atlas-memory
```

Run checks appropriate to the change. Report Windows/platform failures separately from passing checks. Real vendor login, CLI turns, installed browser extensions and native desktop behavior require their own verification.

## Branding and releases

Use **同桌 DeskMate** for desktop product names, **同桌 DeskMate Dev** for the source-build profile, and **DeskMate Browser** for the companion extension. English UI copy uses DeskMate. Follow [Branding](docs/reference/branding.md) when changing names; keep storage, wire and application identifiers compatible, and preserve upstream/license attribution.

The frontend workspace package is `deskmate`; Cargo crates and the executable retain `atlas`. Update `atlas-profile`, Tauri product/window configs and the frontend profile together. Existing profile/release tests check their agreement.

For Windows packaging, artifact verification and GitHub releases, follow [Releases](docs/reference/releases.md). For browser packaging, follow [Extension publishing](docs/reference/browser-extension-publishing.md); the Edge ZIP omits `manifest.key`, while Chrome keeps its assigned public key. Build, desktop testing, publication and store review are separate steps.

Do not commit, push, publish or deploy unless explicitly requested. Stage only task-related files. Git messages use `<type>: <subject>` or `<type>(<scope>): <subject>`.

## Issues and code conventions

Report bugs in [this fork's issue tracker](https://github.com/gggab/atlas/issues), including the version, OS, selected Agent and reproduction steps when available. For security reports, see [SECURITY.md](.github/SECURITY.md). Upstream issues and community channels are for upstream contributions.

Keep React features under `src/features/<feature>/`, shared widgets under `src/components/`, primitives under `src/ui/`, and native commands in `src-tauri/src/commands/`. Follow the existing Zustand, IPC and style conventions in the architecture documentation. Never commit credentials or tokens. Use English for code comments, development documentation and Git messages; the main README is Chinese.
## Scheduler changes

For task changes, cover real SQLite restart/recovery, revision fences, admitted
human/background competition, archive-preserving restore and notification routing.
Follow the [scheduler verification guide](docs/reference/task-scheduler.md#development-verification).
Browser mocks do not establish vendor-authenticated ACP or native notification
delivery.
