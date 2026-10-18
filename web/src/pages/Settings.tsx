import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Cloud,
  Database,
  ExternalLink,
  Github,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { ConnectionsInfo, SessionRecord } from "@shared/types";
import { api, errorMessage, post } from "../lib/api";
import { formatDate, timeAgo } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { useSession } from "../lib/session";
import {
  CopyButton,
  Empty,
  ErrorBanner,
  InfoBanner,
  Loading,
  Spinner,
  StatusPill,
  useToast,
} from "../components/ui";

interface SystemInfo {
  version: string;
  env: string;
  demo: boolean;
  setupComplete: boolean;
  providers: Record<string, { configured?: boolean; ok?: boolean | null }>;
  limits: { agentModelCallsPerRun: number; agentRunsPerHour: number; deploysPerHour: number };
  runtime: string;
  buildEngine: string;
  database: string;
  docs: Record<string, string>;
}

export default function SettingsPage() {
  const { session, signOut, refresh: refreshSession } = useSession();
  const { notify } = useToast();
  const connections = useAsync<ConnectionsInfo>(() => api("/settings/connections"), []);
  const system = useAsync<SystemInfo>(() => api("/settings/system"), []);
  const [sessions, setSessions] = useState<SessionRecord[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const loadSessions = async () => {
    try {
      const data = await api<{ items: SessionRecord[] }>("/settings/sessions");
      setSessions(data.items);
      setSessionsError(null);
    } catch (error) {
      setSessionsError(errorMessage(error));
    }
  };

  useEffect(() => {
    void loadSessions();
  }, []);

  const refreshProviders = async () => {
    setRefreshing(true);
    try {
      await post("/settings/refresh", {});
      connections.reload();
      system.reload();
      await refreshSession();
      notify("Provider status refreshed", "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setRefreshing(false);
    }
  };

  const revokeOthers = async () => {
    if (!window.confirm("Sign out every other browser session for this account?")) return;
    setRevoking(true);
    try {
      await post("/settings/sessions/revoke-others", {});
      notify("Other sessions were revoked", "success");
      await loadSessions();
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setRevoking(false);
    }
  };

  const logoutAll = async () => {
    if (!window.confirm("Sign out everywhere, including this browser?")) return;
    try {
      await post("/auth/logout-all", {});
    } catch (error) {
      notify(errorMessage(error), "error");
    }
    await signOut();
  };

  const capabilities = connections.data?.capabilities ?? session?.capabilities;
  const cloudflare = connections.data?.cloudflare;
  const github = connections.data?.github;
  const openrouter = connections.data?.openrouter;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Provider connections, session security and the real limits that apply to this deployment.</p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => void refreshProviders()} disabled={refreshing}>
            {refreshing ? <Spinner /> : <RefreshCw size={14} />} Refresh provider status
          </button>
        </div>
      </div>

      {connections.error ? <ErrorBanner error={new Error(connections.error)} onRetry={connections.reload} /> : null}
      {connections.loading && !connections.data ? <Loading label="Loading connections" /> : null}

      {capabilities?.demo ? (
        <InfoBanner kind="warn">
          <strong>Demo deployment.</strong>
          <span className="small">
            KI00 is running with sample fixtures. Provider checks are disabled, and no Cloudflare, GitHub or OpenRouter
            calls are made.
          </span>
        </InfoBanner>
      ) : null}

      <div className="grid cols-3">
        <section className="card stack">
          <div className="card-head">
            <h3>
              <Cloud size={16} /> Cloudflare
            </h3>
            <StatusPill
              status={cloudflare?.buildMinutes.error || capabilities?.providers.cloudflare.ok === false ? "failed" : capabilities?.providers.cloudflare.ok ? "success" : "unknown"}
              label={capabilities?.providers.cloudflare.ok === false ? "Error" : capabilities?.providers.cloudflare.ok ? "Connected" : "Unknown"}
            />
          </div>
          {cloudflare ? (
            <dl className="kv">
              <dt>Account</dt>
              <dd>{cloudflare.accountName ?? cloudflare.accountId ?? "Not reported"}</dd>
              <dt>workers.dev</dt>
              <dd>{cloudflare.workersSubdomain ?? "Not reported"}</dd>
              <dt>Workers</dt>
              <dd>{cloudflare.workerCount ?? "Not reported"}</dd>
              <dt>Build token</dt>
              <dd>
                <StatusPill status={cloudflare.buildToken === "configured" ? "success" : cloudflare.buildToken === "missing" ? "failed" : "unknown"} label={cloudflare.buildToken} />
              </dd>
              <dt>Build minutes</dt>
              <dd>
                {cloudflare.buildMinutes.remaining !== null
                  ? `${cloudflare.buildMinutes.remaining} / ${cloudflare.buildMinutes.limit ?? "?"} remaining`
                  : cloudflare.buildMinutes.error ?? "Not exposed"}
              </dd>
            </dl>
          ) : (
            <p className="small muted">{capabilities?.providers.cloudflare.error ?? "Not configured"}</p>
          )}
          {cloudflare?.zones.length ? (
            <div>
              <div className="small dim" style={{ marginBottom: 4 }}>Zones</div>
              <div className="row" style={{ gap: 4 }}>
                {cloudflare.zones.slice(0, 6).map((zone) => (
                  <span key={zone.id} className="pill neutral">
                    {zone.name} · {zone.status}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          <p className="tiny dim">{cloudflare?.permissionHint}</p>
        </section>

        <section className="card stack">
          <div className="card-head">
            <h3>
              <Github size={16} /> GitHub
            </h3>
            <StatusPill
              status={capabilities?.providers.github.ok === false ? "failed" : capabilities?.providers.github.ok ? "success" : "unknown"}
              label={capabilities?.providers.github.mode === "public" ? "Public only" : "Token"}
            />
          </div>
          {github ? (
            <dl className="kv">
              <dt>Mode</dt>
              <dd>{github.mode === "token" ? "Authenticated PAT" : "Unauthenticated (public repos)"}</dd>
              <dt>Login</dt>
              <dd>{github.login ?? "—"}</dd>
              <dt>Rate limit</dt>
              <dd>
                {github.rateLimit.remaining !== null
                  ? `${github.rateLimit.remaining} / ${github.rateLimit.limit}`
                  : "Not reported"}
              </dd>
              <dt>Reset</dt>
              <dd>{github.rateLimit.resetAt ? formatDate(github.rateLimit.resetAt) : "—"}</dd>
            </dl>
          ) : null}
          <details className="small">
            <summary className="dim" style={{ cursor: "pointer" }}>Required token scopes</summary>
            <ul style={{ paddingLeft: 18, margin: "6px 0 0" }}>
              {github?.requiredScopes.map((scope) => (
                <li key={scope} className="muted">{scope}</li>
              ))}
            </ul>
          </details>
          <InfoBanner kind="info">
            <span className="small">
              Cloudflare Workers Builds also requires the Cloudflare GitHub App on the repository. That installation
              happens in the Cloudflare dashboard, not inside KI00.
            </span>
          </InfoBanner>
        </section>

        <section className="card stack">
          <div className="card-head">
            <h3>
              <Sparkles size={16} /> OpenRouter
            </h3>
            <StatusPill
              status={capabilities?.providers.openrouter.ok === false ? "failed" : capabilities?.providers.openrouter.configured ? "success" : "unknown"}
              label={capabilities?.providers.openrouter.configured ? "Key set" : "Missing key"}
            />
          </div>
          {openrouter ? (
            <dl className="kv">
              <dt>Free models</dt>
              <dd>{openrouter.freeModels}</dd>
              <dt>Selected</dt>
              <dd className="mono tiny break">{openrouter.selectedModel ?? "—"}</dd>
              <dt>Name</dt>
              <dd>{openrouter.selectedModelName ?? "—"}</dd>
              <dt>Key label</dt>
              <dd>{openrouter.keyLabel ?? "—"}</dd>
              <dt>Key usage</dt>
              <dd>
                {openrouter.usage
                  ? `${openrouter.usage.usage ?? "?"} used${openrouter.usage.limit ? ` of ${openrouter.usage.limit}` : ""}`
                  : "Not reported"}
              </dd>
            </dl>
          ) : null}
          <p className="tiny dim">
            KI00 selects only models with zero price, tool calling and at least 16k context. It never falls back to a
            paid model.
          </p>
        </section>
      </div>

      <div className="grid main-side">
        <section className="card flush">
          <div className="toolbar">
            <h3 style={{ flex: 1 }}>Sessions</h3>
            <button type="button" className="btn sm" onClick={() => void loadSessions()}>
              <RefreshCw size={13} /> Refresh
            </button>
            <button type="button" className="btn sm" onClick={() => void revokeOthers()} disabled={revoking}>
              {revoking ? <Spinner /> : <Trash2 size={13} />} Revoke others
            </button>
          </div>
          {sessionsError ? (
            <div style={{ padding: 16 }}>
              <ErrorBanner error={new Error(sessionsError)} onRetry={() => void loadSessions()} />
            </div>
          ) : sessions === null ? (
            <Loading label="Loading sessions" />
          ) : sessions.length === 0 ? (
            <Empty icon={<ShieldCheck size={18} />} title="No sessions" description="Sign in to create a session." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Session</th>
                    <th>Created</th>
                    <th>Last seen</th>
                    <th>Expires</th>
                    <th>Client</th>
                    <th>IP prefix</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((item, index) => (
                    <tr key={`${item.createdAt}-${index}`}>
                      <td>{item.current ? <span className="pill success"><span className="dot" /> This browser</span> : <span className="small muted">Other</span>}</td>
                      <td className="small muted">{timeAgo(item.createdAt)}</td>
                      <td className="small muted">{timeAgo(item.lastSeenAt)}</td>
                      <td className="small muted">{formatDate(item.expiresAt)}</td>
                      <td className="small muted truncate" style={{ maxWidth: 220 }}>
                        {item.userAgent ?? "—"}
                      </td>
                      <td className="mono tiny dim">{item.ipHash ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="stack">
          <section className="card stack">
            <div className="card-head">
              <h3>
                <Database size={15} /> System
              </h3>
              <StatusPill status={system.data ? "success" : "unknown"} label={system.data?.version ?? "—"} />
            </div>
            {system.error ? <ErrorBanner error={new Error(system.error)} onRetry={system.reload} /> : null}
            {system.data ? (
              <dl className="kv">
                <dt>Runtime</dt>
                <dd>{system.data.runtime}</dd>
                <dt>Build engine</dt>
                <dd>{system.data.buildEngine}</dd>
                <dt>Database</dt>
                <dd>{system.data.database}</dd>
                <dt>Environment</dt>
                <dd>{system.data.env}</dd>
                <dt>Setup complete</dt>
                <dd>{system.data.setupComplete ? <CheckCircle2 size={14} color="var(--green)" /> : <XCircle size={14} color="var(--red)" />}</dd>
                <dt>Agent limit</dt>
                <dd>{system.data.limits.agentModelCallsPerRun} model calls · {system.data.limits.agentRunsPerHour}/hour</dd>
                <dt>Deploy limit</dt>
                <dd>{system.data.limits.deploysPerHour} per hour</dd>
              </dl>
            ) : null}
            <div className="row">
              <button type="button" className="btn danger sm" onClick={() => void logoutAll()}>
                <LogOut size={13} /> Sign out everywhere
              </button>
            </div>
          </section>

          <section className="card stack">
            <div className="card-head">
              <h3>
                <BookOpen size={15} /> Documentation
              </h3>
            </div>
            <div className="stack" style={{ gap: 6 }}>
              {[
                ["Cloudflare setup", "docs/CLOUDFLARE_SETUP.md"],
                ["Deployment", "docs/DEPLOYMENT.md"],
                ["Security model", "docs/SECURITY.md"],
                ["Runtime compatibility", "docs/RUNTIME_COMPATIBILITY.md"],
              ].map(([label, path]) => (
                <div key={path} className="row small">
                  <Terminal size={13} className="dim" />
                  <span>{label}</span>
                  <span className="spacer" />
                  <code className="tiny dim">{path}</code>
                </div>
              ))}
            </div>
            <p className="tiny dim">
              These files live in the repository. KI00 does not serve secrets through documentation.
            </p>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>
                <ShieldCheck size={15} /> Security notes
              </h3>
            </div>
            <ul className="small muted" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
              <li>Provider tokens exist only as Worker secrets; they are never stored in D1 or returned by an API.</li>
              <li>Project variable values are AES-GCM encrypted at rest and returned masked.</li>
              <li>Mutating requests are same-origin only and require a session CSRF token.</li>
              <li>Builds run in Cloudflare Workers Builds isolation, not on a public Worker.</li>
              <li>Destructive actions require explicit confirmation and are written to the audit log.</li>
              <li>The agent can read logs and patches only through bounded tools, with ≤8 model calls per task.</li>
            </ul>
            <div className="row" style={{ marginTop: 10 }}>
              <CopyButton text={window.location.origin} label="Copy origin" />
            </div>
          </section>
        </div>
      </div>

      {connections.data ? (
        <p className="tiny dim">
          <AlertTriangle size={11} style={{ verticalAlign: "-1px" }} /> Provider status is cached for two minutes in
          D1; use “Refresh provider status” to force a live check.{" "}
          <a href="https://developers.cloudflare.com/workers/" target="_blank" rel="noreferrer noopener" style={{ color: "var(--blue-bright)" }}>
            Cloudflare docs <ExternalLink size={10} />
          </a>
        </p>
      ) : null}
    </div>
  );
}
