import { useMemo } from "react";

export interface Point {
  step: number;
  loss: number;
}

export interface LossChartProps {
  train: Point[];
  validation: Point[];
  /** The tokenizer's random-guess floor, drawn so a loss is never read against
   *  an implied baseline. */
  floor?: number | null;
  /** The step whose validation loss was best — where early stopping restored. */
  bestStep?: number | null;
  height?: number;
  testLoss?: number | null;
}

/**
 * Inline SVG loss chart — no chart library.
 *
 * Two deliberate choices:
 *
 *  * The random-guess floor is drawn as a labelled line. The whole point of the
 *    exercise was that a loss of 10.37 looked like progress while being exactly
 *    what an untrained model scores, so the baseline is part of the chart rather
 *    than something the reader is expected to remember.
 *  * Train and val are drawn from ONE shared scale. Two independent y-axes make
 *    an overfitting run look healthy, which is precisely the mistake this chart
 *    exists to prevent.
 */
export function LossChart({
  train,
  validation,
  floor,
  bestStep,
  height = 200,
  testLoss,
}: LossChartProps) {
  const W = 720;
  const H = height;
  const PAD = { l: 52, r: 14, t: 14, b: 26 };

  const { yOf, xticks, yticks, trainPath, valPath, bestX, points } = useMemo(() => {
    const all = [...train, ...validation].filter((p) => Number.isFinite(p.loss));
    const steps = all.map((p) => p.step);
    const losses = all.map((p) => p.loss);
    if (floor != null) losses.push(floor);
    if (testLoss != null) losses.push(testLoss);

    const maxStep = Math.max(1, ...steps);
    const minStep = Math.min(0, ...steps);
    let lo = Math.min(...losses);
    let hi = Math.max(...losses);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 1;
    }
    const padY = (hi - lo) * 0.08 || 0.5;
    lo = Math.max(0, lo - padY);
    hi = hi + padY;

    const xOf = (s: number) =>
      PAD.l + ((s - minStep) / Math.max(1, maxStep - minStep)) * (W - PAD.l - PAD.r);
    const yOf = (l: number) => PAD.t + (1 - (l - lo) / Math.max(1e-9, hi - lo)) * (H - PAD.t - PAD.b);

    const path = (pts: Point[]) =>
      pts
        .filter((p) => Number.isFinite(p.loss))
        .map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.step).toFixed(1)},${yOf(p.loss).toFixed(1)}`)
        .join(" ");

    const nX = 5;
    const xticks = Array.from({ length: nX + 1 }, (_, i) => {
      const s = minStep + ((maxStep - minStep) * i) / nX;
      return { s: Math.round(s), x: xOf(s) };
    });
    const nY = 4;
    const yticks = Array.from({ length: nY + 1 }, (_, i) => {
      const l = lo + ((hi - lo) * i) / nY;
      return { l, y: yOf(l) };
    });

    return {
      xOf,
      yOf,
      xticks,
      yticks,
      trainPath: path(train),
      valPath: path(validation),
      bestX: bestStep != null ? xOf(bestStep) : null,
      points: { validation, xOf, yOf },
    };
  }, [train, validation, floor, bestStep, testLoss, H]);

  const empty = train.length === 0 && validation.length === 0;

  if (empty) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center"
        style={{ height }}
      >
        <p className="text-[13px] font-medium text-foreground">No metrics recorded yet</p>
        <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
          A loss curve appears here once a run records its first steps. Start a run from the
          Runs panel, or attach metrics to an existing run to compare a schedule against the
          random-guess floor.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label="Training and validation loss by step"
        data-testid="loss-chart"
      >
        {yticks.map((t) => (
          <g key={`y${t.y}`}>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={t.y}
              y2={t.y}
              stroke="currentColor"
              className="text-border"
              strokeWidth={1}
              strokeDasharray={t.l === 0 ? undefined : "2 4"}
            />
            <text
              x={PAD.l - 8}
              y={t.y + 3}
              textAnchor="end"
              className="fill-muted-foreground"
              style={{ fontSize: 10, fontVariantNumeric: "tabular-nums" }}
            >
              {t.l.toFixed(2)}
            </text>
          </g>
        ))}
        {xticks.map((t) => (
          <text
            key={`x${t.x}`}
            x={t.x}
            y={H - 8}
            textAnchor="middle"
            className="fill-muted-foreground"
            style={{ fontSize: 10, fontVariantNumeric: "tabular-nums" }}
          >
            {t.s}
          </text>
        ))}

        {floor != null ? (
          <>
            <line
              x1={PAD.l}
              x2={W - PAD.r}
              y1={yOf(floor)}
              y2={yOf(floor)}
              stroke="currentColor"
              className="text-destructive"
              strokeWidth={1.5}
              strokeDasharray="6 3"
            />
            <text
              x={W - PAD.r - 4}
              y={yOf(floor) - 5}
              textAnchor="end"
              className="fill-destructive"
              style={{ fontSize: 10, fontWeight: 600 }}
            >
              random-guess floor {floor.toFixed(2)} (ln 32,004)
            </text>
          </>
        ) : null}

        {trainPath ? (
          <path d={trainPath} fill="none" stroke="currentColor" className="text-primary" strokeWidth={2} />
        ) : null}
        {valPath ? (
          <path
            d={valPath}
            fill="none"
            stroke="currentColor"
            className="text-warning"
            strokeWidth={2}
            strokeDasharray="5 3"
          />
        ) : null}

        {points.validation.map((p) => (
          <circle
            key={`vp${p.step}`}
            cx={points.xOf(p.step)}
            cy={points.yOf(p.loss)}
            r={2.5}
            className="fill-warning"
          />
        ))}

        {bestX != null ? (
          <>
            <line
              x1={bestX}
              x2={bestX}
              y1={PAD.t}
              y2={H - PAD.b}
              stroke="currentColor"
              className="text-success"
              strokeWidth={1.5}
            />
            <text
              x={bestX + 4}
              y={PAD.t + 10}
              className="fill-success"
              style={{ fontSize: 10, fontWeight: 600 }}
            >
              best val · step {bestStep} · weights kept
            </text>
          </>
        ) : null}
      </svg>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-primary" /> train loss
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-warning" style={{ borderTop: "2px dashed" }} />{" "}
          held-out validation
        </span>
        {floor != null ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded bg-destructive" /> random-guess floor
          </span>
        ) : null}
        {testLoss != null ? (
          <span className="tabular ml-auto">held-out test {testLoss.toFixed(4)}</span>
        ) : null}
      </div>
    </div>
  );
}
