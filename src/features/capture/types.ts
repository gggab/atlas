/**
 * Capture control shapes, mirroring `atlas_checkpoint::health` and
 * `atlas_checkpoint::model`.
 *
 * Separate from the components so the Artifacts panel and the sidebar row can
 * both read them without importing each other.
 */

/**
 * `off` is a first-class state, not the absence of one.
 *
 * A Project nobody enabled is switched off, and a Project the developer
 * paused is switched off by choice. Neither is a fault — treating them as one
 * puts a red alarm on every Project a new user opens, which is what the first
 * version of this did.
 */
export type HealthState = "off" | "ok" | "degraded" | "stopped";

export interface HealthIssue {
  state: HealthState;
  reason: string;
  nextStep: string;
}

export interface CaptureHealth {
  state: HealthState;
  summary: string;
  issues: HealthIssue[];
  flaggedSessions: number;
}

export type ProjectMode = "local";

/**
 * `ok`, or `not_authorized` once the server rejected this identity. Terminal
 * until re-registration — mirrors `atlas_checkpoint::model::DrainGate`.
 */
export type DrainGate = "ok" | "not_authorized";

export interface Binding {
  /** Storage key (a `sessions.db` column + the capture wire) — this is the
   *  project's id. */
  workspaceId: string;
  root: string;
  mode: ProjectMode;
  slug: string | null;
  orgId: string | null;
  rootCommitSha: string | null;
  fingerprintIsShallow: boolean;
  gitUrl: string | null;
  enabled: boolean;
  /**
   * Has the developer approved the bulk transcript import? Always true for
   * Local; for Cloud only the disclosure confirmation sets it.
   */
  importApproved: boolean;
  drainState: DrainGate;
  /** Server-assigned Project id; `null` until registered. */
  remoteWorkspaceId: string | null;
  createdAt: string;
}

export interface Detection {
  root: string;
  isGitRepository: boolean;
  hasCommits: boolean;
  rootCommitSha: string | null;
  isShallow: boolean;
  gitUrl: string | null;
  suggestedSlug: string;
}

/**
 * What a bulk transcript import would disclose — mirrors
 * `atlas_checkpoint::ImportPreview`.
 */
export interface ImportPreview {
  /** Every transcript on disk, including ones an import would skip. */
  sessionCount: number;
  /** How many an import would actually take. Lead with this number. */
  newSessionCount: number;
  earliest: string | null;
  latest: string | null;
  totalBytes: number;
  isBulkDisclosure: boolean;
}
