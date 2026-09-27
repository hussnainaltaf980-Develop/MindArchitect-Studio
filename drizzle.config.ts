import "dotenv/config"; // so `drizzle-kit generate/migrate` sees DATABASE_URL from .env
import { defineConfig } from "drizzle-kit";

// Postgres dialect is FIXED by the template (DESIGN §5.1). Runtime queries pick
// their driver via DB_DRIVER (node-postgres TCP or Neon HTTP, see _core/db.ts),
// but drizzle-kit migrate ALWAYS connects over TCP with DATABASE_URL — on Neon
// prefer the direct (non-pooler) connection string. Ordered migration files
// under drizzle/migrations are the source of truth for prod promotion
// (DESIGN §5.5.1) — never diff a live DB.
export default defineConfig({
  dialect: "postgresql",
  schema: "./drizzle/schema.ts",
  out: "./drizzle/migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  strict: true,
  verbose: true,
});
