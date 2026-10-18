import { describe, expect, it } from "vitest";
import {
  buildCommandsForProject,
  normalizeRootDir,
  quoteShellArg,
  safeOutputDir,
  wranglerVersion,
} from "../src/worker/lib/commands";

const staticProject = {
  workerName: "ki00-demo-ab12",
  runtimeKind: "static" as const,
  installCommand: "npm ci",
  buildCommand: "npm run build",
  outputDir: "dist",
  spaFallback: true,
  hasWranglerConfig: false,
};

describe("buildCommandsForProject", () => {
  it("writes an isolated wrangler config and deploys with the pinned Wrangler version", () => {
    const commands = buildCommandsForProject({ project: staticProject, wranglerVersion: "4.151.1" });
    expect(commands.buildCommand).toContain("npm ci");
    expect(commands.buildCommand).toContain("npm run build");
    expect(commands.buildCommand).toContain("wrangler.ki00.json");
    expect(commands.deployCommand).toContain("npx --yes wrangler@4.151.1 deploy");
    expect(commands.deployCommand).toContain("--config wrangler.ki00.json");
    expect(commands.deployCommand).toContain("--keep-vars");
    expect(commands.previewCommand).toContain("versions upload");
    expect(commands.managedConfig).toBe(true);
  });

  it("never lets a user-controlled output dir escape the repository", () => {
    expect(safeOutputDir("../../etc")).toBe("dist");
    expect(safeOutputDir("/etc")).toBe("dist");
    expect(safeOutputDir("dist/../..")).toBe("dist");
    expect(safeOutputDir("./dist/")).toBe("dist");
    expect(safeOutputDir(".")).toBe(".");
  });

  it("normalizes dangerous root directories", () => {
    expect(normalizeRootDir("apps/web")).toBe("apps/web");
    expect(normalizeRootDir("../../")).toBe("/");
    expect(normalizeRootDir("")).toBe("/");
  });

  it("falls back to a safe Wrangler version", () => {
    expect(wranglerVersion("4.151.1")).toBe("4.151.1");
    expect(wranglerVersion("latest; rm -rf /")).toBe("4.151.1");
    expect(wranglerVersion(undefined)).toBe("4.151.1");
  });

  it("quotes shell arguments that contain spaces or quotes", () => {
    expect(quoteShellArg("ki00-demo")).toBe("ki00-demo");
    expect(quoteShellArg("bad name")).toBe("'bad name'");
    expect(quoteShellArg("a'b")).toBe("'a'\\''b'");
  });

  it("generates a worker deploy command without a generated config", () => {
    const commands = buildCommandsForProject({
      project: { ...staticProject, runtimeKind: "worker", outputDir: "." },
      wranglerVersion: "4.151.1",
    });
    expect(commands.deployCommand).toContain("--name ki00-demo-ab12");
    expect(commands.deployCommand).not.toContain("wrangler.ki00.json");
    expect(commands.managedConfig).toBe(false);
  });
});
