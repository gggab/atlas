# atlas-memory — local shared memory

This Tauri-free crate owns the on-device MiniLM embeddings, persistent usearch HNSW index, document store, SQLite memory records and cross-project global promotion. It has no native-agent or Atlas account dependency.

The app layer (`agent_memory`, `memory_indexer`, `memory_retrieve`, `shared_memory` and `memory_server`) gathers the corpus and exposes it to external ACP agents. An enabled project offers the loopback MCP tools `memory_briefing`, `memory_changes`, `memory_search`, `memory_get`, `memory_list`, `memory_remember` and `memory_forget`. Session-bound local tokens authorize each caller; they are independent of vendor subscription login.

Repository worktrees resolve to the same main-worktree scope. Plans, completed tool calls and assistant turns are recorded locally. Durable facts and decisions can be written explicitly through `memory_remember` and viewed in Memory → Shared. The removed Atlas gateway no longer runs automatic extraction, and prompts are not given a new memory injection path.

## Storage and indexing

- `<scope>/.atlas/memory/memory.sqlite`: shared events, entries and sessions, with legacy import support.
- `<project>/.atlas/memory/hnsw.usearch`, `manifest.json`, `docstore.json`: searchable document index and display text.
- `~/.atlas/memory/`: existing global promotion ledger and human-readable memories.
- Existing `shared-memory/events.jsonl` and `extracted/*.md` are imported without deleting original data.

The indexer runs outside chat turns and responds to project opening, watched files and captured events. `MemoryEngine::retrieve(query, limit, provider)` accepts no agent discriminator. Its results combine indexed project documents with promoted global facts. Initial MiniLM installation can require a model download; retrieval itself runs on device.

## Validation

Run `cargo test -p atlas-memory` for record roundtrips, import, HNSW, retrieval, global promotion and provider tests. Tests requiring an installed MiniLM model or a benchmark are explicitly ignored by default. Set `ATLAS_MINILM_DIR` to a directory containing `model.safetensors` to run model-gated tests.

The desktop `memory_server` tests use a real loopback HTTP listener to check authorization, MCP capabilities, sharing gates and cross-agent access. Real external CLI integration additionally requires an installed vendor CLI and its subscription login.

See [MIGRATION.md](MIGRATION.md) for on-disk compatibility and [local-workbench.md](../../docs/reference/local-workbench.md) for product scope.
