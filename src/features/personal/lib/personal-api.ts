import { invoke } from "@tauri-apps/api/core";
import type { SessionKey, SessionMessage, SessionSnapshot, ImageAttachment } from "@/types/agents";
import type { CalendarSpec, ScheduledTask } from "@/features/tasks/lib/tasks-api";

export interface PersonalMemory {
  id: string;
  revision: number;
  key: string;
  kind: "fact" | "preference";
  content: string;
  confirmed: boolean;
  sourceMessageId: string;
  sourceThreadId: string;
  updatedAt: number;
  origin?: "manual" | "automatic";
  evidenceQuote?: string;
  core?: boolean;
}
export interface MemoryCandidate {
  id: string;
  revision: number;
  input: {
    id?: string | null;
    expectedRevision?: number | null;
    key: string;
    kind: "fact" | "preference";
    content: string;
    core?: boolean | null;
    evidenceQuote: string;
    question?: string | null;
    sourceMessageId: string;
  };
  sourceThreadId: string;
  createdAt: number;
}
export interface Proposal {
  id: string;
  revision: number;
  input: {
    title: string;
    prompt: string;
    dueAt: number;
    calendar?: CalendarSpec | null;
    intervalMinutes?: number | null;
    questions: string[];
  };
  state: "pending" | "registering";
  sourceThreadId: string;
}
export interface PersonalSnapshot {
  directory: string;
  currentThreadId: string | null;
  conversations: { threadId: string; sessionId: string; agent: string }[];
  history: { sessionId: string; messages: SessionMessage[] }[];
  memories: PersonalMemory[];
  memoryCandidates: MemoryCandidate[];
  proposals: Proposal[];
}
export const personalSnapshot = () => invoke<PersonalSnapshot>("personal_snapshot");
export const personalSession = (agentId?: string, threadId?: string) =>
  invoke<{
    key: SessionKey;
    directory: string;
    contextRestarted: boolean;
    toolsAvailable: boolean;
    snapshot: SessionSnapshot;
  }>("personal_session", { agentId, threadId });
export const savePersonalMemory = (
  input: {
    id?: string;
    expectedRevision?: number;
    key: string;
    kind: "fact" | "preference";
    content: string;
    confirmed: boolean;
    core?: boolean;
  },
  relearn = false,
) =>
  invoke<PersonalMemory>("personal_save_memory", {
    input: { ...input, sourceMessageId: "" },
    relearn,
  });
export const confirmMemory = (candidate: MemoryCandidate) =>
  invoke<PersonalMemory>("personal_confirm_memory", {
    id: candidate.id,
    revision: candidate.revision,
  });
export const dismissMemory = (candidate: MemoryCandidate) =>
  invoke<void>("personal_dismiss_memory", { id: candidate.id, revision: candidate.revision });
export const forgetPersonalMemory = (memory: PersonalMemory) =>
  invoke<void>("personal_forget_memory", { id: memory.id, revision: memory.revision });
export const confirmProposal = (proposal: Proposal) =>
  invoke<ScheduledTask>("personal_confirm_proposal", {
    id: proposal.id,
    revision: proposal.revision,
  });
export const dismissProposal = (proposal: Proposal) =>
  invoke<void>("personal_dismiss_proposal", { id: proposal.id, revision: proposal.revision });
export const sendPersonalMessage = (
  key: SessionKey,
  text: string,
  attachments?: ImageAttachment[],
  resourceLinks?: { uri: string; name: string }[],
) =>
  invoke<{ sourceMessageId: string; context: string }>("agents_send", {
    key,
    text,
    attachments: attachments?.length ? attachments : null,
    resourceLinks: resourceLinks?.length ? resourceLinks : null,
    personalTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
