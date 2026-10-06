# `atlas-memory` — Migration & Operations

How Atlas's RAG/memory moved from the in-Tauri **brute-force O(n) cosine** over a
flat `memory-index/index.json` to the on-device **MiniLM → usearch HNSW** engine
in this crate (the grafeo graph that briefly sat beside it was removed in #89).
Covers the on-disk layout, the legacy migration, the feature flags, the
retained rollback fallbacks, and the **manual** 3-agent runtime verification.

External ACP agents access the same local store through the loopback MCP server. Atlas accounts, the native agent, gateway extraction and pushed prompt context are no longer part of this build.

## 1. On-disk layout

### Per-project — `<project>/.atlas/memory/`

| Path | Written by | Purpose |
|---|---|---|
| `hnsw.usearch` | `HnswStore::save` | Persistent usearch HNSW index (384-d MiniLM vectors, cosine). |
| `manifest.json` | `Manifest::save` | `{ provider_name, dim, next_key, entries[] }`. Holds the `id ↔ u64 key` bimap and per-doc `content_hash` so an unchanged doc is never re-embedded. **Supersedes** the legacy `index.json`. Atomic write (temp + rename). |
| `docstore.json` | `DocStore::save` | `id → { title, source, text }` side-map so retrieval renders docs without re-gathering the corpus. |
| `extracted/*.md` | legacy imports only | Old extraction files are imported into the record store; this build does not create new extraction output. |
| `memory.sqlite` (+ `-wal`, `-shm`) | `record::RecordStore` | The shared-memory **record store** (#80): `events`, `entries`, `sessions`, WAL. Lives only at the **scope root** (the repository's main worktree, else the launch directory). Replaces `.atlas/shared-memory/events.jsonl` + `state.json` as the Shared tab's store. |
| `.record-store-migrated` | `record::legacy` | Marker: this directory's legacy `shared-memory/events.jsonl` and `extracted/*.md` were folded into its scope's record store. Written in every worktree that had legacy files; the same fact is kept in the store's `legacy_imports` table. The legacy files are kept one release. |

No longer written or read (#89), safe to delete: `graph/` (the grafeo graph;
its content — the legacy shared log — lives in the record store),
`.shared-memory-imported` (its marker), and `.consolidation_lock` /
`.consolidation_state.json` (the dream gates' lock and state; the memdir they
pruned is no longer written, and the record store caps what it shows per kind).

### Global (cross-project) — `~/.atlas/memory/`

| Path | Purpose |
|---|---|
| `MEMORY.md` | Human-readable promoted list, newest first, kept **< 200 lines** (oldest bullets trimmed). |
| `global-promoted.jsonl` | Every promoted memory (`{"content": …}` per line, promotion order, never trimmed) — what global recall searches, together with `MEMORY.md` for promotions older than this file. |
| `global-candidates.json` | Promotion ledger — tracks which content hashes have been seen, in which repositories, and whether they've been promoted. |

Promotion (#89) runs over each repository's record store: a Fact at confidence
≥ 0.8 whose content hash is recorded from ≥ 2 repositories is promoted once.
`global-graph/`, written by older versions, is no longer read. Every promotion
it held was also written to `MEMORY.md`, so recall still finds those older
promotions — except any the list's 200-line cap had already trimmed. Ledger
rows written before #89 (`preference` / `constraint`, keyed by an older hash)
are kept as they are.

The global dir resolves to `~/.atlas/memory/` by default, or the
`ATLAS_GLOBAL_MEMORY_DIR` override (see §3).

---

## 2. Legacy `index.json` (removed in #90)

The flat `<project>/.atlas/memory-index/index.json` is no longer read or
written. Memory ▸ Graph, its natural-language query and the Policy view take
their vectors from this crate's HNSW engine (`MemoryEngine::cached_vector`,
`add_embedded`, `search_ids`), and the one-shot import that used to lift
`index.json` into HNSW on open is gone with it: a project that still has the
file is simply re-embedded by the indexer's first pass. The file (and any
`index.json.bak`) is left on disk untouched.

The legacy `.atlas/shared-memory/events.jsonl` is folded into the record store
by `record::legacy` (guarded by `.record-store-migrated`), not by the engine.

---

## 3. Environment overrides

| Env var | Default | Effect |
|---|---|---|
| `ATLAS_GLOBAL_MEMORY_DIR` | `~/.atlas/memory/` | Overrides the global memory directory; tests use isolated directories. |
| `ATLAS_MINILM_DIR` | unset | Supplies a local MiniLM model to explicitly ignored model tests. |

## 4. What remains for rollback

The pre-HNSW brute-force retrieval (`memory_retrieve::retrieve_brute_force`)
has been deleted; HNSW is the only retrieval path and there is no switch back.
What remains:

- **Archived legacy data** — the original `shared-memory/events.jsonl` (and any
  old `memory-index/index.json[.bak]`) remain on disk, unread.

The micro-benchmark `bench_hnsw_vs_brute_force` (in `atlas-memory`'s
`parity_bench` module, `#[ignore]`d; run with `--ignored --nocapture`) measured
HNSW at roughly **two orders of magnitude** faster per query than a brute-force
cosine on a few-thousand-vector corpus.

---

## 5. Manual runtime verification

1. Start the desktop app, open one project and enable memory sharing.
2. Use two installed external ACP agents with their own vendor subscription login.
3. Ask the first agent to store a unique decision with `memory_remember`; inspect it in Memory → Shared.
4. Ask the second agent to find it through `memory_search` or `memory_list`, and inspect the same entry ID and content.
5. If testing semantic document retrieval, install MiniLM and wait for the background index to finish. Confirm `hnsw.usearch` and a populated `manifest.json` exist.
6. Restart the app, restore both sessions and confirm the local entry still exists. Repeat from a linked worktree to check the main-worktree shared scope.

The offline tests do not replace real vendor authentication, subscribed CLI streaming or model-dependent retrieval checks.
