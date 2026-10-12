# Atlas Browser extension publishing

This is a release preparation guide, verified against official Chrome/Edge
documentation on 2026-10-08. No account, upload or publication is performed by
the local packaging commands. Chrome's assigned public key has been integrated
in version 0.3.1. Its derived extension ID is
`falkhmhmbghdjcabgojjooddbhjpmmfd`; store-installed behavior still needs verification.
Edge's supplied CRX ID is `dpjekhhlbnbbpcjampjnmffnpnndpcci`, and its separate
Store ID is `0RDCKF6P54QV`. Both store extension origins are integrated in Atlas;
store installation still needs verification with the updated desktop build.

## Start with a draft

1. Run `bun run browser:icons` after editing the SVG, then `bun run browser:test`.
2. Run `bun run browser:package`. Upload
   `artifacts/browser-extension/atlas-browser-0.4.5-chrome.zip` as a new package
   on the **existing Chrome draft item**, not a new item. The ZIP puts
   `manifest.json` at its root, retains the assigned Chrome public key,
   excludes tests, SDK/Node binaries and runtime secrets, and targets released Atlas.
   The previous 0.3.0 draft ZIP was only for obtaining an initial store identity.
3. Register a [Chrome Web Store developer account](https://developer.chrome.com/docs/webstore/register)
   and complete its current registration/verification requirements, including the
   one-time registration fee. In the
   [developer dashboard](https://chrome.google.com/webstore/devconsole), add an
   item only for a first registration. For the current key, update the existing
   item instead. See [Chrome publishing](https://developer.chrome.com/docs/webstore/publish).
4. For Edge, register in [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview)
   under the Microsoft Edge program (currently no registration fee), then open the
   existing Atlas Browser item to upload a package update. Its supplied CRX ID is integrated in
   the desktop native host; the Store ID is not a native extension origin.
   Use `artifacts/browser-extension/atlas-browser-0.4.5-edge.zip` produced by
   `browser:package`. The Edge ZIP omits the manifest `key` field, which Partner
   Center rejects. Do not rename or copy the Chrome ZIP for Edge. The Chrome ZIP
   and source/unpacked manifest retain the assigned Chrome key; Edge's store
   identity is assigned by the store, not derived from the keyless upload ZIP.
   See [account registration](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/create-dev-account)
   and [Edge publishing](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension).

Version 0.4.1 replaces the global agreement with first-use website approval.
Version 0.4.2 fixes automatic approval-window messaging. The real-browser smoke
check must approve a website in that automatic window, not only in the toolbar
popup, before packaging an update.
Version 0.4.4 corrects the 0.4.3 retention default and grouping: Agent-created
tabs close unless explicitly retained, and retained tabs stay in their original
Atlas group. Verify unmarked/temporary tabs close, keep/result tabs keep the same
group ID without debugging or handoff state, and genuine handoffs still require
human continuation.
Version 0.4.5 records retained pages by ACP session, restores their inventory on
later turns and reuses the original group without a duplicate blank page. Keep
and result markers persist; new unmarked tabs still close. Other sessions must
neither discover nor close those pages. Verify identity changes, extension-worker
recovery, website reauthorization and handoff continuation in the same group.
Rebuild/restart Atlas Dev so Agents receive the updated lifecycle instructions,
then reload its local extension. Existing Agent sessions may need a new session
to receive refreshed browser tool documentation.
The disclosure remains beside Allow once / Allow for this site / Allow for all
sites / Decline. Manage website access supports removal and reset, which stop
control immediately. Existing global consent never becomes allow-all. Validate
new sites, redirects, frames, blocked sites, revocation and task-scoped grants
before updating the existing store items. Match privacy/store disclosures to the
actual distributed behavior.

## Integrate store identity before submission

For a new publisher, upload a Chrome draft first and obtain its **Item ID and public key** from the
Package tab. Replace the development manifest key with the assigned public key
and verify the unpacked ID matches the draft Item ID. The manifest `key` does
not establish a store ID; follow the [official key workflow](https://developer.chrome.com/docs/extensions/reference/manifest/key).
Chrome's provided public key is now in `extension/manifest.json` and derives the
ID above. Native origin validation, native-host allowlist, integration fixture
and released-app installation URL use that same ID. Released Atlas opens the
Chrome store listing on Install in both app profiles; Atlas Dev keeps local
unpacked installation for source testing through the development instructions.
The listing is unavailable until publication. Edge's supplied CRX ID differs
from Chrome's ID and is accepted alongside it.

The native host's origin validation and `allowed_origins` share the same two exact
store identities; there are no wildcard origins. Both app profiles open the matching
Chrome or Edge HTTPS store item on Install, without forcing a Google account.
Build and distribute the updated Atlas desktop app, then test each store extension
and native-host connection on a fresh browser profile. The extension ZIP itself
does not register or update the native host; uploading it cannot update an older
Atlas installation. Restart the updated app to refresh native-host registration.
Store-ID integration does not prove store installation or reviewer access.

The store package currently targets released Atlas (`com.atlas.browser`).
Atlas Dev uses the unpacked copy prepared on app startup
(`com.atlas.browser.dev`); one browser profile can load only one extension with
the same ID. Local loading instructions and configuration-directory paths are in
[Browser Use development](browser-use.md#development), not the settings page.
When upgrading from the retired development ID
`mfppkokdebmgaigclpffjjafpicgapbj`, remove the old extension and explicitly
**Forget selected browser profile** in Atlas, then load the prepared folder again.
Saved bindings are not silently deleted during upgrade. Restart Atlas to update
its per-user native-host manifest. Browser installation/removal still requires
user confirmation; Atlas only opens the browser/store page.

## Listing and review materials

Prepare publisher identity, a public support address/page, an Atlas desktop
download/setup page, and a public privacy-policy URL. Review [PRIVACY.md](../../PRIVACY.md)
against the shipped Atlas build and the CLI/model providers you support.
Do not submit placeholder URLs or claim that browser content never leaves the
device: authorized page text/screenshots may be forwarded to the selected model.

Chrome's [listing documentation](https://developer.chrome.com/docs/webstore/cws-dashboard-listing)
specifies a 128px icon, screenshots and promotional assets. Prepare at least one
1280×800 screenshot and a 440×280 small promotional tile; use the dashboard as
the authority for current required fields. The 16/32/48/128px PNG icons and the
SVG source are in `scripts/browser-use/extension/icons/`. Edge's listing fields
and asset requirements are documented in its publishing guide.

Run `bun run browser:native-smoke chrome` to capture the actual packaged popup
in a fixture profile, then `bun run browser:store-assets` to generate opaque JPEGs
and 24-bit RGB PNGs from the same source layouts. Use the PNG files for Edge uploads.
in `artifacts/browser-extension/store-assets/`: a 1280×800 screenshot composition,
a 440×280 small promotional tile, and a 1400×560 optional marquee. The screenshot
uses actual connected/handoff popup captures; promotional images use the original
packaged SVG brand. The renderer uses an isolated headless Chrome with no login or
native connection. It checks image dimensions, JPEG/PNG format, PNG color depth
and absence of alpha, and text clipping;
inspect the results before upload. HTML sources remain alongside them for edits.
The promotional video is optional. The screenshot and small tile are required;
the marquee is optional. See [official image requirements](https://developer.chrome.com/docs/webstore/images).

Suggested title: **Atlas Browser**.

Suggested single purpose: **Allow a local Atlas Agent to work with dedicated task
tabs and tabs explicitly shared by the user in their existing browser profile.**

Suggested description:

> Atlas Browser connects your browser to the Atlas desktop app. Agents open a
> dedicated Atlas tab group, work with pages you authorize, and close temporary
> pages when a task finishes. Share an existing tab, take over for login or
> verification, and explicitly allow the Agent to continue when ready. Your daily
> browser owns its login. Atlas desktop and a configured Agent are required.

In Chrome's [Privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy),
declare the single purpose, actual data handling and each permission:

| Permission | Product reason |
| --- | --- |
| `debugger` | Task-scoped DOM/accessibility snapshots, screenshots and authorized page input through Chrome's debugger API; browser debugging indicator remains visible. |
| `tabs` | Identify a tab explicitly shared from the popup, create/manage owned task pages and validate tab identities during recovery. |
| `tabGroups` | Reuse the session's group, label active/waiting pages and let empty groups disappear after cleanup; group membership never grants access. |
| `nativeMessaging` | Connect to the installed Atlas app's per-user native host, without pasted connection addresses. |
| `storage` | Keep a local browser-profile UUID and session ownership/handoff records for scoped cleanup/resume. |
| `alarms` | Retry the local app connection after browser/app restart. |
| `http://127.0.0.1/*` | Connect to an authenticated task relay on loopback. No arbitrary remote control server is accepted. |

All extension code is packaged locally. Page content and JavaScript evaluated
in an authorized task are separate from extension executable code; explain the
native companion and Agent execution model to reviewers. Store reviewers decide
whether the package meets policy. Do not claim that automated tests guarantee
approval.

Reviewer instructions: install the specified Atlas desktop build, open Settings
> Browser control, load/install the extension in a fresh Chrome/Edge profile,
confirm connected status, and run an Agent on a harmless public test page. Verify
dedicated group creation, completion cleanup, explicit existing-tab sharing,
takeover and user-approved resume. Include access to the app and a reproducible
test route; do not ask reviewers to complete a Taobao CAPTCHA. Do not put personal
credentials, subscriptions or native descriptor secrets in the package.

Submit for review only after store-ID integration and installation testing.
Chrome supports deferred publication after review; select it if you want to
approve the release manually. Edge submission also goes through certification.

## Public privacy policy

The standalone policy is [PRIVACY.md](../../PRIVACY.md) at the repository root.
For this public distribution, the dashboard's privacy-policy URL is:

<https://github.com/gggab/atlas/blob/refactor/local-agent-workbench/PRIVACY.md>

Keep this branch and file publicly accessible without login, and update the policy
when data handling changes. If the branch is renamed or deleted, move the policy
to a stable public location and update the store URL first.

The policy covers the confirmed maintainer/contact, browser-task data, local
storage, external Agent/model-provider transfers, retention and deletion, and
Limited Use. Review it against the build submitted for review. A public policy
does not replace any required prominent disclosure and affirmative consent
within the product before sensitive data processing.
