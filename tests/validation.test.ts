import { describe, expect, it } from "vitest";
import {
  createProjectSchema,
  deploySchema,
  domainSchema,
  envVarSchema,
  envVarUpdateSchema,
  setupSchema,
} from "../src/worker/lib/validation";

const validProject = {
  name: "My App",
  repoOwner: "octocat",
  repoName: "hello-world",
  branch: "main",
  framework: "Static site",
  language: "HTML",
  projectType: "static",
  runtimeKind: "static" as const,
  compatibilityStatus: "compatible" as const,
};

describe("createProjectSchema", () => {
  it("accepts a minimal compatible static project and applies defaults", () => {
    const result = createProjectSchema.parse(validProject);
    expect(result.outputDir).toBe("dist");
    expect(result.rootDir).toBe("/");
    expect(result.autoDeploy).toBe(true);
    expect(result.compatibilityNotes).toEqual([]);
    expect(result.detectedEnvKeys).toEqual([]);
  });

  it("rejects a project name that starts with a symbol", () => {
    const result = createProjectSchema.safeParse({ ...validProject, name: "-bad" });
    expect(result.success).toBe(false);
  });

  it("rejects repository names with path traversal characters", () => {
    const result = createProjectSchema.safeParse({ ...validProject, repoName: "../etc" });
    expect(result.success).toBe(false);
  });

  it("rejects an unsupported runtime", () => {
    const result = createProjectSchema.safeParse({ ...validProject, runtimeKind: "container" });
    expect(result.success).toBe(false);
  });
});

describe("envVarSchema", () => {
  it("accepts uppercase keys and defaults to a secret on production", () => {
    const parsed = envVarSchema.parse({ key: "DATABASE_URL", value: "postgres://example" });
    expect(parsed.isSecret).toBe(true);
    expect(parsed.scope).toBe("production");
    expect(parsed.useBuild).toBe(true);
    expect(parsed.useRuntime).toBe(false);
  });

  it("rejects lowercase keys", () => {
    expect(envVarSchema.safeParse({ key: "database_url", value: "x" }).success).toBe(false);
  });

  it("allows a partial update that only changes the value", () => {
    const parsed = envVarUpdateSchema.parse({ value: "new" });
    expect(parsed.value).toBe("new");
    expect(parsed.key).toBeUndefined();
  });
});

describe("domainSchema", () => {
  it("normalizes hostnames to lowercase", () => {
    const parsed = domainSchema.parse({ hostname: "App.Example.COM" });
    expect(parsed.hostname).toBe("app.example.com");
  });

  it("rejects bare names and URLs", () => {
    expect(domainSchema.safeParse({ hostname: "example" }).success).toBe(false);
    expect(domainSchema.safeParse({ hostname: "https://example.com" }).success).toBe(false);
  });
});

describe("deploySchema", () => {
  it("defaults to a production trigger", () => {
    const parsed = deploySchema.parse({});
    expect(parsed.triggerKind).toBe("production");
    expect(parsed.acknowledgeRepoConfig).toBe(false);
  });

  it("rejects an invalid commit sha", () => {
    expect(deploySchema.safeParse({ commitSha: "not-a-sha" }).success).toBe(false);
  });
});

describe("setupSchema", () => {
  it("enforces a 10 character minimum password", () => {
    const result = setupSchema.safeParse({
      setupToken: "token",
      name: "Ada",
      email: "ADA@example.com",
      password: "short",
    });
    expect(result.success).toBe(false);
  });

  it("lowercases email addresses", () => {
    const parsed = setupSchema.parse({
      setupToken: "token",
      name: "Ada",
      email: "ADA@Example.COM",
      password: "a-long-password",
    });
    expect(parsed.email).toBe("ada@example.com");
  });
});
