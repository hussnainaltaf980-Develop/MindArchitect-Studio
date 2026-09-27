// Small id helper. Kept out of lib/utils.ts (which the scaffold's own test
// covers) so the ported Studio adds a module rather than editing a tested one.
let counter = 0;

export function uid(prefix = "id"): string {
  counter += 1;
  const rand =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${rand}`;
}
