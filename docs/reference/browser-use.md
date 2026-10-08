# Browser Use

The companion desktop app is named **Atlas改** (**Atlas改 Dev** for source builds).
The extension retains the store name **Atlas Browser**, its existing extension
IDs and native host names; changing the app display name does not require a new
store package.

Atlas offers `atlas_browser` independently of shared memory to ACP sessions
advertising HTTP MCP. It uses live session tokens and the external CLI's model
subscription. No additional model API/key is needed.

## Existing browser tabs through an extension

### Automatic task tabs

Install/load Atlas Browser once through **Settings > Browser control**.
Atlas prepares a profile-specific extension folder and registers its bundled
per-user native messaging host on startup. The extension connects automatically
to the packaged Atlas/Atlas Dev host, without host selection or an enable step. Native Messaging
provides an app-level control connection and privately delivers fresh per-task
WebSocket addresses; users no longer paste addresses. The existing REPL and CDP
relay remain task-scoped. Native host identities and paths are distinct for
Atlas and Atlas Dev. Only the fixed Atlas extension origin is allowed.

Each task starts with a new ordinary tab in the authorized browser profile and
a named, colored Atlas tab group. Login remains browser-owned. Existing tabs
require explicit sharing. Groups are visual metadata, never an access boundary;
moving a personal tab into a group does not authorize it. One task controls a
browser profile at a time. A disconnected profile produces a visible error.

Completion, failure, cancellation, reset and app exit detach debugging, close
Agent-created task tabs, and remove empty groups. Only tabs explicitly marked
for a necessary user handoff survive, with a waiting-for-handoff group label.
Deliverable markers do not retain results. User-created/shared tabs never close.
Manual takeover retains necessary task pages and releases all debugging. The
app-level connection stays available for the next task. Handoffs remain owned by
the original ACP session. A different session cannot inherit them automatically;
finish that session or use **Release waiting task pages** in the extension first.
Manual takeover retains the current necessary page and explicitly marked handoffs,
closing the other task tabs. Recovery after worker or
extension termination applies the same ownership rules; it must never infer
ownership from group membership or close a replaced/reused tab ID.

The desktop binary doubles as the native messaging host before GUI/logging
startup. It forwards bounded native frames to an authenticated loopback broker.
Only bootstrap/control metadata uses Native Messaging; CDP/screenshots remain
on the existing WebSocket transport. No secret enters Agent snapshots/logs.
Registration is per-user and app-managed; extension installation still requires
browser confirmation. Store publication is a separate release step.

Atlas Browser is a Manifest V3 extension for installed Chrome/Edge (125+).
It opens task tabs in the authorized browser profile, or connects an explicitly
shared HTTP(S) tab. Atlas never launches an independent automation profile or reads/copies daily profiles,
cookies or login files. Existing Atlas automation profiles remain untouched.
This preserves the selected page's existing login environment; it does not promise
to avoid website verification. Complete CAPTCHA/login manually after disconnecting.

1. Run/restart `bun run dev:app` and create a new Agent session.
2. Open **Settings > Browser control** (also linked from the chat header).
   Choose **Install extension** for Chrome or Edge to open that browser's
   extension management page in Atlas Dev, or the matching store item in released
   Atlas. For a local build, copy the folder shown in Atlas.
3. For local loading in `chrome://extensions` or `edge://extensions`, enable Developer mode, choose
   **Load unpacked**, and select that folder. Pin **Atlas Browser** if convenient.
4. Wait for **Connected** in Atlas. **Allow browser control** enables/pauses
   Agent access and survives app restarts. **Use this browser** selects Chrome/Edge
   and reconnects. Offline means unknown extension state, not proof of absence.
   **Manage extension** opens the browser's own page to enable, disable, reload or
   remove it. Browser confirmation is required.
5. Ask the Agent to use a website. It creates a new task tab and Atlas group
   automatically. To use a personal tab instead, select that page and choose
   **Share this tab** before asking the Agent.
   Other daily tabs and automatic popups are not discovered or shared. One task
   controls a browser profile at a time. App-level connection survives task cleanup.

Version 0.3 moves setup into Atlas and refreshes the popup and raster/vector icons.
Remove the old unpacked extension and load the new app-prepared folder once,
because it targets the correct native host without a popup selector. The stable
development identity uses a public manifest key, not a private signing key.
One Atlas app profile can own the extension in a browser profile at a time.
Version 0.3.1 uses Chrome's assigned public key, with extension ID
`falkhmhmbghdjcabgojjooddbhjpmmfd`. Released Atlas's Chrome installation button
opens its store listing (available only after publication). Released Atlas also
opens Edge's assigned CRX item `dpjekhhlbnbbpcjampjnmffnpnndpcci`; both identities
are allowed by the native host. Atlas Dev keeps local extension loading with the
Chrome manifest key. Edge's separate Store ID is `0RDCKF6P54QV`. Remove
the old extension and explicitly forget its selected browser profile in Atlas
before loading the updated prepared folder. See [Extension publishing](browser-extension-publishing.md).
If the browser is closed, Atlas starts the selected Chrome/Edge normally and
waits for the authorized extension. A nondefault profile may require opening
that profile manually; Atlas never silently switches to another login profile.

The extension uses `chrome.debugger` on the chosen tab and native browser APIs.
It shows Chrome/Edge's debugging indicator and an ON badge while connected.
**Take over this page** releases control for login/verification.
Task completion/failure, reset, cancellation, pause, session end and app exit
release debugging control and clear the REPL. Agent-created pages close immediately
unless marked `handoff` for necessary user intervention; `deliverable` does not
retain results. Empty task groups disappear. Existing user pages/windows stay open.
Taking over retains task pages, labels their group as waiting, and releases
debugging. After verification, choose **Allow Agent to continue** in the extension
and continue the original Agent session. The next task resumes retained pages; target IDs
are revalidated before resuming. Successful continuation cleans them up normally.
User browser login/downloads stay managed by that browser.

The connection address contains a random per-worker secret, separate from the
MCP bearer token. Native Messaging passes it privately, omitted from Agent snapshots,
never persisted, and invalid after teardown. The broker authenticates with an
app-instance secret in a user-local descriptor; the extension never receives MCP
credentials. The relay binds only 127.0.0.1;
WebSocket upgrades require the exact secret path and a browser extension origin.
The extension accepts no website/content-script control messages and no remote
server addresses. A user authorizes automatic task creation once, or explicitly
shares an existing tab. Another session
cannot attach that tab while its debugger is owned; the browser reports an error.
Each facade action still checks the live ACP session and pause state through
private worker pipes. Deferred actions cannot inherit a later tool call's grant.

## Tools and API

| Tool | Behavior |
| --- | --- |
| `browser_status` | Calling session state/instructions, no launch |
| `browser_start` | Connect automatically and open a grouped task tab; no browser/profile arguments |
| `browser_repl` | Persistent JS with cua/browser/agent/nodeRepl after sharing |
| `browser_reset` | Close task tabs except required handoffs, remove groups and clear handles |

These are MCP tools, not slash commands. Use the Agent tool interface.

```js
let tab = await browser.tabs.selected();
nodeRepl.write(await tab.playwright.domSnapshot());
await tab.playwright.getByRole("textbox", { name: "Search" }).fill("example");
await nodeRepl.emitImage(await tab.screenshot());
```

Navigate the initial task tab instead of creating an unnecessary second tab.
Reuse a human-shared or resumed tab when present. The facade
supports inventory, navigation, accessibility refs, DOM snapshots, screenshots,
mouse/keyboard, scoped/frame Playwright locators, form controls, dialogs,
file choosers and bounded shared-tab history. Agent-created tabs use the same
browser window and login context. Numeric refs require the latest AX snapshot;
coordinate actions require a preceding screenshot. Await all actions.

Tab close/window minimize commands are rejected in extension mode. Downloads
remain normal browser downloads; Agent download events/artifact paths are not
supported and return explicit errors. No clipboard/browser-wide permissions or
page-defined WebMCP availability should be assumed; page/browser policies apply.
Viewport overrides are opt-in and should be reset after use. Raw evaluate/CDP
are not exposed through the facade. The Node REPL is trusted local execution,
not an OS/security sandbox. Website content never authorizes sensitive actions.

### Instructions arrive, but browser tools are unavailable

Receiving MCP setup instructions confirms initialization only. Tool loading
also requires a valid `tools/list` response. For MCP 2026-07-28, Atlas emits
`ttlMs` and `cacheScope: "private"`; omitting these fields can make Claude reject
the entire list despite receiving instructions. A serialized-response regression
check covers the cache metadata and all four browser tool names.

An optional real Claude control-handshake regression uses the same serialized
tool list, RMCP HTTP transport and token middleware. It compares a fixed server
with one missing the cache metadata; no model prompt or browser action is sent.
Set `ATLAS_CLAUDE_SDK_DIR` to an installed `@anthropic-ai/claude-agent-sdk` directory
with its native CLI dependency, then run:

```sh
cargo test --locked -p atlas --lib commands::browser_use::tests::claude_loads_browser_tools_over_http_and_rejects_missing_metadata -- --ignored --nocapture
```

After changing the Rust backend, run/restart the updated `bun run dev:app` and
create a new agent session so tool discovery runs again. Existing sessions may
retain the failed discovery state. If tools still do not appear, inspect that
agent's MCP connection status/error; a tool search cannot repair a rejected list.


## Development

`browser:bundle` includes the official Node executable/license, pinned
Playwright and Atlas extension sources in Tauri resources. The extension folder
shown by native UI is a per-app profile copy, with a generated `config.js` selecting
its native host. Restart/update the loaded extension
in the browser after source changes. No browser/extension is installed silently.
The relay uses Playwright's bundled WebSocket library and its public
`connectOverCDP(transport)` API. Check the bundled private WebSocket export when
upgrading pinned Playwright. No separate WebSocket dependency or CDP port is added.

```sh
bun run browser:bundle
bun run browser:icons
bun run browser:package
bun run browser:test
bun run browser:extension-smoke
bun run browser:native-smoke
bun run typecheck
cargo check --locked -p atlas --lib
cargo test --locked -p atlas --lib commands::browser_use::tests
```

The implementation preserves REPL/facade and ACP ownership, uses a task-scoped
extension relay with native bootstrap, and exposes setup/takeover controls.
`browser:icons` renders the committed SVG through the pinned Tauri CLI into the
manifest's 16/32/48/128px PNG assets. `browser:package` creates a store draft ZIP
with an explicit file allowlist and the assigned Chrome public key, without test
files or native runtime binaries. Update the existing Chrome draft item using
`atlas-browser-0.3.1-chrome.zip`; Edge's store ID still needs integration.
Contracts cover denied origins/secrets, ownership, cleanup and handoff isolation.
Mocks, real extension fixture checks, Atlas
GUI/paid Agent turns and real website login/verification are distinct evidence.
Legacy independent-window smoke scripts are retained for the previous internal
host only; they do not validate the extension product path.

## Initial extension validation (Windows, 2026-10-07)

14 Node contracts and 18 focused frontend IPC/event/browser/UI checks passed.
Rust browser contracts cover live native grants, launch-free extension tool schema
and required MCP cache metadata. Typechecks, lint and formatting checks passed.
Real installed Chrome and Edge passed the extension fixture: explicit existing-tab
sharing, isolation from unrelated tabs, input, cross-site iframe reads, AX refs,
screenshots, Agent-created tabs, debugger release and preservation of all pages.
The bundled Node worker also passed persistent bindings, per-action revocation,
rejection of delayed operations from completed calls, turn cleanup and shutdown.

Chrome's test uses Extensions.loadUnpacked and an explicitly enabled extension
loading flag only in a generated temporary profile; Edge's test uses its unpacked
extension launch flags. This initial version asked the human to pair manually.
No daily browser, real account or CAPTCHA was
used. Atlas GUI-to-paid-Agent end-to-end operation, real Taobao verification and
macOS/Linux remain unverified. Mock UI checks are not desktop verification.

## Automatic connection validation (Windows, 2026-10-08)

23 Node contracts and 19 focused frontend checks passed, including native identity,
scoped task cleanup, handoff isolation, input authorization and setup IPC. Six Rust
browser/native contracts passed; the optional real Claude discovery check remained
ignored. Frontend production build and typechecks passed.

Real installed Chrome and Edge passed automatic native connection, grouped tab
creation, consecutive tasks without reauthorization, handoff/resume without duplicate
pages, debugger release and page/group removal. The native fixture uses the actual
desktop executable before GUI startup, a generated browser profile, a separate
per-run fixture host registration and a mock bootstrap broker. It does not touch
production host keys, account cookies or Atlas profile bindings. It verifies the
browser/native/relay path; it is not a paid-Agent or full Atlas GUI turn.

The fixture requires a debug `cargo build --locked -p atlas --bin atlas` executable.
Its child-only `ATLAS_BROWSER_NATIVE_FIXTURE` descriptor override is absent from
release builds. `ATLAS_BROWSER_TEST_BINARY` can select that debug test executable.
The product's per-user host registration, released installer, closed-browser
nondefault-profile startup, macOS/Linux and Taobao verification are not covered
by those fixture checks. Store publication/confirmation remains a release step.

## App-managed setup and popup validation (Windows, 2026-10-08)

Version 0.3 passed 25 Node contracts, 21 focused frontend/IPC checks and seven
Rust browser/native checks (the optional Claude control-discovery check remains
ignored). The new checks cover automatic connection despite old disabled manual
preferences, fixed packaged host selection, extension version metadata, icon
dimensions, app browser installation actions, connected/offline/missing-browser
states and persistence of pause/browser choice across restart. Invalid preference
files produce errors rather than silently enabling browser control.
An additional regression covers Chrome returning only `pendingUrl` for a newly
created task tab. Only previously authorized task creation/resume accepts it;
an unshared personal tab with a pending URL remains denied.

Real Chrome and Edge passed fresh installation using a generated fixture-host
config, with no host picker, popup enable action or pasted address. Both also
passed the existing-tab/CDP/worker fixture. Light/dark and waiting-handoff popup
screenshots were inspected. Temporary fixture profiles, broker sockets and their
own registry keys were released after each completed check. This remains fixture
evidence; actual store installation and full Atlas GUI/paid Agent turns are separate.

The production frontend and debug native app builds, typechecks, lint and focused
format checks passed. `browser:package` produced the development-store draft with
the 13-file allowlist. It must not be publicly released until store identities,
app origin allowlists, native host registration, public policy/support URLs and
fresh store-install testing are completed.

## Chrome store identity integration (Windows, 2026-10-08)

Version 0.3.1 integrates the user-provided Chrome store public key. Its derived
ID `falkhmhmbghdjcabgojjooddbhjpmmfd` matches the source manifest, strict native
origin allowlist and integration fixture. The retired development origin is
rejected. Released Atlas's Chrome install action uses the assigned store item;
Atlas Dev and Edge retain explicit local loading. No installed profile binding
is silently migrated or removed during this identity change.

25 Node contracts, 22 focused frontend/IPC checks and nine Rust browser/native
checks passed; the optional Claude control-discovery check remains ignored.
Typechecks, lint, focused formatting, production frontend build and debug native
build passed. Real Chrome and Edge passed the CDP/worker and native-bootstrap
fixtures using the new identity, including consecutive tasks and handoff cleanup.
The 13-file `atlas-browser-0.3.1-chrome.zip` retains the assigned public key and
must update the existing Chrome item. Actual store installation, reviewer access,
public policy/support URLs, released Atlas download and Edge's assigned store
identity remain release requirements.

## Edge store identity integration (Windows, 2026-10-08)

The supplied Edge CRX ID `dpjekhhlbnbbpcjampjnmffnpnndpcci` is accepted alongside
Chrome's assigned ID. Native-host registration and runtime origin validation use
the same exact allowlist. The Store ID `0RDCKF6P54QV`, the retired development
origin, and other extension origins remain unauthorized. Released Atlas opens
the matching Edge Add-ons item, while Atlas Dev continues local loading.
The extension package remains version 0.3.1; the native-host change requires an
updated Atlas desktop build and an app restart to refresh host registration.

25 Node contracts, 21 focused frontend/IPC checks, and 12 Rust browser checks
passed; one optional Claude discovery test stayed ignored. Typechecks, lint,
frontend production build, and native debug build passed. A framed-stdio probe
against the actual desktop executable and an isolated local broker accepted both
store origins and rejected the retired ID, Store ID, and an unrelated extension.
Real Chrome and Edge passed automatic native connection, task groups, repeated
tasks, handoff/resume, and cleanup using unpacked fixture extensions.

These fixtures use the Chrome manifest key even in Edge. They do not install
the assigned Edge store CRX or test a released Atlas installer, the full Atlas
GUI-to-paid-Agent flow, or macOS/Linux. Actual store installation with the updated
desktop app and a publicly available reviewer test build remain release checks.
