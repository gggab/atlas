# Terminal session discovery

This selective port of upstream `a335ec9c` extends the existing metadata-only
history catalog. Opening a project and regaining window focus request debounced
ACP `session/list` sync for
installed agents that already have history in DeskMate. Capability negotiation
still decides whether listing, loading, resuming and deleting are available.
Discovery does not install agents or authenticate vendor accounts.

## Discovery and activity

Recent sessions active within seven days enter the sidebar; older sessions remain
archived. New activity can unarchive an existing session. Manual import and the
one-time backfill still start archived. Imported rows receive a fixed ordering
timestamp so ongoing activity does not keep moving them between History groups.

For Claude's storage format, DeskMate additionally watches the open project's
directory under `~/.claude/projects`. It lists UUID-shaped transcript filenames
and file metadata for discovery. The activity refinement adapted from upstream
`16d69e1d` (Adib Mohsin) may read bounded JSONL tails for liveness only: it extracts
record type, timestamp and a string entrypoint marker, discarding message fields.
Tail bytes can contain conversation content; they stay local and transient and
are never persisted, logged or rendered by discovery. Replay remains ACP.
The provider currently follows the default home-directory location, not
`CLAUDE_CONFIG_DIR`. ACP listing determines which installed agent owns a discovered
session. Other agents get protocol-based sync without this file-time live signal.
File-time liveness is limited to the currently watched open project; it is not
a global detector of every CLI process or every unopened project.

A conversation write within roughly 90 seconds that DeskMate's own turns do not explain marks
the session "Active in another process". This is an activity heuristic, not a
process lock: a quiet process may still be running. DeskMate's own turn activity and
its five-second trailing-write window avoid marking its own writes as external.
The clock refreshes the live marker. Unknown sessions retry with bounded backoff;
one failed agent is logged and does not block other agents' history.

Only files with a recent mtime are opened. A fixed-length snapshot tries 64 KiB,
then 2 MiB only when the smaller window has no decisive complete record; each
window includes at most one boundary byte. Total read budget is at most
2 MiB + 64 KiB + 2 bytes per probe. A valid conversation timestamp replaces mtime
for liveness. Bookkeeping after a quiet terminal exits cannot renew that time.
Only the exact, case-sensitive types `ai-title`, `last-prompt`, `cost-state` and
`mode` are recognized as inert bookkeeping; unknown types fall back to file time.
Timestamps up to two seconds beyond mtime are clamped to it for filesystem
granularity; later timestamps are unknown. Unreadable, malformed, partial,
oversized or concurrently changed evidence explicitly falls back to mtime.
An SDK entrypoint never proves that DeskMate owns the writer. A fresh SDK write
without a tracked DeskMate turn still counts as external activity. After a
restart, lost in-memory turn ownership can conservatively show a recent own turn
as external until it ages out.

File mtime and size still drive discovery, alias settlement and history touches;
conversation timestamps affect liveness only. The watcher caches unchanged file
observations, serializes scans outside its state lock and publishes complete
snapshots only for the current project generation. A transient read failure is
cached conservatively until file time or size changes. Rewrites preserving both
mtime and size are not detected. Regressed file times invalidate liveness caches
but never settle aliases or touch history. The scheduler uses the same
activity reader for its bound UUID session, independently of the watched project.
Both paths canonicalize the project with `dunce`, avoiding Windows' verbatim
prefix for ordinary paths while preserving drive and UNC roots in the fallback.
Very long/reserved paths may still need a verbatim spelling; alternate case or
drive spellings have not been validated with a real CLI.

## Sending, deleting and ordering

Opening a live row does not clear its live marker. The composer shows a banner
and holds sends until "Send anyway" or until external activity becomes quiet.
The panel also guards suggestion chips, handoffs, permission replies and queued
sends. Held messages stay queued. The override lasts only for the current live
period. A live session cannot be deleted through DeskMate.

Deleted session IDs are recorded durably so sync cannot import them again.
Confirmed continuation aliases are also recorded and removed with their owner's
row. A conversation still open in DeskMate and explicitly continued can write its
row again. The existing catalog backup and epoch-5 compatibility rules remain;
`deleted_sessions` and `session_aliases` are additive named migrations.

Adapters can change their private transcript ID without an ACP signal. DeskMate
temporarily attributes a new file beside an in-flight DeskMate session, revokes the
guess on an unexplained write and persists it only after a later turn confirms
it. This inference can briefly hide a concurrent terminal session until its next
unexplained write; an adapter-level storage-identity signal would remove that
limitation. Only confirmed aliases enter the database.

While the pointer or keyboard focus is inside the sidebar list, existing rows
keep their order to prevent activity moving a row under a click. New rows and
deletions remain visible; leaving the list restores activity order.

## Development checks

```sh
cargo test --locked -p atlas-agent-transcript -p atlas-thread-metadata
cargo test --locked -p atlas --lib session_watcher
cargo test --locked -p atlas --lib live_elsewhere
cargo test --locked -p atlas --lib atlas_activity
cargo test --locked -p atlas --lib project_dir_tests
cargo test --locked -p atlas --lib scheduler::runner::activity_tests
bun run test -- src/features/chat/components/composer-live-elsewhere.test.tsx src/features/chat/components/chat-panel-live-elsewhere.test.tsx src/features/chat/components/session-sidebar-frozen-order.test.tsx src/features/chat/stores/live-elsewhere-store.test.ts src/features/chat/lib/drain-gate.test.ts tests/wire-shape-contract.test.ts
```

These checks use temporary directories, catalogs and scripted agents. They do
not migrate the user's catalog or establish a real vendor CLI restoration.
