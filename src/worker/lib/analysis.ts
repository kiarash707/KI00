import type { RepoAnalysis, TreeEntry } from "../../shared/types";
import type { GitHubClient } from "./github";
import { detectPackageManager, detectProject, suggestedProjectName } from "./detection";
import { now } from "./utils";

const KEY_BASENAMES = new Set([
  "package.json",
  "wrangler.jsonc",
  "wrangler.json",
  "wrangler.toml",
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yaml",
  "compose.yml",
  "tsconfig.json",
  ".env.example",
  ".env.sample",
  ".env.template",
  "example.env",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "astro.config.mjs",
  "astro.config.ts",
  "astro.config.js",
  "svelte.config.js",
  "svelte.config.ts",
  "nuxt.config.ts",
  "nuxt.config.js",
  "vite.config.ts",
  "vite.config.js",
  "angular.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "Gemfile",
  "composer.json",
  "index.html",
]);

const MAX_FILE_BYTES = 160 * 1024;
const MAX_KEY_FILES = 40;

export async function analyzeRepository(
  github: GitHubClient,
  owner: string,
  repoName: string,
  branch?: string
): Promise<RepoAnalysis> {
  const repo = await github.getRepo(owner, repoName);
  const targetBranch = (branch || repo.defaultBranch || "main").trim();
  const warnings: string[] = [];

  const [treeResult, branches, commits] = await Promise.all([
    github.getTree(owner, repoName, targetBranch),
    github.listBranches(owner, repoName),
    github.getRecentCommits(owner, repoName, targetBranch),
  ]);

  if (!branches.some((item) => item.name === targetBranch)) {
    throw new Error(`Branch "${targetBranch}" was not found in ${owner}/${repoName}`);
  }

  const headCommit = commits[0] ?? null;
  if (treeResult.truncated) {
    warnings.push(
      "GitHub truncated the repository tree. Detection used the visible portion; verify the proposed settings."
    );
  }

  const blobs = treeResult.entries.filter((entry) => entry.type === "blob");
  const selected = selectKeyFiles(blobs);
  if (selected.length >= MAX_KEY_FILES) {
    warnings.push(`Only the first ${MAX_KEY_FILES} configuration files were inspected.`);
  }

  const files: Record<string, string | null> = {};
  const concurrency = 6;
  for (let i = 0; i < selected.length; i += concurrency) {
    const batch = selected.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (path) => {
        try {
          const file = await github.getFile(owner, repoName, path, targetBranch);
          return [path, file ? (file.truncated ? null : file.content) : null] as const;
        } catch {
          return [path, null] as const;
        }
      })
    );
    for (const [path, content] of results) files[path] = content;
  }

  const paths = new Set(blobs.map((entry) => entry.path));
  const packageManager = detectPackageManager(paths);
  const detection = detectProject({
    repo: { name: repo.name, language: repo.language, defaultBranch: repo.defaultBranch },
    branch: targetBranch,
    tree: treeResult.entries,
    files,
    packageManager,
  });

  if (!github.authenticated) {
    warnings.push(
      "GitHub is being read anonymously (60 requests/hour). Set GITHUB_TOKEN for reliable analysis and deployment setup."
    );
  }
  if (repo.archived) {
    warnings.push("This GitHub repository is archived. New commits will not arrive automatically.");
  }
  if (detection.compatibilityStatus !== "compatible") {
    warnings.push(
      "This project is not deployable to Workers without changes. KI00 will not fake a successful deployment."
    );
  }

  detection.suggestedName = suggestedProjectName(repo.name);
  detection.warnings = [...new Set([...detection.warnings, ...warnings])];

  const compactTree: TreeEntry[] = treeResult.entries
    .filter((entry) => entry.type !== "commit")
    .slice(0, 600)
    .map((entry) => ({
      path: entry.path,
      type: entry.type,
      size: entry.size,
    }));

  return {
    repo,
    branch: targetBranch,
    commit: headCommit,
    tree: compactTree,
    treeTruncated: treeResult.truncated || treeResult.entries.length > compactTree.length,
    fileCount: blobs.length,
    detection,
    packageManager,
    warnings: [...new Set(warnings)],
    analyzedAt: now(),
  };
}

export function selectKeyFiles(blobs: TreeEntry[]): string[] {
  const chosen = new Map<string, number>();
  for (const blob of blobs) {
    const path = blob.path;
    if (path.includes("node_modules/") || path.startsWith(".git/")) continue;
    const depth = path.split("/").length - 1;
    if (depth > 3) continue;
    const base = path.slice(path.lastIndexOf("/") + 1);
    const isPackage = base === "package.json";
    const isEnvExample = /^\.env\.(example|sample|template)$/.test(base) || base === "example.env";
    if (!KEY_BASENAMES.has(base) && !isEnvExample) continue;
    const weight = depth * 10 + (isPackage ? 0 : 1);
    chosen.set(path, weight);
  }
  return [...chosen.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_KEY_FILES)
    .map(([path]) => path);
}

/** Reads a single file for agent context, with a hard size limit. */
export async function readRepoFileSafe(
  github: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<{ path: string; content: string; truncated: boolean; size: number } | null> {
  const file = await github.getFile(owner, repo, path, ref);
  if (!file) return null;
  if (file.size > MAX_FILE_BYTES || file.truncated) {
    return { path, content: file.content.slice(0, MAX_FILE_BYTES), truncated: true, size: file.size };
  }
  return { path, content: file.content, truncated: false, size: file.size };
}
