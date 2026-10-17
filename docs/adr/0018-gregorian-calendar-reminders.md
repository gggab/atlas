# ADR-0018: Deterministic calendar rules with independent business periods

Status: accepted.

Extend ADR-0017 with Gregorian daily/weekly/monthly/yearly fixed reminders.
Rust validates and expands explicit local dates, clocks, IANA zones, lead days
and boundary policies. Agents extract/clarify intent; missing critical choices
produce non-executable drafts. Preview and execution use the same engine.

Add separate period and reminder-slot tables. Stable nominal period indices,
independent of rule revisions and skipped months, preserve paid/unpaid states.
Activated anchor/frequency are immutable; edits preserve started snapshots and
rewrite only untouched future slots. Period controls cannot complete the series.

Materialize with a durable cutoff and bounded batches, then reserve eligible
elapsed slots with set-based SQL into one durable fixed-reminder run and outbox.
Reuse existing process ownership, revisions, native tags and delivery limits.
Pause suppresses notifications without erasing obligations. Reading is not
completion. No recurrence-specific Agent budget, lunar/holiday framework,
daemon, cloud service or mobile channel is introduced.

See [calendar schedules](../reference/calendar-schedules.md) for exact policies,
review decisions, migration and verification boundaries.
