# DeskMate Browser Privacy Policy

Effective date: October 14, 2026

This policy covers the DeskMate Browser extension and its browser-control connection
to the local DeskMate desktop app maintained in [gggab/atlas](https://github.com/gggab/atlas).
The maintainer of this distribution is [@gggab](https://github.com/gggab).
Websites, browser vendors, and independently configured Agent/model providers
have their own privacy policies.

## Purpose and information processed

DeskMate Browser lets an Agent configured in DeskMate work in dedicated browser task
tabs or existing tabs that you explicitly share. It supports manual takeover,
user-approved continuation, and cleanup of temporary task pages.

Before an Agent first uses a website hostname, a prompt explains page-data sharing
and asks you to allow it once for this task, remember that site, allow all sites,
or decline and block the site. Each subdomain asks separately; blocked sites
override allow-all. Browser installation permissions and metadata connection do
not grant this website access. Old global page-data agreements do not enable it.

Local file pages and file uploads require you to enable the browser's **Allow
access to file URLs** setting for DeskMate Browser. This is separate from website
approval; allowing all websites does not enable file access. Authorized local
page content may be processed like website content. Files selected for an
authorized upload are sent to the destination website through its existing file
chooser. The extension adds no upload UI. Disable the browser setting to block
subsequent local-file operations; it is not a per-file authorization boundary.

To provide these features, the extension processes:

- A locally generated browser-profile identifier, browser type, extension version,
  and connection status, used to connect the intended browser profile to DeskMate.
- Tab identifiers, task ownership, shared-tab selections, and handoff/resume state,
  used to scope control and clean up the appropriate pages.
- URLs, page titles, page text, DOM/accessibility content, screenshots, and
  interactions such as clicks, navigation, and form input on authorized pages.
- Page resources and network information when needed for an authorized task.

Authorized pages may contain names, contact details, messages, financial or
health information, location, or authentication information. Browser automation
does not comprehensively redact sensitive content. Share and automate only pages
whose content you are willing to have processed by DeskMate and your selected Agent.

The extension does not copy browser profile files or stored login databases into
a separate automation profile. It operates within your existing browser login
environment. This does not mean that information on authenticated pages is
excluded from task processing. Unrelated tabs are not exposed through DeskMate's
Agent browser interface; the extension may inspect tab metadata to identify a
tab you share or validate saved task ownership.

## Use and sharing

The extension uses this information to connect locally, perform the requested
browser task, display connection/task status, support takeover and continuation,
and clean up task pages. It connects to the installed DeskMate app through Native
Messaging and authenticated connections on the same computer.

Browser-task content and screenshots may be passed from DeskMate to the external
Agent/model provider you configure, so that provider can perform your task. The
extension does not itself operate a developer-hosted collection service. Review
your provider's privacy policy, account settings, retention, and any model-training
settings before sharing sensitive pages. Provider-side processing and storage
are separate from local extension storage.

The extension contains no analytics or advertising service. The extension
maintainer does not sell browser-task data, use it for advertising, credit scoring
or lending decisions, or collect it for model training. The maintainer does not
receive routine copies of your browser tasks. If you send information in a support
request, only include what is necessary; do not send passwords, session tokens,
or private page content.

DeskMate Browser's use and transfer of user data comply with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies#protecting-user-privacy),
including its [Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).
Use and transfer are limited to the user-facing browser-control feature, or
applicable legal or security obligations. Browser-task data is not provided to
the maintainer for routine human review.

## Storage and retention

The browser-profile identifier is stored locally in the browser's extension
storage, together with your remembered website decisions and allow-all setting.
Once grants exist only for the active task and end on disconnect or takeover.
Session storage contains task/shared-tab ownership, handoff state, and the
retained-page/group associations for each ACP session. Later turns in the same
session restore only those recorded pages after identity and website-access
checks; other sessions and personal tabs are not discovered. Closing a page
removes it from the next restored inventory. This in-memory catalog clears on
extension reload/update/disable or browser restart and does not recover records
from group titles;
these records are updated or cleared during connection, cleanup, and recovery.
DeskMate also stores profile binding and browser-control preferences in its local
app data. These settings may remain across app restarts.

The Agent decides which task pages to keep or close based on your request.
Agent-owned tabs close by default when the task finishes or control is released,
unless explicitly marked keep, result or handoff. Retained pages remain in their
original DeskMate group without Agent control between turns. Later turns reuse
that group and its retained pages. Keep/result decisions remain until changed;
new unmarked pages still close. Handoff pages remain until you
continue or release them. Existing user tabs are never closed by task cleanup.
Closing task tabs does not erase browser history, downloaded files, website
accounts, or DeskMate conversation history.

DeskMate and the selected Agent may retain task messages, screenshots, outputs,
and artifacts in their own local conversation or artifact storage. There is no
fixed automatic deletion period for these records imposed by the extension;
they remain subject to the relevant app's retention and deletion controls.
External providers may keep their own records under their policies.

## Your controls and deletion

- Use **Manage website access** in the extension to remove allowed/blocked sites
  or reset all website decisions. Changes immediately stop active control and
  retain necessary handoff pages. Removing a block while allow-all is enabled
  allows that site again; reset all access to return to asking per website.
  Closing an unanswered prompt or a timeout does not approve access. These
  controls do not erase existing DeskMate or provider records.
- Pause browser control in DeskMate Settings > Browser control to stop Agent browser
  actions and release active control. The pause preference survives app restarts.
- Use the extension popup to take over a page or release waiting task pages.
  After verification, send continue (or 继续) in the original DeskMate chat to
  return control without an extra extension click. Questions or unrelated messages
  keep the handoff paused. Existing user-owned tabs are preserved during cleanup.
- Use **Forget selected browser profile** in DeskMate to remove the saved profile
  binding. This does not erase DeskMate transcripts or browser extension storage.
- Remove the extension through your browser's extension management page to remove
  its browser-managed storage. Disabling it stops control but keeps its settings.
- Delete DeskMate/Agent conversation records, artifacts, downloads, and backups
  separately using their respective controls. Uninstalling the extension does
  not delete data held by DeskMate, websites, or external providers. Contact the
  selected provider for access or deletion of provider-held data.

## Security

The native connection is restricted to the expected extension identity. Task
relay connections use a local secret, and Agent actions are checked against a
live DeskMate session and the pause state. These controls do not make authorized
page content anonymous or guarantee complete protection. Local records rely on
your browser, operating system, and app storage protections; this policy does not
claim that all local records are encrypted at rest.

## Contact and policy changes

For privacy questions or requests, contact
[lwt1421750225@gmail.com](mailto:lwt1421750225@gmail.com).

Updates will be published in this file with a revised effective date. The
published policy and store disclosures should match the distributed extension
and DeskMate build.
## Local scheduled tasks

When you create a reminder or authorize Agent task tools, DeskMate stores task
content, source references, execution bindings, run reports and notification
delivery records in the current profile's local `scheduler.sqlite`. Dev and
Release profiles are separate. Archiving a conversation leaves registered tasks
running. Deleting only a source conversation does not erase independent task
records; manage those tasks in the task center.

Agent checks send their registered task input to the selected external CLI and
its model service under that vendor's existing authentication and permissions.
Fixed reminders do not invoke a model. OS desktop notifications may display the
registered title and content. This feature adds no DeskMate cloud account,
telemetry service, new communication-source access or mobile delivery channel.
