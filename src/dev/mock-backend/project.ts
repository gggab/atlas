// The local projects every scenario opens, and the
// helpers that turn a relative path into the absolute one Rust would see.
//
// The tree itself lives in `fixtures/files.ts` (with the files' real content),
// so `read_directory` and `read_file_content` can never disagree about which
// files exist.

import type { AppStateWire } from "@/features/app/stores/app-store";
import type { Project } from "@/features/projects/stores/project-store";

export const MOCK_PROJECT = {
  id: "ws-mock",
  name: "acme-app",
  path: "/Users/dev/acme-app",
  groupId: null,
} satisfies Project;

/**
 * Two more projects, for the surfaces that list or aggregate every project:
 * the switcher, the sidebar's per-project git summaries, and Mission
 * Control's project table. One carries a deliberately over-long name so
 * truncation is visible without hunting for a repro.
 */
export const OTHER_PROJECTS = [
  {
    id: "ws-mock-2",
    name: "acme-platform-migration-experiments",
    path: "/Users/dev/acme-platform-migration-experiments",
    groupId: null,
  },
  {
    id: "ws-mock-3",
    name: "docs",
    path: "/Users/dev/docs",
    groupId: null,
  },
] satisfies Project[];

export const ALL_PROJECTS: Project[] = [MOCK_PROJECT, ...OTHER_PROJECTS];

/** `path` relative to the project root. */
export const abs = (path: string) => `${MOCK_PROJECT.path}/${path}`;

export function appState(overrides: Partial<AppStateWire> = {}): AppStateWire {
  return {
    currentProject: null,
    recentProjects: [],
    workspaces: ALL_PROJECTS,
    groups: [],
    activeWorkspaceId: MOCK_PROJECT.id,
    configStatus: { status: "ok" },
    configGeneration: 1,
    version: 3,
    ...overrides,
  };
}
