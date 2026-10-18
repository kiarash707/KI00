import { ArrowUpRight, ExternalLink, Rocket, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Deployment } from "@shared/types";
import { api } from "../lib/api";
import { formatDuration, shortSha, timeAgo } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { Empty, ErrorBanner, Loading, StatusPill } from "../components/ui";

interface DeploymentResponse {
  items: Deployment[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export default function Deployments() {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [triggerKind, setTriggerKind] = useState("");
  const [page, setPage] = useState(1);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), perPage: "30" });
    if (q.trim()) params.set("q", q.trim());
    if (status) params.set("status", status);
    if (triggerKind) params.set("triggerKind", triggerKind);
    return params.toString();
  }, [page, q, status, triggerKind]);

  const { data, error, loading, reload } = useAsync<DeploymentResponse>(
    () => api(`/deployments?${query}`),
    [query]
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Deployments</h1>
          <p>Build history for every project in this workspace. Statuses and logs come from Cloudflare Workers Builds.</p>
        </div>
        <div className="page-actions">
          <Link className="btn primary" to="/projects/new">
            <Rocket size={15} /> New project
          </Link>
        </div>
      </div>

      <section className="card flush">
        <div className="toolbar">
          <div className="search-input">
            <Search size={14} />
            <input
              className="input"
              placeholder="Search commit, message or project"
              value={q}
              onChange={(event) => {
                setQ(event.target.value);
                setPage(1);
              }}
              aria-label="Search deployments"
            />
          </div>
          <select
            className="select"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by status"
          >
            <option value="">Any status</option>
            <option value="queued">Queued</option>
            <option value="initializing">Initializing</option>
            <option value="running">Building</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
            <option value="unknown">Unknown</option>
          </select>
          <select
            className="select"
            value={triggerKind}
            onChange={(event) => {
              setTriggerKind(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by trigger"
          >
            <option value="">All triggers</option>
            <option value="production">Production</option>
            <option value="preview">Preview</option>
          </select>
          <span className="spacer" />
          <span className="small dim">{data ? `${data.total} deployment${data.total === 1 ? "" : "s"}` : ""}</span>
        </div>

        {error ? (
          <div style={{ padding: 16 }}>
            <ErrorBanner error={new Error(error)} onRetry={reload} />
          </div>
        ) : loading && !data ? (
          <Loading label="Loading deployments" />
        ) : data && data.items.length === 0 ? (
          <Empty
            icon={<Rocket size={19} />}
            title="No deployments"
            description="Deploy a project to create a real Cloudflare Workers Build record. KI00 never inserts fake deployments."
            action={
              <Link className="btn primary sm" to="/projects">
                Open projects
              </Link>
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Status</th>
                    <th>Commit</th>
                    <th>Trigger</th>
                    <th>Started</th>
                    <th>Duration</th>
                    <th>URL</th>
                    <th className="right">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.items.map((deployment) => (
                    <tr key={deployment.id}>
                      <td>
                        <Link to={`/projects/${deployment.projectId}`} style={{ fontWeight: 520 }}>
                          {deployment.projectName ?? "Project"}
                        </Link>
                        <div className="tiny dim">{deployment.branch}</div>
                      </td>
                      <td>
                        <Link to={`/deployments/${deployment.id}`}>
                          <StatusPill status={deployment.status} />
                        </Link>
                      </td>
                      <td>
                        <div className="mono tiny">{shortSha(deployment.commitSha)}</div>
                        <div className="tiny dim truncate" style={{ maxWidth: 260 }}>
                          {deployment.commitMessage ?? "—"}
                        </div>
                      </td>
                      <td className="small muted">{deployment.triggerKind}</td>
                      <td className="small muted">{timeAgo(deployment.startedAt ?? deployment.createdAt)}</td>
                      <td className="small muted">{formatDuration(deployment.durationMs)}</td>
                      <td>
                        {deployment.url ? (
                          <a
                            className="small"
                            href={deployment.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            style={{ color: "var(--blue-bright)" }}
                          >
                            Open <ExternalLink size={11} />
                          </a>
                        ) : (
                          <span className="small dim">—</span>
                        )}
                      </td>
                      <td className="right">
                        <Link to={`/deployments/${deployment.id}`} className="btn sm">
                          Logs <ArrowUpRight size={12} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data && data.totalPages > 1 ? (
              <div className="row between" style={{ padding: "10px 14px" }}>
                <span className="small dim">
                  Page {data.page} of {data.totalPages}
                </span>
                <div className="row">
                  <button type="button" className="btn sm" disabled={data.page <= 1} onClick={() => setPage((value) => value - 1)}>
                    Previous
                  </button>
                  <button
                    type="button"
                    className="btn sm"
                    disabled={data.page >= data.totalPages}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    Next
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
