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

const cfg = {
  instance:   process.env.MIRROR_INSTANCE   || 'unknown',
  display:    process.env.MIRROR_DISPLAY    || process.env.MIRROR_INSTANCE || 'Instance',
  transcript: process.env.MIRROR_TRANSCRIPT || '',
  dataDir:    process.env.MIRROR_DATA_DIR   || path.join(process.env.HOME || '/tmp', '.claude-mirror'),
  port:  Number(process.env.MIRROR_PORT || 22090),
  bind:         process.env.MIRROR_BIND || '127.0.0.1',
  room:         process.env.MIRROR_ROOM || 'default',
  fromStart:    process.env.MIRROR_FROM_START === '1',
};

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

// --- the tailer is the source of CONTENT -------------------------------------
const tailer = new TranscriptTailer({
  transcriptPath: cfg.transcript,
  ctx: {
    instance: cfg.instance,
    instanceDisplay: cfg.display,
    roomId: cfg.room,
    speaker: { id: 'user', kind: 'human', display: 'User' },
  },
  onEvents: (events) => {
    for (const ev of events) {
      const stored = eventLog.append(ev);
      stats.events++;
      stats.lastEventAt = Date.now();
      broadcast(stored);
    }
  },
  log,
});
// NOTE: start() is deliberately NOT called here. It emits subagent_start events
// synchronously for every transcript already on disk, which reaches broadcast()
// before `clients` exists. Started at the bottom, once everything is wired.

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || cfg.bind}`);

  // ---- POST /hook : FAST ACK. Do not add work here. ----
  if (req.method === 'POST' && url.pathname === '/hook') {
    res.writeHead(204).end();          // ACK first — the session is blocked
    stats.hooks++;
    readBody(req).catch(() => {});     // drain, deliberately ignored
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    const lastAge = stats.lastEventAt ? Math.round((Date.now() - stats.lastEventAt) / 1000) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      instance: cfg.instance,
      epoch: eventLog.epoch,
      seq: eventLog.seq,
      clients: clients.size,
      // NOTE: ok:true means THIS PROCESS is alive. It is not evidence the mind
      // is alive — /health once returned ok through a total outage. Judge
      // liveness from last_event_age_s.
      last_event_age_s: lastAge,
      counters: { ...stats },
      uptime_s: Math.round((Date.now() - stats.startedAt) / 1000),
    }, null, 2));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/events') {
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

    const client = { res, queued: 0 };
    for (const ev of eventLog.replay(afterSeq)) sseWrite(client, ev);
    clients.add(client);
    stats.clients = clients.size;
    log(`client attached (from seq ${afterSeq}); ${clients.size} total`);

    req.on('close', () => { clients.delete(client); stats.clients = clients.size; });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/blob/')) {
    const name = path.basename(url.pathname.slice('/blob/'.length));
    try {
      const data = fs.readFileSync(path.join(eventLog.blobDir, name), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(data);
    } catch {
      res.writeHead(404).end('no such blob');
    }
    return;
  }

  // ---- the browser app ----
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    try {
      const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
    } catch (err) {
      res.writeHead(500).end(`cannot read web/index.html: ${err.message}`);
    }
    return;
  }

  res.writeHead(404).end('not found');
});

// The channel server this sits beside has no 'error' handler on listen, so an
// EADDRINUSE from a stale predecessor kills it silently. Don't repeat that.
server.on('error', (err) => {
  log(`FATAL server error: ${err.code || err.message}`);
  process.exit(1);
});

server.listen(cfg.port, cfg.bind, () => {
  log(`listening on http://${cfg.bind}:${cfg.port}  (events, health, hook, blob)`);
  // Everything is wired now — safe to start emitting.
  tailer.start({ fromStart: cfg.fromStart });
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log(`${sig} — shutting down`); tailer.stop(); server.close(() => process.exit(0)); });
}
