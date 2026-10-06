import type { SwitchableAgent } from "@/types/agent";
import { switchableAgentIds } from "@/features/agents/lib/agent-meta";
// An empty form selection means no agent is installed yet; callers never spawn it.
export function defaultAgentForNewSession(): SwitchableAgent {
  return switchableAgentIds()[0] ?? "";
}
