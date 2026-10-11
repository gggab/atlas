# Atlas Browser Privacy Policy

Effective date: October 11, 2026

This policy covers the Atlas Browser extension and its browser-control connection
to the local Atlas desktop app maintained in [gggab/atlas](https://github.com/gggab/atlas).
The maintainer of this distribution is [@gggab](https://github.com/gggab).
Websites, browser vendors, and independently configured Agent/model providers
have their own privacy policies.

## Purpose and information processed

Atlas Browser lets an Agent configured in Atlas work in dedicated browser task
tabs or existing tabs that you explicitly share. It supports manual takeover,
user-approved continuation, and cleanup of temporary task pages.

Before an Agent first uses a website hostname, a prompt explains page-data sharing
and asks you to allow it once for this task, remember that site, allow all sites,
or decline and block the site. Each subdomain asks separately; blocked sites
override allow-all. Browser installation permissions and metadata connection do
not grant this website access. Old global page-data agreements do not enable it.

To provide these features, the extension processes:

- A locally generated browser-profile identifier, browser type, extension version,
  and connection status, used to connect the intended browser profile to Atlas.
- Tab identifiers, task ownership, shared-tab selections, and handoff/resume state,
  used to scope control and clean up the appropriate pages.
- URLs, page titles, page text, DOM/accessibility content, screenshots, and
  interactions such as clicks, navigation, and form input on authorized pages.
- Page resources and network information when needed for an authorized task.

Authorized pages may contain names, contact details, messages, financial or
health information, location, or authentication information. Browser automation
does not comprehensively redact sensitive content. Share and automate only pages
whose content you are willing to have processed by Atlas and your selected Agent.

The extension does not copy browser profile files or stored login databases into
a separate automation profile. It operates within your existing browser login
environment. This does not mean that information on authenticated pages is
excluded from task processing. Unrelated tabs are not exposed through Atlas's
Agent browser interface; the extension may inspect tab metadata to identify a
tab you share or validate saved task ownership.

## Use and sharing

The extension uses this information to connect locally, perform the requested
browser task, display connection/task status, support takeover and continuation,
and clean up task pages. It connects to the installed Atlas app through Native
Messaging and authenticated connections on the same computer.

Browser-task content and screenshots may be passed from Atlas to the external
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

Atlas Browser's use and transfer of user data comply with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies#protecting-user-privacy),
including its [Limited Use requirements](https://developer.chrome.com/docs/webstore/program-policies/limited-use).
Use and transfer are limited to the user-facing browser-control feature, or
applicable legal or security obligations. Browser-task data is not provided to
the maintainer for routine human review.

## Storage and retention

The browser-profile identifier is stored locally in the browser's extension
storage, together with your remembered website decisions and allow-all setting.
Once grants exist only for the active task and end on disconnect or takeover.
Session storage contains task/shared-tab ownership and handoff state;
these records are updated or cleared during connection, cleanup, and recovery.
Atlas also stores profile binding and browser-control preferences in its local
app data. These settings may remain across app restarts.

The Agent decides which task pages to keep or close based on your request.
Agent-owned tabs close by default when the task finishes or control is released,
unless explicitly marked keep, result or handoff. Retained pages remain in their
original Atlas group without Agent control. Handoff pages remain until you
continue or release them. Existing user tabs are never closed by task cleanup.
Closing task tabs does not erase browser history, downloaded files, website
accounts, or Atlas conversation history.

Atlas and the selected Agent may retain task messages, screenshots, outputs,
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
  controls do not erase existing Atlas or provider records.
- Pause browser control in Atlas Settings > Browser control to stop Agent browser
  actions and release active control. The pause preference survives app restarts.
- Use the extension popup to take over a page or release waiting task pages.
  After verification, send continue (or 继续) in the original Atlas chat to
  return control without an extra extension click. Questions or unrelated messages
  keep the handoff paused. Existing user-owned tabs are preserved during cleanup.
- Use **Forget selected browser profile** in Atlas to remove the saved profile
  binding. This does not erase Atlas transcripts or browser extension storage.
- Remove the extension through your browser's extension management page to remove
  its browser-managed storage. Disabling it stops control but keeps its settings.
- Delete Atlas/Agent conversation records, artifacts, downloads, and backups
  separately using their respective controls. Uninstalling the extension does
  not delete data held by Atlas, websites, or external providers. Contact the
  selected provider for access or deletion of provider-held data.

## Security

The native connection is restricted to the expected extension identity. Task
relay connections use a local secret, and Agent actions are checked against a
live Atlas session and the pause state. These controls do not make authorized
page content anonymous or guarantee complete protection. Local records rely on
your browser, operating system, and app storage protections; this policy does not
claim that all local records are encrypted at rest.

## Contact and policy changes

For privacy questions or requests, contact
[lwt1421750225@gmail.com](mailto:lwt1421750225@gmail.com).

Updates will be published in this file with a revised effective date. The
published policy and store disclosures should match the distributed extension
and Atlas build.
