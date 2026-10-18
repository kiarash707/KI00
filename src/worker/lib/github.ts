import type {
  BranchSummary,
  CommitSummary,
  RepoSummary,
  TreeEntry,
} from "../../shared/types";
import { ProviderError } from "./errors";
import { fetchWithTimeout, parseRetryAfter, sleep } from "./http";

const API_BASE = "https://api.github.com";
const MAX_FILE_BYTES = 300 * 1024;

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string; id: number };
  private: boolean;
  default_branch: string;
  description: string | null;
  language: string | null;
  updated_at: string | null;
  html_url: string;
  archived: boolean;
}

interface GitHubBranch {
  name: string;
  commit: { sha: string };
  protected: boolean;
}

interface GitHubTree {
  sha: string;
  tree: { path: string; type: string; size?: number; sha: string }[];
  truncated: boolean;
}

interface GitHubCommit {
  sha: string;
  commit: {
    message: string;
    author: { name: string; date: string } | null;
  };
}

interface GitHubContent {
  type: string;
  encoding?: string;
  content?: string;
  size: number;
  path: string;
}

export interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
  avatar_url: string;
}

export interface GitHubRateLimit {
  limit: number | null;
  remaining: number | null;
  resetAt: number | null;
}

export interface GitHubFileResult {
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

export class GitHubClient {
  private readonly token: string | null;
  private readonly baseUrl: string;

  constructor(options: { token?: string | null; baseUrl?: string } = {}) {
    this.token = options.token?.trim() || null;
    this.baseUrl = options.baseUrl ?? API_BASE;
  }

  static fromEnv(env: { GITHUB_TOKEN?: string }): GitHubClient {
    return new GitHubClient({ token: env.GITHUB_TOKEN });
  }

  get authenticated(): boolean {
    return Boolean(this.token);
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: { timeoutMs?: number; retries?: number } = {}
  ): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    const retries = options.retries ?? (method === "GET" ? 2 : 0);
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      let response: Response;
      try {
        response = await fetchWithTimeout(
          `${this.baseUrl}${path}`,
          {
            ...init,
            headers: {
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "KI00/0.1 (+https://github.com/kiarash707/KI00)",
              ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
              ...(init.body ? { "Content-Type": "application/json" } : {}),
              ...(init.headers ?? {}),
            },
          },
          options.timeoutMs ?? 20_000
        );
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          await sleep(400 * (attempt + 1));
          continue;
        }
        throw new ProviderError("github", 502, "GitHub API is unreachable", {
          code: "GITHUB_UNREACHABLE",
          hint: error instanceof Error ? error.message : "Network error",
        });
      }

      const text = await response.text();
      let payload: unknown = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = null;
      }

      if (response.ok) return payload as T;

      const message =
        (payload as { message?: string } | null)?.message ??
        `GitHub API returned HTTP ${response.status}`;

      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const after = parseRetryAfter(response.headers.get("retry-after"));
        await sleep(Math.min(after ?? 500 * (attempt + 1), 3000));
        continue;
      }

      const rateLimited =
        response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          message.toLowerCase().includes("rate limit"));
      if (rateLimited) {
        const reset = Number(response.headers.get("x-ratelimit-reset") ?? 0);
        lastError = new ProviderError("github", 429, "GitHub API rate limit reached", {
          code: "GITHUB_RATE_LIMIT",
          hint: reset
            ? `GitHub resets at ${new Date(reset * 1000).toISOString()}. Configure GITHUB_TOKEN for 5,000 requests/hour.`
            : "Configure GITHUB_TOKEN to raise the rate limit.",
        });
        throw lastError;
      }

      lastError = new ProviderError("github", response.status, message, {
        code: `GITHUB_${response.status}`,
        hint: hintForGitHubError(response.status, message),
      });
      throw lastError;
    }

    throw lastError instanceof Error ? lastError : new ProviderError("github", 502, "GitHub request failed");
  }

  async getUser(): Promise<GitHubUser> {
    return this.request<GitHubUser>("/user");
  }

  async getRateLimit(): Promise<GitHubRateLimit> {
    try {
      const result = await this.request<{
        resources: { core: { limit: number; remaining: number; reset: number } };
      }>("/rate_limit", {}, { retries: 0 });
      const core = result.resources?.core;
      return {
        limit: core?.limit ?? null,
        remaining: core?.remaining ?? null,
        resetAt: core?.reset ? core.reset * 1000 : null,
      };
    } catch {
      return { limit: null, remaining: null, resetAt: null };
    }
  }

  async listRepos(): Promise<RepoSummary[]> {
    const repos: RepoSummary[] = [];
    for (let page = 1; page <= 3; page++) {
      const batch = await this.request<GitHubRepo[]>(
        `/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&direction=desc&per_page=100&page=${page}`
      );
      for (const repo of batch) {
        repos.push({
          id: repo.id,
          name: repo.name,
          fullName: repo.full_name,
          owner: repo.owner.login,
          private: repo.private,
          defaultBranch: repo.default_branch,
          description: repo.description,
          language: repo.language,
          updatedAt: repo.updated_at,
          htmlUrl: repo.html_url,
          archived: repo.archived,
        });
      }
      if (batch.length < 100) break;
    }
    return repos;
  }

  async getRepo(owner: string, repo: string): Promise<RepoSummary> {
    const data = await this.request<GitHubRepo>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    );
    return {
      id: data.id,
      name: data.name,
      fullName: data.full_name,
      owner: data.owner.login,
      private: data.private,
      defaultBranch: data.default_branch,
      description: data.description,
      language: data.language,
      updatedAt: data.updated_at,
      htmlUrl: data.html_url,
      archived: data.archived,
    };
  }

  async getRepoOwnerId(owner: string, repo: string): Promise<number> {
    const data = await this.request<GitHubRepo>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
    );
    return data.owner.id;
  }

  async listBranches(owner: string, repo: string): Promise<BranchSummary[]> {
    const branches = await this.request<GitHubBranch[]>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches?per_page=100`
    );
    return branches.map((branch) => ({
      name: branch.name,
      protected: Boolean(branch.protected),
      sha: branch.commit.sha,
    }));
  }

  async getTree(
    owner: string,
    repo: string,
    ref: string,
    recursive = true
  ): Promise<{ entries: TreeEntry[]; truncated: boolean; sha: string }> {
    const data = await this.request<GitHubTree>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}${recursive ? "?recursive=1" : ""}`
    );
    return {
      sha: data.sha,
      truncated: Boolean(data.truncated),
      entries: data.tree.map((entry) => ({
        path: entry.path,
        type: entry.type === "tree" ? "tree" : entry.type === "commit" ? "commit" : "blob",
        size: typeof entry.size === "number" ? entry.size : null,
      })),
    };
  }

  async getFile(
    owner: string,
    repo: string,
    path: string,
    ref?: string
  ): Promise<GitHubFileResult | null> {
    const safePath = path
      .split("/")
      .filter((part) => part && part !== "." && part !== "..")
      .map((part) => encodeURIComponent(part))
      .join("/");
    try {
      const data = await this.request<GitHubContent | GitHubContent[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${safePath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`,
        {},
        { retries: 0 }
      );
      if (Array.isArray(data) || data.type !== "file" || !data.content) return null;
      if (data.size > MAX_FILE_BYTES) {
        return { path: data.path, content: "", size: data.size, truncated: true };
      }
      const binary = atob(data.content.replace(/\n/g, ""));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const content = new TextDecoder().decode(bytes);
      return { path: data.path, content, size: data.size, truncated: false };
    } catch (error) {
      if (error instanceof ProviderError && error.status === 404) return null;
      throw error;
    }
  }

  async getRecentCommits(owner: string, repo: string, ref: string): Promise<CommitSummary[]> {
    try {
      const commits = await this.request<GitHubCommit[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?sha=${encodeURIComponent(ref)}&per_page=10`
      );
      return commits.map((commit) => ({
        sha: commit.sha,
        message: commit.commit.message.split("\n")[0]?.slice(0, 240) ?? "",
        author: commit.commit.author?.name ?? "unknown",
        date: commit.commit.author?.date ?? null,
      }));
    } catch {
      return [];
    }
  }

  async getBranchHead(owner: string, repo: string, branch: string): Promise<string | null> {
    try {
      const data = await this.request<{ object: { sha: string } }>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`
      );
      return data.object?.sha ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Creates a branch with a commit of file patches, using the Git Data API.
   * The agent calls this only after an explicit approval.
   */
  async createPatchBranch(input: {
    owner: string;
    repo: string;
    baseBranch: string;
    newBranch: string;
    files: { path: string; content: string }[];
    message: string;
  }): Promise<{ branch: string; commitSha: string; url: string }> {
    if (input.files.length === 0 || input.files.length > 8) {
      throw new ProviderError("github", 400, "A patch must change between 1 and 8 files", {
        code: "GITHUB_PATCH_SIZE",
      });
    }
    let totalBytes = 0;
    for (const file of input.files) {
      if (!isSafeRepoPath(file.path)) {
        throw new ProviderError("github", 400, `Unsafe file path: ${file.path}`, {
          code: "GITHUB_UNSAFE_PATH",
        });
      }
      totalBytes += new TextEncoder().encode(file.content).length;
    }
    if (totalBytes > 240 * 1024) {
      throw new ProviderError("github", 400, "Patch exceeds the 240 KB limit", {
        code: "GITHUB_PATCH_TOO_LARGE",
      });
    }

    const owner = encodeURIComponent(input.owner);
    const repo = encodeURIComponent(input.repo);
    const headSha = await this.getBranchHead(input.owner, input.repo, input.baseBranch);
    if (!headSha) {
      throw new ProviderError("github", 404, `Base branch "${input.baseBranch}" was not found`, {
        code: "GITHUB_BRANCH_NOT_FOUND",
      });
    }

    const baseCommit = await this.request<GitHubCommit>(
      `/repos/${owner}/${repo}/git/commits/${headSha}`
    );
    const baseTreeSha = (baseCommit as unknown as { tree: { sha: string } }).tree?.sha;
    if (!baseTreeSha) {
      throw new ProviderError("github", 502, "Could not read the base tree from GitHub");
    }

    const treeEntries: { path: string; mode: "100644"; type: "blob"; sha: string }[] = [];
    for (const file of input.files) {
      const blob = await this.request<{ sha: string }>(`/repos/${owner}/${repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: file.content, encoding: "utf-8" }),
      });
      treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
    }

    const tree = await this.request<{ sha: string }>(`/repos/${owner}/${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
    });
    const commit = await this.request<{ sha: string }>(`/repos/${owner}/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: input.message.slice(0, 500),
        tree: tree.sha,
        parents: [headSha],
      }),
    });
    await this.request(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${input.newBranch}`, sha: commit.sha }),
    });

    return {
      branch: input.newBranch,
      commitSha: commit.sha,
      url: `https://github.com/${input.owner}/${input.repo}/tree/${encodeURIComponent(input.newBranch)}`,
    };
  }
}

export function isSafeRepoPath(path: string): boolean {
  if (!path || path.length > 300 || path.startsWith("/") || path.includes("\\")) return false;
  if (path.includes("\0")) return false;
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return false;
  if (parts[0] === ".git" || parts.includes(".git")) return false;
  if (parts.some((part) => part.startsWith(".env"))) return false;
  return /^[A-Za-z0-9._\-/]+$/.test(path);
}

function hintForGitHubError(status: number, message: string): string {
  const lower = message.toLowerCase();
  if (status === 401) {
    return "GITHUB_TOKEN is invalid or expired. Replace the Worker secret with a valid fine-grained PAT.";
  }
  if (status === 403 && lower.includes("saml")) {
    return "The GitHub organization requires SAML SSO authorization for this token.";
  }
  if (status === 403) {
    return "The token lacks the required repository permission. Contents:Read is required for analysis; Contents:Write for agent patches.";
  }
  if (status === 404) {
    return "Repository or branch not found, or the token cannot see it. Install the Cloudflare GitHub App and grant it repository access.";
  }
  return "Check the GitHub API response and the token repository access.";
}
