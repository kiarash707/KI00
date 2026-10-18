import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SessionInfo, Workspace } from "@shared/types";
import { api, post, setCsrfToken, setWorkspaceId, errorMessage } from "./api";

const WORKSPACE_STORAGE_KEY = "ki00.selectedWorkspace";

interface SessionApi {
  session: SessionInfo | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<SessionInfo | null>;
  signIn: (email: string, password: string) => Promise<void>;
  signInDemo: () => Promise<void>;
  signOut: () => Promise<void>;
  switchWorkspace: (workspace: Workspace) => Promise<void>;
  setSession: (session: SessionInfo) => void;
}

const SessionContext = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const initialized = useRef(false);

  const applySession = useCallback((next: SessionInfo) => {
    setSessionState(next);
    setCsrfToken(next.csrfToken);
    if (next.workspace) {
      setWorkspaceId(next.workspace.id);
      try {
        window.localStorage.setItem(WORKSPACE_STORAGE_KEY, next.workspace.id);
      } catch {
        /* storage may be blocked */
      }
    }
  }, []);

  const refresh = useCallback(async (): Promise<SessionInfo | null> => {
    try {
      const next = await api<SessionInfo>("/auth/session");
      applySession(next);
      setError(null);
      return next;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }, [applySession]);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    try {
      const stored = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
      if (stored) setWorkspaceId(stored);
    } catch {
      /* ignore */
    }
    void refresh().finally(() => setLoading(false));
  }, [refresh]);

  const signIn = useCallback(
    async (email: string, password: string) => {
      await post("/auth/login", { email, password });
      const next = await refresh();
      if (!next?.authenticated) {
        throw new Error("Signed in, but the session could not be loaded. Reload the page.");
      }
    },
    [refresh]
  );

  const signInDemo = useCallback(async () => {
    await post("/auth/demo", {});
    const next = await refresh();
    if (!next?.authenticated) {
      throw new Error("The demo session could not be loaded. Reload the page.");
    }
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await post("/auth/logout", {});
    } finally {
      setCsrfToken(null);
      setSessionState(null);
      try {
        window.localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      } catch {
        /* ignore */
      }
      setWorkspaceId(null);
    }
  }, []);

  const switchWorkspace = useCallback(
    async (workspace: Workspace) => {
      setWorkspaceId(workspace.id);
      try {
        window.localStorage.setItem(WORKSPACE_STORAGE_KEY, workspace.id);
      } catch {
        /* ignore */
      }
      const next = await refresh();
      if (!next?.authenticated) {
        throw new Error("Could not switch workspace. Sign in again.");
      }
    },
    [refresh]
  );

  const setSession = useCallback((next: SessionInfo) => applySession(next), [applySession]);

  const value = useMemo(
    () => ({
      session,
      loading,
      error,
      refresh,
      signIn,
      signInDemo,
      signOut,
      switchWorkspace,
      setSession,
    }),
    [session, loading, error, refresh, signIn, signInDemo, signOut, switchWorkspace, setSession]
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const context = useContext(SessionContext);
  if (!context) throw new Error("useSession must be used inside SessionProvider");
  return context;
}
