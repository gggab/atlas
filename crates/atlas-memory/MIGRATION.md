# Memory migration and operations

The supported local-workbench behavior is documented in
[project shared memory](../../docs/reference/shared-memory.md). It supersedes
upstream gateway, native-engine and automatic extraction instructions.

Schema v4 → v7 keeps IDs, events, sessions and deletion tombstones, creates
baseline revisions, adds candidate/active/archived state and full-text/cache
projections, and enables feedback and structured handoff. The upgrade writes a
consistent `memory.pre-v4.sqlite` first; retries keep that file and take a fresh
timestamped snapshot. Owned pre-upgrade/daily snapshots and corruption quarantines
are removed by explicit purge/clear so erased text cannot be restored from them.
Ordinary forgetting retains revisions. Project transcripts and vendor files are
separate records and are not removed by these operations.

Old corpus files are retained; new corpus documents and BM25 rows live in
`corpus.sqlite`. Dense embeddings are optional and downloaded explicitly. The
per-model usearch file is rebuilt from the cache if missing or torn.

Open never treats a newer schema, busy database or permission failure as
corruption. Confirmed corruption is quarantined and restored from the daily
snapshot when available, with a visible recovery status. An older app cannot
read the upgraded store: do not point it at schema v7. To investigate rollback,
stop all owners first and preserve the upgraded store plus WAL/SHM before using
a retained pre-migration snapshot in an isolated copy. A snapshot cannot contain
writes made after it was taken.

Use the synthetic `tests/fixtures/v4.sql` and `tests/revision_contract.rs` for
migration regression. Never point a test at a real user profile. The app tests
exercise MCP with real loopback clients and no billed vendor call.
