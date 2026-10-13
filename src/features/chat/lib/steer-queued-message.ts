import { isBusyAgentStatus, type ChatSession } from "@/types/agent";
import { agents } from "./agents-api";
import { useChatStore } from "../stores/chat-store";

/** Capability comes from this connection's initialize response, never its brand. */
export function canSteer(session: ChatSession | undefined, supported: boolean): boolean {
  return !!(
    supported &&
    session?.acpAgentId &&
    session.acpSessionId &&
    isBusyAgentStatus(session.status) &&
    !session.stopping &&
    !session.disconnected &&
    !session.resumePending &&
    !session.unrestoredModeId &&
    !session.steeringNeedsStop
  );
}

/** Keep the queue parked until the agent acknowledges the selected input. */
export async function steerQueuedMessage(tabId: string, index: number) {
  const state = useChatStore.getState();
  const session = state.sessions[tabId];
  const text = state.queues[tabId]?.[index];
  if (!canSteer(session, true) || session.steeringPending || text === undefined) {
    throw new Error("The session cannot accept steering right now.");
  }
  const key = { agent_id: session.acpAgentId!, session_id: session.acpSessionId! };
  const stillBound = () => {
    const current = useChatStore.getState().sessions[tabId];
    return current?.acpAgentId === key.agent_id && current.acpSessionId === key.session_id;
  };
  state.actions.setSteeringPending(tabId, true);
  try {
    const outcome = await agents.steer(key, text);
    if (stillBound() && outcome !== "prompt_required") {
      const current = useChatStore.getState();
      if (current.queues[tabId]?.[index] === text) current.actions.removeQueueItem(tabId, index);
      current.actions.addMessage(tabId, "user", text);
      if (outcome === "started_new_turn") {
        useChatStore.setState((s) => ({
          sessions: {
            ...s.sessions,
            [tabId]: {
              ...s.sessions[tabId],
              status: "running",
              steeringNeedsStop: true,
            },
          },
        }));
      }
    }
    return outcome;
  } finally {
    if (stillBound()) useChatStore.getState().actions.setSteeringPending(tabId, false);
  }
}
