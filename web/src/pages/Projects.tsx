import { Blocks, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Project } from "@shared/types";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { Empty, ErrorBanner, Loading, StatusPill } from "../components/ui";

interface ProjectResponse {
  items: Project[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
}

export default function Projects() {
  const [q, setQ] = useState("");
  const [runtime, setRuntime] = useState("");
  const [compatibility, setCompatibility] = useState("");
  const [sort, setSort] = useState("updated");
  const [page, setPage] = useState(1);

  const query = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), perPage: "25", sort });
    if (q.trim()) params.set("q", q.trim());
    if (runtime) params.set("runtime", runtime);
    if (compatibility) params.set("compatibility", compatibility);
    return params.toString();
  }, [page, q, runtime, compatibility, sort]);

  const { data, error, loading, reload } = useAsync<ProjectResponse>(
    () => api(`/projects?${query}`),
    [query]
  );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>GitHub repositories connected to Cloudflare Workers, with their real compatibility and build state.</p>
        </div>
        <div className="page-actions">
          <Link to="/projects/new" className="btn primary">
            <Plus size={15} />
            Create project
          </Link>
        </div>
      </div>

      <section className="card flush">
        <div className="toolbar">
          <div className="search-input">
            <Search size={14} />
            <input
              className="input"
              placeholder="Search name or repository"
              value={q}
              onChange={(event) => {
                setQ(event.target.value);
                setPage(1);
              }}
              aria-label="Search projects"
            />
          </div>
          <select
            className="select"
            value={runtime}
            onChange={(event) => {
              setRuntime(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by runtime"
          >
            <option value="">All runtimes</option>
            <option value="static">Static assets</option>
            <option value="worker">Worker</option>
          </select>
          <select
            className="select"
            value={compatibility}
            onChange={(event) => {
              setCompatibility(event.target.value);
              setPage(1);
            }}
            aria-label="Filter by compatibility"
          >
            <option value="">Any compatibility</option>
            <option value="compatible">Compatible</option>
            <option value="needs_adapter">Adapter required</option>
            <option value="incompatible">Incompatible</option>
          </select>
          <select className="select" value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort">
            <option value="updated">Recently updated</option>
            <option value="name">Name</option>
            <option value="deployed">Last deployed</option>
          </select>
          <span className="spacer" />
          <span className="small dim">{data ? `${data.total} project${data.total === 1 ? "" : "s"}` : ""}</span>
        </div>

        {error ? (
          <div style={{ padding: 16 }}>
            <ErrorBanner error={new Error(error)} onRetry={reload} />
          </div>
        ) : loading && !data ? (
          <Loading label="Loading projects" />
        ) : data && data.items.length === 0 ? (
          <Empty
            icon={<Blocks size={19} />}
            title={q || runtime || compatibility ? "No matching projects" : "No projects yet"}
            description={
              q || runtime || compatibility
                ? "Adjust the filters, or create a new project from a GitHub repository."
                : "Connect a GitHub repository and KI00 will detect its framework, check Workers compatibility and prepare a real build."
            }
            action={
              <Link to="/projects/new" className="btn primary sm">
                Create project
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
                    <th>Repository</th>
                    <th>Runtime</th>
                    <th>Compatibility</th>
                    <th>Last build</th>
                    <th>Last deployed</th>
                    <th className="right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.items.map((project) => (
                    <tr key={project.id}>
                      <td>
                        <Link to={`/projects/${project.id}`} style={{ fontWeight: 550 }}>
                          {project.name}
                        </Link>
                        <div className="tiny dim">{project.branch}</div>
                      </td>
                      <td>
                        <div className="small">
                          {project.repoOwner}/{project.repoName}
                        </div>
                        <div className="tiny dim">{project.framework}</div>
                      </td>
                      <td>
                        <span className="small">{project.runtimeKind === "static" ? "Static assets" : "Worker"}</span>
                        <div className="tiny dim">{project.projectType}</div>
                      </td>
                      <td>
                        <StatusPill status={project.compatibilityStatus} />
                      </td>
                      <td>
                        {project.lastBuildStatus ? (
                          <StatusPill status={project.lastBuildStatus} />
                        ) : (
                          <span className="small dim">Never built</span>
                        )}
                      </td>
                      <td className="small muted">{timeAgo(project.lastDeployedAt)}</td>
                      <td className="right">
                        <Link to={`/projects/${project.id}`} className="btn sm">
                          Open
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
                  <button
                    type="button"
                    className="btn sm"
                    disabled={data.page <= 1}
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                  >
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
