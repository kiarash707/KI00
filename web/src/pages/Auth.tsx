import { ArrowRight, Cloud, GitBranch, ShieldCheck, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useSession } from "../lib/session";
import { errorMessage, post } from "../lib/api";
import { ErrorBanner, InfoBanner, Spinner } from "../components/ui";

export default function Auth() {
  const { session, loading, signIn, signInDemo, refresh } = useSession();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "setup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demoBusy, setDemoBusy] = useState(false);

  const setupComplete = session?.capabilities.setupComplete ?? false;

  useEffect(() => {
    if (!setupComplete) setMode("setup");
    else setMode("login");
  }, [setupComplete]);

  if (!loading && session?.authenticated) {
    return <Navigate to="/" replace />;
  }

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") {
        await signIn(email, password);
      } else {
        await post("/auth/setup", {
          setupToken,
          name,
          email,
          password,
          workspaceName: workspaceName || undefined,
        });
        await refresh();
        await signIn(email, password);
      }
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onDemo = async () => {
    setDemoBusy(true);
    setError(null);
    try {
      await signInDemo();
      navigate("/", { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDemoBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <aside className="auth-aside">
        <div className="brand">
          <span className="brand-mark">K</span>
          <span>
            KI00
            <span className="brand-sub" style={{ display: "block" }}>
              Cloudflare deployment platform
            </span>
          </span>
        </div>
        <div className="stack" style={{ gap: 26, maxWidth: 460 }}>
          <h1 style={{ fontSize: 32, lineHeight: 1.15 }}>
            Ship GitHub projects to Cloudflare — with real builds, logs and URLs.
          </h1>
          <p className="muted">
            KI00 connects your repository to Cloudflare Workers Builds, verifies runtime compatibility,
            streams the real build log, and publishes to a live Workers URL.
          </p>
          <div className="stack" style={{ gap: 18 }}>
            <div className="feature">
              <span className="feature-icon">
                <Cloud size={17} />
              </span>
              <div>
                <h3>Cloudflare-native</h3>
                <p className="small muted">Workers, Workers Builds, D1 and Custom Domains — no containers on the free plan.</p>
              </div>
            </div>
            <div className="feature">
              <span className="feature-icon">
                <GitBranch size={17} />
              </span>
              <div>
                <h3>Honest compatibility</h3>
                <p className="small muted">Detection inspects your repo and refuses to promise a deploy that cannot work.</p>
              </div>
            </div>
            <div className="feature">
              <span className="feature-icon">
                <Sparkles size={17} />
              </span>
              <div>
                <h3>Free-model AI agent</h3>
                <p className="small muted">Real tool calls over your repo, build logs and deployment state. Approval required for writes.</p>
              </div>
            </div>
          </div>
        </div>
        <div className="row small dim">
          <ShieldCheck size={14} />
          Tokens stay in Worker secrets. Secrets are encrypted in D1 and never sent to the browser.
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <div>
            <h1>{mode === "setup" ? "Set up KI00" : "Sign in"}</h1>
            <p className="muted small" style={{ marginTop: 6 }}>
              {mode === "setup"
                ? "Create the first owner account for this KI00 deployment."
                : "Use the account created during setup."}
            </p>
          </div>

          {error ? <ErrorBanner error={new Error(error)} /> : null}

          {mode === "setup" && !setupComplete ? (
            <InfoBanner kind="info">
              <strong>Setup token required.</strong>
              <span className="small">
                Add <code>KI00_SETUP_TOKEN</code> and <code>KI00_ENCRYPTION_KEY</code> as Worker secrets before
                creating the owner account.
              </span>
            </InfoBanner>
          ) : null}

          <form className="stack" onSubmit={onSubmit}>
            {mode === "setup" ? (
              <>
                <div className="field">
                  <label htmlFor="setup-token">Setup token</label>
                  <input
                    id="setup-token"
                    className="input mono"
                    type="password"
                    autoComplete="off"
                    value={setupToken}
                    onChange={(event) => setSetupToken(event.target.value)}
                    required
                  />
                </div>
                <div className="field">
                  <label htmlFor="name">Your name</label>
                  <input
                    id="name"
                    className="input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    required
                    minLength={1}
                    maxLength={80}
                  />
                </div>
                <div className="field">
                  <label htmlFor="workspace-name">Workspace name</label>
                  <input
                    id="workspace-name"
                    className="input"
                    value={workspaceName}
                    onChange={(event) => setWorkspaceName(event.target.value)}
                    placeholder="KI00 Workspace"
                    maxLength={60}
                  />
                </div>
              </>
            ) : null}

            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                className="input"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                className="input"
                type="password"
                autoComplete={mode === "setup" ? "new-password" : "current-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={mode === "setup" ? 10 : 1}
              />
              {mode === "setup" ? <span className="hint">At least 10 characters. Stored as a PBKDF2 hash.</span> : null}
            </div>

            <button type="submit" className="btn primary" disabled={busy} style={{ height: 38 }}>
              {busy ? <Spinner /> : <ArrowRight size={15} />}
              {mode === "setup" ? "Create workspace" : "Sign in"}
            </button>
          </form>

          {session?.capabilities.demo ? (
            <button type="button" className="btn" onClick={() => void onDemo()} disabled={demoBusy}>
              {demoBusy ? <Spinner /> : <Sparkles size={15} />}
              Explore the demo workspace
            </button>
          ) : null}

          {setupComplete ? (
            <p className="small dim">
              First-time setup is complete. The setup token endpoint is disabled once an account exists.
            </p>
          ) : (
            <p className="small dim">
              See <code>docs/CLOUDFLARE_SETUP.md</code> for the required secrets and D1 migration steps.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
