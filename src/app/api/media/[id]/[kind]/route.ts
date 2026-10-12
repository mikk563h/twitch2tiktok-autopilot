import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { NextResponse, type NextRequest } from "next/server";
import { getClip } from "@/lib/clips";
import { config } from "@/lib/config";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/** Streams clip media (source/render MP4, thumbnail) with HTTP Range support for the video player. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string; kind: string }> }) {
  try { await requireSession(); } catch { return new NextResponse("unauthorized", { status: 401 }); }
  const { id, kind } = await ctx.params;
  const clip = await getClip(Number(id));
  if (!clip) return new NextResponse("not found", { status: 404 });
  const file = kind === "source" ? clip.source_path : kind === "render" ? clip.render_path : kind === "thumb" ? clip.render_thumb_path : null;
  if (!file || !path.resolve(file).startsWith(config.dataDir) || !fs.existsSync(file)) return new NextResponse("not found", { status: 404 });
  const size = fs.statSync(file).size;
  const type = file.endsWith(".jpg") ? "image/jpeg" : "video/mp4";
  const download = req.nextUrl.searchParams.get("download") === "1";
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=60" };
  if (download) headers["Content-Disposition"] = `attachment; filename="clip-${clip.id}-${kind}.mp4"`;
  const range = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return new NextResponse(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    const stream = Readable.toWeb(fs.createReadStream(file, { start, end })) as ReadableStream;
    return new NextResponse(stream, { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) } });
  }
  const stream = Readable.toWeb(fs.createReadStream(file)) as ReadableStream;
  return new NextResponse(stream, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
}
