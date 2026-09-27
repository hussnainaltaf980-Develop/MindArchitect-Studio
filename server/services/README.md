# server/services/ — AGENT-OWNED business integrations

Write external-integration logic here (call third-party APIs, send email, run
AI, schedule jobs), then call it from `server/routers.ts` procedures. Keep
routers thin — one procedure → one service call.

**Always compose the `_core` integration primitives; never reach around them:**

- `_core/fetch` → `outboundFetch(url, { timeoutMs })` for outbound HTTP.
  (Dev-convenience wrapper, not a security boundary — see the file header.)
- `_core/email` → `sendEmail({ to, subject, html })` (platform-mediated).
- `_core/llm`   → `complete({ system, prompt })` (metered to the owner).
- `_core/jobs`  → `registerJob(name, handler)` (runs in this app's runtime).
- `_core/storage` → `storagePutUrl(relKey)` for user uploads.

Secrets (external API keys) come from env injected by the platform — never
hardcode them. Do not edit anything under `server/_core/`.
