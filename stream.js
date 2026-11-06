// Audio streaming, the way native music apps do it: the server resolves a real audio URL from YouTube
// (trying several Innertube clients until googlevideo accepts one) and sends the audio to a normal <audio>
// element. Audio in an <audio> element keeps playing in the background on phones.
import { Readable } from 'node:stream';
import { once } from 'node:events';
import vm from 'node:vm';
import { Platform } from 'youtubei.js';
import fs from 'node:fs';

export function mountStream(app, { getYT, ID_RE }) {
function libraryVersion() {
  try { return JSON.parse(fs.readFileSync(new URL('./node_modules/youtubei.js/package.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; }
}

// Innertube clients to try, in order, when looking for a playable audio URL.
// A client is only used if googlevideo returns real audio for its URL (see probe()).
// Override with e.g. YT_CLIENTS=TV,IOS if you know which one works for you.
const CLIENTS = (process.env.YT_CLIENTS || 'TV,ANDROID_VR,IOS,ANDROID,TV_EMBEDDED,WEB_EMBEDDED,MWEB,WEB')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const UA_WEB =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const UA_BY_CLIENT = {
  IOS: 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)',
  ANDROID: 'com.google.android.youtube/19.44.38 (Linux; U; Android 11) gzip',
  ANDROID_VR:
    'com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
};

// googlevideo rejects very large ranges, so audio is fetched in chunks like a real YouTube client does.
const CHUNK = 4 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Player-script evaluator                                             */
/* ------------------------------------------------------------------ */
/*
 * Newer youtubei.js releases no longer ship their own JavaScript interpreter.
 * To turn a signed audio URL into one googlevideo accepts, they call
 * Platform.shim.eval(), which the application has to provide. Without it,
 * search still works but every stream URL fails to decipher.
 *
 * This runs a script derived from YouTube's player in a fresh V8 context with a
 * timeout. That is isolation from your variables, not a hardened sandbox, so keep
 * this server on your own machine. Older releases ignore the hook.
 */
try {
  if (Platform?.shim) {
    Platform.shim.eval = async (data, env) => {
      const props = [];
      if (env?.n) props.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
      if (env?.sig) props.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
      const code = `(function () {\n${data.output}\nreturn { ${props.join(', ')} };\n})()`;
      if (process.env.YT_UNSAFE_EVAL === '1') return new Function(`return ${code}`)(); // escape hatch
      return vm.runInNewContext(code, { console }, { timeout: 10_000 });
    };
  }
} catch (err) {
  console.warn('[eval] could not install the player-script evaluator:', err.message);
}

/* Choosing and verifying an audio stream                              */
/* ------------------------------------------------------------------ */

const streamCache = new Map(); // "id|order" -> entry
const STREAM_TTL = 15 * 60 * 1000; // signed URLs expire; refresh well before that

const withRange = (url, start, end) => {
  const u = new URL(url);
  u.searchParams.set('range', `${start}-${end}`); // how YouTube's own clients ask for byte ranges
  return u.toString();
};

const upstreamHeaders = (entry) => ({
  'User-Agent': entry.userAgent,
  Origin: 'https://www.youtube.com',
  Referer: 'https://www.youtube.com/',
});

// Containers YouTube serves audio in: WebM (Opus) and MP4 (AAC).
// The browser tells us which it can play (?prefer=webm,mp4); the order is the preference.
const CONTAINERS = ['webm', 'mp4'];
const DEFAULT_ORDER = (process.env.YT_FORMAT_ORDER || 'webm,mp4')
  .split(',')
  .map((s) => s.trim())
  .filter((c) => CONTAINERS.includes(c));

function parseOrder(value) {
  const list = String(value ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((c) => CONTAINERS.includes(c));
  return list.length ? [...new Set(list)] : DEFAULT_ORDER;
}

const mimeOf = (f) => String(f?.mime_type || '').toLowerCase();
const containerOf = (f) => (mimeOf(f).match(/^audio\/(webm|mp4)/) || [])[1] || null;

// Pick the best audio-only format in the wanted container, without trusting the
// library's own `format` filter alone: whatever it returns is checked, and the
// raw format list is the fallback.
function pickFormat(info, container) {
  const filters = container === 'webm' ? ['opus', 'webm'] : ['mp4'];
  for (const format of filters) {
    try {
      const f = info.chooseFormat({ type: 'audio', quality: 'best', format });
      if (containerOf(f) === container) return f;
    } catch {
      /* try the next filter */
    }
  }
  const manual = (info.streaming_data?.adaptive_formats ?? [])
    .filter((f) => containerOf(f) === container)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return manual[0] || null;
}

// Identify the container from its first bytes. Anything else (an HTML error page,
// YouTube's SABR "UMP" stream, JSON) must never be sent to the browser as audio.
function sniff(buf) {
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'webm';
  if (buf.length >= 8) {
    const box = buf.subarray(4, 8).toString('latin1');
    if (['ftyp', 'styp', 'moof', 'moov', 'sidx', 'mdat', 'free', 'skip', 'wide'].includes(box)) return 'mp4';
  }
  return null;
}

// Reads from a web-stream reader until at least n bytes are buffered (or the stream ends).
async function collectHead(reader, n) {
  const chunks = [];
  let len = 0;
  while (len < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    len += value.length;
  }
  return { head: Buffer.concat(chunks), chunks };
}

// Fetch the first 64 bytes and report what googlevideo actually sent back.
async function probe(entry) {
  const r = await fetch(withRange(entry.url, 0, 63), { headers: upstreamHeaders(entry), signal: AbortSignal.timeout(10_000) });
  let head = Buffer.alloc(0);
  if (r.body) {
    const reader = r.body.getReader();
    try {
      ({ head } = await collectHead(reader, 64));
    } finally {
      reader.cancel().catch(() => {});
    }
  }
  return {
    status: r.status,
    contentType: r.headers.get('content-type') || '',
    container: sniff(head),
    head: head.subarray(0, 12).toString('hex'),
  };
}

async function resolveAudio(id, { order = DEFAULT_ORDER, force = false } = {}) {
  const key = `${id}|${order.join(',')}`;
  const hit = streamCache.get(key);
  if (!force && hit && hit.expires > Date.now()) return hit;

  const yt = await getYT();
  const attempts = [];

  for (const client of CLIENTS) {
    const a = { client, tries: [] };
    attempts.push(a);
    try {
      const info = await yt.getBasicInfo(id, { client });
      a.playability = info.playability_status?.status || 'unknown';
      if (a.playability !== 'OK') {
        throw new Error(info.playability_status?.reason || `playability ${a.playability}`);
      }

      for (const container of order) {
        const t = { container };
        a.tries.push(t);
        try {
          const format = pickFormat(info, container);
          if (!format) throw new Error(`this client offers no ${container} audio`);
          t.itag = format.itag;
          t.mime = format.mime_type;

          const url = await format.decipher(yt.session.player);
          if (!url) throw new Error('format has no URL (this client may need a PO token or SABR)');

          const total = Number(format.content_length) || Number(new URL(url).searchParams.get('clen')) || 0;
          if (!total) throw new Error('could not determine audio size');

          const entry = { id, client, url, total, userAgent: UA_BY_CLIENT[client] || UA_WEB, expires: Date.now() + STREAM_TTL };

          const p = await probe(entry);
          Object.assign(t, { status: p.status, contentType: p.contentType, sniffed: p.container, firstBytes: p.head });
          if (p.status !== 200 && p.status !== 206) throw new Error(`googlevideo answered ${p.status}`);
          if (!p.container) {
            throw new Error(`reply is not audio (content-type "${p.contentType}", starts with ${p.head || 'nothing'})`);
          }

          // Label the stream with what it really is, not just what the metadata claimed.
          entry.container = p.container;
          entry.mime = p.container === containerOf(format) ? format.mime_type : `audio/${p.container}`;

          t.ok = true;
          entry.attempts = attempts;
          streamCache.set(key, entry);
          console.log(`[stream ${id}] ${client} itag ${t.itag} ${entry.mime} (${total} bytes)`);
          return entry;
        } catch (err) {
          t.error = err.message;
        }
      }
      a.error = 'no usable audio format from this client';
    } catch (err) {
      a.error = err.message;
    }
  }

  const err = new Error('No YouTube client produced audio that googlevideo accepts');
  err.attempts = attempts;
  throw err;
}

/* ------------------------------------------------------------------ */
/* Proxying audio to the browser                                       */
/* ------------------------------------------------------------------ */

async function openChunk(entry, start, end, signal) {
  const r = await fetch(withRange(entry.url, start, Math.min(end, start + CHUNK - 1)), {
    headers: upstreamHeaders(entry),
    signal,
  });
  if (r.status !== 200 && r.status !== 206) {
    r.body?.cancel().catch(() => {});
    const err = new Error(`googlevideo answered ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r;
}

async function write(res, buf, signal) {
  if (!res.write(buf)) await once(res, 'drain', { signal });
}

// Streams bytes [start, end] to the client, one upstream chunk at a time.
async function pump(entry, start, end, res, signal, firstChunk) {
  let pos = start;
  let resp = firstChunk;
  while (pos <= end) {
    resp ??= await openChunk(entry, pos, end, signal);
    const before = pos;
    for await (const part of Readable.fromWeb(resp.body)) {
      const room = end + 1 - pos;
      if (room <= 0) break;
      const out = part.length > room ? part.subarray(0, room) : part;
      await write(res, out, signal);
      pos += out.length;
    }
    resp = null;
    if (pos === before) throw new Error('upstream returned an empty chunk');
  }
}

// Last resort: let youtubei.js download the audio itself. Playback works, seeking does not.
// The first bytes are checked, so the response is only sent if it really is WebM or MP4.
async function pipeWithDownload(id, res, signal, order) {
  const yt = await getYT();
  const problems = [];

  for (const container of order) {
    for (const client of CLIENTS.slice(0, 4)) {
      let reader;
      try {
        const stream = await yt.download(id, { type: 'audio', quality: 'best', format: container, client });
        reader = stream.getReader();
        signal.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true });

        const { head, chunks } = await collectHead(reader, 16);
        const kind = sniff(head);
        if (!kind) throw new Error(`not audio (starts with ${head.subarray(0, 12).toString('hex') || 'nothing'})`);

        res.status(200);
        res.setHeader('Content-Type', kind === 'webm' ? 'audio/webm' : 'audio/mp4');
        res.setHeader('Cache-Control', 'no-store');
        for (const c of chunks) await write(res, c, signal);
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await write(res, value, signal);
        }
        console.log(`[stream ${id}] served through yt.download (${client}, ${kind})`);
        return res.end();
      } catch (err) {
        reader?.cancel().catch(() => {});
        problems.push(`${client}/${container}: ${err.message}`);
        if (res.headersSent) return res.destroy(); // too late to try anything else
      }
    }
  }
  const err = new Error('download fallback failed');
  err.problems = problems;
  throw err;
}

function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m || (!m[1] && !m[2])) return { start: 0, end: total - 1, partial: false };
  let start;
  let end = total - 1;
  if (m[1] === '') {
    start = Math.max(0, total - Number(m[2])); // suffix range: the last N bytes
  } else {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), total - 1);
  }
  if (start > end || start >= total) return null;
  return { start, end, partial: true };
}

app.get('/api/stream/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid video id' });

  const order = parseOrder(req.query.prefer);
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  try {
    // Resolve a verified URL, open the first chunk, and only then commit to a response.
    // A stale cached URL gets one forced refresh.
    let entry;
    let range;
    let first;
    for (const force of [false, true]) {
      entry = await resolveAudio(id, { order, force });
      range = parseRange(req.headers.range, entry.total);
      if (!range) {
        return res.status(416).set('Content-Range', `bytes */${entry.total}`).end();
      }
      try {
        first = await openChunk(entry, range.start, range.end, abort.signal);
        break;
      } catch (err) {
        if (abort.signal.aborted) return;
        streamCache.delete(`${id}|${order.join(',')}`);
        if (force) throw err;
      }
    }

    res.status(range.partial ? 206 : 200);
    res.setHeader('Content-Type', entry.mime); // e.g. audio/webm; codecs="opus" or audio/mp4; codecs="mp4a.40.2"
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Length', range.end - range.start + 1);
    if (range.partial) res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${entry.total}`);

    if (req.method === 'HEAD') {
      first.body?.cancel().catch(() => {});
      return res.end();
    }

    await pump(entry, range.start, range.end, res, abort.signal, first);
    res.end();
  } catch (err) {
    if (abort.signal.aborted) return;
    console.error(`[stream ${id}]`, err.message, err.attempts ? JSON.stringify(err.attempts) : '');
    if (res.headersSent) return res.destroy();

    try {
      await pipeWithDownload(id, res, abort.signal, order);
    } catch (fallbackErr) {
      if (abort.signal.aborted || res.headersSent) return res.destroy();
      console.error(`[stream ${id}] download fallback failed:`, fallbackErr.message, fallbackErr.problems ?? '');
      res.status(502).json({
        error: err.message,
        fallbackError: fallbackErr.message,
        attempts: err.attempts,
        fallbackProblems: fallbackErr.problems,
        hint: `Open /api/debug/${id} for details`,
      });
    }
  }
});

// Shows why each YouTube client and container was accepted or rejected for a video id.
// Add ?prefer=mp4 or ?prefer=webm,mp4 to test a specific order.
app.get('/api/debug/:id', async (req, res) => {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: 'Invalid video id' });

  const order = parseOrder(req.query.prefer);
  const out = { node: process.version, youtubei: libraryVersion(), clients: CLIENTS, order };
  try {
    const entry = await resolveAudio(id, { order, force: true });
    Object.assign(out, { ok: true, client: entry.client, mime: entry.mime, bytes: entry.total, attempts: entry.attempts });
  } catch (err) {
    Object.assign(out, { ok: false, error: err.message, attempts: err.attempts });
  }
  res.json(out);
});

}
