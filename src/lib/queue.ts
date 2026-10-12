import { Queue, type JobsOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { config } from "./config";

export const QUEUES = {
  monitor: "t2t-monitor",
  process: "t2t-process",
  upload: "t2t-upload",
} as const;

export type QueueName = keyof typeof QUEUES;

const g = globalThis as unknown as { __redis?: Redis; __queues?: Partial<Record<QueueName, Queue>> };

export function redis(): Redis {
  if (!g.__redis) {
    g.__redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
    g.__redis.on("error", () => {}); // reconnects automatically; errors surface via health checks
  }
  return g.__redis;
}

/** A fresh connection — BullMQ workers need their own blocking connection. */
export function newRedis(): Redis {
  return new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
}

export function queue(name: QueueName): Queue {
  g.__queues ??= {};
  if (!g.__queues[name]) {
    g.__queues[name] = new Queue(QUEUES[name], {
      connection: redis(),
      defaultJobOptions: { removeOnComplete: { count: 500, age: 7 * 86400 }, removeOnFail: { count: 1000, age: 30 * 86400 }, attempts: 1 },
    });
  }
  return g.__queues[name]!;
}

/**
 * The database is the source of truth for clip state; BullMQ only dispatches work.
 * The deterministic jobId makes enqueueing idempotent: an already waiting/active job
 * for the same clip and stage is not duplicated.
 */
export async function enqueueClip(stage: "process" | "upload" | "status", clipId: number | string, opts: JobsOptions = {}) {
  // Batch mode: the scheduled run picks clips up by status — nothing to dispatch.
  if (config.runMode === "batch") return null;
  const q = stage === "process" ? queue("process") : queue("upload");
  const jobId = `${stage}-${clipId}`;
  const existing = await q.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "waiting" || state === "active" || state === "delayed" || state === "prioritized" || state === "waiting-children") return existing;
    await existing.remove().catch(() => {});
  }
  return q.add(stage, { clipId: Number(clipId) }, { jobId, ...opts });
}

export async function closeQueues() {
  for (const q of Object.values(g.__queues ?? {})) await q?.close();
  g.__queues = {};
  if (g.__redis) {
    g.__redis.disconnect();
    g.__redis = undefined;
  }
}

export type JobRequest =
  | { name: "scan-now" }
  | { name: "historical"; start: string; end: string }
  | { name: "upload-now"; clipId: number };

/**
 * Work requested from the dashboard. Workers mode: a BullMQ job. Batch mode: stored in the DB
 * for the next scheduled run, and the GitHub workflow is triggered immediately when possible.
 */
export async function requestJob(req: JobRequest): Promise<{ triggered: boolean }> {
  if (config.runMode === "workers") {
    if (req.name === "upload-now") await queue("upload").add("upload", { clipId: req.clipId, force: true }, { jobId: `upload-${req.clipId}-manual-${Date.now()}` });
    else await queue("monitor").add(req.name, req, { jobId: `${req.name}-${Date.now()}` });
    return { triggered: true };
  }
  const { sql } = await import("./db");
  const db = sql();
  await db`INSERT INTO kv_state (key, value) VALUES ('batch.requests', ${db.json([req] as never)})
           ON CONFLICT (key) DO UPDATE SET value = kv_state.value || EXCLUDED.value, updated_at = now()`;
  const { triggerWorkflow } = await import("./github");
  return { triggered: await triggerWorkflow() };
}

/** Batch runner: takes (and clears) the pending dashboard requests atomically. */
export async function takeRequests(): Promise<JobRequest[]> {
  const { sql } = await import("./db");
  const rows = await sql()`DELETE FROM kv_state WHERE key = 'batch.requests' RETURNING value`;
  return (rows[0]?.value as JobRequest[] | undefined) ?? [];
}
