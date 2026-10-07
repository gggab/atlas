# Atlas-managed SSH

Atlas owns password-based SSH connections on Windows and macOS. Agents use the
`atlas_ssh` MCP server; they never receive a saved password or a credential-file path.

## Set up a server

1. Open **Settings → Remote connections → Add SSH connection**.
2. Enter a name, purpose, host, port, username and SSH password. An optional sudo
   password overrides the SSH password for controlled sudo authentication.
3. Save, then **Fetch fingerprint**. Compare the SHA256 fingerprint with a trusted
   server-side source and explicitly accept it. Fetching a fingerprint does not log in.
4. Use **Test connection** to test password login. This does not associate a project.

Passwords live in Windows Credential Manager or macOS Keychain, under the current
Atlas profile. SQLite in the app configuration directory stores connection metadata,
project associations and redacted command history. There is no plaintext fallback.
Editing a connection invalidates its prior authorization. Changing the host, port or
username also clears the trusted fingerprint. Deletion removes its saved credentials.

## Agent access

Start or reopen an Agent session after the app has started its SSH tool server.
The agent must advertise ACP HTTP MCP support. SSH is offered independently of
the project's shared-memory switch. Available connections are queried only when needed.

| Tool | Purpose |
| --- | --- |
| `ssh_connections_list` | Current endpoints, purpose, project association and authorization state |
| `ssh_connect` | Request user approval, then connect; returns a connection handle |
| `ssh_exec` | Start one independent command and return a job ID |
| `ssh_job_status` | Redacted output, completion status and exit code |
| `ssh_job_cancel` | Request cancellation |
| `ssh_disconnect` | Disconnect this session's SSH handle |

When `ssh_connect` returns `authorization_required`, approve or deny the request in
Atlas. After approval the agent calls `ssh_connect` again. A denial or revocation
prevents further use for that live session. Ending the Agent session revokes its
authorizations; a resumed session requires fresh approval. Discovery never grants access.

Authorization covers a connection's approved configuration and the actual Agent
session identity. The server account's existing permissions apply, including root
or administrator access where configured. Atlas does not infer permissions from
command text. `sudo=true` uses `/usr/bin/sudo -S -k` with a quoted `/bin/sh` payload;
the password goes through SSH channel stdin and the payload closes stdin. Servers
without compatible sudo/sh cannot use this helper.

Each command starts independently: combine `cd` and the command in one call when
needed. Default timeout is 300 seconds, configurable from 1 to 86400 seconds. The
remote execution view displays a continuous transcript in command start order,
with a server prompt, streamed output and completion status for each command.
It follows new output at the bottom and preserves the reading position when
scrolling up; **Latest output** resumes following. Stopping, disconnecting and
revoking access remain available. Output is capped at 1 MiB per job;
the last 100 completed jobs are retained. App interruption leaves an unknown outcome.
Cancellation and disconnect are best effort: check server state before retrying a
command with an unknown outcome. Atlas does not automatically replay commands.

## Project associations

Successful authorized Agent login automatically associates the connection with
the session's project. Listing, failed login, management tests and projectless
sessions do not create associations. Associated connections are listed first;
global connections remain discoverable.

Choose a project in Remote connections, or use the project's sidebar menu to open
its associations. Users can add, remove or restore an association and see its source
and last use. Removal records an exclusion, so later successful logins do not silently
re-add it. An association neither grants nor revokes access.

## Boundaries

V1 provides password login and read-only execution display. Interactive remote shell,
manual terminal takeover, file transfer, other service APIs and credential sync are
outside this version.

The guarantee is that Atlas does not hand saved credentials to model context or
logs. Known login/sudo passwords are redacted across output chunk boundaries; raw
SSH/credential-library logging is disabled. Arbitrary server output may contain
other secrets, and commands can change or expose remote data. Unrestricted local
CLI processes running as the same OS user are not isolated from the OS credential
store by this feature.

## Local validation

- `cargo test -p atlas-ssh --lib`: loopback SSH lifecycle, authorization, host-key
  mismatch, redaction, project exclusion and disposable Windows credential tests.
- `cargo test -p atlas --lib ssh_http_offer_identity_approval_and_revocation`: HTTP
  MCP identity binding, independent offers, approval and revoked-token rejection.
- Frontend SSH management and layout tests, TypeScript checking and Vite build.
- Synthetic browser preview: `?scenario=ssh`; no production server or credentials.

macOS Keychain access and a real remote server require verification on their actual
environments. The synthetic preview does not establish live server connectivity.

On this Windows host, the existing NumKong dependency crashed MSVC 2019 with
`0xc0000005` at its normal C optimization level. App validation used process-local
`CFLAGS=/Od` to disable C optimization. This setting is not committed as a release
build configuration; normal optimized builds still need a compatible C toolchain.
The Windows test harness also needed an embedded Common Controls v6 manifest to
resolve `comctl32!TaskDialogIndirect`. This was applied only to the generated test
executable using the Windows SDK Manifest Tool; no system DLL or registry setting
was changed.

Validated locally: 11 SSH core tests, the HTTP MCP test, the transport log-filter
test, frontend management/layout/IPC contracts, TypeScript, lint and frontend build.
The full app library compiled with the temporary C optimization workaround above.
