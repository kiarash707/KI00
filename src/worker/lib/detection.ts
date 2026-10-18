import type {
  DetectionResult,
  RepoSummary,
  TreeEntry,
  CompatibilityStatus,
  RuntimeKind,
} from "../../shared/types";
import { slugify } from "./utils";

/**
 * Runtime detection is deliberately conservative: when the target runtime
 * cannot be proven compatible, KI00 says so instead of silently converting a
 * project. Every conclusion carries evidence shown to the user.
 */

export interface DetectionInput {
  repo: Pick<RepoSummary, "name" | "language" | "defaultBranch">;
  branch: string;
  tree: TreeEntry[];
  /** Key file contents addressed relative to the detected root directory. */
  files: Record<string, string | null>;
  packageManager?: "npm" | "pnpm" | "yarn" | "bun" | "none";
}

export interface WranglerConfigSummary {
  name: string | null;
  main: string | null;
  assetsDirectory: string | null;
  hasRoutes: boolean;
  hasCustomDomain: boolean;
  format: "jsonc" | "toml";
}

export interface DetectionOutput extends DetectionResult {
  wranglerConfig: WranglerConfigSummary | null;
  rootDir: string;
  warnings: string[];
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none";
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
}

const SERVER_DEPS = ["express", "fastify", "koa", "@nestjs/core", "@hapi/hapi", "restify", "socket.io"];
const DATABASE_DEPS = ["pg", "mysql2", "mongoose", "ioredis", "redis", "prisma", "@prisma/client"];
const FRONTEND_DEPS = ["react", "vue", "svelte", "solid-js", "preact", "@angular/core"];

const COMMON_ENV_EXAMPLES = [
  ".env.example",
  ".env.sample",
  ".env.template",
  "example.env",
  ".env.local.example",
  "env.example",
];

const STATIC_HTML_EXTENSIONS = new Set([".html", ".htm"]);

export function detectProject(input: DetectionInput): DetectionOutput {
  const warnings: string[] = [];
  const evidence: string[] = [];
  const migrationOptions: string[] = [];
  const blockers: string[] = [];
  const configFiles: string[] = [];

  const paths = new Set(input.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path));
  const root = detectRootDir(paths, input.files);
  const rel = (path: string) => (root === "/" ? path : path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path);
  const relFiles: Record<string, string | null> = {};
  for (const [path, content] of Object.entries(input.files)) relFiles[rel(path)] = content;

  const relativePaths = new Set<string>();
  for (const path of paths) {
    if (root === "/" || path.startsWith(`${root}/`)) relativePaths.add(rel(path));
  }

  const packageJson = parsePackageJson(relFiles["package.json"] ?? null);
  const deps = { ...(packageJson?.dependencies ?? {}), ...(packageJson?.devDependencies ?? {}) };
  const hasDep = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
  const hasAnyDep = (names: string[]) => names.some(hasDep);
  const scripts = packageJson?.scripts ?? {};
  const hasPackageJson = Boolean(packageJson);
  const packageManager = input.packageManager ?? detectPackageManager(relativePaths);

  const dockerfile = relativePaths.has("Dockerfile") || relativePaths.has("docker-compose.yml") || relativePaths.has("compose.yaml") || relativePaths.has("compose.yml");
  const python = ["requirements.txt", "pyproject.toml", "Pipfile", "manage.py"].some((file) => relativePaths.has(file));
  const go = relativePaths.has("go.mod");
  const rust = relativePaths.has("Cargo.toml");
  const java = ["pom.xml", "build.gradle", "build.gradle.kts"].some((file) => relativePaths.has(file));
  const ruby = relativePaths.has("Gemfile");
  const php = relativePaths.has("composer.json");

  const wranglerPath = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"].find((file) =>
    relativePaths.has(file)
  );
  const wranglerContent = wranglerPath ? relFiles[wranglerPath] ?? null : null;
  const wranglerRaw =
    wranglerPath && wranglerContent
      ? wranglerPath.endsWith(".toml")
        ? null
        : parseJsonc<Record<string, unknown>>(wranglerContent)
      : null;
  const wranglerToml = wranglerPath?.endsWith(".toml") ? wranglerContent : null;
  const wranglerConfig: WranglerConfigSummary | null = wranglerPath
    ? summarizeWrangler(wranglerRaw, wranglerToml, wranglerPath.endsWith(".toml") ? "toml" : "jsonc")
    : null;
  const hasWrangler = Boolean(wranglerPath);

  if (wranglerPath) {
    configFiles.push(wranglerPath);
    evidence.push(`Found ${wranglerPath}`);
    if (wranglerConfig?.hasRoutes || wranglerConfig?.hasCustomDomain) {
      warnings.push(
        "The repository's Wrangler configuration declares routes or custom domains. Cloudflare may attach them when this project deploys; review the config before your first deploy."
      );
    }
  }
  if (dockerfile) {
    configFiles.push("Dockerfile");
    evidence.push("Found Docker/Compose files");
  }
  if (hasPackageJson) configFiles.push("package.json");

  const envKeys = collectEnvKeys(relFiles, relativePaths);
  if (relativePaths.has(".env") || relativePaths.has(".env.production") || relativePaths.has(".env.local")) {
    warnings.push(
      "A committed .env file was detected. KI00 does not read its values, but you should remove real secrets from the repository and rotate them."
    );
  }

  let framework = "Unknown";
  let language = "Unknown";
  let projectType = "Unknown project";
  let runtimeKind: RuntimeKind = "unknown";
  let runtimeDetail = "";
  let buildCommand = scripts.build ? `${packageManager === "npm" ? "npm run" : packageManager} build` : "";
  let outputDir = "dist";
  let spaFallback = false;
  let compatibilityStatus: CompatibilityStatus = "unknown";
  let confidence: DetectionResult["confidence"] = "low";

  if (java) language = "Java";
  else if (go) language = "Go";
  else if (rust) language = "Rust";
  else if (python) language = "Python";
  else if (ruby) language = "Ruby";
  else if (php) language = "PHP";
  else if (hasPackageJson || relativePaths.has("index.html")) language = "JavaScript";
  if (hasDep("typescript") || relativePaths.has("tsconfig.json")) language = "TypeScript";

  // ── Explicit container / non-JS runtimes ─────────────────────────────────
  if (dockerfile) {
    framework = "Docker";
    projectType = "Containerized application";
    runtimeKind = "container";
    runtimeDetail = "Cloudflare Containers";
    compatibilityStatus = "incompatible";
    confidence = "high";
    blockers.push(
      "This repository ships a Docker image or Compose stack. Workers cannot run a Docker daemon, arbitrary Linux processes, or listen on a custom TCP port."
    );
    migrationOptions.push(
      "Cloudflare Containers can run container images, but the feature requires a Workers Paid plan (minimum $5/month). KI00 does not enable paid resources without your explicit consent.",
      "Refactor the HTTP surface to a Worker (Hono/Fetch handler) and move persistence to D1, KV, R2 or an external database.",
      "Deploy the frontend as static assets here and keep the backend on another provider."
    );
    return finish({ framework, language, projectType, runtimeKind, runtimeDetail, buildCommand, installCommand: "", outputDir: ".", root, spaFallback: false, compatibilityStatus, blockers, migrationOptions, evidence, warnings, envKeys, configFiles, hasDockerfile: dockerfile, hasWrangler, hasPackageJson, packageManager, wranglerConfig, confidence });
  }

  if (python || go || rust || java || ruby || php) {
    framework = python ? "Python" : go ? "Go" : rust ? "Rust" : java ? "JVM" : ruby ? "Ruby" : "PHP";
    projectType = `${framework} application`;
    runtimeKind = "unsupported";
    runtimeDetail = "No compatible Workers runtime detected";
    compatibilityStatus = "incompatible";
    confidence = "high";
    blockers.push(
      `${framework} code cannot be executed as-is on Cloudflare Workers. Workers run JavaScript/TypeScript (and limited Python support in beta) — not a general ${framework} runtime.`
    );
    migrationOptions.push(
      "Port the HTTP API to a TypeScript Worker (Hono is a small router that fits Workers).",
      "If the application needs a full language runtime or long-running processes, use Cloudflare Containers (Workers Paid required) or another container host.",
      "A static frontend from this repository can still be deployed to KI00; point its API base URL at the new backend."
    );
    return finish({ framework, language, projectType, runtimeKind, runtimeDetail, buildCommand, installCommand: "", outputDir, root, spaFallback: false, compatibilityStatus, blockers, migrationOptions, evidence, warnings, envKeys, configFiles, hasDockerfile: dockerfile, hasWrangler, hasPackageJson, packageManager, wranglerConfig, confidence });
  }

  // ── Workers project with an existing Wrangler config ─────────────────────
  if (hasWrangler) {
    runtimeKind = "worker";
    runtimeDetail = "Cloudflare Workers (wrangler configuration detected)";
    framework = detectWorkerFramework(deps);
    projectType = `${framework} on Workers`;
    compatibilityStatus = "compatible";
    confidence = "high";
    if (hasDep("@opennextjs/cloudflare") || hasDep("next")) {
      framework = hasDep("@opennextjs/cloudflare") ? "Next.js (OpenNext)" : "Next.js";
      buildCommand = "npx opennextjs-cloudflare build";
      if (!hasDep("@opennextjs/cloudflare")) {
        compatibilityStatus = "needs_adapter";
        blockers.push(
          "Next.js requires the @opennextjs/cloudflare adapter before it can run on Workers."
        );
        migrationOptions.push(
          "Add @opennextjs/cloudflare and a wrangler.jsonc (the KI00 agent can prepare a patch branch), then deploy with the OpenNext build output."
        );
      }
    } else if (scripts.build) {
      buildCommand = `${packageManager === "npm" ? "npm run" : packageManager} build`;
    }
    outputDir = wranglerConfig?.assetsDirectory ?? "dist";
    spaFallback = /single-page|spa/i.test(wranglerContent ?? "");
    evidence.push(`Worker entry: ${wranglerConfig?.main ?? "(from Wrangler config)"}`);
    return finish({ framework, language: language === "Unknown" ? "TypeScript" : language, projectType, runtimeKind, runtimeDetail, buildCommand, installCommand: installCommandFor(packageManager, relativePaths), outputDir, root, spaFallback, compatibilityStatus, blockers, migrationOptions, evidence, warnings, envKeys, configFiles, hasDockerfile: dockerfile, hasWrangler, hasPackageJson, packageManager, wranglerConfig, confidence });
  }

  // ── Static / frontend frameworks ─────────────────────────────────────────
  if (hasPackageJson) {
    const detection = detectFrontendFramework(deps, scripts, relativePaths, packageManager);
    framework = detection.framework;
    projectType = detection.projectType;
    runtimeKind = detection.runtimeKind;
    runtimeDetail = detection.runtimeDetail;
    outputDir = detection.outputDir;
    buildCommand = detection.buildCommand;
    spaFallback = detection.spaFallback;
    compatibilityStatus = detection.compatibilityStatus;
    blockers.push(...detection.blockers);
    migrationOptions.push(...detection.migrationOptions);
    evidence.push(...detection.evidence);
    confidence = detection.confidence;

    if (detection.serverOnly) {
      blockers.push(
        "This package starts a long-running Node process (e.g. Express/Fastify) and exposes an arbitrary port. Workers do not support that execution model."
      );
      migrationOptions.push(
        "Rewrite the HTTP handlers as a Worker fetch handler. Hono offers a familiar middleware API and runs natively on Workers.",
        "Use Cloudflare Containers if you need the Node server unchanged — Workers Paid is required.",
        "Alternatively deploy only the built frontend here and host the API elsewhere."
      );
    }

    if (hasAnyDep(DATABASE_DEPS)) {
      warnings.push(
        "Database drivers such as pg/mysql2/mongoose/ioredis cannot open raw TCP connections in the Workers free runtime. Use Hyperdrive for Postgres/MySQL, D1 for SQLite, or an HTTP-based database client."
      );
    }

    if (buildCommand && !scripts.build) {
      warnings.push(`No "build" script was found in package.json; the proposed build command may fail.`);
    }

    const outputExists = relativePaths.has(outputDir) || [...relativePaths].some((p) => p.startsWith(`${outputDir}/`));
    if (compatibilityStatus === "compatible" && !outputExists && buildCommand) {
      warnings.push(
        `The output directory "${outputDir}" is not present yet; it will be produced by the build.`
      );
    }

    return finish({ framework, language: language === "Unknown" ? "JavaScript" : language, projectType, runtimeKind, runtimeDetail, buildCommand, installCommand: installCommandFor(packageManager, relativePaths), outputDir, root, spaFallback, compatibilityStatus, blockers, migrationOptions, evidence, warnings, envKeys, configFiles, hasDockerfile: dockerfile, hasWrangler, hasPackageJson, packageManager, wranglerConfig, confidence });
  }

  // ── Plain static HTML ────────────────────────────────────────────────────
  const indexFiles = [...relativePaths].filter((path) => {
    const ext = path.slice(path.lastIndexOf("."));
    return STATIC_HTML_EXTENSIONS.has(ext) && (path === "index.html" || path.endsWith("/index.html"));
  });
  if (indexFiles.length > 0) {
    indexFiles.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
    const shallowest = indexFiles[0]!;
    const directory = shallowest.includes("/") ? shallowest.slice(0, shallowest.lastIndexOf("/")) : ".";
    framework = "Static HTML";
    language = "HTML";
    projectType = "Static site";
    runtimeKind = "static";
    runtimeDetail = "Workers Static Assets";
    buildCommand = "";
    outputDir = directory;
    spaFallback = relativePaths.has("404.html") ? false : false;
    compatibilityStatus = "compatible";
    confidence = "high";
    evidence.push(`Found ${shallowest}`);
    if (directory === ".") {
      evidence.push("Static files deploy from a filtered copy of the repository root");
    }
    return finish({ framework, language, projectType, runtimeKind, runtimeDetail, buildCommand, installCommand: "", outputDir, root, spaFallback, compatibilityStatus, blockers, migrationOptions, evidence, warnings, envKeys, configFiles, hasDockerfile: dockerfile, hasWrangler, hasPackageJson, packageManager, wranglerConfig, confidence });
  }

  projectType = "Unrecognized project";
  compatibilityStatus = "incompatible";
  confidence = "low";
  blockers.push(
    "KI00 could not identify a buildable static site, Worker application, or supported framework in this repository."
  );
  migrationOptions.push(
    "Add a package.json with a build script and a frontend framework, or a Wrangler configuration for a Worker.",
    "If this is a backend service, see docs/RUNTIME_COMPATIBILITY.md for migration options."
  );
  return finish({ framework, language: language === "Unknown" ? "Unknown" : language, projectType, runtimeKind: "unknown", runtimeDetail: "", buildCommand, installCommand: "", outputDir, root, spaFallback, compatibilityStatus, blockers, migrationOptions, evidence, warnings, envKeys, configFiles, hasDockerfile: dockerfile, hasWrangler, hasPackageJson, packageManager, wranglerConfig, confidence });
}

function finish(args: {
  framework: string;
  language: string;
  projectType: string;
  runtimeKind: RuntimeKind;
  runtimeDetail: string;
  buildCommand: string;
  installCommand: string;
  outputDir: string;
  root: string;
  spaFallback: boolean;
  compatibilityStatus: CompatibilityStatus;
  blockers: string[];
  migrationOptions: string[];
  evidence: string[];
  warnings: string[];
  envKeys: string[];
  configFiles: string[];
  hasDockerfile: boolean;
  hasWrangler: boolean;
  hasPackageJson: boolean;
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none";
  wranglerConfig: WranglerConfigSummary | null;
  confidence: DetectionResult["confidence"];
  suggestedName?: string;
}): DetectionOutput {
  return {
    framework: args.framework,
    language: args.language,
    projectType: args.projectType,
    runtimeKind: args.runtimeKind,
    runtimeDetail: args.runtimeDetail,
    buildCommand: args.buildCommand,
    installCommand: args.installCommand,
    outputDir: args.outputDir,
    rootDir: args.root,
    spaFallback: args.spaFallback,
    compatibilityStatus: args.compatibilityStatus,
    compatibilityNotes: [...args.blockers, ...args.warnings],
    blockers: dedupe(args.blockers),
    migrationOptions: dedupe(args.migrationOptions),
    evidence: dedupe(args.evidence),
    requiredEnvKeys: args.envKeys,
    configFiles: args.configFiles,
    hasDockerfile: args.hasDockerfile,
    hasWrangler: args.hasWrangler,
    hasPackageJson: args.hasPackageJson,
    suggestedName: args.suggestedName ?? "",
    confidence: args.confidence,
    wranglerConfig: args.wranglerConfig,
    warnings: dedupe(args.warnings),
    packageManager: args.packageManager,
  } as DetectionOutput;
}

function detectFrontendFramework(
  deps: Record<string, string>,
  scripts: Record<string, string>,
  paths: Set<string>,
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none"
): {
  framework: string;
  projectType: string;
  runtimeKind: RuntimeKind;
  runtimeDetail: string;
  outputDir: string;
  buildCommand: string;
  spaFallback: boolean;
  compatibilityStatus: CompatibilityStatus;
  blockers: string[];
  migrationOptions: string[];
  evidence: string[];
  confidence: DetectionResult["confidence"];
  serverOnly: boolean;
} {
  const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
  const run = packageManager === "npm" ? "npm run build" : `${packageManager} build`;
  const base = {
    blockers: [] as string[],
    migrationOptions: [] as string[],
    evidence: [] as string[],
    serverOnly: false,
    confidence: "high" as DetectionResult["confidence"],
  };
  const chooseOutput = (candidates: string[], fallback: string) =>
    candidates.find((dir) => paths.has(dir) || [...paths].some((p) => p.startsWith(`${dir}/`))) ??
    candidates.find((dir) => ["dist", "build", "out", "public", ".output/public"].includes(dir)) ??
    fallback;

  if (has("next")) {
    const openNext = has("@opennextjs/cloudflare");
    return {
      ...base,
      framework: openNext ? "Next.js (OpenNext)" : "Next.js",
      projectType: "Next.js application",
      runtimeKind: "worker",
      runtimeDetail: openNext ? "Workers via OpenNext adapter" : "Requires the OpenNext Cloudflare adapter",
      outputDir: ".next",
      buildCommand: openNext ? "npx opennextjs-cloudflare build" : run,
      spaFallback: false,
      compatibilityStatus: openNext ? "needs_adapter" : "needs_adapter",
      blockers: [
        openNext
          ? "This Next.js app uses OpenNext, but no wrangler configuration was found. Add wrangler.jsonc so the Worker entry and assets can be deployed."
          : "Next.js cannot run on Workers unchanged. It needs the @opennextjs/cloudflare adapter and a Wrangler configuration; KI00 will not convert it silently.",
      ],
      migrationOptions: [
        "Use the KI00 agent to open a patch branch adding @opennextjs/cloudflare and wrangler.jsonc, then deploy from that branch.",
        "Or export the site as a fully static build and deploy it as static assets (features using server rendering, ISR, middleware or server actions will not work).",
      ],
      confidence: "high",
    };
  }

  if (has("@sveltejs/kit") || paths.has("svelte.config.js") || paths.has("svelte.config.ts")) {
    const cloudflareAdapter = paths.has("svelte.config.js") || paths.has("svelte.config.ts");
    return {
      ...base,
      framework: "SvelteKit",
      projectType: "SvelteKit application",
      runtimeKind: "worker",
      runtimeDetail: "Workers with @sveltejs/adapter-cloudflare",
      outputDir: ".svelte-kit/cloudflare",
      buildCommand: run,
      spaFallback: false,
      compatibilityStatus: "needs_adapter",
      blockers: [
        "SvelteKit's default adapter targets Node. Cloudflare requires @sveltejs/adapter-cloudflare (or adapter-static for a purely static site); KI00 cannot assume which one this app uses.",
      ],
      migrationOptions: [
        "Switch svelte.config.js to @sveltejs/adapter-cloudflare and add a wrangler.jsonc, then deploy as a Worker.",
        "For a static-only site, use @sveltejs/adapter-static; KI00 can deploy the generated build directory.",
      ],
      evidence: ["SvelteKit dependency detected", cloudflareAdapter ? "svelte.config found" : ""],
    };
  }

  if (has("astro") || paths.has("astro.config.mjs") || paths.has("astro.config.ts")) {
    const cloudflareAdapter = has("@astrojs/cloudflare");
    const nonCloudflareAdapter = has("@astrojs/node") || has("@astrojs/vercel");
    const staticOutput = !cloudflareAdapter && !nonCloudflareAdapter;
    return {
      ...base,
      framework: "Astro",
      projectType: staticOutput ? "Astro static site" : "Astro SSR application",
      runtimeKind: staticOutput ? "static" : "worker",
      runtimeDetail: staticOutput
        ? "Workers Static Assets"
        : cloudflareAdapter
          ? "Astro Cloudflare adapter detected"
          : "Astro Cloudflare adapter required",
      outputDir: chooseOutput(["dist"], "dist"),
      buildCommand: run,
      spaFallback: false,
      compatibilityStatus: staticOutput ? "compatible" : "needs_adapter",
      blockers: staticOutput
        ? []
        : [
            "This Astro project appears to use server rendering with a non-Cloudflare adapter. Add @astrojs/cloudflare before deploying.",
          ],
      migrationOptions: staticOutput
        ? []
        : ["Install @astrojs/cloudflare and set the adapter in astro.config, then deploy as a Worker."],
      evidence: ["Astro detected"],
    };
  }

  if (has("nuxt") || paths.has("nuxt.config.ts") || paths.has("nuxt.config.js")) {
    const staticOutput = (scripts.generate ?? "").length > 0;
    return {
      ...base,
      framework: "Nuxt",
      projectType: staticOutput ? "Nuxt static site" : "Nuxt application",
      runtimeKind: staticOutput ? "static" : "worker",
      runtimeDetail: staticOutput ? "Workers Static Assets" : "Nitro Cloudflare preset required",
      outputDir: chooseOutput([".output/public", "dist"], ".output/public"),
      buildCommand: staticOutput ? `${packageManager === "npm" ? "npm run" : packageManager} generate` : run,
      spaFallback: false,
      compatibilityStatus: staticOutput ? "compatible" : "needs_adapter",
      blockers: staticOutput
        ? []
        : [
            "Nuxt's Node server cannot run on Workers unchanged. Set nitro.preset = 'cloudflare-pages' or use `nuxt generate` for a static build.",
          ],
      migrationOptions: staticOutput
        ? []
        : ["Configure the Nitro Cloudflare preset and a wrangler.jsonc, then deploy as a Worker."],
      evidence: ["Nuxt detected"],
    };
  }

  if (has("@remix-run/react") || has("@remix-run/node") || has("@react-router/dev")) {
    return {
      ...base,
      framework: has("@react-router/dev") ? "React Router" : "Remix",
      projectType: "SSR React application",
      runtimeKind: "worker",
      runtimeDetail: "Cloudflare adapter required",
      outputDir: chooseOutput(["build/client"], "build/client"),
      buildCommand: run,
      spaFallback: false,
      compatibilityStatus: "needs_adapter",
      blockers: [
        "This app uses a Node server adapter. Cloudflare requires the Remix/React Router Cloudflare preset and a wrangler.jsonc.",
      ],
      migrationOptions: [
        "Use the official Cloudflare template for Remix/React Router and deploy the worker build.",
        "For a client-only SPA, switch to SPA mode and deploy build/client as static assets with SPA fallback.",
      ],
      evidence: ["SSR React framework detected"],
    };
  }

  if (has("@angular/core") || paths.has("angular.json")) {
    const angularJson = paths.has("angular.json");
    return {
      ...base,
      framework: "Angular",
      projectType: "Angular SPA",
      runtimeKind: "static",
      runtimeDetail: "Workers Static Assets",
      outputDir: chooseOutput(["dist/browser"], "dist/browser"),
      buildCommand: run,
      spaFallback: true,
      compatibilityStatus: "compatible",
      blockers: [],
      migrationOptions: [],
      evidence: ["Angular detected", angularJson ? "angular.json found" : ""],
    };
  }

  if (has("gatsby")) {
    return {
      ...base,
      framework: "Gatsby",
      projectType: "Gatsby static site",
      runtimeKind: "static",
      runtimeDetail: "Workers Static Assets",
      outputDir: chooseOutput(["public"], "public"),
      buildCommand: run,
      spaFallback: false,
      compatibilityStatus: "compatible",
      evidence: ["Gatsby detected"],
    };
  }

  if (has("@docusaurus/core")) {
    return {
      ...base,
      framework: "Docusaurus",
      projectType: "Documentation site",
      runtimeKind: "static",
      runtimeDetail: "Workers Static Assets",
      outputDir: chooseOutput(["build"], "build"),
      buildCommand: run,
      spaFallback: false,
      compatibilityStatus: "compatible",
      evidence: ["Docusaurus detected"],
    };
  }

  if (has("vitepress") || has("vuepress")) {
    return {
      ...base,
      framework: has("vitepress") ? "VitePress" : "VuePress",
      projectType: "Documentation site",
      runtimeKind: "static",
      runtimeDetail: "Workers Static Assets",
      outputDir: chooseOutput(["docs/.vitepress/dist", ".vitepress/dist", "docs/.vuepress/dist"], "docs/.vitepress/dist"),
      buildCommand: run,
      spaFallback: false,
      compatibilityStatus: "compatible",
      evidence: ["Documentation framework detected"],
    };
  }

  const serverDep = SERVER_DEPS.find((dep) => has(dep));
  if (serverDep) {
    return {
      ...base,
      framework: serverDep === "express" ? "Express" : serverDep === "@nestjs/core" ? "NestJS" : serverDep,
      projectType: "Node.js server",
      runtimeKind: "unsupported",
      runtimeDetail: "Long-running Node process",
      outputDir: chooseOutput(["dist"], "dist"),
      buildCommand: run,
      spaFallback: false,
      compatibilityStatus: "incompatible",
      serverOnly: true,
      blockers: [],
      migrationOptions: [
        "Port the routes to Hono or another fetch-native router. Workers use the Fetch API, not Node's http server.",
        "Cloudflare Containers can host the existing server, but Workers Paid is required.",
      ],
      evidence: [`Server dependency: ${serverDep}`],
    };
  }

  const hasVite = has("vite") || paths.has("vite.config.ts") || paths.has("vite.config.js");
  const hasReact = has("react");
  const hasVue = has("vue");
  const hasSvelte = has("svelte");
  const hasSolid = has("solid-js");
  const hasPreact = has("preact");
  if (hasVite || hasReact || hasVue || hasSvelte || hasSolid || hasPreact || has("react-scripts")) {
    const framework = has("react-scripts")
      ? "Create React App"
      : hasVite
        ? `Vite${hasReact ? " + React" : hasVue ? " + Vue" : hasSvelte ? " + Svelte" : ""}`
        : hasReact
          ? "React"
          : hasVue
            ? "Vue"
            : hasSvelte
              ? "Svelte"
              : hasSolid
                ? "Solid"
                : "Preact";
    return {
      ...base,
      framework,
      projectType: "Single-page application",
      runtimeKind: "static",
      runtimeDetail: "Workers Static Assets",
      outputDir: chooseOutput(has("react-scripts") ? ["build"] : ["dist"], has("react-scripts") ? "build" : "dist"),
      buildCommand: run,
      spaFallback: true,
      compatibilityStatus: "compatible",
      blockers: [],
      migrationOptions: [],
      evidence: FRONTEND_DEPS.filter((dep) => has(dep)).map((dep) => `Dependency: ${dep}`),
    };
  }

  if (scripts.start && !scripts.build) {
    return {
      ...base,
      framework: "Node.js",
      projectType: "Node.js service",
      runtimeKind: "unsupported",
      runtimeDetail: "Long-running process",
      outputDir: ".",
      buildCommand: "",
      spaFallback: false,
      compatibilityStatus: "incompatible",
      serverOnly: true,
      blockers: [],
      migrationOptions: [
        "This package only defines a start script. Workers cannot keep a process alive or bind a port.",
        "Rewrite it as a fetch handler, or use Cloudflare Containers (Workers Paid).",
      ],
      evidence: ['Only a "start" script was found'],
    };
  }

  return {
    ...base,
    framework: "JavaScript",
    projectType: "JavaScript project",
    runtimeKind: "static",
    runtimeDetail: "Workers Static Assets",
    outputDir: chooseOutput(["dist", "build"], "dist"),
    buildCommand: run,
    spaFallback: false,
    compatibilityStatus: scripts.build ? "compatible" : "incompatible",
    blockers: scripts.build
      ? []
      : ["No build script was found, so KI00 cannot produce a deployable output directory."],
    migrationOptions: scripts.build
      ? []
      : ["Add a build script that emits static files, or add a Wrangler configuration for a Worker."],
    evidence: ["package.json without a recognised framework"],
    confidence: "medium",
  };
}

function detectWorkerFramework(deps: Record<string, string>): string {
  if (Object.prototype.hasOwnProperty.call(deps, "hono")) return "Hono";
  if (Object.prototype.hasOwnProperty.call(deps, "itty-router")) return "itty-router";
  if (Object.prototype.hasOwnProperty.call(deps, "@cloudflare/workers-types")) return "Cloudflare Worker";
  return "Cloudflare Worker";
}

export function installCommandFor(
  packageManager: "npm" | "pnpm" | "yarn" | "bun" | "none",
  paths: Set<string>
): string {
  switch (packageManager) {
    case "pnpm":
      return paths.has("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile" : "pnpm install";
    case "yarn":
      return "yarn install";
    case "bun":
      return paths.has("bun.lockb") || paths.has("bun.lock") ? "bun install --frozen-lockfile" : "bun install";
    case "npm":
      return paths.has("package-lock.json") ? "npm ci" : "npm install";
    default:
      return "";
  }
}

export function detectPackageManager(paths: Set<string>): "npm" | "pnpm" | "yarn" | "bun" | "none" {
  if (paths.has("bun.lockb") || paths.has("bun.lock")) return "bun";
  if (paths.has("pnpm-lock.yaml")) return "pnpm";
  if (paths.has("yarn.lock")) return "yarn";
  if (paths.has("package-lock.json") || paths.has("npm-shrinkwrap.json")) return "npm";
  if (paths.has("package.json")) return "npm";
  return "none";
}

function detectRootDir(paths: Set<string>, files: Record<string, string | null>): string {
  const hasRootPackage = paths.has("package.json") || files["package.json"] !== undefined;
  const hasRootIndex = paths.has("index.html");
  if (hasRootPackage || hasRootIndex) return "/";

  const candidates = [...paths]
    .map((path) => {
      const match = path.match(/^(.+)\/package\.json$/);
      return match?.[1] ?? null;
    })
    .filter((value): value is string => Boolean(value) && !value!.includes("node_modules"))
    .filter((value) => value.split("/").length <= 2)
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
  return candidates[0] ? `/${candidates[0]}`.replace(/^\/+/, "") : "/";
}

function collectEnvKeys(
  files: Record<string, string | null>,
  paths: Set<string>
): string[] {
  const keys = new Set<string>();
  for (const candidate of COMMON_ENV_EXAMPLES) {
    if (!paths.has(candidate)) continue;
    const content = files[candidate];
    if (!content) continue;
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]{0,63})\s*=/);
      if (match?.[1]) keys.add(match[1]);
    }
  }
  return [...keys].slice(0, 60);
}

export function parsePackageJson(content: string | null): PackageJson | null {
  if (!content) return null;
  try {
    const parsed = JSON.parse(content) as PackageJson;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Tolerant JSONC parser for Wrangler configs (comments + trailing commas). */
export function parseJsonc<T>(content: string): T | null {
  let output = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;
  for (let i = 0; i < content.length; i++) {
    const char = content[i]!;
    const next = content[i + 1];
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        output += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    output += char;
  }
  output = output.replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(output) as T;
  } catch {
    return null;
  }
}

function summarizeWrangler(
  json: Record<string, unknown> | null,
  toml: string | null,
  format: "jsonc" | "toml"
): WranglerConfigSummary {
  if (format === "toml" && toml) {
    const nameMatch = toml.match(/^\s*name\s*=\s*"([^"]+)"/m);
    const mainMatch = toml.match(/^\s*main\s*=\s*"([^"]+)"/m);
    const assetsDirMatch = toml.match(/directory\s*=\s*"([^"]+)"/);
    return {
      name: nameMatch?.[1] ?? null,
      main: mainMatch?.[1] ?? null,
      assetsDirectory: assetsDirMatch?.[1] ?? null,
      hasRoutes: /^\s*(\[\[?routes?\]?\]|route\s*=)/m.test(toml) || /custom_domain\s*=\s*true/m.test(toml),
      hasCustomDomain: /custom_domain\s*=\s*true/m.test(toml),
      format,
    };
  }
  const assets = (json?.assets ?? {}) as Record<string, unknown>;
  const routes = json?.routes;
  return {
    name: typeof json?.name === "string" ? json.name : null,
    main: typeof json?.main === "string" ? json.main : null,
    assetsDirectory: typeof assets.directory === "string" ? assets.directory : null,
    hasRoutes: Array.isArray(routes) ? routes.length > 0 : Boolean(routes),
    hasCustomDomain: format === "jsonc" && JSON.stringify(json ?? {}).includes("custom_domain"),
    format,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function suggestedProjectName(repoName: string): string {
  return slugify(repoName.replace(/\.(git|io)$/i, "").replace(/[-_]+/g, " "));
}

export function compatibilitySummary(result: DetectionOutput): string {
  if (result.compatibilityStatus === "compatible") {
    return `${result.framework} is compatible with ${result.runtimeDetail || "Workers Static Assets"}.`;
  }
  if (result.compatibilityStatus === "needs_adapter") {
    return `${result.framework} needs an adapter or configuration change before it can run on Cloudflare.`;
  }
  if (result.compatibilityStatus === "incompatible") {
    return `${result.framework} cannot run on the selected Cloudflare runtime without changes.`;
  }
  return "Compatibility could not be determined.";
}
