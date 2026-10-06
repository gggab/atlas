/**
 * Which actions a permission banner gets, and how an action maps back to an
 * ACP permission option — pure; `permission-actions.ts` performs the answer.
 *
 * Safety rules, all enforced here:
 *  - Only the `*_once` kinds are ever mapped. A banner never answers "always",
 *    whatever else the agent offered, and Deny never silently becomes
 *    `reject_always`: with no `*_once` counterpart the action is simply absent.
 *  - Allow needs the whole command/target on screen (`complete`, from
 *    `describePermissionDetail`). The OS may also clip a long body, so the
 *    description is capped well inside what macOS shows (80 chars + the
 *    "Needs approval — " lead ≈ 97 chars, two lines of banner body). A request
 *    whose command is cut, multi-line or unnamed gets Deny only.
 *  - Plan reviews, agent questions and outward organisation actions are never
 *    answered from a banner: their approval carries side effects (a mode
 *    switch), needs typed answers, or is a deliberate click by design.
 *  - Both actions require an unlocked device.
 */
import type { PermissionDecision, ToolCallRef } from "@/types/acp";
import { extractPlanMarkdown } from "@/features/chat/lib/plans";
import { extractQuestions } from "@/features/chat/lib/questions";
import { offerableActions, type NativeCapabilities } from "./native-capabilities";
import type { SystemNotificationAction } from "./notifier-api";

export const PERMISSION_ACTION_ALLOW = "perm:allow";
export const PERMISSION_ACTION_DENY = "perm:deny";

interface OptionLike {
  optionId: string;
  kind: string;
}

/** Defensive read of the delta's untyped `options`. */
export function parsePermissionOptions(raw: unknown): OptionLike[] {
  if (!Array.isArray(raw)) return [];
  const out: OptionLike[] = [];
  for (const o of raw) {
    if (typeof o !== "object" || o === null) continue;
    const r = o as Record<string, unknown>;
    if (typeof r.optionId === "string" && typeof r.kind === "string") {
      out.push({ optionId: r.optionId, kind: r.kind });
    }
  }
  return out;
}

const ONCE_KIND = { allow: "allow_once", deny: "reject_once" } as const;

function onceOption(options: readonly OptionLike[], which: "allow" | "deny"): string | null {
  return options.find((o) => o.kind === ONCE_KIND[which])?.optionId ?? null;
}

/** Whether a request may be answered from a banner at all. */
export function bannerAnswerable(toolCall: unknown): boolean {
  if (typeof toolCall !== "object" || toolCall === null) return true;
  const tc = toolCall as ToolCallRef;
  return !extractPlanMarkdown(tc) && !extractQuestions(tc);
}

export interface PermissionActionInput {
  options: readonly OptionLike[];
  /** The banner body shows the whole command/target. */
  complete: boolean;
  /** `bannerAnswerable(toolCall)`. */
  answerable: boolean;
  /** The user's `notifyPermissionActions` setting. */
  enabled: boolean;
  /** When given, the actions are fitted to the backend (none without actions
   *  + a response stream, at most `maxActions`). */
  caps?: NativeCapabilities;
}

export function permissionBannerActions(input: PermissionActionInput): SystemNotificationAction[] {
  if (!input.enabled || !input.answerable) return [];
  const actions: SystemNotificationAction[] = [];
  if (input.complete && onceOption(input.options, "allow")) {
    actions.push({ id: PERMISSION_ACTION_ALLOW, label: "Allow once", requiresUnlock: true });
  }
  if (onceOption(input.options, "deny")) {
    actions.push({
      id: PERMISSION_ACTION_DENY,
      label: "Deny",
      destructive: true,
      requiresUnlock: true,
    });
  }
  return input.caps ? offerableActions(input.caps, actions) : actions;
}

/** The wire answer for a tapped action, resolved against the request's
 *  CURRENT options (not the ones the banner was built from). Null for an
 *  unknown action or when no `*_once` option exists. */
export function permissionDecisionForAction(
  actionId: string,
  options: readonly OptionLike[],
): PermissionDecision | null {
  const which =
    actionId === PERMISSION_ACTION_ALLOW
      ? "allow"
      : actionId === PERMISSION_ACTION_DENY
        ? "deny"
        : null;
  if (!which) return null;
  const optionId = onceOption(options, which);
  return optionId ? { kind: "selected", option_id: optionId } : null;
}

/** What a banner's payload carries so an action can find its request. */
export interface PermissionRef {
  sessionId: string;
  requestId: string;
}

/** Everything the classifier knows about a request that bears on its banner
 *  actions; the setting is applied later, by the decision. */
export interface PermissionBannerInfo extends PermissionRef {
  options: OptionLike[];
  complete: boolean;
  answerable: boolean;
}
