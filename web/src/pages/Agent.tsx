import {
  ArrowUp,
  Check,
  MessageSquarePlus,
  Sparkles,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentEvent,
  AgentMessage,
  AgentThread,
  Approval,
  ModelCatalog,
  Project,
} from "@shared/types";
import { api, del, errorMessage, post, streamAgent } from "../lib/api";
import { timeAgo } from "../lib/format";
import { useSession } from "../lib/session";
import { Empty, ErrorBanner, InfoBanner, Loading, Spinner, StatusPill, useToast } from "../components/ui";

interface LiveTool {
  name: string;
  summary?: string;
  ok?: boolean;
}

interface StreamedMessage {
  content: string;
}

export default function Agent() {
  const { session } = useSession();
  const { notify } = useToast();
  const demo = session?.capabilities.demo ?? false;

  const [threads, setThreads] = useState<AgentThread[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamed, setStreamed] = useState<StreamedMessage[]>([]);
  const [tools, setTools] = useState<LiveTool[]>([]);
  const [usage, setUsage] = useState<{ calls: number; promptTokens: number; completionTokens: number; maxCalls: number } | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    try {
      const data = await api<{ items: AgentThread[] }>("/agent/threads");
      setThreads(data.items);
      setThreadError(null);
    } catch (error) {
      setThreadError(errorMessage(error));
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const data = await api<ModelCatalog>("/models");
      setCatalog(data);
      if (data.selectedModel) setModel((current) => current || data.selectedModel || "");
    } catch (error) {
      setCatalog({
        models: [],
        selectedModel: null,
        selectedModelName: null,
        selectionReason: null,
        fetchedAt: null,
        stale: true,
        error: errorMessage(error),
        overridden: false,
      });
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  const loadProjects = useCallback(async () => {
    try {
      const data = await api<{ items: Project[] }>("/projects?perPage=100");
      setProjects(data.items);
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void loadThreads();
    void loadCatalog();
    void loadProjects();
  }, [loadThreads, loadCatalog, loadProjects]);

  const openThread = useCallback(async (threadId: string) => {
    setThreadLoading(true);
    setRunError(null);
    try {
      const data = await api<{
        thread: AgentThread;
        messages: AgentMessage[];
        approvals: Approval[];
      }>(`/agent/threads/${threadId}`);
      setActiveThread(threadId);
      setMessages(data.messages);
      setApprovals(data.approvals);
      setStreamed([]);
      setTools([]);
      if (data.thread.projectId) setProjectId(data.thread.projectId);
      if (data.thread.model) setModel(data.thread.model);
    } catch (error) {
      setRunError(errorMessage(error));
    } finally {
      setThreadLoading(false);
    }
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streamed, tools]);

  const startNew = () => {
    setActiveThread(null);
    setMessages([]);
    setApprovals([]);
    setStreamed([]);
    setTools([]);
    setUsage(null);
    setRunError(null);
    setInput("");
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming) return;
    if (!catalog?.models.length) {
      notify("No free tool-capable model is available right now", "error");
      return;
    }
    setInput("");
    setRunError(null);
    setStreamed([]);
    setTools([]);
    setUsage(null);
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    let threadId = activeThread;

    await streamAgent(
      {
        threadId: threadId ?? undefined,
        projectId: projectId || undefined,
        message: text,
        model: model || undefined,
      },
      {
        signal: controller.signal,
        onEvent: (event) => {
          const payload = event as AgentEvent;
          switch (payload.type) {
            case "run_start":
              threadId = payload.threadId;
              setActiveThread(payload.threadId);
              setModel(payload.model);
              break;
            case "model_call":
              break;
            case "message":
              setStreamed((current) => [...current, { content: payload.content }]);
              break;
            case "tool_start":
              setTools((current) => [...current, { name: payload.name }]);
              break;
            case "tool_result":
              setTools((current) => {
                const next = [...current];
                for (let index = next.length - 1; index >= 0; index -= 1) {
                  if (next[index]!.name === payload.name && next[index]!.summary === undefined) {
                    next[index] = { ...next[index]!, summary: payload.summary, ok: payload.ok };
                    return next;
                  }
                }
                return [...next, { name: payload.name, summary: payload.summary, ok: payload.ok }];
              });
              break;
            case "approval":
              setApprovals((current) => [
                {
                  id: payload.approvalId,
                  action: payload.action,
                  args: payload.args,
                  status: "pending",
                  projectId: projectId || null,
                  threadId: threadId ?? null,
                  createdAt: Date.now(),
                  resolvedAt: null,
                },
                ...current,
              ]);
              break;
            case "model_switch":
              notify(`Free model fallback: ${payload.from} → ${payload.to}`, "warn");
              setModel(payload.to);
              break;
            case "usage":
              setUsage({
                calls: payload.calls,
                promptTokens: payload.promptTokens,
                completionTokens: payload.completionTokens,
                maxCalls: payload.maxCalls,
              });
              break;
            case "limit":
              notify(payload.message, "warn");
              break;
            case "error":
              setRunError(payload.message);
              break;
            case "done":
              break;
            default:
              break;
          }
        },
        onError: (error) => setRunError(errorMessage(error)),
        onDone: async () => {
          setStreaming(false);
          abortRef.current = null;
          await loadThreads();
          if (threadId) {
            try {
              const data = await api<{ messages: AgentMessage[]; approvals: Approval[] }>(
                `/agent/threads/${threadId}`
              );
              setMessages(data.messages);
              setApprovals(data.approvals);
              setStreamed([]);
              setTools([]);
            } catch {
              /* keep live transcript if reload fails */
            }
          }
        },
      }
    );
  };

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const resolveApproval = async (approval: Approval, decision: "approve" | "reject") => {
    setApproving(approval.id);
    try {
      const result = await post<{ approval: Approval; result: { ok: boolean; summary: string } }>(
        `/agent/approvals/${approval.id}`,
        { decision }
      );
      setApprovals((current) => current.map((item) => (item.id === approval.id ? result.approval : item)));
      notify(result.result.summary, result.result.ok ? "success" : "warn");
      if (activeThread) await openThread(activeThread);
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setApproving(null);
    }
  };

  const removeThread = async (thread: AgentThread) => {
    if (!window.confirm(`Delete conversation "${thread.title}"? Messages and pending approvals will be removed.`)) return;
    try {
      await del(`/agent/threads/${thread.id}`);
      if (activeThread === thread.id) startNew();
      notify("Conversation deleted", "success");
      await loadThreads();
    } catch (error) {
      notify(errorMessage(error), "error");
    }
  };

  const refreshModels = async () => {
    setCatalogLoading(true);
    try {
      const data = await post<ModelCatalog>("/models/refresh", {});
      setCatalog(data);
      notify(`Found ${data.models.length} free tool-capable model(s)`, "success");
    } catch (error) {
      notify(errorMessage(error), "error");
    } finally {
      setCatalogLoading(false);
    }
  };

  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const visibleMessages = useMemo(() => messages.filter((message) => message.role !== "system"), [messages]);
  const selectedProject = projects.find((project) => project.id === projectId);

  if (demo) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>AI agent</h1>
        </div>
        <InfoBanner kind="warn">
          <strong>The agent is disabled in demo mode.</strong>
          <span className="small">
            Demo mode never calls OpenRouter and does not spend tokens. Configure <code>OPENROUTER_API_KEY</code> to
            enable the real tool-calling agent.
          </span>
        </InfoBanner>
        <section className="card">
          <Empty
            icon={<Sparkles size={19} />}
            title="No model calls are made"
            description="The agent only runs against real repositories, Cloudflare builds and logs that it can verify with tools."
          />
        </section>
      </div>
    );
  }

  return (
    <div className="page" style={{ maxWidth: 1500 }}>
      <div className="page-head">
        <div>
          <h1>AI agent</h1>
          <p>
            Tool-calling agent restricted to free OpenRouter models. It can inspect repositories, real build logs and
            Cloudflare resources. Writes, patches and deployments require your explicit approval.
          </p>
        </div>
        <div className="page-actions">
          <button type="button" className="btn" onClick={startNew}>
            <MessageSquarePlus size={14} /> New conversation
          </button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "minmax(200px, 260px) minmax(0, 1fr)", alignItems: "start" }}>
        <aside className="card flush" style={{ maxHeight: "calc(100vh - 160px)", overflow: "auto", position: "sticky", top: 76 }}>
          <div className="toolbar" style={{ padding: "10px 12px" }}>
            <h3 style={{ flex: 1 }}>Conversations</h3>
          </div>
          {threadsLoading ? (
            <Loading label="Loading" />
          ) : threads.length === 0 ? (
            <p className="small muted" style={{ padding: 14 }}>
              No conversations yet.
            </p>
          ) : (
            <div className="menu" style={{ maxHeight: "none" }}>
              {threads.map((thread) => (
                <div key={thread.id} className={`menu-item ${activeThread === thread.id ? "active" : ""}`}>
                  <button
                    type="button"
                    className="menu-item"
                    style={{ padding: 0, flex: 1, minWidth: 0 }}
                    onClick={() => void openThread(thread.id)}
                  >
                    <span className="truncate">{thread.title}</span>
                  </button>
                  <span className="meta">{thread.messageCount ?? 0}</span>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ width: 24, height: 24 }}
                    onClick={() => void removeThread(thread)}
                    aria-label={`Delete ${thread.title}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </aside>

        <div className="stack">
          <div className="card" style={{ padding: 12 }}>
            <div className="row">
              <div className="field" style={{ minWidth: 200 }}>
                <label htmlFor="agent-project">Project context</label>
                <select
                  id="agent-project"
                  className="select"
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  <option value="">No project selected</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ minWidth: 240, flex: 1 }}>
                <label htmlFor="agent-model">Free model</label>
                <select
                  id="agent-model"
                  className="select"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  disabled={catalogLoading || !catalog?.models.length}
                >
                  {catalog?.models.length ? null : <option value="">No free model available</option>}
                  {catalog?.models.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {Math.round(item.contextLength / 1000)}k ctx
                    </option>
                  ))}
                </select>
              </div>
              <div className="field" style={{ minWidth: 120 }}>
                <label>&nbsp;</label>
                <button type="button" className="btn" onClick={() => void refreshModels()} disabled={catalogLoading}>
                  {catalogLoading ? <Spinner /> : <Sparkles size={14} />} Refresh models
                </button>
              </div>
            </div>
            {catalog?.error ? <p className="tiny dim" style={{ marginTop: 8 }}>{catalog.error}</p> : null}
            {catalog?.selectionReason ? (
              <p className="tiny dim" style={{ marginTop: 6 }}>
                Auto-selection: {catalog.selectionReason}
                {catalog.overridden ? " (override from KI00_AGENT_MODEL)" : ""}
              </p>
            ) : null}
            {selectedProject ? (
              <p className="tiny dim" style={{ marginTop: 6 }}>
                Context: {selectedProject.repoOwner}/{selectedProject.repoName} · {selectedProject.branch} ·{" "}
                {selectedProject.runtimeKind}
              </p>
            ) : null}
          </div>

          {runError ? <ErrorBanner error={new Error(runError)} /> : null}
          {threadError ? <ErrorBanner error={new Error(threadError)} /> : null}

          <div className="card chat" style={{ padding: 16 }}>
            <div className="chat-scroll" ref={scrollRef}>
              {threadLoading ? <Loading label="Loading conversation" /> : null}
              {!threadLoading && visibleMessages.length === 0 && streamed.length === 0 ? (
                <Empty
                  icon={<Sparkles size={20} />}
                  title="Ask about a real build"
                  description={
                    selectedProject
                      ? "Try: inspect the last failed deployment and explain the build error. The agent calls KI00 tools and reads the Cloudflare log."
                      : "Select a project for full context, or ask about deployment and compatibility policy."
                  }
                  action={
                    <div className="row" style={{ justifyContent: "center", flexWrap: "wrap" }}>
                      {[
                        "Explain KI00's Workers compatibility rules",
                        "What free Cloudflare limits apply to my builds?",
                        selectedProject ? "Review the last deployment and its logs" : "How do I connect a repository?",
                      ].map((prompt) => (
                        <button key={prompt} type="button" className="btn sm" onClick={() => setInput(prompt)}>
                          {prompt}
                        </button>
                      ))}
                    </div>
                  }
                />
              ) : null}

              {visibleMessages.map((message) => (
                <MessageBubble key={message.id} message={message} />
              ))}

              {streamed.map((message, index) => (
                <div className="msg assistant" key={`stream-${index}`}>
                  <span className="avatar">AI</span>
                  <div className="bubble">{message.content}</div>
                </div>
              ))}

              {tools.length ? (
                <div className="stack" style={{ gap: 6, maxWidth: 860 }}>
                  {tools.map((tool, index) => (
                    <div key={`${tool.name}-${index}`} className="tool-call">
                      {tool.summary === undefined ? <Spinner size={12} /> : tool.ok ? <Check size={13} color="var(--green)" /> : <X size={13} color="var(--red)" />}
                      <Wrench size={13} />
                      <span className="mono">{tool.name}</span>
                      {tool.summary ? <span className="dim">· {tool.summary}</span> : <span className="dim">running…</span>}
                    </div>
                  ))}
                </div>
              ) : null}

              {streaming ? (
                <div className="row small dim">
                  <Spinner size={12} /> The agent is working. Tool results are real; nothing is streamed from a stub.
                </div>
              ) : null}
            </div>

            {pendingApprovals.length ? (
              <div className="stack" style={{ gap: 8 }}>
                {pendingApprovals.map((approval) => (
                  <div key={approval.id} className="approval-card">
                    <div className="row between">
                      <strong className="small">
                        Approval required: {approval.action.replace(/_/g, " ")}
                      </strong>
                      <span className="pill queued">pending</span>
                    </div>
                    <p className="small muted">
                      The agent proposed this action. Nothing has been executed. Review the arguments and approve
                      only if you want KI00 to write to GitHub or start a Cloudflare build.
                    </p>
                    <details className="small">
                      <summary className="dim" style={{ cursor: "pointer" }}>
                        Show arguments
                      </summary>
                      <pre className="mono tiny break" style={{ whiteSpace: "pre-wrap", maxHeight: 220, overflow: "auto" }}>
                        {JSON.stringify(approval.args, null, 2)}
                      </pre>
                    </details>
                    <div className="row">
                      <button
                        type="button"
                        className="btn primary sm"
                        disabled={approving === approval.id}
                        onClick={() => void resolveApproval(approval, "approve")}
                      >
                        {approving === approval.id ? <Spinner /> : <Check size={13} />} Approve and run
                      </button>
                      <button
                        type="button"
                        className="btn danger sm"
                        disabled={approving === approval.id}
                        onClick={() => void resolveApproval(approval, "reject")}
                      >
                        <X size={13} /> Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {approvals.some((approval) => approval.status !== "pending") ? (
              <details className="small dim">
                <summary style={{ cursor: "pointer" }}>Resolved approvals ({approvals.filter((approval) => approval.status !== "pending").length})</summary>
                <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                  {approvals
                    .filter((approval) => approval.status !== "pending")
                    .map((approval) => (
                      <div key={approval.id} className="row small">
                        <span className="mono tiny">{approval.action}</span>
                        <StatusPill status={approval.status === "approved" ? "success" : "failed"} label={approval.status} />
                        <span className="dim tiny">{timeAgo(approval.resolvedAt ?? approval.createdAt)}</span>
                      </div>
                    ))}
                </div>
              </details>
            ) : null}

            <div className="composer">
              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder="Ask the agent to inspect a build failure, review compatibility, or propose a patch…"
                aria-label="Message the agent"
              />
              <div className="row">
                <span className="tiny dim">
                  {usage
                    ? `${usage.calls} / ${usage.maxCalls} model calls · ${usage.promptTokens + usage.completionTokens} tokens`
                    : "Max 8 model calls per task · free models only"}
                </span>
                <span className="spacer" />
                {streaming ? (
                  <button type="button" className="btn sm danger" onClick={stop}>
                    <Square size={12} /> Stop
                  </button>
                ) : (
                  <button type="button" className="btn primary sm" onClick={() => void send()} disabled={!input.trim()}>
                    <ArrowUp size={13} /> Send
                  </button>
                )}
              </div>
            </div>
            <p className="tiny dim" style={{ marginTop: 8 }}>
              The agent never receives secret values. Destructive or publishing actions stay blocked until you approve
              the exact proposed action. OpenRouter usage is billed to your key; KI00 selects free models only.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: AgentMessage }) {
  if (message.role === "user") {
    return (
      <div className="msg user">
        <div className="bubble">{message.content}</div>
      </div>
    );
  }
  if (message.role === "approval") {
    return (
      <div className="msg tool">
        <span className="avatar">OK</span>
        <div className="bubble">{message.content}</div>
      </div>
    );
  }
  if (message.role === "tool") {
    return (
      <details className="msg tool">
        <summary className="tool-call" style={{ cursor: "pointer", listStyle: "none" }}>
          <Wrench size={12} />
          <span className="mono">{message.toolName ?? "tool"}</span>
          <span className="dim">result</span>
        </summary>
        <div className="bubble" style={{ marginTop: 6 }}>
          <pre className="mono tiny" style={{ margin: 0, whiteSpace: "pre-wrap", maxHeight: 260, overflow: "auto" }}>
            {JSON.stringify(message.toolResult, null, 2)}
          </pre>
        </div>
      </details>
    );
  }
  return (
    <div className="msg assistant">
      <span className="avatar">AI</span>
      <div className="bubble">{message.content}</div>
    </div>
  );
}
