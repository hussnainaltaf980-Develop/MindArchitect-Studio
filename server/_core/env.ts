// Central, validated env access. Platform SDK only — business code should not
// read process.env directly.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const isProd = process.env.NODE_ENV === "production";

export const env = {
  isProd,
  databaseUrl: required("DATABASE_URL"),
  // DB driver select (see db.ts). "tcp" = node-postgres pool (default, portable,
  // right for a resident process); "http" = Neon serverless HTTP (Neon DSN +
  // scale-to-zero only). Absent ⇒ "tcp" so the template works on any Postgres.
  dbDriver: (process.env.DB_DRIVER ?? "tcp") as "tcp" | "http",
  // Max TCP connections this app's pool may hold. Only the "tcp" driver has a
  // pool; "http" opens a connection per request and ignores this.
  //
  // 5, not node-postgres' default of 10: that default suits an app that owns its
  // database server. On the platform every app gets its own database on ONE
  // SHARED cluster, so the number that matters is (apps under active iteration
  // x max), and a handful of idle-but-open pools can exhaust the cluster's
  // connection slots long before any single app needs ten.
  //
  // `|| 5` also catches a non-numeric value: `Number("八")` is NaN, and a pool
  // built with max: NaN is a subtle production fault rather than a startup error.
  dbPoolMax: Math.max(1, Number(process.env.DB_POOL_MAX) || 5),
  jwtSecret: required("JWT_SECRET"),
  authProvider: (process.env.AUTH_PROVIDER ?? "local") as "local" | "sso",
  appSlug: process.env.APP_SLUG ?? "app",
  port: Number(process.env.PORT ?? 3000),
  apiPort: Number(process.env.API_PORT ?? 3001),
  storage: {
    presignUrl: process.env.APP_STORAGE_PRESIGN_URL ?? "",
    token: process.env.APP_STORAGE_TOKEN ?? "",
  },
};
