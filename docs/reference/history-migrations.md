# History branches and named migrations

The thread catalog is `<app-config-dir>/threads.db`; Atlas Dev uses its own
configuration profile. It stores conversation metadata, not transcripts,
checkpoints, shared memory, vendor login or credentials. This selective port
from upstream `6e910c7e` extends only that catalog and the cards that read it.

## Recorded branch

The host probes the session's working directory when it binds and before each
turn. Git runs on the blocking pool, so a branch label cannot block sending.
Only the newest in-flight probe per session may write. A changed name emits
the existing history-change event; the same name does not produce another
write or event. Live conversation updates preserve the recorded branch.

Cards display the last branch Atlas actually observed. Switching the project's
branch alone does not rewrite old conversation labels; binding or sending a
new turn refreshes its label. Detached HEAD, missing Git and non-repository
directories do not replace a previously observed name. Thus a branch label is
historical metadata, not a guarantee about the directory's present checkout.
Older and imported rows start with `NULL`, with no guessed backfill.

No PR queries, remote Git calls, checkout or repository writes are introduced.

## Compatibility

The previous catalog used linear `PRAGMA user_version = 3`. The new catalog
uses epoch **5** and a `schema_migrations(name, at)` ledger. Each build applies
its missing named migrations transactionally and leaves unknown names and
tables alone. Additive changes can coexist across branches at the same epoch.
A breaking schema change must increase the epoch; this build refuses anything
above 5 before changing its journal mode or schema.

Legacy versions 1 through 5 are accepted. The new nullable `threads.branch`
column is added only if absent. The former V3 data-cleanup migration is recorded
as already complete on V3+ databases and is not replayed on their existing rows.
The historical upgrade behavior for pre-V3 databases remains unchanged.
The store's existing unsent-draft pruning also remains unchanged.

Terminal discovery adds two tables through the same ledger: `deleted_sessions`
prevents repeated imports after deletion, and `session_aliases` stores confirmed
continuation IDs. They do not raise the epoch or replay old cleanup. See
[Session discovery](session-discovery.md) for the inference and live-send limits.

A pre-ledger build supporting linear version 5 can still open this catalog.
The old fork build supporting only version 3 cannot; use the rollback procedure
below before running it against the same data profile.

## Backup and rollback

Before modifying an existing catalog, opening it takes a SQLite `VACUUM INTO`
snapshot, including committed rows still in its WAL. The snapshot is written
to a unique sibling temporary file, checked, then published without replacing
the first backup for that starting version: for example `threads.db.bak-v3`.
Temporary snapshots are cleaned up after publication. An existing backup must
be readable, pass SQLite's quick check, contain the threads table and have its
expected starting version. An invalid backup or a backup-write/publication
failure stops opening and migration, with the original error shown in history.
Snapshot publication requires filesystem hard-link support; a failure is
reported explicitly. Fresh empty catalogs need no pre-migration backup.

These backups preserve the first snapshot at their starting version. They are
not continuous backups and do not contain later conversations. Keep regular
backups independently.

To return to a build supporting only V3:

1. Close every Atlas process using that profile, including Atlas Dev instances
   if they were explicitly configured to share it.
2. Preserve the current catalog and its WAL/SHM files as a separate recovery
   set. Moving to an earlier snapshot will omit changes made after it.
3. Restore the verified `threads.db.bak-v3` snapshot as `threads.db` in the
   same profile. Do not mix that snapshot with the newer catalog's WAL/SHM.
4. Start the older build and check its history. Keep both recovery sets until
   the result is verified. Restarting the new build will migrate again.

Do not lower `user_version` manually on a live database or delete a backup to
force a failed migration through. Inspect and preserve the failed artifacts
first. No production catalog is migrated by the development tests below.

## Development verification

```sh
cargo test --locked -p atlas-thread-metadata
cargo test --locked -p atlas --lib branch_history
cargo test --locked -p atlas --lib only_the_newest_branch_probe
cargo check --locked -p atlas --lib
bun run test -- src/features/chat/components/session-card.test.tsx src/features/chat/components/session-sidebar-cards.test.tsx
bun run typecheck
bun run lint
bun run build
```

Temporary-database tests cover legacy upgrades, named steps, unknown tables,
concurrent upgrades, backup preservation, WAL rows, invalid-backup rejection,
legacy-shape recovery and branch persistence. Host tests bind a scripted Agent
to a real temporary Git repository and observe bind/turn-start branch changes.
They do not establish a vendor-authenticated CLI turn or an installed app's
live migration. Windows desktop test-runner activation limits are documented
in `local-workbench.md`.
