# Deployment and operations

## Build pipeline

`npm run build` performs three checks in order:

1. `tsc -p tsconfig.worker.json` and `tsc -p tsconfig.web.json` (strict, no emit).
2. `vite build` → `web/dist` (React SPA, hashed assets).
3. `wrangler deploy --dry-run --outdir dist/worker` (validates the Worker bundle and bindings without publishing).

`npm run deploy` builds the SPA and publishes with Wrangler. The Worker is named `ki00` in `wrangler.jsonc`.

## Runtime shape

```
Cloudflare Worker "ki00"
├── /health            liveness + version (no auth)
├── /api/*             Hono REST API (run_worker_first)
└── /*                 static assets from web/dist with SPA fallback
```

D1 binding: `DB`. Secrets are Worker secrets; public configuration lives in `wrangler.jsonc` `vars`.

## Database migrations

Migrations are ordered SQL files in `migrations/`. Apply them with Wrangler:

```bash
npx wrangler d1 migrations apply DB --local     # local development
npx wrangler d1 migrations apply DB --remote    # production
```

Never edit an applied migration in place on a production database; add a new one. Back up important D1 data with
`wrangler d1 export` before destructive changes.

## Project deployment lifecycle

1. `POST /api/projects` validates the repository/branch with GitHub and refuses non-compatible runtimes.
2. `POST /api/projects/:id/deploy` inserts a queued deployment row, ensures the Worker/trigger/build-token/repo
   connection exist, then asks Cloudflare to start a build.
3. `POST /api/deployments/:id/sync` reads the build from Cloudflare and updates status, commit, timings, URL and
   project `last_build_status`.
4. `GET /api/deployments/:id/logs` fetches cursor-paginated build logs, redacts configured secrets and caches terminal
   logs for terminal deployments.
5. On success, encrypted runtime variables are applied to the Worker as secret bindings using the bulk secrets API.
6. Activity and audit rows are appended; the UI polls while a build is active.

A deployment is **never** marked successful from an optimistic local state. If Cloudflare returns 404 for a build, the
deployment becomes `unknown`.

## Rollback semantics

Rollback queues a **new production build** at the commit of a previous successful deployment and records
`rollback_of`. It does not instantly switch traffic and it does not rewrite history. This is stated in the UI.

## Custom domains for KI00 itself

To serve KI00 on your own hostname, add a Workers Custom Domain in the Cloudflare dashboard or with:

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/domains" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"hostname":"ki00.example.com","service":"ki00","zone_id":"<zone-id>","environment":"production"}'
```

The zone must be active in the same account. Cookies are marked `Secure` automatically on HTTPS requests.

## Runtime logs

`GET /api/projects/:id/logs/runtime` queries Workers Observability for the project's Worker name. It is available only
for `worker` runtime projects, requires the token to read telemetry, and reports `available: false` with the provider
error otherwise. There is no fake streaming and no log synthesis.

## Operating checklist

- Monitor deployment failure activity (`GET /api/activity?level=error`) and the overview error panel.
- Keep `KI00_DEMO=0` on public deployments.
- Rotate `CLOUDFLARE_API_TOKEN`, `GITHUB_TOKEN` and `OPENROUTER_API_KEY` periodically; update Worker secrets.
- Keep `KI00_ENCRYPTION_KEY` stable and backed up; rotating it requires re-entering variable values.
- Review `GET /api/audit` (owners/admins) for destructive actions.
- Watch free-tier build minutes and Workers request limits in the overview. The UI labels documented limits separately
  from API-reported usage.

## CI

`.github/workflows/ci.yml` installs dependencies, runs typecheck, lint, tests, the SPA build, a Worker dry-run bundle
and the secret scan. It does not deploy.
