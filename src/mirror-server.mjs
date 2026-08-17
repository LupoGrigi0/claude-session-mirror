#!/usr/bin/env node
/**
 * claude-session-mirror — the output leg.
 *
 * An INDEPENDENT process (deliberately: see docs) that watches a live Claude
 * Code session and republishes it as a structured, replayable event stream.
 *
 *   POST /hook     fast-ACK receiver for Claude Code hooks (latency signal only)
 *   GET  /events   SSE, id: <epoch>.<seq>, honours Last-Event-ID
 *   GET  /health   liveness + real observability
 *   GET  /blob/:id oversized payloads spilled out of the stream
 *
 * WHY A SEPARATE PROCESS: an in-session MCP server dies with the session, so it
 * could never report the session's own death, would have no listener during
 * startup/shutdown, and would make history unavailable exactly when an instance
 * is down. This one outlives the thing it watches.
 *
 * WHY THE HOOK IS FAST-ACK: hooks BLOCK the session, ~1:1. Measured — a 3s hook
 * on a 3-tool turn took it from 7,118ms to 15,197ms. Every millisecond spent
 * here is a millisecond the mind is frozen. So: read, ACK, do nothing else.
 *
 * Cairn-2001
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { EventLog } from './eventlog.mjs';
import { TranscriptTailer } from './tailer.mjs';
import { schemaCanary } from './normalizer.mjs';
import { resolveIdentity, senderAddress, stubIdentity } from './identity.mjs';
import { execFile } from 'node:child_process';

const cfg = {
  instance:   process.env.MIRROR_INSTANCE   || 'unknown',
  display:    process.env.MIRROR_DISPLAY    || process.env.MIRROR_INSTANCE || 'Instance',
  transcript: process.env.MIRROR_TRANSCRIPT || '',
  dataDir:    process.env.MIRROR_DATA_DIR   || path.join(process.env.HOME || '/tmp', '.claude-mirror'),
  port:  Number(process.env.MIRROR_PORT || 22090),
  bind:         process.env.MIRROR_BIND || '127.0.0.1',
  room:         process.env.MIRROR_ROOM || 'default',
  fromStart:    process.env.MIRROR_FROM_START === '1',
  // Everything is served under this prefix, so one host can front many
  // instances at /Cairn, /Bastion, /Crossing … Default '' = serve at root.
  basePath:    (process.env.MIRROR_BASE_PATH || '').replace(/\/+$/, ''),
  // The instance's own channel server — where a browser message is injected.
  channelUrl:   process.env.MIRROR_CHANNEL_URL || '',
  threadId:     process.env.MIRROR_THREAD_ID || 'web',
  // tmux session to interrupt. Defaults to the instance id, which is the
  // chassis convention. Empty string disables the stop button entirely.
  tmuxSession:  process.env.MIRROR_TMUX_SESSION ?? (process.env.MIRROR_INSTANCE || ''),
  // H-04 (Bastion): the channel server will gate verdicts by caller uid. A
  // mirror runs as its own instance's uid, which for a root session is not a
  // trusted one — so a token proves "a human authorized this" alongside uid
  // proving "which local process". Pass-through built now so the patch slots in.
  verdictToken: process.env.MIRROR_VERDICT_TOKEN || '',
};

/** Strip the base path; returns null when the request isn't ours. */
function route(pathname) {
  if (!cfg.basePath) return pathname;
  if (pathname === cfg.basePath) return '/';
  if (pathname.startsWith(cfg.basePath + '/')) return pathname.slice(cfg.basePath.length);
  return null;
}

if (!cfg.transcript) {
  console.error('MIRROR_TRANSCRIPT is required (path to the session .jsonl)');
  process.exit(1);
}
fs.mkdirSync(cfg.dataDir, { recursive: true });

const log = (m) => console.log(`[mirror] ${new Date().toISOString()} ${m}`);
const eventLog = new EventLog(cfg.dataDir, cfg.instance);
log(`instance=${cfg.instance} epoch=${eventLog.epoch} resuming from seq=${eventLog.seq}`);

// --- schema canary -----------------------------------------------------------
// Advisory, never fatal: a renamed field should page us, not take the mirror down.
try {
  const sample = fs.readFileSync(cfg.transcript, 'utf8').split('\n').slice(-400);
  const canary = schemaCanary(sample);
  if (canary.ok) log(`schema canary OK (${canary.stats.parsed} sampled)`);
  else for (const w of canary.warnings) log(`SCHEMA DRIFT: ${w}`);
} catch (err) {
  log(`schema canary skipped: ${err.message}`);
}

// --- health/observability counters -------------------------------------------
const stats = { hooks: 0, events: 0, clients: 0, dropped: 0, lastEventAt: null, startedAt: Date.now() };
let usage = null;   // latest context accounting, straight from the transcript
const CONTEXT_WINDOW = Number(process.env.MIRROR_CONTEXT_WINDOW || 1_000_000);
const REPLAY_LIMIT   = Number(process.env.MIRROR_REPLAY_LIMIT || 300);

// --- the tailer is the source of CONTENT -------------------------------------
const tailer = new TranscriptTailer({
  transcriptPath: cfg.transcript,
  ctx: {
    instance: cfg.instance,
    instanceDisplay: cfg.display,
    roomId: cfg.room,
    // Same source as the write path — one person must not have two names.
    // Replaced by the real resolver the moment authentication is in front.
    speaker: stubIdentity() || { id: 'user', kind: 'human', display: 'User' },
  },
  onUsage: (u) => { usage = u; },
  onEvents: (events) => {
    for (const ev of events) {
      const stored = eventLog.append(ev);
      stats.events++;
      stats.lastEventAt = Date.now();
      broadcast(stored);
    }
  },
  log,
  stateFile: path.join(cfg.dataDir, `${cfg.instance}.offsets.json`),
});
// NOTE: start() is deliberately NOT called here. It emits subagent_start events
// synchronously for every transcript already on disk, which reaches broadcast()
// before `clients` exists. Started at the bottom, once everything is wired.


// --- pending permissions -----------------------------------------------------
// Polled from the instance's own channel server. Held in memory ONLY, and
// cleared whenever the source says they are gone: `pendingPermissions` on the
// channel side is in-memory too and dies with the session, so a card must never
// outlive the session that created it (Bastion).
let pending = [];
let pendingAt = 0;

async function pollPermissions() {
  if (!cfg.channelUrl) return;
  try {
    const r = await fetch(cfg.channelUrl + '/pending-permissions',
                          { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return;
    const d = await r.json();
    const next = Array.isArray(d.pending) ? d.pending : [];
    const before = pending.map(x => x.request_id).join(',');
    const after  = next.map(x => x.request_id).join(',');
    pending = next;
    pendingAt = Date.now();
    if (before !== after) {
      // Surface as a normal mirror event so every attached browser updates at
      // once, rather than each polling independently.
      eventLog.append({
        ts: new Date().toISOString(), room_id: cfg.room, type: 'permissions',
        from: { id: 'system', kind: 'system', display: 'permissions' },
        body: { pending: next },
      });
    }
  } catch { /* channel down or restarting — leave the last known state */ }
}
setInterval(pollPermissions, 2000).unref();

// --- SSE ---------------------------------------------------------------------
/** @type {Set<{res: import('node:http').ServerResponse, queued: number}>} */
const clients = new Set();
const MAX_CLIENT_BACKLOG = 5000;

function sseWrite(client, ev) {
  const frame = `id: ${ev.epoch}.${ev.seq}\nevent: mirror\ndata: ${JSON.stringify(ev)}\n\n`;
  // Respect the write return value. A slow browser must NEVER apply
  // backpressure into the process watching a mind.
  const ok = client.res.write(frame);
  if (!ok) {
    client.queued++;
    if (client.queued > MAX_CLIENT_BACKLOG) {
      stats.dropped++;
      stats.clients = Math.max(0, clients.size - 1);
      log('client overflow — disconnecting; it will replay via Last-Event-ID');
      try {
        client.res.write(`event: overflow\ndata: {"reason":"backlog"}\n\n`);
        client.res.end();
      } catch { /* already gone */ }
      clients.delete(client);
    }
  } else {
    client.queued = 0;
  }
}

function broadcast(ev) {
  for (const c of clients) sseWrite(c, ev);
}

setInterval(() => {
  for (const c of clients) {
    try { c.res.write(': ping\n\n'); } catch { clients.delete(c); }
  }
}, 15000).unref();

// --- HTTP --------------------------------------------------------------------
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n <= limit) chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}


/**
 * Same-origin check for write endpoints. A browser will happily let any page
 * POST here cross-origin unless we look. Sec-Fetch-Site is sent by all current
 * browsers; Origin is the fallback.
 */

/**
 * Describe a connecting client.
 *
 * I cannot see the screen the UI renders on, so when a layout bug is reported
 * the first question is always "on what?". This answers it.
 *
 * Server-side we get the User-Agent plus Chromium's low-entropy Client Hints
 * (sent by default, no permission needed): Sec-CH-UA-Mobile is literally
 * "is this a phone", Sec-CH-UA-Platform is the OS. Client-side the page adds
 * viewport, device pixel ratio and touch support as query params, because
 * EventSource cannot set headers.
 *
 * Kept in memory only, tied to the live connection. Not logged to disk.
 */
function describeClient(req, url) {
  const h = req.headers;
  const ua = h['user-agent'] || '';
  const strip = v => (v || '').replace(/^"|"$/g, '');
  const guessed =
    /iPhone|iPad|iPod/i.test(ua) ? 'iOS' :
    /Android/i.test(ua)          ? 'Android' :
    /Macintosh|Mac OS/i.test(ua) ? 'macOS' :
    /Windows/i.test(ua)          ? 'Windows' :
    /Linux/i.test(ua)            ? 'Linux' : 'unknown';
  return {
    platform: strip(h['sec-ch-ua-platform']) || guessed,
    mobile: h['sec-ch-ua-mobile'] === '?1' || /Mobi|Android|iPhone/i.test(ua),
    browser: strip(h['sec-ch-ua']) || ua.slice(0, 90),
    viewport: url.searchParams.get('vw') && url.searchParams.get('vh')
      ? `${url.searchParams.get('vw')}x${url.searchParams.get('vh')}` : null,
    dpr: url.searchParams.get('dpr') || null,
    touch: url.searchParams.get('touch') === '1',
    connected_at: new Date().toISOString(),
  };
}

function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin' || site === 'none';
  const origin = req.headers['origin'];
  if (!origin) return true;                 // non-browser client (curl, tests)
  try { return new URL(origin).host === req.headers['host']; } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  // A malformed Host header makes new URL() throw. In an async handler that is
  // an unhandled rejection, and Node 20 exits on those — one bad request would
  // take the mirror down. Everything below is wrapped for the same reason.
  let url;
  try { url = new URL(req.url, `http://${req.headers.host || cfg.bind}`); }
  catch { res.writeHead(400).end('bad request'); return; }
  try {
  const p = route(url.pathname);
  if (p === null) { res.writeHead(404).end('not found'); return; }

  // ---- POST /hook : FAST ACK. Do not add work here. ----
  if (req.method === 'POST' && p === '/hook') {
    res.writeHead(204).end();          // ACK first — the session is blocked
    stats.hooks++;
    readBody(req).catch(() => {});     // drain, deliberately ignored
    return;
  }


  // ---- POST /send : the write leg. Browser -> channel server -> live session.
  if (req.method === 'POST' && p === '/send') {
    if (!sameOrigin(req)) { res.writeHead(403).end('cross-origin'); return; }
    // Require a non-simple content type. A form/img/script cross-origin POST
    // cannot set this, so it forces a preflight that sameOrigin() then rejects.
    // SECURITY.md claimed this was enforced; until now only the client sent it.
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
      res.writeHead(415, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error:'content-type must be application/json' }));
      return;
    }

    // Identity is resolved in exactly one place (src/identity.mjs). If it
    // cannot be established we refuse — no anonymous speech into a mind.
    const who = resolveIdentity(req);
    if (!who) { res.writeHead(401, {'Content-Type':'application/json'})
                   .end(JSON.stringify({ ok:false, error:'unauthenticated' })); return; }

    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* handled below */ }
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) { res.writeHead(400, {'Content-Type':'application/json'})
                    .end(JSON.stringify({ ok:false, error:'empty message' })); return; }
    if (!cfg.channelUrl) { res.writeHead(503, {'Content-Type':'application/json'})
                    .end(JSON.stringify({ ok:false, error:'MIRROR_CHANNEL_URL not configured' })); return; }

    // Nonce so the UI can DERIVE delivery by watching the message reappear in
    // the mirror stream, rather than asking the instance anything (Law 9.1).
    const nonce = `${Date.now().toString(36)}-${stats.hooks}-${eventLog.seq}`;

    try {
      const r = await fetch(cfg.channelUrl + '/direct-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // NOTE: every meta value must be a STRING or Claude Code silently drops
        // the whole notification. Non-negotiable; cost the team a wake gap.
        body: JSON.stringify({
          from: senderAddress(who),
          text,
          thread_id: String(cfg.threadId),
        }),
      });
      const out = await r.json().catch(() => ({}));
      const ci = describeClient(req, url);
      log(`send from ${senderAddress(who)} [${who.source}] `
        + `via ${ci.platform}${ci.mobile ? '/mobile' : ''}`
        + `${ci.viewport ? ' ' + ci.viewport : ''} -> ${r.status}`);
      res.writeHead(r.ok ? 200 : 502, { 'Content-Type': 'application/json' })
         .end(JSON.stringify({ ok: r.ok, nonce, identity_source: who.source, channel: out }));
    } catch (err) {
      log(`send FAILED: ${err.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' })
         .end(JSON.stringify({ ok:false, error: err.message }));
    }
    return;
  }

  // ---- GET /history?before=<seq> : a page of older events, for scrolling up

  // ---- POST /interrupt : send ESC to the session's tmux pane.
  //
  // This is console access and is treated as such: same-origin, JSON only,
  // authenticated, and it can send EXACTLY ONE fixed keystroke. There is no
  // parameter for what to send — a button that can type arbitrary keys into a
  // live pane is a remote shell, and this is not that.
  //
  // It exists because the browser can be reachable when SSH is not. On
  // 2026-08-16 ssh to this host was down while the tailnet stayed up, which
  // meant the only way to interrupt a running turn was unavailable.
  if (req.method === 'POST' && p === '/interrupt') {
    if (!sameOrigin(req)) { res.writeHead(403).end('cross-origin'); return; }
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
      res.writeHead(415).end('content-type must be application/json'); return;
    }
    const who = resolveIdentity(req);
    if (!who) { res.writeHead(401).end('unauthenticated'); return; }
    if (!cfg.tmuxSession) {
      res.writeHead(503, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error:'no tmux session configured' })); return;
    }
    await readBody(req);
    const done = await new Promise(resolve => {
      execFile('tmux', ['send-keys', '-t', cfg.tmuxSession, 'Escape'],
        { timeout: 4000 },
        (err, _out, stderr) => resolve(err ? { ok:false, error: (stderr || err.message).trim() }
                                            : { ok:true }));
    });
    log(`interrupt by ${senderAddress(who)} [${who.source}] -> ${done.ok ? 'sent' : done.error}`);
    res.writeHead(done.ok ? 200 : 502, {'Content-Type':'application/json'}).end(JSON.stringify(done));
    return;
  }


  // ---- POST /permission : approve or deny ONE request, BY ID.
  //
  // Never by position. Bastion approved pending[0] during testing and hit a
  // different action than he intended — the mind's own reply call had queued
  // ahead of the Bash command he meant to allow. Requests genuinely queue
  // concurrently; this is not an edge case. The id is the only safe handle.
  if (req.method === 'POST' && p === '/permission') {
    if (!sameOrigin(req)) { res.writeHead(403).end('cross-origin'); return; }
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
      res.writeHead(415).end('content-type must be application/json'); return;
    }
    const who = resolveIdentity(req);
    if (!who) { res.writeHead(401).end('unauthenticated'); return; }

    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* below */ }
    const id = typeof body.request_id === 'string' ? body.request_id.trim() : '';
    const behavior = body.behavior === 'allow' ? 'allow'
                   : body.behavior === 'deny'  ? 'deny' : null;
    if (!id || !behavior) {
      res.writeHead(400, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error:'request_id and behavior ("allow"|"deny") required' }));
      return;
    }

    try {
      const r = await fetch(cfg.channelUrl + '/permission-verdict', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.verdictToken ? { 'X-Verdict-Token': cfg.verdictToken } : {}),
        },
        body: JSON.stringify({ request_id: id, behavior }),
      });
      const out = await r.json().catch(() => ({}));
      log(`permission ${behavior} ${id} by ${senderAddress(who)} -> ${r.status}`);
      pollPermissions();                       // refresh every viewer immediately
      // A request can resolve between render and tap (timeout, terminal answer,
      // session restart). Say so honestly instead of reporting success.
      if (r.status === 404) {
        res.writeHead(409, {'Content-Type':'application/json'})
           .end(JSON.stringify({ ok:false, stale:true,
                                 error:'already resolved or no longer pending' }));
        return;
      }
      res.writeHead(r.ok ? 200 : 502, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok: r.ok, ...out }));
    } catch (err) {
      log(`permission FAILED ${id}: ${err.message}`);
      res.writeHead(502, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error: err.message }));
    }
    return;
  }

  if (req.method === 'GET' && p === '/history') {
    const before = Number(url.searchParams.get('before') || 0);
    const limit = Math.min(500, Number(url.searchParams.get('limit') || 150));
    const page = before > 0 ? eventLog.history(before, limit) : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      events: page,
      first_seq: page.length ? page[0].seq : null,
      more: page.length ? page[0].seq > 1 : false,
    }));
    return;
  }

  if (req.method === 'GET' && p === '/health') {
    const lastAge = stats.lastEventAt ? Math.round((Date.now() - stats.lastEventAt) / 1000) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      instance: cfg.instance,
      epoch: eventLog.epoch,
      seq: eventLog.seq,
      clients: clients.size,
      connected: [...clients].map(c => c.info).filter(Boolean),
      // NOTE: ok:true means THIS PROCESS is alive. It is not evidence the mind
      // is alive — /health once returned ok through a total outage. Judge
      // liveness from last_event_age_s.
      last_event_age_s: lastAge,
      counters: { ...stats },
      pending_permissions: pending,
      pending_age_s: pendingAt ? Math.round((Date.now() - pendingAt)/1000) : null,
      uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
      session: usage ? {
        model: usage.model,
        context_tokens: usage.total,
        context_window: CONTEXT_WINDOW,
        context_pct: +(100 * usage.total / CONTEXT_WINDOW).toFixed(1),
        cached: usage.cache_read,
        at: usage.at,
      } : null,
      write_path: {
        channel_url: cfg.channelUrl || null,
        interrupt: Boolean(cfg.tmuxSession),
        // Loud on purpose: "STUB" here means identity is assumed, not proven.
        identity_source: (resolveIdentity(req) || { source: 'none' }).source,
      },
    }, null, 2));
    return;
  }

  if (req.method === 'GET' && p === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');

    // One code path for history AND live: replay, then continue on the same
    // connection. No snapshot-vs-socket race, because there is no snapshot.
    const lastId = req.headers['last-event-id'] || url.searchParams.get('since') || '';
    let afterSeq = 0;
    const m = /^(\d+)\.(\d+)$/.exec(String(lastId));
    if (m) {
      const [, epoch, seq] = m;
      if (Number(epoch) === eventLog.epoch) afterSeq = Number(seq);
      else res.write(`event: resync\ndata: {"reason":"epoch changed","epoch":${eventLog.epoch}}\n\n`);
    } else if (/^\d+$/.test(String(lastId))) {
      afterSeq = Number(lastId);
    }

    const client = { res, queued: 0, info: describeClient(req, url) };
    log(`client: ${client.info.platform}${client.info.mobile ? ' (mobile)' : ''}`
      + `${client.info.viewport ? ' ' + client.info.viewport : ''}`
      + `${client.info.dpr ? ' @' + client.info.dpr + 'x' : ''}`);
    const backlog = eventLog.replay(afterSeq, REPLAY_LIMIT);
    if (backlog.length) {
      // Tell the client where the window starts so it can offer "load earlier"
      // rather than silently pretending this is the whole conversation.
      sseWrite(client, { epoch: eventLog.epoch, seq: backlog[0].seq - 1,
                         type: 'window_start', ts: new Date().toISOString(),
                         body: { first_seq: backlog[0].seq, more: backlog[0].seq > 1 } });
    }
    for (const ev of backlog) sseWrite(client, ev);
    clients.add(client);
    stats.clients = clients.size;
    log(`client attached (from seq ${afterSeq}); ${clients.size} total`);

    req.on('close', () => { clients.delete(client); stats.clients = clients.size; });
    return;
  }

  if (req.method === 'GET' && p.startsWith('/blob/')) {
    const name = path.basename(p.slice('/blob/'.length));
    try {
      const data = fs.readFileSync(path.join(eventLog.blobDir, name), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(data);
    } catch {
      res.writeHead(404).end('no such blob');
    }
    return;
  }

  // ---- the browser app ----
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    try {
      let html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
      html = html.replace('__BASE_PATH__', cfg.basePath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    } catch (err) {
      res.writeHead(500).end(`cannot read web/index.html: ${err.message}`);
    }
    return;
  }

  res.writeHead(404).end('not found');
  } catch (err) {
    log(`request error: ${err.message}`);
    try { res.writeHead(500).end('server error'); } catch { /* already sent */ }
  }
});

// The channel server this sits beside has no 'error' handler on listen, so an
// EADDRINUSE from a stale predecessor kills it silently. Don't repeat that.
server.on('error', (err) => {
  log(`FATAL server error: ${err.code || err.message}`);
  process.exit(1);
});

server.listen(cfg.port, cfg.bind, () => {
  log(`listening on http://${cfg.bind}:${cfg.port}${cfg.basePath || ''}  (events, health, hook, blob)`);
  // Everything is wired now — safe to start emitting.
  tailer.start({ fromStart: cfg.fromStart });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log(`${sig} — shutting down`); tailer.stop(); server.close(() => process.exit(0)); });
}
