import fs from "node:fs";
import os from "node:os";
import type { Worker } from "bullmq";
import { config } from "@/lib/config";
import { sql, closeDb } from "@/lib/db";
import { closeQueues } from "@/lib/queue";
import { log } from "@/lib/log";

export const HEARTBEAT_FILE = process.env.HEARTBEAT_FILE ?? "/tmp/worker-heartbeat";
/** Unique per process start — used as lock owner id. */
export const INSTANCE_ID = `${os.hostname()}-${process.pid}-${Date.now().toString(36)}`;

/**
 * Heartbeat to DB (dashboard + alerts) and to a local file (Docker healthcheck).
 * If the heartbeat itself keeps failing (DB gone) we exit so Docker restarts us.
 */
export function startHeartbeat(name: string, info: () => Record<string, unknown> = () => ({})) {
  const startedAt = new Date();
  let failures = 0;
  const beat = async () => {
    try {
      const db = sql();
      await db`INSERT INTO worker_heartbeats (worker, hostname, pid, version, started_at, last_beat_at, info)
               VALUES (${name}, ${os.hostname()}, ${process.pid}, ${config.appVersion}, ${startedAt}, now(), ${db.json({ ...info(), instance: INSTANCE_ID } as never)})
               ON CONFLICT (worker) DO UPDATE SET hostname = EXCLUDED.hostname, pid = EXCLUDED.pid, version = EXCLUDED.version,
                 started_at = EXCLUDED.started_at, last_beat_at = now(), info = EXCLUDED.info`;
      fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()));
      failures = 0;
    } catch (err) {
      failures++;
      log.error({ err, failures }, "Heartbeat fejlede");
      if (failures >= 8) {
        log.fatal("Mistet forbindelse til databasen for længe — afslutter så Docker genstarter workeren");
        process.exit(1);
      }
    }
  };
  void beat();
  return setInterval(beat, 15_000);
}

export function installShutdown(name: string, workers: Worker[], timer: NodeJS.Timeout) {
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, `${name}: lukker ned`);
    clearInterval(timer);
    // close() waits for active jobs; the stop_grace_period in compose bounds this.
    await Promise.allSettled(workers.map((w) => w.close()));
    await closeQueues();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("unhandledRejection", (err) => {
    log.fatal({ err }, "Unhandled rejection — afslutter (Docker genstarter)");
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "Uncaught exception — afslutter (Docker genstarter)");
    process.exit(1);
  });
}
