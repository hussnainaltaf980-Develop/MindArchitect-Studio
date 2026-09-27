import { describe, expect, it, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import { makeCaller } from "./_core/test-caller";

// Full rationale for what gets mocked below (and why ./_core/trpc doesn't
// need to be) lives on server/_core/test-caller.ts, next to makeCaller —
// mock every _core module routers.ts touches.
vi.mock("./_core/auth", () => {
  class AuthError extends Error {}
  return {
    authProvider: () => ({ login: vi.fn(), logout: vi.fn(), getSession: vi.fn() }),
    registerLocalUser: vi.fn(),
    AuthError,
    EmailTakenError: class EmailTakenError extends AuthError {},
  };
});

vi.mock("./_core/storage", () => ({
  storageCommit: vi.fn(),
  storageDeleteOwned: vi.fn(),
  storageListByOwner: vi.fn(),
  storagePutUrl: vi.fn(),
  StorageError: class StorageError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  },
}));

vi.mock("./db", () => ({
  listItemsByOwner: vi.fn(),
  createItem: vi.fn(),
  deleteItem: vi.fn(),
}));

const { sanitizeBasename } = await import("./routers");
const { storageDeleteOwned, StorageError } = await import("./_core/storage");
const { registerLocalUser, EmailTakenError } = await import("./_core/auth");

// C1c: uploadUrl's key is `${uuid}-${sanitizeBasename(name)}`. The uuid prefix
// only makes the key unguessable if the REST of the key isn't
// attacker-controlled — sanitizeBasename is what stops a caller-supplied
// `name` like "/../report.pdf" from steering path segments into someone
// else's key (which canonicalKey in storage.ts would then reject outright,
// but the point of sanitizing here is to never construct that key at all).
describe("sanitizeBasename", () => {
  it("passes a normal filename through unchanged", () => {
    expect(sanitizeBasename("report.pdf")).toBe("report.pdf");
  });

  it("takes only the last path segment, dropping any directory traversal", () => {
    expect(sanitizeBasename("/../report.pdf")).toBe("report.pdf");
    expect(sanitizeBasename("a/b/../evil.png")).toBe("evil.png");
    expect(sanitizeBasename("../../etc/passwd")).toBe("passwd");
  });

  it("strips characters outside [A-Za-z0-9._-]", () => {
    expect(sanitizeBasename("my file (final)!.png")).toBe("myfilefinal.png");
    expect(sanitizeBasename("héllo.png")).toBe("hllo.png");
  });

  it("collapses leading dots so a bare '.' or '..' basename can't survive", () => {
    expect(sanitizeBasename("..")).toBe("upload");
    expect(sanitizeBasename(".")).toBe("upload");
    // "upload.hidden", not "hidden": the leading dots are still gone (that is
    // the security property), but the last dot is now read as the extension
    // separator rather than deleted along with them.
    expect(sanitizeBasename("...hidden")).toBe("upload.hidden");
  });

  // Regression (observed 2026-08, published app gallery-app-gpkd51ak): a file
  // named 风景.png landed in storage as "<uuid>-png" — no dot, no extension.
  // Two rules compounded. The allowlist is ASCII-only, so a stem written
  // entirely in CJK is deleted, leaving ".png"; the leading-dot strip that
  // follows then ate the dot, because by that point the only dot left in the
  // string is the extension separator, not a dotfile prefix.
  //
  // The trigger is a stem with NO surviving ASCII, which is the common case for
  // Chinese/Japanese/Korean filenames — "微信图片_2026.png" was always fine,
  // because "_2026" survives and keeps a stem in front of the dot. That is why
  // this went unnoticed.
  it("keeps the extension when the stem is entirely non-ASCII", () => {
    expect(sanitizeBasename("风景.png")).toBe("upload.png");
    expect(sanitizeBasename("日本語.jpeg")).toBe("upload.jpeg");
    expect(sanitizeBasename("한글.png")).toBe("upload.png");
    expect(sanitizeBasename("相册/风景.png")).toBe("upload.png");
  });

  it("keeps the extension on names that already sanitized cleanly", () => {
    expect(sanitizeBasename("微信图片_2026.png")).toBe("_2026.png");
    expect(sanitizeBasename("IMG_1234.PNG")).toBe("IMG_1234.PNG");
    expect(sanitizeBasename("archive.tar.gz")).toBe("archive.tar.gz");
  });

  // A dotfile has no extension to preserve — the whole name is the stem.
  it("treats a leading-dot name as a stem, not as a bare extension", () => {
    expect(sanitizeBasename(".png")).toBe("png");
    expect(sanitizeBasename(".gitignore")).toBe("gitignore");
  });

  // The key is `${uuid}-${basename}`, so a "/" or "\\" surviving here would
  // steer path segments; an over-long extension would pad the key for no gain.
  it("never emits a path separator, and caps the extension", () => {
    expect(sanitizeBasename("C:\\photos\\风景.png")).toBe("upload.png");
    expect(sanitizeBasename("x." + "a".repeat(40))).toBe("x." + "a".repeat(10));
  });

  it("falls back to a constant when nothing survives sanitization", () => {
    expect(sanitizeBasename("???")).toBe("upload");
    expect(sanitizeBasename("")).toBe("upload");
    expect(sanitizeBasename("///")).toBe("upload");
  });
});

// C1d (regression): storageDeleteOwned runs the key through canonicalKey,
// which throws StorageError("forbidden") for a malformed key (e.g. a
// "../"-traversal segment) BEFORE any db/network access. files.remove had no
// try/catch, so that throw used to escape as a raw StorageError, which tRPC
// wraps as an opaque INTERNAL_SERVER_ERROR (500) for what is plainly bad
// client input. Exercise the real router (only auth/storage/db are mocked —
// ./_core/trpc is real) via makeCaller so this asserts the actual error the
// client would receive, not a re-implementation of the mapping.
describe("files.remove", () => {
  it("maps a malformed key (StorageError forbidden) to TRPCError BAD_REQUEST, not a raw throw", async () => {
    vi.mocked(storageDeleteOwned).mockRejectedValueOnce(
      new StorageError("unsafe storage key (diverges from platform normalization): ../evil.pdf", "forbidden"),
    );
    const caller = makeCaller({
      c: {} as never,
      db: {} as never,
      user: { id: "user-1" } as never,
    });

    const err = await caller.files.remove({ key: "../evil.pdf" }).catch((e) => e);

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("BAD_REQUEST");
  });
});

// Regression (observed 2026-08-26, published app): signing up twice with the
// same email answered 500 INTERNAL_SERVER_ERROR whose message was the raw
// Drizzle failure — the INSERT statement plus every bound param, bcrypt hash
// included — which the signup form then printed at the user. The mapping now
// hangs off a type (EmailTakenError from _core/auth), not a regex over a
// driver-specific message.
describe("auth.signup", () => {
  const anonymous = { c: {} as never, db: {} as never, user: null };

  it("maps an already-registered email to TRPCError CONFLICT, not a 500", async () => {
    vi.mocked(registerLocalUser).mockRejectedValueOnce(
      new EmailTakenError("That email is already registered — try logging in instead."),
    );
    const caller = makeCaller(anonymous);

    const err = await caller.auth
      .signup({ email: "asce1885@gmail.com", password: "hunter2hunter2", name: "asce" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TRPCError);
    expect((err as TRPCError).code).toBe("CONFLICT");
    expect((err as TRPCError).message).toMatch(/already registered/i);
    expect((err as TRPCError).message).not.toMatch(/insert into|Failed query|params:|\$2b\$/);
  });
});
