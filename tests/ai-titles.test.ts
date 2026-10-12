/** AI title generation against the MOCK Anthropic server — verifies our request shape and decision logic, not Claude itself. */
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startMockServer } from "./mocks/server";
import { makeTestClip, resetDb } from "./helpers";
import { analyzeClip, verifyTitle, type ClipAnalysis } from "@/lib/ai/claude";
import { decideTitle } from "@/lib/pipeline/process";
import { defaultSettings } from "@/lib/settings";
import { extractFrames } from "@/lib/media/analyze";
import { probe } from "@/lib/media/probe";

let mock: Awaited<ReturnType<typeof startMockServer>>;
const analysis = (over: Partial<ClipAnalysis> = {}): ClipAnalysis => ({
  observations: "Spilleren holder en AWP på Mirage og skyder to modstandere i mid.",
  spoken_summary: "Streameren råber 'to med AWP'en!'",
  understood: true, confidence: 0.86, is_funny: false,
  title: "To kills med AWP'en gennem mid på Mirage",
  title_evidence: "frame 3-5 viser to kills; tale bekræfter",
  game: "Counter-Strike 2", hashtags: ["cs2", "awp", "mirage"], action_focus_x: 0.48,
  facecam: { present: true, x: 0.78, y: 0.04, w: 0.2, h: 0.26, confidence: 0.9 }, ...over,
});
const clip = { id: 1, twitch_title: "AWP DOUBLE", manual_title: null, game_name: "Counter-Strike", broadcaster_name: "SondergaardLOL", duration: 20 };

beforeAll(async () => {
  mock = await startMockServer();
  Object.assign(process.env, mock.env);
});
afterAll(async () => mock.close());
beforeEach(async () => {
  await resetDb();
  mock.reset();
});

describe("AI-titel (MOCK Claude)", () => {
  it("sender frames + transskription og parser struktureret svar", async () => {
    const file = makeTestClip({ seconds: 6 });
    const frames = await extractFrames(file, await probe(file), 4, path.join(process.env.DATA_DIR!, "ai-frames"));
    mock.state.s.aiResponses.push(analysis());
    const r = await analyzeClip({ frames, transcript: { language: "da", text: "to med awpen", words: [{ text: "to", start: 1, end: 1.2 }, { text: "med", start: 1.2, end: 1.4 }, { text: "awpen", start: 1.4, end: 1.9 }], model: "base" }, twitchTitle: "AWP DOUBLE", gameName: "CS", broadcaster: "S", duration: 6, maxTitleLength: 70, allowEmoji: false, recentTitles: ["Tidligere titel"] });
    expect(r.analysis.title).toBe("To kills med AWP'en gennem mid på Mirage");
    const req = mock.state.s.aiRequests[0] as { model: string; output_config: { format: { type: string } }; fallbacks: string; messages: Array<{ content: Array<{ type: string; text?: string }> }> };
    expect(req.model).toBe("claude-opus-5-5");
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.fallbacks).toBe("default");
    const content = req.messages[0].content;
    expect(content.filter((b) => b.type === "image")).toHaveLength(4);
    expect(content.at(-1)!.text).toContain("to med awpen");
    expect(content.at(-1)!.text).toContain("Tidligere titel");
  });

  it("valideret + faktatjekket AI-titel bruges", async () => {
    mock.state.s.aiResponses.push({ supported: true, problems: "" });
    const d = await decideTitle(clip, analysis(), null, defaultSettings(), { verify: verifyTitle, recent: [] });
    expect(d).toMatchObject({ title: "To kills med AWP'en gennem mid på Mirage", source: "ai" });
  });

  it("usikker AI → fallback til Twitch-titel", async () => {
    const d = await decideTitle(clip, analysis({ confidence: 0.3 }), null, defaultSettings(), { recent: [] });
    expect(d).toMatchObject({ title: "AWP DOUBLE", source: "twitch" });
  });

  it("AI forstår ikke klippet → fallback til Twitch-titel", async () => {
    const d = await decideTitle(clip, analysis({ understood: false }), null, defaultSettings(), { recent: [] });
    expect(d.source).toBe("twitch");
  });

  it("forbudt titel afvises; nyt forsøg med begrundelse", async () => {
    let retried: { title: string; reason: string } | null = null;
    const d = await decideTitle(clip, analysis({ title: "SondergaardLOL gør det igen" }), null, defaultSettings(), {
      recent: [],
      retry: async (rej) => { retried = rej; return analysis({ title: "Dobbelt AWP-kill i mid" }); },
    });
    expect(retried!.reason).toMatch(/forbudt|generisk/);
    expect(d).toMatchObject({ title: "Dobbelt AWP-kill i mid", source: "ai" });
  });

  it("faktatjek afviser opdigtet indhold → fallback", async () => {
    mock.state.s.aiResponses.push({ supported: false, problems: "der ses ingen ace" });
    const d = await decideTitle(clip, analysis({ title: "Han laver et ace på 5 sekunder" }), null, defaultSettings(), { verify: verifyTitle, recent: [] });
    expect(d.source).toBe("twitch");
    expect(d.candidates[0].reason).toContain("der ses ingen ace");
  });

  it("AI-fejl (API nede) → Twitch-titel; ingen titel overhovedet → null (fejlkø)", async () => {
    const d1 = await decideTitle(clip, null, null, defaultSettings(), { recent: [] });
    expect(d1).toMatchObject({ title: "AWP DOUBLE", source: "twitch" });
    const d2 = await decideTitle({ ...clip, twitch_title: "" }, null, null, defaultSettings(), { recent: [] });
    expect(d2.title).toBeNull();
  });

  it("manuel titel vinder altid", async () => {
    const d = await decideTitle({ ...clip, manual_title: "Min egen titel" }, analysis(), null, defaultSettings(), { recent: [] });
    expect(d).toMatchObject({ title: "Min egen titel", source: "manual" });
  });

  it("API-fejl fra Claude kastes (så pipelinen kan falde tilbage)", async () => {
    await expect(analyzeClip({ frames: [], transcript: null, twitchTitle: "x", gameName: null, broadcaster: null, duration: 5, maxTitleLength: 70, allowEmoji: false, recentTitles: [] })).rejects.toThrow();
  });
});
