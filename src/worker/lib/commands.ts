import type { Project } from "../../shared/types";
import { toBase64 } from "./utils";

/**
 * KI00 generates deterministic build/deploy commands for Cloudflare Workers
 * Builds. Nothing here is executed inside KI00 itself: builds run in
 * Cloudflare's isolated build environment, and deployment uses a scoped build
 * token. User-supplied commands are only ever sent to that environment, never
 * evaluated by the KI00 Worker.
 */

export const DEFAULT_WRANGLER_VERSION = "4.151.1";
export const KI00_CONFIG_PATH = "wrangler.ki00.json";

export function wranglerVersion(raw?: string): string {
  const value = (raw ?? "").trim();
  return /^\d+\.\d+\.\d+$/.test(value) ? value : DEFAULT_WRANGLER_VERSION;
}

export function safeOutputDir(raw: string): string {
  const value = (raw || "").trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!value || value === "." || value === "/") return ".";
  if (value.startsWith("/") || value.includes("\\") || value.includes("..")) return "dist";
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return "dist";
  return value;
}

export function normalizeRootDir(raw: string): string {
  const value = (raw || "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!value || value === ".") return "/";
  if (value.includes("..") || !/^[A-Za-z0-9._/-]+$/.test(value)) return "/";
  return value;
}

export function compatibilityDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function quoteShellArg(value: string): string {
  if (/^[A-Za-z0-9._/@:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function generateStaticWranglerConfig(input: {
  workerName: string;
  outputDir: string;
  spaFallback: boolean;
  assetsDir?: string;
}): string {
  const directory = input.assetsDir ?? sanitizeAssetsPath(input.outputDir);
  const config = {
    $schema: "node_modules/wrangler/config-schema.json",
    name: input.workerName,
    compatibility_date: compatibilityDate(),
    workers_dev: true,
    preview_urls: true,
    observability: { enabled: true },
    assets: {
      directory,
      not_found_handling: input.spaFallback ? "single-page-application" : "none",
    },
  };
  return JSON.stringify(config, null, 2);
}

function sanitizeAssetsPath(outputDir: string): string {
  const safe = safeOutputDir(outputDir);
  return safe === "." ? ".ki00/assets" : safe;
}

export function staticConfigWriteCommand(configJson: string): string {
  const base64 = toBase64(new TextEncoder().encode(configJson));
  return `node -e 'const fs=require("fs");fs.writeFileSync("wrangler.ki00.json",Buffer.from("${base64}","base64"));console.log("KI00: wrote wrangler.ki00.json")'`;
}

const ROOT_STATIC_STAGE_SCRIPT = `
const fs=require("fs"),path=require("path");
const root=process.cwd();
const out=path.join(root,".ki00","assets");
fs.rmSync(out,{recursive:true,force:true});
fs.mkdirSync(out,{recursive:true});
const allowed=new Set([".html",".htm",".css",".js",".mjs",".json",".txt",".xml",".svg",".png",".jpg",".jpeg",".gif",".webp",".avif",".ico",".woff",".woff2",".ttf",".otf",".eot",".mp4",".webm",".pdf",".wasm",".map",".csv",".md",".yaml",".yml",".webmanifest"]);
const skip=new Set(["node_modules",".git",".wrangler",".ki00"]);
let count=0,bytes=0;
function walk(dir,rel){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const name=entry.name;
    if(name.startsWith("."))continue;
    if(!rel&&skip.has(name))continue;
    if(name==="package.json"||name==="package-lock.json"||name==="pnpm-lock.yaml"||name==="yarn.lock")continue;
    const full=path.join(dir,name);
    const relPath=rel?rel+"/"+name:name;
    if(entry.isDirectory()){walk(full,relPath);continue;}
    if(!entry.isFile())continue;
    if(!allowed.has(path.extname(name).toLowerCase()))continue;
    const stat=fs.statSync(full);
    if(stat.size>10*1024*1024)continue;
    bytes+=stat.size;
    if(bytes>80*1024*1024)throw new Error("KI00: static assets exceed the 80 MB staging limit");
    fs.mkdirSync(path.dirname(path.join(out,relPath)),{recursive:true});
    fs.copyFileSync(full,path.join(out,relPath));
    count++;
  }
}
walk(root,"");
console.log("KI00: staged "+count+" static file(s)");
`.trim();

export function rootStaticStageCommand(): string {
  const base64 = toBase64(new TextEncoder().encode(ROOT_STATIC_STAGE_SCRIPT));
  return `node -e 'eval(Buffer.from("${base64}","base64").toString())'`;
}

export interface BuildCommands {
  buildCommand: string;
  deployCommand: string;
  previewCommand: string;
  outputs: string;
  managedConfig: boolean;
}

export interface BuildCommandInput {
  project: Pick<
    Project,
    | "workerName"
    | "runtimeKind"
    | "installCommand"
    | "buildCommand"
    | "outputDir"
    | "spaFallback"
  > & { hasWranglerConfig?: boolean };
  wranglerVersion: string;
}

export function buildCommandsForProject(input: BuildCommandInput): BuildCommands {
  const version = wranglerVersion(input.wranglerVersion);
  const install = input.project.installCommand.trim();
  const build = input.project.buildCommand.trim();
  const outputDir = safeOutputDir(input.project.outputDir);
  const pieces: string[] = [];

  if (install) pieces.push(install);
  if (build) pieces.push(build);

  if (input.project.runtimeKind === "static") {
    if (outputDir === ".") pieces.push(rootStaticStageCommand());
    const config = generateStaticWranglerConfig({
      workerName: input.project.workerName,
      outputDir,
      spaFallback: input.project.spaFallback,
    });
    pieces.push(staticConfigWriteCommand(config));
    return {
      buildCommand: pieces.join(" && "),
      deployCommand: `npx --yes wrangler@${version} deploy --config ${KI00_CONFIG_PATH} --keep-vars`,
      previewCommand: `npx --yes wrangler@${version} versions upload --config ${KI00_CONFIG_PATH}`,
      outputs: outputDir === "." ? ".ki00/assets" : outputDir,
      managedConfig: true,
    };
  }

  return {
    buildCommand: pieces.length ? pieces.join(" && ") : "true",
    deployCommand: `npx --yes wrangler@${version} deploy --name ${quoteShellArg(input.project.workerName)} --keep-vars`,
    previewCommand: `npx --yes wrangler@${version} versions upload --name ${quoteShellArg(input.project.workerName)}`,
    outputs: outputDir,
    managedConfig: false,
  };
}

export function workerUrl(workerName: string, subdomain: string | null): string | null {
  if (!subdomain) return null;
  return `https://${workerName}.${subdomain}.workers.dev`;
}
