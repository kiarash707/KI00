import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Info,
  Loader2,
  X,
  XCircle,
} from "lucide-react";
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

/* ── Toasts ──────────────────────────────────────────────────────────── */

type ToastKind = "info" | "success" | "error" | "warn";
interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}
interface ToastApi {
  notify: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const notify = useCallback((message: string, kind: ToastKind = "info") => {
    counter.current += 1;
    const id = counter.current;
    setItems((current) => [...current.slice(-3), { id, kind, message }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 6000);
  }, []);

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.kind}`}>
            {item.kind === "success" ? (
              <CheckCircle2 size={16} color="var(--green)" />
            ) : item.kind === "error" ? (
              <XCircle size={16} color="var(--red)" />
            ) : item.kind === "warn" ? (
              <AlertTriangle size={16} color="var(--amber)" />
            ) : (
              <Info size={16} color="var(--blue-bright)" />
            )}
            <span>{item.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used inside ToastProvider");
  return context;
}

/* ── Status ──────────────────────────────────────────────────────────── */

const STATUS_LABELS: Record<string, string> = {
  success: "Success",
  failed: "Failed",
  running: "Building",
  initializing: "Initializing",
  queued: "Queued",
  cancelled: "Cancelled",
  skipped: "Skipped",
  unknown: "Unknown",
  active: "Active",
  error: "Error",
  deploying: "Deploying",
  archived: "Archived",
  pending: "Pending",
  instructions: "Action needed",
  compatible: "Compatible",
  needs_adapter: "Adapter required",
  incompatible: "Incompatible",
  configured: "Configured",
  missing: "Missing",
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const normalized = (status || "unknown").toLowerCase();
  const cls = [
    "success",
    "failed",
    "error",
    "running",
    "deploying",
    "queued",
    "pending",
    "initializing",
    "cancelled",
    "skipped",
    "unknown",
    "active",
    "archived",
    "instructions",
    "compatible",
    "needs_adapter",
    "incompatible",
  ].includes(normalized)
    ? normalized
    : "neutral";
  const live = normalized === "running" || normalized === "deploying";
  return (
    <span className={`pill ${cls}`}>
      <span className="dot" />
      {label ?? STATUS_LABELS[normalized] ?? status}
      {live ? "" : ""}
    </span>
  );
}

export function StatusDot({ ok, label }: { ok: boolean | null; label: string }) {
  return (
    <span className="row" style={{ gap: 6, fontSize: 12.5 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: ok === null ? "var(--text-dim)" : ok ? "var(--green)" : "var(--red)",
        }}
      />
      <span className="muted">{label}</span>
    </span>
  );
}

/* ── Feedback ────────────────────────────────────────────────────────── */

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Loader2 size={17} className="spin" style={{ animation: "spin 0.9s linear infinite" }} />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div className="banner error" role="alert">
      <AlertTriangle size={16} />
      <div className="stack" style={{ gap: 6 }}>
        <span>{message}</span>
        {onRetry ? (
          <button type="button" className="btn sm" onClick={onRetry} style={{ alignSelf: "flex-start" }}>
            Try again
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="icon-wrap">{icon}</div>
      <h3>{title}</h3>
      <p className="small muted" style={{ maxWidth: 440 }}>
        {description}
      </p>
      {action ? <div style={{ marginTop: 6 }}>{action}</div> : null}
    </div>
  );
}

export function InfoBanner({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "warn" }) {
  return (
    <div className={`banner ${kind}`}>
      {kind === "warn" ? <AlertTriangle size={16} /> : <Info size={16} />}
      <div className="stack" style={{ gap: 4 }}>
        {children}
      </div>
    </div>
  );
}

/* ── Modal ───────────────────────────────────────────────────────────── */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const focusable = ref.current?.querySelector<HTMLElement>(
      "input, textarea, select, button, [tabindex]:not([tabindex='-1'])"
    );
    focusable?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="overlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ── Misc ────────────────────────────────────────────────────────────── */

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const { notify } = useToast();
  return (
    <button
      type="button"
      className="btn sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          notify("Clipboard access was denied by the browser", "error");
        }
      }}
      aria-label={label}
    >
      {copied ? <Check size={13} /> : <Copy size={13} />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}

export function Tabs({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: string; label: string; count?: number }[];
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          className={`tab ${value === tab.id ? "active" : ""}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="dim" style={{ marginLeft: 6 }}>{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
