# Browser Use

The companion desktop app is named **同桌 DeskMate** (**同桌 DeskMate Dev** for source builds).
The extension retains the store name **DeskMate Browser**, its existing extension
IDs and native host names; changing the app display name does not require a new
store package.

Version 0.4.1 replaces the separate page-data agreement with website authorization.
Native metadata connects automatically; it never grants page access. On first use
of a hostname, the extension opens an approval window offering **Allow once**
(for this task), **Allow for this site**, **Allow for all sites**, and **Decline**
(persistently block this site). The same prompt is available in the toolbar popup.
Version 0.4.2 fixes the automatic approval window's message routing. Both the
toolbar popup and `popup.html#website-access` can read and submit approval; other
pages and extension origins cannot. Approval appears when an Agent first uses
an unapproved website, after the browser connection succeeds, not on installation
or on **Share this tab** alone.
The prompt discloses URLs, text, screenshots, form input and network details,
possible sensitive content, and transfer through local DeskMate to the selected
external Agent/model provider. Only extension UI can make these decisions.

**Manage website access** in the extension lists allowed/blocked hostnames and
lets the user remove decisions or reset all access. Revocation immediately stops
control and preserves the necessary handoff page. Existing conversation/provider
records are not erased. Decisions belong to the selected browser profile; each
subdomain asks separately. Blocked sites override allow-all. Once grants end on
task completion, failure, reset, takeover, pause, disconnect or worker restart.
Old global consent never becomes allow-all. Closing a prompt or letting it time
out cancels access without approving it. Retry only after the user reviews access.

Authorization precedes attaching shared pages, exposing existing frame trees,
creating HTTP(S) or file task tabs, navigating, and continuing document requests (including
redirects and cross-site frames). The extension owns Document Fetch interception;
Agents cannot disable it. A declined document stops control and preserves the
necessary page. Resource/API content used by an authorized page can also be part
of that page's data; this is website access control, not a network firewall.

`bun run browser:package` produces separate Chrome/Edge ZIPs. Chrome keeps
its assigned manifest key; Edge omits it. Identities and native hosts stay unchanged.
Passing fixtures does not prove store certification or real CLI integration.

DeskMate offers `atlas_browser` independently of shared memory to ACP sessions
advertising HTTP MCP. It uses live session tokens and the external CLI's model
subscription. No additional model API/key is needed.

## Existing browser tabs through an extension

### Automatic task tabs

Extension 0.4.5 keeps one group per ACP session while that group exists. Turn
completion still releases debugging and clears REPL handles, but retains a
browser-session catalog of explicitly shared and kept/result pages. The next
browser_start restores those pages, checks their target identity and current
website approval, and reuses the same group. It creates a blank page only if no
recorded page remains. Query browser.tabs.list() and acquire fresh handles before
opening more pages. Keep/result markers survive reconnect; markTemporary() can
close a previously retained owned page at the next cleanup. New unmarked pages
still close, and personal/shared pages never acquire deletion ownership.

Other sessions get separate groups and cannot discover these pages. Moving an
unrelated tab into an DeskMate group does not authorize it. Manually closed or
replaced targets are skipped; an empty/deleted group is recreated when needed.
The catalog uses extension session storage: it survives service-worker restarts,
but clears when the extension is reloaded/updated/disabled or the browser restarts
([Chrome storage lifecycle](https://developer.chrome.com/docs/extensions/reference/api/storage#session)).
A changed ACP session ID does not inherit another session's pages. Existing
0.4.4 groups lack retained ownership records and are not inferred from their
titles; explicitly share a page if needed. Updating does not merge or close them.

Install/load DeskMate Browser once through **Settings > Browser control**.
DeskMate prepares a profile-specific extension folder and registers its bundled
per-user native messaging host on startup. The extension connects automatically
to the packaged DeskMate/DeskMate Dev host, without host selection or an enable step. Native Messaging
provides an app-level control connection and privately delivers fresh per-task
WebSocket addresses; users no longer paste addresses. The existing REPL and CDP
relay remain task-scoped. Native host identities and paths are distinct for
DeskMate and DeskMate Dev. Only the fixed DeskMate extension origin is allowed.

Each task starts with a new ordinary tab in the authorized browser profile and
a named, colored DeskMate tab group. Login remains browser-owned. Existing tabs
require explicit sharing. Groups are visual metadata, never an access boundary;
moving a personal tab into a group does not authorize it. One task controls a
browser profile at a time. A disconnected profile produces a visible error.

Version 0.4.4 lets the Agent decide page retention from the user's task, without
fixed website/content categories. Before finishing, it can mark owned pages with
`markTemporary()` to close, `markKeep()` or `markDeliverable()` to retain, and
`markHandoff()` to return control for human intervention. Markers can be revised;
unmarked Agent-created pages default to temporary and close at cleanup.
Completion, failure, cancellation, reset and app exit detach debugging and close
owned pages unless explicitly marked keep, deliverable or handoff.
Ordinary retained pages stay in the original task group, do not block later tasks, and are
not automatically exposed to another session. Handoffs retain their waiting group.
User-created/shared tabs never close, even if marked temporary.
Manual takeover retains necessary task pages and releases all debugging. The
app-level connection stays available for the next task. Handoffs remain owned by
the original ACP session. A different session cannot inherit them automatically;
finish that session or use **Release waiting task pages** in the extension first.
Manual takeover retains the current necessary page and explicitly marked handoffs,
applying the Agent's decisions to the other task tabs. Recovery after worker or
extension termination applies the same ownership rules; it must never infer
ownership from group membership or close a replaced/reused tab ID.

The desktop binary doubles as the native messaging host before GUI/logging
startup. It forwards bounded native frames to an authenticated loopback broker.
Only bootstrap/control metadata uses Native Messaging; CDP/screenshots remain
on the existing WebSocket transport. No secret enters Agent snapshots/logs.
Registration is per-user and app-managed; extension installation still requires
browser confirmation. Store publication is a separate release step.

DeskMate Browser is a Manifest V3 extension for installed Chrome/Edge (125+).
It opens task tabs in the authorized browser profile, or connects an explicitly
shared HTTP(S) or local file tab. DeskMate never launches an independent automation profile or reads/copies daily profiles,
cookies or login files. Existing DeskMate automation profiles remain untouched.
This preserves the selected page's existing login environment; it does not promise
to avoid website verification. Complete CAPTCHA/login manually after disconnecting.

### Browser-task operating guidance

The MCP initialization instructions, `browser_status` documentation, tool
descriptions and runtime API documentation direct Agents to open/navigate browser
tasks through DeskMate tools. Shell/PowerShell/OS URL launches bypass task ownership
and grouping; they must not substitute for DeskMate tools to avoid cleanup,
permission, verification or connection errors. Page retention remains the Agent's
decision using `markKeep()`/`markDeliverable()`/`markTemporary()`.

Read full observed `href` values through locators, keep navigation data separate
from shortened display labels, and resolve with `new URL(href, sourcePageURL)`.
Preserve query parameters and fragments; never concatenate `https:` blindly,
truncate navigation URLs, or require every result to use one path filename.
Ad/redirect links may be valid. Inspect the destination or choose an observed
direct alternative rather than reconstructing an address.

Agents navigate and inspect one page at a time, check the final URL/page identity
and task-required content, and report missing content explicitly. CAPTCHA/login
or verification stops further openings, navigation and retries until human
handoff/continuation. This reduces unnecessary requests but does not guarantee
that a website will never challenge the user. Parameter-dependent page behavior
must be supported by observations rather than assumed.

These instructions are guidance for the external Agent, not an OS-level ban on
shell execution. The vendor CLI owns shell permissions, and DeskMate's trusted Node
REPL is not a security sandbox. No live Taobao behavior is inferred from fixtures.

1. Start DeskMate and create a new Agent session.
2. Open **Settings > Browser control** (also linked from the chat header).
   Chrome and Edge use their respective browser logos. Choose **Install from Chrome
   Web Store** or **Install from Edge Add-ons** and confirm
   installation in the browser. Pin **DeskMate Browser** if convenient.
   Settings shows browser availability, connection status and controls; it does
   not show developer-mode instructions, local extension paths or publication status.
   Source-build setup is documented under [Development](#development).
   Installation buttons open the assigned HTTPS store item in both app profiles;
   they never use internal extension-management URLs for installation. The Chrome
   target is `https://chromewebstore.google.com/detail/atlas-browser/falkhmhmbghdjcabgojjooddbhjpmmfd`,
   without account-specific `authuser` or forced language parameters.
3. Wait for **Connected** in DeskMate. **Allow browser control** enables/pauses
   Agent access and survives app restarts. **Use this browser** selects Chrome/Edge
   and reconnects. Offline means unknown extension state, not proof of absence.
   **Manage extension** opens the browser's own page to enable, disable, reload or
   remove it. Browser confirmation is required.
4. Ask the Agent to use a website and approve its hostname in the automatic
   extension prompt. The first browser operation creates a tab and DeskMate group;
   later turns restore retained pages and reuse that group. To use a personal tab instead, select that page and choose
   **Share this tab** before asking the Agent.
   Other daily tabs and automatic popups are not discovered or shared. One task
   controls a browser profile at a time. App-level connection survives task cleanup.

Version 0.3 moves setup into DeskMate and refreshes the popup and raster/vector icons.
Remove the old unpacked extension and load the new app-prepared folder once,
because it targets the correct native host without a popup selector. The stable
development identity uses a public manifest key, not a private signing key.
One DeskMate app profile can own the extension in a browser profile at a time.
Version 0.3.1 uses Chrome's assigned public key, with extension ID
`falkhmhmbghdjcabgojjooddbhjpmmfd`. Released DeskMate's Chrome installation button
opens its store listing (available only after publication). Released DeskMate also
opens Edge's assigned CRX item `dpjekhhlbnbbpcjampjnmffnpnndpcci`; both identities
are allowed by the native host. DeskMate Dev keeps local extension loading with the
Chrome manifest key. Edge's separate Store ID is `0RDCKF6P54QV`. Remove
the old extension and explicitly forget its selected browser profile in DeskMate
before loading the updated prepared folder. See [Extension publishing](browser-extension-publishing.md).
If the browser is closed, DeskMate starts the selected Chrome/Edge normally and
waits for the authorized extension. A nondefault profile may require opening
that profile manually; DeskMate never silently switches to another login profile.

The extension uses `chrome.debugger` on the chosen tab and native browser APIs.
It shows Chrome/Edge's debugging indicator and an ON badge while connected.
**Take over this page** releases control for login/verification.
Task completion/failure, reset, cancellation, pause, session end and app exit
release debugging control and clear the REPL. Agent-created pages close by default;
explicitly kept, deliverable and handoff pages remain in their original task group.
Existing user pages/windows stay open regardless of markers.
Taking over retains task pages, labels their group as waiting, and releases
debugging. The original ACP session can reconnect with a fresh
browser_start without a required chat phrase or return-control button. Target IDs
are revalidated before resuming. Resumed pages return to temporary task state;
Agents must mark them again to retain them after the resumed task finishes.
User browser login/downloads stay managed by that browser.

Takeover ends current control; it does not lock out subsequent calls by the
original Agent session. The extension does not detect human mouse/keyboard
activity or whether verification is complete. The Agent must wait for the human
when it hands off verification, but the extension does not enforce that wait.
If the Agent is still running or retrying, it can reconnect while the human is
working. If its turn has ended, removing this gate does not start a new turn;
send a follow-up in the original chat when ready, with no required wording.

To prevent reconnection, turn off **Allow browser control** in **Settings >
Browser control**, or choose **Pause all browser automation** in the chat's
browser menu. Global pause stops control, blocks later calls and persists across
app restarts until explicitly enabled. Website authorization and original-session
ownership still apply, including when restoring legacy handoffs with ready=false.
This is separate from ChatGPT Work's documented cloud-browser sign-in return
action; it makes no claim about ChatGPT's local extension takeover implementation.
Rebuild/restart the desktop app and reload the local extension after updating.

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

### Local files

DeskMate Browser declares `file:///*` so Chrome/Edge exposes **Allow access to
file URLs** in the extension details. The human must enable that browser-owned
switch before opening, navigating, or sharing a local file page, or using a
website's existing file chooser to upload an absolute file path. The extension
adds no upload button or upload page. Disabled access returns instructions to
open Extensions > DeskMate Browser > Details and enable the switch.

Local-file authorization is separate from hostname decisions: website allow-all
does not grant it, and enabled file access does not grant website access. File
pages still require session ownership, and each page action/navigation/upload
checks current access. Turning the switch off blocks later file operations.
Global pause remains enforced. Only use files authorized by the user's task;
the browser switch is a profile-wide capability, not a per-file sandbox.

Reload the prepared extension after updating DeskMate to see the browser setting.
Rebuild/restart the app so its bundled runtime and Agent instructions also update.

### API reference

| Tool | Behavior |
| --- | --- |
| `browser_status` | Calling session state/instructions, no launch |
| `browser_start` | Connect automatically, restore this session's pages and reuse its group; no browser/profile arguments |
| `browser_repl` | Persistent JS with cua/browser/agent/nodeRepl after sharing |
| `browser_reset` | Release control, close unmarked/temporary owned tabs and clear handles; preserve retained pages and their session group |

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
also requires a valid `tools/list` response. For MCP 2026-07-28, DeskMate emits
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

After operating-guidance changes, run `bun run browser:test`: its runtime check
executes the link-navigation example from the MCP instructions against absolute,
protocol-relative, relative, file, missing and unsupported-scheme links, including long query
tails. Run `bun run browser:extension-smoke chrome` for the real extension's
grouped navigation through a full redirect URL and verify the requested content
after navigation. These checks test API/example behavior, not model compliance
with instructions or a vendor CLI's shell permissions. Rebuild/restart DeskMate Dev
and start a new Agent session to refresh MCP instructions and tool discovery.
Guidance-only changes do not require a new extension version.

For session reuse changes, test consecutive native starts with the same session
ID: retain multiple pages, finish the turn, list them on the next start without
a duplicate blank tab, and add a page to the exact original group ID. Verify
keep/result markers survive, new unmarked pages close, shared/personal pages
survive, other sessions remain isolated, and handoff resumes in that same group
without a chat authorization message. Check manual takeover and legacy ready=false
records, and verify website denial and global pause still block browser operations.
Run real Chrome and Edge extension/native fixtures. Reload the updated extension
and rebuild/restart DeskMate Dev for the new worker and instructions. These fixtures
do not prove a paid CLI Agent's compliance or real shopping-site behavior.

Run/restart `bun run dev:app` to prepare the DeskMate Dev extension copy. Store
extensions target released DeskMate (`com.atlas.browser`); source development still
requires the local copy targeting DeskMate Dev (`com.atlas.browser.dev`). Installation
buttons open the store in both profiles and do not change native-host selection.
For local loading, open `chrome://extensions` or `edge://extensions` manually in
the browser. Chrome may reject internal page URLs passed on its launch command
line, so loading instructions should not rely on launching those URLs.
Enable Developer mode, choose **Load unpacked**, and select `browser-extension`
inside the OS configuration directory for `dev.atlas.ide.dev`:

- Windows: `%APPDATA%\dev.atlas.ide.dev\browser-extension`.
- macOS: `~/Library/Application Support/dev.atlas.ide.dev/browser-extension`.
- Linux: `${XDG_CONFIG_HOME:-~/.config}/dev.atlas.ide.dev/browser-extension`.

The settings page intentionally omits this developer setup in both app profiles.
DeskMate connects automatically after loading; no address or connection switch is
needed. Only one DeskMate app profile can own the extension in a browser profile.
When switching from the retired extension ID, remove the old extension and
forget its selected browser profile in DeskMate before loading the prepared folder.

The settings browser logos are bundled SVGs in `src/assets/browser-logos/`,
sourced from [Browser Logos](https://github.com/alrra/browser-logos). Each asset
retains its source and license notice; rendering does not fetch remote images.

`browser:bundle` includes the official Node executable/license, pinned
Playwright and DeskMate extension sources in Tauri resources. The prepared extension
folder is a per-app profile copy, with a generated `config.js` selecting
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
Mocks, real extension fixture checks, DeskMate
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
used. DeskMate GUI-to-paid-Agent end-to-end operation, real Taobao verification and
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
production host keys, account cookies or DeskMate profile bindings. It verifies the
browser/native/relay path; it is not a paid-Agent or full DeskMate GUI turn.

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
evidence; actual store installation and full DeskMate GUI/paid Agent turns are separate.

The production frontend and debug native app builds, typechecks, lint and focused
format checks passed. `browser:package` produced the development-store draft with
the 13-file allowlist. It must not be publicly released until store identities,
app origin allowlists, native host registration, public policy/support URLs and
fresh store-install testing are completed.

## Chrome store identity integration (Windows, 2026-10-08)

Version 0.3.1 integrates the user-provided Chrome store public key. Its derived
ID `falkhmhmbghdjcabgojjooddbhjpmmfd` matches the source manifest, strict native
origin allowlist and integration fixture. The retired development origin is
rejected. Released DeskMate's Chrome install action uses the assigned store item;
DeskMate Dev and Edge retain explicit local loading. No installed profile binding
is silently migrated or removed during this identity change.

25 Node contracts, 22 focused frontend/IPC checks and nine Rust browser/native
checks passed; the optional Claude control-discovery check remains ignored.
Typechecks, lint, focused formatting, production frontend build and debug native
build passed. Real Chrome and Edge passed the CDP/worker and native-bootstrap
fixtures using the new identity, including consecutive tasks and handoff cleanup.
The 13-file `atlas-browser-0.3.1-chrome.zip` retains the assigned public key and
must update the existing Chrome item. Actual store installation, reviewer access,
public policy/support URLs, released DeskMate download and Edge's assigned store
identity remain release requirements.

## Edge store identity integration (Windows, 2026-10-08)

The supplied Edge CRX ID `dpjekhhlbnbbpcjampjnmffnpnndpcci` is accepted alongside
Chrome's assigned ID. Native-host registration and runtime origin validation use
the same exact allowlist. The Store ID `0RDCKF6P54QV`, the retired development
origin, and other extension origins remain unauthorized. Released DeskMate opens
the matching Edge Add-ons item, while DeskMate Dev continues local loading.
The extension package remains version 0.3.1; the native-host change requires an
updated DeskMate desktop build and an app restart to refresh host registration.

25 Node contracts, 21 focused frontend/IPC checks, and 12 Rust browser checks
passed; one optional Claude discovery test stayed ignored. Typechecks, lint,
frontend production build, and native debug build passed. A framed-stdio probe
against the actual desktop executable and an isolated local broker accepted both
store origins and rejected the retired ID, Store ID, and an unrelated extension.
Real Chrome and Edge passed automatic native connection, task groups, repeated
tasks, handoff/resume, and cleanup using unpacked fixture extensions.

These fixtures use the Chrome manifest key even in Edge. They do not install
the assigned Edge store CRX or test a released DeskMate installer, the full DeskMate
GUI-to-paid-Agent flow, or macOS/Linux. Actual store installation with the updated
desktop app and a publicly available reviewer test build remain release checks.
