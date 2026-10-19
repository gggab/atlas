# Independent background execution

Windows and macOS support an optional independent user-session backend. It is off
by default. In **Task Center → 独立后台服务**, choose **启用并重启** and confirm after
saving unsent drafts. The existing Agents chat, approvals and Personal Assistant
remain the UI; there is no separate background chat interface.

Switching execution mode interrupts currently running turns; it does not migrate
live CLI subprocesses. Tool effects are not undone. Wait for important work to
finish, and inspect interrupted checks before explicitly restoring them. A later
client-only reconnect restart keeps the already-enabled backend running.

The backend owns all live Agent sessions, scheduler claims, personal storage,
task tools and notifications. Closing the desktop client does not stop it. Fixed
reminders, minute intervals, calendar reminders and already-authorized Agent
checks continue while the computer is awake and the user session is logged in.
Scheduled model turns retain the existing limits, HTTP MCP and task-tool opt-in.
They may consume vendor quota and use the CLI's existing permissions. A new
permission, login or elicitation request waits for the user and raises an
attention notification; no background approval is granted.

Production enablement registers current-user login startup: an interactive,
least-privilege Task Scheduler job on Windows, or a LaunchAgent with a nested
LSUIElement helper app on macOS. Failed process restarts are bounded/throttled.
No administrator service or password is installed. Sleep, power-off and logout
stop execution; the existing calendar/interval catch-up policy applies later.
On macOS, the backend installs its SIGTERM handler before AgentHost starts and
routes termination through the normal scheduler and Agent subprocess cleanup.
This covers launchd's logout/unload signal, following
[Apple's LaunchAgent lifecycle guidance](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html).
There is no device wake, cloud or mobile notification channel. Native notification
acceptance is not proof that a person received or read it.

Development does not register persistent login startup. Windows copies the
executable to a build-specific profile runtime directory so the background process
does not lock Cargo's development output. macOS requires a built `.app` containing
the helper; a bare development executable cannot enable this feature.

## Ownership and failures

`<app-config-dir>/background/` holds configuration, owner/GUI locks, and an atomic
endpoint descriptor. Windows restricts the directory to the current user and
SYSTEM; Unix uses 0700 directories and 0600 JSON files. A per-boot self-signed TLS
certificate is pinned by the native client. The endpoint also contains a random
capability; the private TLS key exists only in backend memory. Origin requests,
unexpected Host headers and unlisted commands are rejected. IPC does not add a
browser `connect-src` exception or expose application RPC to web content.

The profile owner lock is acquired before opening stores or creating AgentHost.
A client never starts a local AgentHost/scheduler when connection fails. One
backend serializes human and scheduled turns through the existing admission
gate. Protocol, profile, version and backend source-build mismatches are visible
errors; active turns are never killed automatically to make a new GUI connect.

Requests disconnected after dispatch are not replayed: the effect may already
have happened. An event-stream interruption or bounded-ring gap fences further
commands. Use **重启界面重新连接**, after saving drafts, to hydrate full snapshots
and current pending approvals. Replayed requests enter the same ordered event
stream, so a later resolution cannot be overtaken by a stale pending snapshot.
This restarts only the UI, not the backend. This
is an explicit first implementation limit, rather than seamless reconnect.
Backend restart keeps the existing `dispatched → unknown/blocked` recovery.

**停用并重启** removes login restart mechanisms, stops the backend, verifies owner
release, and only then switches back to local execution. Failure leaves service
mode enabled with a visible error; it never opens a competing local store.
Task/chat/memory data are retained. Already-executed CLI effects are not undone.

## Updating and uninstalling

Close the UI and stop the backend before replacing the application or removing it. Prefer the
Task Center control. If the GUI cannot connect to an older build, run the
installed desktop binary with `--background-service-stop`; it removes current-user
login startup and waits for ownership release, retaining the enabled preference.
The next production GUI start refreshes the application path and login job.
`--background-service-remove` additionally disables the feature. Both exit nonzero
on incomplete cleanup, leave user databases untouched and start no AgentHost.

Examples (substitute the actual installed path):

```powershell
& 'C:\path\to\atlas.exe' --background-service-remove
```

```sh
'/Applications/同桌 DeskMate.app/Contents/MacOS/atlas' --background-service-remove
```

These are explicit maintenance operations. An automatic MSI uninstall action and
Finder-deletion cleanup are not installed by this implementation; release/manual
uninstall procedures must perform cleanup first. Moving/updating a running app
without stopping it can leave stale paths, which are reported rather than guessed.

## Development and release verification

Run frontend typechecks, task-center/notification tests and production build;
run `background::`, scheduler and notifier native tests. On Windows the known
test-runner Common Controls manifest workaround applies to a copied test binary.
`node --test scripts/background-service/package.test.mjs` checks helper metadata.

In a debug build, `node scripts/background-service/native-smoke.mjs <atlas.exe>`
starts an isolated temporary profile fixture in a process whose launcher exits.
It checks TLS/native-command round trips, structured failures, a real SQLite
reminder, a simulated Agent turn continuing after client disconnect, exactly one
dispatch, second-owner rejection, a real native client relay, client exit leaving
the backend running, stopped-endpoint cleanup and pending approval replay/resolution.
On macOS its shutdown check uses SIGTERM and requires normal endpoint cleanup.
It never registers login startup,
opens user stores, sends real native notifications or invokes a vendor CLI.
The fixture has a 60-second watchdog and is excluded from release builds.

Installed release checks remain separate on each OS: login startup/restart,
GUI exit during a real approved Agent check, reopen/permission routing, native
notification cold activation, update/uninstall cleanup and profile isolation.
On macOS verify the nested helper's distinct bundle identifier, signature,
entitlements and notarization, and grant its own notification permission. Verify
logout and LaunchAgent unload during an active Agent turn clean up CLI processes.
On Windows verify COM toast activation with the installed MSI/AUMID and an
interactive user session. Browser mocks and the fixture do not establish these.

See [ADR-0019](../adr/0019-independent-background-backend.md) for the design and
[task scheduling](task-scheduler.md) for calendar, admission and recovery rules.

### Local verification, 2026-10-19

Typechecks, lint, production build, 228 focused frontend tests and 118 native
tests passed. The isolated Windows process fixture passed all checks above,
including the real native client relay. Its native client runs detached: an
attached Node child could not create a working native window despite App Ready.
Installed OS startup/notification behavior, real vendor turns and macOS signing
remain release checks; no current-user login item or real reminder was created.

Commit validation also checks the IPC and CI-input contracts. Debug native
fixtures live in `src-tauri/tests/support/`, outside the shipping command scan.
The Windows contract run retains nine pre-existing failures, reproduced from
the unchanged parent commit: six Unix-only target-GC cases cannot spawn Bash,
two legacy-name checks are stale, and the CI planner does not classify the
existing Windows release workflow. These are separate from background execution.
