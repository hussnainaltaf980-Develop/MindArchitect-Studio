import { describe, expect, it } from "vitest";
import type { Context } from "hono";
import {
  requestIsSecure,
  sessionCookieClearOptions,
  sessionCookieOptions,
} from "./session-cookie";

function ctx(url: string, headers: Record<string, string> = {}): Context {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    req: {
      url,
      header: (name: string) => lower[name.toLowerCase()],
    },
  } as Context;
}

const LOCAL = "http://localhost:3001/trpc/auth.login";
const PREVIEW_ORIGIN = "https://abc.preview.test.teamily.run";

describe("sessionCookieOptions", () => {
  it("plants CHIPS on HTTPS", () => {
    expect(sessionCookieOptions(true)).toEqual({
      httpOnly: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
      sameSite: "None",
      secure: true,
      partitioned: true,
    });
  });

  it("keeps Lax on localhost HTTP", () => {
    expect(sessionCookieOptions(false)).toEqual({
      httpOnly: true,
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
      sameSite: "Lax",
      secure: false,
    });
  });
});

describe("sessionCookieClearOptions", () => {
  it("covers CHIPS, unpartitioned None, and both Lax jars", () => {
    expect(sessionCookieClearOptions()).toEqual([
      { path: "/", sameSite: "None", secure: true, partitioned: true },
      { path: "/", sameSite: "None", secure: true },
      { path: "/", sameSite: "Lax", secure: true },
      { path: "/", sameSite: "Lax", secure: false },
    ]);
  });
});

describe("requestIsSecure", () => {
  it("trusts an https request URL", () => {
    expect(requestIsSecure(ctx("https://app.teamily.run/trpc"))).toBe(true);
  });

  it("trusts Host / x-forwarded-host on preview and published suffixes", () => {
    expect(requestIsSecure(ctx(LOCAL, { host: "sbx.preview.teamily.run" }))).toBe(true);
    expect(requestIsSecure(ctx(LOCAL, { "x-forwarded-host": "sbx.preview.test.teamily.run" }))).toBe(true);
    expect(requestIsSecure(ctx(LOCAL, { host: "demo.teamily.run:443" }))).toBe(true);
  });

  it("trusts a published host on either product's root domain", () => {
    // A coai app is published on chainopera.io. Without it in the suffix list
    // the app falls back to weaker signals, and a first navigation that carries
    // no Origin/Referer plants a Lax, unpartitioned cookie — which breaks the
    // session as soon as the app is embedded in the Studio iframe.
    expect(requestIsSecure(ctx(LOCAL, { host: "demo.chainopera.io" }))).toBe(true);
    expect(requestIsSecure(ctx(LOCAL, { host: "demo.chainopera.run" }))).toBe(true);
    // 一条后缀跨所有深度：最深的那个形态也必须认
    expect(requestIsSecure(ctx(LOCAL, { host: "sbx.preview.test.chainopera.run" }))).toBe(true);
    expect(requestIsSecure(ctx(LOCAL, { "x-forwarded-host": "demo.chainopera.io:443" }))).toBe(true);
  });

  it("does not treat a lookalike host as an app origin", () => {
    expect(requestIsSecure(ctx(LOCAL, { host: "evil.teamily.run.example.com" }))).toBe(false);
    expect(requestIsSecure(ctx(LOCAL, { host: "notteamily.run" }))).toBe(false);
    expect(requestIsSecure(ctx(LOCAL, { host: "evil.chainopera.io.example.com" }))).toBe(false);
    expect(requestIsSecure(ctx(LOCAL, { host: "notchainopera.io" }))).toBe(false);
  });

  it("treats x-forwarded-proto: https as positive", () => {
    expect(requestIsSecure(ctx(LOCAL, { "x-forwarded-proto": "https" }))).toBe(true);
    expect(requestIsSecure(ctx(LOCAL, { "x-forwarded-proto": "https,http" }))).toBe(true);
  });

  it("does not let x-forwarded-proto: http veto a later https Origin", () => {
    expect(
      requestIsSecure(
        ctx(LOCAL, {
          "x-forwarded-proto": "http",
          origin: PREVIEW_ORIGIN,
        }),
      ),
    ).toBe(true);
  });

  it("trusts x-forwarded-ssl: on", () => {
    expect(requestIsSecure(ctx(LOCAL, { "x-forwarded-ssl": "on" }))).toBe(true);
  });

  it("trusts https Origin / Referer — the Vite /trpc proxy case", () => {
    expect(requestIsSecure(ctx(LOCAL, { origin: PREVIEW_ORIGIN }))).toBe(true);
    expect(requestIsSecure(ctx(LOCAL, { referer: `${PREVIEW_ORIGIN}/login` }))).toBe(true);
  });

  it("stays insecure for a bare localhost request with no https signal", () => {
    expect(requestIsSecure(ctx(LOCAL, { host: "localhost:3001" }))).toBe(false);
  });
});
