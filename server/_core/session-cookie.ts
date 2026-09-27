import type { Context } from "hono";

const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

/**
 * Host suffixes whose public URL is always HTTPS (host-router / published apps).
 *
 * One entry per PLATFORM ROOT DOMAIN, not per product: the same template is
 * published under teamily (teamily.run) and coai (chainopera.run), and an app
 * cannot know at build time which one it will be served on. A root missing here
 * is not a hard failure — `requestIsSecure` has weaker fallbacks — but a first
 * navigation carrying no Origin/Referer would then plant a Lax, unpartitioned
 * cookie, which breaks the session the moment the app is embedded in an iframe.
 *
 * ONE ENTRY PER ROOT ALSO MEANS ONE PER ROOT, NOT ONE PER DEPTH. `endsWith`
 * already spans every level, so `.teamily.run` covers all four host shapes the
 * platform serves — `{slug}.teamily.run`, `{sbx}.preview.teamily.run`,
 * `{slug}.test.teamily.run`, `{sbx}.preview.test.teamily.run`. This list used to
 * spell out `.preview.test.…` and `.preview.…` beside the bare domain; both were
 * redundant, and they implied a new entry is needed per depth — which is how one
 * gets forgotten when a level is added.
 *
 * Negative cases still fail correctly because the leading dot is part of the
 * suffix: `evil.teamily.run.example.com` and `notteamily.run` both miss.
 */
const HTTPS_HOST_SUFFIXES = [
  ".teamily.run",
  ".chainopera.run",
  // Retired apps roots, kept while anything may still answer on them:
  // chainopera.io still resolves; teamily.site is under a registry serverHold.
  ".chainopera.io",
] as const;

export type SessionCookieOptions = {
  httpOnly: true;
  path: "/";
  maxAge: number;
  sameSite: "None" | "Lax";
  secure: boolean;
  partitioned?: true;
};

/** HTTPS 种 CHIPS；localhost 仍 Lax。 */
export function sessionCookieOptions(https: boolean): SessionCookieOptions {
  if (https) {
    return {
      httpOnly: true,
      path: "/",
      maxAge: SESSION_MAX_AGE,
      sameSite: "None",
      secure: true,
      partitioned: true, // Hono 会写成 ; Partitioned
    };
  }
  return {
    httpOnly: true,
    path: "/",
    maxAge: SESSION_MAX_AGE,
    sameSite: "Lax",
    secure: false,
  };
}

/**
 * Same-name cookies in different jars are independent: CHIPS, unpartitioned
 * None+Secure, and legacy Lax (with/without Secure). Logout must expire all
 * four or a stale copy in another jar will keep the user signed in.
 */
export function sessionCookieClearOptions(): Array<
  Pick<SessionCookieOptions, "path" | "sameSite" | "secure"> & { partitioned?: true }
> {
  return [
    { path: "/", sameSite: "None", secure: true, partitioned: true },
    { path: "/", sameSite: "None", secure: true },
    { path: "/", sameSite: "Lax", secure: true },
    { path: "/", sameSite: "Lax", secure: false },
  ];
}

/**
 * Whether the *browser* is on HTTPS. Cannot just look at this process's
 * protocol: Vite proxies `/trpc` to `http://localhost`, which would otherwise
 * plant a Lax cookie that the HTTPS preview never sends.
 *
 * Positive signals only, in this order. `x-forwarded-proto: http` is NOT a
 * veto — Vite/host-router often set that while Origin is still https.
 */
export function requestIsSecure(c: Context): boolean {
  if (urlIsHttps(c.req.url)) return true;

  const forwardedHost = firstHop(c.req.header("x-forwarded-host"));
  const host = firstHop(c.req.header("host"));
  if (hostIsHttpsApp(forwardedHost) || hostIsHttpsApp(host)) return true;

  if (firstHop(c.req.header("x-forwarded-proto"))?.toLowerCase() === "https") return true;
  if ((c.req.header("x-forwarded-ssl") ?? "").trim().toLowerCase() === "on") return true;

  if (urlIsHttps(c.req.header("origin")) || urlIsHttps(c.req.header("referer"))) return true;

  return false;
}

function firstHop(raw: string | undefined): string | undefined {
  const hop = raw?.split(",")[0]?.trim();
  return hop || undefined;
}

function hostIsHttpsApp(host: string | undefined): boolean {
  if (!host) return false;
  const hostname = host.split(":")[0]?.trim().toLowerCase() ?? "";
  return HTTPS_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function urlIsHttps(raw: string | undefined): boolean {
  if (!raw || !raw.includes("://")) return false;
  try {
    return new URL(raw).protocol === "https:";
  } catch {
    return false;
  }
}
