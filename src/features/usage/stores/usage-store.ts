import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { createSelectors } from "@/lib/create-selectors";
import { localProjectsSnapshot } from "@/features/projects/lib/project-scope";
import {
  NO_FACETS,
  type DateRange,
  type Facets,
  type GroupBy,
  type Metric,
  type TableTab,
  type UsageDashboard,
} from "../types";

/**
 * The Usage tab's data + view state. ONE Rust call (`usage_dashboard`) returns
 * every daily bucket for the active org's projects; range, facets, group-by
 * and metric are all applied CLIENT-SIDE (`use-usage-view.ts`), so none of
 * them needs a refetch. A refresh inside a minute for the same project set is
 * a no-op unless forced.
 */

/** A fetch younger than this is reused for the same project set. */
export const STALE_MS = 60_000;

type FacetAxis = keyof Facets;

interface UsageState {
  data: UsageDashboard | null;
  loading: boolean;
  error: string | null;
  fetchedAt: number | null;
  /** The project-path set the current `data` was fetched for. */
  projectSig: string;
  range: DateRange;
  facets: Facets;
  groupBy: GroupBy;
  metric: Metric;
  table: TableTab;
  search: string;
  actions: {
    refresh: (opts?: { force?: boolean }) => Promise<void>;
    setRange: (range: DateRange) => void;
    setFacets: (facets: Facets) => void;
    toggleFacet: (axis: FacetAxis, value: string) => void;
    clearFacets: () => void;
    setGroupBy: (groupBy: GroupBy) => void;
    setMetric: (metric: Metric) => void;
    setTable: (table: TableTab) => void;
    setSearch: (search: string) => void;
  };
}

function projectSignature(paths: string[]): string {
  return [...paths].sort().join("\n");
}

export const useUsageStore = createSelectors(
  create<UsageState>()((set, get) => ({
    data: null,
    loading: false,
    error: null,
    fetchedAt: null,
    projectSig: "",
    range: { preset: "30d" },
    facets: NO_FACETS,
    groupBy: "project",
    metric: "tokens",
    table: "sessions",
    search: "",
    actions: {
      refresh: async (opts) => {
        // Aggregate the local project registry.
        const projectPaths = localProjectsSnapshot().map((p) => p.path);
        const sig = projectSignature(projectPaths);
        const { fetchedAt, projectSig, loading } = get();
        const fresh = fetchedAt !== null && Date.now() - fetchedAt < STALE_MS && sig === projectSig;
        if (!opts?.force && (fresh || loading)) return;
        set({ loading: true, error: null });
        try {
          const data = await invoke<UsageDashboard>("usage_dashboard", { projectPaths });
          set({ data, loading: false, fetchedAt: Date.now(), projectSig: sig });
        } catch (e) {
          set({ error: String(e), loading: false });
        }
      },
      setRange: (range) => set({ range }),
      setFacets: (facets) => set({ facets }),
      toggleFacet: (axis, value) =>
        set((s) => {
          const cur = s.facets[axis];
          const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
          return { facets: { ...s.facets, [axis]: next } };
        }),
      clearFacets: () => set({ facets: NO_FACETS }),
      setGroupBy: (groupBy) => set({ groupBy }),
      setMetric: (metric) => set({ metric }),
      setTable: (table) => set({ table }),
      setSearch: (search) => set({ search }),
    },
  })),
);
