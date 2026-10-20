# ADR-0023: Retain the code index freshness fallback

**Status:** Accepted (2026-10-20).

## Context

Upstream `d466cf5c` removes the persistent code index, retaining on-demand grep
and file discovery. `142395a8` also contains independent performance fixes.
DeskMate retains symbol, graph and optional semantic tools, `@symbol`, manual
builds and index status. Removing their index would change the product contract.

The current code index consumes explorer file events and Git events only for
roots those watchers own. An ACP session may open an index in a separate
worktree through `Scope::resolve`, without installing an explorer watcher there.
A new top-level directory may require rebuilding the explorer watch plan, and
`.atlasignore` can re-include source paths excluded by that plan or its event
filter. These are coverage gaps, not evidence that the index is current.

## Decision

Port independent performance fixes with regression tests. Retain eager opening,
the debounced turn-end reconciliation, manual rebuilding, all ten code tools and
the separate optional code embedding selection. Preserve the local
`code_index.apply_feed` and project-close cleanup while adapting file-picker
optimizations. The Agent code-tools switch continues to govern Agent access;
it does not stand in for an index ownership policy for UI consumers.

Defer removing turn-end reconciliation and introducing lazy activation until
index freshness has an explicit coverage owner or a query-time freshness design
covering worktrees, new directories and ignore overrides. Do not introduce an
incomplete lazy mode, new setting or new status shape in this performance port.
Do not delete existing derived indexes, model files or user memory.

## Consequences

The redundant-reconciliation cost remains; this port does not claim to make
indexing idle or measure a CPU reduction. File/mention ranking, transcript
membership checks, recent-chat writes, editor reconciliation, stream parsing
and long terminal output avoid independent repeated work. The silent-terminal
output-pane change and native-engine sink/replay changes are excluded.

Independent Claude review and the primary agent agreed on this boundary after
checking the local watcher paths. The primary agent owns implementation and
verification; review is not runtime evidence.
