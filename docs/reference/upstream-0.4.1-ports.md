# Selective alpha-0.4.1 ports

Source: upstream `alpha-0.4.1` (`7476d112`). These ports retain the local external
CLI scope. They do not merge the upstream branch or restore removed modules.

## Behavior

- ACP npm and managed-Node installations run independently of a connect caller;
  callers join a running job. A failed upgrade preserves a runnable copy and
  reports its stale state explicitly. Setup RPCs and UI waits are bounded; only
  changing progress re-arms a bind deadline. Exited connections are evicted,
  open chats are disconnected, and a successful reload replaces replayed history
  and delegated-work snapshots instead of appending duplicates.
- Closing the last project resets global panel data while preserving cached
  snapshots and actions. Vendor login state and stored user data are unchanged.
- Shared-memory changes page without skipping capped results or timestamp ties.
  Entries and deletion tombstones are read in one SQLite snapshot. Clearing the
  shared record requires confirmation. Policy edits resolve real paths and only
  admit Markdown memory/instruction files, excluding credentials and config.
- Notification channels fail independently. Data actions work across toast,
  notification center and OS-banner routing; failed Agent updates offer Retry.
  Task IDs/outbox delivery, permission replies and retired Git targets retain
  their local contracts. Hiding a login terminal hides its dock without ending
  its login; a closed terminal still offers a way to finish/cancel the flow.
- Subagent rows, details and the thread overview derive from actual ACP tool
  calls, input and metadata. No Agent identity selects capabilities. Synchronous,
  asynchronous and separately reported children can have different amounts of
  observable work. Unknown payloads remain ordinary tool calls. This observes
  delegation and does not create a local multi-agent execution engine. The
  overview shows delegated work and file changes; shared memory retains its
  existing panel, without importing the upstream M4 review/health system.
- All local MCP services reach external ACP Agents through the credential-free
  stdio bridge described in [ADR-0020](../adr/0020-local-mcp-credentials-stay-out-of-adapter-config.md).
- Windows library-test executables receive Common Controls v6 through the linker;
  the background build fingerprint remains. Shell-script checks find Git Bash
  and its coreutils. Usage chart dates and editor blame are more legible.

## Development checks

Use the repository-pinned Bun and Rust versions. `ATLAS_TEST_PYTHON` may name an
existing Python interpreter for scripted ACP subprocess tests, especially on
Windows where the `python3` application alias is not an interpreter. Missing or
invalid overrides fail explicitly. The upstream npm fault harness uses Unix
shell fixtures and does not validate Windows npm installation.

```sh
bun run typecheck
bun run lint
bun run test
bun run build
cargo check --locked -p atlas --lib
cargo test --locked -p atlas-acp-thread -p atlas-agent-wire -p atlas-agent-delta --lib
cargo test --locked -p atlas-agent-manager -p atlas-agent-servers -p atlas-agent-store -p atlas-memory --lib
cargo test --locked -p atlas-agent-delta --test live_subagents
cargo test --locked -p atlas-agent-manager --test handshake --test session_mcp
cargo test --locked -p atlas --lib memory_
cargo test --locked -p atlas --lib agent_host::tests
cargo test --locked -p atlas --lib ssh::tests
```

The `chat-subagents` browser scenario includes both streaming and completed delegated
work. Inspect row-to-detail navigation, the overview toggle, narrow layouts and
cancel/reload behavior. This mock does not establish vendor authentication or
current adapter behavior. Live subagent tests remain explicitly ignored because
they can invoke installed, authenticated vendor CLIs.

### Windows verification snapshot (2026-10-20)

- App/test type checking, lint, production frontend build, Rust library check
  and desktop binary build passed.
- Frontend product tests: 215 files, 2,068 passed, one skipped. Two unchanged
  repository-maintenance test files were excluded after their full-run failures:
  `ci-affected.test.ts` and `no-legacy-names.test.ts`.
- Application Rust tests: 631 passed, eight ignored, 15 filtered failures in
  unchanged command-registration, save-path, skill-symlink and XDG-path tests.
  Seven supporting library suites passed 171 tests, with four model tests ignored.
- Real Python ACP subprocess tests passed: six handshake, seven session-MCP,
  and 18 connection tests (three existing POSIX command fixtures filtered).
  Subagent projection/replay checks passed with three existing POSIX terminal
  fixtures filtered; live vendor tests remain ignored.
- A Windows GUI-subsystem executable passed stdin/stdout bridge forwarding,
  JSON-RPC error forwarding, private token-file loading and proxy isolation.
  Browser mock checks covered delegated rows, overview/detail navigation and
  a narrower viewport, without page errors.

The unfiltered suites are not fully green. These checks do not establish a
release installer, Windows npm fault recovery, real vendor authentication or
billed vendor turns. Existing POSIX terminal fixtures also fail in the Windows
ACP-thread integration suite; they were not rewritten by these ports.

## Deferred decisions

Memory schema, revisions, evidence and selected review/handoff behavior are now selectively ported; see [shared memory](shared-memory.md). Model-driven consolidation, Dream, exports/mirrors, automatic expiry, default
`atlasOnlyMemory`, code-index removal and transcript-tail liveness inference are
not included. Git write UI, embedded Browser, native engine, account, organization
and cloud infrastructure remain removed. Existing profiles, sessions,
checkpoints, personal facts, tasks, local memory and CLI authentication remain
compatible. No product version or extension version is bumped by these ports.
