import type { User, Workspace } from "../shared/types";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // Provider credentials — Worker secrets only. Never persisted in D1 or sent to the browser.
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  GITHUB_TOKEN?: string;
  OPENROUTER_API_KEY?: string;

  // KI00 core secrets.
  KI00_ENCRYPTION_KEY?: string;
  KI00_SETUP_TOKEN?: string;
  KI00_AGENT_MODEL?: string;
  KI00_BUILD_TOKEN_UUID?: string;
  // Optional dedicated build token (Workers Scripts:Edit only) so KI00 never
  // reuses its own broader API token for Workers Builds.
  KI00_BUILD_TOKEN_SECRET?: string;
  KI00_BUILD_TOKEN_ID?: string;

  // Public configuration.
  KI00_ENV?: string;
  KI00_DEMO?: string;
  KI00_APP_NAME?: string;
  KI00_WRANGLER_VERSION?: string;
  KI00_DEFAULT_ACCOUNT_ID?: string;
  KI00_DEFAULT_GITHUB_OWNER?: string;
}

export interface SessionRow {
  token_hash: string;
  user_id: string;
  csrf_token: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip_hash: string | null;
  user_agent: string | null;
}

export interface AppVariables {
  requestId: string;
  user: User | null;
  workspace: Workspace | null;
  session: SessionRow | null;
  csrfToken: string | null;
  ipHash: string | null;
  actorEmail: string | null;
}

export type AppEnv = { Bindings: Env; Variables: AppVariables };

export const APP_VERSION = "0.1.0";
