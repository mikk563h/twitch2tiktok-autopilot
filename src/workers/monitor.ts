process.env.WORKER_NAME ??= "monitor";
import { Worker } from "bullmq";
import { QUEUES, newRedis } from "@/lib/queue";
import { log, record, errMsg } from "@/lib/log";
import { runHistoricalImport, runIncrementalScan } from "@/lib/twitch/monitor";
import { TwitchNotConfigured } from "@/lib/twitch/api";
import { evaluateAlerts, housekeeping, logRecovery, reconcile, syncSchedulers } from "@/lib/pipeline/maintenance";
import { startHeartbeat, installShutdown } from "./common";

let lastScan: unknown = null;

const worker = new Worker(
  QUEUES.monitor,
  async (job) => {
    switch (job.name) {
      case "scan":
      case "scan-now": {
        try {
          lastScan = await runIncrementalScan();
          return lastScan;
        } catch (err) {
          if (err instanceof TwitchNotConfigured) return { skipped: err.message };
          await record("error", "twitch", `Twitch-scan fejlede: ${errMsg(err)}`);
          throw err;
        }
      }
      case "historical":
        return runHistoricalImport(new Date(job.data.start), new Date(job.data.end));
      case "reconcile": {
        await syncSchedulers();
        return logRecovery(await reconcile());
      }
      case "housekeeping":
        return housekeeping();
      case "alerts":
        return evaluateAlerts();
      default:
        log.warn({ name: job.name }, "Ukendt monitor-job");
    }
  },
  { connection: newRedis(), concurrency: 2, lockDuration: 120_000 },
);
worker.on("failed", (job, err) => log.error({ job: job?.name, err: err.message }, "Monitor-job fejlede"));

await syncSchedulers();
const hb = startHeartbeat("monitor", () => ({ lastScan }));
installShutdown("monitor", [worker], hb);
log.info("Monitor-worker startet");
