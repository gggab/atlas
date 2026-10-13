import { CornerDownRight, ListEnd, Loader2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/dropdown-menu";

export function QueuedMessage({
  text,
  onEdit,
  onRemove,
  onSteer,
  pending = false,
}: {
  text: string;
  onEdit: () => void;
  onRemove: () => void;
  onSteer?: () => void;
  pending?: boolean;
}) {
  const control =
    "flex h-control-sm shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-muted-foreground hover:bg-[var(--atlas-element-hover)] hover:text-foreground disabled:opacity-50 disabled:cursor-default cursor-pointer";
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-1.5 text-xs text-secondary-foreground">
      <ListEnd size={13} className="shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={text}>
        {text.replace(/\s+/g, " ")}
      </span>
      {onSteer && (
        <button
          type="button"
          onClick={onSteer}
          disabled={pending}
          className={control}
          aria-label="引导"
          title="Send into the running task"
        >
          {pending ? (
            <Loader2 size={13} className="animate-spin" aria-hidden />
          ) : (
            <CornerDownRight size={13} aria-hidden />
          )}
          <span>引导</span>
        </button>
      )}
      <button
        type="button"
        onClick={onRemove}
        disabled={pending}
        className={control}
        aria-label="Remove from queue"
        title="Remove from queue"
      >
        <Trash2 size={13} aria-hidden />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={pending}
          className={control}
          aria-label="Queued message options"
        >
          <MoreHorizontal size={13} aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil size={14} />
            Edit / merge into input
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
