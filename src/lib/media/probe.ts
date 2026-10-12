import { config } from "../config";
import { run } from "../proc";

export interface MediaInfo {
  width: number;
  height: number;
  fps: number;
  duration: number;
  videoCodec: string;
  audioCodec: string | null;
  hasAudio: boolean;
  sizeBytes: number;
  pixFmt?: string;
  sampleRate?: number;
}

function parseRate(r?: string): number {
  if (!r) return 0;
  const [a, b] = r.split("/").map(Number);
  return b ? a / b : a;
}

export async function probe(file: string): Promise<MediaInfo> {
  const { stdout } = await run(config.ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { timeoutMs: 60_000 });
  const j = JSON.parse(stdout.toString()) as {
    streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string; pix_fmt?: string; sample_rate?: string; duration?: string }>;
    format: { duration?: string; size?: string };
  };
  const v = j.streams.find((s) => s.codec_type === "video");
  const a = j.streams.find((s) => s.codec_type === "audio");
  if (!v) throw new Error("Filen indeholder ingen videostream");
  const fps = parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30;
  return {
    width: v.width ?? 0,
    height: v.height ?? 0,
    fps: Math.round(fps * 100) / 100,
    duration: Number(j.format.duration ?? v.duration ?? 0),
    videoCodec: v.codec_name,
    audioCodec: a?.codec_name ?? null,
    hasAudio: !!a,
    sizeBytes: Number(j.format.size ?? 0),
    pixFmt: v.pix_fmt,
    sampleRate: a?.sample_rate ? Number(a.sample_rate) : undefined,
  };
}
