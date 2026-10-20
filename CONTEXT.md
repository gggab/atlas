# 同桌 DeskMate — Context

**同桌 DeskMate** is this fork's product display name; **同桌 DeskMate Dev** is its separate
source-build profile. Existing `atlas` package, command and storage names remain
compatibility identifiers. The companion extension is **DeskMate Browser**; store listings update only after review. See [Branding](docs/reference/branding.md).

Glossary of domain terms as this project uses them. Decisions with lasting consequences live in `docs/adr/`.

## Session history domain

- **Thread** — one conversation as DeskMate tracks it, keyed by an app-minted thread id. A thread exists independently of any agent process.
- **Draft** — a thread before its first sent message. Its ACP session id is never recorded, because the session is re-created whenever the chat is reopened and the id would be stale. A draft is visible while its chat is open and is removed when the chat closes unsent, so abandoned chats leave no history. *(Divergence from Zed, and from this ADR's original wording "drafts never create agent sessions": DeskMate's chat panel opens an agent session when the tab mounts, so a draft usually does have a live session — just not a recorded one. Making that lazy is a chat-panel change, not a history one.)*
- **Session** — the agent-side conversation, identified by an ACP session id. A thread references at most one session.
- **Thread-metadata store** — the app-level SQLite store that is the *only* source for the session sidebar and history. Holds metadata only (ids, agent, titles, timestamps, worktree paths, archived flag) — never transcript content. See ADR-0001.
- **Recorded branch** — the last Git branch observed for a thread's own working directory at bind or turn start. Older/imported rows remain unknown; the current project checkout is never used to guess past branches. Catalog compatibility and backups are described in `docs/reference/history-migrations.md`.
- **Archive** — a first-class thread state: out of the active sidebar, kept in history. Opening an archived thread unarchives it; qualifying observed external activity inside the 7-day window can also do so. Scheduled background activity preserves archive state. Registered tasks keep their independent lifecycle. Manually imported and backfilled threads land archived.
- **Live thread feed** — the path that keeps a thread's store row current from the running conversation's own events (`ThreadRecorder`). The only writer besides import and project sync. Distinct from the *capture recorder* (`atlas-checkpoint`), which records the transcript and the usage.
- **Import** — the user-initiated (manual) pull of an agent's sessions into the store via ACP `session/list`; metadata only; capability-gated; deduped by session id. Imported rows land archived.
- **Project sync / discovery** — the ongoing, automatic counterpart of import, scoped to the open project: `session/list` from the agents DeskMate already has history with, plus an on-disk provider (a watcher on Claude's transcript directory) that learns a session exists and when it was last active. Metadata only — it never reads message content; replay and resume still go through the agent. Rows active in the last 7 days land unarchived; a deleted session is never brought back. Attribution is by the agent's own `session/list`, never by agent id. See ADR-0001, *Discovery*.
- **Backfill** — the one-time automatic import pass per installed agent on first launch after the history model shipped.
- **Resume** — turning a history row into a live session through the protocol: `session/load` (replays transcript) or `session/resume` (no replay, user notified), selected by advertised capability.
- **Live elsewhere** — a session whose transcript was written in the last ~90s by something other than DeskMate's own turn (none in flight, and the write not within 5s of one ending). Having the session open in DeskMate does not count. DeskMate must not silently fork it: every send is held behind an explicit confirmation, and it cannot be deleted. See ADR-0001, *Liveness*.
- **Capability gating** — every per-agent behavior is decided by the capabilities the agent advertised at `initialize`; agent-identity checks are forbidden. ("No ACP agent gets special treatment.")
- **DeskMate-recorded usage** — the token totals DeskMate's capture recorder wrote for a session (`atlas-checkpoint`), priced from the models.dev map DeskMate caches. The only source for the usage widget and the Usage tab; covers sessions run through DeskMate and no others.
- **Turn / message** — a *turn* is one prompt and the answer to it; a *message* is one user or assistant row within it. Usage surfaces count messages, because that is what DeskMate records per session.
- **Scrape readers** *(deleted)* — the per-agent readers of CLI private storage that used to build session history: Claude's `~/.claude/projects` JSONL, Kilo's SQLite, Codex's state DB, the Claude-directory watcher, and the JSONL replay behind the fast transcript paint. Content scrape readers remain removed. The metadata-only Claude directory watcher is now allowed for discovery under ADR-0001; it never replays messages. Reads of those directories that deliberately remain, none of them session history:
  - the **checkpoint importer**, whose contract is preserved verbatim;
  - the **memory corpus** and **skills** surfaces, which read instruction files (`CLAUDE.md`, `AGENTS.md`, skills, per-project memory notes) as documents;
  - the Memory panel's **Codex thread list**, which still queries `~/.codex/state_*.sqlite`. This one is a genuine exception rather than a category difference — it is a session list, read from another program's database, rendered as UI. It survived the history port because it belongs to the Memory panel rather than to the ACP stack. Flagged, not endorsed.

## Adjacent subsystems

- **Independent backend** — an opt-in Windows/macOS user-session process owning
  live Agent sessions, scheduler/personal storage, MCP and approvals after GUI
  exit. Closing its client does not cancel work; explicit disable stops it.
  Sleep, logout and power-off do not execute work. See
  [background execution](docs/reference/background-service.md).
- **Scheduled task** — a durable reminder or bounded Agent check, independent of
  conversation visibility. Source references trace the request; an execution
  binding selects the authorized conversation/Agent/cwd. Archive does not pause
  it. Explicit task controls and completion conditions own its lifetime.
- **Task re-enable** — an explicit UI action reopening the same completed or
  cancelled task, preserving its ID/history and cumulative execution usage.
  Old reminder slots remain suppressed. Deletion removes scheduler content and
  leaves only an ID and hashed creation-key barrier against stale retries.
- **Scheduled run** — one claimed execution, keyed by a durable run ID; distinct
  from its task, ACP session and notification. Success requires a matching
  successful terminal result and a valid structured report for Agent checks.
- **Notification outbox** — Rust-owned delivery intent committed with task
  progress. OS acceptance, reading and business completion remain separate.
- **Calendar period** — one nominal daily/weekly/monthly/yearly occurrence with
  independent completion and revision. Its identity survives schedule edits and
  skipped dates. A reminder slot is a notification opportunity, not a bill.
- **Calendar draft** — unresolved structured rules awaiting clarification;
  `needs_confirmation` never enters the execution queue.

- **Project** — a local folder opened in DeskMate and shown in the sidebar. The unit almost everything else is scoped to: the editor state, the file index, the git watcher, the knowledge base, the capture store. *Avoid: workspace.* The stored names still say `workspace` — `state.json`'s `workspaces` / `activeWorkspaceId`, the `workspace_id` columns in `sessions.db`, the `workspaceId` argument of the fileindex / recent-files / git-watch / mention commands and the events that carry it, the `"workspace"` mention tag, and the `workspace.*` keybinding action ids. Those are **storage keys**, not the concept: renaming one is a data migration that breaks existing installs, not a rename. Every such site carries a comment saying so.
- **Historical native session** — an old record carrying the `atlas-agent` storage key. Its transcript and checkpoints remain readable; its removed engine cannot be resumed.
- **Timeline / checkpoint** — the per-project observational record (`atlas-checkpoint`). Separate from the thread-metadata store; its importer may read CLIs' transcript files under its own contract, which the history model explicitly preserves.
- **Marketplace / registry** — where agents are installed from; the installed-agents map is what import enumerates.
- **Installed-agents map** — the one record of which ACP agents exist. Installing writes an entry, uninstalling removes it, and nothing else makes an agent runnable. A fresh install has an empty map and asks the user to install an external agent. See ADR-0002.
- **Detection** — an agent found on the user's `PATH` that DeskMate has *not* installed. An offer, never a spawn candidate: **accepting a detection** is a user action that writes an installed-agents-map entry pointing at their own binary, downloading nothing. Finding a binary installs nothing by itself.

## Shared memory domain

**Shared memory** is the one record every agent on a project reads and writes, across external ACP agents, so that a second agent inherits what the first learned. It is DeskMate-owned; no agent's private store is shared memory. It holds exactly six kinds of entry (decided 2026-09-17):

- **Active plan** — the agent's own structured plan list. One per project; a newer plan replaces the older one, and a plan that is done or abandoned clears it.
- **Decision** — a choice made and why. Keyed; a newer decision with the same key replaces the older one. Shown capped; never evicted.
- **File changed** — one entry per path with a summary of what was done. A repeat edit to the same path replaces the earlier entry. Shown capped; never evicted.
- **Fact** — a durable project fact or convention. Shown capped; never evicted.
- **Failure** — a dead end or anti-pattern, kept so a second agent does not repeat it. Shown capped; never evicted.
- **Architecture** — a structural note about how the system fits together. Shown capped; never evicted.

The six kinds have two lifetimes. **Working memory** is Active plan and File changed: it describes the current stretch of work, replaces by key, is always shown to an agent fresh, and never ages or travels beyond the project. **Durable memory** is Decision, Fact, Failure and Architecture: it accumulates, stays true across sessions, is what agents search, and is what can be promoted beyond one project. Both are shared memory.

**Scope** of shared memory is the repository: every worktree and every subdirectory launch of one repository shares one memory. Outside a repository the scope is the directory the agent was started in.

Shared memory also records **session lifecycle** (session start and end, todo added and done, and which agent owns each session). Lifecycle is bookkeeping for the record, never something an agent is shown.

Terms that are *not* shared memory: **capture** (raw transcripts, see Timeline), **knowledge notes** (user-written pages in the Knowledge panel), the **codebase index** (derived from source), and any agent's own memory files (`CLAUDE.md`, `AGENTS.md`, Claude's auto-memory directory). These may be *sources* shared memory cites or imports, but an entry in them is not an entry in shared memory.

Shared memory reaches an agent one way only: it **pulls** it through the **memory tool server**, the in-process MCP server DeskMate hands every session that can take it (ADR-0010). Nothing is prepended to a user's message; the text goes to the agent exactly as typed. The server's **instructions** are the protocol — read first, write as you learn — and its tools are, in that order: **`memory_briefing`** (the first look of a session: working memory, the **durable index**, the **curated pack** and the **recent-session handoff**), **`memory_changes`** (what *other* sessions recorded since this session's **last look**), **`memory_search`** (the record plus the codebase index's documents), **`memory_get`**, **`memory_list`**, **`memory_remember`** and **`memory_forget`**.

- The **durable index** is one capped line per durable entry, each kind's best up to its display cap, ranked by recency (two-week half-life), use count and confidence; `memory_get` expands a line. It lists shared-memory entries; it is not the codebase index, and not the retrieval index `memory_search` also searches.
- The **curated pack** is the high-signal part of the project's foreign memory files (Claude's memory directory, `CLAUDE.md`, `AGENTS.md`), recency-ranked and budget-bounded. The **recent-session handoff** is the tail of the most recent other session in the scope, whichever agent ran it, read from capture (or, where capture was never enabled, from DeskMate's own session transcripts) — never from an agent's own files.
- A session's **last look** is the newest write it has seen, set by its briefing or its last changes call and forgotten when the session ends. It belongs to the session, not to the send path.

The **injected-context envelope** — `<atlas-memory>` … `</atlas-memory>` — is what DeskMate *used to* prepend. Every DeskMate reader still strips it (`atlas_agent_transcript::strip_injected_context`): the Claude memory directory, capture transcripts, the session handoff, the chat's echoed prompts. Files written while DeskMate pushed still carry it, and the loop it once caused (an agent saved DeskMate's block into its own memory file and DeskMate read the copy back in as a new fact) must stay closed.

## External Agent ownership

**Personal assistant** is a global entry, independent of a work project. Its
profile-local personal space is separate from repository shared memory. Session
purpose is assigned by the backend at creation; a project conversation cannot be
promoted by an MCP argument. Personal fixed reminders share this space while
preserving their source conversation; Agent checks keep their execution boundary.
Human sends in this entry include a bounded `PERSONAL ASSISTANT DATA` block as
separate ACP content. Readers recognize it as application data, not human prose;
personal writes require a separately recorded human source and admitted turn.
This is an explicit exception to project shared memory's pull-only behavior.
The foreground Agent is instructed to learn new clear human assertions through
personal MCP with exact raw-source evidence and revisions; this is best effort,
not guaranteed extraction. Application-managed recall provides bounded core and
relevant active memory on sends. Inert candidates, hashed forgetting barriers and
trusted UI confirmation remain distinct from task registration. It adds no
background extractor, model-generated summary or session rotation.

**Browser automation session** is one ACP session's persistent JS REPL and
explicitly shared daily Chrome/Edge tabs, connected through DeskMate Browser.
Browser login remains in the user's browser. Settings > Browser control owns
installation guidance, browser choice and persistent global pause. A profile-specific
extension connects to DeskMate/DeskMate Dev automatically. Native Messaging privately
bootstraps each task relay, separately from CLI/MCP
credentials. Tasks use grouped Agent-created tabs. Completion, stop/pause and
session end close owned pages except required handoffs, release debugging and
remove empty groups. Existing user tabs never close. The app connection persists.

Installed ACP CLI processes own vendor login and model selection. DeskMate owns local projects, approvals, transcripts, recording and shared memory. No DeskMate account, official model gateway, organization service or built-in Agent is available. The literal `atlas-agent` is retained only for reading historical records. Local MCP bearer tokens authorize a session to the memory service and are unrelated to account authentication.

## Theming

- **Theme** — one named, shareable description of how DeskMate looks, covering the whole app: chrome, editor, terminal, diffs and syntax. Holds a dark and/or light **variant**. There is exactly one active theme; there is no separate editor theme. *Avoid*: interface theme, editor theme, colour scheme.
- **Variant** — the dark or light half of a theme. A theme may ship only one.
- **Base tokens** — the required colours of a variant, named exactly as shadcn/ui names them, so any shadcn or tweakcn theme is a valid set of base tokens. *Avoid*: shadcn tokens.
- **Palette** — an optional small set of named hues (red, orange, yellow, green, cyan, blue, purple, pink) in a variant, from which syntax, terminal and status colours are derived when not set explicitly.
- **Theme keys** — optional, DeskMate-specific colours in a variant, named by role in Zed's dotted style (`element.hover`, `terminal.ansi.red`, `syntax.keyword`). Any key a theme omits is derived from the palette, then the base tokens, then DeskMate's defaults.
- **Theme override** — a user's settings-level patch of keys on top of the active theme. Changes that user's DeskMate only; it is not a theme.
- **Theme import** — a one-time conversion of a shadcn/tweakcn, Zed or VS Code theme into an DeskMate theme. The result is an ordinary DeskMate theme; the source is not read again.
- **Icon theme** — a named mapping from files and folders (by name, extension or language) to icons, in VS Code's icon-theme format so VS Code icon themes can be used as-is. Chosen independently of the colour theme. *Avoid*: file icon pack, icon set.
- **Derived variable** — a colour DeskMate computes from a key or a base token and no theme may set, because it is a function rather than a judgement (a status badge's fill is its status foreground at 12%). Written to `:root` like a key, absent from the schema, so writing one in a theme file is an unknown-key warning. *Avoid*: computed key, implicit key.
- **Appearance** — which of the two a variant is, `dark` or `light`. The user's `themeMode` (`system` / `dark` / `light`) is what they asked for; the appearance is what it resolved to, and a theme with only the other variant resolves to that one. *Avoid*: mode, when the resolved answer is meant.
- **Scale** — a named, finite ladder of non-colour values: type, control heights, radius, elevation, z-index layers, motion durations, icon sizes. A scale step is named, never measured (`text-xs`, not `text-[11px]`). Scales are app-owned; a theme sets `radius`, the fonts, `tracking-normal` and the shadow ramp, and nothing else on this side. Reference: `docs/reference/design-system.md`. *Avoid*: token, for a non-colour value.

## ACP delegated work and local MCP transport

A subagent is observed delegated work reported through actual ACP tool calls and metadata, not a new DeskMate execution engine or a promise of control support. Its launch ID, parent attribution, lifecycle and available transcript feed the chat rows and overview. Unknown formats remain ordinary tool calls.

External ACP sessions receive local tools through the mandatory stdio transport. The DeskMate executable forwards each JSON-RPC message to the session-authorized loopback HTTP service and reads its credential from a private token file. Adapter arguments and environment carry no bearer token. See ADR-0020 and [selective ports](docs/reference/upstream-0.4.1-ports.md).
