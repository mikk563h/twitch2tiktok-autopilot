import { NextResponse, type NextRequest } from "next/server";
import { sql } from "@/lib/db";
import { redis } from "@/lib/queue";
import { workerStatus } from "@/lib/pipeline/maintenance";
import { getSyncState } from "@/lib/twitch/monitor";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Liveness: DB + Redis reachable (used by Docker healthcheck).
 * `?deep=1`: also requires all workers alive — point external uptime monitoring here.
 */
export async function GET(req: NextRequest) {
  const deep = req.nextUrl.searchParams.get("deep") === "1";
  const checks: Record<string, boolean | string> = {};
  try { await sql()`SELECT 1`; checks.database = true; } catch { checks.database = false; }
  if (config.runMode === "workers") {
    try { checks.redis = (await redis().ping()) === "PONG"; } catch { checks.redis = false; }
  }
  let ok = checks.database === true && checks.redis !== false;
  if (deep && ok) {
    const workers = await workerStatus();
    for (const w of workers) { checks[`worker_${w.worker}`] = w.alive; if (!w.alive) ok = false; }
    const sync = await getSyncState();
    checks.lastTwitchScan = sync.lastSuccessAt ?? "aldrig";
  }
  return NextResponse.json({ ok, checks, time: new Date().toISOString() }, { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
