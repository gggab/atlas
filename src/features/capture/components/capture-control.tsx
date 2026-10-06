import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { AtlasIcon } from "@/components/atlas-icon";

/** Open the local Timeline across the project registry. Recording status belongs to each project. */

export function CaptureControl() {
  const { addTab } = useLayoutStore.use.actions();

  return (
    // Styled as one row of the rail's fixed navigation (see `NavItem` in
    // project-sidebar.tsx) — same height, gaps and weights, so the five
    // rows read as one list.
    <button
      type="button"
      onClick={() =>
        addTab({
          id: "artifacts",
          type: "artifacts",
          title: "Timeline",
          closable: true,
          dirty: false,
          data: {},
        })
      }
      className="group/nav flex h-7 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-sm leading-none text-[var(--secondary-foreground)] outline-none transition-colors hover:bg-[var(--atlas-element-hover)] hover:text-[var(--foreground)] focus-visible:ring-1 focus-visible:ring-[var(--atlas-border-strong)]"
      title="Sessions recorded across local projects"
    >
      <AtlasIcon size={14} className="shrink-0 rounded-sm opacity-70 group-hover/nav:opacity-100" />
      <span className="truncate">Timeline</span>
    </button>
  );
}
