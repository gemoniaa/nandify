/*
 * Smart shuffle scoring. Pure functions (no network), so they are easy to test.
 *
 * Every seed song contributes its "up next" list. A song suggested by several seeds (several things the
 * listener likes) scores higher, artists the listener plays a lot get a boost, artists just played get
 * a small penalty so the mix stays varied, and a little jitter keeps each refresh fresh.
 * "Vibe" matching: style words in titles (lofi, slowed, acoustic, remix ...), the script of the title
 * (Hindi/Tamil/Korean/Latin ...), and song length are compared with the songs being played, so the
 * next pick sounds like the same kind of song. Junk (live, reaction, karaoke, jukebox, 10h loops) is dropped.
 */

export const splitNames = (v) => String(v ?? '').split('|').map((s) => s.trim()).filter(Boolean);
export const artistKey = (t) => String(t?.artist || '').split(/,|&/)[0].trim().toLowerCase();

const STYLE_WORDS = ['lofi', 'lo-fi', 'slowed', 'reverb', 'sped up', 'speed up', 'acoustic', 'unplugged', 'remix', 'mashup', 'instrumental', 'piano', 'cover', 'bass', 'phonk', 'edm', 'rap', 'hip hop', 'rock', 'sad', 'romantic', 'party', 'chill', 'study', 'workout', 'devotional', 'bhajan', 'ghazal', 'qawwali', 'punjabi', 'tamil', 'telugu', 'malayalam', 'kannada', 'bhojpuri', 'k-pop', 'kpop', 'arijit'];
const JUNK = /\b(karaoke|jukebox|reaction|full album|nonstop|non-stop|10 hours?|1 hour|podcast|interview|tutorial|trailer|live at|live from|teaser|shorts?)\b/i;

const scriptOf = (str) => {
  const m = String(str || '');
  if (/[\u0900-\u097F]/.test(m)) return 'deva';
  if (/[\u0B80-\u0BFF]/.test(m)) return 'tamil';
  if (/[\u0C00-\u0C7F]/.test(m)) return 'telugu';
  if (/[\uAC00-\uD7AF]/.test(m)) return 'hangul';
  if (/[\u3040-\u30FF\u4E00-\u9FFF]/.test(m)) return 'cjk';
  if (/[\u0600-\u06FF]/.test(m)) return 'arabic';
  return 'latin';
};

const styleTags = (t) => {
  const h = `${t?.title || ''} ${t?.artist || ''}`.toLowerCase();
  return new Set(STYLE_WORDS.filter((w) => h.includes(w)));
};

export function vibeProfile(lists, titles, pos = [], neg = []) {
  const tags = new Map();
  const scripts = new Map();
  const durs = [];
  lists.forEach(({ weight, tracks }, i) => {
    const w = weight * (i === 0 ? 2 : 1);
    const seedTitle = { title: titles[i] || '' };
    for (const g of styleTags(seedTitle)) tags.set(g, (tags.get(g) || 0) + w * 2);
    scripts.set(scriptOf(seedTitle.title), (scripts.get(scriptOf(seedTitle.title)) || 0) + w * 2);
    tracks.slice(0, 8).forEach((t) => {
      for (const g of styleTags(t)) tags.set(g, (tags.get(g) || 0) + w * 0.4);
      scripts.set(scriptOf(t.title), (scripts.get(scriptOf(t.title)) || 0) + w * 0.4);
      if (t.duration > 60 && t.duration < 600) durs.push(t.duration);
    });
  });
  // What the listener finished / liked pulls the vibe towards it; what they skipped pushes it away.
  const bad = new Map();
  pos.forEach((l) => {
    for (const g of styleTags({ title: l })) tags.set(g, (tags.get(g) || 0) + 0.8);
    const sc = scriptOf(l);
    scripts.set(sc, (scripts.get(sc) || 0) + 0.8);
  });
  neg.forEach((l) => { for (const g of styleTags({ title: l })) bad.set(g, (bad.get(g) || 0) + 1); });
  durs.sort((x, y) => x - y);
  const topScript = [...scripts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || 'latin';
  return { bad, tags, topScript, medDur: durs.length ? durs[durs.length >> 1] : 210, tagMax: Math.max(1, ...tags.values()) };
}

function vibeScore(t, vp) {
  let s = 0;
  const mine = styleTags(t);
  for (const g of mine) s += 0.1 * ((vp.tags.get(g) || 0) / vp.tagMax) - (vp.tags.has(g) ? 0 : 0.03);
  for (const g of vp.tags.keys()) if (!mine.has(g) && (vp.tags.get(g) || 0) / vp.tagMax > 0.6) s -= 0.04;
  for (const g of mine) if (vp.bad?.has(g) && !vp.tags.has(g)) s -= 0.1 * Math.min(2, vp.bad.get(g));
  s += scriptOf(t.title) === vp.topScript ? 0.08 : -0.12;
  if (t.duration) {
    const d = Math.abs(t.duration - vp.medDur) / vp.medDur;
    s += d < 0.25 ? 0.05 : d > 0.8 ? -0.1 : 0;
    if (t.duration > 600 || t.duration < 60) s -= 0.2;
  }
  return s;
}

export function scoreCandidates(lists, {
  affinity = new Set(), avoid = new Set(), exclude = new Set(), jitter = 0.04,
  vibe = null, love = new Set(), hate = new Set(), hour = new Set(),
} = {}) {
  const byId = new Map();
  for (const { weight, tracks } of lists) {
    tracks.forEach((t, rank) => {
      if (exclude.has(t.id)) return;
      const e = byId.get(t.id) || { track: t, score: 0, seeds: 0 };
      e.score += weight / (rank + 3);
      e.seeds += 1;
      byId.set(t.id, e);
    });
  }
  return [...byId.values()]
    .map((e) => {
      const k = artistKey(e.track);
      let s = e.score + 0.12 * (e.seeds - 1);
      if (affinity.has(k)) s += 0.15;
      if (avoid.has(k)) s -= 0.1;
      if (love.has(k)) s += 0.2;
      if (hate.has(k)) s -= 0.35;
      if (hour.has(k)) s += 0.1;
      if (vibe) s += vibeScore(e.track, vibe);
      if (JUNK.test(e.track.title || '')) s -= 0.5;
      return { ...e.track, score: Number((s + Math.random() * jitter).toFixed(4)) };
    })
    .sort((a, b) => b.score - a.score);
}

// At most two songs per artist, like a real mix.
export function pickMix(ranked, limit) {
  const per = new Map();
  const results = [];
  for (const t of ranked) {
    const k = artistKey(t);
    const n = per.get(k) || 0;
    if (n >= 2) continue;
    per.set(k, n + 1);
    results.push(t);
    if (results.length >= limit) break;
  }
  return results;
}
