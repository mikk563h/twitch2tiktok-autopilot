/** Uses the MOCK Twitch server (tests/mocks/server.ts). */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startMockServer } from "./mocks/server";
import { resetDb } from "./helpers";
import { sql } from "@/lib/db";
import { setState, updateSettings } from "@/lib/settings";
import { runIncrementalScan, getSyncState, fetchClipsWindow, runHistoricalImport } from "@/lib/twitch/monitor";
import { queue } from "@/lib/queue";

let mock: Awaited<ReturnType<typeof startMockServer>>;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** Runs the first-start baseline, then pretends it happened an hour ago. */
async function baseline() {
  await runIncrementalScan();
  const s = await getSyncState();
  await setState("twitch.sync", { ...s, baselineDoneAt: iso(3600_000), lastSuccessEnd: iso(30_000), lastDeepAt: new Date().toISOString() });
}

beforeAll(async () => {
  mock = await startMockServer();
  Object.assign(process.env, mock.env);
});
afterAll(async () => mock.close());
beforeEach(async () => {
  await resetDb();
  mock.reset();
});

describe("Twitch clip monitor (MOCK)", () => {
  it("baseline ved første start: eksisterende clips registreres men køes ikke", async () => {
    mock.state.s.clips = [
      { id: "old1", created_at: iso(5 * 86400_000), title: "gammelt", view_count: 500 },
      { id: "old2", created_at: iso(400 * 86400_000), title: "meget gammelt", view_count: 9000 },
    ];
    const r = await runIncrementalScan();
    expect(r?.kind).toBe("baseline");
    const rows = await sql()`SELECT twitch_clip_id, status FROM clips ORDER BY twitch_clip_id`;
    expect(rows.map((x) => [x.twitch_clip_id, x.status])).toEqual([["old1", "BASELINE"], ["old2", "BASELINE"]]);
    expect((await getSyncState()).baselineDoneAt).toBeTruthy();
    expect(await queue("process").count()).toBe(0);
  });

  it("registrerer nye clips efter baseline og sætter dem i kø", async () => {
    await baseline();
    mock.state.s.clips.push({ id: "new1", created_at: iso(10_000), title: "nyt clip", view_count: 1, game_id: "32399" });
    const r = await runIncrementalScan();
    expect(r).toMatchObject({ kind: "incremental", inserted: 1 });
    const [row] = await sql()`SELECT * FROM clips WHERE twitch_clip_id = 'new1'`;
    expect(row.status).toBe("DISCOVERED");
    expect(row.game_name).toBe("Counter-Strike");
    expect(await queue("process").getJob(`process-${row.id}`)).toBeTruthy();
  });

  it("pagination: henter alle sider selvom resultater er sorteret efter visninger", async () => {
    await baseline();
    for (let i = 0; i < 250; i++) mock.state.s.clips.push({ id: `p${i}`, created_at: iso(60_000 + i * 1000), title: `clip ${i}`, view_count: Math.floor(Math.random() * 1000) });
    const r = await runIncrementalScan();
    expect(r?.inserted).toBe(250);
    const clipCalls = mock.state.s.twitchRequests.filter((q) => q.path === "/clips" && q.query.get("started_at"));
    expect(clipCalls.some((q) => q.query.get("after"))).toBe(true);
  });

  it("splitter tætte vinduer (≥900 clips) i mindre intervaller", async () => {
    for (let i = 0; i < 1500; i++) mock.state.s.clips.push({ id: `d${i}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), title: "x", view_count: i });
    const stats = { requests: 0, seen: 0, inserted: 0 };
    const res = await fetchClipsWindow("1234", new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 0, 1, 1)), stats);
    expect(res.length).toBe(1500);
  });

  it("overlap + ingen dobbeltregistrering ved gentagne scanninger", async () => {
    await baseline();
    mock.state.s.clips.push({ id: "dup", created_at: iso(5000), title: "dup", view_count: 1 });
    await runIncrementalScan();
    await runIncrementalScan();
    await runIncrementalScan();
    const [{ n }] = await sql()`SELECT count(*)::int AS n FROM clips WHERE twitch_clip_id = 'dup'`;
    expect(n).toBe(1);
    const [{ e }] = await sql()`SELECT count(*)::int AS e FROM clip_events ce JOIN clips c ON c.id = ce.clip_id WHERE c.twitch_clip_id = 'dup' AND ce.message = 'Nyt clip opdaget'`;
    expect(e).toBe(1);
  });

  it("sent indekseret clip fanges af overlap-vinduet", async () => {
    await baseline();
    // Clip created 10 minutes ago but only visible in the API now (Twitch indexing lag).
    mock.state.s.clips.push({ id: "late", created_at: iso(10 * 60_000), title: "sent", view_count: 1 });
    await runIncrementalScan();
    const [row] = await sql()`SELECT status FROM clips WHERE twitch_clip_id = 'late'`;
    expect(row?.status).toBe("DISCOVERED");
  });

  it("recovery efter nedetid: backfill af hele perioden siden sidste succes", async () => {
    await runIncrementalScan();
    const s = await getSyncState();
    const sixHoursAgo = new Date(Date.now() - 6 * 3600_000).toISOString();
    await setState("twitch.sync", { ...s, baselineDoneAt: new Date(Date.now() - 7 * 3600_000).toISOString(), lastSuccessEnd: sixHoursAgo, lastDeepAt: new Date().toISOString() });
    mock.state.s.clips.push({ id: "during-outage-1", created_at: iso(5 * 3600_000), title: "a", view_count: 3 });
    mock.state.s.clips.push({ id: "during-outage-2", created_at: iso(2 * 3600_000), title: "b", view_count: 1 });
    const r = await runIncrementalScan();
    expect(r?.kind).toBe("backfill");
    expect(r?.inserted).toBe(2);
  });

  it("håndterer Twitch rate limit (429) med retry", async () => {
    await baseline();
    mock.state.s.twitch429Once = true;
    mock.state.s.clips.push({ id: "rl", created_at: iso(1000), title: "rl", view_count: 1 });
    const r = await runIncrementalScan();
    expect(r?.inserted).toBe(1);
  });

  it("historisk import sætter baseline-clips i kø", async () => {
    mock.state.s.clips = [{ id: "h1", created_at: iso(3 * 86400_000), title: "h", view_count: 1 }];
    await runIncrementalScan();
    await updateSettings("automation", { autoEdit: true });
    const r = await runHistoricalImport(new Date(Date.now() - 10 * 86400_000), new Date());
    expect(r.queued).toBe(1);
    const [row] = await sql()`SELECT status, origin FROM clips WHERE twitch_clip_id = 'h1'`;
    expect(row).toMatchObject({ status: "QUEUED", origin: "historical" });
  });
});
