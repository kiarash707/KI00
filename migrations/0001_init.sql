-- KI00 initial schema (Cloudflare D1 / SQLite)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip_hash TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  cloudflare_account_id TEXT,
  cloudflare_account_name TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  repo_id TEXT,
  repo_private INTEGER NOT NULL DEFAULT 0,
  default_branch TEXT NOT NULL DEFAULT 'main',
  branch TEXT NOT NULL DEFAULT 'main',
  project_type TEXT NOT NULL DEFAULT 'static',
  framework TEXT,
  language TEXT,
  runtime_kind TEXT NOT NULL DEFAULT 'unknown',
  runtime_detail TEXT,
  compatibility_status TEXT NOT NULL DEFAULT 'unknown',
  compatibility_notes TEXT,
  build_command TEXT NOT NULL DEFAULT '',
  install_command TEXT NOT NULL DEFAULT 'npm ci',
  output_dir TEXT NOT NULL DEFAULT 'dist',
  root_dir TEXT NOT NULL DEFAULT '/',
  deploy_command TEXT NOT NULL DEFAULT '',
  worker_name TEXT NOT NULL,
  worker_tag TEXT,
  workers_dev_url TEXT,
  custom_url TEXT,
  spa_fallback INTEGER NOT NULL DEFAULT 0,
  auto_deploy INTEGER NOT NULL DEFAULT 1,
  build_caching INTEGER NOT NULL DEFAULT 1,
  has_wrangler_config INTEGER NOT NULL DEFAULT 0,
  wrangler_has_routes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  detected_env_keys TEXT,
  detection_json TEXT,
  build_token_uuid TEXT,
  repo_connection_uuid TEXT,
  production_trigger_uuid TEXT,
  preview_trigger_uuid TEXT,
  last_deployment_id TEXT,
  last_build_status TEXT,
  last_build_finished_at INTEGER,
  last_deployed_at INTEGER,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_repo ON projects(repo_owner, repo_name);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'cloudflare_workers_builds',
  trigger_kind TEXT NOT NULL DEFAULT 'production',
  build_uuid TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  outcome TEXT,
  branch TEXT NOT NULL DEFAULT 'main',
  commit_sha TEXT,
  commit_message TEXT,
  author TEXT,
  url TEXT,
  preview_url TEXT,
  error_summary TEXT,
  logs_cursor TEXT,
  logs_cached_at INTEGER,
  logs_bytes INTEGER NOT NULL DEFAULT 0,
  rollback_of TEXT,
  requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  duration_ms INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_workspace ON deployments(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_build ON deployments(build_uuid);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(workspace_id, status);

CREATE TABLE IF NOT EXISTS deployment_logs (
  deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  chunk INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (deployment_id, chunk)
);

CREATE TABLE IF NOT EXISTS env_vars (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_enc TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'production',
  use_build INTEGER NOT NULL DEFAULT 1,
  use_runtime INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, key, scope)
);
CREATE INDEX IF NOT EXISTS idx_env_project ON env_vars(project_id, scope);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hostname TEXT NOT NULL,
  zone_id TEXT,
  zone_name TEXT,
  cloudflare_domain_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  dns_instructions TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  verified_at INTEGER,
  UNIQUE (project_id, hostname)
);
CREATE INDEX IF NOT EXISTS idx_domains_project ON domains(project_id);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  meta_json TEXT,
  actor TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_workspace ON activities(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activities_project ON activities(project_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  ip_hash TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_workspace ON audit_log(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'New conversation',
  model TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_threads_workspace ON agent_threads(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_name TEXT,
  tool_call_id TEXT,
  tool_args_json TEXT,
  tool_result_json TEXT,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_thread ON agent_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'running',
  model TEXT,
  calls INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_thread ON agent_runs(thread_id, started_at DESC);

CREATE TABLE IF NOT EXISTS model_cache (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS github_cache (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id TEXT,
  project_id TEXT,
  action TEXT NOT NULL,
  args_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_approvals_thread ON approvals(thread_id, created_at DESC);
