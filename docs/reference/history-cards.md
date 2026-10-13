# Basic history cards

The chat sidebar and header's session dropdown present existing thread metadata
as cards. A title occupies up to two lines; the current conversation is marked,
and each card shows its original Agent. Historical native Agent marks identify
old records only and do not restore the removed engine.

Cards also show the last Git branch DeskMate observed for that session. Older or
imported rows can have no branch; the current project's checkout is never used
to guess their past branch. See [History migrations](history-migrations.md) for
recording behavior, backups, compatibility and rollback.

## Status and duration

An open session's `running` status displays a working ring and the duration of
its current turn. `waiting` displays `Needs input` for permission or plan
approval. A card with no busy live session displays its last update; that does
not certify task success.

A separate live dot marks recent activity attributed to another process.
Opening its card keeps the marker and the composer holds sends until "Send
anyway" or until the activity window expires. This is a file-time heuristic,
not proof that a process has exited. See [Session discovery](session-discovery.md).

`turnStartedAt` is temporary chat-store state. Entering running/waiting stamps
it once, moving between those two preserves it, and leaving them clears it.
The waiting interval therefore counts toward elapsed time when execution
continues. A new ACP turn identity resets the timer even when the buffered
events end one turn and start the next in a single update. Restoring a busy session stamps
the time it is observed locally, not an invented original CLI start time.
The timer is not persisted and is not historical usage or billing data.

All running cards share one one-second clock. Hidden windows pause refresh;
returning recalculates elapsed time. The working animation respects reduced
motion, and screen readers receive a static status description rather than
per-second announcements.

## Projects, search and actions

Within the current project, cards omit repeated project names. A card from
another project names it. When no project is open, each run of a project's
cards receives a heading. Placement is computed after title search, so hiding
the first matching project's row cannot remove its heading. Project scope
continues to come from the existing backend's canonicalized paths.

The card's main button opens the conversation by click, Enter or Space. Archive
and delete are separate buttons, visible on hover or keyboard focus, and do not
trigger opening. Existing handlers remain responsible for all operations:

- Open focuses an existing tab, or restores with the recorded Agent and
  directory. A busy current tab is preserved by opening another tab. ACP
  capability negotiation still determines load/resume support.
- Archive removes a thread from the active list but keeps it in All history.
  Reopening or new activity within the discovery window unarchives it; archive
  does not cancel an active turn.
- Delete removes DeskMate's history row and asks the Agent to delete its copy only
  when it advertises that capability. It does not guarantee erasing all CLI
  data or checkpoints. A still-running conversation may be recorded again.
  A session marked live in another process cannot be deleted. Deleted IDs are
  remembered so discovery does not re-import them.

Rows keep their order while pointer or keyboard focus is in the list; their
content still updates. Leaving restores activity order.

Loading, an empty project, no title matches and a history read error have
different messages. Failed reads display the error without automatic query
retries; the existing history-change and window-focus refresh signals remain.
A refresh failure is displayed even when an earlier list is still available.

## Integration boundary and development

This selectively ports cards and branch metadata from upstream `6e910c7e`.
Branch recording now includes a nullable column, named migrations and verified
pre-migration snapshots. The approved `a335ec9c` port adds metadata-only terminal
discovery; replay remains protocol-based. There is no PR lookup or cloud sync.
All history still uses the existing store.
The All history dialog keeps its existing list and import behavior.

```sh
bun run test -- src/features/chat/components/session-card.test.tsx src/features/chat/components/session-sidebar-cards.test.tsx src/features/chat/lib/sidebar-grouping.test.ts src/features/chat/stores/chat-store.turn-start.test.ts
bun run typecheck
bun run lint
bun run build
```

Tests exercise timers, waiting/terminal transitions, keyboard activation,
independent action buttons, project filtering, query errors, existing-tab focus
and preservation of a busy tab during resume. DOM/mock checks do not establish
native desktop behavior or vendor-authenticated CLI restoration.
