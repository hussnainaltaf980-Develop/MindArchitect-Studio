import { describe, expect, it } from "vitest";
import { cn } from "./utils";

// Smoke test for the scaffold's one shared UI util. Its real job is to prove
// `pnpm test` (verify signal #2 in AGENT.md) is wired and green on a fresh
// scaffold, before the agent has written any business tests.
describe("cn", () => {
  it("joins class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("drops falsy/conditional input", () => {
    expect(cn("a", false && "b", undefined, "c")).toBe("a c");
  });

  it("lets the later Tailwind class win (tailwind-merge, not plain concat)", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });
});
