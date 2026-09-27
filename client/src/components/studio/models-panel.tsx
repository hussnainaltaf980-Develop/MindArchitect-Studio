import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useStudio } from "@/stores/studio-store";
import { fetchModels, type CatalogueEntry, type GatewayStatus } from "@/lib/studio-api";

// The sovereign hierarchy. Reads /v1/models so `available` and `status` are the
// registry's verdict, not a hardcoded label: Forge reports whether a checkpoint
// was actually probed, and the CI line stays non-routable.
export function ModelsPanel() {
  const [models, setModels] = useState<CatalogueEntry[] | null>(null);
  const [gateway, setGateway] = useState<{ live: boolean; status?: GatewayStatus } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchModels()
      .then((body) => {
        if (cancelled) return;
        setModels(body.data);
        setGateway({ live: body.gateway_live, status: body.gateway });
        setAt(body.generated_at);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const useModel = (m: CatalogueEntry) => {
    const store = useStudio.getState();
    store.setSelectedModel(m.id);
    store.setDeepReasoning(m.routing === "cognitive" || m.badge === "APEX");
    store.newConversation();
    store.setView("chat");
  };

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto scroll-thin px-4 py-8 sm:px-8">
      <h2 className="font-display text-xl font-medium text-fg">Sovereign hierarchy</h2>
      <p className="mt-1 text-sm text-muted">
        Pick a line. Chat uses the composer; Apex arms Deep Reasoning. Smoke stays CI-only.
      </p>

      {/* The reply plane's real state. `status` here is a probe verdict, not an
          env-var presence check — so "configured but unreachable" reads as the
          fault it is. */}
      {gateway ? (
        <div className="mt-4 rounded-lg border border-line bg-surface px-3 py-2.5">
          <p className="text-[11px] uppercase tracking-wider text-subtle">Reply plane</p>
          <p
            className={cn(
              "mt-0.5 text-sm font-medium",
              gateway.live ? "text-ok" : gateway.status?.configured ? "text-danger" : "text-warn",
            )}
          >
            {gateway.live
              ? `Live gateway · ${gateway.status?.model}`
              : gateway.status?.configured
                ? "Gateway configured, unreachable"
                : "Local expert plane"}
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            {gateway.live
              ? `${gateway.status?.baseUrl} · key from ${gateway.status?.keySource} · ${gateway.status?.latencyMs}ms`
              : gateway.status?.detail ?? "No gateway key configured. Replies come from recorded project knowledge."}
          </p>
        </div>
      ) : null}
      {error ? <p className="mt-4 text-sm text-danger">{error}</p> : null}
      {!models && !error ? <p className="mt-6 text-sm text-muted">Reading registry…</p> : null}
      <ul className="mt-6 space-y-3">
        {(models ?? []).map((m) => (
          <li key={m.id} className="rounded-xl border border-line bg-surface p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-3">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "rounded-sm px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-wide",
                    m.series === "CI" ? "bg-lift text-muted" : "bg-signal/15 text-signal",
                  )}
                >
                  {m.badge}
                </span>
                <h3 className="font-display text-base text-fg">{m.name}</h3>
              </div>
              <span className="tabular font-mono text-[11px] text-subtle">
                {m.params} · {m.ctx}
              </span>
            </div>
            <p className="mt-1 font-mono text-xs text-signal">{m.id}</p>
            <p className="mt-2 text-sm leading-relaxed text-chrome">{m.role}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted">{m.vibe}</p>
            <p className="mt-2 text-sm text-chrome">{m.note}</p>
            {m.probe?.final_loss != null ? (
              <p className="tabular mt-2 font-mono text-[11px] text-subtle">
                loss {m.probe.final_loss} · ppl {m.probe.final_ppl} · acc {m.probe.token_accuracy}
              </p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5 font-medium",
                  m.available ? "bg-ok/15 text-ok" : "bg-lift text-muted",
                )}
              >
                Available: {m.available ? "True" : "False"}
              </span>
              <span className="rounded-full bg-lift px-2 py-0.5 font-mono text-subtle">
                {m.status}
              </span>
              {m.competitor !== "—" ? (
                <span className="text-subtle">internal counter: {m.competitor}</span>
              ) : null}
              {m.series !== "CI" ? (
                <button
                  type="button"
                  onClick={() => useModel(m)}
                  className="ml-auto h-10 rounded-md bg-chrome px-3 text-xs font-medium text-bg"
                >
                  Use {m.badge}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {at ? (
        <p className="mt-6 text-[11px] text-subtle">Registry snapshot {at}</p>
      ) : null}
    </div>
  );
}
