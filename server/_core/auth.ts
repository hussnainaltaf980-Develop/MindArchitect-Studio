import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { SignJWT, jwtVerify } from "jose";
import { compare, hash as bcryptHash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { isUniqueViolation } from "./db-errors";
import { users } from "../../drizzle/schema";
import { env } from "./env";
import { sessionCookieName, type UserRole } from "../../shared/constants";
import type { SessionUser } from "../../shared/types";
import {
  requestIsSecure,
  sessionCookieClearOptions,
  sessionCookieOptions,
} from "./session-cookie";

// ─────────────────────────────────────────────────────────────────────────────
// AuthProvider abstraction (DESIGN §5.1). Business code depends only on the
// SessionUser it yields, NEVER on how the user authenticated. M1 wires only
// LocalAuthProvider; SsoAuthProvider is a reserved stub. Swapping/adding a
// provider later touches only this file + config — zero business-code churn.
// ─────────────────────────────────────────────────────────────────────────────
export interface AuthProvider {
  /** Resolve the current user from the request, or null if unauthenticated. */
  getSession(c: Context): Promise<SessionUser | null>;
  /** Begin a session (sets the auth cookie). Throws on bad credentials. */
  login(c: Context, email: string, password: string): Promise<SessionUser>;
  /** End the current session (clears the auth cookie). */
  logout(c: Context): Promise<void>;
}

const COOKIE = sessionCookieName(env.appSlug);
const secretKey = new TextEncoder().encode(env.jwtSecret);

function toSessionUser(row: typeof users.$inferSelect): SessionUser {
  // password_hash is intentionally dropped here — never leaves the auth layer.
  return { id: row.id, email: row.email, name: row.name, role: row.role as UserRole };
}

class LocalAuthProvider implements AuthProvider {
  async getSession(c: Context): Promise<SessionUser | null> {
    const token = getCookie(c, COOKIE);
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, secretKey);
      const userId = payload.sub;
      if (!userId) return null;
      const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      return row ? toSessionUser(row) : null;
    } catch {
      return null; // expired / tampered / wrong key → treat as anonymous
    }
  }

  async login(c: Context, email: string, password: string): Promise<SessionUser> {
    const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    // Constant-ish: still run a compare when the user is missing to blunt timing.
    const hash = row?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
    const ok = await compare(password, hash);
    if (!row || !row.passwordHash || !ok) throw new AuthError("Invalid email or password");
    await this.#setSession(c, row.id);
    return toSessionUser(row);
  }

  async logout(c: Context): Promise<void> {
    for (const opt of sessionCookieClearOptions()) {
      deleteCookie(c, COOKIE, opt);
    }
  }

  async #setSession(c: Context, userId: string): Promise<void> {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(secretKey);
    setCookie(c, COOKIE, token, sessionCookieOptions(env.isProd || requestIsSecure(c)));
  }
}

// Reserved for post-M1 SSO (OIDC / Teamily IdP). NOT implemented — its presence
// only proves the seam holds; it is never wired in M1 (DESIGN §5.1).
class SsoAuthProvider implements AuthProvider {
  async getSession(): Promise<SessionUser | null> {
    throw new Error("SsoAuthProvider not implemented (reserved seam — DESIGN §5.1).");
  }
  async login(): Promise<SessionUser> {
    throw new Error("SsoAuthProvider not implemented (reserved seam — DESIGN §5.1).");
  }
  async logout(): Promise<void> {
    throw new Error("SsoAuthProvider not implemented (reserved seam — DESIGN §5.1).");
  }
}

export class AuthError extends Error {}

/** Signup hit the `users.email` UNIQUE index — that address already has an
 *  account. A distinct type (not a string match on some driver's wording) so a
 *  router can answer 409 "log in instead" instead of leaking a 500. */
export class EmailTakenError extends AuthError {}

let _provider: AuthProvider | undefined;
export function authProvider(): AuthProvider {
  if (!_provider) _provider = env.authProvider === "sso" ? new SsoAuthProvider() : new LocalAuthProvider();
  return _provider;
}

// Local-only helper for the signup flow (registration is inherently
// provider-specific; SSO signup happens at the IdP). Kept out of the interface.
export async function registerLocalUser(email: string, password: string, name?: string): Promise<SessionUser> {
  const passwordHash = await bcryptHash(password, 10);
  try {
    const [row] = await db
      .insert(users)
      .values({ email: email.toLowerCase(), passwordHash, name: name ?? null })
      .returning();
    return { id: row.id, email: row.email, name: row.name, role: row.role as UserRole };
  } catch (e) {
    // `users` carries exactly one UNIQUE index (email) — `id` is generated — so
    // a 23505 on this INSERT can only mean the address is taken. Translating it
    // HERE, rather than in each app's routers.ts, is what keeps a second signup
    // from surfacing as a 500 that quotes the INSERT and its bound params
    // (password hash included) back to the browser.
    if (isUniqueViolation(e)) {
      throw new EmailTakenError("That email is already registered — try logging in instead.");
    }
    throw e;
  }
}
