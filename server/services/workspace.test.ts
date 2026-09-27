import { describe, expect, it } from "vitest";
import { languageFor, seedFilesFor, TEMPLATES, DEFAULT_TEMPLATE } from "./workspace-seed";
import { computeLossDelta, neverBeatRandomFloor, RANDOM_GUESS_FLOOR } from "./metrics";

describe("seedFilesFor", () => {
  it("seeds a non-empty tree for the default template", () => {
    const files = seedFilesFor(DEFAULT_TEMPLATE);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.path.length).toBeGreaterThan(0);
      expect(f.content.length).toBeGreaterThan(0);
    }
  });

  it("includes the model source and a training script, since those are the real subject", () => {
    const paths = seedFilesFor(DEFAULT_TEMPLATE).map((f) => f.path);
    expect(paths.some((p) => p.endsWith("modeling_mindarchitect.py"))).toBe(true);
    expect(paths.some((p) => p.includes("train"))).toBe(true);
  });

  it("never emits an absolute or traversal path", () => {
    for (const key of Object.keys(TEMPLATES)) {
      for (const f of seedFilesFor(key)) {
        expect(f.path.startsWith("/"), `${key}: ${f.path}`).toBe(false);
        expect(f.path.includes(".."), `${key}: ${f.path}`).toBe(false);
      }
    }
  });

  it("returns an array rather than throwing for an unknown template", () => {
    expect(Array.isArray(seedFilesFor("does-not-exist"))).toBe(true);
  });
});

describe("languageFor", () => {
  it("maps the extensions the seeded tree actually uses", () => {
    expect(languageFor("modeling_mindarchitect.py")).toBe("python");
    expect(languageFor("client/src/main.tsx")).toBe("typescript");
    expect(languageFor("checkpoint_meta.json")).toBe("json");
    expect(languageFor("README.md")).toBe("markdown");
    expect(languageFor("deploy_gpu.sh")).toBe("shell");
  });

  it("falls back to plaintext for anything unrecognised", () => {
    expect(languageFor("LICENSE")).toBe("plaintext");
    expect(languageFor("weights.npz")).toBe("plaintext");
  });
});

describe("computeLossDelta", () => {
  it("is negative when the loss improves", () => {
    expect(computeLossDelta(10.3595, 0.0057)).toBeCloseTo(-10.3538, 3);
  });

  // The regression that motivated this helper: the original metadata reported
  // -0.0606 for a run whose loss ROSE from 10.5055 to 10.5661.
  it("is POSITIVE when the loss regresses — never silently an improvement", () => {
    expect(computeLossDelta(10.5055, 10.5661)).toBeCloseTo(0.0606, 3);
    expect(computeLossDelta(10.5055, 10.5661)).toBeGreaterThan(0);
  });

  it("is zero when nothing changed", () => {
    expect(computeLossDelta(5, 5)).toBe(0);
  });
});

describe("neverBeatRandomFloor", () => {
  it("flags a run that never beat an untrained model", () => {
    // The original 300-step run's best train loss, against ln(32004).
    expect(neverBeatRandomFloor(10.5055)).toBe(true);
  });

  it("does not flag a run that clearly trained", () => {
    expect(neverBeatRandomFloor(0.0057)).toBe(false);
  });

  it("uses ln(32004) as the default floor", () => {
    expect(RANDOM_GUESS_FLOOR).toBeCloseTo(10.3736, 3);
  });
});
