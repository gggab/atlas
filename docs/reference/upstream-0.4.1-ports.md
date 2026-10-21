# Selective 0.4.1 ports

Source: upstream `alpha-0.4.1` (`7476d112`). These ports retain the local external
CLI scope. They do not merge the upstream branch or restore removed modules.

## Selected post-alpha fixes

The following fixes are extracted from `origin/0.4.1` at `e747d560`:

- `b836e6e7`: incomplete terminal OSC/CSI sequences have bounded pending bodies
  (64 * 1024 characters for OSC, 256 for CSI). Overlong incomplete sequences
  abandon their introducer so later output can be displayed. Normal fragmented
  sequences remain supported, including an ST terminator split at the OSC limit.
  A legitimate incomplete OSC beyond the limit is intentionally abandoned too.
- `19244e80`: search, pins and command-history jumps address their own chat tab.
  Other mounted transcripts retain their reading position and highlights.
  Unaddressed events are ignored; all three local senders supply `tabId`.
- `f3661618`: tool-reported file counts recognize ACP edit kind even when the
  call's name is a display title. Empty text contributes zero lines; only one
  terminating newline is excluded, preserving additional blank lines. Live
  summaries, restored summaries, transcript markers and existing diff sources
  use the same kind-aware extraction. Creation labels remain inferred from tool
  text, not verified Git status; newline-only changes may not affect counts.

ACP `locations` propagation is deferred pending a real vendor example. Native
`paths` arrays, new capture/session-changes IPC, cloud comments/voting, overview
redesign, PTY input queues and terminal render budgets are not part of these
fixes. Existing knowledge-saving actions remain available.

Focused regression checks (component tests use simulated DOM geometry):

```sh
bun run test -- src/features/chat/components/chat-panel-jump.test.tsx src/features/chat/components/transcript-jump.test.tsx src/features/chat/lib/tool-files.test.ts src/features/chat/lib/turn-edits.test.ts src/features/chat/lib/turn-rows.test.ts src/features/chat/stores/chat-store.deltas.test.ts src/features/terminal/lib/block-parser.test.ts
bun run typecheck
bun run lint
bun run build
```

Desktop verification: open two chat columns, leave the second browsing history,
then use search, a pin and command history in the first; the second must stay
put. In a real vendor turn, compare a titled whole-file edit's marker, summary
and diff before and after reloading the session. These checks are separate from
the simulated component tests and do not require a change to vendor settings.

## Alpha behavior

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
  overview shows delegated work and file changes. Selected memory review/health
  behavior is documented separately in [shared memory](shared-memory.md).
- All local MCP services reach external ACP Agents through the credential-free
  stdio bridge described in [ADR-0020](../adr/0020-local-mcp-credentials-stay-out-of-adapter-config.md).
- Windows library-test executables receive Common Controls v6 through the linker;
  the background build fingerprint remains. Shell-script checks find Git Bash
  and its coreutils. Usage chart dates and editor blame are more legible.

## Development checks

The external-session activity fix in `16d69e1d` is selectively adapted: Windows
plain-path canonicalization and bounded conversation-time probes are retained;
blanket SDK-writer suppression is excluded. Watcher snapshots are generation
checked and serialized, and background tasks use the same liveness reader.
See [session discovery](session-discovery.md) for metadata boundaries and limits.
The mixed commit is not cherry-picked wholesale because its SDK assumption does
not identify this application's process.

Independent performance fixes from `142395a8` are selectively adapted; the code
index removal in `d466cf5c` and the native-engine changes are excluded. See
[code search](code-search.md#selected-performance-ports) for the bounds and
[ADR-0023](../adr/0023-retain-code-index-freshness-fallback.md) for why eager
opening and the turn-end freshness fallback remain.

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
`atlasOnlyMemory`, code-index removal and blanket SDK-writer suppression are
not included. Git write UI, embedded Browser, native engine, account, organization
and cloud infrastructure remain removed. Existing profiles, sessions,
checkpoints, personal facts, tasks, local memory and CLI authentication remain
compatible. No product version or extension version is bumped by these ports.
