# Security model

KI00 handles deployment credentials, so the default posture is deny and separate concerns. This document describes
what is implemented, and what remains operational risk.

## Assets

| Asset | Where it lives | Exposure |
| --- | --- | --- |
| Cloudflare API token | Worker secret | Never returned by any API; used server-side only |
| GitHub token | Worker secret | Same |
| OpenRouter key | Worker secret | Same; read only by the model client |
| KI00 encryption key | Worker secret | Never stored in D1 |
| Project variable values | D1 `env_vars.value_enc` (AES-GCM) | Only masked values in responses |
| Session tokens | Browser HttpOnly cookie; SHA-256 hash in D1 | Cookie is not readable by JS |
| Passwords | PBKDF2-SHA256 (210,000 iterations, per-user salt) | Never logged or returned |

## Authentication and sessions

- First-run setup requires `KI00_SETUP_TOKEN` and is refused once a user exists.
- Login is rate limited to 8 attempts per 15 minutes per IP + email, with a generic `INVALID_CREDENTIALS` response.
- Session tokens are 32 random bytes, stored hashed, valid for 7 days with a 30-day absolute cap, refreshed on use.
- Cookies: `HttpOnly`, `SameSite=Strict`, `Secure` on HTTPS, path `/`.
- Logout and logout-all require a valid CSRF token.

## CSRF and origins

- Every authenticated mutation requires `x-ki00-csrf` to equal the session's CSRF token.
- `originGuard` rejects cross-origin non-GET requests with `403 ORIGIN_REJECTED`.
- CORS is intentionally not enabled; the API is same-origin only.
- `SameSite=Strict` provides defence in depth.

## Input validation and injection

- Every request body is parsed with Zod schemas (bounded lengths, enum runtime/status values, safe repository and
  branch character sets, hostname regex, commit SHA pattern).
- SQL uses prepared statements with bound parameters. Dynamic column names are never taken from user input (project
  settings map a fixed allow-list of fields).
- Shell commands are generated from validated values; output directories reject `..`, absolute paths and backslashes,
  and shell arguments are quoted.
- React escapes rendered content; the CSP forbids inline scripts. There is no `dangerouslySetInnerHTML`.

## Secrets in logs

- Build logs are stored/returned after `redactSecrets`, which removes the configured provider secrets and common token
  shapes (GitHub, OpenRouter/OpenAI-style keys, bearer headers).
- Agent tool output is redacted and truncated before being stored or sent to the model.
- Audit metadata never includes variable values.

## Build isolation

Cloudflare Workers Builds runs the install/build in Cloudflare's build environment. KI00 never executes user commands
on its own Worker and never runs a Docker daemon. Build minutes, concurrency and timeouts follow Cloudflare plan limits.

## Authorization

- A workspace membership determines access; project lookups are scoped by `workspace_id`.
- Project deletion requires the `owner` or `admin` role plus the exact project name.
- The audit log is restricted to owners/admins.
- The agent cannot bypass UI approvals: privileged tools create an approval row and return `approval_required`.

## Rate limits

D1-backed fixed windows, keyed by workspace and/or user:

| Action | Limit |
| --- | --- |
| Login | 8 / 15 min per IP + email |
| Setup | 5 / hour per IP |
| Deploy / rollback | 12 / hour |
| GitHub analysis | 30 / 10 min |
| Variable / domain writes | bounded per route |
| Deployment sync / logs | 300 / 120 per 5 min |
| Agent runs | 10 / hour; 8 model calls per run |
| Model catalog refresh | 6 / hour |

## Headers

`X-Frame-Options: DENY`, `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, strict referrer policy,
permissions policy, COOP/CORP, HSTS on HTTPS, `Cache-Control: no-store` for `/api/*`, and a CSP with
`script-src 'self'`, `connect-src 'self'`, and image sources limited to self and GitHub avatars.

## Agent-specific controls

- Only zero-price, tool-capable models with ≥16k context are eligible; no paid fallback is possible.
- Hard caps: 8 model calls, 12 tool calls, 4 tools per model turn, 18-message context window.
- Repository reads are bounded (200 paths, 40 KB file) and refuse `.env`, keys and credential-shaped paths.
- Writes to GitHub or Cloudflare require a human approval; patch branches are limited to 8 files / 240 KB and never
  target the default branch.

## Residual risks and non-goals

- Single-role workspace model; no per-project RBAC, SSO, WebAuthn or SCIM.
- No WAF/geo blocking by default; put Cloudflare Access in front of KI00 if it must be private.
- D1 storage is at-rest encrypted by Cloudflare, in addition to KI00's application-level AES-GCM for variables.
- If `KI00_ENCRYPTION_KEY` is lost, variable values cannot be recovered.
- Demo mode is intentionally read-only, but a public demo still exposes sample data and should not hold real secrets.
- Rate limits are best-effort fixed windows in D1, not a global traffic shaper.

## Reporting

If you find a vulnerability, do not open a public issue with credentials or exploit details. Rotate any exposed
credential first, then contact the repository owner privately.
