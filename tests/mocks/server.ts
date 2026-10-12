/**
 * MOCK SERVER — simulates Twitch Helix/OAuth, TikTok Content Posting API and the Anthropic
 * Messages API for automated integration tests. Passing tests against this server do NOT prove
 * that the real services accept our requests; see scripts/live-e2e.ts for real checks.
 */
import http from "node:http";
import fs from "node:fs";
import type { AddressInfo } from "node:net";

export interface MockClip { id: string; created_at: string; title: string; view_count: number; game_id?: string; duration?: number }

export interface MockState {
  clips: MockClip[];
  twitchRequests: Array<{ path: string; query: URLSearchParams }>;
  twitch429Once: boolean;
  downloadForbidden: boolean;
  clipFile: string | null;
  // TikTok
  tiktokTokens: { code: string; access: string; refresh: string; scope: string };
  tiktokRequests: Array<{ path: string; body: unknown }>;
  initError: string | null;
  initCount: number;
  initDropResponse: boolean;
  uploads: Map<string, { size: number; received: number; chunks: number }>;
  failUploadChunks: number;
  statusSequence: string[];
  statusFailReason: string | null;
  statusNetworkFail: number;
  privacyOptions: string[];
  publishedIds: string[];
  // Anthropic
  aiResponses: Array<Record<string, unknown> | ((body: unknown) => Record<string, unknown>)>;
  /** Answers every request when the queue above is empty. */
  aiResponder: ((body: unknown) => Record<string, unknown>) | null;
  aiRequests: unknown[];
}

export function freshState(): MockState {
  return {
    clips: [], twitchRequests: [], twitch429Once: false, downloadForbidden: false, clipFile: null,
    tiktokTokens: { code: "good-code", access: "tt-access-1", refresh: "tt-refresh-1", scope: "user.info.basic,video.publish,video.upload" },
    tiktokRequests: [], initError: null, initCount: 0, initDropResponse: false, uploads: new Map(), failUploadChunks: 0,
    statusSequence: ["PROCESSING_UPLOAD", "PUBLISH_COMPLETE"], statusFailReason: null, statusNetworkFail: 0,
    privacyOptions: ["SELF_ONLY"], publishedIds: [],
    aiResponses: [], aiResponder: null, aiRequests: [],
  };
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export async function startMockServer() {
  const state: { s: MockState } = { s: freshState() };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const s = state.s;
    const body = await readBody(req);
    try {
      // ---------------- Twitch ----------------
      if (url.pathname === "/twitch/oauth2/token") {
        const p = new URLSearchParams(body.toString());
        if (p.get("grant_type") === "client_credentials") return json(res, 200, { access_token: "app-token", expires_in: 5000000, token_type: "bearer" });
        if (p.get("grant_type") === "authorization_code") return json(res, 200, { access_token: "user-token", refresh_token: "user-refresh", expires_in: 14000, scope: ["editor:manage:clips"] });
        if (p.get("grant_type") === "refresh_token") return json(res, 200, { access_token: "user-token-2", refresh_token: "user-refresh-2", expires_in: 14000, scope: ["editor:manage:clips"] });
      }
      if (url.pathname === "/twitch/oauth2/validate") return json(res, 200, { login: "editoruser", user_id: "999", scopes: ["editor:manage:clips"] });
      if (url.pathname.startsWith("/twitch/helix/")) {
        const path = url.pathname.replace("/twitch/helix", "");
        s.twitchRequests.push({ path, query: url.searchParams });
        if (s.twitch429Once) {
          s.twitch429Once = false;
          return json(res, 429, { message: "Too Many Requests" }, { "Ratelimit-Remaining": "0", "Ratelimit-Reset": String(Math.ceil(Date.now() / 1000) + 1) });
        }
        if (path === "/users") return json(res, 200, { data: [{ id: "1234", login: url.searchParams.get("login"), display_name: "SondergaardLOL", profile_image_url: "" }] });
        if (path === "/games") return json(res, 200, { data: url.searchParams.getAll("id").map((id) => ({ id, name: id === "32399" ? "Counter-Strike" : `Game ${id}` })) });
        if (path === "/clips") {
          const start = url.searchParams.get("started_at");
          const end = url.searchParams.get("ended_at");
          let list = s.clips.filter((c) => (!start || c.created_at >= start) && (!end || c.created_at <= end));
          list = [...list].sort((a, b) => b.view_count - a.view_count); // Twitch orders by views, not time
          const first = Number(url.searchParams.get("first") ?? 20);
          const offset = Number(url.searchParams.get("after") ?? 0);
          const page = list.slice(offset, offset + first);
          const next = offset + first < list.length ? String(offset + first) : undefined;
          return json(res, 200, {
            data: page.map((c) => ({
              id: c.id, url: `http://mock/clip/${c.id}`, embed_url: `http://mock/embed/${c.id}`, broadcaster_id: "1234", broadcaster_name: "SondergaardLOL",
              creator_id: "5", creator_name: "viewer", video_id: "", game_id: c.game_id ?? "32399", language: "da", title: c.title, view_count: c.view_count,
              created_at: c.created_at, thumbnail_url: "", duration: c.duration ?? 20, vod_offset: null,
            })),
            pagination: next ? { cursor: next } : {},
          });
        }
        if (path === "/clips/downloads") {
          if (s.downloadForbidden) return json(res, 403, { message: "user is not an editor" });
          const port = (server.address() as AddressInfo).port;
          return json(res, 200, { data: url.searchParams.getAll("clip_id").map((id) => ({ clip_id: id, landscape_download_url: `http://127.0.0.1:${port}/files/${id}.mp4`, portrait_download_url: null })) });
        }
      }
      if (url.pathname.startsWith("/files/")) {
        if (!s.clipFile) return json(res, 404, {});
        res.writeHead(200, { "Content-Type": "video/mp4" });
        return fs.createReadStream(s.clipFile).pipe(res);
      }

      // ---------------- TikTok ----------------
      if (url.pathname === "/tiktok/v2/oauth/token/") {
        const p = new URLSearchParams(body.toString());
        const t = s.tiktokTokens;
        if (p.get("grant_type") === "authorization_code") {
          if (p.get("code") !== t.code) return json(res, 400, { error: "invalid_grant", error_description: "bad code" });
          return json(res, 200, { access_token: t.access, expires_in: 86400, open_id: "open-1", refresh_token: t.refresh, refresh_expires_in: 31536000, scope: t.scope, token_type: "Bearer" });
        }
        if (p.get("grant_type") === "refresh_token") {
          if (p.get("refresh_token") !== t.refresh) return json(res, 400, { error: "invalid_grant", error_description: "refresh token invalid" });
          t.access = `${t.access}-r`;
          t.refresh = `${t.refresh}-r`;
          return json(res, 200, { access_token: t.access, expires_in: 86400, open_id: "open-1", refresh_token: t.refresh, refresh_expires_in: 31536000, scope: t.scope, token_type: "Bearer" });
        }
      }
      if (url.pathname.startsWith("/tiktok/v2/")) {
        const path = url.pathname.replace("/tiktok", "");
        const auth = req.headers.authorization ?? "";
        const parsed = body.length && req.headers["content-type"]?.includes("json") ? JSON.parse(body.toString()) : null;
        s.tiktokRequests.push({ path, body: parsed });
        if (path === "/v2/user/info/") return json(res, 200, { data: { user: { open_id: "open-1", display_name: "Test Creator", username: "testcreator", avatar_url: "" } }, error: { code: "ok", message: "" } });
        if (auth !== `Bearer ${s.tiktokTokens.access}`) return json(res, 401, { error: { code: "access_token_invalid", message: "token invalid" } });
        if (path === "/v2/post/publish/creator_info/query/") {
          return json(res, 200, { data: { creator_avatar_url: "", creator_username: "testcreator", creator_nickname: "Test Creator", privacy_level_options: s.privacyOptions, comment_disabled: false, duet_disabled: false, stitch_disabled: true, max_video_post_duration_sec: 600 }, error: { code: "ok", message: "" } });
        }
        if (path === "/v2/post/publish/video/init/" || path === "/v2/post/publish/inbox/video/init/") {
          s.initCount++;
          if (s.initError) return json(res, 200, { error: { code: s.initError, message: s.initError } });
          const id = `v_pub_${s.initCount}`;
          const port = (server.address() as AddressInfo).port;
          s.uploads.set(id, { size: parsed.source_info.video_size, received: 0, chunks: 0 });
          if (s.initDropResponse) { s.initDropResponse = false; req.socket.destroy(); return; }
          return json(res, 200, { data: { publish_id: id, upload_url: `http://127.0.0.1:${port}/tiktok-upload/${id}` }, error: { code: "ok", message: "" } });
        }
        if (path === "/v2/post/publish/status/fetch/") {
          if (s.statusNetworkFail > 0) { s.statusNetworkFail--; req.socket.destroy(); return; }
          const up = s.uploads.get(parsed.publish_id);
          if (!up) return json(res, 200, { error: { code: "invalid_publish_id", message: "unknown" } });
          if (up.received < up.size) return json(res, 200, { data: { status: "PROCESSING_UPLOAD", uploaded_bytes: up.received }, error: { code: "ok", message: "" } });
          const st = s.statusSequence.length > 1 ? s.statusSequence.shift()! : s.statusSequence[0];
          if (st === "PUBLISH_COMPLETE" && !s.publishedIds.includes(parsed.publish_id)) s.publishedIds.push(parsed.publish_id);
          return json(res, 200, { data: { status: st, fail_reason: st === "FAILED" ? s.statusFailReason : undefined, uploaded_bytes: up.received, publicaly_available_post_id: st === "PUBLISH_COMPLETE" ? [7000000000 + Number(String(parsed.publish_id).split("_").pop())] : [] }, error: { code: "ok", message: "" } });
        }
      }
      if (url.pathname.startsWith("/tiktok-upload/")) {
        const id = url.pathname.split("/").pop()!;
        const up = s.uploads.get(id);
        if (!up) return json(res, 404, {});
        if (s.failUploadChunks > 0) { s.failUploadChunks--; req.socket.destroy(); return; }
        const m = String(req.headers["content-range"]).match(/bytes (\d+)-(\d+)\/(\d+)/);
        if (!m || Number(m[3]) !== up.size || Number(m[2]) - Number(m[1]) + 1 !== body.length) return json(res, 400, { error: "bad range" });
        up.received = Number(m[2]) + 1;
        up.chunks++;
        res.writeHead(up.received >= up.size ? 201 : 206);
        return res.end();
      }

      // ---------------- Anthropic ----------------
      if (url.pathname === "/anthropic/v1/messages") {
        const parsed = JSON.parse(body.toString());
        s.aiRequests.push(parsed);
        const next = s.aiResponses.shift() ?? s.aiResponder ?? undefined;
        if (!next) return json(res, 500, { type: "error", error: { type: "api_error", message: "no mock response queued" } });
        const payload = typeof next === "function" ? next(parsed) : next;
        return json(res, 200, {
          id: `msg_${s.aiRequests.length}`, type: "message", role: "assistant", model: parsed.model,
          content: [{ type: "text", text: JSON.stringify(payload) }], stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 1000, output_tokens: 200 },
        });
      }
      json(res, 404, { error: "mock: no route", path: url.pathname });
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  return {
    state,
    base,
    env: {
      TWITCH_API_BASE: `${base}/twitch/helix`,
      TWITCH_AUTH_BASE: `${base}/twitch/oauth2`,
      TIKTOK_API_BASE: `${base}/tiktok`,
      ANTHROPIC_BASE_URL: `${base}/anthropic`,
    },
    reset() { state.s = freshState(); },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
