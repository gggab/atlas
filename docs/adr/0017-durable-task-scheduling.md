# ADR-0017: Durable scheduling belongs to the local Rust runtime

Status: accepted for the initial scheduler implementation.

## Decision

Keep a profile-local SQLite database with tasks, runs and notification outbox
records. Rust schedules explicit UTC deadlines and performs native delivery even
when the task center is not open. Reuse installed external ACP Agents and vendor
authentication; introduce no native model engine, remote queue or account service.

Register Agent-created tasks through a separately enabled, session-bound
`atlas_tasks` MCP server. Store registration receipts; accept structured reports
only from the current admitted run. Claiming is not completion. Progress and
notification intent commit together only after a successful terminal result.

Make human and scheduled submission share a reservation across recording,
dispatch and prompt completion. Check idle state atomically at `begin_turn`.
Background work cannot acquire a conversation by cancelling its current turn.
Keep source/run identity in wire, transcript and checkpoint records.

Conversation archive controls visibility, not task lifetime. Registered tasks
continue independently; background restore and discovery preserve archive state.
Notifications navigate to task details. Only explicit task controls or registered
completion conditions change task lifetime.

## Consequences

Desktop process lifetime bounds execution. Ambiguous dispatched work requires
reconciliation, not automatic replay. Stable native tags reduce duplicates but do
not promise exactly-once delivery. Vendor CLI permissions still apply; scheduler
authorization alone is not a filesystem or tool sandbox. Calendar recurrence,
automatic post-human-turn planning, daemons and mobile channels remain separate
features.

See [task scheduler](../reference/task-scheduler.md) for configuration, operations
and verification boundaries.
