// ── AGENT-OWNED: run-metric helpers ─────────────────────────────────────────

/** ln(32004) — the loss an untrained model scores on this vocabulary. */
export const RANDOM_GUESS_FLOOR = Math.log(32004);

/**
 * Loss delta with an explicit sign convention: `final - initial`, so a NEGATIVE
 * value means the loss went DOWN.
 *
 * This exists because the original checkpoint metadata reported `-0.0606` for a
 * run whose loss actually rose from 10.5055 to 10.5661. A sign error in a
 * metadata file is invisible — it reads as an improvement and survives review —
 * so the convention is pinned in one place and asserted in the tests.
 */
export function computeLossDelta(initial: number, final: number): number {
  return final - initial;
}

/** True when the run never produced a loss better than an untrained model's. */
export function neverBeatRandomFloor(bestLoss: number, floor = RANDOM_GUESS_FLOOR): boolean {
  return bestLoss >= floor;
}
