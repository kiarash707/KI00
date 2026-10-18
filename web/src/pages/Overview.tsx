import {
  AlertTriangle,
  ArrowUpRight,
  Blocks,
  Cloud,
  ExternalLink,
  GitBranch,
  Layers,
  Rocket,
  Sparkles,
  Timer,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { Overview as OverviewData } from "@shared/types";
import { api, errorMessage, post } from "../lib/api";
import { compactNumber, formatDate, formatDuration, percent, timeAgo } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { useToast } from "../components/ui";
import {
  Empty,
  ErrorBanner,
  InfoBanner,
  Loading,
  Spinner,
  StatusPill,
} from "../components/ui";

export default function Overview() {
  const { data, error, loading, reload } = useAsync<OverviewData>(() => api("/overview"), []);
  const { notify } = useToast();
  const [syncing, setSyncing] = useState(false);

  const onSync = async () => {
    setSyncing(true);
    try {
      const result = await post<{ synced: number; at: number; demo?: boolean }>("/overview/sync", {});
      if (result.demo) notify("Demo workspace: no Cloudflare sync is performed", "info");
      else notify(`Synced ${result.synced} active deployment${result.synced === 1 ? "" : "s"}`, "success");
      reload();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setSyncing(false);
    }
  };

  if (loading && !data) return <Loading label="Loading workspace overview" />;
  if (error) return <div className="page"><ErrorBanner error={new Error(error)} onRetry={reload} /></div>;
  if (!data) return null;

  const { stats, resources, quotas } = data;
  const maxSpark = Math.max(1, ...stats.sparkline.map((point) => point.success + point.failed));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p>
            Real deployment state for <strong>{data.workspace.name}</strong>. Every number below is computed from
            KI00's D1 records and Cloudflare API responses.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => void onSync()} disabled={syncing}>
            {syncing ? <Spinner /> : <Layers size={15} />}
            Sync deployments
          </button>
          <Link to="/projects/new" className="btn primary">
            <Rocket size={15} />
            Create project
          </Link>
        </div>
      </div>

      {data.demo ? (
        <InfoBanner kind="warn">
          <strong>Demo workspace.</strong>
          <span className="small">
            Project and deployment records are sample fixtures. KI00 does not call Cloudflare, GitHub or OpenRouter
            in demo mode, and all write operations are disabled.
          </span>
        </InfoBanner>
      ) : null}

      <div className="grid cols-4">
        <Stat label="Projects" value={compactNumber(stats.projects)} icon={<Blocks size={13} />} note="In this workspace" />
        <Stat
          label="Deployments"
          value={compactNumber(stats.deployments)}
          icon={<Rocket size={13} />}
          note={`${stats.last7d} in the last 7 days`}
        />
        <Stat
          label="Success rate"
          value={percent(stats.successRate)}
          icon={<Sparkles size={13} />}
          note={`${stats.successful} succeeded · ${stats.failed} failed`}
        />
        <Stat
          label="Building now"
          value={compactNumber(stats.building)}
          icon={<Timer size={13} />}
          note={stats.building > 0 ? "Cloudflare reports these as active" : "No active builds"}
        />
      </div>

      <div className="grid main-side">
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <div>
                <h3>Deployments · last 14 days</h3>
                <span className="card-sub">Successful and failed builds from KI00's deployment records.</span>
              </div>
              <span className="muted small">
                Last sync: {data.lastSyncAt ? timeAgo(data.lastSyncAt) : "never"}
              </span>
            </div>
            <div className="sparkline" aria-label="Deployments per day for the last 14 days">
              {stats.sparkline.map((point) => {
                const total = point.success + point.failed;
                return (
                  <div
                    key={point.day}
                    className="bar"
                    title={`${point.day}: ${point.success} succeeded, ${point.failed} failed`}
                    style={{ height: `${Math.max(6, (total / maxSpark) * 100)}%` }}
                  >
                    <span
                      className="ok"
                      style={{
                        height: total ? `${(point.success / total) * 100}%` : 0,
                        background: point.failed > point.success ? "var(--amber)" : undefined,
                      }}
                    />
                  </div>
                );
              })}
            </div>
            <div className="row small dim" style={{ marginTop: 10, justifyContent: "space-between" }}>
              <span>{stats.sparkline[0]?.day}</span>
              <span>
                {stats.last7d} deployments · {stats.last7dFailed} failed in 7 days
              </span>
              <span>{stats.sparkline[stats.sparkline.length - 1]?.day}</span>
            </div>
          </section>

          <section className="card flush">
            <div className="toolbar">
              <h3 style={{ flex: 1 }}>Recent deployments</h3>
              <Link to="/deployments" className="btn sm">
                View all <ArrowUpRight size={13} />
              </Link>
            </div>
            {data.recentDeployments.length === 0 ? (
              <Empty
                icon={<Rocket size={19} />}
                title="No deployments yet"
                description="Create a project from GitHub and start your first Cloudflare Workers build."
                action={
                  <Link to="/projects/new" className="btn primary sm">
                    Create project
                  </Link>
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Project</th>
                      <th>Status</th>
                      <th>Commit</th>
                      <th>Started</th>
                      <th className="right">Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recentDeployments.map((deployment) => (
                      <tr key={deployment.id}>
                        <td>
                          <Link to={`/deployments/${deployment.id}`} style={{ fontWeight: 520 }}>
                            {deployment.projectName ?? "Project"}
                          </Link>
                          <div className="tiny dim">{deployment.branch}</div>
                        </td>
                        <td>
                          <StatusPill status={deployment.status} />
                        </td>
                        <td className="mono">{deployment.commitSha?.slice(0, 7) ?? "—"}</td>
                        <td className="muted small">{timeAgo(deployment.createdAt)}</td>
                        <td className="right small muted">{formatDuration(deployment.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="grid cols-2">
            <section className="card">
              <div className="card-head">
                <h3>Cloudflare resources</h3>
                <StatusPill
                  status={resources.cloudflare.ok === false ? "failed" : resources.cloudflare.ok ? "success" : "unknown"}
                  label={resources.cloudflare.ok === false ? "Unavailable" : resources.cloudflare.ok ? "Connected" : "Unknown"}
                />
              </div>
              <dl className="kv">
                <dt>Account</dt>
                <dd>{resources.cloudflare.accountName ?? resources.cloudflare.accountId ?? "Not reported"}</dd>
                <dt>workers.dev</dt>
                <dd>{resources.cloudflare.subdomain ?? "Not reported"}</dd>
                <dt>Workers</dt>
                <dd>{resources.cloudflare.workerCount === null ? "Not reported" : resources.cloudflare.workerCount}</dd>
                <dt>Build minutes</dt>
                <dd>
                  {resources.cloudflare.buildMinutes.remaining !== null
                    ? `${resources.cloudflare.buildMinutes.remaining} remaining of ${resources.cloudflare.buildMinutes.limit ?? "?"}`
                    : resources.cloudflare.buildMinutes.error || "Not exposed by the API token"}
                </dd>
              </dl>
              <div className="row" style={{ marginTop: 12 }}>
                <a
                  className="btn sm"
                  href={resources.cloudflare.consoleUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Cloudflare dashboard <ExternalLink size={12} />
                </a>
              </div>
            </section>

            <section className="card">
              <div className="card-head">
                <h3>GitHub &amp; AI</h3>
                <StatusPill
                  status={resources.github.ok === false ? "failed" : resources.github.ok ? "success" : "unknown"}
                  label={resources.github.ok === false ? "Unavailable" : resources.github.ok ? "Connected" : "Unknown"}
                />
              </div>
              <dl className="kv">
                <dt>GitHub mode</dt>
                <dd>{resources.github.mode === "token" ? "Authenticated token" : "Public repositories only"}</dd>
                <dt>GitHub login</dt>
                <dd>{resources.github.login ?? "—"}</dd>
                <dt>Rate limit</dt>
                <dd>
                  {resources.github.rateLimit.remaining !== null
                    ? `${resources.github.rateLimit.remaining} / ${resources.github.rateLimit.limit} remaining`
                    : "Not reported"}
                </dd>
                <dt>OpenRouter</dt>
                <dd>
                  {resources.openrouter.configured
                    ? `${resources.openrouter.freeModels ?? "?"} free tool-capable models`
                    : "Not configured"}
                </dd>
                <dt>Agent model</dt>
                <dd className="mono tiny">{resources.openrouter.selectedModel ?? "—"}</dd>
              </dl>
            </section>
          </div>
        </div>

        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h3>Important errors</h3>
              <span className="card-sub">{data.errors.length}</span>
            </div>
            {data.errors.length === 0 ? (
              <p className="small muted">No error-level activity has been recorded.</p>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                {data.errors.map((item) => (
                  <Link
                    key={item.id}
                    to={item.projectId ? `/projects/${item.projectId}` : "/activity"}
                    className="row"
                    style={{ gap: 8, alignItems: "flex-start" }}
                  >
                    <AlertTriangle size={14} color="var(--red)" style={{ marginTop: 2, flex: "none" }} />
                    <div>
                      <div className="small">{item.message}</div>
                      <div className="tiny dim">
                        {item.projectName ? `${item.projectName} · ` : ""}
                        {timeAgo(item.createdAt)}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Quotas &amp; limits</h3>
              <Cloud size={15} className="dim" />
            </div>
            <div className="stack" style={{ gap: 14 }}>
              {quotas.map((quota) => {
                const ratio =
                  quota.used !== null && quota.limit
                    ? Math.min(100, Math.round((quota.used / quota.limit) * 100))
                    : null;
                return (
                  <div key={quota.name}>
                    <div className="row between small" style={{ marginBottom: 5 }}>
                      <span>{quota.name}</span>
                      <span className="dim">
                        {quota.used !== null ? compactNumber(quota.used) : "—"}
                        {quota.limit !== null ? ` / ${compactNumber(quota.limit)}` : ""} {quota.unit}
                      </span>
                    </div>
                    <div className="meter">
                      <span style={{ width: `${ratio ?? 0}%` }} />
                    </div>
                    {quota.note ? <div className="tiny dim" style={{ marginTop: 5 }}>{quota.note}</div> : null}
                    {quota.docsUrl ? (
                      <a
                        className="tiny"
                        href={quota.docsUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{ color: "var(--blue-bright)" }}
                      >
                        Cloudflare limits
                      </a>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Activity</h3>
              <Link to="/activity" className="small" style={{ color: "var(--blue-bright)" }}>
                All activity
              </Link>
            </div>
            {data.activities.length === 0 ? (
              <p className="small muted">No activity recorded yet.</p>
            ) : (
              <div className="stack" style={{ gap: 10 }}>
                {data.activities.slice(0, 8).map((item) => (
                  <div key={item.id} className="row" style={{ gap: 8, alignItems: "flex-start" }}>
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        marginTop: 7,
                        borderRadius: "50%",
                        flex: "none",
                        background:
                          item.level === "error"
                            ? "var(--red)"
                            : item.level === "warn"
                              ? "var(--amber)"
                              : item.level === "success"
                                ? "var(--green)"
                                : "var(--blue)",
                      }}
                    />
                    <div>
                      <div className="small">{item.message}</div>
                      <div className="tiny dim">{timeAgo(item.createdAt)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <div className="small dim">
            <GitBranch size={12} style={{ verticalAlign: "-2px" }} /> Builds run on Cloudflare Workers Builds.
            Static assets are served free; CPU limits apply to Worker requests.
            <div style={{ marginTop: 6 }}>Data captured {formatDate(Date.now())}.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
  note,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  note: string;
}) {
  return (
    <div className="stat">
      <span className="stat-label">
        {icon}
        {label}
      </span>
      <span className="stat-value">{value}</span>
      <span className="stat-note">{note}</span>
    </div>
  );
}
