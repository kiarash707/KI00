import { Activity as ActivityIcon, ChevronLeft, ChevronRight, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Activity as ActivityItem, AuditEntry } from "@shared/types";
import { api } from "../lib/api";
import { formatDate, timeAgo } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { useSession } from "../lib/session";
import { Empty, ErrorBanner, Loading, Tabs } from "../components/ui";

interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export default function ActivityPage() {
  const { session } = useSession();
  const [tab, setTab] = useState("activity");
  const [level, setLevel] = useState("");
  const [page, setPage] = useState(1);
  const [auditPage, setAuditPage] = useState(1);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), perPage: "30" });
    if (level) params.set("level", level);
    return params.toString();
  }, [page, level]);

  const activity = useAsync<Paged<ActivityItem>>(() => api(`/activity?${query}`), [query]);
  const canAudit = ["owner", "admin"].includes(session?.workspace?.role ?? "");
  const audit = useAsync<Paged<AuditEntry> | { error: string }>(
    () => (canAudit ? api(`/audit?page=${auditPage}&perPage=30`) : Promise.resolve({ error: "Restricted" })),
    [auditPage, canAudit]
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p>
            Every entry is recorded by KI00 when something actually happens: project changes, deployments, variable
            edits and provider failures.
          </p>
        </div>
      </div>

      <section className="card flush">
        <div style={{ padding: "0 8px" }}>
          <Tabs
            tabs={[
              { id: "activity", label: "Activity", count: activity.data?.total },
              { id: "audit", label: "Audit log" },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>

        {tab === "activity" ? (
          <>
            <div className="toolbar">
              <select
                className="select"
                value={level}
                onChange={(event) => {
                  setLevel(event.target.value);
                  setPage(1);
                }}
                aria-label="Filter by level"
              >
                <option value="">All levels</option>
                <option value="error">Errors</option>
                <option value="warn">Warnings</option>
                <option value="success">Success</option>
                <option value="info">Info</option>
              </select>
              <span className="spacer" />
              <span className="small dim">{activity.data ? `${activity.data.total} entries` : ""}</span>
            </div>

            {activity.error ? (
              <div style={{ padding: 16 }}>
                <ErrorBanner error={new Error(activity.error)} onRetry={activity.reload} />
              </div>
            ) : activity.loading && !activity.data ? (
              <Loading label="Loading activity" />
            ) : activity.data && activity.data.items.length === 0 ? (
              <Empty
                icon={<ActivityIcon size={19} />}
                title="No activity"
                description="Actions such as creating a project, deploying, or changing a variable appear here."
              />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Level</th>
                      <th>Event</th>
                      <th>Message</th>
                      <th>Project</th>
                      <th>Actor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activity.data?.items.map((item) => (
                      <tr key={item.id}>
                        <td className="small muted" title={formatDate(item.createdAt)}>
                          {timeAgo(item.createdAt)}
                        </td>
                        <td>
                          <span className={`pill ${item.level === "error" ? "failed" : item.level === "warn" ? "queued" : item.level === "success" ? "success" : "neutral"}`}>
                            {item.level}
                          </span>
                        </td>
                        <td className="mono tiny">{item.type}</td>
                        <td className="small">{item.message}</td>
                        <td className="small">
                          {item.projectId ? (
                            <Link to={`/projects/${item.projectId}`} style={{ color: "var(--blue-bright)" }}>
                              {item.projectName ?? "Project"}
                            </Link>
                          ) : (
                            <span className="dim">—</span>
                          )}
                        </td>
                        <td className="small muted">{item.actor ?? "system"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <Pagination
              page={activity.data?.page ?? 1}
              totalPages={activity.data?.totalPages ?? 1}
              onChange={setPage}
            />
          </>
        ) : (
          <>
            <div className="toolbar">
              <ShieldCheck size={15} className="dim" />
              <span className="small muted">
                Append-only record of mutating actions. Available to workspace owners and admins.
              </span>
            </div>
            {!canAudit ? (
              <Empty
                icon={<ShieldCheck size={19} />}
                title="Audit log is restricted"
                description="Only workspace owners and admins can read the audit log. Ask an owner to review it."
              />
            ) : audit.error ? (
              <div style={{ padding: 16 }}>
                <ErrorBanner error={new Error(audit.error)} onRetry={audit.reload} />
              </div>
            ) : audit.loading && !audit.data ? (
              <Loading label="Loading audit log" />
            ) : "error" in (audit.data ?? {}) ? (
              <Empty
                icon={<ShieldCheck size={19} />}
                title="Audit log is restricted"
                description="The server rejected this request. Sign in as an owner or admin."
              />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Action</th>
                      <th>Actor</th>
                      <th>Target</th>
                      <th>Metadata</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(audit.data as Paged<AuditEntry>)?.items.map((entry) => (
                      <tr key={entry.id}>
                        <td className="small muted" title={formatDate(entry.createdAt)}>
                          {timeAgo(entry.createdAt)}
                        </td>
                        <td className="mono tiny">{entry.action}</td>
                        <td className="small muted">{entry.actorEmail ?? "—"}</td>
                        <td className="small">
                          {entry.targetType ?? "—"}
                          {entry.targetId ? <span className="dim"> · {entry.targetId}</span> : null}
                        </td>
                        <td className="tiny dim mono break" style={{ maxWidth: 320 }}>
                          {entry.meta ? JSON.stringify(entry.meta).slice(0, 240) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {canAudit ? (
              <Pagination
                page={(audit.data as Paged<AuditEntry>)?.page ?? 1}
                totalPages={(audit.data as Paged<AuditEntry>)?.totalPages ?? 1}
                onChange={setAuditPage}
              />
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function Pagination({
  page,
  totalPages,
  onChange,
}: {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;
  return (
    <div className="row between" style={{ padding: "10px 14px" }}>
      <span className="small dim">
        Page {page} of {totalPages}
      </span>
      <div className="row">
        <button type="button" className="btn sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <ChevronLeft size={13} /> Previous
        </button>
        <button type="button" className="btn sm" disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
          Next <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}
