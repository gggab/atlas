# Atlas改 — Context

**Atlas改** is this fork's product display name; **Atlas改 Dev** is its separate
source-build profile. Existing `atlas` package, command and storage names remain
compatibility identifiers. The browser store extension is still **Atlas Browser**.

Glossary of domain terms as this project uses them. Decisions with lasting consequences live in `docs/adr/`.

## Session history domain

- **Thread** — one conversation as Atlas tracks it, keyed by an app-minted thread id. A thread exists independently of any agent process.
- **Draft** — a thread before its first sent message. Its ACP session id is never recorded, because the session is re-created whenever the chat is reopened and the id would be stale. A draft is visible while its chat is open and is removed when the chat closes unsent, so abandoned chats leave no history. *(Divergence from Zed, and from this ADR's original wording "drafts never create agent sessions": Atlas's chat panel opens an agent session when the tab mounts, so a draft usually does have a live session — just not a recorded one. Making that lazy is a chat-panel change, not a history one.)*
- **Session** — the agent-side conversation, identified by an ACP session id. A thread references at most one session.
- **Thread-metadata store** — the app-level SQLite store that is the *only* source for the session sidebar and history. Holds metadata only (ids, agent, titles, timestamps, worktree paths, archived flag) — never transcript content. See ADR-0001.
- **Archive** — a first-class thread state: out of the active sidebar, kept in history. Opening an archived thread unarchives it. Imported threads land archived.
- **Live thread feed** — the path that keeps a thread's store row current from the running conversation's own events (`ThreadRecorder`). The only writer besides import. Distinct from the *capture recorder* (`atlas-checkpoint`), which records the transcript and the usage.
- **Import** — user-initiated pull of an agent's sessions into the store via ACP `session/list`; metadata only; capability-gated; deduped by session id.
- **Backfill** — the one-time automatic import pass per installed agent on first launch after the history model shipped.
- **Resume** — turning a history row into a live session through the protocol: `session/load` (replays transcript) or `session/resume` (no replay, user notified), selected by advertised capability.
- **Capability gating** — every per-agent behavior is decided by the capabilities the agent advertised at `initialize`; agent-identity checks are forbidden. ("No ACP agent gets special treatment.")
- **Atlas-recorded usage** — the token totals Atlas's capture recorder wrote for a session (`atlas-checkpoint`), priced from the models.dev map Atlas caches. The only source for the usage widget and the Usage tab; covers sessions run through Atlas and no others.
- **Turn / message** — a *turn* is one prompt and the answer to it; a *message* is one user or assistant row within it. Usage surfaces count messages, because that is what Atlas records per session.
- **Scrape readers** *(deleted)* — the per-agent readers of CLI private storage that used to build session history: Claude's `~/.claude/projects` JSONL, Kilo's SQLite, Codex's state DB, the Claude-directory watcher, and the JSONL replay behind the fast transcript paint. All gone; do not reintroduce. Reads of those directories that deliberately remain, none of them session history:
  - the **checkpoint importer**, whose contract is preserved verbatim;
  - the **memory corpus** and **skills** surfaces, which read instruction files (`CLAUDE.md`, `AGENTS.md`, skills, per-project memory notes) as documents;
  - the Memory panel's **Codex thread list**, which still queries `~/.codex/state_*.sqlite`. This one is a genuine exception rather than a category difference — it is a session list, read from another program's database, rendered as UI. It survived the history port because it belongs to the Memory panel rather than to the ACP stack. Flagged, not endorsed.

## Adjacent subsystems

- **Project** — a local folder opened in Atlas and shown in the sidebar. The unit almost everything else is scoped to: the editor state, the file index, the git watcher, the knowledge base, the capture store. *Avoid: workspace.* The stored names still say `workspace` — `state.json`'s `workspaces` / `activeWorkspaceId`, the `workspace_id` columns in `sessions.db`, the `workspaceId` argument of the fileindex / recent-files / git-watch / mention commands and the events that carry it, the `"workspace"` mention tag, and the `workspace.*` keybinding action ids. Those are **storage keys**, not the concept: renaming one is a data migration that breaks existing installs, not a rename. Every such site carries a comment saying so.
- **Historical native session** — an old record carrying the `atlas-agent` storage key. Its transcript and checkpoints remain readable; its removed engine cannot be resumed.
- **Timeline / checkpoint** — the per-project observational record (`atlas-checkpoint`). Separate from the thread-metadata store; its importer may read CLIs' transcript files under its own contract, which the history model explicitly preserves.
- **Marketplace / registry** — where agents are installed from; the installed-agents map is what import enumerates.
- **Installed-agents map** — the one record of which ACP agents exist. Installing writes an entry, uninstalling removes it, and nothing else makes an agent runnable. A fresh install has an empty map and asks the user to install an external agent. See ADR-0002.
- **Detection** — an agent found on the user's `PATH` that Atlas has *not* installed. An offer, never a spawn candidate: **accepting a detection** is a user action that writes an installed-agents-map entry pointing at their own binary, downloading nothing. Finding a binary installs nothing by itself.

## Shared memory domain

**Shared memory** is the one record every agent on a project reads and writes, across external ACP agents, so that a second agent inherits what the first learned. It is Atlas-owned; no agent's private store is shared memory. It holds exactly six kinds of entry (decided 2026-09-17):

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

Shared memory reaches an agent one way only: it **pulls** it through the **memory tool server**, the in-process MCP server Atlas hands every session that can take it (ADR-0010). Nothing is prepended to a user's message; the text goes to the agent exactly as typed. The server's **instructions** are the protocol — read first, write as you learn — and its tools are, in that order: **`memory_briefing`** (the first look of a session: working memory, the **durable index**, the **curated pack** and the **recent-session handoff**), **`memory_changes`** (what *other* sessions recorded since this session's **last look**), **`memory_search`** (the record plus the codebase index's documents), **`memory_get`**, **`memory_list`**, **`memory_remember`** and **`memory_forget`**.

- The **durable index** is one capped line per durable entry, each kind's best up to its display cap, ranked by recency (two-week half-life), use count and confidence; `memory_get` expands a line. It lists shared-memory entries; it is not the codebase index, and not the retrieval index `memory_search` also searches.
- The **curated pack** is the high-signal part of the project's foreign memory files (Claude's memory directory, `CLAUDE.md`, `AGENTS.md`), recency-ranked and budget-bounded. The **recent-session handoff** is the tail of the most recent other session in the scope, whichever agent ran it, read from capture (or, where capture was never enabled, from Atlas's own session transcripts) — never from an agent's own files.
- A session's **last look** is the newest write it has seen, set by its briefing or its last changes call and forgotten when the session ends. It belongs to the session, not to the send path.

The **injected-context envelope** — `<atlas-memory>` … `</atlas-memory>` — is what Atlas *used to* prepend. Every Atlas reader still strips it (`atlas_agent_transcript::strip_injected_context`): the Claude memory directory, capture transcripts, the session handoff, the chat's echoed prompts. Files written while Atlas pushed still carry it, and the loop it once caused (an agent saved Atlas's block into its own memory file and Atlas read the copy back in as a new fact) must stay closed.

## External Agent ownership

**Browser automation session** is one ACP session's persistent JS REPL and
explicitly shared daily Chrome/Edge tabs, connected through Atlas Browser.
Browser login remains in the user's browser. Settings > Browser control owns
installation guidance, browser choice and persistent global pause. A profile-specific
extension connects to Atlas/Atlas Dev automatically. Native Messaging privately
bootstraps each task relay, separately from CLI/MCP
credentials. Tasks use grouped Agent-created tabs. Completion, stop/pause and
session end close owned pages except required handoffs, release debugging and
remove empty groups. Existing user tabs never close. The app connection persists.

Installed ACP CLI processes own vendor login and model selection. Atlas owns local projects, approvals, transcripts, recording and shared memory. No Atlas account, official model gateway, organization service or built-in Agent is available. The literal `atlas-agent` is retained only for reading historical records. Local MCP bearer tokens authorize a session to the memory service and are unrelated to account authentication.

## Theming

- **Theme** — one named, shareable description of how Atlas looks, covering the whole app: chrome, editor, terminal, diffs and syntax. Holds a dark and/or light **variant**. There is exactly one active theme; there is no separate editor theme. *Avoid*: interface theme, editor theme, colour scheme.
- **Variant** — the dark or light half of a theme. A theme may ship only one.
- **Base tokens** — the required colours of a variant, named exactly as shadcn/ui names them, so any shadcn or tweakcn theme is a valid set of base tokens. *Avoid*: shadcn tokens.
- **Palette** — an optional small set of named hues (red, orange, yellow, green, cyan, blue, purple, pink) in a variant, from which syntax, terminal and status colours are derived when not set explicitly.
- **Theme keys** — optional, Atlas-specific colours in a variant, named by role in Zed's dotted style (`element.hover`, `terminal.ansi.red`, `syntax.keyword`). Any key a theme omits is derived from the palette, then the base tokens, then Atlas's defaults.
- **Theme override** — a user's settings-level patch of keys on top of the active theme. Changes that user's Atlas only; it is not a theme.
- **Theme import** — a one-time conversion of a shadcn/tweakcn, Zed or VS Code theme into an Atlas theme. The result is an ordinary Atlas theme; the source is not read again.
- **Icon theme** — a named mapping from files and folders (by name, extension or language) to icons, in VS Code's icon-theme format so VS Code icon themes can be used as-is. Chosen independently of the colour theme. *Avoid*: file icon pack, icon set.
- **Derived variable** — a colour Atlas computes from a key or a base token and no theme may set, because it is a function rather than a judgement (a status badge's fill is its status foreground at 12%). Written to `:root` like a key, absent from the schema, so writing one in a theme file is an unknown-key warning. *Avoid*: computed key, implicit key.
- **Appearance** — which of the two a variant is, `dark` or `light`. The user's `themeMode` (`system` / `dark` / `light`) is what they asked for; the appearance is what it resolved to, and a theme with only the other variant resolves to that one. *Avoid*: mode, when the resolved answer is meant.
- **Scale** — a named, finite ladder of non-colour values: type, control heights, radius, elevation, z-index layers, motion durations, icon sizes. A scale step is named, never measured (`text-xs`, not `text-[11px]`). Scales are app-owned; a theme sets `radius`, the fonts, `tracking-normal` and the shadow ramp, and nothing else on this side. Reference: `docs/reference/design-system.md`. *Avoid*: token, for a non-colour value.
