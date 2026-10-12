process.env.WORKER_NAME ??= "uploader";
import { Worker } from "bullmq";
import { QUEUES, newRedis, queue } from "@/lib/queue";
import { log } from "@/lib/log";
import { checkPublishStatus, uploadClip } from "@/lib/pipeline/upload";
import { startHeartbeat, installShutdown } from "./common";

let active: string | null = null;

const worker = new Worker(
  QUEUES.upload,
  async (job) => {
    const clipId = Number(job.data.clipId);
    active = `${job.name}:${clipId}`;
    try {
      if (job.name === "upload") return await uploadClip(clipId, { force: job.data.force === true });
      if (job.name === "status") {
        const poll = Number(job.data.poll ?? 0);
        const r = await checkPublishStatus(clipId, poll);
        if (r.nextDelayMs) {
          await queue("upload").add("status", { clipId, poll: poll + 1 }, { jobId: `status-${clipId}-p${poll + 1}-${Date.now()}`, delay: r.nextDelayMs });
        }
        return r;
      }
    } finally {
      active = null;
    }
  },
  // Concurrency 1: posts go out strictly one at a time, in queue order.
  { connection: newRedis(), concurrency: 1, lockDuration: Number(process.env.WORKER_LOCK_MS ?? 10 * 60_000), stalledInterval: Number(process.env.WORKER_STALLED_MS ?? 60_000), maxStalledCount: 5 },
);
worker.on("failed", (job, err) => log.error({ job: job?.name, clipId: job?.data?.clipId, err: err.message }, "Upload-job fejlede"));

const hb = startHeartbeat("uploader", () => ({ active }));
installShutdown("uploader", [worker], hb);
log.info("Uploader-worker startet");
