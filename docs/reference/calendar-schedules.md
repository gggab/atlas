# Gregorian recurring reminders

Calendar reminders extend the [local scheduler](task-scheduler.md). The desktop
process must remain running and the computer awake. This adds no daemon, device
wake, mobile channel or communication-source access.

## Rules and clarification

Choose daily/weekly/monthly/yearly, a Gregorian anchor date, reminder clock,
fixed IANA timezone, lead days, optional inclusive end date, and whether each
period needs explicit completion. The clock is a reminder preference, not a
verified bill cutoff. A past anchor preserves phase without backfilling periods
before registration; already-past lead slots are skipped at creation.

UI creation previews before saving. Rust preview and execution share one engine.
Every save revalidates; no model confirmation boolean can bypass it. Missing
critical choices persist a `needs_confirmation` draft with structured questions
and zero occurrences, runs or outbox. Resolve using a revision-checked edit.
Invalid edits to activated calendars leave the current rule unchanged. Drafts
share the existing 500 unfinished-task limit.

Agents should propose choices from the user's request, trusted source or existing
preference, asking only material unresolved questions. Save the resolved choices
as a snapshot. The backend validates fields, not the model's interpretation of
consent. This feature adds no automatic preference learning or memory injection.

| Boundary | Behavior |
| --- | --- |
| Monthly day 29–31 | Explicit `last_day` or `skip`; original anchor never drifts |
| Annual February 29 | Explicit `last_day`, `next_day` (March 1), or `skip` |
| Lead days | Unique, include 0, at most 8; daily only 0, weekly 0–6, others 0–30 |
| DST gap / fold | Next valid local minute / first occurrence, independently for each lead |
| Lead across DST | Subtract local calendar dates before timezone conversion |
| Travel | Fixed named timezone; never follows a changed computer zone implicitly |
| Lunar/holiday rules | Unsupported; do not invent dates or business policies |

The bundled `chrono-tz` IANA database resolves named zones. Slots retain nominal
local time alongside cached UTC, and task progress records the tzdb version.
After a tzdb change startup recomputes pending future slots; consumed slots and
absolute snooze instants are not replayed or converted.

## Periods and slots

Additive SQLite schema v2 adds `calendar_occurrences` and `calendar_reminders`.
The old tasks, runs and notification outbox remain; missing JSON fields default
compatibly. Existing one-shots and bounded Agent checks keep their behavior.

A period has unique `(task_id, nominal_period_index)` identity: elapsed
days/weeks/months/years from its immutable anchor. Skipped months/years consume
indices without shifting subsequent identities. Each period has an independent
revision, state and date/zone snapshot. Completing January never pays February
or stops the series. Reminder rows are the only slot authority. Lead IDs include
the lead-day value; snooze IDs include their kind and the new period revision.

Complete/skip/snooze act on a named period. Snooze uses an absolute future instant,
replacing unsubmitted slots through that instant and retaining later slots. Other
periods remain independent. The UI offers one hour; MCP accepts an explicit
instant. Reading/dismissing a notification never completes a period. Tracked
periods remain pending until explicit action. Informational periods become
`elapsed`, not paid, after their date and stay outside overdue to-do counts.
History is paginated; unpaid periods are never silently expired or removed.

## Editing and pausing

Activated anchor date and frequency are immutable; changing them requires an
explicit new series. Clock, zone, lead days, end date and completion preference
can change for untouched future periods, retaining their IDs. A period is frozen
when its due reminder time has passed, any slot was reserved, or it was completed
or skipped. Edit preview preserves its snapshot and lists up to 20 recent frozen
dates. Resume before editing a paused series. Claimed runs and unfinished history
catch-up reject edits until they settle. Ended calendars require a new series.

Edits reset the scan for the new rule revision, never paid states or identities.
Unsubmitted notices invalidated by edits rearm from unresolved slots once;
locally accepted native submissions do not rearm. Ordinary backwards clock
movement cannot replay a claimed/queued slot.

Pause stops notifications, not business obligations. Resume retains unpaid
periods and materializes intervening periods but suppresses slots in durable
pause intervals; it does not burst-send paused reminders. Unsubmitted pre-pause
slots may create one merged notice. Cancel ends the series while preserving
history. Series-wide complete/snooze are rejected; use period controls. An end
date stops recurrence without paying outstanding periods.

## Catch-up and delivery

Materialization persists a fixed cutoff, expands at most 64 periods per
transaction and considers at most 4 series per pass. It includes the first period
whose earliest reminder exceeds the cutoff, covering advance reminders. A
not-ready series cannot dispatch.

After expansion, one indexed SQL transaction reserves all eligible elapsed slots
into one durable fixed-reminder run. This set-based reservation is intentionally
outside the 64-period *materialization* bound; it does not load all history into
memory or perform external calls. Settlement commits one outbox entry and run
result together. Restart settles the same fixed claim without replaying an Agent
prompt. Future slots remain pending. A digest contains a count and at most three
dates; full periods remain in the paginated task detail.

Task revisions fence series edits, period revisions fence individual controls.
The existing exclusive profile lock, DB mutex and transactions own all writes.
Delivery rechecks series and slots under that mutex immediately before native
submission. Mixed digests remove completed/snoozed periods; empty digests are
suppressed. Native acceptance records that the local submit call succeeded,
not receipt, reading or completion. Existing native-call/DB-ack crash duplication
and stable-tag limitations remain explicit.

## Agent tools and checks

`tasks_upsert` accepts optional `calendar`; one-shots still require future `dueAt`.
Calendars require `kind=reminder`. `tasks_calendar_preview` validates without
activation and optionally previews an owned edit. `tasks_occurrences` pages owned
history. `tasks_control_occurrence` requires both task and period revisions.
Owner/session gates apply throughout; scheduled turns cannot mutate plans/periods.

Claude and Kimi independently reviewed the proposal on 2026-10-16 and accepted
the final revision after correcting generation-dependent IDs, catch-up cutoffs,
activation boundaries, edit/snooze identity and pause semantics. The existing
single-profile lock made an additional distributed lease unnecessary.

Tests cover short months, leap centuries, DST, activation/end boundaries, draft
isolation/resolution, v1 migration, frozen identities/previews, period actions,
multi-year catch-up, fixed-claim recovery, mixed digests, pause intervals and old
one-shots. UI tests cover preview-before-save and named-period completion. Real
vendor MCP calls and native receipt require separate desktop integration checks.

### Local verification, 2026-10-16

- Typechecks, frontend lint and production build passed. The focused task,
  notification and settings run passed 212 tests across 18 files.
- `cargo check --locked -p atlas --lib --tests -j 1` passed, including the new
  task-tool schemas and desktop integration's test code.
- The local Windows app test link failed with `no space on device`; the full
  Tauri test executable was not run. A disposable standalone Cargo harness under
  ignored `output/calendar-check/` directly included the production calendar,
  model and store modules plus their unchanged test modules. Its 27 tests passed,
  including five-year catch-up and temporary-file SQLite v1 migration. It does
  not validate Tauri/native notification plumbing or vendor-authenticated MCP.
- All task databases used in these tests were temporary. No production profile,
  real reminders or app-owned vendor model turns were created.
- Repository contracts passed 213 tests and retained the same 9 pre-existing
  failures: Windows Bash availability, legacy-name residue assertions and the
  existing Windows release-workflow classification. These are outside this change.
