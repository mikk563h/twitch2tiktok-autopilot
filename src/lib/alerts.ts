import { sql } from "./db";
import { sendEmail } from "./notify";
import { log } from "./log";

export type Severity = "info" | "warning" | "critical";

const RENOTIFY_MS = 6 * 3600_000;

/** Opens (or refreshes) an alert. Warnings/criticals e-mail at most every 6 hours per alert. */
export async function raiseAlert(key: string, severity: Severity, message: string) {
  const db = sql();
  const [row] = await db`
    INSERT INTO alerts (key, severity, message) VALUES (${key}, ${severity}, ${message})
    ON CONFLICT (key) WHERE resolved_at IS NULL DO UPDATE SET severity = EXCLUDED.severity, message = EXCLUDED.message, last_seen_at = now()
    RETURNING id, last_notified_at, first_seen_at`;
  const last = row.last_notified_at as Date | null;
  if (severity !== "info" && (!last || Date.now() - last.getTime() > RENOTIFY_MS)) {
    log.warn({ key, severity }, message);
    const sent = await sendEmail(`${severity === "critical" ? "KRITISK" : "Advarsel"}: ${message.slice(0, 80)}`, `${message}\n\nAlarm: ${key}\nFørst set: ${(row.first_seen_at as Date).toISOString()}`);
    if (sent) await db`UPDATE alerts SET last_notified_at = now() WHERE id = ${row.id}`;
  }
}

export async function resolveAlert(key: string) {
  const rows = await sql()`UPDATE alerts SET resolved_at = now() WHERE key = ${key} AND resolved_at IS NULL RETURNING severity, message`;
  for (const r of rows) if (r.severity === "critical") await sendEmail(`Løst: ${String(r.message).slice(0, 80)}`, `Alarmen "${key}" er løst.`);
}

export async function setAlert(key: string, active: boolean, severity: Severity, message: string) {
  if (active) await raiseAlert(key, severity, message);
  else await resolveAlert(key);
}

export async function openAlerts() {
  return sql()`SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, last_seen_at DESC`;
}
