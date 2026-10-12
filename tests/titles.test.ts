import { describe, expect, it } from "vitest";
import { buildHashtags, composeCaption, fallbackTitle, normalizeTag, validateTitle } from "@/lib/ai/titles";
import { DEFAULT_FORBIDDEN_TITLES } from "@/lib/settings";

const opts = { maxLength: 70, allowEmoji: false, forbidden: DEFAULT_FORBIDDEN_TITLES, recent: [] as string[] };

describe("titelvalidering", () => {
  it("accepterer en konkret titel", () => {
    expect(validateTitle("Han clutcher 1v3 med en Deagle på Mirage", opts)).toMatchObject({ ok: true });
  });
  it.each(DEFAULT_FORBIDDEN_TITLES)("afviser forbudt titel: %s", (t) => {
    expect(validateTitle(t, opts).ok).toBe(false);
  });
  it("afviser varianter af forbudte titler og generiske floskler", () => {
    expect(validateTitle("Søndergaard gør det igen!", opts).ok).toBe(false);
    expect(validateTitle("Det her er for vildt 😳", opts).ok).toBe(false);
    expect(validateTitle("SondergaardLOLs vildeste øjeblik!!", opts).ok).toBe(false);
  });
  it("afviser for lange titler og næsten-gentagelser", () => {
    expect(validateTitle("a ".repeat(40), opts).ok).toBe(false);
    expect(validateTitle("Han clutcher 1v3 med en Deagle på Mirage", { ...opts, recent: ["Han clutcher 1v3 med Deagle på Mirage"] }).ok).toBe(false);
  });
  it("fjerner emoji når det er slået fra og hashtags fra titlen", () => {
    expect(validateTitle("Ninja-defuse i sidste sekund 🔥 #cs2", opts).title).toBe("Ninja-defuse i sidste sekund");
    expect(validateTitle("Ninja-defuse i sidste sekund 🔥", { ...opts, allowEmoji: true }).title).toBe("Ninja-defuse i sidste sekund 🔥");
  });
});

describe("fallback til Twitch-titel", () => {
  it("bruger Twitch-titlen og forkorter ved ordgrænse", () => {
    expect(fallbackTitle("  kort titel  ", 70)).toBe("kort titel");
    const long = fallbackTitle("Det her er en meget lang twitch titel som bliver ved og ved og ved og ved og ved", 40)!;
    expect([...long].length).toBeLessThanOrEqual(40);
    expect(long.endsWith("…")).toBe(true);
  });
  it("returnerer null når titlen mangler (→ fejlkø)", () => {
    expect(fallbackTitle("", 70)).toBeNull();
    expect(fallbackTitle(null, 70)).toBeNull();
  });
});

describe("hashtags", () => {
  it("validerer og normaliserer", () => {
    expect(normalizeTag("#TwitchDK")).toBe("TwitchDK");
    expect(normalizeTag("dansk streamer")).toBe("danskstreamer");
    expect(normalizeTag("bad-tag!")).toBeNull();
    expect(normalizeTag("#1")).toBeNull();
  });
  it("faste hashtags prioriteres, dubletter fjernes, maks respekteres", () => {
    const tags = buildHashtags(["sondergaard", "twitchdk", "danskstreamer"], ["CS2", "TwitchDK", "clutch", "counterstrike"], { max: 5, aiEnabled: true });
    expect(tags).toEqual(["sondergaard", "twitchdk", "danskstreamer", "CS2", "clutch"]);
  });
  it("AI-hashtags kan slås fra", () => {
    expect(buildHashtags(["a1", "b2"], ["cs2"], { max: 10, aiEnabled: false })).toEqual(["a1", "b2"]);
  });
  it("caption overholder længdegrænsen ved at droppe de sidste tags", () => {
    const { caption, tags } = composeCaption("Titel", ["sondergaard", "twitchdk", "cs2clutches"], 32);
    expect(caption.length).toBeLessThanOrEqual(32);
    expect(tags).toEqual(["sondergaard", "twitchdk"]);
    expect(caption).toBe("Titel\n\n#sondergaard #twitchdk");
  });
});
