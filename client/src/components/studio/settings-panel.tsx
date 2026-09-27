import { useEffect, useState } from "react";
import { RefreshCw, SlidersHorizontal, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchHealth, type HealthPayload } from "@/lib/studio-api";
import { CHAT_MODELS } from "@/lib/models";
import { useStudio, type ReplyStyle } from "@/stores/studio-store";

const STYLES: { id: ReplyStyle; label: string; hint: string }[] = [
  { id: "concise", label: "Concise", hint: "Short answers. Less preamble." },
  { id: "balanced", label: "Balanced", hint: "Working code plus a brief why." },
  { id: "thorough", label: "Thorough", hint: "Contracts, failure modes, files." },
];

// Settings. Every status card reads a real probe: the gateway verdict, whether
// a Forge checkpoint was found, and the smoke model's recorded vocabulary.
export function SettingsPanel() {
  const settings = useStudio((s) => s.settings);
  const selectedModel = useStudio((s) => s.selectedModel);
  const deepReasoning = useStudio((s) => s.deepReasoning);
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [pinging, setPinging] = useState(false);

  const refresh = (force = false) => {
    void fetchHealth(force)
      .then(setHealth)
      .catch(() => setHealth(null));
  };

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="mx-auto h-full max-w-2xl overflow-y-auto scroll-thin px-4 py-8 sm:px-8">
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="size-5 text-signal" />
        <h2 className="font-display text-xl font-medium text-fg">Settings</h2>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        These controls change this studio on this device. They do not retrain Forge.
      </p>

      <section className="mt-8">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-subtle">
          Engine plane
        </h3>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <StatusCard
            label="Chat"
            ok={Boolean(health?.gateway?.reachable)}
            value={
              health?.gateway?.reachable
                ? `Live gateway · ${health.gateway.model}`
                : health?.gateway?.configured
                  ? "Gateway configured, unreachable"
                  : "Local expert"
            }
            hint={
              health?.gateway?.reachable
                ? `Streaming from ${health.gateway.baseUrl}${health.gateway.baseUrlIsDefault ? " (assumed URL)" : ""}. Key from ${health.gateway.keySource}. Probing took ${health.gateway.latencyMs}ms.`
                : health?.gateway?.detail ||
                  health?.gateway_reason ||
                  "No external gateway key is configured, so answers come from the local expert plane."
            }
          />
          <StatusCard
            label="Forge student"
            ok={Boolean(health?.forge?.available)}
            value={health?.forge?.available ? "Checkpoint loaded" : "Cold"}
            hint={
              health?.forge?.available
                ? `Native decoder · loss ${String(health.forge.final_loss ?? "—")} · ${String(health.forge.param_count ?? "—")} params`
                : "Train in Lab. This student is not the chat model."
            }
          />
          <StatusCard
            label="Smoke CI"
            ok={Boolean(health?.smoke?.available)}
            value={health?.smoke?.available ? "Aligned" : "Missing"}
            hint={`vocab ${String(health?.smoke?.vocab_size ?? 32004)} · ${String(health?.smoke?.param_count ?? "—")} params · loss ${String(health?.smoke?.final_loss ?? "—")}`}
          />
          <StatusCard
            label="Cognitive"
            ok={Boolean(health?.gateway?.reachable)}
            value={health?.gateway?.reachable ? "ToT + Reflexion" : "Local planner"}
            hint={
              health?.gateway?.reachable
                ? "Deep Reasoning uses Apex. Steps land in Agents."
                : "Gateway unreachable — Deep Reasoning runs on the local planner."
            }
          />
        </div>
        <button
          type="button"
          disabled={pinging}
          onClick={() => {
            setPinging(true);
            // `force` bypasses the server's 30s probe cache. Without it this
            // button would re-render the cached verdict it was pressed to
            // invalidate — which looks like the button doing nothing.
            refresh(true);
            window.setTimeout(() => setPinging(false), 600);
          }}
          className="mt-3 inline-flex h-11 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm text-chrome hover:bg-lift"
        >
          <RefreshCw className={cn("size-3.5", pinging && "animate-spin")} />
          Re-probe gateway
        </button>
      </section>

      <section className="mt-10">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-subtle">
          Default model
        </h3>
        <select
          value={selectedModel}
          onChange={(e) => useStudio.getState().setSelectedModel(e.target.value)}
          className="mt-3 h-12 w-full rounded-md border border-line bg-inset px-3 text-sm text-fg"
        >
          {CHAT_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.badge} · {m.name.replace("MindArchitect ", "")}
            </option>
          ))}
        </select>
        <label className="mt-3 flex h-12 items-center justify-between gap-3 rounded-md border border-line bg-surface px-3">
          <span className="text-sm text-chrome">Arm Deep Reasoning by default</span>
          <input
            type="checkbox"
            checked={settings.deepDefault}
            onChange={(e) => {
              useStudio.getState().patchSettings({ deepDefault: e.target.checked });
              if (e.target.checked) useStudio.getState().setDeepReasoning(true);
            }}
            className="size-4 accent-signal"
          />
        </label>
        <p className="mt-2 text-xs text-subtle">
          Current composer:{" "}
          {deepReasoning
            ? "Apex · Deep Reasoning"
            : selectedModel.replace("mindarchitect-", "")}
        </p>
      </section>

      <section className="mt-10">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-subtle">
          Reply style
        </h3>
        <div className="mt-3 grid grid-cols-3 gap-2">
          {STYLES.map((s) => {
            const on = settings.style === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => useStudio.getState().patchSettings({ style: s.id })}
                className={cn(
                  "rounded-md border px-3 py-3 text-left",
                  on
                    ? "border-signal/40 bg-signal/10 text-fg"
                    : "border-line bg-surface text-muted hover:bg-lift",
                )}
              >
                <p className="text-sm font-medium">{s.label}</p>
                <p className="mt-1 text-[11px] leading-relaxed text-subtle">{s.hint}</p>
              </button>
            );
          })}
        </div>
      </section>

      <section className="mt-10">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-subtle">
          Decoding
        </h3>
        <label className="mt-3 block">
          <div className="flex items-center justify-between text-sm">
            <span className="text-chrome">Temperature</span>
            <span className="tabular font-mono text-xs text-subtle">
              {settings.temperature.toFixed(2)}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={1.2}
            step={0.05}
            value={settings.temperature}
            onChange={(e) =>
              useStudio.getState().patchSettings({ temperature: Number(e.target.value) })
            }
            className="mt-2 w-full accent-signal"
          />
        </label>
        <label className="mt-5 block">
          <div className="flex items-center justify-between text-sm">
            <span className="text-chrome">Max tokens</span>
            <span className="tabular font-mono text-xs text-subtle">{settings.maxTokens}</span>
          </div>
          <input
            type="range"
            min={256}
            max={4096}
            step={128}
            value={settings.maxTokens}
            onChange={(e) =>
              useStudio.getState().patchSettings({ maxTokens: Number(e.target.value) })
            }
            className="mt-2 w-full accent-signal"
          />
        </label>
        <label className="mt-5 flex h-12 items-center justify-between gap-3 rounded-md border border-line bg-surface px-3">
          <span className="text-sm text-chrome">Show trace rail on chat (desktop)</span>
          <input
            type="checkbox"
            checked={settings.showTraceRail}
            onChange={(e) =>
              useStudio.getState().patchSettings({ showTraceRail: e.target.checked })
            }
            className="size-4 accent-signal"
          />
        </label>
      </section>

      <section className="mt-10">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-subtle">
          This device
        </h3>
        <button
          type="button"
          onClick={() => {
            if (window.confirm("Clear all conversations and traces on this device?")) {
              useStudio.getState().clearConversations();
            }
          }}
          className="mt-3 inline-flex h-11 items-center gap-2 rounded-md border border-danger/30 bg-danger/10 px-3 text-sm text-danger"
        >
          <Trash2 className="size-3.5" />
          Clear conversations
        </button>
      </section>
    </div>
  );
}

function StatusCard({
  label,
  value,
  hint,
  ok,
}: {
  label: string;
  value: string;
  hint: string;
  ok: boolean;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-3">
      <p className="text-[11px] uppercase tracking-wider text-subtle">{label}</p>
      <p className={cn("mt-1 text-sm font-medium", ok ? "text-ok" : "text-warn")}>{value}</p>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">{hint}</p>
    </div>
  );
}
