# Durable local task scheduling

The titlebar task center is available without an open project. Rust owns the
schedule, run records and notification outbox in
`<app_config_dir>/scheduler.sqlite`. Dev and Release use their existing separate
profiles. A process holds `scheduler.lock` while it owns that profile's scheduler.
If its database or ownership lock cannot be opened, the task center reports the
initialization error and task tools stay unavailable; ordinary workbench features
remain usable. No temporary database or alternate execution path hides the error.

## Supported behavior

- Create a fixed reminder for an explicit future instant, or an Agent check in
  an existing, non-draft conversation. The form interprets dates in the computer's
  timezone and persists UTC milliseconds.
- Pause, resume, cancel, mark complete, edit or postpone a task by one hour.
  Resuming an expired one-shot requires a new future time; old reminders are not
  replayed in a burst.
- Completed and cancelled tasks offer **重新启用** and **删除** in Task Center.
  Re-enable preserves the task ID, source, execution and period history. One-shots
  and Agent checks require a future time; minute intervals start a fresh countdown.
  Calendar reminders retain their anchor and zone and never replay old slots.
  An existing end date can be extended or removed. An unresolved calendar remains
  a non-executable draft. Agent usage is cumulative; increasing its limit (at most
  100) requires an explicit field change, never a silent reset.
- Delete requires an in-app confirmation and is limited to completed/cancelled
  tasks. It atomically removes the task, runs, calendar periods/slots and outbox.
  Chat, memory, proposals, CLI effects and already-submitted OS banners remain
  independent. A minimal task ID and hash of the scoped creation key persist to
  reject old creation retries; an intentional new task needs a new key. This is
  not secure erasure or a recycle bin. Unknown IDs fail; repeated deletion of a
  known deleted ID is idempotent.
- Both operations check the inspected revision and live turn reservations under
  the Store lock. A previous execution still finishing rejects the operation with
  a retryable explanation. Ordinary edits, pause/resume and snooze cannot revive
  ended tasks. These two operations are UI/IPC only; no new MCP authority is added.
- Fixed reminders send their registered content without invoking a model.
  Delivery leaves the business item waiting for user confirmation.
- Fixed reminders can also set `intervalMinutes` (integer 1–1440), mutually
  exclusive with `calendar`. In the task center choose **按分钟间隔** (default 5).
  Saving starts a fresh countdown; the first notification is one interval later.
  Subsequent ticks follow elapsed time from that first tick, without timezone or
  DST adjustments. MCP callers supply the explicit first `dueAt`.
  They stay active until paused, completed or cancelled; `maxRuns` only limits
  Agent execution. **结束提醒** ends the entire interval schedule.
  Sleep/restart coalesces missed ticks into one notification and advances to the
  next future tick. Only the latest unsent notification is retained, preventing
  quiet-hour/outage backlogs; accepted notifications remain in history.
  Resuming an overdue paused interval starts a fresh interval without replaying
  paused ticks. Existing one-shot and calendar reminders keep their behavior.
- Agent checks reuse the bound installed CLI, directory and conversation. They
  need a negotiated HTTP MCP connection and a valid task-server offer.
- Optional per-task quiet hours defer native notification submission from 22:00
  to 08:00 in the computer's current timezone. Task execution itself can continue.
- Native notification clicks open task details. The in-app notification center
  mirrors durable IDs; reading or dismissing a notification does not complete a
  task. Delivery errors and retry exhaustion remain visible in task details.

The application must stay open and the computer awake. Startup and bounded
wall-clock checks reconcile missed work. There is no independent daemon, device
wake, mobile delivery or new access to email/chat/contact services. Gregorian
daily/weekly/monthly/yearly fixed reminders are described in
[calendar schedules](calendar-schedules.md). General cron, lunar/holiday rules,
automatic after-human-turn planning and extra notification channels are not
implemented.

## Agent authorization and tools

`agentTaskTools` defaults to `false`. The task center exposes the explicit opt-in;
the backend checks it again on tool calls and before Agent dispatch. Start or
reopen the execution conversation after enabling it. If its live binding never
received the task server, the task is blocked with a visible explanation.

`atlas_tasks` is mounted at `/tasks` on the existing authenticated loopback MCP
listener, independently of shared memory. All offered services share the same
session token. Unbound tokens and mismatched thread/Agent/directory bindings are
rejected. Task tools cannot accept caller-selected execution directories or
cross-conversation ownership:

The [personal assistant](personal-assistant.md) is a deliberate scoped exception:
backend-created personal sessions may manage fixed reminders sourced from other
personal sessions in the same profile. They cannot acquire project reminders or
another session's Agent checks, choose scope via tool arguments, or rewrite the
original source. Personal mutations require an admitted human turn. Ordinary
project conversations retain their existing ownership rules. Suggestions use
inert, versioned personal proposal cards; a UI confirmation registers them using
an idempotent scheduler request. No application-data block is a human source.

| Tool | Contract |
| --- | --- |
| `tasks_inspect` | Read tasks linked to the trusted caller conversation |
| `tasks_upsert` | Persist an explicitly requested task; use a stable idempotency key and expected revision for edits |
| `tasks_cancel` | Cancel a task owned by this conversation, with its inspected revision |
| `tasks_report_run` | Stage the current admitted scheduled run's structured report |
| `tasks_calendar_preview` | Validate calendar rules and preview future/frozen periods without activation |
| `tasks_occurrences` | Page periods belonging to an owned task |
| `tasks_control_occurrence` | Complete, skip or snooze one period with task/period revisions |

Scheduled turns can inspect/report but cannot create, edit or cancel tasks.
Reports choose exactly one of `done`, `waitingInput` or a `nextCheckAt` at least
30 seconds in the future, and explicitly choose whether to notify. A tool receipt
is required before claiming registration. An Agent's final prose is not parsed
as a substitute for a report.

The scheduler does not sandbox every tool inside a vendor CLI. Background checks
retain the user's accepted CLI permissions; existing permission requests remain
interactive. Task creation does not grant new tool authority.

## Conversation and task lifecycle

Source references, execution bindings and task lifecycle are separate. Archiving
or opening a conversation does not pause/resume tasks, alter revisions or cancel
running checks. Background restore preserves the archive flag. Persisted run
activity and live turn ownership keep project discovery and transcript watchers
from reviving a conversation solely because a scheduled turn wrote to it.

Deleting only a source conversation does not cancel an independent reminder.
Deleting a required execution context blocks future Agent checks until an
explicit rebind. A conversation currently reserved by a scheduled turn cannot be
deleted until that turn is explicitly stopped. Task-owned content remains in the
task database; deleting a source conversation does not erase that independent
record.

## Execution and recovery

Human and scheduled sends share `TurnAdmissions`. A reservation covers input
recording, asynchronous dispatch and the full prompt. The manager's
`send_if_idle` checks thread state under the same lock as `begin_turn` and never
supersedes a running turn. Busy scheduled work is deferred without consuming its
model budget. Two Agent checks may run globally, with at most one per session;
fixed reminders do not consume Agent slots.

Claiming work and settling a result are separate transactions. The latter checks
task revision, run and session identity, and commits progress, the next check and
notification intent together only after the prompt actually ends successfully.
Refusal, cancellation, timeout or a missing report cannot publish a success
notification. Manual task changes fence stale results but do not undo tools that
already ran.

Before dispatch, known external CLI activity is probed without rearming the open
project's watcher. This remains an observational guard, not a lock on unrelated
CLI processes.

On restart, undispatched claims are reclaimed. Dispatched runs become unknown and
blocked, with an attention record; their prompts are never blindly replayed.
Outbox submission has stable tags, bounded retries, notification preference checks
and a final task-state check serialized with submission. OS acceptance is not
proof of device receipt, reading or business completion. A crash between OS
submission and acknowledgement can still cause a recognizable duplicate where
the platform cannot replace by tag.

Scheduled deltas carry `task_run_id`. Application transcripts persist durable
message/run IDs; checkpoint prompts use a system role and `scheduled:<run-id>`
identity. Scheduled input does not update `interacted_at`, feed automatic memory
ingestion as a human fact, or act as a Browser Use handoff authorization. Ordinary
Agent completion banners are suppressed for scheduled turns; the scheduler owns
their outcome delivery, while real permission requests remain visible.

## Development verification

The personal assistant's approved automatic registration policy is documented in
[Personal assistant](personal-assistant.md#registering-reminders-from-conversation).
Its own clear future obligations use the standard scheduler and Task Center;
memory entries or vendor-local memory files are not task registrations. The
personal/task MCP tool lists carry required cache metadata and have a real Claude
SDK discovery regression, separately from persistence and native delivery checks.

Run frontend typechecks, lint, task-center and notification tests, then the Vite
build. Run Rust scheduler, task MCP, turn admission, background restore,
transcript, configuration, manager admission/steering, wire and checkpoint tests.
Use real temporary SQLite databases for persistence/recovery assertions.

On Windows, the existing test-runner Common Controls issue may prevent the Rust
app test executable from starting. A test-only copy with an embedded v6 Common
Controls manifest can run the suites; do not change the application to hide this
environment limitation. Mock ACP tests do not establish a successful vendor
login, billed model turn, real history restore, permission interaction or native
desktop banner. Verify those separately in `bun run dev:app`.

## Verification record (2026-10-15)

- Frontend: typechecks, lint and production build passed. The focused task,
  notification, settings and chat-delta run passed 286 tests across 22 files.
- Rust app: `cargo check --locked -p atlas --lib` and test compilation passed.
  The manifest-equipped test copy passed 84 tests across scheduler (10), task
  tools (2), admission (1), archive restore (1), reserved submission (1),
  transcripts (18) and configuration (51).
- Related crates: manager admission/steering passed 4 tests, wire contracts passed
  8, and checkpoint capture passed 12. One pre-existing wire documentation check
  remains ignored because its referenced document is absent.
- The app test run excluded the previously documented Windows
  `an_absolute_xdg_config_home_wins` case. The original test executable still has
  the environment's Common Controls loading limitation; only its validation copy
  received the test manifest.
- Not exercised: real vendor login/model turns, actual desktop notification
  receipt, native window interaction, mobile delivery or app-exited scheduling.
  No real reminders or vendor-billed Agent turns were created for these checks.
