# Atlas Browser Privacy Policy

Effective date: October 8, 2026

This policy covers the Atlas Browser extension and its browser-control connection
to the local Atlas desktop app maintained in [gggab/atlas](https://github.com/gggab/atlas).
The maintainer of this distribution is [@gggab](https://github.com/gggab).
Websites, browser vendors, and independently configured Agent/model providers
have their own privacy policies.

## Purpose and information processed

Atlas Browser lets an Agent configured in Atlas work in dedicated browser task
tabs or existing tabs that you explicitly share. It supports manual takeover,
user-approved continuation, and cleanup of temporary task pages.

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
storage. Session storage contains task/shared-tab ownership and handoff state;
these records are updated or cleared during connection, cleanup, and recovery.
Atlas also stores profile binding and browser-control preferences in its local
app data. These settings may remain across app restarts.

Temporary Agent-owned tabs normally close when the task finishes or control is
released. Necessary handoff pages can remain until you continue or release them.
Closing task tabs does not erase browser history, downloaded files, website
accounts, or Atlas conversation history.

Atlas and the selected Agent may retain task messages, screenshots, outputs,
and artifacts in their own local conversation or artifact storage. There is no
fixed automatic deletion period for these records imposed by the extension;
they remain subject to the relevant app's retention and deletion controls.
External providers may keep their own records under their policies.

## Your controls and deletion

- Pause browser control in Atlas Settings > Browser control to stop Agent browser
  actions and release active control. The pause preference survives app restarts.
- Use the extension popup to take over a page, allow continuation, or release
  waiting task pages. Existing user-owned tabs are preserved during task cleanup.
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
