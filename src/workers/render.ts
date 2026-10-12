process.env.WORKER_NAME ??= "render";
import { Worker } from "bullmq";
import { QUEUES, newRedis } from "@/lib/queue";
import { log } from "@/lib/log";
import { processClip } from "@/lib/pipeline/process";
import { ensureModel } from "@/lib/media/whisper";
import { startHeartbeat, installShutdown, INSTANCE_ID } from "./common";

const id = INSTANCE_ID;
let active: number | null = null;

const worker = new Worker(
  QUEUES.process,
  async (job) => {
    active = job.data.clipId;
    try {
      return await processClip(Number(job.data.clipId), id);
    } finally {
      active = null;
    }
  },
  // lockDuration is renewed automatically while the process lives; if it dies the job is
  // detected as stalled and re-run (the pipeline resumes from the DB state).
  { connection: newRedis(), concurrency: Number(process.env.RENDER_CONCURRENCY ?? 1), lockDuration: Number(process.env.WORKER_LOCK_MS ?? 5 * 60_000), stalledInterval: Number(process.env.WORKER_STALLED_MS ?? 60_000), maxStalledCount: 3 },
);
worker.on("failed", (job, err) => log.error({ clipId: job?.data?.clipId, err: err.message }, "Render-job fejlede"));

const hb = startHeartbeat("render", () => ({ activeClip: active }));
installShutdown("render", [worker], hb);
ensureModel().then((f) => log.info({ model: f }, "Whisper-model klar")).catch((err) => log.error({ err }, "Whisper-model kunne ikke hentes (prøver igen ved næste clip)"));
log.info("Render-worker startet");
