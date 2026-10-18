#!/usr/bin/env node
/**
 * Fails the build when a credential-shaped string or a real .env file is present
 * in the repository. This is a guard rail, not a replacement for reviewing diffs.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".wrangler",
  "dist",
  "coverage",
  ".vite",
  ".arena",
  "build",
]);
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".pdf", ".map", ".zip"]);
const ALLOW = new Set([".dev.vars.example", "scripts/check-secrets.mjs"]);

const PATTERNS = [
  { name: "OpenRouter key", re: /\bsk-or-v1-[A-Za-z0-9]{32,}\b/g },
  { name: "OpenAI-style key", re: /\bsk-(?!or-v1)[A-Za-z0-9]{32,}\b/g },
  { name: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g },
  { name: "AWS key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: "Cloudflare API token", re: /\b(?![A-Za-z0-9_-]{40}\b)[A-Za-z0-9_-]{40}\b/g, onlyIn: /(CLOUDFLARE_API_TOKEN|CF_API_TOKEN)\s*[=:]\s*["']?([A-Za-z0-9_-]{40})/ },
  { name: "Hard-coded secret assignment", re: /(?:OPENROUTER_API_KEY|GITHUB_TOKEN|CLOUDFLARE_API_TOKEN|KI00_ENCRYPTION_KEY|KI00_SETUP_TOKEN)\s*[:=]\s*["'][^"'\s]{8,}["']/g },
];

const findings = [];

/**
 * Only files git would actually publish are scanned: tracked files plus untracked
 * files that are not gitignored. A local `.dev.vars` is therefore fine, while a
 * force-added one is caught.
 */
function listFiles() {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }
    );
    return output
      .split("\u0000")
      .filter(Boolean)
      .map((rel) => join(root, rel))
      .filter((full) => {
        try {
          return statSync(full).isFile();
        } catch {
          return false;
        }
      });
  } catch {
    // Fall back to walking the tree when git is unavailable (e.g. a source tarball).
    const files = [];
    walkAll(root, files);
    return files;
  }
}

function walkAll(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env" && !entry.name.startsWith(".dev.vars")) {
      if (entry.name !== ".github") continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walkAll(full, files);
      continue;
    }
    if (entry.isFile()) files.push(full);
  }
}

function scan(files) {
  for (const full of files) {
    const rel = relative(root, full).split("\\").join("/");
    if (ALLOW.has(rel)) continue;
    if (SKIP_EXT.has(extname(full))) continue;
    if (rel === ".env" || rel === ".dev.vars" || (rel.startsWith(".dev.vars.") && rel !== ".dev.vars.example")) {
      findings.push(`${rel}: a real ${rel} file must not be committed`);
      continue;
    }
    if (statSync(full).size > 1_500_000) continue;
    let content;
    try {
      content = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    for (const pattern of PATTERNS) {
      if (pattern.onlyIn) {
        const match = content.match(pattern.onlyIn);
        if (match) findings.push(`${rel}: possible ${pattern.name} (${match[1]} assignment)`);
        continue;
      }
      const matches = content.match(pattern.re);
      if (matches) {
        for (const match of matches.slice(0, 3)) {
          findings.push(`${rel}: possible ${pattern.name}: ${match.slice(0, 12)}…`);
        }
      }
    }
  }
}

scan(listFiles());

if (findings.length) {
  console.error("Secret scan failed:\n" + findings.map((finding) => `  - ${finding}`).join("\n"));
  console.error("\nRemove the value, rotate the credential, and use `wrangler secret put` instead.");
  process.exit(1);
}
console.log("Secret scan passed: no credential-shaped strings or committed .env files found.");
