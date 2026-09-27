import { Link } from "wouter";
import { trpc } from "@/_core/trpc";
import { Button } from "@/components/ui/button";
import { DeviceBadge } from "@/components/DeviceBadge";
import { useAuth } from "@/_core/useAuth";

/**
 * Environment overview.
 *
 * This replaced the scaffold's example CRUD page, which queried an `items`
 * router that does not exist in this app. A page that 500s on `trpc.items.list`
 * is worse than no page, so rather than leave a dead route it now reports what
 * the environment actually provides — which is the thing a GPU workspace user
 * wants confirmed first.
 */
export default function Dashboard() {
  const { user } = useAuth();
  const device = trpc.device.info.useQuery();
  const workspaces = trpc.workspaces.list.useQuery();

  const rows: [string, string][] = [
    ["runtime", device.data?.runtime ?? "…"],
    ["cuda available", device.data == null ? "…" : device.data.cudaReady ? "yes" : "no"],
    ["accelerator", device.data?.gpuName ?? "none detected"],
    ["cpu count", device.data?.cpuCount != null ? `${device.data.cpuCount} vCPU` : "…"],
    [
      "memory cap",
      device.data?.memoryCapMb != null
        ? `${(device.data.memoryCapMb / 1024).toFixed(1)} GiB`
        : "not reported",
    ],
    ["vram", device.data?.vramGb != null ? `${device.data.vramGb} GB` : "none detected"],
    ["workspaces", workspaces.data ? String(workspaces.data.length) : "…"],
  ];

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-5 py-3">
          <Link to="/" className="text-[13px] font-semibold tracking-tight">
            MindArchitect Studio
          </Link>
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Environment
          </span>
          <div className="ml-auto flex items-center gap-2">
            <DeviceBadge
              runtime={device.data?.runtime ?? "cpu"}
              gpuName={device.data?.gpuName}
              cpuCount={device.data?.cpuCount}
              memoryCapMb={device.data?.memoryCapMb}
            />
            <Button asChild size="sm" variant="outline">
              <Link to="/workspaces">Workspaces</Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-8">
        <h1 className="text-[var(--text-xl)] font-semibold tracking-tight">
          Environment
          {user?.name ? <span className="text-muted-foreground"> · {user.name}</span> : null}
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
          What this host actually provides, probed at request time. CUDA images are supplied for a
          GPU host; when no device is present the runtime falls back to CPU and says so.
        </p>

        <section className="panel mt-6 overflow-hidden">
          <div className="panel-header">
            <span className="panel-title">Device probe</span>
            <span className="text-[11px] text-muted-foreground">
              {device.isLoading ? "probing…" : "live"}
            </span>
          </div>
          <table className="w-full text-[13px]">
            <tbody>
              {rows.map(([k, v]) => (
                <tr key={k} className="border-b border-border/60 last:border-0">
                  <th className="w-52 px-3 py-2 text-left font-medium text-muted-foreground">
                    {k}
                  </th>
                  <td className="tabular px-3 py-2 font-mono">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {device.data?.evidence?.length ? (
          <section className="panel mt-4 p-3">
            <h2 className="panel-title mb-2">Detection evidence</h2>
            <ul className="space-y-1">
              {device.data.evidence.map((e) => (
                <li key={e} className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                  · {e}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="mt-6">
          <Button asChild>
            <Link to="/workspaces">Open workspaces</Link>
          </Button>
        </div>
      </main>
    </div>
  );
}
