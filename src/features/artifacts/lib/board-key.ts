import type { BoardSession } from "../types";
/** Session ids are scoped to their local project. */
export function boardKey(s: Pick<BoardSession, "id" | "projectPath">): string {
  return JSON.stringify([s.projectPath, s.id]);
}
