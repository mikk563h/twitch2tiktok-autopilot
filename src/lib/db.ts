import postgres from "postgres";
import { config } from "./config";

type Sql = postgres.Sql<Record<string, unknown>>;

const g = globalThis as unknown as { __sql?: Sql };

/** Shared Postgres connection pool (one per process). */
export function sql(): Sql {
  if (!g.__sql) {
    g.__sql = postgres(config.databaseUrl, {
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idle_timeout: 30,
      connect_timeout: 10,
      onnotice: () => {},
      transform: { undefined: null },
    });
  }
  return g.__sql;
}

export async function closeDb(): Promise<void> {
  if (g.__sql) {
    await g.__sql.end({ timeout: 5 });
    g.__sql = undefined;
  }
}

export type { Sql };
