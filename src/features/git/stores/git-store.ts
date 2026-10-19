import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { createSelectors } from "@/lib/create-selectors";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface GitFileStatus {
  path: string;
  status: string;
  staged: boolean;
}

export interface GitLogEntry {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  date: string;
}

/** Wire shape of the coalesced read-only repository status. */
export interface GitSnapshotWire {
  isRepo: boolean;
  branch: string;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: {
    path: string;
    status: string;
    staged: boolean;
    origPath?: string;
    conflicted: boolean;
  }[];
}

let gitStatusFreshListenerInit = false;
function ensureGitStatusFreshListener(): void {
  if (gitStatusFreshListenerInit) return;
  gitStatusFreshListenerInit = true;
  void listen<{
    path: string;
    status: {
      is_repo: boolean;
      branch: string;
      files: GitFileStatus[];
      ahead: number;
      behind: number;
    };
  }>("atlas:git-status-fresh", (e) => {
    const current = useGitStore.getState().repoPath;
    if (!current || current !== e.payload.path) return;
    useGitStore.setState((s) => {
      s.isRepo = e.payload.status.is_repo;
      s.branch = e.payload.status.branch;
      s.files = e.payload.status.files;
      s.ahead = e.payload.status.ahead;
      s.behind = e.payload.status.behind;
    });
  });

  // External Git tools still update decorations and the diff commit picker.
  void listen<{ project: string }>("atlas:git-changed", (e) => {
    const current = useGitStore.getState().repoPath;
    if (!current || current !== e.payload.project) return;
    const actions = useGitStore.getState().actions;
    void actions.refresh(current).catch(() => {});
    void actions.loadLog(current).catch(() => {});
  });

  let projectDebounce: ReturnType<typeof setTimeout> | null = null;
  void listen("atlas:explorer:changed", () => {
    if (!useGitStore.getState().repoPath) return;
    if (projectDebounce) clearTimeout(projectDebounce);
    projectDebounce = setTimeout(() => {
      projectDebounce = null;
      const path = useGitStore.getState().repoPath;
      if (path)
        void useGitStore
          .getState()
          .actions.refreshStatusNow(path)
          .catch(() => {});
    }, 120);
  });
}

interface GitState {
  log: GitLogEntry[];
  isRepo: boolean;
  branch: string;
  files: GitFileStatus[];
  ahead: number;
  behind: number;
  loading: boolean;
  repoPath: string | null;
}

interface GitActions {
  actions: {
    loadLog: (path: string) => Promise<void>;
    loadStatus: (path: string) => Promise<void>;
    refresh: (path?: string) => Promise<void>;
    refreshStatusNow: (path?: string) => Promise<void>;
  };
}

export const useGitStore = createSelectors(
  create<GitState & GitActions>()(
    immer((set, get) => ({
      log: [],
      isRepo: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
      loading: false,
      repoPath: null,
      actions: {
        loadLog: async (path) => {
          try {
            const entries = await invoke<GitLogEntry[]>("git_log", { path, limit: 100 });
            set((s) => {
              s.log = entries;
            });
          } catch {
            /* not a repo */
          }
        },
        loadStatus: async (path) => {
          ensureGitStatusFreshListener();
          set((s) => {
            s.loading = true;
            s.repoPath = path;
          });
          await get().actions.refresh(path);
          set((s) => {
            s.loading = false;
          });
        },
        refresh: async (path) => {
          ensureGitStatusFreshListener();
          const p = path ?? get().repoPath;
          if (!p) return;
          // No `loading = true` here — in-place patch, no flicker.
          set((s) => {
            s.repoPath = p;
          });
          try {
            const snap = await invoke<GitSnapshotWire>("git_snapshot", { path: p });
            set((s) => {
              s.isRepo = snap.isRepo;
              s.branch = snap.branch;
              s.files = snap.files.map((f) => ({
                path: f.path,
                status: f.status,
                staged: f.staged,
              }));
              s.ahead = snap.ahead;
              s.behind = snap.behind;
            });
          } catch {
            /* not a repo / transient — leave prior state */
          }
        },
        refreshStatusNow: async (path) => {
          await get().actions.refresh(path);
        },
      },
    })),
  ),
);
