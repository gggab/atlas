# Steering a running CLI task

Messages typed while a task runs remain queued above the composer. Each message
uses a compact card: queue icon and text on the left, **引导**, remove, and an
edit menu on the right. Enter still queues the message; steering is an explicit
action on one selected message.

## Capability and transport

DeskMate enables the action only when the live ACP connection's `initialize`
response contains `_meta.steering.supported: true`. It sends
`_session/steering` with `sessionId`, `prompt`, and
`_meta.steering.idleBehavior: "promptRequired"`. There is no Agent-name allowlist,
model-name inference, cancellation followed by resending, or parallel
`session/prompt` used to simulate injection.

The installed `@agentclientprotocol/codex-acp` 2.2.2 and Claude Agent ACP 0.89.1 adapters explicitly
advertise this extension. This does not imply that every version supports it.
Kimi Wire, Qwen's queue-pull extension, Copilot SDK, and Pi RPC use other
interfaces: support in those interfaces does not enable this ACP path.
Antigravity and any adapter without this declaration keep the ordinary queue.

## Acknowledgements and turn boundaries

- `injected`: remove only the selected queued message and record it as user
  content inside the existing turn. No turn cancellation, checkpoint boundary,
  or new turn sequence is introduced.
- `promptRequired`: the active turn has ended. Leave the message queued; the
  normal queue sends it once the session is idle and the send gate opens.
- `startedNewTurn`: a legacy adapter ignored the idle contract and consumed the
  input in a detached turn. Remove it once, display an explicit explanation,
  and keep the task busy with a Stop action. ACP has no completion response for
  this detached turn, so the user must stop it before continuing. This protects
  against overlapping queue sends; it is not reported as successful injection.
- RPC errors or a failed/unknown acknowledgement: retain the queued message and
  surface the error. Do not fail or cancel the prompt already running, and do
  not retry the steering RPC automatically.

While acknowledgement is pending, queue draining, editing, removal, and another
steering click are held. Newly typed text can still queue. A late reply from an
old binding cannot mutate the replacement session. The action is unavailable
while stopping, disconnected, restoring a session/mode, or held by another
process. Text queues retain their existing attachment/mention limitations:
staged images stay in the composer for the next direct send.

Accepted input reaches DeskMate's transcript, interaction history, and current
turn capture. It does not increment capture's prompt counter or imply automatic
MCP memory retrieval.

## Development verification

Frontend tests cover capability gating, the queued card, selected input,
rejection, binding changes, double clicks, and completion/drain races. Rust
manager tests verify that injection preserves the active prompt and that the
legacy detached turn stays stoppable. The `atlas-agent-servers` steering tests
use a real Node.js child over stdio to verify the wire method and metadata,
strict handshake gating, outcomes, and the absence of cancel/re-prompt calls.
They require Node.js on PATH or `ATLAS_TEST_NODE` and never silently skip.

These tests do not make vendor model requests or establish real desktop/CLI
verification. A manual check requires a running vendor task, a queued message,
an explicit steering click, and inspection of the task's response.
