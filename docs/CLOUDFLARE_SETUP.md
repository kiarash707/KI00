# Cloudflare setup

This is the operator checklist for a real KI00 deployment. Nothing in this document contains a real credential.

## 1. Prerequisites

- Cloudflare account (Free plan is sufficient for Workers, static assets and Workers Builds).
- Wrangler 4.x (`npx wrangler --version`; this repo pins `^4.43.0` and uses `4.151.1` as the build wrangler version).
- Node.js 20+.
- A GitHub account that owns, or can install apps on, the repositories KI00 will build.

## 2. Create the D1 database

```bash
npx wrangler d1 create ki00
```

Copy the returned `database_id` into `wrangler.jsonc`:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "ki00", "database_id": "<real-id>", "migrations_dir": "migrations" }
]
```

Also replace the placeholder `account_id` with your Cloudflare account id, or log in with `wrangler login` and remove
the placeholder. Keep `KI00_DEMO` set to `"0"` for a real deployment.

## 3. Create the Cloudflare API token

Use **My Profile → API Tokens → Create Custom Token**. The token must be **user-scoped**; Workers Builds rejects
account-scoped tokens for its API.

Required permissions:

| Scope | Permission | Why |
| --- | --- | --- |
| Account | Workers Scripts: Edit | Create the placeholder Worker, delete Workers on project deletion, upload secrets |
| Account | Workers Builds Configuration: Edit (Workers CI: Write) | Build tokens, repo connections, triggers, manual builds, cancel |
| Account | Workers Observability: Read | Runtime logs (optional; omit to disable runtime log queries) |
| Account | Account Settings: Read | Account name and workers.dev subdomain |
| Zone | Zone: Read + Workers Routes: Edit | Workers Custom Domains (limit to zones you will attach) |
| User | User Details: Read + Memberships: Read | Verify the token and list accounts |

Do not grant DNS: Edit globally. KI00 attaches Workers Custom Domains, which Cloudflare manages; it never edits
unrelated DNS records. Keep the token restricted to the zones you use.

Add it as a Worker secret (never commit it):

```bash
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
```

`CLOUDFLARE_ACCOUNT_ID` is also accepted as a D1 workspace setting, but the environment secret is the simplest path.

## 4. GitHub access

Create a **fine-grained personal access token**:

- Repository access: only the repositories KI00 should read.
- Permissions: Metadata: Read, Contents: Read. Add Contents: Write only if you want the agent to create patch
  branches; KI00 never pushes to the default branch.
- Optionally set an expiry and rotate it.

```bash
npx wrangler secret put GITHUB_TOKEN
```

Public repositories can be inspected without a token (subject to the low unauthenticated GitHub rate limit), but
Workers Builds still needs repository access through Cloudflare.

## 5. Install the Cloudflare GitHub App

Workers Builds clones repositories through the **Cloudflare GitHub App**. Install it from the Cloudflare dashboard
(Workers & Pages → your Worker → Settings → Builds, or the GitHub integration page) and grant access to the
repository. KI00 cannot install it for you and will report build setup failures from Cloudflare instead of faking a
build.

The build token is operator-owned. Create a **dedicated** API token with only **Workers Scripts:Edit**, then either
copy its build-token UUID from Workers & Pages → your Worker → Settings → Builds into `KI00_BUILD_TOKEN_UUID`, or set
`KI00_BUILD_TOKEN_SECRET` (the token value) and `KI00_BUILD_TOKEN_ID` (its API token id) so KI00 can register it with
`POST /accounts/{id}/builds/tokens`. KI00 never reuses its own broader API token for builds. The UUID is cached in D1
settings (`cf:build-token:<accountId>`) and is not exposed by any endpoint.

## 6. KI00 core secrets

```bash
npx wrangler secret put KI00_ENCRYPTION_KEY    # openssl rand -base64 32
npx wrangler secret put KI00_SETUP_TOKEN       # long random one-time value
npx wrangler secret put OPENROUTER_API_KEY     # optional, agent only
```

- `KI00_ENCRYPTION_KEY` decrypts project variables. Losing it makes stored variable values unreadable by design.
- `KI00_SETUP_TOKEN` is only accepted while there are zero users. Remove or rotate it after setup.

## 7. Apply migrations and deploy

```bash
npx wrangler d1 migrations apply DB --remote
npm run verify
npm run deploy
```

`wrangler.jsonc` serves the built SPA from `./web/dist` and routes `/api`, `/api/*` and `/health` to the Worker first.
Unknown non-API paths fall back to `index.html` for client-side routing.

## 8. First run

1. Open the Worker URL.
2. The setup form appears because `setupComplete` is false.
3. Enter `KI00_SETUP_TOKEN`, your name, email, password and a workspace name.
4. Sign in. Open **Settings → Connections** and verify Cloudflare, GitHub and (optionally) OpenRouter.
5. Create a project from a repository.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `SETUP_TOKEN_MISSING` | Secret not set. `npx wrangler secret put KI00_SETUP_TOKEN`. |
| `ENCRYPTION_KEY_MISSING` | Set a 32-byte base64 `KI00_ENCRYPTION_KEY`. |
| `GITHUB_NOT_CONFIGURED` (424) | `GITHUB_TOKEN` missing; add it or use a public repository. |
| `CLOUDFLARE_BUILD_TOKEN_FAILED` | Token is account-scoped, lacks Workers Builds Configuration: Edit, or the account has no Workers Builds access. |
| `REPO_CONFIG_ACK_REQUIRED` (409) | The repo's Wrangler config declares routes/custom domains. Confirm in the UI and retry with `acknowledgeRepoConfig: true`. |
| `PREVIEW_TRIGGER_UNAVAILABLE` | Cloudflare allows at most two build triggers per Worker; delete or reuse one in the dashboard. |
| Build fails immediately | The Cloudflare GitHub App may not have access to the repository, or the build command is wrong. Open the deployment logs; the real error is shown and redacted. |
| Runtime logs unavailable | Workers Observability is disabled, retention expired, or the token lacks Observability: Read. |
| `ORIGIN_REJECTED` | Requests must be same-origin; do not call the API from another domain. |
