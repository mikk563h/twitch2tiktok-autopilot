import path from "node:path";
import pino from "pino";
import type postgres from "postgres";
import { sql } from "./db";

const g = globalThis as unknown as { __log?: pino.Logger };

/** Service name from the entry script (src/workers/render.ts → "render"); ESM import order makes env vars unreliable here. */
function serviceName(): string {
  if (process.env.WORKER_NAME) return process.env.WORKER_NAME;
  const entry = path.basename(process.argv[1] ?? "", path.extname(process.argv[1] ?? ""));
  return ["monitor", "render", "uploader", "migrate"].includes(entry) ? entry : "web";
}

export const log: pino.Logger =
  g.__log ?? (g.__log = pino({ level: process.env.LOG_LEVEL ?? "info", base: { svc: serviceName() } }));

/**
 * Logs and persists the line to the database so the dashboard can show it.
 * Persisting is best-effort: a broken DB must never crash the caller.
 */
export async function record(level: "info" | "warn" | "error", source: string, message: string, data?: unknown) {
  log[level]({ source, data }, message);
  try {
    const db = sql();
    await db`INSERT INTO log_entries (level, source, message, data)
             VALUES (${level}, ${source}, ${message.slice(0, 4000)}, ${data === undefined ? null : db.json(toJson(data))})`;
  } catch (err) {
    log.warn({ err }, "Kunne ikke gemme log-linje");
  }
}

export function toJson(v: unknown): postgres.JSONValue {
  return JSON.parse(
    JSON.stringify(v ?? null, (_k, val) => (val instanceof Error ? { name: val.name, message: val.message } : val)),
  ) as postgres.JSONValue;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
