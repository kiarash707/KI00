# REST API

All endpoints live under `/api`. Requests are same-origin only; there is no CORS. Authentication uses the session
cookie. Authenticated mutations must send the CSRF token returned by `GET /api/auth/session` in the `x-ki00-csrf`
header. Multi-workspace requests may send `x-ki00-workspace: <workspace-id>`.

## Errors

```json
{
  "error": {
    "code": "PROJECT_INCOMPATIBLE",
    "message": "This project is not compatible with the Workers runtime",
    "hint": "Review the compatibility notes and migration options.",
    "details": ["..."],
    "requestId": "req_..."
  }
}
```

`requestId` correlates with Worker logs. Validation failures return `400 VALIDATION_ERROR` with a `details` array of
`{path, message}`. Unhandled failures return `500 INTERNAL_ERROR` without leaking stack traces.

## Authentication

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/auth/session` | Session, workspaces, capabilities, CSRF token |
| GET | `/bootstrap` | Setup state and provider capabilities |
| POST | `/auth/setup` | One-time; requires `KI00_SETUP_TOKEN`; 409 once a user exists |
| POST | `/auth/login` | 8 / 15 min per IP + email |
| POST | `/auth/demo` | Only when `KI00_DEMO=1`; returns `demoPassword` |
| POST | `/auth/logout` | Requires CSRF |
| POST | `/auth/logout-all` | Requires CSRF |

## Overview and activity

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/overview` | Real counters, resources, quotas, recent deployments, errors |
| POST | `/overview/sync` | Sync up to 5 active deployments |
| GET | `/activity` | Filters: `level`, `projectId`, pagination |
| GET | `/audit` | Owner/admin only |
| GET | `/search?q=` | Projects and deployments for the command palette |

## GitHub

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/github/repos` | 424 `GITHUB_NOT_CONFIGURED` without a token |
| GET | `/github/branches?owner=&repo=` | Branch list + head SHAs |
| POST | `/github/analyze` | `{owner, repo, branch}` → detection + compatibility; 30/10 min |

## Projects

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/projects` | Filters `q`, `runtime`, `status`, `compatibility`; `sort`; pagination |
| POST | `/projects` | Rejects non-`static`/`worker` or non-`compatible` with 422 |
| GET | `/projects/:id` | Project, recent deployments, counts, domains |
| PATCH | `/projects/:id` | Name, description, branch, commands, dirs, flags |
| DELETE | `/projects/:id` | Owner/admin + `{confirmName}`; returns `warnings[]` |
| POST | `/projects/:id/deploy` | 12/hour; `{branch?, commitSha?, triggerKind?, acknowledgeRepoConfig?}` |
| POST | `/projects/:id/rollback` | `{deploymentId}`; target must be successful with a commit |
| POST | `/projects/:id/sync` | Sync active deployments for this project |
| GET/POST | `/projects/:id/variables` | Masked values only; writes return `warnings[]` |
| PATCH/DELETE | `/projects/:id/variables/:varId` | Delete requires `{confirm: true}` |
| GET | `/projects/:id/zones` | Zones available to the token |
| GET/POST | `/projects/:id/domains` | Add may return `instructions` and create no DNS |
| DELETE | `/projects/:id/domains/:domainId` | Requires `{confirmHostname}` |
| GET | `/projects/:id/logs/runtime` | Workers Observability; `minutes`, `level`, `q` |

## Deployments

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/deployments` | Filters `projectId`, `status`, `branch`, `triggerKind`, `q` |
| GET | `/deployments/:id` | Deployment + project + metadata |
| POST | `/deployments/:id/sync` | Read the real build from Cloudflare |
| GET | `/deployments/:id/logs` | Cursor-based build logs; `refresh=1` bypasses cache |
| POST | `/deployments/:id/cancel` | Asks Cloudflare to cancel |
| GET | `/deployments/:id/activity` | Related activity entries |

## Agent and models

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/models` | Cached free, tool-capable catalog + selection reason |
| POST | `/models/refresh` | 6/hour; re-fetches OpenRouter |
| GET | `/agent/threads` | Recent conversations |
| GET | `/agent/threads/:id` | Messages + approvals |
| DELETE | `/agent/threads/:id` | Removes messages and pending approvals |
| POST | `/agent/run` | NDJSON stream; max 8 model calls, 10 runs/hour |
| POST | `/agent/approvals/:id` | `{decision: "approve" \\| "reject"}` |

### Agent stream events

Each line is JSON with a `type`:

- `run_start` — run id, thread id, model
- `model_call` — call index
- `message` — assistant text
- `tool_start` / `tool_result` — tool name, `ok`, summary, result
- `approval` — approval id, action, arguments (nothing executed yet)
- `model_switch` — free-model failover only
- `usage` — calls, tokens, max calls
- `limit` — hard stop explanation
- `error` — message/code
- `done` — run id and status

## Settings

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/settings/connections` | Live provider status, zones, build minutes, model info |
| POST | `/settings/refresh` | Force provider re-check (cached 2 minutes otherwise) |
| GET | `/settings/sessions` | Current account sessions (hashes/IP prefixes only) |
| POST | `/settings/sessions/revoke-others` | Keeps the current session |
| GET | `/settings/system` | Version, limits, storage engine, docs paths |

## Status codes

| Code | Meaning |
| --- | --- |
| 400 | Validation, missing confirmation, invalid branch/commit |
| 401 | Not signed in or invalid credentials |
| 403 | CSRF/origin failure, role restriction |
| 404 | Not found in this workspace |
| 409 | Conflict: demo read-only, duplicate project/variable, confirmation required, missing preview trigger |
| 422 | Repository analysis failure or incompatible runtime |
| 424 | Provider not configured (GitHub, Cloudflare, OpenRouter) |
| 429 | Rate limit |
| 502 | Cloudflare accepted the request but returned an unusable response |
| 503 | Missing setup/encryption secret |
