import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql, closeDb } from "./db";

/** Applies pending SQL migrations from /migrations in order, each in a transaction. */
export async function migrate(dir = path.resolve(process.cwd(), "migrations")): Promise<string[]> {
  const db = sql();
  await db`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
  // Serialise concurrent migrators (e.g. two containers starting at once).
  return db.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727274)`;
    const done = new Set((await tx`SELECT name FROM schema_migrations`).map((r) => r.name as string));
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    const applied: string[] = [];
    for (const f of files) {
      if (done.has(f)) continue;
      await tx.unsafe(await fs.readFile(path.join(dir, f), "utf8"));
      await tx`INSERT INTO schema_migrations (name) VALUES (${f})`;
      applied.push(f);
    }
    return applied;
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate()
    .then((applied) => {
      console.log(applied.length ? `Anvendte migrationer: ${applied.join(", ")}` : "Databasen er opdateret");
      return closeDb();
    })
    .catch(async (err) => {
      console.error("Migration fejlede:", err);
      await closeDb();
      process.exit(1);
    });
}
