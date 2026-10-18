import {
  Activity,
  Bell,
  Blocks,
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Command,
  FolderGit2,
  Gauge,
  LogOut,
  Menu,
  Plus,
  Rocket,
  Search,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router-dom";
import type { Activity as ActivityItem, Deployment, Project } from "@shared/types";
import { useSession } from "../lib/session";
import { api, errorMessage, post } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useToast, StatusPill } from "./ui";

interface ProjectListResponse {
  items: Project[];
  total: number;
}

const NAV = [
  { to: "/", label: "Overview", icon: Gauge, end: true },
  { to: "/projects", label: "Projects", icon: FolderGit2 },
  { to: "/deployments", label: "Deployments", icon: Rocket },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/agent", label: "AI agent", icon: Sparkles },
  { to: "/settings", label: "Settings", icon: Settings },
];

const PAGE_RESULTS = [
  { label: "Overview", path: "/", description: "Workspace health and recent deployments" },
  { label: "Projects", path: "/projects", description: "All projects in this workspace" },
  { label: "Create project", path: "/projects/new", description: "Connect a GitHub repository and deploy" },
  { label: "Deployments", path: "/deployments", description: "Build and deploy history" },
  { label: "Activity", path: "/activity", description: "Workspace activity stream" },
  { label: "AI agent", path: "/agent", description: "Inspect repos, logs and build failures" },
  { label: "Settings", path: "/settings", description: "Connections, sessions and limits" },
];

export default function Layout() {
  const { session, signOut, switchWorkspace } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const params = useParams();
  const { notify } = useToast();

  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem("ki00.sidebar") === "collapsed";
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [userOpen, setUserOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [notifications, setNotifications] = useState<{ activities: ActivityItem[]; deployments: Deployment[] }>({
    activities: [],
    deployments: [],
  });
  const [seenAt, setSeenAt] = useState(0);
  const [notificationError, setNotificationError] = useState<string | null>(null);

  useEffect(() => {
    setMobileOpen(false);
    setWorkspaceOpen(false);
    setProjectsOpen(false);
    setNotificationsOpen(false);
    setUserOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    let cancelled = false;
    api<ProjectListResponse>("/projects?perPage=100&sort=updated")
      .then((data) => {
        if (!cancelled) setProjects(data.items);
      })
      .catch(() => {
        /* the selector degrades to a disabled state */
      });
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  useEffect(() => {
    try {
      setSeenAt(Number(window.localStorage.getItem("ki00.notificationsSeenAt") ?? 0));
    } catch {
      setSeenAt(0);
    }
  }, []);

  const loadNotifications = useCallback(async () => {
    try {
      const [activities, deployments] = await Promise.all([
        api<{ items: ActivityItem[] }>("/activity?level=error&perPage=5"),
        api<{ items: Deployment[] }>("/deployments?status=failed&perPage=5"),
      ]);
      setNotifications({ activities: activities.items, deployments: deployments.items });
      setNotificationError(null);
    } catch (error) {
      setNotificationError(errorMessage(error));
    }
  }, []);

  const unread = useMemo(() => {
    const newestActivity = notifications.activities[0]?.createdAt ?? 0;
    const newestDeployment = notifications.deployments[0]?.createdAt ?? 0;
    return Math.max(newestActivity, newestDeployment) > seenAt;
  }, [notifications, seenAt]);

  const openNotifications = () => {
    setNotificationsOpen((open) => !open);
    if (!notificationsOpen) {
      void loadNotifications();
      const ts = Date.now();
      setSeenAt(ts);
      try {
        window.localStorage.setItem("ki00.notificationsSeenAt", String(ts));
      } catch {
        /* ignore */
      }
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem("ki00.sidebar", next ? "collapsed" : "expanded");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const activeProject = params.id ? projects.find((project) => project.id === params.id) : null;

  return (
    <div className="shell">
      {mobileOpen ? (
        <div
          className="overlay"
          style={{ background: "rgba(0,0,0,0.5)", zIndex: 39, display: "block" }}
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      ) : null}
      <aside className={`sidebar ${collapsed ? "collapsed" : ""} ${mobileOpen ? "open" : ""}`}>
        <div className="sidebar-head">
          <Link to="/" className="brand" aria-label="KI00 home">
            <span className="brand-mark">K</span>
            {!collapsed ? (
              <span className="brand-text">
                KI00
                <span className="brand-sub" style={{ display: "block" }}>
                  Cloudflare deploys
                </span>
              </span>
            ) : null}
          </Link>
          <span className="spacer" />
          <button
            type="button"
            className="icon-btn hide-sm"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <ChevronsRight size={16} /> : <ChevronsLeft size={16} />}
          </button>
          <button type="button" className="icon-btn hide-sm" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
            <X size={16} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Primary">
          <div className="nav-group-label">Workspace</div>
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
              title={collapsed ? item.label : undefined}
            >
              <item.icon size={17} />
              <span className="nav-label">{item.label}</span>
            </NavLink>
          ))}
          <div className="nav-group-label">Projects</div>
          {projects.slice(0, 6).map((project) => (
            <NavLink
              key={project.id}
              to={`/projects/${project.id}`}
              className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}
              title={project.name}
            >
              <Blocks size={16} />
              <span className="nav-label truncate">{project.name}</span>
            </NavLink>
          ))}
          {projects.length === 0 ? (
            <span className="nav-label dim" style={{ paddingLeft: 12 }}>
              No projects yet
            </span>
          ) : null}
        </nav>

        <div className="sidebar-foot">
          <Link to="/projects/new" className="btn primary" style={{ width: "100%" }}>
            <Plus size={15} />
            <span className="sidebar-foot-text">New project</span>
          </Link>
          <button type="button" className="btn ghost" onClick={() => void signOut()} style={{ width: "100%" }}>
            <LogOut size={15} />
            <span className="sidebar-foot-text">Sign out</span>
          </button>
        </div>
      </aside>

      <div className={`main ${collapsed ? "collapsed" : ""}`}>
        <header className="topbar">
          <button type="button" className="icon-btn" onClick={() => setMobileOpen(true)} aria-label="Open navigation">
            <Menu size={18} />
          </button>

          <div className="popover-wrap hide-sm">
            <button type="button" className="btn ghost" onClick={() => setWorkspaceOpen((open) => !open)}>
              <span className="avatar" style={{ width: 22, height: 22, fontSize: 10 }}>
                {(session?.workspace?.name ?? "K").slice(0, 1).toUpperCase()}
              </span>
              <span className="truncate" style={{ maxWidth: 160 }}>
                {session?.workspace?.name ?? "Workspace"}
              </span>
              <ChevronDown size={14} />
            </button>
            {workspaceOpen ? (
              <div className="popover">
                <div className="menu">
                  <div className="menu-label">Workspaces</div>
                  {(session?.workspaces ?? []).map((workspace) => (
                    <button
                      key={workspace.id}
                      type="button"
                      className={`menu-item ${workspace.id === session?.workspace?.id ? "active" : ""}`}
                      onClick={() => {
                        setWorkspaceOpen(false);
                        if (workspace.id === session?.workspace?.id) return;
                        void switchWorkspace(workspace)
                          .then(() => {
                            notify(`Switched to ${workspace.name}`, "success");
                            navigate("/");
                          })
                          .catch((error) => notify(errorMessage(error), "error"));
                      }}
                    >
                      <Blocks size={14} />
                      {workspace.name}
                      <span className="meta">{workspace.role}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="popover-wrap">
            <button type="button" className="btn ghost" onClick={() => setProjectsOpen((open) => !open)}>
              <FolderGit2 size={15} />
              <span className="truncate hide-sm" style={{ maxWidth: 180 }}>
                {activeProject?.name ?? "Select project"}
              </span>
              <ChevronDown size={14} />
            </button>
            {projectsOpen ? (
              <div className="popover">
                <div className="menu">
                  <div className="menu-label">Projects</div>
                  {projects.map((project) => (
                    <button
                      key={project.id}
                      type="button"
                      className={`menu-item ${project.id === activeProject?.id ? "active" : ""}`}
                      onClick={() => {
                        setProjectsOpen(false);
                        navigate(`/projects/${project.id}`);
                      }}
                    >
                      <Blocks size={14} />
                      <span className="truncate">{project.name}</span>
                      <span className="meta">{project.runtimeKind}</span>
                    </button>
                  ))}
                  {projects.length === 0 ? <div className="menu-label">No projects in this workspace</div> : null}
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      setProjectsOpen(false);
                      navigate("/projects/new");
                    }}
                  >
                    <Plus size={14} /> New project
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          <div className="spacer" />

          <button type="button" className="btn ghost hide-sm" onClick={() => setPaletteOpen(true)} aria-label="Open command palette">
            <Search size={15} />
            <span className="dim">Search</span>
            <kbd>⌘K</kbd>
          </button>

          <div className="popover-wrap">
            <button type="button" className="icon-btn" onClick={openNotifications} aria-label="Notifications">
              <Bell size={17} />
              {unread ? (
                <span
                  style={{
                    position: "absolute",
                    marginLeft: 14,
                    marginTop: -10,
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: "var(--red)",
                  }}
                />
              ) : null}
            </button>
            {notificationsOpen ? (
              <div className="popover" style={{ minWidth: 330 }}>
                <div className="menu">
                  <div className="menu-label">Recent problems</div>
                  {notificationError ? <div className="menu-item">{notificationError}</div> : null}
                  {notifications.deployments.map((deployment) => (
                    <button
                      key={deployment.id}
                      type="button"
                      className="menu-item"
                      onClick={() => navigate(`/deployments/${deployment.id}`)}
                    >
                      <StatusPill status={deployment.status} />
                      <span className="truncate">{deployment.projectName ?? "Deployment"}</span>
                      <span className="meta">{timeAgo(deployment.createdAt)}</span>
                    </button>
                  ))}
                  {notifications.activities.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className="menu-item"
                      onClick={() => navigate(item.projectId ? `/projects/${item.projectId}` : "/activity")}
                    >
                      <span className="pill failed">Error</span>
                      <span className="truncate">{item.message}</span>
                    </button>
                  ))}
                  {!notificationError &&
                  notifications.activities.length === 0 &&
                  notifications.deployments.length === 0 ? (
                    <div className="menu-item muted">No failures or errors recorded.</div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>

          <div className="popover-wrap">
            <button type="button" className="avatar" onClick={() => setUserOpen((open) => !open)} aria-label="Account menu">
              {(session?.user?.name ?? "K").slice(0, 1).toUpperCase()}
            </button>
            {userOpen ? (
              <div className="popover">
                <div className="menu">
                  <div className="menu-label">{session?.user?.email ?? "Signed in"}</div>
                  <button type="button" className="menu-item" onClick={() => navigate("/settings")}>
                    <Settings size={14} /> Settings
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={async () => {
                      setUserOpen(false);
                      try {
                        await post("/auth/logout", {});
                      } catch {
                        /* cookie is cleared client-side either way */
                      }
                      await signOut();
                    }}
                  >
                    <LogOut size={14} /> Sign out
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </header>

        <main id="main">
          <Outlet context={{ projects, refreshProjects: () => undefined }} />
        </main>
      </div>

      {paletteOpen ? (
        <CommandPalette
          projects={projects}
          onClose={() => setPaletteOpen(false)}
          onNavigate={(path) => {
            setPaletteOpen(false);
            navigate(path);
          }}
        />
      ) : null}
    </div>
  );
}

function CommandPalette({
  projects,
  onClose,
  onNavigate,
}: {
  projects: Project[];
  onClose: () => void;
  onNavigate: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [remote, setRemote] = useState<{ projects: Project[]; deployments: Deployment[] }>({
    projects: [],
    deployments: [],
  });
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) {
      setRemote({ projects: [], deployments: [] });
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api<{ projects: Project[]; deployments: Deployment[] }>(`/search?q=${encodeURIComponent(term)}`)
        .then((data) => {
          if (!cancelled) setRemote({ projects: data.projects, deployments: data.deployments });
        })
        .catch(() => {
          if (!cancelled) setRemote({ projects: [], deployments: [] });
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const items = useMemo(() => {
    const term = query.trim().toLowerCase();
    const pages = PAGE_RESULTS.filter(
      (page) => !term || page.label.toLowerCase().includes(term) || page.description.toLowerCase().includes(term)
    );
    const projectItems = (term ? remote.projects : projects)
      .slice(0, 6)
      .map((project) => ({
        key: `project-${project.id}`,
        label: project.name,
        description: `${project.repoOwner}/${project.repoName} · ${project.runtimeKind}`,
        path: `/projects/${project.id}`,
        section: "Projects",
      }));
    const deploymentItems = remote.deployments.slice(0, 5).map((deployment) => ({
      key: `deployment-${deployment.id}`,
      label: `${deployment.projectName ?? "Deployment"} · ${deployment.status}`,
      description: `${deployment.branch} · ${deployment.commitSha?.slice(0, 7) ?? "no commit"}`,
      path: `/deployments/${deployment.id}`,
      section: "Deployments",
    }));
    const pageItems = pages.map((page) => ({
      key: `page-${page.path}`,
      label: page.label,
      description: page.description,
      path: page.path,
      section: "Pages",
    }));
    return [...pageItems, ...projectItems, ...deploymentItems];
  }, [query, projects, remote]);

  useEffect(() => setSelected(0), [query]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((index) => Math.min(items.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((index) => Math.max(0, index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[selected];
      if (item) onNavigate(item.path);
    } else if (event.key === "Escape") {
      onClose();
    }
  };

  const grouped = items.reduce<Record<string, typeof items>>((accumulator, item) => {
    (accumulator[item.section] ??= []).push(item);
    return accumulator;
  }, {});

  let flatIndex = -1;

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search KI00">
        <div className="palette-input">
          <Search size={16} className="dim" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search projects, deployments, pages…"
            aria-label="Search"
          />
          {searching ? <span className="spinner" /> : <Command size={14} className="dim" />}
        </div>
        <div className="palette-results">
          {Object.entries(grouped).map(([section, sectionItems]) => (
            <div key={section}>
              <div className="palette-section">{section}</div>
              {sectionItems.map((item) => {
                flatIndex += 1;
                const index = flatIndex;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`palette-item ${index === selected ? "selected" : ""}`}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => onNavigate(item.path)}
                  >
                    <span className="truncate">{item.label}</span>
                    <span className="hint truncate">{item.description}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {items.length === 0 ? <div className="palette-section">No matches</div> : null}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
