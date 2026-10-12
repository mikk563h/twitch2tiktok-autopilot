import { NextResponse, type NextRequest } from "next/server";
import { checkPassword, createSessionToken, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { redis } from "@/lib/queue";
import { config } from "@/lib/config";
import { sql } from "@/lib/db";

const MAX_ATTEMPTS = 8;
const WINDOW_SEC = 15 * 60;

export async function POST(req: NextRequest) {
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const key = `t2t:login:${ip}`;
  const attempts = await countAttempt(key);
  const form = await req.formData();
  const next = String(form.get("next") ?? "/");
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/";
  const back = (err: string) => NextResponse.redirect(new URL(`/login?error=${err}&next=${encodeURIComponent(safeNext)}`, req.url), 303);
  if (attempts > MAX_ATTEMPTS) return back("locked");
  if (!checkPassword(String(form.get("password") ?? ""))) return back("invalid");
  await clearAttempts(key);
  const res = NextResponse.redirect(new URL(safeNext, req.url), 303);
  res.cookies.set(SESSION_COOKIE, await createSessionToken(), sessionCookieOptions);
  return res;
}

/** Failed-login counter: Redis when available, otherwise a row in kv_state (batch/Vercel mode). */
async function countAttempt(key: string): Promise<number> {
  try {
    if (config.runMode === "workers") {
      const n = await redis().incr(key);
      if (n === 1) await redis().expire(key, WINDOW_SEC);
      return n;
    }
    const db = sql();
    const [r] = await db`
      INSERT INTO kv_state (key, value) VALUES (${key}, ${db.json({ n: 1 } as never)})
      ON CONFLICT (key) DO UPDATE SET
        value = CASE WHEN kv_state.updated_at < now() - make_interval(secs => ${WINDOW_SEC}) THEN '{"n":1}'::jsonb
                     ELSE jsonb_build_object('n', (kv_state.value->>'n')::int + 1) END,
        updated_at = CASE WHEN kv_state.updated_at < now() - make_interval(secs => ${WINDOW_SEC}) THEN now() ELSE kv_state.updated_at END
      RETURNING (value->>'n')::int AS n`;
    return Number(r.n);
  } catch {
    return 0; // rate limiting is best effort
  }
}

async function clearAttempts(key: string) {
  try {
    if (config.runMode === "workers") await redis().del(key);
    else await sql()`DELETE FROM kv_state WHERE key = ${key}`;
  } catch { /* ignore */ }
}
