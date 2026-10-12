/** Pure title/hashtag/caption logic — no I/O, fully unit tested. */

const GENERIC_PATTERNS = [
  /vildeste (øjeblik|moment|clip)/i,
  /gør det (sgu )?igen/i,
  /(endnu et|et helt) (sindssygt|vildt|crazy) clip/i,
  /det her er (for|så) vildt/i,
  /tror ikke (dine|jeres) egne øjne/i,
  /^(vildt|sindssygt|crazy|omg|wow)[!.]*$/i,
  /bedste clip (nogensinde|ever)/i,
];

const EMOJI = /\p{Extended_Pictographic}(‍\p{Extended_Pictographic}|️)*/gu;

export function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(EMOJI, "")
    .replace(/sondergaard(lol)?|søndergaard(lol)?/g, "")
    .replace(/[^\p{L}\p{N} ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

export function similarity(a: string, b: string): number {
  const x = normalizeForCompare(a);
  const y = normalizeForCompare(b);
  if (!x || !y) return x === y ? 1 : 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

export function cleanTitle(raw: string, allowEmoji: boolean): string {
  let t = raw.replace(/\s+/g, " ").trim();
  t = t.replace(/^["'“”„«»]+|["'“”„«»]+$/g, "").trim();
  t = t.replace(/(^|\s)#[\p{L}\p{N}_]+/gu, "").trim(); // hashtags belong in the caption, not the title
  if (!allowEmoji) t = t.replace(EMOJI, "").replace(/\s+/g, " ").trim();
  return t;
}

export interface TitleCheck { ok: boolean; title: string; reason?: string }

export function validateTitle(raw: string, opts: { maxLength: number; allowEmoji: boolean; forbidden: string[]; recent: string[] }): TitleCheck {
  const title = cleanTitle(raw ?? "", opts.allowEmoji);
  if (title.length < 3) return { ok: false, title, reason: "tom eller for kort titel" };
  if ([...title].length > opts.maxLength) return { ok: false, title, reason: `titlen er over ${opts.maxLength} tegn` };
  const norm = normalizeForCompare(title);
  if (!norm) return { ok: false, title, reason: "titlen indeholder ingen ord" };
  for (const f of opts.forbidden) {
    const nf = normalizeForCompare(f);
    if (nf && (norm === nf || similarity(title, f) >= 0.8 || (nf.length > 8 && norm.includes(nf)))) return { ok: false, title, reason: `forbudt/generisk titel ("${f}")` };
  }
  if (GENERIC_PATTERNS.some((r) => r.test(title))) return { ok: false, title, reason: "generisk titel" };
  for (const r of opts.recent) {
    if (similarity(title, r) >= 0.85) return { ok: false, title, reason: `næsten identisk med en tidligere titel ("${r}")` };
  }
  return { ok: true, title };
}

/** The original Twitch title as fallback: cleaned and shortened at a word boundary. */
export function fallbackTitle(twitchTitle: string | null | undefined, maxLength: number): string | null {
  const t = (twitchTitle ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if ([...t].length <= maxLength) return t;
  const cut = [...t].slice(0, maxLength - 1).join("");
  const sp = cut.lastIndexOf(" ");
  return `${(sp > maxLength * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, "")}…`;
}

export function normalizeTag(raw: string): string | null {
  const t = raw.trim().replace(/^#+/, "").replace(/\s+/g, "");
  if (!/^[\p{L}\p{N}_]+$/u.test(t)) return null;
  if (t.length < 2 || t.length > 50) return null;
  if (/^\d+$/.test(t)) return null;
  return t;
}

/** Fixed tags first (always win), then AI tags, de-duplicated case-insensitively, capped at max. */
export function buildHashtags(fixed: string[], ai: string[], opts: { max: number; aiEnabled: boolean }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const t = normalizeTag(raw);
    if (!t || seen.has(t.toLowerCase()) || out.length >= opts.max) return;
    seen.add(t.toLowerCase());
    out.push(t);
  };
  fixed.forEach(add);
  if (opts.aiEnabled) ai.forEach(add);
  return out;
}

/** UTF-16 length is what TikTok counts (title max 2200 UTF-16 units). */
export function utf16Length(s: string): number {
  return s.length;
}

/** Title + blank line + hashtags. Drops trailing (AI first, as they come last) tags if over the limit. */
export function composeCaption(title: string, tags: string[], maxLength: number): { caption: string; tags: string[] } {
  const kept = [...tags];
  const make = () => (kept.length ? `${title}\n\n${kept.map((t) => `#${t}`).join(" ")}` : title);
  while (kept.length && utf16Length(make()) > maxLength) kept.pop();
  let caption = make();
  if (utf16Length(caption) > maxLength) caption = caption.slice(0, maxLength);
  return { caption, tags: kept };
}
