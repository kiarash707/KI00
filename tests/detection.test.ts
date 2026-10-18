import { describe, expect, it } from "vitest";
import { detectProject } from "../src/worker/lib/detection";
import type { DetectionInput } from "../src/worker/lib/detection";
import type { TreeEntry } from "../src/shared/types";

function input(files: Record<string, string>, extras: Partial<DetectionInput> = {}): DetectionInput {
  return {
    repo: { name: "demo", language: null, defaultBranch: "main" },
    branch: "main",
    tree: Object.keys(files).map<TreeEntry>((path) => ({ path, type: "blob", size: files[path]!.length })),
    files,
    ...extras,
  };
}

describe("detectProject", () => {
  it("detects a static HTML site as compatible static assets", () => {
    const result = detectProject(input({ "index.html": "<html><body>Hello</body></html>" }));
    expect(result.runtimeKind).toBe("static");
    expect(result.compatibilityStatus).toBe("compatible");
    expect(result.language).toBe("HTML");
  });

  it("detects a Docker repository as incompatible and never claims Workers can run it", () => {
    const result = detectProject(
      input({ Dockerfile: "FROM node:22\nCMD node server.js\n", "package.json": "{}" })
    );
    expect(result.runtimeKind).toBe("container");
    expect(result.compatibilityStatus).toBe("incompatible");
    expect(result.blockers.join(" ")).toMatch(/docker/i);
    expect(result.migrationOptions.join(" ")).toMatch(/paid/i);
  });

  it("detects an Express server as incompatible", () => {
    const result = detectProject(
      input({
        "package.json": JSON.stringify({
          dependencies: { express: "^4.19.0" },
          scripts: { start: "node server.js" },
        }),
        "server.js": "require('express')()",
      })
    );
    expect(result.compatibilityStatus).toBe("incompatible");
    expect(result.runtimeKind).toBe("unsupported");
  });

  it("marks Next.js as needing an adapter rather than silently converting it", () => {
    const result = detectProject(
      input({
        "package.json": JSON.stringify({
          dependencies: { next: "^15.0.0", react: "^19.0.0" },
          scripts: { build: "next build" },
        }),
        "next.config.js": "module.exports = {};",
      })
    );
    expect(result.compatibilityStatus).toBe("needs_adapter");
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.migrationOptions.length).toBeGreaterThan(0);
  });

  it("finds a monorepo root directory from a nested package.json", () => {
    const result = detectProject(
      input({
        "apps/web/package.json": JSON.stringify({
          dependencies: { react: "^19.0.0", vite: "^7.0.0" },
          scripts: { build: "vite build" },
        }),
        "apps/web/vite.config.ts": "export default {}",
        "apps/web/index.html": "<div id=root></div>",
      })
    );
    expect(result.rootDir).not.toBe("/");
    expect(result.rootDir).toMatch(/apps\/web/);
  });

  it("collects required environment variable names without values", () => {
    const result = detectProject(
      input({
        "index.html": "<html></html>",
        ".env.example": "API_URL=\nSECRET_KEY=\n",
      })
    );
    expect(result.requiredEnvKeys).toContain("API_URL");
    expect(result.requiredEnvKeys).toContain("SECRET_KEY");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });
});
