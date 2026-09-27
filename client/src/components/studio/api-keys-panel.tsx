import { useState } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { trpc } from "@/_core/trpc";

// ── Platform API keys ───────────────────────────────────────────────────────
//
// The Studio's own developer keys, presented the way a model provider presents
// them. Two behaviours here are deliberate and worth stating, because both are
// easy to "fix" into a worse design:
//
//  1. The plaintext key is shown ONCE, in a modal that requires an explicit
//     "I have saved it" click. It is never re-fetchable — the server cannot
//     produce it again, so the UI must not imply it can (no "reveal" affordance
//     on the list rows).
//  2. Revoke asks twice. Revocation is immediate and irreversible; a key that is
//     powering someone's production job does not deserve a one-click delete.
//
// Every row shows status, scopes, the hourly budget and REAL usage — the counts
// come from the same rows the limiter reads, so this panel cannot drift from
// what the API actually enforces.
type CreatedKey = { plaintext: string; key: ApiKey };

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  environment: string;
  scopes: string[];
  rateLimitPerHour: number;
  requestCount: number;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  expiresAt: string | null;
  createdAt: string;
  status: "active" | "revoked" | "expired";
};

function when(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "unknown";
  const secs = Math.round((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.floor(secs / 3600)}h ago`;
  return d.toISOString().slice(0, 10);
}

export function ApiKeysPanel() {
  const list = trpc.apiKeys.list.useQuery();
  const utils = trpc.useUtils();
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);
  const [name, setName] = useState("");
  const [limit, setLimit] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const invalidate = () => void utils.apiKeys.list.invalidate();

  const create = trpc.apiKeys.create.useMutation({
    onSuccess: (res) => {
      setCreated(res as CreatedKey);
      setName("");
      setLimit("");
      setShowCreate(false);
      invalidate();
    },
  });

  const revoke = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      setConfirmRevoke(null);
      invalidate();
    },
  });

  const rotate = trpc.apiKeys.rotate.useMutation({
    onSuccess: (res) => {
      setCreated(res as CreatedKey);
      invalidate();
    },
  });

  const remove = trpc.apiKeys.remove.useMutation({ onSuccess: invalidate });

  const keys: ApiKey[] = (list.data?.keys ?? []) as ApiKey[];
  const usage = list.data?.usage;
  const defaults = list.data?.defaults;

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto scroll-thin px-4 py-8 sm:px-8">
      <div className="flex items-center gap-2">
        <KeyRound className="size-5 text-signal" />
        <h2 className="font-display text-xl font-medium text-fg">API keys</h2>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        Keys let your own code call MindArchitect Studio&apos;s models. A key is shown
        once when it is created and stored only as a hash — if you lose it, rotate it
        rather than looking for it.
      </p>

      {usage && (
        <div className="mt-6 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Active" value={String(usage.active)} />
          <Stat label="Revoked" value={String(usage.revoked)} />
          <Stat label="Expired" value={String(usage.expired)} />
          <Stat label="Requests" value={usage.requests.toLocaleString()} />
        </div>
      )}

      <div className="mt-6 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex h-11 items-center gap-2 rounded-md border border-signal/40 bg-signal/10 px-3 text-sm text-fg hover:bg-signal/15"
        >
          <Plus className="size-3.5" /> Create key
        </button>
        <button
          type="button"
          onClick={invalidate}
          className="inline-flex h-11 items-center gap-2 rounded-md border border-line bg-surface px-3 text-sm text-chrome hover:bg-lift"
        >
          <RefreshCw className={cn("size-3.5", list.isFetching && "animate-spin")} /> Refresh
        </button>
      </div>

      {showCreate && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({
              name: name.trim() || "Untitled key",
              rateLimitPerHour: limit ? Number(limit) : undefined,
            });
          }}
          className="mt-4 rounded-lg border border-line bg-surface p-4"
        >
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-subtle">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Production ingest"
              autoFocus
              className="mt-1.5 h-11 w-full rounded-md border border-line bg-inset px-3 text-sm text-fg"
            />
            <span className="mt-1 block text-[11px] text-subtle">
              Names are how you tell keys apart later. They are not secret.
            </span>
          </label>
          <label className="mt-4 block">
            <span className="text-xs uppercase tracking-wider text-subtle">
              Requests per hour
            </span>
            <input
              value={limit}
              onChange={(e) => setLimit(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder={String(defaults?.rateLimitPerHour ?? 120)}
              inputMode="numeric"
              className="mt-1.5 h-11 w-full rounded-md border border-line bg-inset px-3 text-sm text-fg"
            />
            <span className="mt-1 block text-[11px] text-subtle">
              Leave blank for the default of {defaults?.rateLimitPerHour ?? 120}/hour.
            </span>
          </label>
          {create.error && (
            <p className="mt-3 rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
              {create.error.message}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <button
              type="submit"
              disabled={create.isPending}
              className="inline-flex h-11 items-center gap-2 rounded-md border border-signal/40 bg-signal/15 px-4 text-sm text-fg disabled:opacity-50"
            >
              {create.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Create key
            </button>
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="h-11 rounded-md border border-line bg-surface px-4 text-sm text-muted hover:bg-lift"
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <section className="mt-8">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-subtle">
          Your keys
        </h3>

        {list.isPending && (
          <p className="mt-3 text-sm text-muted">
            <Loader2 className="mr-2 inline size-3.5 animate-spin" />
            Loading keys…
          </p>
        )}

        {!list.isPending && keys.length === 0 && (
          <div className="mt-3 rounded-lg border border-dashed border-line bg-surface/50 px-4 py-6 text-center">
            <p className="text-sm text-muted">No keys yet.</p>
            <p className="mt-1 text-xs text-subtle">
              Create one to call the models from your own code.
            </p>
          </div>
        )}

        <div className="mt-3 space-y-2">
          {keys.map((k) => (
            <div
              key={k.id}
              className={cn(
                "rounded-lg border px-4 py-3",
                k.status === "active"
                  ? "border-line bg-surface"
                  : "border-line/60 bg-surface/40 opacity-80",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-fg">{k.name}</span>
                <StatusPill status={k.status} />
                <code className="rounded bg-inset px-1.5 py-0.5 font-mono text-[11px] text-muted">
                  {k.prefix}…{k.last4}
                </code>
                <span className="ml-auto font-mono text-[11px] text-subtle">
                  {k.requestCount.toLocaleString()} / {k.rateLimitPerHour} per hour
                </span>
              </div>

              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-subtle">
                <span>created {when(k.createdAt)}</span>
                <span>last used {when(k.lastUsedAt)}</span>
                {k.expiresAt && <span>expires {k.expiresAt.slice(0, 10)}</span>}
                <span>{k.scopes.length ? k.scopes.join(" · ") : "no scopes"}</span>
                {k.revokedAt && <span className="text-danger">revoked {when(k.revokedAt)}</span>}
              </div>

              {k.status === "active" && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => rotate.mutate({ id: k.id })}
                    disabled={rotate.isPending}
                    className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs text-chrome hover:bg-lift disabled:opacity-50"
                  >
                    <RotateCw className="size-3" /> Rotate
                  </button>
                  {confirmRevoke === k.id ? (
                    <span className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => revoke.mutate({ id: k.id })}
                        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-danger/40 bg-danger/15 px-3 text-xs text-danger"
                      >
                        <AlertTriangle className="size-3" /> Yes, revoke now
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRevoke(null)}
                        className="h-9 rounded-md border border-line bg-surface px-3 text-xs text-muted"
                      >
                        Keep it
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmRevoke(k.id)}
                      className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs text-danger hover:bg-danger/10"
                    >
                      <Trash2 className="size-3" /> Revoke
                    </button>
                  )}
                </div>
              )}

              {k.status !== "active" && (
                <button
                  type="button"
                  onClick={() => remove.mutate({ id: k.id })}
                  className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs text-muted hover:bg-lift"
                >
                  <Trash2 className="size-3" /> Delete permanently
                </button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="mt-10 rounded-lg border border-line bg-surface px-4 py-4">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-subtle">
          Using a key
        </h3>
        <pre className="mt-2 overflow-x-auto scroll-thin rounded-md bg-inset p-3 font-mono text-[11px] leading-relaxed text-chrome">
{`curl ${typeof window !== "undefined" ? window.location.origin : ""}/v1/chat/completions \\
  -H "Authorization: Bearer ma_live_…" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"mindarchitect-synapse-v5","messages":[{"role":"user","content":"Hello"}]}'`}
        </pre>
        <p className="mt-2 text-[11px] text-subtle">
          Responses carry <code className="font-mono">x-ma-engine</code> telling you whether a
          hosted gateway or the local expert plane answered, plus{" "}
          <code className="font-mono">x-ratelimit-remaining</code>.
        </p>
      </section>

      {created && <CreatedKeyModal created={created} onClose={() => setCreated(null)} copied={copied} setCopied={setCopied} />}
    </div>
  );
}

function StatusPill({ status }: { status: ApiKey["status"] }) {
  const map = {
    active: "border-ok/30 bg-ok/10 text-ok",
    revoked: "border-danger/30 bg-danger/10 text-danger",
    expired: "border-warn/30 bg-warn/10 text-warn",
  } as const;
  return (
    <span className={cn("rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider", map[status])}>
      {status}
    </span>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-subtle">{label}</p>
      <p className="tabular mt-0.5 font-mono text-sm text-fg">{value}</p>
    </div>
  );
}

// The one-time reveal. Fixed overlay rather than a route so it cannot be reached
// again by navigating back, and there is no dismiss-by-clicking-away: the only
// way out is the explicit acknowledgement button.
function CreatedKeyModal({
  created,
  onClose,
  copied,
  setCopied,
}: {
  created: CreatedKey;
  onClose: () => void;
  copied: boolean;
  setCopied: (v: boolean) => void;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.plaintext);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-xl border border-signal/30 bg-card p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <KeyRound className="size-4 text-signal" />
          <h3 className="font-display text-base font-medium text-fg">
            {created.key.name}
          </h3>
        </div>
        <p className="mt-2 text-sm text-muted">
          This is the only time the key is shown. Copy it into your secret store now —
          it is stored only as a hash and cannot be recovered.
        </p>
        <div className="mt-3 flex items-stretch gap-2">
          <code className="min-w-0 flex-1 overflow-x-auto scroll-thin rounded-md border border-line bg-inset px-3 py-2.5 font-mono text-xs text-fg">
            {created.plaintext}
          </code>
          <button
            type="button"
            onClick={copy}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-3 text-xs text-chrome hover:bg-lift"
          >
            {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-subtle">
          <span>prefix {created.key.prefix}</span>
          <span>{created.key.rateLimitPerHour}/hour</span>
          <span>{created.key.scopes.join(" · ") || "no scopes"}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 h-11 w-full rounded-md border border-signal/40 bg-signal/15 text-sm text-fg hover:bg-signal/20"
        >
          I have saved this key
        </button>
      </div>
    </div>
  );
}
