import { NextResponse, type NextRequest } from "next/server";
import { config } from "@/lib/config";
import { safeEqual } from "@/lib/crypto";
import { ensureWorkflowEnabled, latestRuns, triggerWorkflow } from "@/lib/github";
import { record } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Daily Vercel cron (safety net): makes sure the GitHub schedule is still enabled (GitHub turns
 * schedules off in repos without activity) and starts a run if none happened for 2 hours.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!config.cronSecret || !safeEqual(auth, `Bearer ${config.cronSecret}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const wf = await ensureWorkflowEnabled();
  const [last] = await latestRuns(1);
  let triggered = false;
  if (!last || Date.now() - Date.parse(last.created_at) > 2 * 3600_000) triggered = await triggerWorkflow();
  if (wf.state?.includes("genaktiveret") || triggered) await record("warn", "keepalive", `GitHub-workflow: ${wf.state ?? "ukendt"}${triggered ? ", kørsel startet (ingen i 2 t)" : ""}`);
  return NextResponse.json({ workflow: wf, lastRun: last?.created_at ?? null, triggered });
}
