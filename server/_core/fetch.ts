// Controlled outbound HTTP for business `services/`.
//
// SECURITY POSTURE (DESIGN §5.1.2 / §8.1): this is a DEV-CONVENIENCE + coding
// convention (uniform timeout/observability), NOT a security boundary. It runs
// in the app's own (untrusted) process, so nothing here can stop a determined
// caller from using global fetch directly. Real SSRF / metadata-endpoint
// protection is enforced at the NETWORK layer by the platform per deploy stage
// (§8.1) — do not rely on this wrapper for isolation.
export interface OutboundOptions extends RequestInit {
  timeoutMs?: number;
}

export async function outboundFetch(url: string, opts: OutboundOptions = {}): Promise<Response> {
  const { timeoutMs = 10_000, ...init } = opts;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}
