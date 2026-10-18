import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireAuth } from "../lib/auth";
import { ApiError, formatZodError } from "../lib/errors";
import { GitHubClient } from "../lib/github";
import { analyzeRepository } from "../lib/analysis";
import { z } from "zod";
import { enforceRateLimit, workspaceLimitKey } from "./helpers";
import { recordAudit } from "../lib/activity";

export const githubRoutes = new Hono<AppEnv>();

const repoSchema = z.object({
  owner: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  repo: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/),
  branch: z.string().trim().max(120).regex(/^[A-Za-z0-9._/-]+$/).optional(),
});

githubRoutes.get("/github/repos", async (c) => {
  requireAuth(c);
  const client = GitHubClient.fromEnv(c.env);
  if (!client.authenticated) {
    throw new ApiError(424, "GITHUB_NOT_CONFIGURED", "GITHUB_TOKEN is not configured", {
      hint: "Add a fine-grained GitHub PAT with Metadata:Read and Contents:Read. You can still analyse a public repository by typing its owner/name manually.",
    });
  }
  const [repos, rate] = await Promise.all([client.listRepos(), client.getRateLimit()]);
  return c.json({
    repos,
    rateLimit: rate,
    hint: "Cloudflare also needs the Cloudflare GitHub App installed on a repository before Workers Builds can clone it.",
  });
});

githubRoutes.get("/github/branches", async (c) => {
  requireAuth(c);
  const parsed = repoSchema.safeParse({
    owner: c.req.query("owner"),
    repo: c.req.query("repo"),
  });
  if (!parsed.success) throw formatZodError(parsed.error);
  const client = GitHubClient.fromEnv(c.env);
  const branches = await client.listBranches(parsed.data.owner, parsed.data.repo);
  return c.json({ branches });
});

githubRoutes.post("/github/analyze", async (c) => {
  const { user, workspace } = requireAuth(c);
  const parsed = repoSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw formatZodError(parsed.error);
  await enforceRateLimit(
    c,
    workspaceLimitKey(c, "github:analyze"),
    30,
    10 * 60 * 1000
  );
  const client = GitHubClient.fromEnv(c.env);
  try {
    const analysis = await analyzeRepository(
      client,
      parsed.data.owner,
      parsed.data.repo,
      parsed.data.branch
    );
    await recordAudit(c, {
      workspaceId: workspace.id,
      action: "github.analyze",
      targetType: "repository",
      targetId: `${parsed.data.owner}/${parsed.data.repo}`,
      meta: { branch: analysis.branch, compatibility: analysis.detection.compatibilityStatus },
    });
    return c.json(analysis);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, "ANALYSIS_FAILED", error instanceof Error ? error.message : "Repository analysis failed", {
      hint: "Confirm the repository exists, the branch name is correct, and GITHUB_TOKEN can access it.",
    });
  } finally {
    void user;
  }
});
