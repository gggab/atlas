// The four surfaces that talk to something outside Atlas: the Atlas account
// (organisations, members, invitations), GitHub, the feedback panel with its
// native screenshot, and PDF annotations.
//
// They are one file because they share one fact — none of them can be reached
// from a browser, so every one of them is invisible until it is faked here.
//
// The account fakes start **signed in**. Signed out, the org switcher shows a
// "Connect" button and the members/invitations screens are unreachable, so a
// signed-out base would leave three quarters of `src/features/organisations/`
// with no way in. Sign-out still works (and sign-in back in, through a real
// `connecting` phase), so the signed-out half is a click away rather than the
// only thing on offer.
//
// Mutations here are real: inviting, removing, renaming the active org,
// cloning a repo, dropping a PDF highlight — all of them change what the next
// read returns, for the life of the page.

import type { ClonedRepo, GithubRepo, RepoMeta } from "@/features/github/types";
import type { PdfAnnotation } from "@/features/pdf/stores/pdf-annotation-store";
import type { TypedHandlers, Unread } from "../types";
import { abs } from "../project";

/**
 * Fail a command the way Rust fails it.
 *
 * Every command in this file returns `Result<_, String>`, so `invoke` rejects
 * with a **bare string** — and the callers branch on exactly that
 * (`typeof e === "string" ? e : "Couldn't …"`). Rejecting with an `Error`
 * instead silently swaps every message below for the caller's generic
 * fallback, which is the opposite of what a fixture chosen for its wording is
 * for. Elsewhere in the mock backend `throw new Error(…)` is fine: nothing
 * reads those messages.
 */
function fail(message: string): never {
  // oxlint-disable-next-line no-throw-literal -- Rust's `Err(String)`, not an Error.
  throw message;
}

/** Fixed "now", so every relative date below reads the same on every reload. */
const NOW = Date.parse("2026-09-18T11:30:00Z");
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(NOW + offsetDays * DAY).toISOString();

// ── GitHub ──────────────────────────────────────────────────────────────────

const repoMeta = (
  description: string,
  language: string,
  stars: number,
  forks: number,
  fullName: string,
  updatedAt: string,
): RepoMeta => ({
  description,
  language,
  stars,
  forks,
  html_url: `https://github.com/${fullName}`,
  updated_at: updatedAt,
});

const searchRow = (fullName: string, meta: RepoMeta): GithubRepo => ({
  name: fullName.split("/")[1],
  full_name: fullName,
  description: meta.description,
  html_url: meta.html_url,
  clone_url: `https://github.com/${fullName}.git`,
  language: meta.language,
  stars: meta.stars,
  forks: meta.forks,
  updated_at: meta.updated_at,
});

/**
 * What GitHub search can hand back. Note that Rust `unwrap_or("")`s every
 * string field, so a repo with no description or no detected language arrives
 * as an **empty string**, never `null` — the rows below keep that exact shape.
 *
 * `GithubRepo` carries no `archived` flag (the Rust mapper drops it), so an
 * archived repo is only ever visible as its own `[ARCHIVED]` description and a
 * years-stale `updated_at`, which is how it reads in the panel.
 */
const SEARCH_RESULTS: GithubRepo[] = [
  searchRow(
    "acme/design-tokens",
    repoMeta(
      "Design tokens for the Acme product suite — colours, type ramp, spacing.",
      "TypeScript",
      2_184,
      147,
      "acme/design-tokens",
      iso(-4),
    ),
  ),
  searchRow(
    "vercel/swr",
    repoMeta("React Hooks for Data Fetching", "TypeScript", 31_204, 1_288, "vercel/swr", iso(-11)),
  ),
  searchRow(
    "acme/legacy-billing",
    repoMeta(
      "[ARCHIVED] Superseded by acme/billing-v2. Kept for the migration scripts only.",
      "Ruby",
      86,
      12,
      "acme/legacy-billing",
      iso(-1_390),
    ),
  ),
  searchRow(
    "openobserve/telemetry-pipeline",
    repoMeta(
      "A horizontally scalable, vendor-neutral pipeline for collecting, buffering, enriching, redacting and forwarding OpenTelemetry traces, metrics and logs to any number of downstream sinks, with a declarative YAML configuration, a hot-reloadable rule engine, back-pressure aware batching, and first-class support for running as a sidecar, a DaemonSet or a standalone binary on constrained edge hardware.",
      "Rust",
      9_431,
      612,
      "openobserve/telemetry-pipeline",
      iso(-2),
    ),
  ),
  // No description and no detected language: both arrive as "", and the row
  // has to survive rendering nothing rather than "undefined".
  searchRow("acme/scratch", repoMeta("", "", 3, 0, "acme/scratch", iso(-201))),
  searchRow(
    "rust-lang/rust",
    repoMeta(
      "Empowering everyone to build reliable and efficient software.",
      "Rust",
      104_882,
      13_507,
      "rust-lang/rust",
      iso(-1),
    ),
  ),
];

const ACME_TOKENS_README = `# @acme/design-tokens

The single source of truth for Acme's colours, type ramp and spacing. Every
surface — web, iOS, the desktop app — reads from the same generated files.

## Install

\`\`\`bash
bun add @acme/design-tokens
\`\`\`

## Usage

\`\`\`ts
import { tokens } from "@acme/design-tokens";

document.documentElement.style.setProperty("--background", tokens.color.bg.base);
\`\`\`

## Layers

| Layer     | What it holds                         | Changes           |
| --------- | ------------------------------------- | ----------------- |
| primitive | Raw values (\`blue.500\`, \`space.4\`)    | Almost never      |
| semantic  | Roles (\`bg.base\`, \`text.secondary\`)   | Per theme         |
| component | Component overrides (\`button.bg\`)     | Per release       |

> Semantic tokens are the only layer product code may read. A component
> reaching past them into a primitive is a review comment, not a preference.

## Releasing

1. \`bun run build\` regenerates \`dist/\` for all four targets.
2. \`bun run check:contrast\` fails the build on any pair under 4.5:1.
3. Tag \`vX.Y.Z\`; CI publishes.
`;

const SWR_README = `# SWR

The name "SWR" is derived from \`stale-while-revalidate\`, a cache invalidation
strategy popularized by HTTP [RFC 5861](https://tools.ietf.org/html/rfc5861).

\`\`\`jsx
import useSWR from "swr";

function Profile() {
  const { data, error, isLoading } = useSWR("/api/user", fetcher);

  if (error) return <div>failed to load</div>;
  if (isLoading) return <div>loading…</div>;
  return <div>hello {data.name}!</div>;
}
\`\`\`

## Why

| Without SWR                  | With SWR                         |
| ---------------------------- | -------------------------------- |
| Manual loading/error state   | Returned from the hook           |
| Refetch on focus by hand     | Built in                         |
| Duplicate requests per page  | Deduplicated inside the interval |
`;

/** README text by on-disk directory name. A repo missing from here throws the
 *  same "No README found" Rust does — which is the state `acme-legacy-billing`
 *  is in, and what the knowledge panel's empty README pane is for. */
const READMES: Record<string, string> = {
  "acme-design-tokens": ACME_TOKENS_README,
  "vercel-swr": SWR_README,
};

const clonedRepo = (fullName: string, branch: string | null, meta: RepoMeta | null): ClonedRepo => {
  const name = fullName.replace("/", "-");
  return {
    name,
    display_name: fullName,
    path: abs(`.atlas/repos/${name}`),
    has_readme: name in READMES,
    branch,
    meta,
  };
};

/**
 * Already on disk under `<project>/.atlas/repos`.
 *
 * Three states that the panel handles differently: a healthy clone on a branch,
 * one with a **detached HEAD** (`branch: null` — its update button must refuse
 * rather than guess), and one cloned before Atlas cached any metadata
 * (`meta: null`), which the panel notices and back-fills through
 * `fetch_cloned_repo_meta` on its own, one row at a time.
 */
let clonedRepos: ClonedRepo[] = [
  clonedRepo(
    "acme/design-tokens",
    "main",
    repoMeta(
      "Design tokens for the Acme product suite — colours, type ramp, spacing.",
      "TypeScript",
      2_184,
      147,
      "acme/design-tokens",
      iso(-4),
    ),
  ),
  clonedRepo(
    "vercel/swr",
    null,
    repoMeta("React Hooks for Data Fetching", "TypeScript", 31_204, 1_288, "vercel/swr", iso(-11)),
  ),
  clonedRepo("acme/legacy-billing", "master", null),
];

const REMOTE_BRANCHES: Record<string, string[]> = {
  "acme-design-tokens": ["main", "next", "release/3.x", "renovate/bun-1.x"],
  "vercel-swr": ["main", "v1", "canary"],
};

// ── PDF annotations ─────────────────────────────────────────────────────────

/** The two-page PDF seeded into the fake tree. Annotations are keyed by the
 *  PDF's absolute path, exactly as Rust keys `.atlas/pdf-annotations.json`. */
const SPEC_PDF = abs("docs/spec.pdf");

/**
 * Seeded so the viewer opens onto something: two highlights on page 1 (one of
 * them a second colour, so the swatch is visibly not hardcoded) and a note on
 * page 2 whose body is long enough to test the note editor's wrapping and the
 * tooltip, rather than the one-word note everyone writes by hand.
 *
 * Geometry is normalized 0..1 of the page, so these land in the same place at
 * every zoom level.
 */
const SEEDED_ANNOTATIONS: PdfAnnotation[] = [
  {
    kind: "highlight",
    id: "ann-seed-h1",
    page: 1,
    color: "#F5C542",
    createdAt: iso(-2),
    rect: { x: 0.12, y: 0.21, w: 0.63, h: 0.028 },
  },
  {
    kind: "highlight",
    id: "ann-seed-h2",
    page: 1,
    color: "#6796E6",
    createdAt: iso(-2),
    rect: { x: 0.12, y: 0.42, w: 0.41, h: 0.028 },
  },
  {
    kind: "note",
    id: "ann-seed-n1",
    page: 2,
    color: "#5CC28A",
    createdAt: iso(-1),
    // A note is a pin, not a box: `x`/`y` are the anchor, and the body below is
    // only ever seen through the editor it opens.
    x: 0.78,
    y: 0.33,
    text:
      "This paragraph contradicts §2.1: there the retry budget is described as per-connection, " +
      "and here it is per-request. Worth deciding before the client is generated, because the " +
      "generator reads this section and not that one — and whichever it picks becomes the " +
      "behaviour every downstream service inherits without anyone reading either paragraph again.",
  },
];

const pdfAnnotations = new Map<string, PdfAnnotation[]>([
  [SPEC_PDF, structuredClone(SEEDED_ANNOTATIONS)],
]);

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * What the frontend reads from each command below — the type argument of its
 * `invoke<T>`, or `Unread` where it awaits only success or failure.
 */
export interface IntegrationsResponses {
  search_github: GithubRepo[];
  clone_github_repo: string;
  list_cloned_repos: ClonedRepo[];
  read_repo_readme: string;
  delete_cloned_repo: Unread;
  list_remote_branches: string[];
  switch_cloned_repo_branch: Unread;
  update_cloned_repo: string;
  fetch_cloned_repo_meta: ClonedRepo["meta"];

  pdf_annotations_load: PdfAnnotation[];
  pdf_annotations_save: Unread;
}

export const integrationsHandlers: TypedHandlers<IntegrationsResponses> = {
  // ── GitHub ────────────────────────────────────────────────────────────────
  /**
   * Filtered rather than fixed, so the empty state ("zzz") and a narrowing
   * search ("swr") are both one keystroke away. The literal query `offline` is
   * the failure path — the panel's error line has no other way in.
   */
  search_github: async ({ query }): Promise<GithubRepo[]> => {
    const q = String(query ?? "")
      .trim()
      .toLowerCase();
    if (q === "offline") fail("GitHub API request failed: error sending request");
    // GitHub search is a round trip; without the wait the spinner never paints.
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (!q) return [];
    return SEARCH_RESULTS.filter((repo) =>
      `${repo.full_name} ${repo.description} ${repo.language}`.toLowerCase().includes(q),
    );
  },
  /** Slow on purpose: a `git clone` is the one action in the panel long enough
   *  that its per-row progress state is worth looking at. */
  clone_github_repo: async ({ repoName, meta }): Promise<string> => {
    const name = String(repoName);
    if (clonedRepos.some((r) => r.name === name)) {
      fail(`Repository '${name}' already cloned`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_400));
    // Rust derives the display name from the clone's own `origin`, which the
    // directory name cannot be un-mangled back into — `rust-lang-rust` splits
    // at the wrong hyphen. Look it up instead, and only guess when it came
    // from somewhere other than search.
    const known = SEARCH_RESULTS.find((row) => row.full_name.replace("/", "-") === name);
    clonedRepos = [
      ...clonedRepos,
      {
        name,
        display_name: known?.full_name ?? name.replace("-", "/"),
        path: abs(`.atlas/repos/${name}`),
        has_readme: name in READMES,
        branch: "main",
        meta: (meta ?? null) as RepoMeta | null,
      },
    ];
    return abs(`.atlas/repos/${name}`);
  },
  list_cloned_repos: (): ClonedRepo[] => clonedRepos.map((r) => ({ ...r })),
  read_repo_readme: ({ repoName }): string => {
    const readme = READMES[String(repoName)];
    if (readme === undefined) fail("No README found");
    return readme;
  },
  delete_cloned_repo: ({ repoName }): null => {
    clonedRepos = clonedRepos.filter((r) => r.name !== String(repoName));
    return null;
  },
  /** `ls-remote` over the network, so an unreachable remote is a real outcome:
   *  the repo Atlas has no cached metadata for is also the one that fails here,
   *  which is what the branch popover's error line is for. */
  list_remote_branches: async ({ repoName }): Promise<string[]> => {
    const name = String(repoName);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const branches = REMOTE_BRANCHES[name];
    if (!branches) fail("fatal: could not read from remote repository");
    return [...branches];
  },
  switch_cloned_repo_branch: async ({ repoName, branch }): Promise<string> => {
    const name = String(repoName);
    const next = String(branch);
    await new Promise((resolve) => setTimeout(resolve, 600));
    clonedRepos = clonedRepos.map((r) => (r.name === name ? { ...r, branch: next } : r));
    return next;
  },
  /** Refuses on a detached HEAD, exactly as Rust does — `vercel-swr` is seeded
   *  in that state precisely so the refusal is reachable. */
  update_cloned_repo: async ({ repoName }): Promise<string> => {
    const repo = clonedRepos.find((r) => r.name === String(repoName));
    if (!repo) fail("that repository is not cloned here");
    if (!repo.branch) fail("the clone is not on a branch — pick one first");
    await new Promise((resolve) => setTimeout(resolve, 900));
    return repo.branch;
  },
  /** The back-fill the panel runs, once, for every row whose `meta` is null. */
  fetch_cloned_repo_meta: async ({ repoName }): Promise<RepoMeta> => {
    const name = String(repoName);
    const repo = clonedRepos.find((r) => r.name === name);
    if (!repo) fail("cannot tell which GitHub repository this is");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const known = SEARCH_RESULTS.find((row) => row.full_name === repo.display_name);
    const meta: RepoMeta = known
      ? {
          description: known.description,
          language: known.language,
          stars: known.stars,
          forks: known.forks,
          html_url: known.html_url,
          updated_at: known.updated_at,
        }
      : repoMeta("", "", 0, 0, repo.display_name, iso(-900));
    clonedRepos = clonedRepos.map((r) => (r.name === name ? { ...r, meta } : r));
    return meta;
  },

  // ── Feedback ──────────────────────────────────────────────────────────────
  /**
   * Succeeds. The panel keeps the user's draft on a rejection and clears it on
   * success, so to see the failure half, `fail("…")` here — an empty
   * message and an inert telemetry key are the two ways Rust itself rejects.
   *
   * `anonymous` is what *happened*, not what was asked for: signed out, a
   * report is anonymous whether or not the box was ticked, and the panel says
   * "sent anonymously" off this field rather than off its own checkbox.
   */

  /**
   * Native `screencapture`. Returns a real decodable PNG so the preview, the
   * canvas downscale and the chat composer's inline attachment all work.
   *
   * The other half of this command is `null`, which is the user pressing Esc
   * during region selection and is deliberately not an error — return `null`
   * here to see the panel treat a cancelled capture as a no-op.
   */

  // ── PDF annotations ───────────────────────────────────────────────────────
  pdf_annotations_load: ({ pdfPath }): PdfAnnotation[] =>
    structuredClone(pdfAnnotations.get(String(pdfPath)) ?? []),
  /** Writes through to module state, so a highlight drawn here survives a tab
   *  switch and a reopen — the store reloads from this on every mount. */
  pdf_annotations_save: ({ pdfPath, annotations }): null => {
    const key = String(pdfPath);
    const next = (annotations ?? []) as PdfAnnotation[];
    // Rust drops the key entirely when the last annotation is erased, so the
    // file never accumulates entries for PDFs with nothing on them.
    if (next.length === 0) pdfAnnotations.delete(key);
    else pdfAnnotations.set(key, structuredClone(next));
    return null;
  },
};
