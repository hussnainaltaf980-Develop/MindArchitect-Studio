import { useEffect, useState } from "react";
import {
  Cpu,
  Files,
  FlaskConical,
  GitBranch,
  KeyRound,
  Layers3,
  LogOut,
  MessageSquare,
  PanelLeft,
  Plus,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/lib/brand";
import { useStudio, type StudioView } from "@/stores/studio-store";
import { fetchHealth, type GatewayStatus } from "@/lib/studio-api";
import { useAuth } from "@/_core/useAuth";
import { ChatWindow } from "@/components/studio/chat-window";
import { ModelsPanel } from "@/components/studio/models-panel";
import { LabPanel } from "@/components/studio/lab-panel";
import { AgentsPanel, DocumentsPanel, MemoryPanel } from "@/components/studio/panels";
import { SettingsPanel } from "@/components/studio/settings-panel";
import { ApiKeysPanel } from "@/components/studio/api-keys-panel";

const NAV: { id: StudioView; label: string; icon: typeof MessageSquare }[] = [
  { id: "chat", label: "Chat", icon: MessageSquare },
  { id: "agents", label: "Agents", icon: GitBranch },
  { id: "lab", label: "Lab", icon: FlaskConical },
  { id: "documents", label: "Documents", icon: Files },
  { id: "memory", label: "Memory", icon: Layers3 },
  { id: "models", label: "Models", icon: Cpu },
  { id: "apikeys", label: "API keys", icon: KeyRound },
  { id: "settings", label: "Settings", icon: SlidersHorizontal },
];

// API keys and Settings are destinations you visit to change something, not
// workspaces you inhabit — so they sit under the divider, with the mobile bar
// keeping only the five you switch between while working.
const BOTTOM_NAV = NAV.filter((n) => n.id !== "settings" && n.id !== "apikeys");

export function StudioShell() {
  const [hydrated, setHydrated] = useState(false);
  const view = useStudio((s) => s.view);
  const conversations = useStudio((s) => s.conversations);
  const activeId = useStudio((s) => s.activeId);
  const sidebarOpen = useStudio((s) => s.sidebarOpen);
  const activeRunId = useStudio((s) => s.activeRunId);
  const deepReasoning = useStudio((s) => s.deepReasoning);
  const showTraceRail = useStudio((s) => s.settings.showTraceRail);
  const selectedModel = useStudio((s) => s.selectedModel);
  const { user, logout } = useAuth();

  const [health, setHealth] = useState<{ gateway_live: boolean; gateway?: GatewayStatus } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      await useStudio.persist.rehydrate();
      if (!live) return;
      const s = useStudio.getState();
      if (s.settings.deepDefault) s.setDeepReasoning(true);
      s.setSidebarOpen(window.innerWidth >= 768);
      setHydrated(true);
    })();
    void fetchHealth()
      .then((h) => live && setHealth({ gateway_live: h.gateway_live, gateway: h.gateway }))
      .catch(() => live && setHealth({ gateway_live: false }));
    return () => {
      live = false;
    };
  }, []);

  const go = (id: StudioView) => {
    useStudio.getState().setView(id);
    if (window.innerWidth < 768) useStudio.getState().setSidebarOpen(false);
  };

  const showRail = view === "chat" && Boolean(activeRunId) && showTraceRail;
  const activeTrace = activeRunId ? useStudio.getState().traces[activeRunId] : undefined;

  const displayName = user?.name || user?.email || "Account";

  // Three states, not two. A gateway that is CONFIGURED but unreachable is a
  // fault worth showing distinctly from "no key configured" — collapsing them
  // into one warn-coloured pill is how a dead key looks like a working setup.
  const engine = !health
    ? { label: "Probing…", cls: "bg-lift text-muted" }
    : health.gateway?.reachable
      ? { label: "Live", cls: "bg-ok/15 text-ok" }
      : health.gateway?.configured
        ? { label: "Gateway down", cls: "bg-danger/15 text-danger" }
        : { label: "Local expert", cls: "bg-warn/15 text-warn" };

  return (
    <div className="flex h-dvh min-h-0 bg-bg text-fg">
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          className="fixed inset-0 z-40 bg-bg/70 md:hidden"
          onClick={() => useStudio.getState().setSidebarOpen(false)}
        />
      ) : null}

      <aside
        className={cn(
          "flex shrink-0 flex-col border-r border-line bg-surface",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:w-[min(18.5rem,88vw)] max-md:transition-transform max-md:duration-200",
          sidebarOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full",
          sidebarOpen ? "md:w-[16.5rem]" : "md:w-16",
        )}
      >
        <div className="flex h-14 items-center gap-2 border-b border-line px-3">
          <Logo variant="mark" height={28} />
          {sidebarOpen ? (
            <div className="min-w-0 flex-1">
              <Logo variant="wordmark" className="block truncate text-[15px]" />
              <p className="text-[10px] font-medium uppercase tracking-[0.28em] text-subtle">
                Studio
              </p>
            </div>
          ) : null}
          <button
            type="button"
            className="ml-auto flex size-10 items-center justify-center rounded-md text-muted hover:bg-lift md:hidden"
            onClick={() => useStudio.getState().setSidebarOpen(false)}
            aria-label="Close sidebar"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex flex-col gap-0.5 p-2">
          {NAV.map((item) => {
            const Icon = item.icon;
            const on = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => go(item.id)}
                className={cn(
                  "flex h-11 items-center gap-3 rounded-md px-2.5 text-sm",
                  on ? "bg-lift text-fg" : "text-muted hover:bg-lift/60 hover:text-fg",
                )}
                title={item.label}
              >
                <Icon className="size-4 shrink-0" />
                {sidebarOpen ? (
                  item.label
                ) : (
                  <span className="sr-only">{item.label}</span>
                )}
              </button>
            );
          })}
        </nav>

        {sidebarOpen ? (
          <div className="flex min-h-0 flex-1 flex-col border-t border-line">
            <div className="flex items-center justify-between px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wider text-subtle">
                Conversations
              </p>
              <button
                type="button"
                onClick={() => {
                  useStudio.getState().newConversation();
                  go("chat");
                }}
                className="flex size-9 items-center justify-center rounded-sm text-muted hover:bg-lift hover:text-fg"
                aria-label="New conversation"
              >
                <Plus className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto scroll-thin px-2 pb-3">
              {conversations.length === 0 ? (
                <p className="px-2 py-1 text-xs text-subtle">No threads yet. Send a prompt.</p>
              ) : (
                conversations.map((c) => (
                  <div
                    key={c.id}
                    className={cn(
                      "group mb-0.5 flex items-center rounded-md",
                      c.id === activeId ? "bg-lift" : "hover:bg-lift/50",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        useStudio.getState().selectConversation(c.id);
                        go("chat");
                      }}
                      className="min-w-0 flex-1 truncate px-2.5 py-2.5 text-left text-xs text-chrome"
                    >
                      {c.title}
                    </button>
                    <button
                      type="button"
                      className="mr-1 flex size-9 items-center justify-center text-subtle hover:text-danger"
                      onClick={() => useStudio.getState().deleteConversation(c.id)}
                      aria-label={`Delete ${c.title}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}

        {/* Identity + sign out. Auth is required, so the signed-in account is
            always visible and always escapable. */}
        <div className="border-t border-line p-2">
          <div className={cn("flex items-center gap-2", !sidebarOpen && "justify-center")}>
            <span
              className="grid size-8 shrink-0 place-items-center rounded-full bg-lift text-xs font-medium text-chrome"
              title={displayName}
            >
              {displayName.charAt(0).toUpperCase()}
            </span>
            {sidebarOpen ? (
              <>
                <span className="min-w-0 flex-1 truncate text-xs text-chrome" title={displayName}>
                  {displayName}
                </span>
                <button
                  type="button"
                  onClick={() => void logout()}
                  className="flex size-9 items-center justify-center rounded-md text-subtle hover:bg-lift hover:text-fg"
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <LogOut className="size-3.5" />
                </button>
              </>
            ) : null}
          </div>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-line px-2 sm:px-3">
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              className="flex size-11 items-center justify-center rounded-md text-muted hover:bg-lift hover:text-fg"
              onClick={() => useStudio.getState().setSidebarOpen(!sidebarOpen)}
              aria-label="Toggle sidebar"
            >
              <PanelLeft className="size-4" />
            </button>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-fg">
                {NAV.find((n) => n.id === view)?.label ?? "Studio"}
              </p>
              <p className="truncate text-[11px] text-subtle">
                {deepReasoning ? "Cognitive engine armed" : "Streaming chat"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                useStudio.getState().newConversation();
                go("chat");
              }}
              className="flex size-11 items-center justify-center rounded-md text-muted hover:bg-lift hover:text-fg"
              aria-label="New chat"
            >
              <Plus className="size-4" />
            </button>
            <button
              type="button"
              onClick={() => go("settings")}
              className={cn(
                "flex size-11 items-center justify-center rounded-md hover:bg-lift hover:text-fg",
                view === "settings" ? "text-fg" : "text-muted",
              )}
              aria-label="Settings"
            >
              <SlidersHorizontal className="size-4" />
            </button>
            <span
              className={cn(
                "hidden rounded-full px-2.5 py-1 text-[11px] font-medium sm:inline",
                engine.cls,
              )}
              title={health?.gateway?.detail ?? undefined}
            >
              {engine.label}
            </span>
            <span className="hidden rounded-full bg-lift px-2.5 py-1 font-mono text-[11px] text-muted sm:inline">
              {deepReasoning
                ? "APEX"
                : selectedModel.replace("mindarchitect-", "").split("-")[0]?.toUpperCase()}
            </span>
          </div>
        </header>

        <main className="min-h-0 flex-1">
          {!hydrated ? (
            <div className="flex h-full items-center justify-center text-sm text-muted">
              Loading studio…
            </div>
          ) : view === "chat" ? (
            <div className="flex h-full min-h-0">
              <div className="min-w-0 flex-1">
                <ChatWindow />
              </div>
              {showRail ? (
                <div className="hidden w-[22rem] shrink-0 overflow-y-auto scroll-thin border-l border-line p-4 lg:block">
                  <p className="panel-title">Trace</p>
                  {activeTrace ? (
                    <ol className="mt-3 space-y-2">
                      {activeTrace.steps.map((s) => (
                        <li
                          key={s.id}
                          className="rounded-md border border-line bg-surface px-3 py-2"
                        >
                          <p className="text-xs text-fg">{s.label}</p>
                          <p className="mt-0.5 text-[11px] text-subtle">{s.detail ?? "—"}</p>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="mt-3 text-xs text-muted">No active run.</p>
                  )}
                </div>
              ) : null}
            </div>
          ) : view === "agents" ? (
            <AgentsPanel />
          ) : view === "documents" ? (
            <DocumentsPanel />
          ) : view === "memory" ? (
            <MemoryPanel />
          ) : view === "lab" ? (
            <LabPanel />
          ) : view === "apikeys" ? (
            <ApiKeysPanel />
          ) : view === "settings" ? (
            <SettingsPanel />
          ) : (
            <ModelsPanel />
          )}
        </main>

        <nav className="flex shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden">
          {BOTTOM_NAV.map((item) => {
            const Icon = item.icon;
            const on = view === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => go(item.id)}
                className={cn(
                  "flex h-14 min-h-11 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] font-medium",
                  on ? "text-fg" : "text-subtle",
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

export function StudioMark() {
  return <Sparkles className="size-4 text-signal" />;
}
