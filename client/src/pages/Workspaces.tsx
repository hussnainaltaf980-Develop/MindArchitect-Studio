import { useState } from "react";
import { Link } from "wouter";
import { trpc } from "@/_core/trpc";
import { Button } from "@/components/ui/button";
import { DeviceBadge } from "@/components/DeviceBadge";
import { cn } from "@/lib/utils";

const TEMPLATES = [
  {
    id: "python",
    label: "Python · GPU training",
    blurb: "Model source, training scripts, data and artifacts.",
  },
  {
    id: "fullstack",
    label: "TypeScript · serving",
    blurb: "Serving entrypoint, inference client and Dockerfile.",
  },
  {
    id: "blank",
    label: "Blank",
    blurb: "An empty tree, for scratch work.",
  },
] as const;

export default function Workspaces() {
  const utils = trpc.useUtils();
  const list = trpc.workspaces.list.useQuery();
  const device = trpc.device.info.useQuery();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState<(typeof TEMPLATES)[number]["id"]>("python");
  const [createError, setCreateError] = useState<string | null>(null);

  const create = trpc.workspaces.create.useMutation({
    onSuccess: async () => {
      setName("");
      await utils.workspaces.list.invalidate();
    },
    onError: (e) => setCreateError(e.message),
  });

  const remove = trpc.workspaces.remove.useMutation({
    onSuccess: () => utils.workspaces.list.invalidate(),
  });

  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-3">
          <Link to="/" className="text-[13px] font-semibold tracking-tight">
            MindArchitect Studio
          </Link>
          <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Workspace
          </span>
          <div className="ml-auto">
            <DeviceBadge
              runtime={device.data?.runtime ?? "cpu"}
              gpuName={device.data?.gpuName}
              cpuCount={device.data?.cpuCount}
              memoryCapMb={device.data?.memoryCapMb}
              showDetail
            />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-8">
        <section className="mb-8">
          <h1 className="text-[var(--text-xl)] font-semibold tracking-tight">Workspaces</h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted-foreground">
            Each workspace is an isolated cloud development environment: a file tree, an editor, a
            console and a preview server. Sessions provision the environment and report what the
            host actually provides.
          </p>
        </section>

        {/* create */}
        <section className="panel mb-8 p-4">
          <h2 className="panel-title mb-3">New workspace</h2>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="workspace name"
              aria-label="Workspace name"
              className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-[13px] outline-none focus:border-ring"
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim() && !create.isPending) {
                  setCreateError(null);
                  create.mutate({ name: name.trim(), template });
                }
              }}
            />
            <Button
              disabled={!name.trim() || create.isPending}
              onClick={() => {
                setCreateError(null);
                create.mutate({ name: name.trim(), template });
              }}
            >
              {create.isPending ? "Creating…" : "Create workspace"}
            </Button>
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTemplate(t.id)}
                className={cn(
                  "rounded-lg border p-2.5 text-left transition-colors",
                  template === t.id
                    ? "border-primary bg-accent/60"
                    : "border-border hover:border-primary/40",
                )}
              >
                <div className="text-[12px] font-medium">{t.label}</div>
                <div className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                  {t.blurb}
                </div>
              </button>
            ))}
          </div>

          {createError ? (
            <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[12px] text-destructive">
              {createError}
            </p>
          ) : null}
        </section>

        {/* list */}
        {list.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <div key={i} className="panel h-32 animate-pulse p-4">
                <div className="h-3 w-32 rounded bg-muted" />
                <div className="mt-3 h-3 w-48 rounded bg-muted" />
              </div>
            ))}
          </div>
        ) : list.isError ? (
          <div className="panel border-destructive/40 p-4 text-[13px] text-destructive">
            Could not load workspaces: {list.error.message}
          </div>
        ) : !list.data?.length ? (
          <div className="panel flex flex-col items-center gap-2 border-dashed px-6 py-12 text-center">
            <h3 className="text-[var(--text-base)] font-semibold">No workspaces yet</h3>
            <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
              A workspace is where a training run actually happens — source files, data, and the
              artifacts a run produces. Create one above to get a file tree, editor, console and
              preview server.
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {list.data.map((w) => (
              <article key={w.id} className="panel flex flex-col p-4">
                <div className="flex items-start gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-[14px] font-semibold">{w.name}</h3>
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                      {w.slug}
                    </p>
                  </div>
                  <span className="ml-auto shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {w.template}
                  </span>
                </div>

                <div className="tabular mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{w.fileCount} files</span>
                  <span>{w.runCount} runs</span>
                  <span>updated {new Date(w.updatedAt).toLocaleDateString()}</span>
                </div>

                <div className="mt-4 flex items-center gap-2">
                  <Button asChild size="sm">
                    <Link to={`/workspaces/${w.id}`}>Open IDE</Link>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate({ id: w.id })}
                  >
                    Delete
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
