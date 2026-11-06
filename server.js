import express from 'express';
import { Innertube, UniversalCache } from 'youtubei.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { vibeProfile, scoreCandidates, pickMix, splitNames, describeFocus } from './recommend.js';
import { mountStream } from './stream.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = String(process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const HOSTED = Boolean(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME || process.env.K_SERVICE);
const HOST = process.env.HOST || (HOSTED ? '0.0.0.0' : '127.0.0.1'); // local only unless a hosting service runs it
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const UA = { 'User-Agent': 'nandify/3.0 (local project)' };

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // so the real visitor address is used behind a hosting service

// Small per-visitor limits so a public site can not be hammered. Guests polling a session use the roomier one.
const buckets = new Map();
function limit(name, max) {
  return (req, res, next) => {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.reset < now) { b = { n: 0, reset: now + 60_000 }; buckets.set(key, b); }
    if (++b.n > max) return res.status(429).json({ error: 'Too many requests. Slow down a little.' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();
const limitTogether = limit('together', 400);
const limitApi = limit('api', 240);
const limitStream = limit('stream', 150);
app.use('/api', (req, res, next) => (req.path.startsWith('/together') ? limitTogether(req, res, next) : req.path.startsWith('/stream') ? limitStream(req, res, next) : limitApi(req, res, next)));

/* ------------------------------------------------------------------ */
/* YouTube.js session (created once, reused)                           */
/* ------------------------------------------------------------------ */

let ytPromise = null;
function getYT() {
  if (!ytPromise) {
    ytPromise = Innertube.create({ cache: new UniversalCache(false) }).catch((err) => {
      ytPromise = null; // allow a retry on the next request
      throw err;
    });
  }
  return ytPromise;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

function toText(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (typeof v.text === 'string') return v.text;
  if (Array.isArray(v.runs)) return v.runs.map((r) => r?.text || '').join('');
  const s = typeof v.toString === 'function' ? v.toString() : '';
  if (s && s !== '[object Object]') return s;
  return String(v.name || v.title || '');
}

function upsizeArt(url) {
  // Google-hosted album art ends in =w60-h60-... ; ask for a larger square.
  return url.replace(/=w\d+-h\d+[^/]*$/, '=w544-h544-l90-rj');
}

function normalize(item) {
  const id = item?.id || item?.video_id;
  if (!id || !ID_RE.test(id)) return null;

  const title = toText(item.title) || 'Unknown title';
  const artist =
    (Array.isArray(item.artists) && item.artists.map((a) => a?.name).filter(Boolean).join(', ')) ||
    item.author?.name ||
    item.channel?.name ||
    '';

  const art =
    item.thumbnail?.contents?.[0]?.url ||
    item.thumbnails?.[0]?.url ||
    `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
  const thumbnail = art.startsWith('//') ? `https:${art}` : upsizeArt(art);

  return {
    id,
    title,
    artist,
    duration: Number(item.duration?.seconds) || 0,
    thumbnail,
    album: toText(item.album?.name) || '',
  };
}

const searchCache = new Map(); // query -> { at, results }
const SEARCH_TTL = 5 * 60 * 1000;

const YT_API_KEY = String(process.env.YT_API_KEY || '').trim();

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

// Used only when the normal search is blocked (some hosting services are). Needs a free YouTube Data API key.
async function searchWithApiKey(q) {
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  u.search = new URLSearchParams({
    part: 'snippet', type: 'video', videoCategoryId: '10', videoEmbeddable: 'true', maxResults: '20', q, key: YT_API_KEY,
  }).toString();
  const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('YouTube search API answered ' + r.status);
  const d = await r.json();
  return (d.items || [])
    .filter((i) => i.id && ID_RE.test(i.id.videoId || ''))
    .map((i) => ({
      id: i.id.videoId,
      title: decodeEntities(i.snippet.title),
      artist: decodeEntities(i.snippet.channelTitle).replace(/\s*-\s*Topic$/i, ''),
      duration: 0,
      thumbnail: i.snippet.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${i.id.videoId}/mqdefault.jpg`,
    }));
}

async function searchTracks(q) {
  try {
    const found = await searchTracksInnertube(q);
    if (found.length || !YT_API_KEY) return found;
  } catch (err) {
    if (!YT_API_KEY) throw err;
    console.warn('[search] normal search failed, using the API key:', err.message);
  }
  return searchWithApiKey(q);
}

async function searchTracksInnertube(q) {
  const yt = await getYT();
  let tracks = [];

  // Prefer YouTube Music "Songs": cleaner titles, artists and square artwork.
  try {
    const res = await yt.music.search(q, { type: 'song' });
    for (const shelf of res.contents ?? []) {
      for (const item of shelf.contents ?? []) {
        const t = normalize(item);
        if (t) tracks.push(t);
      }
    }
  } catch (err) {
    console.warn('[search] music search failed, falling back:', err.message);
  }

  if (!tracks.length) {
    const res = await yt.search(q, { type: 'video' });
    tracks = (res.results ?? [])
      .filter((r) => r?.type === 'Video')
      .map(normalize)
      .filter(Boolean);
  }

  const seen = new Set();
  return tracks.filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 25);
}

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 120);
  if (!q) return res.json({ results: [] });

  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return res.json({ results: hit.results });

  try {
    const results = await searchTracks(q);
    if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(key, { at: Date.now(), results });
    res.json({ results });
  } catch (err) {
    console.error('[search]', err);
    res.status(502).json({ error: 'Search failed. Check your connection and try again.' });
  }
});

/* ------------------------------------------------------------------ */
/* Up next, smart shuffle recommendations and creators                 */
/* ------------------------------------------------------------------ */

// Panel items (YouTube Music "Up next") carry their art as a plain array, unlike search results.
function normalizePanelItem(item) {
  const v = item?.primary || item; // PlaylistPanelVideoWrapper -> .primary
  const id = v?.video_id || v?.id;
  if (!id || !ID_RE.test(id)) return null;
  const art = Array.isArray(v.thumbnail) ? v.thumbnail[v.thumbnail.length - 1]?.url : v.thumbnail?.contents?.[0]?.url;
  return {
    id,
    title: toText(v.title) || 'Unknown title',
    artist:
      (Array.isArray(v.artists) && v.artists.map((a) => a?.name).filter(Boolean).join(', ')) ||
      (typeof v.author === 'string' ? v.author : v.author?.name) ||
      '',
    duration: Number(v.duration?.seconds) || 0,
    thumbnail: art ? (art.startsWith('//') ? `https:${art}` : upsizeArt(art)) : `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    album: toText(v.album?.name) || '',
  };
}

const relatedCache = new Map(); // id -> { at, results }

async function relatedTracks(id) {
  const yt = await getYT();
  const panel = await yt.music.getUpNext(id);
  const out = [];
  for (const item of panel?.contents ?? []) {
    const t = normalizePanelItem(item);
    if (t && t.id !== id) out.push(t);
  }
  return out;
}

async function relatedFor(id, title) {
  const hit = relatedCache.get(id);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.results;
  let results;
  try {
    results = await relatedTracks(id);
  } catch {
    results = title ? (await searchTracks(title)).filter((t) => t.id !== id) : [];
  }
  if (results.length) {
    if (relatedCache.size > 100) relatedCache.delete(relatedCache.keys().next().value);
    relatedCache.set(id, { at: Date.now(), results });
  }
  return results;
}

app.get('/api/related/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid video id' });
  try {
    const q = String(req.query.q ?? '').trim().slice(0, 120);
    const results = await relatedFor(id, q);
    // The client sends the ids already in its queue so autoplay never repeats a song.
    const skip = new Set(String(req.query.exclude ?? '').split(',').filter((s) => ID_RE.test(s)));
    res.json({ results: results.filter((t) => !skip.has(t.id)).slice(0, 15) });
  } catch (err) {
    console.error('[related]', err.message);
    res.status(502).json({ error: 'Could not load related songs.' });
  }
});

// Extra candidate sources beyond YouTube's own "up next": the same album (movie), the artist's best songs,
// the co-artists (music director, duet partner) and a theme search built from the song's style and language.
const sourceCache = new Map();
const withTimeout = (p, ms = 5000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
async function cached(key, fn) {
  const hit = sourceCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL * 4) return hit.data;
  const data = await fn();
  if (data.length) { if (sourceCache.size > 200) sourceCache.delete(sourceCache.keys().next().value); sourceCache.set(key, { at: Date.now(), data }); }
  return data;
}
const albumSongs = (album, artist) => cached('al|' + album + '|' + artist, async () => {
  const yt = await getYT();
  const res = await yt.music.search(`${album} ${artist}`.trim(), { type: 'album' });
  let id = '';
  for (const shelf of res.contents ?? []) for (const it of shelf.contents ?? []) { id = id || it.id || it.endpoint?.payload?.browseId || ''; }
  if (!id) return [];
  const page = await yt.music.getAlbum(id);
  const out = [];
  for (const it of page?.contents ?? []) { const t = normalize(it); if (t) out.push({ ...t, artist: t.artist || artist, album: toText(page?.header?.title) || album }); }
  return out;
});
const artistSongs = (name) => cached('ar|' + name.toLowerCase(), async () => {
  const yt = await getYT();
  const [first] = await findArtists(name);
  if (!first) return [];
  const page = await yt.music.getArtist(first.id);
  const out = [];
  for (const sec of page?.sections ?? []) {
    for (const it of sec.contents ?? []) { const t = normalize(it); if (t) out.push({ ...t, artist: t.artist || first.name }); }
    if (out.length) break;
  }
  return out;
});
const themeSongs = (q) => cached('th|' + q, async () => (await searchTracks(q)).slice(0, 20));

const SEED_CAP = 6;
const splitIds = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter((s) => ID_RE.test(s));

app.get('/api/recommend', async (req, res) => {
  const seeds = splitIds(req.query.seeds).slice(0, SEED_CAP);
  if (!seeds.length) return res.json({ results: [] });
  const titles = splitNames(req.query.titles);
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 15));

  const settled = await Promise.allSettled(
    seeds.map((id, i) => relatedFor(id, titles[i]).then((tracks) => ({ weight: Math.max(0.4, 1 - i * 0.12), tracks }))),
  );
  const lists = settled.filter((r) => r.status === 'fulfilled').map((r) => ({ ...r.value, kind: 'radio' }));
  if (!lists.length) return res.status(502).json({ error: 'Could not load recommendations.' });

  // What the listener is hearing right now (the first seed): its movie/album, artist, co-artists and theme.
  const albums = splitNames(req.query.albums);
  const seedArtists = splitNames(req.query.seedArtists);
  const focus = describeFocus({ title: titles[0], artist: seedArtists[0], album: albums[0] });
  const extra = [];
  if (focus.album) extra.push(withTimeout(albumSongs(focus.album, focus.artist)).then((tracks) => ({ weight: 1.1, tracks, kind: 'album' })));
  if (focus.artist) extra.push(withTimeout(artistSongs(focus.artist)).then((tracks) => ({ weight: 0.8, tracks, kind: 'artist' })));
  focus.collabs.slice(0, 2).forEach((c) => extra.push(withTimeout(artistSongs(c)).then((tracks) => ({ weight: 0.7, tracks, kind: 'collab' }))));
  if (focus.theme) extra.push(withTimeout(themeSongs(focus.theme)).then((tracks) => ({ weight: 0.6, tracks, kind: 'theme' })));
  (await Promise.allSettled(extra)).forEach((r) => { if (r.status === 'fulfilled' && r.value.tracks.length) lists.push(r.value); });

  const lower = (v) => new Set(splitNames(v).map((s) => s.toLowerCase()));
  const exclude = new Set([...seeds, ...splitIds(req.query.exclude)]);
  const vibe = vibeProfile(lists, titles, splitNames(req.query.pos), splitNames(req.query.neg));
  const ranked = scoreCandidates(lists, {
    affinity: lower(req.query.artists),
    avoid: lower(req.query.avoid),
    exclude,
    vibe,
    love: lower(req.query.love),
    hate: lower(req.query.hate),
    hour: lower(req.query.hour),
    focus,
  });
  res.json({ results: pickMix(ranked, limit, focus) });
});

function artThumb(x) {
  const u = x?.thumbnail?.contents?.[0]?.url || x?.thumbnails?.[x?.thumbnails?.length - 1]?.url || x?.thumbnail?.[0]?.url || '';
  return u ? (u.startsWith('//') ? `https:${u}` : upsizeArt(u)) : '';
}

async function findArtists(q) {
  const yt = await getYT();
  const res = await yt.music.search(q, { type: 'artist' });
  const out = [];
  for (const shelf of res.contents ?? []) {
    for (const item of shelf.contents ?? []) {
      const name = toText(item.name) || toText(item.title) || item.flex_columns?.[0]?.title?.text || '';
      const id = item.id || item.endpoint?.payload?.browseId || '';
      if (name && id) out.push({ id, name, thumbnail: artThumb(item) });
    }
  }
  return out.slice(0, 12);
}

app.get('/api/artists', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 120);
  if (!q) return res.json({ results: [] });
  try {
    res.json({ results: await findArtists(q) });
  } catch (err) {
    console.warn('[artists]', err.message);
    res.json({ results: [] }); // artists are a bonus: never break search over them
  }
});

const artistCache = new Map();

app.get('/api/artist', async (req, res) => {
  const name = String(req.query.name ?? '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Missing name' });
  const key = name.toLowerCase();
  const hit = artistCache.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL * 3) return res.json(hit.data);

  let thumbnail = '';
  let tracks = [];
  try {
    const yt = await getYT();
    const [first] = await findArtists(name);
    if (first) {
      thumbnail = first.thumbnail;
      try {
        const page = await yt.music.getArtist(first.id);
        thumbnail = artThumb(page?.header) || thumbnail;
        for (const sec of page?.sections ?? []) {
          for (const item of sec.contents ?? []) {
            const t = normalize(item);
            if (t) tracks.push({ ...t, artist: t.artist || first.name });
          }
          if (tracks.length) break; // the first shelf with songs is "Songs"
        }
      } catch (err) {
        console.warn(`[artist ${name}] artist page failed (${err.message}); using search`);
      }
    }
    if (!tracks.length) {
      const found = await searchTracks(name);
      tracks = found.filter((t) => t.artist.toLowerCase().includes(key));
      if (!tracks.length) tracks = found;
    }
  } catch (err) {
    console.error('[artist]', err.message);
    return res.status(502).json({ error: 'Could not load this artist.' });
  }
  const seen = new Set();
  tracks = tracks.filter((t) => !seen.has(t.id) && seen.add(t.id)).slice(0, 25);
  const data = { name, thumbnail: thumbnail || tracks[0]?.thumbnail || '', tracks };
  if (artistCache.size > 60) artistCache.delete(artistCache.keys().next().value);
  artistCache.set(key, { at: Date.now(), data });
  res.json(data);
});

/* ------------------------------------------------------------------ */
/* Playable check: some songs forbid playing outside YouTube           */
/* ------------------------------------------------------------------ */
/*
 * Record labels can switch off embedding for a video. YouTube's own oEmbed address answers 200 when a
 * video may be embedded and 401 when it may not. When a song is blocked we look for another upload of the
 * same song (lyric video, audio upload) that is allowed, and the app plays that one instead.
 */

const embedCache = new Map(); // id -> { at, ok }
const EMBED_TTL = 6 * 3600 * 1000;

async function isEmbeddable(id) {
  const hit = embedCache.get(id);
  if (hit && Date.now() - hit.at < EMBED_TTL) return hit.ok;
  let ok = null; // null = could not find out
  try {
    const u = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id);
    const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(5000) });
    r.body?.cancel().catch(() => {});
    if (r.status === 200) ok = true;
    else if (r.status === 401 || r.status === 403 || r.status === 404) ok = false;
  } catch {
    ok = null;
  }
  if (ok !== null) {
    if (embedCache.size > 2000) embedCache.delete(embedCache.keys().next().value);
    embedCache.set(id, { at: Date.now(), ok });
  }
  return ok;
}

const altCache = new Map(); // id -> { at, id }
const ALT_JUNK = /\b(karaoke|reaction|8d|slowed|reverb|sped up|speed up|nightcore|tutorial|cover by|piano cover|guitar cover|status|shorts?)\b/i;

async function searchVideos(q) {
  const yt = await getYT();
  const res = await yt.search(q, { type: 'video' });
  return (res.results ?? []).filter((r) => r?.type === 'Video').map(normalize).filter(Boolean);
}

async function findAlternative(id, title, artist, duration) {
  const q = `${title} ${artist}`.trim();
  if (!q) return null;
  const seen = new Set([id]);
  const cands = [];
  const lists = await Promise.allSettled([searchTracks(q), searchVideos(q + ' official audio'), searchVideos(q + ' lyrics'), searchVideos(q)]);
  for (const l of lists) {
    if (l.status !== 'fulfilled') continue;
    for (const t of l.value) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      if (ALT_JUNK.test(t.title) && !ALT_JUNK.test(title)) continue;
      cands.push(t);
      if (cands.length >= 16) break;
    }
  }
  const checked = await Promise.all(cands.map(async (t) => ({ t, ok: await isEmbeddable(t.id) })));
  const allowed = checked.filter((x) => x.ok !== false);
  if (!allowed.length) return null;
  const close = (t) => (duration && t.duration ? Math.abs(t.duration - duration) : 9999);
  allowed.sort((a, b) => (b.ok === true) - (a.ok === true) || close(a.t) - close(b.t));
  const best = allowed[0].t;
  if (duration && best.duration && Math.abs(best.duration - duration) > Math.max(25, duration * 0.35)) return null;
  return best.id;
}

app.get('/api/playable', async (req, res) => {
  const id = String(req.query.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid video id' });
  const title = String(req.query.title || '').slice(0, 200);
  const artist = String(req.query.artist || '').slice(0, 200);
  const duration = Math.max(0, Math.min(36000, Number(req.query.duration) || 0));
  try {
    if ((await isEmbeddable(id)) !== false) return res.json({ id, alt: false });
    const hit = altCache.get(id);
    if (hit && Date.now() - hit.at < EMBED_TTL) return res.json(hit.alt ? { id: hit.alt, alt: true } : { id, alt: false, none: true });
    const alt = await findAlternative(id, title, artist, duration);
    if (altCache.size > 500) altCache.delete(altCache.keys().next().value);
    altCache.set(id, { at: Date.now(), alt });
    res.json(alt ? { id: alt, alt: true } : { id, alt: false, none: true });
  } catch (err) {
    console.warn('[playable]', err.message);
    res.json({ id, alt: false });
  }
});

/* ------------------------------------------------------------------ */
/* Listen together: rooms where the host's playback is mirrored        */
/* ------------------------------------------------------------------ */
/*
 * Everybody plays the song in their own official YouTube player. The server only passes small messages
 * (which song, playing or paused, position) from the host to the guests. No audio goes through this server.
 * Guests ask for news about once a second (plain requests, so it works through tunnels, proxies and hosting
 * services, from any network).
 */

const rooms = new Map(); // code -> { code, host, members: Map(cid -> { seen }), state, v, closed }
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ROOMS = 50;
const MAX_MEMBERS = 20;
// Smart session lifetime: a reload, a phone lock or a switch to another app must never end the session.
const ACTIVE_MS = 45_000;         // seen this recently = actively listening
const GUEST_GONE_MS = 5 * 60_000; // a guest who is silent this long is removed
const HOST_GRACE_MS = 90_000;     // host silent this long -> hand over to the longest-present active member
const HOST_GONE_MS = 15 * 60_000; // host silent this long and nobody active -> the session ends
const CLOSED_KEEP_MS = 30_000;

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
}

function closeRoom(room, reason) {
  if (room.closed) return;
  room.closed = { reason, at: Date.now() };
  room.v++;
}

const cleanStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const cleanName = (v, fallback) => cleanStr(v, 60).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24) || fallback;

function cleanTrack(t) {
  if (!t || typeof t !== 'object' || !ID_RE.test(String(t.id))) return null;
  return {
    id: t.id,
    title: cleanStr(t.title, 200) || 'Unknown title',
    artist: cleanStr(t.artist, 200),
    duration: Math.max(0, Math.min(36000, Number(t.duration) || 0)),
    thumbnail: /^https:\/\//.test(String(t.thumbnail || '')) ? cleanStr(t.thumbnail, 400) : '',
  };
}

function cleanState(s, by) {
  if (!s || typeof s !== 'object') return null;
  const track = s.track ? cleanTrack(s.track) : null;
  if (s.track && !track) return null;
  const position = Number(s.position);
  return {
    track,
    playing: Boolean(s.playing),
    position: Number.isFinite(position) ? Math.max(0, Math.min(36000, position)) : 0,
    queue: (Array.isArray(s.queue) ? s.queue : []).slice(0, 20).map(cleanTrack).filter(Boolean),
    at: Date.now(),
    by: by || '',
  };
}

const jsonBody = express.json({ limit: '64kb' });
const findRoom = (req, res) => {
  const room = rooms.get(String(req.params.code || '').toUpperCase());
  if (!room) res.status(404).json({ error: 'No session with that code.' });
  return room;
};

app.post('/api/together/create', jsonBody, (req, res) => {
  if (rooms.size >= MAX_ROOMS) return res.status(503).json({ error: 'Too many sessions right now.' });
  const cid = crypto.randomUUID();
  const room = { code: newCode(), host: cid, members: new Map([[cid, { seen: Date.now(), joined: Date.now(), name: cleanName(req.body?.name, 'Host') }]]), state: null, v: 1, closed: null, all: false, notice: null };
  rooms.set(room.code, room);
  res.json({ code: room.code, cid, people: peopleOf(room), now: Date.now() });
});

// What a person may do: `play` = choose songs, play, pause, seek. `next` = skip to the next or previous song.
const BOTH = { play: true, next: true };
const permOf = (room, cid) => (cid === room.host || room.all === true ? BOTH : { play: room.members.get(cid)?.perm?.play === true, next: room.members.get(cid)?.perm?.next === true });
const canControl = (room, cid) => { const p = permOf(room, cid); return p.play || p.next; };
const peopleOf = (room) => [...room.members].map(([cid, m]) => ({ id: cid.slice(0, 8), name: m.name, host: cid === room.host, ctl: canControl(room, cid), perm: permOf(room, cid) }));

app.post('/api/together/:code/join', jsonBody, (req, res) => {
  const room = findRoom(req, res);
  if (!room) return;
  if (room.closed) return res.status(404).json({ error: 'That session has ended.' });
  if (room.members.size >= MAX_MEMBERS) return res.status(409).json({ error: 'This session is full.' });
  const cid = crypto.randomUUID();
  room.members.set(cid, { seen: Date.now(), joined: Date.now(), name: cleanName(req.body?.name, 'Guest') });
  res.json({ code: room.code, cid, state: room.state, v: room.v, count: room.members.size, people: peopleOf(room), ctl: canControl(room, cid), perm: permOf(room, cid), all: room.all, now: Date.now() });
});

// Guests (and the host) ask "anything new?". `v` is the version they already have.
app.get('/api/together/:code/poll', (req, res) => {
  const room = findRoom(req, res);
  if (!room) return;
  res.setHeader('Cache-Control', 'no-store');
  const cid = String(req.query.cid || '');
  const m = room.members.get(cid);
  if (!m) return res.status(403).json({ error: 'Not part of this session.' });
  m.seen = Date.now();
  if (room.closed) return res.json({ now: Date.now(), closed: true, reason: room.closed.reason });
  const body = { now: Date.now(), count: room.members.size, v: room.v, host: cid === room.host, people: peopleOf(room), ctl: canControl(room, cid), perm: permOf(room, cid), all: room.all, notice: room.notice };
  if (String(req.query.v) !== String(room.v)) body.state = room.state;
  res.json(body);
});

app.post('/api/together/:code/state', jsonBody, (req, res) => {
  const room = findRoom(req, res);
  if (!room) return;
  if (room.closed) return res.status(404).json({ error: 'That session has ended.' });
  const cid = String(req.body?.cid || '');
  if (!room.members.has(cid)) return res.status(403).json({ error: 'Not part of this session.' });
  const perm = permOf(room, cid);
  if (!perm.play && !perm.next) return res.status(403).json({ error: 'The host has not given you control.' });
  // The host's 4-second heartbeat must not overwrite a change someone else just made.
  if (req.body?.hb && room.state && room.state.by && room.state.by !== cid.slice(0, 8) && Date.now() - room.state.at < 6000) return res.status(204).end();
  const state = cleanState(req.body?.state, cid.slice(0, 8));
  if (!state) return res.status(400).json({ error: 'Bad state.' });
  if (cid !== room.host && !perm.play) {
    // Skip-only people may move to the song that is up next, or the one before it. Nothing else.
    const old = room.state;
    const ok = old && state.track && old.track && state.track.id !== old.track.id && (state.track.id === old.queue?.[0]?.id || state.track.id === room.prevId);
    if (!ok) return res.status(403).json({ error: 'The host only allowed you to skip songs.' });
  }
  if (room.state?.track && state.track && room.state.track.id !== state.track.id) room.prevId = room.state.track.id;
  room.state = state;
  room.v++;
  room.members.get(cid).seen = Date.now();
  res.status(204).end();
});

// The host decides who may play: one person, or everyone.
app.post('/api/together/:code/perm', jsonBody, (req, res) => {
  const room = findRoom(req, res);
  if (!room) return;
  if (room.closed) return res.status(404).json({ error: 'That session has ended.' });
  if (String(req.body?.cid || '') !== room.host) return res.status(403).json({ error: 'Only the host can give control.' });
  if (typeof req.body?.all === 'boolean') room.all = req.body.all;
  if (typeof req.body?.target === 'string') {
    for (const [cid, m] of room.members) {
      if (cid === room.host || cid.slice(0, 8) !== req.body.target) continue;
      m.perm = { play: m.perm?.play === true, next: m.perm?.next === true };
      if (typeof req.body.play === 'boolean') m.perm.play = req.body.play;
      if (typeof req.body.next === 'boolean') m.perm.next = req.body.next;
    }
  }
  res.json({ people: peopleOf(room), all: room.all });
});

app.post('/api/together/:code/leave', jsonBody, (req, res) => {
  const room = findRoom(req, res);
  if (!room) return;
  const cid = String(req.body?.cid || '');
  if (cid === room.host) closeRoom(room, 'The host ended the session.');
  else room.members.delete(cid);
  res.status(204).end();
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.closed) {
      if (now - room.closed.at > CLOSED_KEEP_MS) rooms.delete(code);
      continue;
    }
    for (const [cid, m] of room.members) {
      if (cid !== room.host && now - m.seen > GUEST_GONE_MS) room.members.delete(cid);
    }
    const hostM = room.members.get(room.host);
    if (now - hostM.seen > HOST_GRACE_MS) {
      const next = [...room.members].filter(([c, m]) => c !== room.host && now - m.seen < ACTIVE_MS).sort((a, b) => (a[1].joined || 0) - (b[1].joined || 0))[0];
      if (next) {
        room.host = next[0]; // hand over, so the music keeps going for everyone
        room.v++;
        room.notice = { id: now, text: `${next[1].name} is now the host.` };
      } else if (now - hostM.seen > HOST_GONE_MS) closeRoom(room, 'Nobody was listening, so the session ended.');
    }
  }
}, 5000).unref();

/* ------------------------------------------------------------------ */
/* Related songs (for autoplay)                                        */
/* ------------------------------------------------------------------ */

app.get('/api/related', async (req, res) => {
  const q = String(req.query.q ?? '').trim().slice(0, 120);
  const exclude = String(req.query.exclude ?? '').split(',').filter((x) => ID_RE.test(x));
  if (!q) return res.json({ results: [] });

  const key = q.toLowerCase();
  try {
    let results;
    const hit = searchCache.get(key);
    if (hit && Date.now() - hit.at < SEARCH_TTL) {
      results = hit.results;
    } else {
      results = await searchTracks(q);
      if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);
      searchCache.set(key, { at: Date.now(), results });
    }
    res.json({ results: results.filter((t) => !exclude.includes(t.id)) });
  } catch (err) {
    console.error('[related]', err);
    res.status(502).json({ error: 'Could not load related songs.' });
  }
});

/* ------------------------------------------------------------------ */
/* Synced lyrics from LrcLib                                           */
/* ------------------------------------------------------------------ */

const lyricsCache = new Map();
const LYRICS_TTL = 60 * 60 * 1000;

async function lrclibGet(title, artist, duration) {
  const u = new URL('https://lrclib.net/api/get');
  u.searchParams.set('track_name', title);
  u.searchParams.set('artist_name', artist);
  if (duration) u.searchParams.set('duration', String(duration));
  const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(8000) });
  return r.ok ? r.json() : null;
}

async function lrclibSearch(title, artist) {
  const u = new URL('https://lrclib.net/api/search');
  u.searchParams.set('q', `${title} ${artist}`.trim());
  const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!r.ok) return null;
  const list = await r.json();
  if (!Array.isArray(list)) return null;
  return list.find((x) => x.syncedLyrics) || list[0] || null;
}

app.get('/api/lyrics', async (req, res) => {
  const title = String(req.query.title ?? '').trim().slice(0, 200);
  const artist = String(req.query.artist ?? '').trim().slice(0, 200);
  const duration = Math.round(Number(req.query.duration) || 0);
  if (!title) return res.status(400).json({ error: 'Title is required.' });

  const key = `${title}|${artist}|${duration}`.toLowerCase();
  const hit = lyricsCache.get(key);
  if (hit && Date.now() - hit.at < LYRICS_TTL) return res.json(hit.data);

  try {
    let d = null;
    try { d = await lrclibGet(title, artist, duration); } catch { d = null; }
    if (!d) d = await lrclibSearch(title, artist);
    const data = { synced: (d && d.syncedLyrics) || null, plain: (d && d.plainLyrics) || null };
    if (lyricsCache.size > 200) lyricsCache.delete(lyricsCache.keys().next().value);
    lyricsCache.set(key, { at: Date.now(), data });
    res.json(data);
  } catch (err) {
    console.error('[lyrics]', err.message);
    res.status(502).json({ error: 'Lyrics service unreachable.' });
  }
});

const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
app.get('/api/config', (_req, res) => res.json({ publicUrl: PUBLIC_URL, googleClientId: GOOGLE_CLIENT_ID }));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
mountStream(app, { getYT, ID_RE });
app.get('/api/version', (_req, res) => res.json({ build: 'nandify-v6', perms: true, handoff: true, stream: true }));
app.use(express.static(path.join(__dirname, 'public')));

process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

app.listen(PORT, HOST, () => {
  console.log(`Music player running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  getYT().catch((err) => console.error('[innertube] init failed:', err.message));
});
