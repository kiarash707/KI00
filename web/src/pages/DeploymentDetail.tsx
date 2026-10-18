import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  ExternalLink,
  Info,
  RefreshCw,
  Rocket,
  Search,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { DeploymentDetail as DeploymentDetailType, DeploymentStatus, Project } from "@shared/types";
import { api, errorMessage, post } from "../lib/api";
import { formatDate, formatDuration, shortSha, timeAgo } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import {
  CopyButton,
  ErrorBanner,
  InfoBanner,
  Loading,
  Modal,
  Spinner,
  StatusPill,
  Tabs,
  useToast,
} from "../components/ui";

interface DeploymentResponse {
  deployment: DeploymentDetailType & { project: Project };
}

const ACTIVE: DeploymentStatus[] = ["queued", "initializing", "running"];

export default function DeploymentDetail() {
  const { id = "" } = useParams();
  const { notify } = useToast();
  const { data, error, loading, reload } = useAsync<DeploymentResponse>(() => api(`/deployments/${id}`), [id]);
  const [logs, setLogs] = useState<{ ts: number | null; level: string; text: string }[]>([]);
  const [logsMeta, setLogsMeta] = useState<{ source: string; truncated: boolean; error: string | null } | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [level, setLevel] = useState("all");
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [tab, setTab] = useState("logs");
  const attempts = useRef(0);
  const timer = useRef<number | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  const fetchLogs = useCallback(
    async (force = false) => {
      setLogsLoading(true);
      setLogsError(null);
      try {
        const params = new URLSearchParams();
        if (force) params.set("refresh", "1");
        const result = await api<{ deployment: DeploymentDetailType }>(
          `/deployments/${id}/logs${params.toString() ? `?${params.toString()}` : ""}`
        );
        if (!mounted.current) return;
        setLogs(result.deployment.logs ?? []);
        setLogsMeta({
          source: result.deployment.logsSource,
          truncated: result.deployment.logsTruncated,
          error: result.deployment.logsError,
        });
        return result.deployment;
      } catch (err) {
        if (mounted.current) setLogsError(errorMessage(err));
        return null;
      } finally {
        if (mounted.current) setLogsLoading(false);
      }
    },
    [id]
  );

  const sync = useCallback(
    async (silent = false) => {
      if (!silent) setSyncing(true);
      try {
        await post(`/deployments/${id}/sync`, {});
        const deployment = await fetchLogs(true);
        if (deployment) {
          reload();
          if (deployment.status === "success" && !silent) notify("Cloudflare reports this build as successful", "success");
          if (deployment.status === "failed" && !silent) notify("Cloudflare reports this build as failed", "error");
        }
      } catch (err) {
        if (!silent) notify(errorMessage(err), "error");
      } finally {
        if (!silent) setSyncing(false);
      }
    },
    [id, fetchLogs, reload, notify]
  );

  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  const status = data?.deployment.status;
  const isActive = status ? ACTIVE.includes(status) : false;

  useEffect(() => {
    if (!isActive || !autoRefresh) return;
    attempts.current = 0;

    const tick = async () => {
      attempts.current += 1;
      const deployment = await fetchLogs(true);
      if (!mounted.current) return;
      if (deployment && ACTIVE.includes(deployment.status) && attempts.current < 120) {
        timer.current = window.setTimeout(tick, 5000);
      } else {
        reload();
      }
    };

    timer.current = window.setTimeout(tick, 2500);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [isActive, autoRefresh, fetchLogs, reload]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return logs.filter((line) => {
      if (level !== "all" && line.level !== level) return false;
      if (term && !line.text.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [logs, level, search]);

  const cancel = async () => {
    setCancelling(true);
    try {
      await post(`/deployments/${id}/cancel`, {});
      notify("Cancel request sent to Cloudflare", "info");
      setConfirmCancel(false);
      reload();
      void fetchLogs(true);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setCancelling(false);
    }
  };

  if (loading && !data) return <Loading label="Loading deployment" />;
  if (error) {
    return (
      <div className="page">
        <ErrorBanner error={new Error(error)} onRetry={reload} />
        <Link to="/deployments" className="btn" style={{ alignSelf: "flex-start" }}>
          <ArrowLeft size={14} /> Deployments
        </Link>
      </div>
    );
  }
  if (!data) return null;

  const { deployment } = data;
  const project = deployment.project;

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 8 }}>
          <div className="row small dim">
            <Link to="/deployments" className="row" style={{ gap: 4 }}>
              <ArrowLeft size={13} /> Deployments
            </Link>
            <span>/</span>
            <Link to={`/projects/${project.id}`}>{project.name}</Link>
          </div>
          <div className="row">
            <h1>Deployment</h1>
            <StatusPill status={deployment.status} />
            {deployment.triggerKind === "preview" ? <span className="pill neutral">Preview</span> : null}
          </div>
          <p className="mono small">
            {deployment.id} · {deployment.branch} @ {shortSha(deployment.commitSha)}
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={() => void sync()} disabled={syncing}>
            {syncing ? <Spinner /> : <RefreshCw size={14} />} Sync from Cloudflare
          </button>
          {isActive ? (
            <button type="button" className="btn danger" onClick={() => setConfirmCancel(true)}>
              <Ban size={14} /> Cancel build
            </button>
          ) : null}
          {deployment.url ? (
            <a className="btn primary" href={deployment.url} target="_blank" rel="noreferrer noopener">
              <ExternalLink size={14} /> Open site
            </a>
          ) : null}
        </div>
      </div>

      {deployment.status === "unknown" ? (
        <InfoBanner kind="warn">
          <strong>Cloudflare no longer reports this build.</strong>
          <span className="small">
            KI00 marks the deployment unknown instead of pretending it succeeded. Re-deploy if this was unexpected.
          </span>
        </InfoBanner>
      ) : null}

      {deployment.errorSummary ? (
        <div className="banner error">
          <AlertTriangle size={16} />
          <div className="stack" style={{ gap: 6 }}>
            <strong>Build failure</strong>
            <pre className="small break" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
              {deployment.errorSummary}
            </pre>
          </div>
        </div>
      ) : null}

      <section className="card flush">
        <div style={{ padding: "0 8px" }}>
          <Tabs
            tabs={[
              { id: "logs", label: "Build logs", count: logs.length },
              { id: "meta", label: "Details" },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
        <div style={{ padding: 18 }}>
          {tab === "logs" ? (
            <div className="stack">
              <div className="toolbar" style={{ padding: 0, border: 0 }}>
                <div className="search-input">
                  <Search size={14} />
                  <input
                    className="input"
                    placeholder="Search log text"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    aria-label="Search logs"
                  />
                </div>
                <select className="select" value={level} onChange={(event) => setLevel(event.target.value)} aria-label="Log level">
                  <option value="all">All levels</option>
                  <option value="error">Errors</option>
                  <option value="warn">Warnings</option>
                  <option value="info">Info</option>
                  <option value="debug">Debug</option>
                  <option value="system">System</option>
                </select>
                <label className="check">
                  <input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} />
                  <span>Auto refresh {isActive ? "(every 5s)" : ""}</span>
                </label>
                <button type="button" className="btn sm" onClick={() => void fetchLogs(true)} disabled={logsLoading}>
                  {logsLoading ? <Spinner /> : <RefreshCw size={13} />} Refresh
                </button>
                <CopyButton text={filtered.map((line) => `${line.level.toUpperCase()} ${line.text}`).join("\n")} label="Copy logs" />
              </div>

              {logsError ? <ErrorBanner error={new Error(logsError)} onRetry={() => void fetchLogs(true)} /> : null}
              {logsMeta?.error && logs.length === 0 ? (
                <InfoBanner kind="warn">
                  <strong>Logs unavailable.</strong>
                  <span className="small">{logsMeta.error}</span>
                </InfoBanner>
              ) : null}

              <div className="logs" aria-live="polite">
                {filtered.length === 0 ? (
                  <div className="log-empty">
                    {logsLoading && logs.length === 0
                      ? "Fetching Cloudflare build output…"
                      : logs.length === 0
                        ? isActive
                          ? "The build is queued. Cloudflare output appears as soon as the build starts."
                          : "No log lines were returned for this deployment."
                        : "No lines match the current filter."}
                  </div>
                ) : (
                  filtered.map((line, index) => (
                    <div key={index} className={`log-line ${line.level}`}>
                      <span className="log-level">{line.level}</span>
                      <span className="log-time">
                        {line.ts ? new Date(line.ts).toLocaleTimeString(undefined, { hour12: false }) : ""}
                      </span>
                      <span>{line.text}</span>
                    </div>
                  ))
                )}
              </div>
              <div className="row small dim">
                <Terminal size={13} />
                <span>
                  Source: {logsMeta?.source ?? "unknown"}
                  {logsMeta?.truncated ? " · truncated by KI00" : ""}
                </span>
                <span className="spacer" />
                {isActive && attempts.current > 0 ? <span>Poll attempt {attempts.current}</span> : null}
              </div>
            </div>
          ) : (
            <div className="stack">
              <dl className="kv">
                <dt>Deployment id</dt>
                <dd className="mono">{deployment.id}</dd>
                <dt>Project</dt>
                <dd>
                  <Link to={`/projects/${project.id}`} style={{ color: "var(--blue-bright)" }}>
                    {project.name}
                  </Link>
                </dd>
                <dt>Provider</dt>
                <dd className="mono">{deployment.provider}</dd>
                <dt>Trigger</dt>
                <dd>{deployment.triggerKind}</dd>
                <dt>Cloudflare build id</dt>
                <dd className="mono">{deployment.buildUuid ?? "—"}</dd>
                <dt>Commit</dt>
                <dd className="mono break">
                  {deployment.commitSha ?? "—"}
                  {deployment.commitMessage ? <div className="small muted">{deployment.commitMessage}</div> : null}
                </dd>
                <dt>Author</dt>
                <dd>{deployment.author ?? "—"}</dd>
                <dt>Branch</dt>
                <dd className="mono">{deployment.branch}</dd>
                <dt>Created</dt>
                <dd>{formatDate(deployment.createdAt)}</dd>
                <dt>Started</dt>
                <dd>{formatDate(deployment.startedAt)}</dd>
                <dt>Finished</dt>
                <dd>{formatDate(deployment.finishedAt)}</dd>
                <dt>Duration</dt>
                <dd>{formatDuration(deployment.durationMs)}</dd>
                <dt>Outcome</dt>
                <dd>{deployment.outcome ?? "—"}</dd>
                <dt>Published URL</dt>
                <dd>
                  {deployment.url ? (
                    <a href={deployment.url} target="_blank" rel="noreferrer noopener" style={{ color: "var(--blue-bright)" }}>
                      {deployment.url}
                    </a>
                  ) : (
                    <span className="dim">Not published</span>
                  )}
                </dd>
                <dt>Preview URL</dt>
                <dd>
                  {deployment.previewUrl ? (
                    <a href={deployment.previewUrl} target="_blank" rel="noreferrer noopener" style={{ color: "var(--blue-bright)" }}>
                      {deployment.previewUrl}
                    </a>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </dd>
                <dt>Rollback of</dt>
                <dd>
                  {deployment.rollbackOf ? (
                    <Link to={`/deployments/${deployment.rollbackOf}`} className="mono" style={{ color: "var(--blue-bright)" }}>
                      {deployment.rollbackOf}
                    </Link>
                  ) : (
                    "—"
                  )}
                </dd>
                <dt>Log cache</dt>
                <dd className="small muted">
                  {deployment.logsCachedAt ? `Cached ${timeAgo(deployment.logsCachedAt)}` : "Not cached"} · {deployment.logsBytes} bytes
                </dd>
              </dl>
              <InfoBanner kind="info">
                <span className="small">
                  The success state is set from Cloudflare&apos;s build outcome. KI00 does not verify application
                  behavior, and it cannot health-check a URL from the browser because of the Content Security Policy.
                </span>
              </InfoBanner>
            </div>
          )}
        </div>
      </section>

      <Modal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        title="Cancel this build"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setConfirmCancel(false)}>Keep building</button>
            <button type="button" className="btn danger" onClick={() => void cancel()} disabled={cancelling}>
              {cancelling ? <Spinner /> : <Ban size={14} />} Cancel build
            </button>
          </>
        }
      >
        <p className="small">
          KI00 asks Cloudflare to cancel build <code>{deployment.buildUuid ?? deployment.id}</code>. A cancelled build
          never publishes to production. This action is recorded in the audit log.
        </p>
        <div className="row small dim">
          <Rocket size={13} /> {project.name} · {deployment.branch} @ {shortSha(deployment.commitSha)}
        </div>
        <div className="row small dim">
          <Info size={13} /> Cancellation is not instant; Cloudflare must acknowledge it.
        </div>
      </Modal>
    </div>
  );
}
