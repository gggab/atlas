# ADR-0020: Local MCP credentials stay out of adapter configuration

Status: Accepted (2026-10-20). Selectively adapts upstream alpha-0.4.1's bridge
design to the external-CLI workbench. Amends ADR-0010's HTTP-capability gate.
ADR-0019 in this fork remains the independent background backend decision.

## Decision

Every external ACP session receives host tools as stdio MCP entries. ACP requires
stdio support; HTTP capability negotiation remains diagnostic information and
continues to gate third-party HTTP entries. The host entry is the current binary
with `mcp-bridge <loopback URL> <token file>` and an empty environment list. An
adapter may serialize this entire entry into its command line or logs; none of
its fields contains the credential.

The bridge dispatches before profile initialization, background-role selection,
native browser hosting or window creation. It reads a private file and forwards
JSON-RPC to loopback HTTP without proxies or redirects. JSON-RPC errors are
returned intact. An expired HTTP session can be initialized again with the
client's own handshake; a revoked bearer token cannot be renewed this way.

Memory, code search, SSH, Browser Use, personal tools and task tools share one
token file per offer. Their existing independent settings, session purposes,
website/SSH approvals and task opt-in still decide access. Only read-only code
search retains adapter preapproval. A missing executable or failed file write
omits the tools with a warning and revokes the unused token; there is no HTTP
fallback carrying a credential.

The backend that owns the Agent also owns the token files. An unbound offer
removes its file on drop; a rebind removes its earlier file; session shutdown
revokes the token and removes its file. Each process owns a locked launch
directory. Startup sweeps only ended launches older than seven days. Unix files
use 0600 inside 0700 directories; Windows files inherit the user's app-data ACL.
This restricts cross-user exposure, not processes already running as that user.

## Boundaries and verification

No native execution engine, account, cloud service or automatic project-memory
injection is introduced. Tool availability never proves a model retrieved it.
Personal facts and scheduled tasks keep their separate stores and authorities.

Tests cover token omission from serialized entries, mandatory stdio without HTTP
support, shared service identity, permission preservation, offer/session cleanup,
loopback restrictions, error relay and reconnect. A real Windows process-launch
check is separate from in-process transport tests and browser mocks. See
[development checks](../reference/upstream-0.4.1-ports.md).
