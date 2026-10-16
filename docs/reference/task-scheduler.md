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
- Fixed reminders send their registered content without invoking a model.
  Delivery leaves the business item waiting for user confirmation.
- Agent checks reuse the bound installed CLI, directory and conversation. They
  need a negotiated HTTP MCP connection and a valid task-server offer.
- Optional per-task quiet hours defer native notification submission from 22:00
  to 08:00 in the computer's current timezone. Task execution itself can continue.
- Native notification clicks open task details. The in-app notification center
  mirrors durable IDs; reading or dismissing a notification does not complete a
  task. Delivery errors and retry exhaustion remain visible in task details.

The application must stay open and the computer awake. Startup and bounded
wall-clock checks reconcile missed work. There is no independent daemon, device
wake, mobile delivery or new access to email/chat/contact services. General cron,
monthly/yearly/lunar calendars, automatic after-human-turn planning and extra
notification channels are not implemented in this slice.

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

| Tool | Contract |
| --- | --- |
| `tasks_inspect` | Read tasks linked to the trusted caller conversation |
| `tasks_upsert` | Persist an explicitly requested task; use a stable idempotency key and expected revision for edits |
| `tasks_cancel` | Cancel a task owned by this conversation, with its inspected revision |
| `tasks_report_run` | Stage the current admitted scheduled run's structured report |

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
