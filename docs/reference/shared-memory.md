# Project shared memory

DeskMate's repository memory is shared by external ACP sessions and worktrees.
It is separate from personal facts (`personal.sqlite`), tasks (`scheduler.sqlite`)
and each vendor CLI's own memory. The MCP instructions ask an Agent to read and
write; tool availability does not guarantee retrieval or automatic learning.
Project prompts receive no automatic memory injection.

## Writes, trust and history

Every content/state change appends a revision. Current entries, BM25 and vectors
are projections of canonical history. A keyed replacement from a different
session requires `expected_revision`; another session of the same Agent is a
different writer. A conflict returns the current revision for an explicit reread.

The durable kinds are decision, fact, failure, architecture and preference.
Plans and file changes remain captured working memory. Preferences are briefed
first. Candidate/active/archived are entry states, not changes to a vendor's own
memory policy. Captured assistant assertions and new Claude-memory imports are
candidates; they are excluded from briefings until confirmed. Imported filenames
and type labels are untrusted provenance, never authority to promote a memory.

Memory → Shared → Review exposes candidates and explicit merge/conflict choices.
Every mutation is a user action; no background consolidation runs. Shared →
Memories exposes current entries, provenance, revision history, editing, feedback
and deletion. The chat's Memory updated card shows that session's actual writes;
its entry links open Shared → Memories. Personal Assistant does not show this
project card. Review/read errors are reported instead of claiming an empty store.

`memory_feedback` records useful/wrong/stale verdicts. Wrong archives an entry;
stale makes it a candidate. Forget stops recall while retaining history. Erase
with history purges the record's original text, revisions, event payloads,
embedding cache, owned daily/pre-migration snapshots and timestamped corruption
quarantines. It does not erase the conversation, checkpoint store, vendor records
or user-maintained source files.
Filesystem removal failures are reported. Hash chains detect accidental or
unacknowledged edits; they are not keyed signatures against an attacker.

## Retrieval, evidence and handoff

Search combines BM25 with content-keyed vectors through reciprocal-rank fusion.
Without a downloaded model, lexical search and indexing remain available. A
bounded Han substring leg supplements unicode61's uninterrupted Chinese tokens.
Semantic quality/model benchmarks still require the explicitly installed model.

`memory_remember` accepts code paths and line ranges. The server checks scope and
hashes the cited content. Reads report valid/moved/stale/unverifiable evidence;
stale entries leave briefings and rank below current entries in search. A file
that cannot be checked is not silently declared valid. Worktree citations are
checked in the session's worktree. Uncited code-related entries can derive commit
evidence from the existing checkpoint recorder; no recorder means no invented
provenance. `memory_why` names the recorded work behind a file or commit.

Finished sessions leave structured handoff notes. Briefings remove forgotten,
archived or unconfirmed items from old notes. Recorded rewinds demote affected
writes to candidates: checked on rewind (with a bounded delayed retry), session
end and health catch-up. Without capture, no turn boundary is guessed.

## Storage and recovery

Under the repository scope's `.atlas/memory/` (`.atlas-dev/memory/` in Dev):

| File | Purpose |
| --- | --- |
| `memory.sqlite` | Canonical revisions and the current record, schema v7 |
| `memory.pre-v4.sqlite` | Consistent pre-upgrade snapshot for a v4 database |
| `memory.snapshot.sqlite` | Daily snapshot when health runs |
| `memory.sqlite.corrupt-<time>` and companions | Confirmed corruption kept for inspection |
| `restored.json` | Recovery marker surfaced by the app |
| `corpus.sqlite` | Documents, full-text rows and model/content-keyed vector cache |
| `corpus.<model>.usearch` | Rebuildable vector projection |

The v4 upgrade preserves entry IDs, sessions, events and deletion tombstones and
creates a baseline revision for every existing entry. A pre-migration SQLite
snapshot is written before schema changes. Old HNSW/manifest/docstore files are
retained while the new corpus is reconstructed. If an earlier pre-migration
snapshot exists, a timestamped snapshot preserves the latest state on retry.
A newer schema, lock error,
permission failure or failed migration is refused without quarantining valid
data. Only confirmed SQLite corruption/integrity failure permits quarantine and
snapshot recovery; the UI reports recovery, including an empty recovery.

Health runs on first corpus open, every 30 minutes and after an embedding-provider
change. It repairs derived entries/FTS/cache/vector files and snapshots the
record, off the async runtime. Full queue jobs are coalesced and retried. A closed
project is not reopened by stale jobs. A broken revision chain is reported;
**Review history change → Trust changes** requires explicit confirmation before
accepting an external edit and rebuilding the view. No time-based archive job
is scheduled. Never accept an unexplained history edit as a routine repair.

The app's independent backend owns these services when enabled; a GUI client
uses the existing IPC allowlist and starts no second memory owner.

## Development and validation

```sh
bun run typecheck
bun run lint
bun run test -- src/features/memory
bun run build
cargo test --locked -p atlas-memory --lib --test revision_contract --test fault_injection --test briefing_index --test behaviour
cargo test --locked -p atlas-checkpoint --test reads
cargo test --locked -p atlas --lib memory_
cargo check --locked -p atlas --lib
```

The v4 migration fixture is synthetic and checked into
`crates/atlas-memory/tests/fixtures/v4.sql`. Tests cover two sessions of the same
Agent, stale revisions, timestamp ties, candidate exclusion, code changes,
snapshot recovery, future-schema refusal, Chinese lexical recall and MCP calls
over real loopback clients. Browser mocks cover presentation only. Model-dependent
tests, real vendor turns and installer validation are separate checks.

## Deliberately excluded

No automatic transcript extraction, gateway/account restoration, Dream/model
review, AGENTS.md export, Agent Memory Repo mirror/import or default
`atlasOnlyMemory` is introduced. Compatibility tables retained from upstream's
schema do not schedule or expose those features. The existing read-only code
index and its tools remain enabled according to their own settings.
