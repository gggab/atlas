# ADR-0015: Code search is served by the atlas_code tool server

**Status:** Accepted, selectively adapted from upstream bb8eb6ac for the local external-Agent workbench.

## Decision

Offer read-only project code search through HTTP MCP at /code on the existing memory listener. One session token covers all offered local services, avoiding token replacement between services. The agent must advertise HTTP MCP support; agentCodeTools gates new offers and every running call independently of memory sharing.

The atlas-search engine serves grep and find_files in process, with scoped paths, ignore rules, bounded output, cancellation and explicit partial results. The project search overlay uses the same engine. The atlas-codeindex SQLite index adds symbol, graph and semantic tools; atlas-grepindex accelerates grep in large Git projects, and atlas-retrieval shares vector persistence and fusion primitives with memory. Code and memory embedding selections remain separate.

The Claude adapter receives allowedTools metadata only for the read-only atlas_code service. Memory, SSH and Browser Use retain their existing adapter permission rules. No native execution engine, organization service, model gateway or prompt injection is restored. Model weights are downloaded explicitly. Tools are offered, not guaranteed to be called.

See [Local code search](../reference/code-search.md) for storage, security limits and development checks, and ADR-0016 for the pull-based task-context seed.
