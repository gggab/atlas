# ADR-0019: One independent backend owns scheduled and human Agent execution

Status: accepted; implementation and isolated Windows checks complete; installed
Windows/macOS release validation remains pending.

## Decision

The approved scope is Windows and macOS, including Agent checks after the desktop
UI process exits. A tray-resident desktop process and a reminder-only handover do
not satisfy this requirement. Linux retains its existing in-process workbench.

When explicitly enabled, an independent user-session process owns the scheduler,
personal store, AgentHost, TurnAdmissions, MCP offers, history and approval routes.
The desktop process forwards the existing Agent/task/personal command surface and
retains its editor/window/terminal functions. No second AgentHost is initialized
in a client, including when connecting fails. An owner file lock precedes store
and Agent initialization. Enabling/disabling requires an explicit UI restart;
closing the client does not shut down the backend.

The existing Tauri 2.11.1 command decoder is reused through a permanently hidden
internal webview containing only a static local page, not the React application.
Its navigation is restricted to the exact internal protocol URL, scripting is
denied by CSP, its data directory is independent of the GUI, and only native
authenticated RPC can dispatch the allowlisted commands. Window, Channel and
plugin commands are excluded. This carries a WebView runtime dependency and is
not a zero-webview daemon. An isolated real Windows process verified JSON/error
round trips and unknown-command rejection before integration proceeded.

Authenticated loopback HTTPS reuses the installed axum/reqwest/rustls stack. A
per-boot self-signed certificate is pinned by the native client before a capability
or command body is transmitted; the private key remains in backend memory. The random
capability lives in a profile-private atomic endpoint file, with current-user
Windows ACLs or Unix 0700/0600 permissions. Origin-bearing requests, unexpected
Host values, unlisted commands and incompatible protocol/profile/build identities
are rejected. Bodies, concurrent requests and the event ring are bounded. Tokens
and command contents are not logged. A disconnected mutation is not replayed.

An event gap is explicit and fences subsequent RPC: the user restarts the interface
to hydrate full existing snapshots. There is no automatic renderer reload that
discards an unsent draft, and no unbounded event journal. Current pending approval
UUIDs are replayed after the shared approval listener attaches; resolved/finished
requests are removed. A backend restart retains existing dispatched-to-unknown
recovery instead of continuing an uncertain tool effect or granting permission.

Windows uses a current-user interactive Task Scheduler entry with bounded failure
restarts. macOS uses a user LaunchAgent and a separately identified LSUIElement
helper inside Contents/Library/LoginItems. The helper is signed and verified by
the prebundle hook; notarization and installed activation still require platform
release verification. The helper keeps the compiled GUI data-profile identifier
and resolves resources through the configured main application resource directory.
No administrator service, stored password, device wake or mobile delivery is added.

Background execution is off by default. Production enablement explains login
startup and continued vendor usage. Development does not register login startup;
Windows uses a build-specific runtime copy to avoid locking target/debug/atlas.exe.
Disabling unregisters restart mechanisms before shutdown and checks owner release.
Version mismatch never automatically kills active Agent turns.

Explicit stop/remove maintenance arguments support update/uninstall cleanup
without opening application databases. Automatic installer/Finder deletion hooks
are not yet provided; release procedures must stop/remove the backend first.

## Review

Kimi CLI 0.43.1 and Claude Code 2.1.302 independently reviewed the confirmed scope
and exchanged critiques. Both accepted the single-owner backend. Their review
rejected same-process residency, needless leases/request ledgers, duplicate Agent
hosts, assumed macOS shared-bundle activation and silently omitted Windows cold
activation. Source implementation and platform checks remain the primary agent's
responsibility; consultation is not verification.

## Local verification (2026-10-19)

Frontend typechecks, lint, production build and 228 focused tests passed. Native
app compilation and 118 focused tests passed (one vendor-billed test stayed
explicitly ignored). A copied Windows test binary received the known Common
Controls manifest workaround; production sources were not changed for it.

The isolated Windows process fixture passed real TLS/native RPC round trips,
structured errors, a durable SQLite reminder, second-owner rejection, one mock
Agent execution surviving client disconnect, live approval replay/resolution,
native client exit preserving the backend and stopped endpoint removal. The
native test client must launch independently: an attached Node child reported
App Ready but failed native window creation. This was a fixture launch issue,
not a reason to skip its assertions. No real user stores, startup jobs or
vendor-billed Agent turns were used.

Installed login startup, Windows COM cold activation, actual native delivery,
real vendor Agent checks and macOS build/signing/notarization were not verified
on this Windows checkout. Automatic MSI/Finder uninstall cleanup is still absent;
the documented explicit stop/remove procedure remains required.
