# KI00

KI00 is a Cloudflare-native deployment platform: connect a GitHub repository, inspect what it actually is, and publish
it through **Cloudflare Workers Builds** with real build logs, real deployment records and a real URL. It is not a
Railway proxy, a mock control panel, or a Docker host.

The dashboard and REST API are a single Cloudflare Worker with static assets. State lives in D1, project variables are
encrypted at rest, builds execute in Cloudflare's build isolation, and the AI agent is restricted to free
tool-capable OpenRouter models.

```
Browser ──► Cloudflare Worker (Hono API + React static assets)
                │
                ├─ D1: users, sessions, projects, deployments, env vars, domains,
                │       activity, audit log, agent threads, approvals, rate limits
                ├─ Cloudflare API: Workers, Workers Builds, Custom Domains,
                │       Workers Observability, build tokens and repo connections
                ├─ GitHub API: repositories, branches, trees, files, patch branches
                └─ OpenRouter API: free model catalog + tool-calling chat
```

## What actually works

| Area | Implementation |
| --- | --- |
| Authentication | First-run setup with a one-time `KI00_SETUP_TOKEN`; PBKDF2 password hashes; HttpOnly, SameSite=Strict session cookies; CSRF token required for every authenticated mutation |
| Projects | Create from a GitHub repo, detect framework/runtime, enforce compatibility, edit settings, delete with typed confirmation |
| Builds | Cloudflare Workers Builds triggers; real build UUIDs, statuses, commit metadata, durations and logs from the Cloudflare API |
| Deployments | Create, sync, poll, cancel, view logs, roll back by rebuilding a previous successful commit |
| Static projects | Built into a static directory, then deployed with a generated `wrangler.ki00.json` to Workers static assets |
| Worker projects | Deployed with the project's own Wrangler configuration and a pinned Wrangler version |
| Variables | AES-GCM encrypted in D1, masked in the API, pushed to build triggers and applied as Worker secrets after success |
| Domains | Workers Custom Domains for zones in the account; explicit manual DNS instructions when the zone is external. No email or unrelated DNS records are changed |
| Logs | Real build logs (cursor pagination), real Workers Observability runtime logs when the token allows it; no fabricated lines |
| AI agent | Bounded tool-calling loop over real KI00/Cloudflare/GitHub tools, max 8 model calls, free models only, approvals for writes |
| Audit | Append-only audit log for mutating actions, readable by workspace owners/admins |
| Demo | `KI00_DEMO=1` seeds sample fixtures and hard-disables writes and all provider calls |

## Requirements

- Node.js 20+ (developed on Node 22).
- A Cloudflare account on the **Free** plan is enough for static assets, Workers and Workers Builds.
- A Cloudflare API token, a Cloudflare account ID, and a GitHub token for real deployments.
- The **Cloudflare GitHub App** installed on the repositories you want Workers Builds to clone.
- Optional: `OPENROUTER_API_KEY` for the agent.

## Local start

```bash
npm install
cp .dev.vars.example .dev.vars        # fill in what you have; leave blank for demo mode
npx wrangler d1 migrations apply DB --local
KI00_DEMO=1 npm run dev               # builds the SPA and serves it with the Worker on :8787
```

Open `http://localhost:8787`. In demo mode, use **Explore the demo workspace**; the seed account is
`demo@ki00.local` with password `ki00-demo-local` (demo only, never a production credential).

For UI iteration, run `npm run dev:web` (Vite on `:5173`, proxying `/api` to `:8787`) in a second terminal.

## Deploy KI00 itself

1. Create the D1 database and put its real id in `wrangler.jsonc` (`database_id`), replace the placeholder
   `account_id`, and set `KI00_DEMO` to `0`.
2. Add the Worker secrets:

   ```bash
   npx wrangler secret put CLOUDFLARE_API_TOKEN
   npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
   npx wrangler secret put GITHUB_TOKEN
   npx wrangler secret put OPENROUTER_API_KEY        # optional
   npx wrangler secret put KI00_ENCRYPTION_KEY       # openssl rand -base64 32
   npx wrangler secret put KI00_SETUP_TOKEN          # one-time, long random
   ```

3. Apply migrations remotely and deploy:

   ```bash
   npx wrangler d1 migrations apply DB --remote
   npm run deploy
   ```

4. Open the Worker URL, complete setup with the setup token, then connect a repository.

Full details and the exact token permission list are in [`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md).

## Cloudflare token permissions (least privilege)

User-scoped token (Workers Builds rejects account-scoped tokens):

- Workers Scripts: Edit
- Workers Builds Configuration: Edit / Workers CI: Write
- Workers Observability: Read (runtime logs)
- Account Settings: Read
- Zone: Read and Workers Routes: Edit, limited to the zones you actually attach
- User Details: Read, Memberships: Read (the token must be user-owned)

Workers Builds uses an operator-owned, dedicated build token (Workers Scripts: Edit only) configured with
`KI00_BUILD_TOKEN_UUID` or `KI00_BUILD_TOKEN_SECRET` + `KI00_BUILD_TOKEN_ID`; KI00 never reuses its own broader token
for builds. The resolved UUID is cached in D1 settings and is not exposed by any endpoint.

## Runtime compatibility — the honest version

KI00 refuses to pretend that arbitrary applications run on Workers.

| Detected target | Result |
| --- | --- |
| Static HTML, Vite/React SPA, static Astro, static Nuxt (`generate`), plain JS/CSS | Deploys as Workers static assets |
| Existing Workers project with `wrangler.jsonc`/`wrangler.toml` | Deploys as a Worker |
| Next.js, SvelteKit, Remix/React Router SSR, SSR Astro, `nuxt build` | `needs_adapter`: KI00 explains the required adapter and does not rewrite your app |
| Express/Fastify/Koa/Nest, Python, Go, Rust, JVM, Ruby, PHP | `incompatible`: no Workers runtime |
| Dockerfile / Compose | `incompatible`: Workers cannot run Docker or arbitrary Linux processes. Cloudflare Containers requires a **paid Workers plan** and KI00 never enables it automatically |

Detection is conservative and exposes its evidence, blockers and migration options. See
[`docs/RUNTIME_COMPATIBILITY.md`](docs/RUNTIME_COMPATIBILITY.md).

## AI agent

- The key is read only from the `OPENROUTER_API_KEY` Worker secret. It is never stored in D1, returned by an API,
  logged, or included in prompts.
- The catalog comes from `GET https://openrouter.ai/api/v1/models`. KI00 keeps only models with **zero price**, text
  output, tool support and at least 16k context, then ranks them and caches the result for 6 hours.
- `KI00_AGENT_MODEL` is honored **only** if it is a free, tool-capable model in the current catalog.
- Max 8 model calls and 12 tool calls per run, at most 10 runs per hour per workspace. Failover is limited to free
  models; if none is available the agent stops and says so.
- Tools read project context, repository files/trees, KI00 deployments, real build logs, runtime logs and Cloudflare
  resource status. They never return secret values.
- `create_patch_branch`, `trigger_deployment` and `create_preview_build` require an explicit approval in the UI before
  anything is executed. Patch branches are limited to 8 files / 240 KB and blocked from writing sensitive paths.

## Security model

- All provider tokens are Worker secrets, used only server-side.
- Sessions are hashed in D1; cookies are HttpOnly/SameSite=Strict; every authenticated mutation requires the session
  CSRF token and a same-origin request.
- Project variable values are AES-256-GCM encrypted; APIs return masked values only.
- Security headers include a strict CSP (`script-src 'self'`, `frame-ancestors 'none'`), `nosniff`, HSTS on HTTPS and
  `no-store` for API responses.
- Rate limits are enforced in D1 for login, setup, deploys, variable writes, GitHub analysis, logs and agent runs.
- Audit entries record who did what, without secret values.
- Builds run in Cloudflare Workers Builds isolation; KI00 never executes user commands on its own Worker.

See [`docs/SECURITY.md`](docs/SECURITY.md).

## Verification

```bash
npm run typecheck   # Worker + web TypeScript, strict
npm run lint        # ESLint flat config
npm run test        # Vitest (validation, detection, commands, crypto/redaction)
npm run build       # typecheck + SPA build + wrangler dry-run bundle
npm run secrets:check
```

CI runs the same commands in `.github/workflows/ci.yml`.

## Known limitations

- **No live Cloudflare deployment is performed by this repository.** The code is wired to the Workers Builds API, but
  deploying requires the operator's account, token, database id and the Cloudflare GitHub App.
- Workers Builds needs the Cloudflare GitHub App installed on the repository; KI00 can only detect and explain that
  prerequisite, not install it for you.
- Runtime logs require Workers Observability access on the token. When the API does not expose them, the UI says
  "unavailable" instead of inventing lines.
- Rollback is implemented as a **new build of a previous commit**, not an instant traffic switch. KI00 states this in
  the UI.
- Only `static` and `worker` runtimes can be created and deployed. Containers and other runtimes are intentionally
  blocked until explicitly supported and paid-plan consent exists.
- Workspace switching is implemented server-side, but this build's setup flow creates one workspace per account.
- The agent cannot read secret values and cannot execute arbitrary commands.
- Free-tier numbers in the UI are labelled by source; Cloudflare may not expose remaining build minutes to a token, in
  which case KI00 shows the documented limit instead of a fake "remaining" value.

## Documentation

- [`docs/CLOUDFLARE_SETUP.md`](docs/CLOUDFLARE_SETUP.md) — account, token scopes, D1, GitHub App, build tokens.
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — deploying KI00 itself, custom domains, rollback, operations.
- [`docs/SECURITY.md`](docs/SECURITY.md) — threat model, secrets, sessions, CSRF, audit, rate limits.
- [`docs/RUNTIME_COMPATIBILITY.md`](docs/RUNTIME_COMPATIBILITY.md) — supported runtimes and migration options.
- [`docs/API.md`](docs/API.md) — REST endpoints and error codes.
