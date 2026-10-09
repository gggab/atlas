# Local code search

This selective port of upstream `bb8eb6ac` gives external ACP agents ten
read-only tools through the session-authorized `atlas_code` HTTP MCP service:
`grep`, `find_files`, `find_symbol`, `outline`, `read_symbol`, `related`,
`impact_of_diff`, `repo_map`, `semantic_search` and `task_context`.

## Availability and scope

The agent must advertise HTTP MCP support. Settings > General > "Let agents
search code with Atlas" controls both new offers and calls in existing sessions.
It is independent of shared-memory sharing. The code endpoint shares the memory
listener and one session token with the other local services; token binding and
revocation remain owned by the session lifecycle. SSH and Browser Use retain
their existing permission rules. The Claude adapter receives preapproval only
for the read-only `atlas_code` server.

Tools operate on the session's launch directory. Paths escaping that directory
are refused, symlinks are not followed and VCS metadata is excluded. Text search
respects ignore files, skips binary and oversized files, and hides secret-shaped
files unless explicitly requested by path. Replies have output budgets, paging
and partial-result indicators. Calls are bounded and cancellation-aware.

Receiving these tools does not guarantee the agent will use them. No code or
memory context is injected into user prompts, and no native Atlas engine is
required. Project search uses the same text-search engine independently of the
agent setting.

## Index and embeddings

The per-project index at `.atlas/code-index/index.db` (the Dev profile uses
`.atlas-dev`) is derived from source files. Tree-sitter extracts symbols
and code relations into SQLite; file and Git watchers update it incrementally.
The optional sparse grep prefilter is Unix-only upstream: its file stamps cannot
prove unchanged content on Windows. Windows uses the ordinary text scan, with
the same matching and freshness semantics; symbol, graph and semantic indexes
remain available. An unavailable prefilter is logged explicitly. Unix differential
and freshness suites compile to zero tests on Windows and are not claimed as
validated here; a Windows regression checks direct scanning after file edits.
Completed, uncanceled agent turns also schedule a debounced refresh. The composer
shows index status and offers a manual rebuild. The new index replaces the old
code-summary corpus path; shared-memory entries and their databases are preserved.
Status read failures show "Index unavailable" with the original cause; a
successful retry clears the error rather than presenting the failure as an
unbuilt index.

Semantic code search has its own embedding-model selection in Settings > Models.
Downloading model weights is an explicit user action. Without downloaded code
weights, search uses keywords and symbols; semantic replies report the absence
of vectors. A downloaded model is loaded locally. Changing code models does not
change the memory embedding selection or require a paid model gateway.

## Development checks

```sh
cargo test --locked -p atlas-search -p atlas-codeindex -p atlas-grepindex -p atlas-retrieval
cargo test --locked -p atlas-agent-servers -p atlas-memory
cargo test --locked -p atlas --lib code_server
cargo test --locked -p atlas --lib code_index
cargo check --locked -p atlas --lib
bun run test -- src/components/code-search-api.test.ts src/components/search-overlay.test.tsx src/features/chat/lib/use-codebase-index-status.test.ts src/features/chat/lib/turn-index-scheduler.test.ts
```

Loopback MCP and temporary-project tests exercise search, tokens, disabled tools,
index refresh and path restrictions. They do not establish a vendor-authenticated
CLI session, a real downloaded embedding model or desktop rendering.
