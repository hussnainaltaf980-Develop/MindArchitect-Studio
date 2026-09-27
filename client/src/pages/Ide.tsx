import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "wouter";
import { trpc } from "@/_core/trpc";
import { Button } from "@/components/ui/button";
import { FileTree, type FileEntry } from "@/components/FileTree";
import { CodeEditor } from "@/components/CodeEditor";
import { LossChart } from "@/components/LossChart";
import { DeviceBadge } from "@/components/DeviceBadge";
import { escapeHtml } from "@/lib/escape";
import { cn } from "@/lib/utils";

type RailTab = "console" | "metrics" | "preview" | "runs" | "deps";

interface ConsoleLine {
  kind: "in" | "out" | "err" | "info";
  text: string;
}

export default function Ide() {
  const params = useParams<{ id: string }>();
  const workspaceId = params.id ?? "";
  const utils = trpc.useUtils();

  const workspace = trpc.workspaces.get.useQuery({ id: workspaceId }, { enabled: Boolean(workspaceId) });
  const filesQuery = trpc.workspaces.files.useQuery(
    { workspaceId },
    { enabled: Boolean(workspaceId) },
  );
  const device = trpc.device.info.useQuery();
  const sessions = trpc.sessions.list.useQuery({ workspaceId }, { enabled: Boolean(workspaceId) });
  const runs = trpc.runs.list.useQuery({ workspaceId }, { enabled: Boolean(workspaceId) });
  const deps = trpc.deps.list.useQuery({ workspaceId }, { enabled: Boolean(workspaceId) });

  const [openPaths, setOpenPaths] = useState<string[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [rail, setRail] = useState<RailTab>("console");
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([
    { kind: "info", text: "MindArchitect Studio console — type `help` for commands." },
  ]);
  const [command, setCommand] = useState("");
  const consoleEnd = useRef<HTMLDivElement | null>(null);

  const files: FileEntry[] = useMemo(
    () => (filesQuery.data ?? []).map((f) => ({ ...f, updatedAt: String(f.updatedAt) })),
    [filesQuery.data],
  );

  const fileQuery = trpc.workspaces.readFile.useQuery(
    { workspaceId, path: activePath ?? "" },
    { enabled: Boolean(workspaceId && activePath) },
  );

  // Adopt the server's copy whenever the active file finishes loading. Keyed on
  // the file's updatedAt so a later save (which bumps it) re-syncs, while a
  // local keystroke — which does not change updatedAt — is left alone.
  useEffect(() => {
    if (!fileQuery.data || !activePath) return;
    const serverText = fileQuery.data.content;
    const stamp = String(fileQuery.data.updatedAt);
    setSaved((s) => (s[activePath] === stamp ? s : { ...s, [activePath]: stamp }));
    setDrafts((d) => (d[activePath] === serverText ? d : { ...d, [activePath]: serverText }));
  }, [fileQuery.data, activePath]);

  // Auto-select the most interesting file on first load, so the editor is never
  // an empty well the user has to dig out of.
  useEffect(() => {
    if (activePath || files.length === 0) return;
    const preferred =
      files.find((f) => f.path.endsWith("modeling_mindarchitect.py")) ??
      files.find((f) => f.path.endsWith("configuration_mindarchitect.py")) ??
      files.find((f) => f.path.endsWith(".py")) ??
      files[0];
    setActivePath(preferred.path);
    setOpenPaths([preferred.path]);
  }, [files, activePath]);

  useEffect(() => {
    consoleEnd.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleLines]);

  const write = trpc.workspaces.writeFile.useMutation({
    onSuccess: async () => {
      await utils.workspaces.files.invalidate({ workspaceId });
      await utils.workspaces.readFile.invalidate({ workspaceId, path: activePath ?? "" });
    },
  });

  const startSession = trpc.sessions.start.useMutation({
    onSuccess: async () => {
      await utils.sessions.list.invalidate({ workspaceId });
    },
  });
  const stopSession = trpc.sessions.stop.useMutation({
    onSuccess: async () => {
      await utils.sessions.list.invalidate({ workspaceId });
    },
  });
  const checkDeps = trpc.deps.check.useMutation({
    onSuccess: async () => {
      await utils.deps.list.invalidate({ workspaceId });
    },
  });
  const createRun = trpc.runs.create.useMutation({
    onSuccess: async (r) => {
      await utils.runs.list.invalidate({ workspaceId });
      setSelectedRunId(r.id);
      setRail("metrics");
    },
  });
  const deleteRun = trpc.runs.remove.useMutation({
    onSuccess: async () => {
      await utils.runs.list.invalidate({ workspaceId });
      setSelectedRunId(null);
    },
  });
  const appendMetrics = trpc.runs.appendMetrics.useMutation();
  const finishRun = trpc.runs.finish.useMutation({
    onSuccess: async () => {
      await utils.runs.list.invalidate({ workspaceId });
    },
  });

  const runDetail = trpc.runs.get.useQuery(
    { id: selectedRunId ?? "" },
    { enabled: Boolean(selectedRunId) },
  );

  const current = activePath ? (drafts[activePath] ?? "") : "";
  const dirty = activePath != null && current !== (saved[activePath] ?? "__none__") && Boolean(activePath);
  const language =
    files.find((f) => f.path === activePath)?.language ?? "python";

  const doSave = useCallback(async () => {
    if (!activePath) return;
    await write.mutateAsync({
      workspaceId,
      path: activePath,
      content: current,
      language,
      // Send the server's version, not ours: that is what makes a concurrent
      // edit surface as a CONFLICT instead of silently losing one side.
      expectedUpdatedAt: saved[activePath] ?? null,
    });
  }, [activePath, current, language, saved, workspaceId, write]);

  // Cmd/Ctrl+S saves. Bound on the window so the editor does not need to
  // forward key events out of the CDN iframe.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirty) void doSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, doSave]);

  const running = sessions.data?.find((s) => s.status === "running") ?? null;

  const pushLines = (...lines: ConsoleLine[]) => setConsoleLines((prev) => [...prev, ...lines]);

  /** Record the workspace's real training results as a run. */
  const importRecordedRun = useCallback(async () => {
    pushLines({ kind: "info", text: "importing recorded smoke run…" });
    try {
      const res = await fetch("/recorded-smoke-run.json");
      if (!res.ok) throw new Error(`fixture unavailable (${res.status})`);
      const data = (await res.json()) as {
        name: string;
        maxSteps: number;
        floor: number;
        initialLoss: number;
        finalLoss: number;
        bestValLoss: number;
        bestValStep: number;
        testLoss: number;
        stoppedEarly: boolean;
        notes: string;
        train: { step: number; loss: number; lr?: number }[];
        validation: { step: number; loss: number }[];
      };
      const run = await createRun.mutateAsync({
        workspaceId,
        name: data.name,
        kind: "train",
        maxSteps: data.maxSteps,
      });
      await appendMetrics.mutateAsync({
        runId: run.id,
        rows: [
          ...data.train.map((t) => ({
            step: t.step,
            split: "train" as const,
            loss: t.loss,
            lr: t.lr ?? null,
          })),
          ...data.validation.map((v) => ({
            step: v.step,
            split: "validation" as const,
            loss: v.loss,
          })),
        ],
      });
      await finishRun.mutateAsync({
        id: run.id,
        status: data.stoppedEarly ? "stopped" : "completed",
        completedSteps: data.maxSteps,
        initialLoss: data.initialLoss,
        finalLoss: data.finalLoss,
        bestValLoss: data.bestValLoss,
        bestValStep: data.bestValStep,
        testLoss: data.testLoss,
        stoppedEarly: data.stoppedEarly,
        notes: data.notes,
      });
      pushLines(
        { kind: "out", text: `run recorded: ${data.name}` },
        { kind: "out", text: `steps=${data.maxSteps} final_train=${data.finalLoss.toFixed(4)}` },
        {
          kind: "out",
          text: `best_val=${data.bestValLoss.toFixed(4)} @ step ${data.bestValStep} · test=${data.testLoss.toFixed(4)}`,
        },
      );
    } catch (e) {
      pushLines({ kind: "err", text: `import failed: ${(e as Error).message}` });
    }
  }, [appendMetrics, createRun, finishRun, workspaceId]);

  const runCommand = useCallback(
    async (raw: string) => {
      const cmd = raw.trim();
      if (!cmd) return;
      pushLines({ kind: "in", text: `$ ${cmd}` });
      const [head, ...rest] = cmd.split(/\s+/);
      switch (head) {
        case "help":
          pushLines(
            { kind: "info", text: "available commands:" },
            { kind: "out", text: "  help                     this list" },
            { kind: "out", text: "  device                   probe this environment" },
            { kind: "out", text: "  files                    list workspace files" },
            { kind: "out", text: "  runs                     list recorded runs" },
            { kind: "out", text: "  import smoke-run         record the completed 200-step run" },
            { kind: "out", text: "  session start|stop       start or stop the workspace session" },
            { kind: "out", text: "  deps check               re-run the dependency preflight" },
            { kind: "out", text: "  clear                    clear this console" },
          );
          break;
        case "device":
          if (device.data) {
            pushLines(
              { kind: "out", text: `runtime   : ${device.data.runtime}` },
              { kind: "out", text: `cudaReady : ${device.data.cudaReady}` },
              { kind: "out", text: `summary   : ${device.data.summary}` },
              ...device.data.evidence.map((e) => ({ kind: "info" as const, text: `  · ${e}` })),
            );
          }
          break;
        case "files":
          pushLines(...files.map((f) => ({ kind: "out" as const, text: `  ${f.path}` })));
          break;
        case "runs":
          if (!runs.data?.length) pushLines({ kind: "info", text: "no runs recorded yet" });
          else
            pushLines(
              ...runs.data.map((r) => ({
                kind: "out" as const,
                text: `  ${r.name} [${r.status}] steps=${r.completedSteps}/${r.maxSteps ?? "?"} bestVal=${r.bestValLoss?.toFixed(4) ?? "—"}`,
              })),
            );
          break;
        case "import":
          if (rest[0] === "smoke-run") await importRecordedRun();
          else pushLines({ kind: "err", text: "usage: import smoke-run" });
          break;
        case "session":
          if (rest[0] === "start") {
            await startSession.mutateAsync({ workspaceId });
            pushLines({ kind: "out", text: "session started" });
          } else if (rest[0] === "stop") {
            if (running) await stopSession.mutateAsync({ id: running.id });
            pushLines({ kind: "out", text: "session stopped" });
          } else pushLines({ kind: "err", text: "usage: session start|stop" });
          break;
        case "deps":
          if (rest[0] === "check") {
            const rows = await checkDeps.mutateAsync({ workspaceId });
            pushLines(
              ...rows.map((r) => ({
                kind: (r.status === "missing" ? "err" : "out") as "err" | "out",
                text: `  ${r.name.padEnd(14)} ${r.versionReq.padEnd(16)} ${r.status}`,
              })),
            );
          } else pushLines({ kind: "err", text: "usage: deps check" });
          break;
        case "clear":
          setConsoleLines([]);
          break;
        default:
          pushLines({
            kind: "err",
            text: `unknown command: ${head} — type \`help\``,
          });
      }
    },
    [
      checkDeps,
      device.data,
      files,
      importRecordedRun,
      running,
      runs.data,
      startSession,
      stopSession,
      workspaceId,
    ],
  );

  const closeTab = (path: string) => {
    setOpenPaths((prev) => prev.filter((p) => p !== path));
    if (activePath === path) {
      const next = openPaths.filter((p) => p !== path);
      setActivePath(next.length ? next[next.length - 1] : null);
    }
  };

  const metrics = runDetail.data?.metrics ?? [];
  const trainPoints = metrics
    .filter((m) => m.split === "train" && m.loss != null)
    .map((m) => ({ step: m.step, loss: m.loss as number }));
  const valPoints = metrics
    .filter((m) => m.split === "validation" && m.loss != null)
    .map((m) => ({ step: m.step, loss: m.loss as number }));

  const railTabs: { id: RailTab; label: string; badge?: string | number }[] = [
    { id: "console", label: "Console" },
    { id: "metrics", label: "Metrics" },
    { id: "preview", label: "Preview" },
    { id: "runs", label: "Runs", badge: runs.data?.length ?? 0 },
    { id: "deps", label: "Env", badge: deps.data?.length ?? 0 },
  ];

  // Default to the newest run so the metrics panel opens on real data rather
  // than the empty state. The dropdown still overrides this.
  useEffect(() => {
    if (!selectedRunId && runs.data && runs.data.length > 0) {
      setSelectedRunId(runs.data[0].id);
    }
  }, [runs.data, selectedRunId]);

  if (workspace.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-[13px] text-muted-foreground">
        Loading workspace…
      </div>
    );
  }

  if (workspace.isError || !workspace.data) {
    return (
      <div className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-3 p-8 text-center">
        <h1 className="text-[var(--text-lg)] font-semibold">Workspace not available</h1>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          This workspace does not exist, or it belongs to another account. Workspaces are
          private to their owner.
        </p>
        <Button asChild size="sm">
          <Link to="/workspaces">Back to workspaces</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      {/* ── top bar ─────────────────────────────────────────────────────── */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-3 py-2">
        <Link
          to="/workspaces"
          className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground hover:text-foreground"
        >
          ← workspaces
        </Link>
        <span className="text-border">/</span>
        <h1 className="truncate text-[13px] font-semibold">{workspace.data.name}</h1>
        <span className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {workspace.data.slug}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <DeviceBadge
            runtime={device.data?.runtime ?? workspace.data.runtime}
            gpuName={device.data?.gpuName}
            cpuCount={device.data?.cpuCount}
            memoryCapMb={device.data?.memoryCapMb}
            showDetail
          />
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium",
              running
                ? "border-primary/50 bg-primary/10 text-primary"
                : "border-border bg-muted text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                running ? "animate-pulse bg-primary" : "bg-muted-foreground/50",
              )}
              aria-hidden
            />
            {running ? "session running" : "session stopped"}
          </span>
        </div>
      </header>

      {/* ── body ────────────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1">
        {/* left: file tree */}
        <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-card">
          <div className="panel-header">
            <span className="panel-title">Explorer</span>
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              {workspace.data.template}
            </span>
          </div>
          <FileTree
            files={files}
            activePath={activePath}
            dirtyPaths={new Set(dirty && activePath ? [activePath] : [])}
            onOpen={(p) => {
              setActivePath(p);
              setOpenPaths((prev) => (prev.includes(p) ? prev : [...prev, p]));
            }}
            onCreate={async (p) => {
              await write.mutateAsync({ workspaceId, path: p, content: "", language: "python" });
              setActivePath(p);
              setOpenPaths((prev) => [...prev, p]);
            }}
          />
        </aside>

        {/* centre: editor */}
        <main className="flex min-w-0 flex-1 flex-col bg-editor-bg">
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-1 py-1">
            {openPaths.length === 0 ? (
              <span className="px-2 py-1 text-[11px] text-muted-foreground">
                No file open — pick one from the explorer.
              </span>
            ) : (
              openPaths.map((p) => (
                <div
                  key={p}
                  className={cn(
                    "group flex items-center gap-1.5 rounded-t border-b-2 px-2 py-1 text-[12px]",
                    p === activePath
                      ? "border-primary bg-editor-bg text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <button type="button" onClick={() => setActivePath(p)} className="truncate">
                    {p.split("/").pop()}
                  </button>
                  {dirty && p === activePath ? <span className="h-1.5 w-1.5 rounded-full bg-primary" /> : null}
                  <button
                    type="button"
                    onClick={() => closeTab(p)}
                    className="opacity-0 transition-opacity group-hover:opacity-70"
                    aria-label={`Close ${p}`}
                  >
                    ×
                  </button>
                </div>
              ))
            )}
            {activePath ? (
              <div className="ml-auto flex shrink-0 items-center gap-2 pr-2">
                {dirty ? (
                  <span className="text-[11px] text-warning">unsaved</span>
                ) : (
                  <span className="text-[11px] text-muted-foreground">saved</span>
                )}
                <Button size="sm" variant="outline" className="h-6 text-[11px]" disabled={!dirty || write.isPending} onClick={() => void doSave()}>
                  {write.isPending ? "Saving…" : "Save"}
                </Button>
              </div>
            ) : null}
          </div>

          {write.isError ? (
            <div className="border-b border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
              {write.error.message}
            </div>
          ) : null}

          <div className="min-h-0 flex-1">
            {activePath ? (
              fileQuery.isLoading ? (
                <div className="p-4 text-[12px] text-muted-foreground">Loading {activePath}…</div>
              ) : (
                <CodeEditor
                  value={current}
                  language={language}
                  onChange={(next) => setDrafts((d) => ({ ...d, [activePath]: next }))}
                />
              )
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
                <p className="text-[13px] font-medium text-editor-fg">No file open</p>
                <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">
                  Select a file in the explorer to edit it. Changes are saved with{" "}
                  <kbd className="rounded border border-border px-1 font-mono text-[10px]">⌘S</kbd>{" "}
                  or the Save button.
                </p>
              </div>
            )}
          </div>
        </main>

        {/* right: rail */}
        <aside className="flex w-[420px] shrink-0 flex-col border-l border-border bg-card">
          <div className="flex shrink-0 items-center gap-0.5 border-b border-border px-1 py-1">
            {railTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setRail(t.id)}
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors",
                  rail === t.id
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                data-testid={`rail-${t.id}`}
              >
                {t.label}
                {t.badge ? (
                  <span className="tabular rounded bg-muted px-1 text-[10px]">{t.badge}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1">
            {rail === "console" ? (
              <div className="flex h-full min-h-0 flex-col">
                <div
                  className="scroll-thin min-h-0 flex-1 overflow-y-auto bg-editor-bg p-2 font-mono text-[12px] leading-relaxed"
                  data-testid="console"
                >
                  {consoleLines.map((l, i) => (
                    <div
                      key={i}
                      className={cn(
                        "whitespace-pre-wrap break-words",
                        l.kind === "in" && "text-primary",
                        l.kind === "out" && "text-editor-fg",
                        l.kind === "err" && "text-destructive",
                        l.kind === "info" && "text-muted-foreground",
                      )}
                    >
                      {l.text}
                    </div>
                  ))}
                  {startSession.isPending || checkDeps.isPending || createRun.isPending ? (
                    <div className="text-muted-foreground">working…</div>
                  ) : null}
                  <div ref={consoleEnd} />
                </div>
                <form
                  className="flex shrink-0 items-center gap-2 border-t border-border px-2 py-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const cmd = command;
                    setCommand("");
                    void runCommand(cmd);
                  }}
                >
                  <span className="font-mono text-[12px] text-primary">$</span>
                  <input
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder="help"
                    aria-label="Console command"
                    className="h-7 flex-1 bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground/60"
                  />
                  <Button type="submit" size="sm" variant="outline" className="h-6 text-[11px]">
                    Run
                  </Button>
                </form>
              </div>
            ) : null}

            {rail === "metrics" ? (
              <div className="scroll-thin h-full overflow-y-auto p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="panel-title">Loss curve</span>
                  {runs.data?.length ? (
                    <select
                      value={selectedRunId ?? ""}
                      onChange={(e) => setSelectedRunId(e.target.value || null)}
                      className="rounded border border-border bg-background px-1.5 py-0.5 text-[11px]"
                      aria-label="Select run"
                    >
                      <option value="">select a run…</option>
                      {runs.data.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>

                {!runs.data?.length ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-4">
                    <p className="text-[13px] font-medium">No runs recorded</p>
                    <p className="text-[12px] leading-relaxed text-muted-foreground">
                      Nothing has been trained in this workspace yet. Record the completed
                      200-step smoke run to populate a real curve, including the random-guess
                      floor and the early-stopping point.
                    </p>
                    <Button
                      size="sm"
                      className="mt-1 w-fit"
                      onClick={() => void runCommand("import smoke-run")}
                      disabled={createRun.isPending}
                    >
                      Import recorded run
                    </Button>
                  </div>
                ) : !selectedRunId ? (
                  <p className="text-[12px] text-muted-foreground">
                    Select a run above to plot its loss against the random-guess floor.
                  </p>
                ) : runDetail.isLoading ? (
                  <div className="space-y-2">
                    <div className="h-4 w-40 animate-pulse rounded bg-muted" />
                    <div className="h-48 w-full animate-pulse rounded bg-muted" />
                  </div>
                ) : (
                  <>
                    <LossChart
                      train={trainPoints}
                      validation={valPoints}
                      floor={runDetail.data?.run.randomGuessFloor ?? null}
                      bestStep={runDetail.data?.run.bestValStep ?? null}
                      testLoss={runDetail.data?.run.testLoss ?? null}
                    />
                    <dl className="mt-3 grid grid-cols-2 gap-2">
                      {[
                        ["initial loss", runDetail.data?.run.initialLoss],
                        ["final train loss", runDetail.data?.run.finalLoss],
                        [
                          "best val loss",
                          runDetail.data?.run.bestValLoss != null
                            ? `${(runDetail.data.run.bestValLoss as number).toFixed(4)} @ step ${runDetail.data.run.bestValStep}`
                            : null,
                        ],
                        ["held-out test", runDetail.data?.run.testLoss],
                      ].map(([label, value]) => (
                        <div key={String(label)} className="rounded-md border border-border p-2">
                          <dt className="metric-label">{label}</dt>
                          <dd className="tabular mt-0.5 text-[14px] font-semibold">
                            {value == null
                              ? "—"
                              : typeof value === "number"
                                ? value.toFixed(4)
                                : String(value)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    {runDetail.data?.run.stoppedEarly ? (
                      <p className="mt-3 rounded-md border border-success/40 bg-success/10 p-2 text-[11px] leading-relaxed text-success">
                        Early stopping fired — the saved weights are the best-on-validation
                        snapshot from step {runDetail.data.run.bestValStep}, not the weights at the
                        final step.
                      </p>
                    ) : null}
                    {runDetail.data?.run.notes ? (
                      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                        {runDetail.data.run.notes}
                      </p>
                    ) : null}
                  </>
                )}
              </div>
            ) : null}

            {rail === "preview" ? (
              <div className="flex h-full min-h-0 flex-col">
                <div className="border-b border-border px-3 py-2">
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    The workspace preview server serves the project's generated artifacts over
                    HTTP. Start it from the console with{" "}
                    <code className="rounded bg-muted px-1 font-mono text-[10px]">
                      session start
                    </code>{" "}
                    to attach a live preview URL.
                  </p>
                </div>
                <div className="min-h-0 flex-1 bg-editor-bg">
                  {running ? (
                    <iframe
                      title="Workspace preview"
                      className="h-full w-full border-0 bg-white"
                      srcDoc={`<!doctype html><html><head><meta charset="utf-8"><style>
                        body{font-family:ui-monospace,Menlo,monospace;background:#0b1116;color:#dde5ec;margin:0;padding:24px}
                        h1{font-size:16px;margin:0 0 4px;color:#3ad1e0}
                        p{font-size:12px;color:#93a5b4;margin:4px 0 16px}
                        .row{display:flex;justify-content:space-between;border-bottom:1px solid #1e2a35;padding:7px 0;font-size:12px}
                        .k{color:#7fd4e0}.v{color:#dde5ec;font-variant-numeric:tabular-nums}
                      </style></head><body>
                        <h1>MindArchitect Studio preview server</h1>
                        <p>session #${escapeHtml(running.id.slice(0, 8))} · ${escapeHtml(running.device)} · started ${escapeHtml(new Date(running.startedAt).toLocaleTimeString())}</p>
                        <div class="row"><span class="k">runtime</span><span class="v">${escapeHtml(running.device)}</span></div>
                        <div class="row"><span class="k">gpu</span><span class="v">${escapeHtml(running.gpuName ?? "none detected")}</span></div>
                        <div class="row"><span class="k">vcpu</span><span class="v">${escapeHtml(running.cpuCount ?? "?")}</span></div>
                        <div class="row"><span class="k">memory cap</span><span class="v">${running.memoryCapMb ? escapeHtml((running.memoryCapMb / 1024).toFixed(1) + " GiB") : "?"}</span></div>
                        <div class="row"><span class="k">workspace</span><span class="v">${escapeHtml(workspace.data.slug)}</span></div>
                        <div class="row"><span class="k">files</span><span class="v">${escapeHtml(files.length)}</span></div>
                      </body></html>`}
                    />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                      <p className="text-[13px] font-medium text-editor-fg">Preview server stopped</p>
                      <p className="max-w-xs text-[12px] leading-relaxed text-muted-foreground">
                        No session is running, so there is nothing listening to preview. Start a
                        session to bring the preview up.
                      </p>
                      <Button
                        size="sm"
                        className="mt-1"
                        onClick={() => void runCommand("session start")}
                        disabled={startSession.isPending}
                      >
                        {startSession.isPending ? "Starting…" : "Start session"}
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            {rail === "runs" ? (
              <div className="scroll-thin h-full overflow-y-auto p-3">
                {!runs.data?.length ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-4">
                    <p className="text-[13px] font-medium">No runs yet</p>
                    <p className="text-[12px] leading-relaxed text-muted-foreground">
                      Training and serving runs recorded for this workspace appear here with their
                      step counts, losses and whether early stopping fired.
                    </p>
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {runs.data.map((r) => (
                      <li
                        key={r.id}
                        className="rounded-lg border border-border p-2.5 transition-colors hover:border-primary/40"
                      >
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium">{r.name}</span>
                          <span
                            className={cn(
                              "ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                              r.status === "completed" && "bg-success/15 text-success",
                              r.status === "running" && "bg-primary/15 text-primary",
                              r.status === "stopped" && "bg-warning/15 text-warning",
                              r.status === "failed" && "bg-destructive/15 text-destructive",
                              r.status === "queued" && "bg-muted text-muted-foreground",
                            )}
                          >
                            {r.status}
                          </span>
                        </div>
                        <div className="tabular mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                          <span>
                            steps {r.completedSteps}/{r.maxSteps ?? "—"}
                          </span>
                          {r.finalLoss != null ? <span>train {r.finalLoss.toFixed(4)}</span> : null}
                          {r.bestValLoss != null ? (
                            <span>val {r.bestValLoss.toFixed(4)}</span>
                          ) : null}
                          {r.stoppedEarly ? <span className="text-success">early-stopped</span> : null}
                        </div>
                        <div className="mt-2 flex gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[11px]"
                            onClick={() => {
                              setSelectedRunId(r.id);
                              setRail("metrics");
                            }}
                          >
                            View curve
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 text-[11px] text-muted-foreground hover:text-destructive"
                            onClick={() => deleteRun.mutate({ id: r.id })}
                          >
                            Delete
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}

            {rail === "deps" ? (
              <div className="scroll-thin h-full overflow-y-auto p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="panel-title">Environment preflight</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[11px]"
                    onClick={() => void runCommand("deps check")}
                    disabled={checkDeps.isPending}
                  >
                    {checkDeps.isPending ? "Checking…" : "Re-check"}
                  </Button>
                </div>
                {!deps.data?.length ? (
                  <div className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-4">
                    <p className="text-[13px] font-medium">No preflight recorded</p>
                    <p className="text-[12px] leading-relaxed text-muted-foreground">
                      The project shipped no dependency manifest, which is how an unpinned
                      transformers upgrade broke the training script with nothing to blame. Run
                      the check to record what this environment actually resolves.
                    </p>
                    <Button
                      size="sm"
                      className="mt-1 w-fit"
                      onClick={() => void runCommand("deps check")}
                    >
                      Run preflight
                    </Button>
                  </div>
                ) : (
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="py-1 font-medium">package</th>
                        <th className="py-1 font-medium">required</th>
                        <th className="py-1 font-medium">status</th>
                      </tr>
                    </thead>
                    <tbody className="tabular">
                      {deps.data.map((d) => (
                        <tr key={d.id} className="border-b border-border/50">
                          <td className="py-1.5 font-mono">{d.name}</td>
                          <td className="py-1.5 text-muted-foreground">{d.versionReq}</td>
                          <td className="py-1.5">
                            <span
                              className={cn(
                                "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase",
                                d.status === "installed" && "bg-success/15 text-success",
                                d.status === "missing" && "bg-destructive/15 text-destructive",
                                d.status === "outdated" && "bg-warning/15 text-warning",
                                d.status === "unknown" && "bg-muted text-muted-foreground",
                              )}
                            >
                              {d.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : null}
          </div>
        </aside>
      </div>

      {/* ── status bar ──────────────────────────────────────────────────── */}
      <footer className="tabular flex shrink-0 items-center gap-4 border-t border-border bg-card px-3 py-1 text-[11px] text-muted-foreground">
        <span className="font-mono">{activePath ?? "no file"}</span>
        <span>{dirty ? "modified" : "clean"}</span>
        <span className="ml-auto">{files.length} files</span>
        <span>{openPaths.length} open</span>
        <span>{device.data ? `${device.data.cpuCount ?? "?"} vCPU` : "…"}</span>
        <span>{device.data?.cudaReady ? "CUDA ready" : "CPU fallback"}</span>
      </footer>
    </div>
  );
}
