import { z } from "zod";

const safeString = (min: number, max: number) => z.string().trim().min(min).max(max);
const repoPart = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "Only letters, numbers, dots, dashes and underscores are allowed");

export const setupSchema = z.object({
  setupToken: z.string().min(1).max(400),
  name: safeString(1, 80),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(10, "Use at least 10 characters").max(200),
  workspaceName: safeString(1, 60).optional(),
});

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

export const createProjectSchema = z.object({
  name: safeString(2, 50).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, "Invalid project name"),
  description: z.string().trim().max(300).optional().default(""),
  repoOwner: repoPart,
  repoName: repoPart,
  repoId: z.union([z.string().max(40), z.number()]).optional().nullable(),
  branch: safeString(1, 120).regex(/^[A-Za-z0-9._/-]+$/, "Invalid branch name"),
  framework: safeString(1, 80),
  language: safeString(1, 40),
  projectType: safeString(1, 80),
  runtimeKind: z.enum(["static", "worker"]),
  runtimeDetail: z.string().max(200).optional().default(""),
  compatibilityStatus: z.enum(["compatible", "needs_adapter", "incompatible", "unknown"]),
  compatibilityNotes: z.array(z.string().max(500)).max(20).optional().default([]),
  installCommand: z.string().max(400).optional().default(""),
  buildCommand: z.string().max(400).optional().default(""),
  outputDir: z.string().max(160).optional().default("dist"),
  rootDir: z.string().max(160).optional().default("/"),
  spaFallback: z.boolean().optional().default(false),
  autoDeploy: z.boolean().optional().default(true),
  detectedEnvKeys: z.array(z.string().max(64)).max(60).optional().default([]),
  hasWranglerConfig: z.boolean().optional().default(false),
  wranglerHasRoutes: z.boolean().optional().default(false),
  acknowledgeRepoConfig: z.boolean().optional().default(false),
});

export const updateProjectSchema = z.object({
  name: safeString(2, 50).regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/, "Invalid project name").optional(),
  description: z.string().trim().max(300).optional(),
  branch: safeString(1, 120).regex(/^[A-Za-z0-9._/-]+$/, "Invalid branch name").optional(),
  installCommand: z.string().max(400).optional(),
  buildCommand: z.string().max(400).optional(),
  outputDir: z.string().max(160).optional(),
  rootDir: z.string().max(160).optional(),
  autoDeploy: z.boolean().optional(),
  buildCaching: z.boolean().optional(),
  spaFallback: z.boolean().optional(),
});

export const envVarSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Z][A-Z0-9_]*$/, "Use uppercase letters, digits and underscores, starting with a letter"),
  value: z.string().min(1, "A value is required").max(8192),
  isSecret: z.boolean().optional().default(true),
  scope: z.enum(["production", "preview"]).optional().default("production"),
  useBuild: z.boolean().optional().default(true),
  useRuntime: z.boolean().optional().default(false),
});

export const envVarUpdateSchema = envVarSchema.partial().extend({
  value: z.string().max(8192).optional(),
  useBuild: z.boolean().optional(),
  useRuntime: z.boolean().optional(),
});

export const domainSchema = z.object({
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(253)
    .regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "Enter a valid hostname"),
});

export const deploySchema = z.object({
  commitSha: z.string().regex(/^[a-f0-9]{7,40}$/i, "Invalid commit SHA").optional(),
  branch: z.string().max(120).regex(/^[A-Za-z0-9._/-]+$/).optional(),
  triggerKind: z.enum(["production", "preview"]).optional().default("production"),
  acknowledgeRepoConfig: z.boolean().optional().default(false),
  rollbackOf: z.string().max(64).optional(),
});

export const agentRunSchema = z.object({
  threadId: z.string().max(64).optional(),
  projectId: z.string().max(64).optional().nullable(),
  message: z.string().trim().min(1).max(8000),
  model: z.string().max(160).optional(),
});

export const approvalResolveSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
  perPage: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type CreateProjectBody = z.infer<typeof createProjectSchema>;
export type UpdateProjectBody = z.infer<typeof updateProjectSchema>;
export type EnvVarBody = z.infer<typeof envVarSchema>;
