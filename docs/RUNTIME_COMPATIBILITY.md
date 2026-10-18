# Runtime compatibility

KI00's rule is simple: **prove it, or say it cannot run**. It never converts an arbitrary application to Workers and
never claims that a Railway service will run unchanged.

## Runtime classes

| Class | KI00 target | What runs |
| --- | --- | --- |
| Static | Workers static assets | HTML/CSS/JS/SPA output, prerendered Astro/Nuxt, Vite/React |
| Serverless | Cloudflare Worker | Fetch-style JS/TS Workers, Hono, existing `wrangler` projects |
| Stateful | D1 / KV / Durable Objects | Application data; KI00 itself uses D1 |
| Files | R2 | Object storage when a project needs it |
| Containers | Cloudflare Containers | **Paid Workers plan only**; KI00 notifies and never enables it automatically |

## Detection signals

KI00 inspects a bounded set of files (never the whole repository): `package.json`, lockfiles, `wrangler.jsonc/json/toml`,
framework configs, `Dockerfile`, `docker-compose*`, `index.html`, `.env.example` names, and common language manifests.
It records evidence and confidence.

- **Static**: no server entry, or a known static output (`dist`, `build`, `out`, `_site`, `public`) with a build script.
- **Worker**: `wrangler.*` with a `main` or a Workers-compatible entry.
- **Needs adapter**: Next.js (OpenNext), SvelteKit (`@sveltejs/adapter-cloudflare`), Remix/React Router (Cloudflare
  preset), SSR Astro (Cloudflare adapter), Nuxt with server routes.
- **Incompatible**: Docker/Compose, Express/Fastify/Koa/Nest/Hapi/Restify, Python, Go, Rust, JVM, Ruby, PHP.

## Build and publish

- Static: install → build → generate `wrangler.ki00.json` with `assets.directory` and optional SPA fallback →
  `npx --yes wrangler@<pinned> deploy --config wrangler.ki00.json --keep-vars`.
- Worker: install → build (optional) → `npx --yes wrangler@<pinned> deploy --name <worker> --keep-vars` using the
  repository's own Wrangler config.
- Preview: `wrangler versions upload` (no production traffic).

Wrangler is pinned (`KI00_WRANGLER_VERSION`, default `4.151.1`) so build behavior is reproducible.

## Cloudflare free-tier facts used in the UI

| Resource | Free plan |
| --- | --- |
| Workers requests | 100,000 / day |
| Worker CPU | 10 ms / invocation |
| Static asset requests | Free and unlimited |
| Workers Builds | 3,000 minutes/month, 1 concurrent build, 20-minute timeout |
| Workers Logs | 200,000 events/day, 3-day retention |
| Containers | Not included; Workers Paid plan required |

Paid plan numbers (10M requests, 30M CPU-ms, 6 concurrent builds, etc.) are not assumed anywhere. `wrangler.jsonc`
enables only Workers + static assets.

## Migration playbook

1. **Static frontend**: deploy it on KI00. Keep the API elsewhere initially.
2. **HTTP API on Workers**: rewrite the handler to the Fetch API (Hono is a good fit), move persistence to D1/KV/R2,
   and provide a `wrangler` config. KI00 can then build it.
3. **Framework SSR**: add the official Cloudflare adapter in the repository, verify a local `wrangler dev`, then let
   KI00 build it. KI00 reports the adapter requirement instead of modifying your code.
4. **Containers**: only with an explicit paid-plan decision. KI00 will show that option and stop.

## What KI00 will never claim

- That a Docker image runs on Workers.
- That a Node server with sockets, cron loops or local filesystem state runs unchanged.
- That a deployment succeeded before Cloudflare reports success.
- That runtime logs exist when the API returns none.
- That containers are free.
