// Background / scheduled jobs (DESIGN §5.1.2 / §8.4).
//
// TRUST MODEL: the job BODY only ever runs inside THIS app's own runtime. The
// platform stores just (app, name, schedule) and fires a signed HTTP callback
// to POST /api/_jobs/{name} on schedule — untrusted app code NEVER runs on
// shared platform infra. Registration below just maps a name → handler; the
// callback route in _core/index.ts verifies the platform signature and invokes
// the handler. Platform-side scheduling/quota lands in a later milestone (§8.4).
export type JobHandler = () => Promise<void>;

const registry = new Map<string, JobHandler>();

/** Register a job handler. Also declare its schedule with the platform (later). */
export function registerJob(name: string, handler: JobHandler): void {
  registry.set(name, handler);
}

export function getJob(name: string): JobHandler | undefined {
  return registry.get(name);
}
