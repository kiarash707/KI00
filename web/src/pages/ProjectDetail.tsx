import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowUpRight,
  Blocks,
  CheckCircle2,
  Cloud,
  ExternalLink,
  GitBranch,
  Globe,
  KeyRound,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { Deployment, DomainRecord, EnvVar, Project, RuntimeLogsResponse } from "@shared/types";
import { ApiRequestError, api, del, errorMessage, patch, post } from "../lib/api";
import { formatDate, formatDuration, shortSha, timeAgo } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import {
  CopyButton,
  Empty,
  ErrorBanner,
  InfoBanner,
  Loading,
  Modal,
  Spinner,
  StatusPill,
  Tabs,
  useToast,
} from "../components/ui";

interface ProjectDetailResponse {
  project: Project;
  recentDeployments: Deployment[];
  counts: { envVars: number; domains: number; deployments: number };
  domains: DomainRecord[];
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "deployments", label: "Deployments" },
  { id: "variables", label: "Variables" },
  { id: "domains", label: "Domains" },
  { id: "logs", label: "Runtime logs" },
  { id: "settings", label: "Settings" },
];

export default function ProjectDetail() {
  const { id = "", tab } = useParams();
  const navigate = useNavigate();
  const activeTab = tab && TABS.some((item) => item.id === tab) ? tab : "overview";

  const { data, error, loading, reload } = useAsync<ProjectDetailResponse>(
    () => api(`/projects/${id}`),
    [id]
  );

  if (loading && !data) return <Loading label="Loading project" />;
  if (error) {
    return (
      <div className="page">
        <ErrorBanner error={new Error(error)} onRetry={reload} />
        <Link to="/projects" className="btn" style={{ alignSelf: "flex-start" }}>
          <ArrowLeft size={14} /> Projects
        </Link>
      </div>
    );
  }
  if (!data) return null;

  const { project } = data;

  return (
    <div className="page">
      <div className="page-head">
        <div className="stack" style={{ gap: 8 }}>
          <div className="row small dim">
            <Link to="/projects" className="row" style={{ gap: 4 }}>
              <ArrowLeft size={13} /> Projects
            </Link>
            <span>/</span>
            <span>{project.repoOwner}/{project.repoName}</span>
          </div>
          <div className="row">
            <h1>{project.name}</h1>
            <StatusPill status={project.status} />
            <StatusPill status={project.compatibilityStatus} />
          </div>
          <p>
            {project.description || `${project.framework ?? "Unknown framework"} · ${project.runtimeKind} runtime`}
          </p>
        </div>
        <div className="page-actions">
          <a className="btn" href={project.repoUrl} target="_blank" rel="noreferrer noopener">
            <GitBranch size={14} /> Repository
          </a>
          {project.url ? (
            <a className="btn" href={project.url} target="_blank" rel="noreferrer noopener">
              <ExternalLink size={14} /> Open site
            </a>
          ) : null}
          <DeployButton project={project} onStarted={(deploymentId) => {
            reload();
            navigate(`/deployments/${deploymentId}`);
          }} />
        </div>
      </div>

      {project.compatibilityStatus !== "compatible" ? (
        <InfoBanner kind="warn">
          <strong>Compatibility: {project.compatibilityStatus.replace("_", " ")}.</strong>
          <span className="small">
            {project.compatibilityNotes.length
              ? project.compatibilityNotes.join(" · ")
              : "This project may not build on Workers. A real build will show the truth."}
          </span>
        </InfoBanner>
      ) : null}

      <section className="card flush">
        <div style={{ padding: "0 8px" }}>
          <Tabs
            tabs={TABS.map((item) =>
              item.id === "variables"
                ? { ...item, count: data.counts.envVars }
                : item.id === "domains"
                  ? { ...item, count: data.counts.domains }
                  : item
            )}
            value={activeTab}
            onChange={(next) => navigate(`/projects/${id}/${next}`)}
          />
        </div>
        <div style={{ padding: 18 }}>
          {activeTab === "overview" ? <OverviewTab data={data} onReload={reload} /> : null}
          {activeTab === "deployments" ? <DeploymentsTab project={project} onChanged={reload} /> : null}
          {activeTab === "variables" ? <VariablesTab project={project} /> : null}
          {activeTab === "domains" ? <DomainsTab project={project} onChanged={reload} /> : null}
          {activeTab === "logs" ? <RuntimeLogsTab project={project} /> : null}
          {activeTab === "settings" ? <SettingsTab project={project} onSaved={reload} onDeleted={() => navigate("/projects")} /> : null}
        </div>
      </section>
    </div>
  );
}

/* ── Deploy ──────────────────────────────────────────────────────────── */

function DeployButton({ project, onStarted }: { project: Project; onStarted: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState(project.branch);
  const [commit, setCommit] = useState("");
  const [kind, setKind] = useState<"production" | "preview">("production");
  const [ack, setAck] = useState(false);
  const [needsAck, setNeedsAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { notify } = useToast();

  useEffect(() => {
    setBranch(project.branch);
    setCommit("");
  }, [project.branch]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await post<{ deployment: Deployment | null }>(`/projects/${project.id}/deploy`, {
        branch: branch.trim() || undefined,
        commitSha: commit.trim() || undefined,
        triggerKind: kind,
        acknowledgeRepoConfig: ack,
      });
      if (!result.deployment) throw new Error("Cloudflare did not return a deployment id");
      notify("Deployment queued on Cloudflare Workers Builds", "success");
      setOpen(false);
      onStarted(result.deployment.id);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "REPO_CONFIG_ACK_REQUIRED") {
        setNeedsAck(true);
        setError(err.message);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="btn primary" onClick={() => setOpen(true)}>
        <Play size={14} /> Deploy
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={`Deploy ${project.name}`}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void submit()} disabled={busy}>
              {busy ? <Spinner /> : <Zap size={14} />} Start deployment
            </button>
          </>
        }
      >
        <p className="small muted">
          This triggers a real build on Cloudflare Workers Builds. KI00 records the deployment only after Cloudflare
          returns a build id, and marks it successful only when Cloudflare reports success.
        </p>
        <div className="field">
          <label htmlFor="deploy-branch">Branch</label>
          <input
            id="deploy-branch"
            className="input mono"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="deploy-commit">Commit SHA (optional)</label>
          <input
            id="deploy-commit"
            className="input mono"
            value={commit}
            onChange={(event) => setCommit(event.target.value)}
            placeholder="Leave empty for the branch head"
          />
        </div>
        <div className="field">
          <label htmlFor="deploy-kind">Trigger</label>
          <select
            id="deploy-kind"
            className="select"
            value={kind}
            onChange={(event) => setKind(event.target.value as "production" | "preview")}
          >
            <option value="production">Production</option>
            <option value="preview">Preview</option>
          </select>
          {kind === "preview" ? (
            <span className="hint">Preview builds must target a branch other than the production branch.</span>
          ) : null}
        </div>
        {needsAck ? (
          <label className="check">
            <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
            <span>
              Allow Cloudflare to attach routes or custom domains declared in this repository&apos;s Wrangler config.
            </span>
          </label>
        ) : null}
        {error ? <ErrorBanner error={new Error(error)} /> : null}
      </Modal>
    </>
  );
}

/* ── Overview ────────────────────────────────────────────────────────── */

function OverviewTab({ data, onReload }: { data: ProjectDetailResponse; onReload: () => void }) {
  const { project, recentDeployments } = data;
  const [syncing, setSyncing] = useState(false);
  const { notify } = useToast();

  const sync = async () => {
    setSyncing(true);
    try {
      const result = await post<{ synced: number; demo?: boolean }>(`/projects/${project.id}/sync`, {});
      notify(result.demo ? "Demo workspace: no Cloudflare sync performed" : `Synced ${result.synced} deployment(s)`, "info");
      onReload();
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="grid main-side">
      <div className="stack">
        <div className="grid cols-3">
          <div className="stat">
            <span className="stat-label"><Blocks size={13} /> Runtime</span>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{project.runtimeKind}</span>
            <span className="stat-note">{project.runtimeDetail ?? project.projectType}</span>
          </div>
          <div className="stat">
            <span className="stat-label"><RefreshCw size={13} /> Last build</span>
            <span style={{ fontSize: 15, fontWeight: 600 }}>
              {project.lastBuildStatus ? <StatusPill status={project.lastBuildStatus} /> : "Never built"}
            </span>
            <span className="stat-note">{project.lastBuildFinishedAt ? timeAgo(project.lastBuildFinishedAt) : "—"}</span>
          </div>
          <div className="stat">
            <span className="stat-label"><Cloud size={13} /> Last deployed</span>
            <span style={{ fontSize: 15, fontWeight: 600 }}>{timeAgo(project.lastDeployedAt)}</span>
            <span className="stat-note">{data.counts.deployments} total deployments</span>
          </div>
        </div>

        <section className="card" style={{ padding: 0, border: 0 }}>
          <div className="card-head">
            <h3>Recent deployments</h3>
            <button type="button" className="btn sm" onClick={() => void sync()} disabled={syncing}>
              {syncing ? <Spinner /> : <RefreshCw size={13} />} Sync
            </button>
          </div>
          {recentDeployments.length === 0 ? (
            <Empty
              icon={<Play size={18} />}
              title="No deployments yet"
              description="Start a production build. Cloudflare Workers Builds will clone the repository and run the configured build."
            />
          ) : (
            <DeploymentTable deployments={recentDeployments} />
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Build configuration</h3>
            <Settings2 size={15} className="dim" />
          </div>
          <dl className="kv">
            <dt>Install command</dt>
            <dd className="mono">{project.installCommand || "—"}</dd>
            <dt>Build command</dt>
            <dd className="mono">{project.buildCommand || "—"}</dd>
            <dt>Deploy command</dt>
            <dd className="mono break">{project.deployCommand || "—"}</dd>
            <dt>Output directory</dt>
            <dd className="mono">{project.outputDir}</dd>
            <dt>Root directory</dt>
            <dd className="mono">{project.rootDir}</dd>
            <dt>SPA fallback</dt>
            <dd>{project.spaFallback ? "Enabled" : "Disabled"}</dd>
            <dt>Auto deploy</dt>
            <dd>{project.autoDeploy ? "On new commits" : "Manual only"}</dd>
          </dl>
        </section>
      </div>

      <div className="stack">
        <section className="card">
          <div className="card-head">
            <h3>Project</h3>
            <StatusPill status={project.status} />
          </div>
          <dl className="kv">
            <dt>Repository</dt>
            <dd>
              <a href={project.repoUrl} target="_blank" rel="noreferrer noopener" style={{ color: "var(--blue-bright)" }}>
                {project.repoFullName} <ExternalLink size={11} />
              </a>
            </dd>
            <dt>Branch</dt>
            <dd className="mono">{project.branch}</dd>
            <dt>Default branch</dt>
            <dd className="mono">{project.defaultBranch}</dd>
            <dt>Worker</dt>
            <dd className="mono">{project.workerName}</dd>
            <dt>URL</dt>
            <dd>
              {project.url ? (
                <a href={project.url} target="_blank" rel="noreferrer noopener" style={{ color: "var(--blue-bright)" }}>
                  {project.url}
                </a>
              ) : (
                <span className="dim">Not published</span>
              )}
            </dd>
            <dt>Detected variables</dt>
            <dd>{project.detectedEnvKeys.length ? project.detectedEnvKeys.join(", ") : "None"}</dd>
            <dt>Created</dt>
            <dd className="small muted">{formatDate(project.createdAt)}</dd>
          </dl>
          {project.url ? <div className="row" style={{ marginTop: 10 }}><CopyButton text={project.url} label="Copy URL" /></div> : null}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Compatibility notes</h3>
          </div>
          {project.compatibilityNotes.length === 0 ? (
            <p className="small muted">No compatibility notes were recorded.</p>
          ) : (
            <ul className="stack" style={{ margin: 0, paddingLeft: 18, gap: 6 }}>
              {project.compatibilityNotes.map((note) => (
                <li key={note} className="small muted">{note}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Quick actions</h3>
          </div>
          <div className="stack" style={{ gap: 8 }}>
            <Link className="btn" to={`/projects/${project.id}/variables`}>
              <KeyRound size={14} /> Manage variables
            </Link>
            <Link className="btn" to={`/projects/${project.id}/domains`}>
              <Globe size={14} /> Custom domains
            </Link>
            {project.runtimeKind === "worker" ? (
              <Link className="btn" to={`/projects/${project.id}/logs`}>
                <Terminal size={14} /> Runtime logs
              </Link>
            ) : null}
            <Link className="btn" to="/agent">
              <Activity size={14} /> Ask the agent
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ── Deployments tab ─────────────────────────────────────────────────── */

function DeploymentsTab({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [page, setPage] = useState(1);
  const { data, error, loading, reload } = useAsync<{
    items: Deployment[];
    total: number;
    totalPages: number;
    page: number;
  }>(() => api(`/deployments?projectId=${project.id}&perPage=20&page=${page}`), [project.id, page]);
  const [target, setTarget] = useState<Deployment | null>(null);
  const [busy, setBusy] = useState(false);
  const { notify } = useToast();
  const navigate = useNavigate();

  const rollback = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const result = await post<{ deploymentId: string }>(`/projects/${project.id}/rollback`, {
        deploymentId: target.id,
      });
      notify("Rollback deployment queued", "success");
      setTarget(null);
      reload();
      onChanged();
      navigate(`/deployments/${result.deploymentId}`);
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {error ? <ErrorBanner error={new Error(error)} onRetry={reload} /> : null}
      {loading && !data ? <Loading label="Loading deployments" /> : null}
      {data && data.items.length === 0 ? (
        <Empty icon={<Play size={18} />} title="No deployments" description="Deploy this project to see real build history here." />
      ) : null}
      {data && data.items.length > 0 ? (
        <>
          <DeploymentTable deployments={data.items} onRollback={(deployment) => setTarget(deployment)} />
          {data.totalPages > 1 ? (
            <div className="row between">
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
      ) : null}

      <Modal
        open={Boolean(target)}
        onClose={() => setTarget(null)}
        title="Roll back to a previous deployment"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setTarget(null)}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void rollback()} disabled={busy}>
              {busy ? <Spinner /> : <RotateCcw size={14} />} Queue rollback
            </button>
          </>
        }
      >
        <p className="small muted">
          KI00 will start a new production build at the commit of the selected successful deployment. The previous
          deployment is not modified; the new build appears as a new deployment record.
        </p>
        {target ? (
          <div className="summary-box">
            <dl className="kv">
              <dt>Deployment</dt>
              <dd className="mono">{target.id}</dd>
              <dt>Commit</dt>
              <dd className="mono">{shortSha(target.commitSha)}</dd>
              <dt>Branch</dt>
              <dd className="mono">{target.branch}</dd>
              <dt>Finished</dt>
              <dd>{formatDate(target.finishedAt)}</dd>
            </dl>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

function DeploymentTable({
  deployments,
  onRollback,
}: {
  deployments: Deployment[];
  onRollback?: (deployment: Deployment) => void;
}) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Status</th>
            <th>Commit</th>
            <th>Branch</th>
            <th>Started</th>
            <th>Duration</th>
            <th>URL</th>
            <th className="right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {deployments.map((deployment) => (
            <tr key={deployment.id}>
              <td>
                <Link to={`/deployments/${deployment.id}`}><StatusPill status={deployment.status} /></Link>
              </td>
              <td>
                <div className="mono tiny">{shortSha(deployment.commitSha)}</div>
                <div className="tiny dim truncate" style={{ maxWidth: 240 }}>
                  {deployment.commitMessage ?? "—"}
                </div>
              </td>
              <td className="small mono">{deployment.branch}</td>
              <td className="small muted">{timeAgo(deployment.startedAt ?? deployment.createdAt)}</td>
              <td className="small muted">{formatDuration(deployment.durationMs)}</td>
              <td>
                {deployment.url ? (
                  <a href={deployment.url} target="_blank" rel="noreferrer noopener" className="small" style={{ color: "var(--blue-bright)" }}>
                    Open <ArrowUpRight size={11} />
                  </a>
                ) : (
                  <span className="small dim">—</span>
                )}
              </td>
              <td className="right">
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <Link to={`/deployments/${deployment.id}`} className="btn sm">Logs</Link>
                  {onRollback && deployment.status === "success" && deployment.commitSha ? (
                    <button type="button" className="btn sm" onClick={() => onRollback(deployment)}>
                      <RotateCcw size={12} /> Rollback
                    </button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ── Variables ───────────────────────────────────────────────────────── */

function VariablesTab({ project }: { project: Project }) {
  const { data, error, loading, reload } = useAsync<{ items: EnvVar[]; hint: string }>(
    () => api(`/projects/${project.id}/variables`),
    [project.id]
  );
  const [editing, setEditing] = useState<EnvVar | "new" | null>(null);
  const [deleting, setDeleting] = useState<EnvVar | null>(null);
  const [form, setForm] = useState({
    key: "",
    value: "",
    isSecret: true,
    scope: "production" as "production" | "preview",
    useBuild: true,
    useRuntime: project.runtimeKind === "worker",
  });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { notify } = useToast();

  useEffect(() => {
    if (editing === "new") {
      setForm({
        key: "",
        value: "",
        isSecret: true,
        scope: "production",
        useBuild: true,
        useRuntime: project.runtimeKind === "worker",
      });
      setFormError(null);
    } else if (editing) {
      setForm({
        key: editing.key,
        value: "",
        isSecret: editing.isSecret,
        scope: editing.scope,
        useBuild: editing.useBuild,
        useRuntime: editing.useRuntime,
      });
      setFormError(null);
    }
  }, [editing, project.runtimeKind]);

  const save = async () => {
    setBusy(true);
    setFormError(null);
    try {
      if (editing === "new") {
        const result = await post<{ warnings: string[] }>(`/projects/${project.id}/variables`, form);
        if (result.warnings.length) notify(result.warnings.join(" · "), "warn");
        else notify("Variable stored and encrypted", "success");
      } else if (editing) {
        const result = await patch<{ warnings: string[] }>(`/projects/${project.id}/variables/${editing.id}`, {
          ...form,
          value: form.value || undefined,
        });
        if (result.warnings.length) notify(result.warnings.join(" · "), "warn");
        else notify("Variable updated", "success");
      }
      setEditing(null);
      reload();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      const result = await del<{ warnings: string[] }>(`/projects/${project.id}/variables/${deleting.id}`, {
        confirm: true,
      });
      if (result.warnings.length) notify(result.warnings.join(" · "), "warn");
      else notify("Variable deleted", "success");
      setDeleting(null);
      reload();
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h3>Environment variables</h3>
          <p className="small muted">
            Values are encrypted with AES-GCM in D1. The API only returns masked values; secret values are never sent
            to the browser.
          </p>
        </div>
        <button type="button" className="btn primary sm" onClick={() => setEditing("new")}>
          <KeyRound size={13} /> Add variable
        </button>
      </div>

      {data?.hint ? <InfoBanner kind="info"><span className="small">{data.hint}</span></InfoBanner> : null}
      {error ? <ErrorBanner error={new Error(error)} onRetry={reload} /> : null}
      {loading && !data ? <Loading label="Loading variables" /> : null}

      {data && data.items.length === 0 ? (
        <Empty
          icon={<KeyRound size={18} />}
          title="No variables"
          description="Add build-time or runtime variables. Runtime bindings only apply to non-static projects on the production scope."
        />
      ) : null}

      {data && data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Key</th>
                <th>Value</th>
                <th>Scope</th>
                <th>Used at</th>
                <th>Type</th>
                <th>Updated</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((variable) => (
                <tr key={variable.id}>
                  <td className="mono">{variable.key}</td>
                  <td className="mono muted">{variable.maskedValue}</td>
                  <td><span className="pill neutral">{variable.scope}</span></td>
                  <td className="small muted">
                    {[variable.useBuild ? "build" : null, variable.useRuntime ? "runtime" : null].filter(Boolean).join(", ") || "—"}
                  </td>
                  <td className="small muted">{variable.isSecret ? "Secret" : "Plain"}</td>
                  <td className="small muted">{timeAgo(variable.updatedAt)}</td>
                  <td className="right">
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <button type="button" className="btn sm" onClick={() => setEditing(variable)}>Edit</button>
                      <button type="button" className="icon-btn" onClick={() => setDeleting(variable)} aria-label={`Delete ${variable.key}`}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Modal
        open={Boolean(editing)}
        onClose={() => setEditing(null)}
        title={editing === "new" ? "Add variable" : editing ? `Edit ${editing.key}` : "Variable"}
        footer={
          <>
            <button type="button" className="btn" onClick={() => setEditing(null)}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void save()} disabled={busy}>
              {busy ? <Spinner /> : <KeyRound size={14} />} Save
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="var-key">Key</label>
          <input
            id="var-key"
            className="input mono"
            value={form.key}
            disabled={editing !== "new"}
            onChange={(event) => setForm({ ...form, key: event.target.value.toUpperCase() })}
            placeholder="API_TOKEN"
          />
          <span className="hint">Uppercase letters, digits and underscores. Keys cannot be renamed.</span>
        </div>
        <div className="field">
          <label htmlFor="var-value">Value</label>
          <input
            id="var-value"
            className="input"
            type="password"
            value={form.value}
            onChange={(event) => setForm({ ...form, value: event.target.value })}
            placeholder={editing === "new" ? "Required" : "Leave empty to keep the current value"}
            autoComplete="new-password"
          />
          <span className="hint">
            {project.runtimeKind === "worker"
              ? "Build values are pushed to the Cloudflare build trigger. Runtime values become encrypted Worker secrets after a successful deploy."
              : "Static sites have no runtime; this value is only available during the build."}
          </span>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="var-scope">Scope</label>
            <select
              id="var-scope"
              className="select"
              value={form.scope}
              onChange={(event) => setForm({ ...form, scope: event.target.value as "production" | "preview" })}
            >
              <option value="production">Production</option>
              <option value="preview">Preview</option>
            </select>
          </div>
          <div className="field">
            <label>Options</label>
            <label className="check"><input type="checkbox" checked={form.isSecret} onChange={(event) => setForm({ ...form, isSecret: event.target.checked })} /> <span>Secret (mask in UI)</span></label>
            <label className="check"><input type="checkbox" checked={form.useBuild} onChange={(event) => setForm({ ...form, useBuild: event.target.checked })} /> <span>Available at build time</span></label>
            <label className="check">
              <input
                type="checkbox"
                checked={form.useRuntime}
                disabled={project.runtimeKind !== "worker" || form.scope !== "production"}
                onChange={(event) => setForm({ ...form, useRuntime: event.target.checked })}
              />
              <span>Runtime binding (Workers, production only)</span>
            </label>
          </div>
        </div>
        {formError ? <ErrorBanner error={new Error(formError)} /> : null}
      </Modal>

      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Delete variable"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDeleting(null)}>Cancel</button>
            <button type="button" className="btn danger" onClick={() => void remove()} disabled={busy}>
              {busy ? <Spinner /> : <Trash2 size={14} />} Delete variable
            </button>
          </>
        }
      >
        <p className="small">
          Delete <code>{deleting?.key}</code> from the {deleting?.scope} scope? If it is the last runtime binding for
          this key, KI00 also removes the Worker secret from Cloudflare. This cannot be undone.
        </p>
      </Modal>
    </div>
  );
}

/* ── Domains ─────────────────────────────────────────────────────────── */

function DomainsTab({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const { data, error, loading, reload } = useAsync<{ items: (DomainRecord & { autoAttached?: boolean })[]; refreshError: string | null }>(
    () => api(`/projects/${project.id}/domains?refresh=1`),
    [project.id, refresh]
  );
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<DomainRecord | null>(null);
  const [hostname, setHostname] = useState("");
  const [confirmHostname, setConfirmHostname] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const { notify } = useToast();

  const add = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const result = await post<{ domain: DomainRecord; attached: boolean }>(`/projects/${project.id}/domains`, {
        hostname: hostname.trim(),
      });
      if (!result.attached) {
        notify("Domain saved with manual DNS instructions. No DNS record was created.", "warn");
      } else {
        notify("Custom domain attached through Cloudflare", "success");
      }
      setAdding(false);
      setHostname("");
      reload();
      onChanged();
    } catch (error) {
      setFormError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      await del(`/projects/${project.id}/domains/${deleting.id}`, { confirmHostname });
      notify("Domain removed", "success");
      setDeleting(null);
      setConfirmHostname("");
      reload();
      onChanged();
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h3>Custom domains</h3>
          <p className="small muted">
            Workers Custom Domains require the DNS zone to be active in this Cloudflare account. KI00 never creates or
            deletes unrelated DNS records, and never touches email records.
          </p>
        </div>
        <div className="row">
          <button type="button" className="btn sm" onClick={() => setRefresh((value) => value + 1)}>
            <RefreshCw size={13} /> Refresh status
          </button>
          <button type="button" className="btn primary sm" onClick={() => setAdding(true)}>
            <Globe size={13} /> Add domain
          </button>
        </div>
      </div>

      {error ? <ErrorBanner error={new Error(error)} onRetry={reload} /> : null}
      {data?.refreshError ? <InfoBanner kind="warn"><span className="small">{data.refreshError}</span></InfoBanner> : null}
      {loading && !data ? <Loading label="Loading domains" /> : null}

      {data && data.items.length === 0 ? (
        <Empty
          icon={<Globe size={18} />}
          title="No custom domains"
          description="Add a hostname that belongs to a Cloudflare zone in your account, or read the manual DNS instructions KI00 returns."
        />
      ) : null}

      {data && data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Hostname</th>
                <th>Status</th>
                <th>Zone</th>
                <th>DNS</th>
                <th>Added</th>
                <th className="right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((domain) => (
                <tr key={domain.id}>
                  <td className="mono">{domain.hostname}</td>
                  <td><StatusPill status={domain.status} /></td>
                  <td className="small muted">{domain.zoneName ?? "External zone"}</td>
                  <td className="small muted">
                    {domain.autoAttached ? "Managed by Cloudflare" : "Manual instructions"}
                  </td>
                  <td className="small muted">{timeAgo(domain.createdAt)}</td>
                  <td className="right">
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      {domain.status === "instructions" ? (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() => notify(domain.dnsInstructions ?? "No instructions recorded", "info")}
                        >
                          Instructions
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="icon-btn"
                        onClick={() => {
                          setDeleting(domain);
                          setConfirmHostname("");
                        }}
                        aria-label={`Remove ${domain.hostname}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {data?.items.some((domain) => domain.dnsInstructions) ? (
        <div className="stack" style={{ gap: 10 }}>
          {data.items
            .filter((domain) => domain.dnsInstructions)
            .map((domain) => (
              <div key={`instructions-${domain.id}`} className="summary-box">
                <div className="row between" style={{ marginBottom: 8 }}>
                  <strong className="small">{domain.hostname}</strong>
                  <CopyButton text={domain.dnsInstructions ?? ""} label="Copy instructions" />
                </div>
                <pre className="small muted break" style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                  {domain.dnsInstructions}
                </pre>
              </div>
            ))}
        </div>
      ) : null}

      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add custom domain"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
            <button type="button" className="btn primary" onClick={() => void add()} disabled={busy || !hostname.trim()}>
              {busy ? <Spinner /> : <Globe size={14} />} Add domain
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="domain-host">Hostname</label>
          <input
            id="domain-host"
            className="input mono"
            value={hostname}
            onChange={(event) => setHostname(event.target.value)}
            placeholder="app.example.com"
            autoComplete="off"
          />
        </div>
        <InfoBanner kind="info">
          <span className="small">
            If the zone is in this account, KI00 attaches a Workers Custom Domain and Cloudflare creates the DNS
            record. Otherwise KI00 stores manual instructions and creates nothing.
          </span>
        </InfoBanner>
        <a className="small" href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer noopener" style={{ color: "var(--blue-bright)" }}>
          Open Cloudflare dashboard <ExternalLink size={11} />
        </a>
        {formError ? <ErrorBanner error={new Error(formError)} /> : null}
      </Modal>

      <Modal
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="Remove custom domain"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDeleting(null)}>Cancel</button>
            <button
              type="button"
              className="btn danger"
              disabled={busy || confirmHostname !== deleting?.hostname}
              onClick={() => void remove()}
            >
              {busy ? <Spinner /> : <Trash2 size={14} />} Remove domain
            </button>
          </>
        }
      >
        <p className="small">
          This detaches <code>{deleting?.hostname}</code> from the Worker. Cloudflare removes the Workers Custom Domain
          record it created. Existing email and unrelated DNS records are not touched. Type the hostname to confirm.
        </p>
        <input
          className="input mono"
          value={confirmHostname}
          onChange={(event) => setConfirmHostname(event.target.value)}
          aria-label="Confirm hostname"
          placeholder={deleting?.hostname}
        />
      </Modal>
    </div>
  );
}

/* ── Runtime logs ────────────────────────────────────────────────────── */

function RuntimeLogsTab({ project }: { project: Project }) {
  const [minutes, setMinutes] = useState(60);
  const [level, setLevel] = useState("all");
  const [q, setQ] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<RuntimeLogsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ minutes: String(minutes), level });
      if (q.trim()) params.set("q", q.trim());
      const result = await api<RuntimeLogsResponse>(`/projects/${project.id}/logs/runtime?${params.toString()}`);
      setData(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [project.id, minutes, level, q]);

  useEffect(() => {
    void load();
  }, [load, refresh]);

  if (project.runtimeKind !== "worker") {
    return (
      <Empty
        icon={<Terminal size={18} />}
        title="No Worker runtime"
        description="This project deploys static assets. Static sites have no Worker invocation logs; build logs are available on each deployment."
      />
    );
  }

  return (
    <div className="stack">
      <div className="row between">
        <div>
          <h3>Runtime logs</h3>
          <p className="small muted">
            Queried from Cloudflare Workers Observability for <code>{project.workerName}</code>. This is not a fake
            stream: if the token cannot read telemetry, KI00 says so.
          </p>
        </div>
        <button type="button" className="btn sm" onClick={() => setRefresh((value) => value + 1)} disabled={loading}>
          {loading ? <Spinner /> : <RefreshCw size={13} />} Refresh
        </button>
      </div>

      <div className="row">
        <select className="select" style={{ width: 140 }} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} aria-label="Window">
          <option value={15}>Last 15 min</option>
          <option value={60}>Last hour</option>
          <option value={360}>Last 6 hours</option>
          <option value={1440}>Last 24 hours</option>
        </select>
        <select className="select" style={{ width: 140 }} value={level} onChange={(event) => setLevel(event.target.value)} aria-label="Level">
          <option value="all">All levels</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </select>
        <input
          className="input"
          style={{ maxWidth: 240 }}
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Search message text"
          aria-label="Search logs"
        />
      </div>

      {error ? <ErrorBanner error={new Error(error)} onRetry={() => setRefresh((value) => value + 1)} /> : null}
      {data && !data.available ? (
        <InfoBanner kind="warn">
          <strong>Runtime logs are unavailable.</strong>
          <span className="small">{data.error ?? "Cloudflare did not return telemetry for this Worker."}</span>
        </InfoBanner>
      ) : null}

      <div className="logs">
        {loading && !data ? (
          <div className="log-empty">Loading runtime logs…</div>
        ) : !data || data.lines.length === 0 ? (
          <div className="log-empty">
            {data?.available
              ? `No runtime events in the last ${data.windowMinutes} minutes.`
              : "No runtime log lines are available."}
          </div>
        ) : (
          data.lines.map((line, index) => (
            <div key={index} className={`log-line ${line.level}`}>
              <span className="log-level">{line.level}</span>
              <span className="log-time">{line.ts ? new Date(line.ts).toLocaleTimeString(undefined, { hour12: false }) : ""}</span>
              <span>{line.text}</span>
            </div>
          ))
        )}
      </div>
      <p className="tiny dim">
        Workers Logs free tier retains 3 days and is limited to 200,000 events per day. KI00 does not stream logs it
        cannot retrieve.
      </p>
    </div>
  );
}

/* ── Settings ────────────────────────────────────────────────────────── */

function SettingsTab({ project, onSaved, onDeleted }: { project: Project; onSaved: () => void; onDeleted: () => void }) {
  const [form, setForm] = useState({
    name: project.name,
    description: project.description,
    branch: project.branch,
    installCommand: project.installCommand,
    buildCommand: project.buildCommand,
    outputDir: project.outputDir,
    rootDir: project.rootDir,
    spaFallback: project.spaFallback,
    autoDeploy: project.autoDeploy,
    buildCaching: project.buildCaching,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const { notify } = useToast();

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await patch(`/projects/${project.id}`, form);
      notify("Project settings saved", "success");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleteBusy(true);
    try {
      const result = await del<{ warnings: string[] }>(`/projects/${project.id}`, { confirmName });
      if (result.warnings.length) notify(result.warnings.join(" · "), "warn");
      else notify("Project deleted", "success");
      onDeleted();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setDeleteBusy(false);
    }
  };

  return (
    <div className="grid main-side">
      <section className="card stack" style={{ padding: 0, border: 0 }}>
        <div className="card-head">
          <h3>Project settings</h3>
          <span className="small dim">Applies to the next build</span>
        </div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="settings-name">Name</label>
            <input id="settings-name" className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="settings-branch">Branch</label>
            <input id="settings-branch" className="input mono" value={form.branch} onChange={(event) => setForm({ ...form, branch: event.target.value })} />
          </div>
          <div className="field full">
            <label htmlFor="settings-description">Description</label>
            <input id="settings-description" className="input" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="settings-install">Install command</label>
            <input id="settings-install" className="input mono" value={form.installCommand} onChange={(event) => setForm({ ...form, installCommand: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="settings-build">Build command</label>
            <input id="settings-build" className="input mono" value={form.buildCommand} onChange={(event) => setForm({ ...form, buildCommand: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="settings-output">Output directory</label>
            <input id="settings-output" className="input mono" value={form.outputDir} onChange={(event) => setForm({ ...form, outputDir: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="settings-root">Root directory</label>
            <input id="settings-root" className="input mono" value={form.rootDir} onChange={(event) => setForm({ ...form, rootDir: event.target.value })} />
          </div>
          <div className="field full">
            <label className="check">
              <input type="checkbox" checked={form.spaFallback} onChange={(event) => setForm({ ...form, spaFallback: event.target.checked })} />
              <span>Single-page application fallback</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={form.autoDeploy} onChange={(event) => setForm({ ...form, autoDeploy: event.target.checked })} />
              <span>Deploy automatically on new commits</span>
            </label>
            <label className="check">
              <input type="checkbox" checked={form.buildCaching} onChange={(event) => setForm({ ...form, buildCaching: event.target.checked })} />
              <span>Cloudflare build caching</span>
            </label>
          </div>
        </div>
        {error ? <ErrorBanner error={new Error(error)} /> : null}
        <div className="row">
          <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner /> : <CheckCircle2 size={14} />} Save settings
          </button>
        </div>
      </section>

      <section className="card stack">
        <div className="card-head">
          <h3 style={{ color: "#ff8a8a" }}>Danger zone</h3>
          <AlertTriangle size={16} color="var(--red)" />
        </div>
        <p className="small muted">
          Deleting the project removes its deployments, variables and domains from KI00, and attempts to delete the
          Cloudflare Worker. This cannot be undone.
        </p>
        <button type="button" className="btn danger" onClick={() => setDeleting(true)}>
          <Trash2 size={14} /> Delete project
        </button>
      </section>

      <Modal
        open={deleting}
        onClose={() => setDeleting(false)}
        title="Delete project"
        footer={
          <>
            <button type="button" className="btn" onClick={() => setDeleting(false)}>Cancel</button>
            <button
              type="button"
              className="btn danger"
              onClick={() => void remove()}
              disabled={deleteBusy || confirmName !== project.name}
            >
              {deleteBusy ? <Spinner /> : <Trash2 size={14} />} Delete {project.name}
            </button>
          </>
        }
      >
        <p className="small">
          Type <code>{project.name}</code> to confirm. KI00 will also try to remove the Cloudflare Worker and its
          Custom Domains first; any failures are reported as warnings and the local record is still deleted.
        </p>
        <input
          className="input"
          value={confirmName}
          onChange={(event) => setConfirmName(event.target.value)}
          aria-label="Confirm project name"
        />
      </Modal>
    </div>
  );
}
