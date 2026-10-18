# Personal assistant

The project-independent Personal Assistant entry owns one personal space per
application data profile. It reuses installed ACP CLIs and their vendor login,
the existing conversation transcript, and the durable task scheduler.
It is one fixed chat window, without a new-conversation action or a history
selector. Opening it reads application-owned text history without connecting a
vendor. Unsent drafts survive hiding and reopening the window.
The entry renders the existing Agents `ChatPanel`, including its composer, model
picker, permissions, elicitation, streaming and tool/detail views. The personal
controller supplies its scoped connection/send lifecycle and combined history;
it does not build a second chat UI. The fixed header hides new/history actions.
Memory and plans are in a drawer that starts closed, with Task Center always
accessible from the header. Personal vendor switches stay in this tab and do not
handoff raw history to another vendor or create a project chat.
The selected model and permission mode are applied before exposing a binding.
A failed permission restore holds the first message with its attachments until
the user resolves the mode. Send errors retain text drafts and hold the queue,
including after reopening the tab. Normal running turns cannot rotate the queue.
The shared running queue remains text-only; staged images stay in the composer.
After a failed dispatched turn, text is restored but image/mention chips are not
restaged, and retrying can show a second user bubble.

The dedicated working directory is not a sandbox. Messages and explicitly
provided personal context reach the selected vendor. CLI permissions and global
configuration still apply. Project conversations receive no personal context or
personal tool authorization.

Personal session purpose is assigned by the backend at creation. It cannot be
retroactively granted to a project thread. Personal fixed reminders can be managed
across authorized personal sessions without rewriting their original source.
Agent checks retain their existing execution/session boundary.

The foreground Agent is instructed on every human send to learn clearly asserted,
stable facts and preferences from new human input without requiring a "remember"
phrase. This is best effort: HTTP MCP availability and instructions do not prove
that extraction ran or found every useful fact. No receipt means no saved claim;
no tool call is not an extraction-completion signal. Without personal MCP, the
manual editor and per-human-message save action remain available. This feature
adds no separate extractor, API gateway, background memory writer or regex facts.

Automatic writes require an admitted active human source, an exact evidence quote
from its raw input, schema/size validation and optimistic revisions. Application
context and assistant output are not human sources. Evidence proves traceability,
not semantic truth: quotations, hypotheses, inference, secrets and temporary paid
status must not become active personal facts. `confirmed=true` means a clear
assertion, not independently verified truth or proof of a manual click. Current
origin, quote, revision and save time are visible; no separate version archive or
undo engine is introduced. Same-value restatement refreshes the source/time without
incrementing the semantic revision. Stable keys and inspection assist semantic
deduplication; aliases are not guaranteed to match perfectly.

Uncertain changes are stored as separate inert memory candidates. The trusted UI
confirms a specific candidate ID/revision by reading its stored payload and checking
the original durable source, quote, target revision and deletion barrier inside the
transaction. It does not require the original turn to remain active. Outstanding
questions must be resolved in chat or through the manual editor before saving;
"confirm" cannot guess which person was meant. A model cannot promote the same
source's pending candidate by merely switching its `confirmed` field. A new clear
human assertion may learn the fact with new evidence. Stale candidate edits and
confirmations fail visibly. At most one targeted clarification per turn is requested.

Memory changes never create or change reminders. Temporary completion belongs to
the scheduler's period record. Existing related reminders remain accessible in the
same panel/task center for explicit editing. Scheduled turns cannot write personal
memory or plans. Already admitted writes may finish after cancellation; actual
committed results stay visible rather than silently rolling back. Memory and task
receipts remain independent.

## Reading on each send

The application provides durable memory even if the model does not call a read
tool. Deterministic selection uses the current and up to two recent raw human
messages in the same backend thread, capped to 512 characters each. It chooses up
to five core records, up to three relevant corrected records and up to ten other
relevant records, deduplicated at the current revision. Exact keys, ASCII words and
CJK bigrams provide simple relevance; time and stable ID break ties. This is not
semantic search or a guarantee that every relevant fact was found.

The serialized memory pack, including metadata and omitted references, is at most
4,000 Unicode characters. This is a character budget, not an exact token count.
Core records come first, then relevant corrections and other matches. Content
previews are marked truncated; selected entries that do not fit remain listed by
ID and abbreviated key. `total` can exceed `selected`. `personal_context` accepts
query/IDs and bounded pages to expand records; explicit IDs override the query.
The Agent must expand incomplete records before precise claims, and use the manual
panel if an entry exceeds the tool expansion budget. Pinning a sixth core record
fails with an actionable error; it never silently unpins an existing constraint.
Only the manual editor can unpin an existing core entry; automatic updates that
omit the core field preserve it. Editing a candidate preserves the current pin
unless the user explicitly changes it.

Only asserted records enter this pack; candidates and legacy unverified records
are excluded. Core/relevant memory remains the primary continuity source after a
CLI restart. Current explicit human corrections can update memory; old summaries
and transcripts do not override its current version. Task state stays authoritative
in the scheduler. Plans/candidate summaries have separate count bounds outside this
memory-only budget. Repeated context still consumes vendor input/context; no
incremental-context or compaction guarantee is implied.

## Forgetting and compatible storage

Schema version 1 adds a source admission clock, separate candidates, and hashed
key deletion barriers. Existing facts/IDs/JSON are preserved with defaults for
origin/evidence/core. Deletion, manual key rename and explicit re-learning stamp
affected keys atomically. Rename blocks the old key, validates the destination,
stamps both and clears stale candidates. An old source cannot write after a
delete/relearn cycle. Unrelated existing-key updates are not invalidated. Unknown
automatic keys from an in-flight source older than a barrier change are deferred
with a visible error, preventing stale alias creation; retry needs a new human
message or a manual save. This conservative check can also defer unrelated new
facts during that turn; it never claims they were saved.

Forget logically removes the current entry and same-key candidate value copies,
retaining a hashed barrier without the forgotten value. It is not secure disk
erasure. Raw human sources, chat history, previous vendor context, independent
reminders and vendor records are separate and retained. Re-learning requires the
trusted manual form's explicit confirmation with current content; the model cannot
set that flag. Re-learning creates a new entry and keeps the old-source barrier,
rather than restoring deleted content. Arbitrary semantic rewrites are not perfectly
suppressed. No new audit/value-history store retains extra deleted copies.

## Registering reminders from conversation

The user's approved defaults authorize the Agent to register the user's own clearly
asserted future obligations, including schedule statements without a separate
"remind me" phrase. An explicit deadline time defaults to a reminder 30 minutes
earlier; a date-only obligation defaults to 09:00 on that date. Every personal send
provides the computer's current IANA timezone, validated by the backend; creation
snapshots it into the calendar, and explicit user overrides take precedence.
For a weekly Thursday 12:00 obligation this means Thursday 11:30. A Thursday
00:15 obligation means Wednesday 23:45; preview the shifted reminder calendar.
Unknown dates/people, short-month policies and other material ambiguity still
require clarification. Hypotheses, quoted text and opt-outs are not authorization.
If the calculated default time has already passed, skip that reminder and explicitly
tell the user. Do not substitute an immediate notification or move it to the deadline.
Recurring tasks keep the next normal future slot; a one-off without a future reminder
is skipped rather than falsely reported as scheduled. Explicit user overrides win.

The Agent must inspect existing tasks to avoid duplicates, preview recurring rules
and use `tasks_upsert`. Memory storage and reminder registration are independent
tool calls; changing a memory in its editor alone never changes reminders. Once
persisted, the reminder is visible in Task Center. Database snapshot changes also
produce a chat receipt that opens the exact task; model prose is never a receipt.
Missing tools or failed registration must be reported rather than called scheduled.

Unrequested suggestions still use persistent, versioned proposal cards that need
UI confirmation. These suggestions are distinct from the auto-registration policy
for a user's own clear obligation. An ambiguous target must be clarified rather
than defaulting to the latest proposal.

Connect on send, reusing the live execution context or restoring the selected
Agent's previous context through its negotiated load/resume capability. If neither
capability is supported, create a new internal execution context and explain that
the model has not read the old chat. Authentication, network and restore failures
remain errors with a retryable draft; they never erase history or silently create
a replacement. The application retains references to earlier text transcripts
even when a resumed Agent changes its session ID. Saved facts and plans are
independent of these execution contexts. Showing old messages does not imply the
model has received them.

First-send registration resolves the recorder's live session-to-thread binding.
A newly connected conversation is still a draft, so its ACP session ID is not yet
persisted in thread metadata. Looking up only the persisted session ID would reject
the first message before it could be sent. This lookup neither sends a message nor
changes the normal draft lifecycle.

No generated handoff summary, automatic cross-vendor history sharing, historical
batch extraction, daemon, mobile delivery or new data source integration is included.
Deleting saved memory does not delete historical messages, existing model context,
independent tasks or vendor records.

## Verification

Personal and task MCP `tools/list` responses include `ttlMs` and private
`cacheScope`, matching the existing memory/browser services. Without these fields,
Claude SDK can report a connected service with zero tools. The ignored
`claude_discovers_personal_and_task_tools` regression uses the production lists,
real loopback HTTP and an installed Claude Agent SDK control handshake; it checks
all four personal and seven task tools without a model turn or user-profile writes.
Set `ATLAS_CLAUDE_SDK_DIR` to run it. Transport discovery, model tool execution,
SQLite persistence, UI rendering and native delivery remain separate checks.
The separately ignored `claude_registers_a_default_weekly_reminder_in_temporary_sqlite`
test uses a real model turn, production task schemas/calendar/store and an isolated
MCP fixture. It verifies a Thursday 11:30 reminder and reopens temporary SQLite to
check the same task ID. It also exercises an expired weekly default (skip this
slot, retain next week's reminder, notify the user) and an expired one-off
(notify without creating a scheduled task). Its fixed fixture scope does not validate production
AppHandle/foreground authorization or native delivery; those have separate checks.
The `personal-assistant` browser mock scenario checks shared chat composition and
Task Center presentation with fictional data; it does not prove a live vendor turn.

Use temporary SQLite for compatibility, source/quote checks, candidate confirmation,
rename/delete/relearn races across connections, unrelated-key updates, core limits
and deterministic recall budgets. UI tests cover no silent re-learning, unresolved
questions, source-message prefill, real receipts and failure. Fictional labeled
`src-tauri/src/personal/semantic-cases.json` can be evaluated by real vendor CLIs
with tools disabled in a neutral temporary directory. Semantic classification checks
do not prove live ACP/MCP delivery or native notification receipt; those need separate
desktop verification. Never write test facts or reminders into a user's profile.
