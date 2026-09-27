import { useCallback, useEffect, useState } from "react";
import { FlaskConical, Play, ShieldCheck, LoaderCircle } from "lucide-react";
import { labRun, labStatus, type LabStatus } from "@/lib/studio-api";

// Forge Lab. Reads the real training plane: the dataset row count and the last
// train/eval/synth results as recorded on disk, not invented numbers.
export function LabPanel() {
  const [status, setStatus] = useState<LabStatus | null>(null);
  const [log, setLog] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void labStatus()
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (kind: "synthesize" | "train" | "eval") => {
    setBusy(kind);
    setError(null);
    try {
      const res = await labRun(kind);
      setLog(res.log ?? JSON.stringify(res.result ?? {}, null, 2));
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lab run failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto h-full max-w-3xl overflow-y-auto scroll-thin px-4 py-8 sm:px-8">
      <div className="flex items-center gap-2">
        <FlaskConical className="size-5 text-signal" />
        <h2 className="font-display text-xl font-medium text-fg">Forge Lab</h2>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        OSS-Instruct / Evol-Instruct on the training plane. Every pair is executed before it
        enters the dataset — crashing code is discarded. The student is the native Forge Smoke
        decoder (vocab 32,004), not a 7B download.
      </p>

      <dl className="mt-6 grid grid-cols-3 gap-2">
        <Stat label="Verified pairs" value={status?.verified_rows ?? "—"} />
        <Stat
          label="Last eval pass"
          value={
            typeof status?.last_eval?.pass_rate === "number"
              ? `${Math.round(Number(status.last_eval.pass_rate) * 100)}%`
              : "—"
          }
        />
        <Stat
          label="Teacher calls"
          value={
            typeof status?.last_synth?.teacher_calls === "number"
              ? String(status.last_synth.teacher_calls)
              : "0"
          }
        />
      </dl>

      <div className="mt-6 grid gap-2 sm:grid-cols-3">
        {(
          [
            ["synthesize", "Generate + validate", Play],
            ["train", "Fine-tune Smoke", FlaskConical],
            ["eval", "Run exec eval", ShieldCheck],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            disabled={busy !== null}
            onClick={() => void run(id)}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-chrome px-3 text-sm font-medium text-bg disabled:opacity-40"
          >
            {busy === id ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Icon className="size-4" />
            )}
            {label}
          </button>
        ))}
      </div>
      {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}

      <ol className="mt-8 space-y-3 text-sm text-chrome">
        <li>
          <span className="font-medium text-fg">1. Seed + Evol.</span> Architecture seeds
          (chunking, RLS predicates, GQA repeat, ToT prune). Evol adds typing and validation
          constraints.
        </li>
        <li>
          <span className="font-medium text-fg">2. Execution gate.</span> Run the solution
          against its assertions. Failures never enter the dataset.
        </li>
        <li>
          <span className="font-medium text-fg">3. SFT.</span> Native decoder, vocab 32,004,
          writes a full state_dict — all 57 tensors.
        </li>
        <li>
          <span className="font-medium text-fg">4. Score.</span> Pass rate is the dataset gate:
          the number that matters before you scale teacher spend.
        </li>
      </ol>

      {log ? (
        <pre className="mt-6 overflow-x-auto rounded-lg border border-line bg-inset p-3 font-mono text-[11px] leading-relaxed text-muted">
          {log}
        </pre>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-3">
      <dt className="text-[11px] uppercase tracking-wider text-subtle">{label}</dt>
      <dd className="tabular mt-1 font-display text-2xl text-fg">{value}</dd>
    </div>
  );
}
