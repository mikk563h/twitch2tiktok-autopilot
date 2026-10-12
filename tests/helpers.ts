import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sql } from "@/lib/db";
import { migrate } from "@/lib/migrate";
import { redis } from "@/lib/queue";

export async function resetDb() {
  await migrate();
  await sql()`TRUNCATE clips, clip_events, upload_attempts, settings, oauth_tokens, kv_state, scan_runs, worker_heartbeats, alerts, log_entries, system_metrics, backup_runs RESTART IDENTITY CASCADE`;
  await redis().flushall();
}

export const FIXTURES = path.resolve("tests/fixtures");

export function hasBinary(bin: string): boolean {
  try { execFileSync(bin, ["--help"], { stdio: "ignore" }); return true; } catch (e) { return (e as { status?: number }).status !== undefined && fs.existsSync(bin) || false; }
}

/**
 * A real test clip: 1920x1080 test pattern with a "facecam" box in the top-right, and
 * Danish speech (macOS `say`) mixed over a quiet tone. Cached between runs.
 */
export function makeTestClip(opts: { seconds?: number; speech?: string; audio?: boolean; name?: string; fps?: number } = {}): string {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const seconds = opts.seconds ?? 6;
  const name = opts.name ?? `clip-${seconds}s-${opts.audio === false ? "silent" : "speech"}-${opts.fps ?? 60}.mp4`;
  const out = path.join(FIXTURES, name);
  if (fs.existsSync(out)) return out;
  const video = ["-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=${opts.fps ?? 60}:duration=${seconds}`];
  if (opts.audio === false) {
    execFileSync("ffmpeg", ["-v", "error", "-y", ...video, "-vf", "drawbox=x=1500:y=40:w=380:h=280:color=orange@0.9:t=fill", "-c:v", "libx264", "-pix_fmt", "yuv420p", out]);
    return out;
  }
  const aiff = path.join(FIXTURES, `${name}.aiff`);
  const text = opts.speech ?? "Hej allesammen. Nu skal vi spille Counter Strike, og jeg vinder runden.";
  execFileSync("say", ["-v", "Sara", "-o", aiff, text]);
  execFileSync("ffmpeg", ["-v", "error", "-y", ...video, "-i", aiff, "-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds}`,
    "-filter_complex", "[1:a]volume=1.6[s];[2:a]volume=0.05[t];[t][s]amix=inputs=2:duration=first:normalize=0[a];[0:v]drawbox=x=1500:y=40:w=380:h=280:color=orange@0.9:t=fill[v]",
    "-map", "[v]", "-map", "[a]", "-t", String(seconds), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", out]);
  fs.rmSync(aiff, { force: true });
  return out;
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000, everyMs = 250): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error("waitFor: timeout");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
