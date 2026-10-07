import { create } from "zustand";
import { ssh, type Snapshot } from "../lib/api";

interface State extends Snapshot {
  selectedProject: string;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  selectProject: (path: string) => void;
}
export const useSshStore = create<State>((set, get) => ({
  connections: [],
  approvals: [],
  authorizations: [],
  sessions: [],
  jobs: [],
  selectedProject: "",
  loading: false,
  error: null,
  selectProject: (selectedProject) => set({ selectedProject }),
  refresh: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      set({ ...(await ssh.snapshot()), error: null });
    } catch (error) {
      set({ error: String(error) });
    } finally {
      set({ loading: false });
    }
  },
}));
