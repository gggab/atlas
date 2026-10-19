// Read-only repository fixtures for the explorer, editor, terminal and chat diffs.
import type { BlameLine } from "@/features/git/lib/git-blame-api";
import type { CommitFile, DiffLineStatus, FileDiff } from "@/features/git/lib/git-diff-api";
import type { GitSnapshotWire } from "@/features/git/stores/git-store";
import type { RawGitStatus } from "@/features/terminal/components/block-terminal";
import type { GitSummary } from "@/features/projects/stores/project-git-store";
import type { TypedHandlers, Unread } from "../types";
import { ALL_PROJECTS, MOCK_PROJECT } from "../project";
import { binaryFileDiff, buildFileDiff, lineStatusOf } from "./diff";
import { fileText } from "./files";

/** Apply ordered substitutions, refusing to produce a no-op diff silently. */
function atHead(rel: string, edits: [find: string, replace: string][]): string {
  let text = fileText(rel);
  if (!text) throw new Error(`[mock-backend] no working-tree text for ${rel}`);
  for (const [find, replace] of edits) {
    if (!text.includes(find)) {
      throw new Error(
        `[mock-backend] HEAD fixture for ${rel} no longer matches: ${find.slice(0, 40)}`,
      );
    }
    text = text.replace(find, replace);
  }
  return text;
}

// ── HEAD content ──────────────────────────────────────────────────────────

const HEAD_API_TS = () =>
  atHead("src/lib/api.ts", [
    // Removed in HEAD → shows as added lines.
    [
      `  createdAt: z.coerce.date(),\n  plan: z.enum(["free", "team", "enterprise"]),\n`,
      `  createdAt: z.coerce.date(),\n`,
    ],
    // Modified lines → `changed` rows with word-level spans.
    [
      `const BASE = import.meta.env.VITE_API_BASE ?? "https://api.acme.dev";`,
      `const BASE = "https://api.acme.dev";`,
    ],
    [`    credentials: "include",\n`, ``],
    [
      `    throw new ApiError(res.status, \`\${init?.method ?? "GET"} \${path} failed\`);`,
      `    throw new Error("request failed");`,
    ],
    [
      `  listUsers: (page = 0, size = 50) => request<User[]>(\`/users?page=\${page}&size=\${size}\`),`,
      `  listUsers: () => request<User[]>("/users"),`,
    ],
    // The whole retry helper is new work → a run of added lines.
    [
      `\n/** Retry a request with exponential backoff — 5xx and network errors only. */`,
      `\n/* TODO(ACME-1184): retry 5xx here. */`,
    ],
  ])
    .replace(/export async function withRetry[\s\S]*$/, "")
    .trimEnd() + "\n";

const HEAD_LIB_RS = () =>
  atHead("src-tauri/src/lib.rs", [
    [`use std::collections::BTreeMap;\n`, `use std::collections::HashMap;\n`],
    [`    users: Mutex<BTreeMap<String, User>>,`, `    users: Mutex<HashMap<String, User>>,`],
    [
      `        let mut guard = self.users.lock().expect("cache poisoned");\n        guard.insert(user.id.clone(), user)`,
      `        let mut guard = self.users.lock().unwrap();\n        guard.insert(user.id.clone(), user)`,
    ],
    // Removed in HEAD → added lines in the working tree.
    [
      `    pub fn len(&self) -> usize {\n        self.users.lock().map(|g| g.len()).unwrap_or(0)\n    }\n`,
      ``,
    ],
    [
      `#[tauri::command]\npub async fn seat_limit(plan: Plan) -> Result<Option<u32>, String> {\n    Ok(plan.seat_limit())\n}\n\n`,
      ``,
    ],
  ]);

const HEAD_TOKENS_CSS = () =>
  atHead("src/styles/tokens.css", [
    [`  --accent: #6e9cff;`, `  --accent: #4f7fe0;`],
    [`  --destructive: #f2555a;\n`, ``],
    [`  --font-mono: "JetBrains Mono", ui-monospace, monospace;\n`, ``],
    [`.card[data-state="disabled"] {\n  opacity: 0.45;\n  pointer-events: none;\n}\n`, ``],
  ]);

const HEAD_README_MD = () =>
  atHead("README.md", [
    [`| \`src/styles\` | Design tokens — the only place raw colours appear |\n`, ``],
    [
      `- Every colour is a token in \`src/styles/tokens.css\`. No hex literals in JSX.`,
      `- Keep colours in one place.`,
    ],
  ]);

/** Deleted in the working tree — its diff is every line removed. */
const LEGACY_AUTH_TS = `import { api } from "./api";

/** @deprecated Session cookies replaced this in 2.3. Delete after ACME-1184. */
export function readLegacyToken(): string | null {
  const raw = window.localStorage.getItem("acme.token");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(atob(raw.split(".")[1] ?? "")) as { exp?: number };
    if (parsed.exp && parsed.exp * 1000 < Date.now()) return null;
    return raw;
  } catch {
    return null;
  }
}

export async function migrateLegacySession(): Promise<boolean> {
  const token = readLegacyToken();
  if (!token) return false;
  await api.listUsers();
  window.localStorage.removeItem("acme.token");
  return true;
}
`;

// ── working-tree status ───────────────────────────────────────────────────

interface FakeChange {
  path: string;
  status: string;
  staged: boolean;
  /** Old and new text; `null` on either side means created / deleted. */
  before: () => string;
  after: () => string;
  binary?: boolean;
}

const CHANGES: FakeChange[] = [
  {
    path: "src/lib/api.ts",
    status: "modified",
    staged: false,
    before: HEAD_API_TS,
    after: () => fileText("src/lib/api.ts"),
  },
  {
    path: "src-tauri/src/lib.rs",
    status: "modified",
    staged: false,
    before: HEAD_LIB_RS,
    after: () => fileText("src-tauri/src/lib.rs"),
  },
  {
    path: "src/styles/tokens.css",
    status: "modified",
    staged: true,
    before: HEAD_TOKENS_CSS,
    after: () => fileText("src/styles/tokens.css"),
  },
  {
    path: "README.md",
    status: "modified",
    staged: true,
    before: HEAD_README_MD,
    after: () => fileText("README.md"),
  },
  {
    path: "src/components/badge.tsx",
    status: "untracked",
    staged: false,
    before: () => "",
    after: () => fileText("src/components/badge.tsx"),
  },
  {
    path: "src/legacy/auth.ts",
    status: "deleted",
    staged: true,
    before: () => LEGACY_AUTH_TS,
    after: () => "",
  },
  {
    path: "public/logo.png",
    status: "modified",
    staged: false,
    before: () => "",
    after: () => "",
    binary: true,
  },
];

const changeFor = (file: string) => CHANGES.find((change) => change.path === file);

function diffFor(file: string): FileDiff {
  const change = changeFor(file);
  if (change) {
    return change.binary
      ? binaryFileDiff(file)
      : buildFileDiff(change.before(), change.after(), file);
  }
  // Not a file this fixture tracks as dirty (another scenario's status, say):
  // show it as if its first line had just been added, rather than blank.
  const text = fileText(file);
  return buildFileDiff(text.split("\n").slice(1).join("\n"), text, file);
}

// ── branches, stashes, commits ────────────────────────────────────────────

const SEED_BRANCHES: BranchInfo[] = [
  {
    name: "main",
    isCurrent: true,
    isRemote: false,
    upstream: "origin/main",
    ahead: 3,
    behind: 1,
    subject: "feat(api): move user reads onto /v2",
    date: "2026-09-17T09:12:00Z",
  },
  {
    name: "feature/auth-v2",
    isCurrent: false,
    isRemote: false,
    upstream: "origin/feature/auth-v2",
    ahead: 0,
    behind: 4,
    subject: "Switch API client to v2 endpoints",
    date: "2026-09-16T17:40:00Z",
  },
  {
    name: "renovate/design-tokens-and-the-entire-colour-system-rewrite",
    isCurrent: false,
    isRemote: false,
    // No upstream yet — the "publish branch" affordance.
    upstream: null,
    ahead: 12,
    behind: 0,
    subject:
      "chore(deps): bump every design-token package and regenerate the palette, including the dark-mode ramp",
    date: "2026-09-15T08:05:00Z",
  },
  {
    name: "fix/pdf-annotations",
    isCurrent: false,
    isRemote: false,
    upstream: "origin/fix/pdf-annotations",
    ahead: 0,
    behind: 0,
    subject: "fix(pdf): keep highlight rects on rotate",
    date: "2026-09-12T14:22:00Z",
  },
  {
    // Grafted-in history with no common ancestor: the one branch whose merge
    // preview comes back `invalid`, which is otherwise unreachable.
    name: "vendor/import-upstream-history",
    isCurrent: false,
    isRemote: false,
    upstream: null,
    ahead: 214,
    behind: 0,
    subject: "vendor: import upstream at 42b5f05",
    date: "2026-08-28T11:00:00Z",
  },
  {
    name: "origin/main",
    isCurrent: false,
    isRemote: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    subject: "feat(api): move user reads onto /v2",
    date: "2026-09-17T09:12:00Z",
  },
  {
    name: "origin/feature/auth-v2",
    isCurrent: false,
    isRemote: true,
    upstream: null,
    ahead: 0,
    behind: 0,
    subject: "Switch API client to v2 endpoints",
    date: "2026-09-16T17:40:00Z",
  },
];

/** Live branch list: checkout, create, rename, delete and publish move it. */
const BRANCHES: BranchInfo[] = SEED_BRANCHES.map((branch) => ({ ...branch }));

const currentBranch = (): BranchInfo =>
  BRANCHES.find((branch) => branch.isCurrent && !branch.isRemote) ?? BRANCHES[0];

interface FakeCommit {
  sha: string;
  message: string;
  author: string;
  email: string;
  date: string;
  /** Parents, newest-first in this list; a second parent makes it a merge. */
  parents: string[];
  lane: number;
  refs: { name: string; kind: string; isCurrent: boolean }[];
  files: CommitFile[];
}

const COMMITS: FakeCommit[] = [
  {
    sha: "4f21a9033c1d8e77b0a5f1c2d3e4b5a6c7d8e9f0",
    message: "feat(api): move user reads onto /v2",
    author: "Dev",
    email: "dev@acme.dev",
    date: "2026-09-17T09:12:00Z",
    parents: ["9a1c2b3d4e5f60718293a4b5c6d7e8f901234567"],
    lane: 0,
    refs: [
      { name: "main", kind: "branch", isCurrent: true },
      { name: "origin/main", kind: "remote", isCurrent: false },
    ],
    files: [
      { path: "src/lib/api.ts", status: "M" },
      { path: "src/lib/utils.ts", status: "M" },
    ],
  },
  {
    sha: "9a1c2b3d4e5f60718293a4b5c6d7e8f901234567",
    message: "Merge branch 'fix/pdf-annotations'",
    author: "Dev",
    email: "dev@acme.dev",
    date: "2026-09-16T18:02:00Z",
    parents: [
      "1b2c3d4e5f60718293a4b5c6d7e8f9012345678a",
      "c0ffee11223344556677889900aabbccddeeff01",
    ],
    lane: 0,
    refs: [],
    files: [{ path: "src/components/header.tsx", status: "M" }],
  },
  {
    sha: "c0ffee11223344556677889900aabbccddeeff01",
    message: "fix(pdf): keep highlight rects on rotate",
    author: "Priya Raghunathan",
    email: "priya@acme.dev",
    date: "2026-09-16T11:48:00Z",
    parents: ["1b2c3d4e5f60718293a4b5c6d7e8f9012345678a"],
    lane: 1,
    refs: [{ name: "fix/pdf-annotations", kind: "branch", isCurrent: false }],
    files: [{ path: "src/components/button.tsx", status: "M" }],
  },
  {
    sha: "1b2c3d4e5f60718293a4b5c6d7e8f9012345678a",
    message: "refactor(tokens): one source of truth for colour",
    author: "Dev",
    email: "dev@acme.dev",
    date: "2026-09-15T16:30:00Z",
    parents: ["2c3d4e5f60718293a4b5c6d7e8f9012345678abc"],
    lane: 0,
    refs: [{ name: "v2.4.1", kind: "tag", isCurrent: false }],
    files: [{ path: "src/styles/tokens.css", status: "M" }],
  },
  {
    sha: "2c3d4e5f60718293a4b5c6d7e8f9012345678abc",
    message: "chore: drop the legacy token reader",
    author: "Sam Oyelaran",
    email: "sam@acme.dev",
    date: "2026-09-14T10:15:00Z",
    parents: ["3d4e5f60718293a4b5c6d7e8f9012345678abcde"],
    lane: 0,
    refs: [],
    files: [{ path: "src/legacy/auth.ts", status: "D" }],
  },
  {
    sha: "3d4e5f60718293a4b5c6d7e8f9012345678abcde",
    message:
      "feat(admin): paginate the user table, add the plan column, and stop refetching on window focus",
    author: "Dev",
    email: "dev@acme.dev",
    date: "2026-09-12T13:05:00Z",
    parents: ["4e5f60718293a4b5c6d7e8f9012345678abcdef0"],
    lane: 0,
    refs: [],
    files: [
      { path: "src/main.tsx", status: "M" },
      { path: "src/lib/api.ts", status: "M" },
    ],
  },
  {
    sha: "4e5f60718293a4b5c6d7e8f9012345678abcdef0",
    message: "build: move to Vite 6",
    author: "Priya Raghunathan",
    email: "priya@acme.dev",
    date: "2026-09-09T09:41:00Z",
    parents: ["5f60718293a4b5c6d7e8f9012345678abcdef012"],
    lane: 0,
    refs: [],
    files: [
      { path: "package.json", status: "M" },
      { path: "tsconfig.json", status: "M" },
    ],
  },
  {
    sha: "5f60718293a4b5c6d7e8f9012345678abcdef012",
    message: "docs: rewrite the README layout table",
    author: "Sam Oyelaran",
    email: "sam@acme.dev",
    date: "2026-09-05T15:20:00Z",
    parents: [],
    lane: 0,
    refs: [{ name: "v2.4.0", kind: "tag", isCurrent: false }],
    files: [{ path: "README.md", status: "M" }],
  },
];

const shortSha = (sha: string) => sha.slice(0, 7);

/** Per-line blame for the editor's inline annotation. */
function blame(file: string): BlameLine[] {
  const text = fileText(file);
  if (!text) return [];
  const change = changeFor(file);
  const lineCount = text.replace(/\n$/, "").split("\n").length;
  const touched = new Set(change && !change.binary ? lineStatusOf(diffFor(file)).changed : []);
  const added = new Set(change && !change.binary ? lineStatusOf(diffFor(file)).added : []);
  return Array.from({ length: lineCount }, (_, i) => {
    const line = i + 1;
    // Uncommitted lines are the ones this working tree changed.
    if (touched.has(line) || added.has(line)) {
      return {
        line,
        sha: "0000000000000000000000000000000000000000",
        shortSha: "0000000",
        author: "Not Committed Yet",
        timeMs: 0,
        summary: "Uncommitted changes",
        committed: false,
      };
    }
    const commit = COMMITS[(line * 7) % COMMITS.length];
    return {
      line,
      sha: commit.sha,
      shortSha: shortSha(commit.sha),
      author: commit.author,
      timeMs: Date.parse(commit.date),
      summary: commit.message,
      committed: true,
    };
  });
}

const HEAD = () => COMMITS[0];
let statsCache: { additions: number; deletions: number } | null = null;

/** Additions/deletions across the whole tree, for the sidebar summary.
 *  Recomputed only when something moved — it re-diffs every dirty file. */
function treeStats(): { additions: number; deletions: number } {
  if (statsCache) return statsCache;
  let additions = 0;
  let deletions = 0;
  for (const change of CHANGES) {
    if (change.binary) continue;
    const stats = buildFileDiff(change.before(), change.after(), change.path).stats;
    additions += stats.additions;
    deletions += stats.deletions;
  }
  statsCache = { additions, deletions };
  return statsCache;
}

// ── handlers ──────────────────────────────────────────────────────────────

/** Per-project summaries: a dirty repo, a clean one, and a non-repo. */
const SUMMARIES: Record<string, GitSummary> = {
  [ALL_PROJECTS[1].path]: {
    isRepo: true,
    branch: "renovate/design-tokens-and-the-entire-colour-system-rewrite",
    headSubject: "chore(deps): bump every design-token package and regenerate the palette",
    dirty: false,
    additions: 0,
    deletions: 0,
  },
  [ALL_PROJECTS[2].path]: {
    isRepo: false,
    branch: "",
    headSubject: "",
    dirty: false,
    additions: 0,
    deletions: 0,
  },
};

function statusRows(): GitSnapshotWire["files"] {
  return CHANGES.map(({ path, status, staged }) => ({ path, status, staged, conflicted: false }));
}

export interface GitResponses {
  git_watch_start: Unread;
  git_watch_stop: Unread;
  git_workspace_summary: GitSummary;
  git_snapshot: GitSnapshotWire;
  git_status_fresh: RawGitStatus;
  git_commit_changed_files: CommitFile[];
  git_diff_structured: FileDiff;
  diff_structured_text: FileDiff;
  git_diff_line_status: DiffLineStatus;
  git_blame_file: BlameLine[];
}

export const gitHandlers: TypedHandlers<GitResponses> = {
  git_watch_start: () => null,
  git_watch_stop: () => null,
  git_workspace_summary: ({ path }): GitSummary => {
    if (String(path) === MOCK_PROJECT.path) {
      const { additions, deletions } = treeStats();
      return {
        isRepo: true,
        branch: currentBranch().name,
        headSubject: HEAD().message.split("\n")[0],
        dirty: CHANGES.length > 0,
        additions,
        deletions,
      };
    }
    return (
      SUMMARIES[String(path)] ?? {
        isRepo: false,
        branch: "",
        headSubject: "",
        dirty: false,
        additions: 0,
        deletions: 0,
      }
    );
  },
  git_snapshot: (): GitSnapshotWire => {
    const branch = currentBranch();
    return {
      isRepo: true,
      branch: branch.name,
      detached: false,
      upstream: branch.upstream,
      ahead: branch.ahead,
      behind: branch.behind,
      files: statusRows(),
    };
  },
  git_status_fresh: (): RawGitStatus => ({
    is_repo: true,
    branch: currentBranch().name,
    files: statusRows().map((row) => ({
      path: row.path,
      status: row.status,
      staged: row.staged,
    })),
    ahead: currentBranch().ahead,
    behind: currentBranch().behind,
  }),
  git_commit_changed_files: ({ sha }): CommitFile[] =>
    COMMITS.find((commit) => commit.sha.startsWith(String(sha)))?.files ?? [],

  git_diff_structured: ({ file }): FileDiff => diffFor(String(file)),
  diff_structured_text: ({ oldText, newText, file }): FileDiff =>
    buildFileDiff(String(oldText ?? ""), String(newText ?? ""), String(file)),
  git_diff_line_status: ({ file }): DiffLineStatus => lineStatusOf(diffFor(String(file))),
  git_blame_file: ({ file }): BlameLine[] => blame(String(file)),
};

interface BranchInfo {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  subject: string;
  date: string;
}
