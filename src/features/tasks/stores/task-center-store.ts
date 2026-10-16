import { create } from "zustand";

/** Presentation only; Rust owns all task and execution state. */
export const useTaskCenter = create<{
  open: boolean;
  selectedId: string | null;
  show: (id?: string) => void;
  close: () => void;
}>((set) => ({
  open: false,
  selectedId: null,
  show: (id) => set({ open: true, selectedId: id ?? null }),
  close: () => set({ open: false }),
}));
