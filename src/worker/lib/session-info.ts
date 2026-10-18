import type { Context } from "hono";
import type { AppEnv } from "../env";
import type { SessionInfo } from "../../shared/types";
import { listWorkspaces } from "./auth";
import { getCapabilities } from "./providers";

export async function buildSessionInfo(c: Context<AppEnv>): Promise<SessionInfo> {
  const capabilities = await getCapabilities(c.env);
  const user = c.get("user");
  const session = c.get("session");
  if (!user) {
    return {
      authenticated: false,
      user: null,
      workspace: null,
      workspaces: [],
      csrfToken: null,
      capabilities,
    };
  }
  const workspaces = await listWorkspaces(c, user.id);
  return {
    authenticated: true,
    user,
    workspace: c.get("workspace") ?? workspaces[0] ?? null,
    workspaces,
    csrfToken: session?.csrf_token ?? null,
    capabilities,
  };
}
