# Contributing to DeskMate

DeskMate (同桌) is the local Agent workbench maintained in [gggab/atlas](https://github.com/gggab/atlas), based on [upstream Atlas](https://github.com/pacifio/atlas). Read [README.md](README.md) first, then the relevant [reference docs](docs/reference/), [ARCHITECTURE.md](ARCHITECTURE.md) and [CONTEXT.md](CONTEXT.md). The current local-workbench scope supersedes historical account, cloud and native-engine guidance.

## Workflow

Use `develop` as the starting and PR target branch for this fork. Inspect the branch and existing changes before working; preserve unrelated edits. Propose the approach, test observable behavior, implement it, then review and run focused checks. For a bug, reproduce and identify the root cause before editing. Requirement changes also update reference/development docs and tests.

Keep external Agent behavior capability-driven through ACP negotiation. Preserve vendor CLI authentication, local configuration, sessions, checkpoints and memory. MCP availability is not proof of retrieval or automatic context injection. Do not hide errors or introduce silent fallbacks.

For the [selected 0.4.1 fixes](docs/reference/upstream-0.4.1-ports.md#selected-post-alpha-fixes),
run the focused regression commands there and frontend typecheck/lint/build.
Keep every chat jump tab-addressed. When changing tool-file extraction, cover
live/replayed summaries, transcript markers and diff sources together. Parser
tests must preserve valid fragmented control sequences as well as malformed
sequence recovery. Simulated DOM checks do not establish native window behavior
or real vendor turns; the reference lists the corresponding desktop checks.

For [steering](docs/reference/steering.md), verify both the queued-message UI and
the negotiated transport. Run `cargo test --locked -p atlas-agent-servers --test steering`
and `cargo test --locked -p atlas-agent-manager --test steering`; the stdio suite
requires Node.js on PATH or `ATLAS_TEST_NODE`. Mock/browser checks do not establish
real desktop or vendor-task verification.

For the [embedded Browser removal](docs/reference/local-workbench.md#embedded-browser-removal),
check retired-tab restoration and the two-column Zen layout with
`bun run test -- src/features/layout/stores/org-tabs.test.ts`. Run the retained
browser-control tests, IPC/event/mock contracts, `bun run browser:test`, frontend
typecheck/lint/build and `cargo check --locked -p atlas --lib`. Browser mocks do
not establish native desktop or installed-extension verification. Preserve
existing browser profile data and saved knowledge notes.

For the Untitled Editor entry removal, run
`bun run test -- src/components/tab-palettes.test.tsx src/features/keybindings src/features/layout src/features/editor`
and frontend typecheck/lint/build. Verify both palettes omit scratch creation,
retired shortcut overrides remain inert, Develop does not create a new draft,
and existing file/legacy-draft editors survive layout changes. File editing and
saving in the native app require separate desktop verification.

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

For app bootstrap changes, run
`bun run test -- src/features/app/lib/use-app-bootstrap.test.tsx src/features/app/stores/app-store.test.ts`.
Cover hydration reset after shell readiness, CLI opening, StrictMode, unmount
and failed-bootstrap write protection. Browser fixtures alone cannot establish
that a running desktop window has recovered its project state.

For [independent background execution](docs/reference/background-service.md), run
the focused UI/native suites and isolated debug-process fixture. Do not enable
login startup or exercise maintenance commands against a developer's real profile
as a test. macOS helper signing/notarization and Windows installed cold activation
need their own OS checks. Stop/remove the current-user backend before updating
or uninstalling an enabled installation; automatic installer cleanup is pending.

## Branding and releases

Use **同桌 DeskMate** for desktop product names, **同桌 DeskMate Dev** for the source-build profile, and **DeskMate Browser** for the companion extension. English UI copy uses DeskMate. Follow [Branding](docs/reference/branding.md) when changing names; keep storage, wire and application identifiers compatible, and preserve upstream/license attribution.

The frontend workspace package is `deskmate`; Cargo crates and the executable retain `atlas`. Update `atlas-profile`, Tauri product/window configs and the frontend profile together. Existing profile/release tests check their agreement.

For Windows packaging, artifact verification and GitHub releases, follow [Releases](docs/reference/releases.md). For browser packaging, follow [Extension publishing](docs/reference/browser-extension-publishing.md); the Edge ZIP omits `manifest.key`, while Chrome keeps its assigned public key. Build, desktop testing, publication and store review are separate steps.

Do not commit, push, publish or deploy unless explicitly requested. Stage only task-related files. Git messages use `<type>: <subject>` or `<type>(<scope>): <subject>`.

## Issues and code conventions

Report bugs in [this fork's issue tracker](https://github.com/gggab/atlas/issues), including the version, OS, selected Agent and reproduction steps when available. For security reports, see [SECURITY.md](.github/SECURITY.md). Upstream issues and community channels are for upstream contributions.

Keep React features under `src/features/<feature>/`, shared widgets under `src/components/`, primitives under `src/ui/`, and native commands in `src-tauri/src/commands/`. Follow the existing Zustand, IPC and style conventions in the architecture documentation. Never commit credentials or tokens. Use English for code comments, development documentation and Git messages; the main README is Chinese.
## Scheduler changes

Personal assistant changes must cover the fixed projectless/global window, history
without a vendor connection, draft retention on reconnect failure, unchanged human text versus application context, real human
source validation, profile separation, optimistic memory revisions and deletion.
Use temporary SQLite files for inert proposals, freeze/retry/version conflicts
and independent memory/task receipts. Personal cross-session ownership applies
only to fixed reminders, preserves source IDs and must never grant project or
Agent-check access. Test MCP offer negotiation and omission of project/browser/
SSH services. Do not create test facts or reminders in a user's profile.
See [personal assistant](docs/reference/personal-assistant.md). Vendor-authenticated
chat/tool calls and native notification receipt require separate desktop checks.
Automatic-memory changes also require literal-source evidence, post-turn trusted
candidate confirmation, unresolved-question rejection, per-key rename/delete/relearn
barriers (including concurrent connections), honest stale-create deferral, and
bounded deterministic recall with explicit omissions. Keep old JSON/data compatible.
Use the fictional semantic fixtures for real-CLI decision checks; these are separate
from actual MCP transport and persistence verification.
Keep the personal assistant on the shared Agents chat components and verify fixed
header behavior, vendor switches, queue/permission gates and real task receipts.
Cover permission/model application before binding, structured first-send holds,
failure draft retention, queue order during running turns and error holds across
remounts. A mock composer must respect the same session-readiness gate as ChatPanel.
MCP discovery tests must include the cache metadata required by current clients;
a connected transport with an empty tool list is a failure. With an installed SDK,
set `ATLAS_CLAUDE_SDK_DIR` and run the ignored
`claude_discovers_personal_and_task_tools` test. It performs no model turn.
Use `?scenario=personal-assistant` for the separate fictional browser UI check.
The separately ignored `claude_registers_a_default_weekly_reminder_in_temporary_sqlite`
check makes a real vendor model turn against an isolated MCP fixture and temporary
SQLite, including expired weekly and one-off defaults with explicit notices.
Run it explicitly with the installed SDK; never point it at user-profile
databases. The fixture uses production schemas/calendar/store, while production
session authorization and native delivery still need their own checks.

Minute-interval reminder changes must cover temporary SQLite restart, skipped
ticks, pause/resume/stop, superseding older unsent notifications, and rejecting
invalid intervals or mixed calendar/Agent rules. Verify form creation and editing;
never register test reminders in a user's profile.

For task changes, cover real SQLite restart/recovery, revision fences, admitted
human/background competition, archive-preserving restore and notification routing.
Re-enable/delete checks additionally cover terminal edit/pause bypass rejection,
cumulative Agent budgets, late reservations/results/notifications, atomic FK
cleanup, v1/v2 migration and hashed deletion barriers across restart. Use temporary
profiles only; deletion is not secure erasure and does not affect chat/memory.
Follow the [scheduler verification guide](docs/reference/task-scheduler.md#development-verification).
Browser mocks do not establish vendor-authenticated ACP or native notification
delivery.

Calendar changes must also cover the pure expansion engine, additive v1 migration,
fixed-cutoff catch-up, frozen-period edits and per-period revision/delivery races.
See [calendar schedules](docs/reference/calendar-schedules.md). Test against real
temporary SQLite files; never create test reminders in a user's data profile.

## Source Control removal checks

Keep the retired Source Control entry points out of the sidebar, command palette,
layout templates and right-panel renderer. Preserve shared read-only Git consumers
(explorer/editor/chat diffs, project summaries and checkpoints), and do not reactivate
background fetch. Saved Source Control layouts must close the slot without changing
central tabs or widths; saved SSH layouts must still reopen. The standalone Git
Diff tab is also removed: keep it out of both tab menus and the tab registry.
Existing `diff` tabs must be dropped on restore while chat diff file selection
stays inside its modal.

```sh
bun run test -- src/features/layout/stores/org-tabs.test.ts src/features/ssh/components/ssh-host.test.ts src/features/notifications/lib/prefs.test.ts tests/ipc-contract.test.ts
bun run typecheck
bun run lint
bun run build
```

These checks do not establish native desktop/CLI behavior. Verify SSH panel reopening
and chat diffs in DeskMate Dev separately when a desktop runtime is available.
