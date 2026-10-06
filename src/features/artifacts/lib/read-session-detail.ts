import { invoke } from "@tauri-apps/api/core";
import type { OpenSession } from "../stores/artifacts-store";
import type { SessionDetail } from "../types";
export interface DetailSources {
  local: (projectPath: string, sessionId: string) => Promise<SessionDetail | null>;
}
const tauriSources: DetailSources = {
  local: (projectPath, sessionId) => invoke("artifacts_session", { projectPath, sessionId }),
};
/** Read a local timeline. A missing record stays missing, without a cloud fallback. */
export async function readSessionDetail(
  open: Pick<OpenSession, "sessionId" | "projectPath">,
  sources: DetailSources = tauriSources,
): Promise<SessionDetail | null> {
  return open.projectPath ? sources.local(open.projectPath, open.sessionId) : null;
}
