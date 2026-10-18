import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Github,
  GitBranch,
  Loader2,
  Plus,
  Rocket,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type {
  DeploymentDetail,
  DeploymentStatus,
  Project,
  RepoAnalysis,
  RepoSummary,
  BranchSummary,
} from "@shared/types";
import { ApiRequestError, api, errorMessage, post } from "../lib/api";
import { formatDuration, shortSha, timeAgo } from "../lib/format";
import { useSession } from "../lib/session";
import {
  CopyButton,
  ErrorBanner,
  InfoBanner,
  Loading,
  Spinner,
  StatusPill,
  useToast,
} from "../components/ui";

const STEPS = [
  "GitHub connection",
  "Repository",
  "Branch",
  "Detection",
  "Compatibility",
  "Settings",
  "Variables",
  "Build & deploy",
];

interface EnvDraft {
  key: string;
  value: string;
  isSecret: boolean;
  useBuild: boolean;
  useRuntime: boolean;
}

interface FormState {
  name: string;
  description: string;
  branch: string;
  framework: string;
  language: string;
  projectType: string;
  runtimeKind: "static" | "worker";
  runtimeDetail: string;
  buildCommand: string;
  installCommand: string;
  outputDir: string;
  rootDir: string;
  spaFallback: boolean;
  autoDeploy: boolean;
  hasWranglerConfig: boolean;
  wranglerHasRoutes: boolean;
  compatibilityStatus: string;
  compatibilityNotes: string[];
  detectedEnvKeys: string[];
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  branch: "main",
  framework: "Static site",
  language: "HTML",
  projectType: "static",
  runtimeKind: "static",
  runtimeDetail: "",
  buildCommand: "",
  installCommand: "",
  outputDir: "dist",
  rootDir: "/",
  spaFallback: false,
  autoDeploy: true,
  hasWranglerConfig: false,
  wranglerHasRoutes: false,
  compatibilityStatus: "compatible",
  compatibilityNotes: [],
  detectedEnvKeys: [],
};

export default function NewProject() {
  const navigate = useNavigate();
  const { session } = useSession();
  const { notify } = useToast();

  const [step, setStep] = useState(0);
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [reposError, setReposError] = useState<string | null>(null);
  const [repoFilter, setRepoFilter] = useState("");
  const [manual, setManual] = useState(false);
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [branches, setBranches] = useState<BranchSummary[] | null>(null);
  const [branchesError, setBranchesError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<RepoAnalysis | null>(null);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [asserted, setAsserted] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [envDrafts, setEnvDrafts] = useState<EnvDraft[]>([]);
  const [envKeysInput, setEnvKeysInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<Project | null>(null);
  const [deploymentId, setDeploymentId] = useState<string | null>(null);
  const [deployment, setDeployment] = useState<DeploymentDetail | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [needsAck, setNeedsAck] = useState(false);
  const [starting, setStarting] = useState(false);
  const [logs, setLogs] = useState<{ ts: number | null; level: string; text: string }[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);

  const githubOk = session?.capabilities.providers.github.ok;

  const loadRepos = useCallback(async () => {
    setReposError(null);
    try {
      const data = await api<{ repos: RepoSummary[] }>("/github/repos");
      setRepos(data.repos);
    } catch (error) {
      setRepos([]);
      setReposError(errorMessage(error));
      if (error instanceof ApiRequestError && error.code === "GITHUB_NOT_CONFIGURED") setManual(true);
    }
  }, []);

  useEffect(() => {
    if (step === 1 && repos === null) void loadRepos();
  }, [step, repos, loadRepos]);

  const selectRepo = async (repoSummary: RepoSummary) => {
    setOwner(repoSummary.owner);
    setRepo(repoSummary.name);
    setForm((current) => ({
      ...current,
      name: current.name || repoSummary.name.slice(0, 50),
      branch: repoSummary.defaultBranch || "main",
    }));
    setStep(2);
    setBranches(null);
    setBranchesError(null);
    try {
      const data = await api<{ branches: BranchSummary[] }>(
        `/github/branches?owner=${encodeURIComponent(repoSummary.owner)}&repo=${encodeURIComponent(repoSummary.name)}`
      );
      setBranches(data.branches);
    } catch (error) {
      setBranchesError(errorMessage(error));
    }
  };

  const continueManualRepo = () => {
    if (!owner.trim() || !repo.trim()) {
      notify("Enter both the repository owner and name", "warn");
      return;
    }
    setStep(2);
    setBranches(null);
    api<{ branches: BranchSummary[] }>(
      `/github/branches?owner=${encodeURIComponent(owner.trim())}&repo=${encodeURIComponent(repo.trim())}`
    )
      .then((data) => setBranches(data.branches))
      .catch((error) => setBranchesError(errorMessage(error)));
  };

  const analyze = async () => {
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const result = await post<RepoAnalysis>("/github/analyze", {
        owner: owner.trim(),
        repo: repo.trim(),
        branch: form.branch,
      });
      setAnalysis(result);
      const detection = result.detection;
      setForm((current) => ({
        ...current,
        name: current.name || detection.suggestedName,
        framework: detection.framework,
        language: detection.language,
        projectType: detection.projectType,
        runtimeKind: detection.runtimeKind === "worker" ? "worker" : "static",
        runtimeDetail: detection.runtimeDetail,
        buildCommand: detection.buildCommand,
        installCommand: detection.installCommand,
        outputDir: detection.outputDir,
        rootDir: detection.rootDir,
        spaFallback: detection.spaFallback,
        hasWranglerConfig: detection.hasWrangler,
        compatibilityStatus: detection.compatibilityStatus,
        compatibilityNotes: detection.compatibilityNotes,
        detectedEnvKeys: detection.requiredEnvKeys,
      }));
      setEnvDrafts(
        detection.requiredEnvKeys.slice(0, 20).map((key) => ({
          key,
          value: "",
          isSecret: true,
          useBuild: true,
          useRuntime: detection.runtimeKind === "worker",
        }))
      );
      setStep(3);
    } catch (error) {
      setAnalysisError(errorMessage(error));
      setStep(3);
    } finally {
      setAnalyzing(false);
    }
  };

  const chooseBranch = (branch: string) => {
    setForm((current) => ({ ...current, branch }));
    setStep(3);
    void analyze();
  };

  const manualSettings = () => {
    setForm((current) => ({
      ...EMPTY_FORM,
      name: current.name || repo,
      branch: current.branch || "main",
      compatibilityStatus: "compatible",
      compatibilityNotes: ["Manual configuration asserted by the operator; automatic detection did not complete."],
    }));
    setAsserted(false);
    setStep(5);
  };

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const canLeaveCompatibility = analysis?.detection.compatibilityStatus === "compatible" || asserted;

  const createProject = async () => {
    if (!form.name.trim()) {
      notify("Give the project a name", "warn");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const project = await post<{ project: Project }>("/projects", {
        name: form.name.trim(),
        description: form.description.trim(),
        repoOwner: owner.trim(),
        repoName: repo.trim(),
        branch: form.branch,
        framework: form.framework || "Static site",
        language: form.language || "unknown",
        projectType: form.projectType || "static",
        runtimeKind: form.runtimeKind,
        runtimeDetail: form.runtimeDetail,
        compatibilityStatus: "compatible",
        compatibilityNotes: form.compatibilityNotes,
        installCommand: form.installCommand,
        buildCommand: form.buildCommand,
        outputDir: form.outputDir,
        rootDir: form.rootDir,
        spaFallback: form.spaFallback,
        autoDeploy: form.autoDeploy,
        detectedEnvKeys: form.detectedEnvKeys,
        hasWranglerConfig: form.hasWranglerConfig,
        wranglerHasRoutes: form.wranglerHasRoutes,
        acknowledgeRepoConfig: ack,
      });
      setCreated(project.project);

      const warnings: string[] = [];
      for (const draft of envDrafts) {
        if (!draft.key.trim() || !draft.value) continue;
        try {
          const result = await post<{ warnings: string[] }>(`/projects/${project.project.id}/variables`, {
            key: draft.key.trim(),
            value: draft.value,
            isSecret: draft.isSecret,
            scope: "production",
            useBuild: draft.useBuild,
            useRuntime: draft.useRuntime,
          });
          warnings.push(...result.warnings);
        } catch (error) {
          warnings.push(`${draft.key}: ${errorMessage(error)}`);
        }
      }
      if (warnings.length) notify(warnings.join(" · "), "warn");
      setStep(7);
      await startBuild(project.project.id, false);
    } catch (error) {
      setCreateError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  };

  const startBuild = async (projectId: string, acknowledge: boolean) => {
    setStarting(true);
    setDeployError(null);
    setNeedsAck(false);
    try {
      const result = await post<{ deployment: DeploymentDetail | null }>(`/projects/${projectId}/deploy`, {
        triggerKind: "production",
        acknowledgeRepoConfig: acknowledge,
      });
      if (result.deployment) {
        setDeploymentId(result.deployment.id);
        setDeployment(result.deployment as DeploymentDetail);
      }
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "REPO_CONFIG_ACK_REQUIRED") {
        setNeedsAck(true);
        setDeployError(error.message);
      } else {
        setDeployError(errorMessage(error));
      }
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    if (!deploymentId) return;
    let attempts = 0;
    let cancelled = false;

    const tick = async () => {
      attempts += 1;
      try {
        await post(`/deployments/${deploymentId}/sync`, {});
        const detail = await api<{ deployment: DeploymentDetail }>(`/deployments/${deploymentId}/logs?refresh=1`);
        if (cancelled) return;
        setDeployment(detail.deployment);
        setLogs(detail.deployment.logs ?? []);
        setLogsError(detail.deployment.logsError);
        const terminal = ["success", "failed", "cancelled", "skipped", "unknown"].includes(
          detail.deployment.status
        );
        if (terminal || attempts >= 150) {
          if (pollTimer.current) window.clearTimeout(pollTimer.current);
          if (detail.deployment.status === "success") {
            notify("Cloudflare reported the build as successful", "success");
          }
          return;
        }
      } catch (error) {
        if (!cancelled) setLogsError(errorMessage(error));
      }
      if (!cancelled) pollTimer.current = window.setTimeout(tick, 5000);
    };

    void tick();
    return () => {
      cancelled = true;
      if (pollTimer.current) window.clearTimeout(pollTimer.current);
    };
  }, [deploymentId, notify]);

  const filteredRepos = useMemo(() => {
    const term = repoFilter.trim().toLowerCase();
    if (!repos) return [];
    if (!term) return repos;
    return repos.filter(
      (item) =>
        item.fullName.toLowerCase().includes(term) || (item.language ?? "").toLowerCase().includes(term)
    );
  }, [repos, repoFilter]);

  const status: DeploymentStatus | null = deployment?.status ?? null;
  const done = status === "success";
  const failed = status === "failed" || status === "cancelled" || status === "unknown";

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Create project</h1>
          <p>
            KI00 inspects the repository, checks Workers compatibility, creates the project, then runs a real
            Cloudflare Workers Build. Nothing is published until Cloudflare reports success.
          </p>
        </div>
        <div className="page-actions">
          <Link to="/projects" className="btn">
            <ArrowLeft size={14} /> Projects
          </Link>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(190px, 230px) minmax(0, 1fr)", alignItems: "start" }}>
        <aside className="card" style={{ position: "sticky", top: 76 }}>
          <div className="steps">
            {STEPS.map((label, index) => (
              <div
                key={label}
                className={`step ${index === step ? "current" : ""} ${index < step ? "done" : ""}`}
                aria-current={index === step ? "step" : undefined}
              >
                <span className="step-num">{index < step ? <CheckCircle2 size={11} /> : index + 1}</span>
                <span>{label}</span>
              </div>
            ))}
          </div>
        </aside>

        <div className="stack">
          {step === 0 ? (
            <section className="card stack">
              <div className="card-head">
                <h3>
                  <Github size={16} /> GitHub connection
                </h3>
                <StatusPill
                  status={githubOk === false ? "failed" : githubOk ? "success" : "unknown"}
                  label={githubOk === false ? "Token unavailable" : githubOk ? "Connected" : "Checking"}
                />
              </div>
              <p className="muted small">
                KI00 reads repository metadata, branches and files with the server-side <code>GITHUB_TOKEN</code>.
                It never receives your GitHub password, and the token never reaches the browser.
              </p>
              <InfoBanner kind="info">
                <strong>Cloudflare Workers Builds also needs repository access.</strong>
                <span className="small">
                  Install the Cloudflare GitHub App on the repository and create a Workers Builds build token.
                  Without it, KI00 can create the project record but Cloudflare cannot clone or build the repo.
                </span>
              </InfoBanner>
              <div className="row">
                <button type="button" className="btn primary" onClick={() => setStep(1)}>
                  Continue <ArrowRight size={14} />
                </button>
                <button type="button" className="btn ghost" onClick={() => setManual(true)}>
                  Enter a public repository manually
                </button>
              </div>
            </section>
          ) : null}

          {step === 1 ? (
            <section className="card stack">
              <div className="card-head">
                <h3>
                  <Github size={16} /> Select a repository
                </h3>
                {repos ? <span className="small dim">{repos.length} accessible</span> : null}
              </div>
              {reposError ? <ErrorBanner error={new Error(reposError)} onRetry={() => void loadRepos()} /> : null}
              {manual ? (
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="manual-owner">Owner</label>
                    <input
                      id="manual-owner"
                      className="input"
                      value={owner}
                      onChange={(event) => setOwner(event.target.value)}
                      placeholder="octocat"
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="manual-repo">Repository</label>
                    <input
                      id="manual-repo"
                      className="input"
                      value={repo}
                      onChange={(event) => setRepo(event.target.value)}
                      placeholder="hello-world"
                    />
                  </div>
                  <div className="full">
                    <button type="button" className="btn primary" onClick={continueManualRepo}>
                      Load branches <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              ) : repos === null ? (
                <Loading label="Listing repositories" />
              ) : (
                <>
                  <div className="search-input">
                    <Search size={14} />
                    <input
                      className="input"
                      placeholder="Filter repositories"
                      value={repoFilter}
                      onChange={(event) => setRepoFilter(event.target.value)}
                      aria-label="Filter repositories"
                    />
                  </div>
                  <div className="repo-list">
                    {filteredRepos.map((item) => (
                      <button key={item.id} type="button" className="repo-item" onClick={() => void selectRepo(item)}>
                        <Github size={15} className="dim" />
                        <span style={{ flex: 1 }}>
                          <span style={{ fontWeight: 520 }}>{item.fullName}</span>
                          <span className="tiny dim" style={{ display: "block" }}>
                            {item.language ?? "unknown language"} · default {item.defaultBranch}
                            {item.private ? " · private" : ""}
                          </span>
                        </span>
                        <ArrowRight size={14} className="dim" />
                      </button>
                    ))}
                    {filteredRepos.length === 0 ? (
                      <div className="empty">
                        <p className="small muted">No repositories match this filter.</p>
                        <button type="button" className="btn sm" onClick={() => setManual(true)}>
                          Enter owner/name manually
                        </button>
                      </div>
                    ) : null}
                  </div>
                </>
              )}
              <div className="row">
                <button type="button" className="btn ghost" onClick={() => setStep(0)}>
                  <ArrowLeft size={14} /> Back
                </button>
              </div>
            </section>
          ) : null}

          {step === 2 ? (
            <section className="card stack">
              <div className="card-head">
                <h3>
                  <GitBranch size={16} /> Branch
                </h3>
                <span className="small mono">
                  {owner}/{repo}
                </span>
              </div>
              {branchesError ? <ErrorBanner error={new Error(branchesError)} /> : null}
              {branches === null ? (
                <Loading label="Loading branches" />
              ) : (
                <div className="repo-list">
                  {branches.map((branch) => (
                    <button
                      key={branch.name}
                      type="button"
                      className={`repo-item ${branch.name === form.branch ? "selected" : ""}`}
                      onClick={() => chooseBranch(branch.name)}
                    >
                      <GitBranch size={14} />
                      <span style={{ flex: 1 }}>{branch.name}</span>
                      <span className="tiny dim mono">{branch.sha.slice(0, 7)}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="row">
                <button type="button" className="btn ghost" onClick={() => setStep(1)}>
                  <ArrowLeft size={14} /> Back
                </button>
                <button type="button" className="btn primary" onClick={() => void analyze()} disabled={analyzing}>
                  {analyzing ? <Spinner /> : <Search size={14} />}
                  Analyse {owner}/{repo}
                </button>
              </div>
            </section>
          ) : null}

          {step === 3 ? (
            <section className="card stack">
              <div className="card-head">
                <h3>Detection</h3>
                <span className="small dim">Inspects config files, not the whole repository</span>
              </div>
              {analyzing ? (
                <Loading label="Analysing repository and checking Workers compatibility" />
              ) : analysis ? (
                <div className="stack">
                  <dl className="kv">
                    <dt>Framework</dt>
                    <dd>{analysis.detection.framework}</dd>
                    <dt>Language</dt>
                    <dd>{analysis.detection.language}</dd>
                    <dt>Project type</dt>
                    <dd>{analysis.detection.projectType}</dd>
                    <dt>Runtime</dt>
                    <dd>
                      {analysis.detection.runtimeKind} · {analysis.detection.runtimeDetail || "default"}
                    </dd>
                    <dt>Branch</dt>
                    <dd className="mono">
                      {analysis.branch} @ {shortSha(analysis.commit?.sha)}
                    </dd>
                    <dt>Confidence</dt>
                    <dd>{analysis.detection.confidence}</dd>
                  </dl>
                  <div className="row">
                    <button type="button" className="btn primary" onClick={() => setStep(4)}>
                      Review compatibility <ArrowRight size={14} />
                    </button>
                    <button type="button" className="btn ghost" onClick={() => setStep(5)}>
                      Adjust settings manually
                    </button>
                  </div>
                </div>
              ) : (
                <div className="stack">
                  <ErrorBanner error={new Error(analysisError ?? "Analysis has not run")} onRetry={() => void analyze()} />
                  <button type="button" className="btn" onClick={manualSettings}>
                    Enter settings manually
                  </button>
                </div>
              )}
              <button type="button" className="btn ghost" onClick={() => setStep(2)}>
                <ArrowLeft size={14} /> Back
              </button>
            </section>
          ) : null}

          {step === 4 ? (
            <section className="card stack">
              <div className="card-head">
                <h3>Compatibility check</h3>
                {analysis ? (
                  <StatusPill status={analysis.detection.compatibilityStatus} />
                ) : (
                  <StatusPill status="unknown" label="Manual review" />
                )}
              </div>

              {analysis ? (
                <>
                  <dl className="kv">
                    <dt>Workers runtime</dt>
                    <dd>
                      {analysis.detection.runtimeKind} —{" "}
                      {analysis.detection.runtimeKind === "static"
                        ? "served as Workers static assets"
                        : analysis.detection.runtimeKind === "worker"
                          ? "deployed as a Worker script"
                          : "not deployable on KI00's current runtime classes"}
                    </dd>
                    <dt>Blockers</dt>
                    <dd>
                      {analysis.detection.blockers.length
                        ? analysis.detection.blockers.join(" · ")
                        : "None detected"}
                    </dd>
                    <dt>Evidence</dt>
                    <dd className="small muted">{analysis.detection.evidence.join(" · ") || "—"}</dd>
                  </dl>

                  {analysis.detection.compatibilityStatus === "compatible" ? (
                    <InfoBanner kind="info">
                      This project can be deployed on Cloudflare Workers. The build engine will install dependencies,
                      run the build command, and publish the detected output directory.
                    </InfoBanner>
                  ) : (
                    <div className="stack">
                      <InfoBanner kind="warn">
                        <strong>KI00 will not create this project as-is.</strong>
                        <span className="small">
                          {analysis.detection.compatibilityStatus === "needs_adapter"
                            ? "The app needs a Cloudflare adapter before Workers can serve it. Adding an adapter changes your application code, so it is not automatic."
                            : "This runtime cannot execute on Cloudflare Workers, and KI00 will not fake a deployment."}
                        </span>
                      </InfoBanner>
                      {analysis.detection.migrationOptions.length ? (
                        <div className="small">
                          <strong>Migration options</strong>
                          <ul style={{ margin: "6px 0 0 18px", padding: 0 }}>
                            {analysis.detection.migrationOptions.map((option) => (
                              <li key={option} className="muted">
                                {option}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={asserted}
                          onChange={(event) => setAsserted(event.target.checked)}
                        />
                        <span>
                          I have already added the required adapter or verified that this repository actually builds
                          to a static/Worker output. I understand KI00 will report the real build result instead of
                          converting the app.
                        </span>
                      </label>
                    </div>
                  )}
                </>
              ) : (
                <div className="stack">
                  <InfoBanner kind="warn">
                    <strong>Automatic detection did not complete.</strong>
                    <span className="small">
                      Set the runtime and build settings manually. KI00 will still run the real build; if the output
                      is not a deployable Worker or static directory, the build will fail and you will see the real
                      logs.
                    </span>
                  </InfoBanner>
                  <div className="field">
                    <label htmlFor="runtime-kind">Runtime</label>
                    <select
                      id="runtime-kind"
                      className="select"
                      value={form.runtimeKind}
                      onChange={(event) => update("runtimeKind", event.target.value as "static" | "worker")}
                    >
                      <option value="static">Static assets</option>
                      <option value="worker">Worker</option>
                    </select>
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={asserted}
                      onChange={(event) => setAsserted(event.target.checked)}
                    />
                    <span>
                      I verified that this repository produces a static directory or a Worker, and accept that a real
                      build will determine the outcome.
                    </span>
                  </label>
                </div>
              )}

              <div className="row">
                <button type="button" className="btn ghost" onClick={() => setStep(3)}>
                  <ArrowLeft size={14} /> Back
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={!canLeaveCompatibility}
                  onClick={() => setStep(5)}
                >
                  Continue to settings <ArrowRight size={14} />
                </button>
              </div>
            </section>
          ) : null}

          {step === 5 ? (
            <section className="card stack">
              <div className="card-head">
                <h3>Project settings</h3>
                <span className="small dim">These values control the real build</span>
              </div>
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="project-name">Name</label>
                  <input
                    id="project-name"
                    className="input"
                    value={form.name}
                    onChange={(event) => update("name", event.target.value)}
                    maxLength={50}
                  />
                </div>
                <div className="field">
                  <label htmlFor="project-branch">Branch</label>
                  <input
                    id="project-branch"
                    className="input mono"
                    value={form.branch}
                    onChange={(event) => update("branch", event.target.value)}
                  />
                </div>
                <div className="field full">
                  <label htmlFor="project-description">Description</label>
                  <input
                    id="project-description"
                    className="input"
                    value={form.description}
                    onChange={(event) => update("description", event.target.value)}
                    maxLength={300}
                  />
                </div>
                <div className="field">
                  <label htmlFor="install-command">Install command</label>
                  <input
                    id="install-command"
                    className="input mono"
                    value={form.installCommand}
                    onChange={(event) => update("installCommand", event.target.value)}
                    placeholder="npm ci"
                  />
                </div>
                <div className="field">
                  <label htmlFor="build-command">Build command</label>
                  <input
                    id="build-command"
                    className="input mono"
                    value={form.buildCommand}
                    onChange={(event) => update("buildCommand", event.target.value)}
                    placeholder="npm run build"
                  />
                </div>
                <div className="field">
                  <label htmlFor="output-dir">Output directory</label>
                  <input
                    id="output-dir"
                    className="input mono"
                    value={form.outputDir}
                    onChange={(event) => update("outputDir", event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="root-dir">Root directory</label>
                  <input
                    id="root-dir"
                    className="input mono"
                    value={form.rootDir}
                    onChange={(event) => update("rootDir", event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor="runtime-detail">Runtime detail</label>
                  <input
                    id="runtime-detail"
                    className="input"
                    value={form.runtimeDetail}
                    onChange={(event) => update("runtimeDetail", event.target.value)}
                    placeholder="Cloudflare Workers Static Assets"
                  />
                </div>
                <div className="field">
                  <label htmlFor="project-type">Project type</label>
                  <input
                    id="project-type"
                    className="input"
                    value={form.projectType}
                    onChange={(event) => update("projectType", event.target.value)}
                  />
                </div>
                <div className="field full">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={form.spaFallback}
                      onChange={(event) => update("spaFallback", event.target.checked)}
                    />
                    <span>Single-page application fallback (serve index.html for unknown paths)</span>
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={form.autoDeploy}
                      onChange={(event) => update("autoDeploy", event.target.checked)}
                    />
                    <span>Deploy automatically on new commits (Cloudflare build trigger)</span>
                  </label>
                  {form.hasWranglerConfig ? (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={form.wranglerHasRoutes}
                        onChange={(event) => update("wranglerHasRoutes", event.target.checked)}
                      />
                      <span>
                        The repository&apos;s Wrangler config declares routes or custom domains that Cloudflare may
                        attach during deploy
                      </span>
                    </label>
                  ) : null}
                </div>
              </div>
              <div className="row">
                <button type="button" className="btn ghost" onClick={() => setStep(4)}>
                  <ArrowLeft size={14} /> Back
                </button>
                <button type="button" className="btn primary" onClick={() => setStep(6)}>
                  Variables <ArrowRight size={14} />
                </button>
              </div>
            </section>
          ) : null}

          {step === 6 ? (
            <section className="card stack">
              <div className="card-head">
                <h3>Environment variables</h3>
                <span className="small dim">Detected names only — values are never inferred</span>
              </div>
              {form.detectedEnvKeys.length ? (
                <InfoBanner kind="info">
                  The repository references these variable names. KI00 cannot read their values. Add values here, or
                  add them later in the project&apos;s Variables tab.
                </InfoBanner>
              ) : (
                <p className="small muted">
                  No environment variable names were detected. You can skip this step and add variables later.
                </p>
              )}

              <div className="stack">
                {envDrafts.map((draft, index) => (
                  <div className="row" key={`${draft.key}-${index}`} style={{ alignItems: "flex-end" }}>
                    <div className="field" style={{ minWidth: 150 }}>
                      <label htmlFor={`env-key-${index}`}>Key</label>
                      <input
                        id={`env-key-${index}`}
                        className="input mono"
                        value={draft.key}
                        onChange={(event) => {
                          const next = [...envDrafts];
                          next[index] = { ...draft, key: event.target.value.toUpperCase() };
                          setEnvDrafts(next);
                        }}
                      />
                    </div>
                    <div className="field" style={{ flex: 1 }}>
                      <label htmlFor={`env-value-${index}`}>Value</label>
                      <input
                        id={`env-value-${index}`}
                        className="input"
                        type={draft.isSecret ? "password" : "text"}
                        value={draft.value}
                        onChange={(event) => {
                          const next = [...envDrafts];
                          next[index] = { ...draft, value: event.target.value };
                          setEnvDrafts(next);
                        }}
                        placeholder="Required before deploys that need it"
                      />
                    </div>
                    <label className="check" style={{ paddingBottom: 8 }}>
                      <input
                        type="checkbox"
                        checked={draft.useBuild}
                        onChange={(event) => {
                          const next = [...envDrafts];
                          next[index] = { ...draft, useBuild: event.target.checked };
                          setEnvDrafts(next);
                        }}
                      />
                      <span className="tiny">build</span>
                    </label>
                    <label className="check" style={{ paddingBottom: 8 }}>
                      <input
                        type="checkbox"
                        checked={draft.useRuntime}
                        disabled={form.runtimeKind !== "worker"}
                        onChange={(event) => {
                          const next = [...envDrafts];
                          next[index] = { ...draft, useRuntime: event.target.checked };
                          setEnvDrafts(next);
                        }}
                      />
                      <span className="tiny">runtime</span>
                    </label>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label={`Remove ${draft.key}`}
                      onClick={() => setEnvDrafts(envDrafts.filter((_, itemIndex) => itemIndex !== index))}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>

              <div className="row">
                <input
                  className="input mono"
                  style={{ maxWidth: 220 }}
                  value={envKeysInput}
                  onChange={(event) => setEnvKeysInput(event.target.value.toUpperCase())}
                  placeholder="API_TOKEN"
                  aria-label="Additional variable name"
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const key = envKeysInput.trim();
                    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
                      notify("Use uppercase letters, digits and underscores, starting with a letter", "warn");
                      return;
                    }
                    setEnvDrafts([
                      ...envDrafts,
                      {
                        key,
                        value: "",
                        isSecret: true,
                        useBuild: true,
                        useRuntime: form.runtimeKind === "worker",
                      },
                    ]);
                    setEnvKeysInput("");
                  }}
                >
                  <Plus size={14} /> Add
                </button>
              </div>

              {createError ? <ErrorBanner error={new Error(createError)} /> : null}

              <div className="row">
                <button type="button" className="btn ghost" onClick={() => setStep(5)}>
                  <ArrowLeft size={14} /> Back
                </button>
                <button type="button" className="btn primary" onClick={() => void createProject()} disabled={creating}>
                  {creating ? <Spinner /> : <Rocket size={14} />}
                  Create project and build
                </button>
              </div>
              <p className="tiny dim">
                Creating the project records it in D1. The build is triggered on Cloudflare Workers Builds and only
                marked successful when Cloudflare reports success.
              </p>
            </section>
          ) : null}

          {step === 7 ? (
            <section className="card stack">
              <div className="card-head">
                <h3>Build &amp; deploy</h3>
                {deployment ? <StatusPill status={deployment.status} /> : null}
              </div>

              {created ? (
                <div className="row small">
                  <span className="dim">Project</span>
                  <Link to={`/projects/${created.id}`} style={{ color: "var(--blue-bright)" }}>
                    {created.name}
                  </Link>
                  <span className="dim">·</span>
                  <span className="mono tiny">{created.workerName}</span>
                  <span className="spacer" />
                  <CopyButton text={`${window.location.origin}/projects/${created.id}`} label="Copy link" />
                </div>
              ) : null}

              {needsAck ? (
                <div className="stack">
                  <InfoBanner kind="warn">
                    <strong>Wrangler config declares routes or domains.</strong>
                    <span className="small">{deployError}</span>
                  </InfoBanner>
                  <label className="check">
                    <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
                    <span>
                      Allow Cloudflare to attach the routes/custom domains declared in this repository&apos;s Wrangler
                      config when it deploys.
                    </span>
                  </label>
                  {created ? (
                    <button
                      type="button"
                      className="btn primary"
                      disabled={!ack || starting}
                      onClick={() => void startBuild(created.id, true)}
                    >
                      {starting ? <Spinner /> : <Rocket size={14} />} Retry build
                    </button>
                  ) : null}
                </div>
              ) : null}

              {deployError && !needsAck ? (
                <ErrorBanner error={new Error(deployError)} onRetry={created ? () => void startBuild(created.id, ack) : undefined} />
              ) : null}

              {deployError && !deployment ? (
                <div className="row">
                  {created ? (
                    <Link to={`/projects/${created.id}`} className="btn">
                      Continue without a build
                    </Link>
                  ) : null}
                </div>
              ) : null}

              {deployment ? (
                <>
                  <div className="summary-box">
                    <dl className="kv">
                      <dt>Deployment</dt>
                      <dd className="mono">{deployment.id}</dd>
                      <dt>Status</dt>
                      <dd>
                        <StatusPill status={deployment.status} />
                      </dd>
                      <dt>Branch / commit</dt>
                      <dd className="mono">
                        {deployment.branch} @ {shortSha(deployment.commitSha)}
                      </dd>
                      <dt>Started</dt>
                      <dd>{deployment.startedAt ? timeAgo(deployment.startedAt) : "waiting for Cloudflare"}</dd>
                      <dt>Duration</dt>
                      <dd>{formatDuration(deployment.durationMs)}</dd>
                      <dt>URL</dt>
                      <dd>
                        {deployment.url ? (
                          <a href={deployment.url} target="_blank" rel="noreferrer noopener" style={{ color: "var(--blue-bright)" }}>
                            {deployment.url} <ExternalLink size={11} />
                          </a>
                        ) : (
                          <span className="dim">Not published yet</span>
                        )}
                      </dd>
                    </dl>
                  </div>

                  <div className="logs">
                    {logs.length === 0 ? (
                      <div className="log-empty">
                        {status === "queued" || status === "initializing" || status === "running" ? (
                          <span className="row" style={{ justifyContent: "center", gap: 8 }}>
                            <Loader2 size={14} className="spin" /> Waiting for Cloudflare build output…
                          </span>
                        ) : (
                          logsError ?? "No build output is available for this deployment."
                        )}
                      </div>
                    ) : (
                      logs.map((line, index) => (
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

                  {logsError && logs.length > 0 ? (
                    <p className="tiny dim">{logsError}</p>
                  ) : null}

                  {done ? (
                    <InfoBanner kind="info">
                      <strong>Build succeeded.</strong>
                      <span className="small">
                        Cloudflare finished the build and published the Worker. The deployment is recorded in history
                        with its commit and logs.
                      </span>
                    </InfoBanner>
                  ) : null}
                  {failed ? (
                    <InfoBanner kind="warn">
                      <strong>Build did not succeed.</strong>
                      <span className="small">
                        {deployment.errorSummary ?? "Cloudflare reported a non-success status."} Open the project to
                        inspect logs and settings.
                      </span>
                    </InfoBanner>
                  ) : null}

                  <div className="row">
                    {created ? (
                      <>
                        <Link to={`/projects/${created.id}`} className="btn primary">
                          Open project
                        </Link>
                        <Link to={`/deployments/${deployment.id}`} className="btn">
                          Deployment details
                        </Link>
                      </>
                    ) : null}
                    {done || failed ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          if (created) navigate(`/projects/${created.id}`);
                          else navigate("/projects");
                        }}
                      >
                        Done
                      </button>
                    ) : null}
                  </div>
                </>
              ) : !deployError ? (
                <Loading label="Creating deployment" />
              ) : null}

              {failed ? (
                <div className="row small dim">
                  <XCircle size={13} /> Failure details are real Cloudflare build output, not simulated.
                </div>
              ) : null}
              {!deployment && !deployError ? (
                <div className="row small dim">
                  <AlertTriangle size={13} /> The build queue can take a minute to start.
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
