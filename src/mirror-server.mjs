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
import { resolveIdentity, senderAddress, stubIdentity, mayWrite,
         identityStartupRefusal } from './identity.mjs';
import { FileStore, MAX_UPLOAD_BYTES, isInlineImage } from './files.mjs';
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

  // 'full'        — tail the transcript and publish the session (the default)
  // 'permissions' — publish NOTHING about the session except pending permission
  //                 requests, and accept verdicts. For Bastion, who runs as root
  //                 without --dangerously-skip-permissions: he needs the approval
  //                 panel, and a transcript mirror of a root session would publish
  //                 every config read and every path on the box to a web page.
  //
  // This is enforced by ABSENT CAPABILITY, not by a hidden button. Every route
  // that could disclose session content is refused at the server in this mode.
  mode: process.env.MIRROR_MODE === 'permissions' ? 'permissions' : 'full',
};

// Writing into a live session is a separate grant from watching one. It used to
// be implied by MIRROR_CHANNEL_URL — but permissions mode NEEDS that URL to poll
// and to deliver verdicts, so the two must be decoupled or enabling approvals
// would silently enable injection.
cfg.allowSend = process.env.MIRROR_ALLOW_SEND === '1' ? true
              : process.env.MIRROR_ALLOW_SEND === '0' ? false
              : cfg.mode === 'full' && Boolean(cfg.channelUrl);

// Interrupt is also a WRITE — console access to a live session, one fixed key.
// It used to be enabled by merely knowing the tmux session name, so permissions
// mode refused message injection while still offering ESC to a ROOT session.
// Bastion caught that asymmetry: both are writes, so both need a grant. Full
// mode keeps its previous behaviour; permissions mode requires an explicit yes.
cfg.allowInterrupt = process.env.MIRROR_ALLOW_INTERRUPT === '1' ? true
                   : process.env.MIRROR_ALLOW_INTERRUPT === '0' ? false
                   : cfg.mode === 'full' && Boolean(cfg.tmuxSession);

// Slash commands type text into a live pane, so they get their OWN grant rather
// than riding on another. Off unless asked for, in every mode — the lesson from
// --with-input silently arriving via flag ordering.
cfg.allowCommands = process.env.MIRROR_ALLOW_COMMANDS === '1';

/**
 * The allowlist. Short on purpose, and the omissions are the design.
 *
 * IN: commands that print something and return.
 *
 * OUT — interactive TUI (`config`, `model`, `agents`, `mcp`, `plugin`, `login`,
 * `theme`, `vim`…). Fired blind from a browser these leave the pane inside a
 * modal the viewer cannot see or dismiss, stranding the session until someone
 * reaches a terminal. Worse than not having the feature.
 *
 * OUT — destructive (`clear`, `exit`, `quit`). A mis-tap on a phone should not
 * be able to end a mind's context. `compact` is in because it is a routine,
 * recoverable operation Lupo performs deliberately.
 */
cfg.commandAllow = new Set(
  (process.env.MIRROR_COMMAND_ALLOW || 'context,cost,status,help,compact,export,plan')
    .split(',').map(s => s.trim().replace(/^\/+/, '').toLowerCase()).filter(Boolean));

/** Strip the base path; returns null when the request isn't ours. */
function route(pathname) {
  if (!cfg.basePath) return pathname;
  if (pathname === cfg.basePath) return '/';
  if (pathname.startsWith(cfg.basePath + '/')) return pathname.slice(cfg.basePath.length);
  return null;
}

if (!cfg.transcript && cfg.mode === 'full') {
  console.error('MIRROR_TRANSCRIPT is required (path to the session .jsonl)');
  process.exit(1);
}
if (cfg.mode === 'permissions' && !cfg.channelUrl) {
  console.error('MIRROR_MODE=permissions requires MIRROR_CHANNEL_URL — there is nothing to do without it');
  process.exit(1);
}
// A configuration whose safety nobody has stated must not start. See
// identityStartupRefusal() for the two cases and why each is enforced rather
// than documented.
const idRefusal = identityStartupRefusal(cfg.bind);
if (idRefusal) {
  console.error(`refusing to start: ${idRefusal}`);
  process.exit(1);
}

fs.mkdirSync(cfg.dataDir, { recursive: true });

// --- mode stickiness ---------------------------------------------------------
// The failure worth preventing: MIRROR_MODE unset on some later restart, and a
// root session silently becomes a full mirror publishing every command it runs.
// A startup banner is not a control — nobody reads it on the restart that
// matters, which is always the unattended one.
//
// So the DEPLOYMENT remembers instead of the operator. Once a data dir has been
// used in permissions mode it is marked, and a full-mode start against that dir
// REFUSES TO BOOT. The failure direction flips from silently-publishes-root to
// loudly-refuses-to-start. Bastion's suggestion, and better than anything I had.
const modeMarker = path.join(cfg.dataDir, '.permissions-only');
const markedPermissions = fs.existsSync(modeMarker);
if (markedPermissions && cfg.mode !== 'permissions') {
  console.error(
    `refusing to start: ${cfg.dataDir} is marked permissions-only, but MIRROR_MODE is "${cfg.mode}".\n` +
    `  This data dir belongs to a session that chose not to be published.\n` +
    `  Starting in full mode would publish its transcript.\n\n` +
    `  If that is genuinely intended, clear the marker deliberately:\n` +
    `      rm ${modeMarker}`);
  process.exit(1);
}
if (cfg.mode === 'permissions' && !markedPermissions) {
  try { fs.writeFileSync(modeMarker, `marked ${new Date().toISOString()}\n`); }
  catch (err) { console.error(`could not write mode marker: ${err.message}`); process.exit(1); }
}

const log = (m) => console.log(`[mirror] ${new Date().toISOString()} ${m}`);
const eventLog = new EventLog(cfg.dataDir, cfg.instance);
log(`instance=${cfg.instance} epoch=${eventLog.epoch} resuming from seq=${eventLog.seq}`);

// Inbound and outbound files. Adopting the existing outbox at startup (rather
// than announcing it) is the restart-safety lesson from the tailer, applied
// before it can bite a second time.
const files = new FileStore(cfg.dataDir);
log(`files: inbox=${files.inbox} outbox=${files.outbox} (${files.primeOutbox()} already present, not re-announced)`);

// --- schema canary -----------------------------------------------------------
// Advisory, never fatal: a renamed field should page us, not take the mirror down.
if (cfg.mode === 'full') try {
  const sample = fs.readFileSync(cfg.transcript, 'utf8').split('\n').slice(-400);
  const canary = schemaCanary(sample);
  if (canary.ok) log(`schema canary OK (${canary.stats.parsed} sampled)`);
  else for (const w of canary.warnings) log(`SCHEMA DRIFT: ${w}`);
} catch (err) {
  log(`schema canary skipped: ${err.message}`);
}

// --- version, and whether this process is stale ------------------------------
//
// Four mirrors ran for three days on copies frozen at whenever each was set up,
// and nothing anywhere said so. From inside the deployment that was current,
// everything looked fine — the same blind spot as every other defect this week.
//
// So the process reports what it is running, and notices when the code under it
// changes. The dangerous case is NOT stale files; it is FRESH files with a stale
// process: web/index.html is re-read on every request, so a pull-without-restart
// serves a new page against an old server. That renders buttons which POST to
// endpoints the running process does not have.
//
// Deliberately local — nothing phones home. It compares the running process to
// the disk beneath it, which is the question that actually has a wrong answer.
const SRC_DIR = new URL('.', import.meta.url).pathname;
function srcFingerprint() {
  const parts = [];
  try {
    for (const f of fs.readdirSync(SRC_DIR).filter(n => n.endsWith('.mjs')).sort()) {
      const st = fs.statSync(path.join(SRC_DIR, f));
      parts.push(`${f}:${st.size}:${Math.floor(st.mtimeMs)}`);
    }
  } catch { /* unreadable — report what we have */ }
  return parts.join('|');
}
function gitCommit() {
  try {
    const head = fs.readFileSync(path.join(SRC_DIR, '..', '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref: (.+)$/.exec(head);
    if (!m) return head.slice(0, 12);
    return fs.readFileSync(path.join(SRC_DIR, '..', '.git', m[1]), 'utf8').trim().slice(0, 12);
  } catch { return null; }
}
const bootFingerprint = srcFingerprint();
const bootCommit = gitCommit();
let srcChangedAt = null;
setInterval(() => {
  if (srcChangedAt) return;                        // already known; stop stat-ing
  if (srcFingerprint() !== bootFingerprint) {
    srcChangedAt = Date.now();
    log('SOURCE CHANGED ON DISK — this process is running the OLD code. Restart to apply.');
  }
}, 30000).unref();

// --- health/observability counters -------------------------------------------
const stats = { hooks: 0, events: 0, clients: 0, dropped: 0, lastEventAt: null, startedAt: Date.now() };
let usage = null;   // latest context accounting, straight from the transcript
const CONTEXT_WINDOW = Number(process.env.MIRROR_CONTEXT_WINDOW || 1_000_000);
const REPLAY_LIMIT   = Number(process.env.MIRROR_REPLAY_LIMIT || 300);

// --- the tailer is the source of CONTENT -------------------------------------
// In permissions mode it is never constructed. The transcript is the ONLY thing
// that turns into published session content, so not building the reader is the
// whole privacy guarantee — there is no code path from the session to a viewer.
const tailer = cfg.mode !== 'full' ? null : new TranscriptTailer({
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
let lastAssert = 0;

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
    // Re-assert periodically even when unchanged. /health no longer carries the
    // list, so this stream is the only source of detail — and Bastion's rule
    // that "the poll is the only truth and it always wins" has to survive a
    // viewer that missed a push, not just one that was watching at the time.
    const stale = Date.now() - lastAssert > 15000;
    if (before !== after || stale) {
      lastAssert = Date.now();
      // EPHEMERAL, and deliberately never logged.
      //
      // This used to call eventLog.append(), which was wrong twice over: the
      // appended event was never broadcast (nothing subscribes the log to
      // broadcast, so the "everyone updates at once" it claimed never
      // happened), and worse, it PERSISTED a snapshot of live state. On
      // reconnect the client replayed it and rendered cards for requests
      // resolved hours earlier — exactly Bastion's requirement #4, violated by
      // the transport rather than the UI.
      //
      // A pending list is state, not history. The log is for conversation.
      broadcastEphemeral(permissionsEvent());
    }
  } catch { /* channel down or restarting — leave the last known state */ }
}
setInterval(pollPermissions, 2000).unref();

// --- outbox: files the instance is offering to the human ---------------------
// The instance writes a file into outbox/; that write IS the intent to publish.
// Polled rather than fs.watch()'d for the same reason permissions are: watch
// semantics vary by platform and filesystem, and a missed event here is a file
// the human never learns exists.
function pollOutbox() {
  for (const f of files.scanOutbox()) {
    const stored = eventLog.append({
      ts: new Date().toISOString(), room_id: cfg.room, type: 'file',
      from: { id: cfg.instance, kind: 'instance', display: cfg.display },
      body: {
        direction: 'out', name: f.name, bytes: f.bytes, inline: f.inline,
        url: `${cfg.basePath}/file/outbox/${encodeURIComponent(f.name)}`,
      },
    });
    stats.events++;
    stats.lastEventAt = Date.now();
    broadcast(stored);
    log(`outbox -> ${f.name} (${f.bytes} bytes)`);
  }
}
setInterval(pollOutbox, 2000).unref();

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

/**
 * Push live STATE to every viewer without writing it to the log.
 *
 * The frame carries no `id:` line on purpose. SSE only advances a client's
 * Last-Event-ID when a frame supplies one, so an ephemeral push cannot make a
 * reconnecting browser skip real events it never received. That property is
 * what lets state and history share one connection safely.
 */
function ephemeralFrame(ev) {
  return `event: mirror\ndata: ${JSON.stringify({ ...ev, ephemeral: true })}\n\n`;
}

function broadcastEphemeral(ev) {
  const frame = ephemeralFrame(ev);
  for (const c of clients) {
    try { c.res.write(frame); } catch { clients.delete(c); }
  }
}

/** The current pending-permission state, as an ephemeral event. */
function permissionsEvent() {
  return {
    ts: new Date().toISOString(), room_id: cfg.room, type: 'permissions',
    from: { id: 'system', kind: 'system', display: 'permissions' },
    body: { pending },
  };
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
 * Read a request body as BYTES, REFUSING anything over the cap.
 *
 * readBody() above silently drops whatever exceeds its limit. That is fine for
 * a JSON message and catastrophic for a file: the upload would report success
 * and the human would have sent a truncated image, with no error anywhere in
 * the system. Silent truncation is the worst available failure, so this one
 * rejects and stops reading the moment the cap is passed.
 */
function readBodyBuffer(req, limit = MAX_UPLOAD_BYTES) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) {
        req.destroy();
        reject(Object.assign(new Error('file too large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Human-readable byte count, for log lines and chat text. */
function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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

  // ---- permissions mode: refuse every route that could disclose the session.
  //
  // Deliberately ONE list in ONE place, so the whole disclosure surface can be
  // audited without reading the rest of the file. Enforced at the server, not by
  // hiding controls: the guarantee has to be an absent capability, not an
  // unrendered button.
  //
  // /events stays open because it is the transport for the permission panel —
  // but its REPLAY is suppressed separately below. A log written during an
  // earlier run in full mode is still on disk, and replaying it here would hand
  // back the very session content this mode exists to withhold.
  if (cfg.mode === 'permissions') {
    for (const r of ['/history', '/blob/', '/file/', '/upload']) {
      if (p === r || p.startsWith(r)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
           .end(JSON.stringify({ ok: false, error: 'not available in permissions mode' }));
        return;
      }
    }
  }

  // ---- POST /hook : FAST ACK. Do not add work here. ----
  if (req.method === 'POST' && p === '/hook') {
    res.writeHead(204).end();          // ACK first — the session is blocked
    stats.hooks++;
    readBody(req).catch(() => {});     // drain, deliberately ignored
    return;
  }


  // ---- POST /send : the write leg. Browser -> channel server -> live session.
  if (req.method === 'POST' && p === '/send') {
    // Writing into a session is a separate grant from watching one. Approvals
    // need the channel URL, so deriving "can send" from "has a channel URL"
    // would make enabling the permission panel silently enable injection too.
    if (!cfg.allowSend) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
         .end(JSON.stringify({ ok: false, error: 'input is not enabled on this mirror' }));
      return;
    }
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
    if (!mayWrite(who)) { res.writeHead(401, {'Content-Type':'application/json'})
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

  // ---- POST /upload : a file from the browser into the instance's inbox.
  //
  // Raw bytes, with the name in X-Filename rather than multipart — a custom
  // header cannot be set by a cross-origin form or <img>, so it forces a
  // preflight that sameOrigin() then rejects. Same CSRF property /send gets
  // from requiring application/json, without hand-parsing multipart.
  //
  // The file is stored AND announced twice, deliberately: as a mirror event so
  // every viewer sees it land, and as a channel message so the instance
  // actually knows it arrived. A file that only appears in the browser is a
  // file the mind never learns about.
  if (req.method === 'POST' && p === '/upload') {
    if (!sameOrigin(req)) { res.writeHead(403).end('cross-origin'); return; }
    const rawName = req.headers['x-filename'];
    if (!rawName) {
      res.writeHead(400, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error:'X-Filename header required' })); return;
    }
    const who = resolveIdentity(req);
    if (!mayWrite(who)) { res.writeHead(401, {'Content-Type':'application/json'})
                   .end(JSON.stringify({ ok:false, error:'unauthenticated' })); return; }

    // Check the declared length BEFORE reading a byte.
    //
    // Measured, not assumed: the streaming guard below works — it refuses the
    // upload and stores nothing — but it destroys the socket to stop the
    // transfer, and a destroyed socket cannot carry the 413 back. The browser
    // saw a network error instead of "too large, the limit is 25 MB", which
    // made a handled condition look like a broken mirror. A browser always
    // sends Content-Length for a File body, so the common case answers cleanly
    // here and the stream guard stays as the backstop for chunked bodies.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
      log(`upload REJECTED from ${senderAddress(who)}: declared ${humanBytes(declared)} > cap`);
      res.writeHead(413, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error:'file too large',
                               limit_bytes: MAX_UPLOAD_BYTES }));
      return;
    }

    let buf;
    try {
      buf = await readBodyBuffer(req);
    } catch (err) {
      const tooBig = err.code === 'TOO_LARGE';
      log(`upload REJECTED from ${senderAddress(who)}: ${err.message}`);
      res.writeHead(tooBig ? 413 : 400, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error: err.message,
                               limit_bytes: tooBig ? MAX_UPLOAD_BYTES : undefined }));
      return;
    }
    if (!buf.length) {
      res.writeHead(400, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error:'empty file' })); return;
    }

    let saved;
    try { saved = files.saveInbound(buf, decodeURIComponent(String(rawName))); }
    catch (err) {
      log(`upload FAILED to store: ${err.message}`);
      res.writeHead(500, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error:'could not store file' })); return;
    }

    const stored = eventLog.append({
      ts: new Date().toISOString(), room_id: cfg.room, type: 'file',
      from: { id: who.id, kind: who.kind, display: who.display },
      body: {
        direction: 'in', name: saved.name, bytes: saved.bytes, inline: saved.inline,
        path: saved.path,
        url: `${cfg.basePath}/file/inbox/${encodeURIComponent(saved.stored)}`,
      },
    });
    stats.events++;
    stats.lastEventAt = Date.now();
    broadcast(stored);
    log(`upload from ${senderAddress(who)}: ${saved.name} ${humanBytes(saved.bytes)} -> ${saved.stored}`);

    // Ring the instance. The absolute path is the payload that matters — it is
    // what makes the file readable with an ordinary file tool, no new verb.
    if (cfg.channelUrl) {
      try {
        await fetch(cfg.channelUrl + '/direct-message', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: senderAddress(who),
            text: `[file] sent you "${saved.name}" (${humanBytes(saved.bytes)}). `
                + `It is on disk at: ${saved.path}`,
            thread_id: String(cfg.threadId),
          }),
        });
      } catch (err) {
        // The file is stored and visible either way; say so rather than failing.
        log(`upload stored but channel notify failed: ${err.message}`);
      }
    }

    res.writeHead(200, {'Content-Type':'application/json'})
       .end(JSON.stringify({ ok:true, name: saved.name, bytes: saved.bytes,
                             path: saved.path, inline: saved.inline,
                             url: `${cfg.basePath}/file/inbox/${encodeURIComponent(saved.stored)}` }));
    return;
  }

  // ---- GET /file/<box>/<name> : serve an inbox or outbox file.
  //
  // Only ever from those two directories, resolved through realpath so a
  // symlink cannot point out of them. Type comes from the extension and is
  // sent with nosniff; anything not on the raster-image allowlist downloads
  // rather than renders, because an HTML or SVG document served here would be
  // same-origin with a page that can POST into a live session.
  if (req.method === 'GET' && p.startsWith('/file/')) {
    const [, , box, ...rest] = p.split('/');
    const full = files.resolveServable(box, decodeURIComponent(rest.join('/')));
    if (!full) { res.writeHead(404).end('no such file'); return; }
    const base = path.basename(full);
    let size = 0;
    try { size = fs.statSync(full).size; } catch { res.writeHead(404).end('no such file'); return; }
    res.writeHead(200, {
      'Content-Type': files.contentType(base),
      'Content-Length': size,
      'X-Content-Type-Options': 'nosniff',
      // Strip CR/LF and control characters HERE, not only upstream.
      //
      // Axiom's finding: this line stripped quotes and backslashes, and was safe
      // from header injection only because safeName() had already removed
      // control characters several layers earlier. Correct today, and correct
      // for a reason that does not live at the point of use — so any future path
      // that serves a name from a less-sanitised source turns this line into
      // header injection, silently.
      //
      // That is the exact defect class this project keeps finding: a protection
      // that holds because of an invariant somewhere else. Enforce it locally.
      'Content-Disposition':
        `${isInlineImage(base) ? 'inline' : 'attachment'}; `
        + `filename="${base.replace(/["\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, '')}"`,
      'Cache-Control': 'private, max-age=300',
    });
    // Streamed: a 25 MB readFileSync would block the loop that is watching a mind.
    const stream = fs.createReadStream(full);
    stream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
    stream.pipe(res);
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
    if (!mayWrite(who)) { res.writeHead(401).end('unauthenticated'); return; }
    if (!cfg.allowInterrupt) {
      res.writeHead(403, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error:'interrupt is not enabled on this mirror' })); return;
    }
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


  // ---- POST /command : run an ALLOWLISTED slash command in the session.
  //
  // This is the one endpoint that types text into a live pane, so it is the one
  // that most needs its limits stated rather than implied.
  //
  // WHAT MAKES IT NOT A REMOTE SHELL:
  //   1. The command name must be on an allowlist. Not "not on a denylist" —
  //      on a list. Anything unrecognised is refused by name.
  //   2. Everything sent begins with '/', which is also why a stray send into a
  //      dead pane is inert: a shell reads "/context" as a path and fails to
  //      find it. That is luck turned into a property, so it is written down.
  //   3. Args are stripped of newlines and control characters. A newline is an
  //      Enter press — without this, one "argument" could submit further lines
  //      into the session. That is the injection that matters here.
  //   4. send-keys uses -l (literal), so nothing is interpreted as a key name.
  //
  // WHAT IS DELIBERATELY NOT ALLOWED, and why the allowlist is short:
  // commands that open an interactive TUI (config, model, agents, mcp…) would
  // leave the pane inside a modal the browser cannot see or dismiss — stranding
  // the session in a state only someone at the terminal can clear. That is
  // worse than not having the feature. Destructive ones (clear, exit) are out
  // because a mis-tap on a phone should not be able to end a mind's context.
  if (req.method === 'POST' && p === '/command') {
    if (!sameOrigin(req)) { res.writeHead(403).end('cross-origin'); return; }
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) {
      res.writeHead(415).end('content-type must be application/json'); return;
    }
    const who = resolveIdentity(req);
    if (!mayWrite(who)) { res.writeHead(401).end('unauthenticated'); return; }
    if (!cfg.allowCommands) {
      res.writeHead(403, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error:'slash commands are not enabled on this mirror' }));
      return;
    }
    if (!cfg.tmuxSession) {
      res.writeHead(503, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error:'no tmux session configured' })); return;
    }

    let body = {};
    try { body = JSON.parse(await readBody(req)); } catch { /* below */ }
    const name = String(body.name || '').trim().replace(/^\/+/, '').toLowerCase();
    const rawArgs = String(body.args || '');
    // Newlines ARE Enter presses. Strip them and every other control char.
    // Escapes, NOT literal control bytes. Typing the raw characters here put
    // 0x00 and 0x1f into the source: it parsed fine, behaved correctly, and
    // silently made the file BINARY to grep — every search returned nothing,
    // including searches for unrelated code. Correct and unsearchable.
    const args = rawArgs.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);

    if (!/^[a-z][a-z0-9:_-]*$/.test(name) || !cfg.commandAllow.has(name)) {
      log(`command REFUSED "${name}" from ${senderAddress(who)}`);
      res.writeHead(403, {'Content-Type':'application/json'})
         .end(JSON.stringify({ ok:false, error:`"/${name}" is not allowed`,
                               allowed: [...cfg.commandAllow].sort() }));
      return;
    }

    const line = `/${name}${args ? ' ' + args : ''}`;
    const done = await new Promise(resolve => {
      // Literal text first, THEN Enter as a separate key. Sending them together
      // would let the text be parsed as key names.
      execFile('tmux', ['send-keys', '-t', cfg.tmuxSession, '-l', '--', line],
        { timeout: 4000 }, (err, _o, stderr) => {
          if (err) return resolve({ ok:false, error:(stderr || err.message).trim() });
          execFile('tmux', ['send-keys', '-t', cfg.tmuxSession, 'Enter'],
            { timeout: 4000 }, (e2, _o2, se2) =>
              resolve(e2 ? { ok:false, error:(se2 || e2.message).trim() } : { ok:true, sent: line }));
        });
    });
    log(`command ${line} by ${senderAddress(who)} -> ${done.ok ? 'sent' : done.error}`);
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
    if (!mayWrite(who)) { res.writeHead(401).end('unauthenticated'); return; }

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
      // Where the RECORD begins — not where the session did. The UI says so
      // when you reach the top, rather than letting an exhausted list imply
      // it found the beginning.
      log_start: eventLog.firstTs(),
    }));
    return;
  }

  if (req.method === 'GET' && p === '/health') {
    const lastAge = stats.lastEventAt ? Math.round((Date.now() - stats.lastEventAt) / 1000) : null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      instance: cfg.instance,
      // Stated plainly so a viewer can tell which mirror they are looking at
      // without inferring it from what happens to be missing.
      mode: cfg.mode,
      publishes_session: cfg.mode === 'full',
      // What this PROCESS is running, and whether the disk has moved under it.
      version: {
        commit: bootCommit,
        src_changed_on_disk: Boolean(srcChangedAt),
        restart_required: Boolean(srcChangedAt),
      },
      epoch: eventLog.epoch,
      seq: eventLog.seq,
      clients: clients.size,
      connected: [...clients].map(c => c.info).filter(Boolean),
      // NOTE: ok:true means THIS PROCESS is alive. It is not evidence the mind
      // is alive — /health once returned ok through a total outage. Judge
      // liveness from last_event_age_s.
      last_event_age_s: lastAge,
      counters: { ...stats },
      // A COUNT, never the list.
      //
      // Bastion's H-04 patch gates GET /pending-permissions on the CHANNEL
      // server behind kernel-verified peer uid, because an unauthenticated read
      // of pending request_ids plus a verdict POST is a privilege-escalation
      // chain against a root session. This endpoint held the same data on a
      // different port and served it unauthenticated — re-opening on 22004 the
      // hole his patch closes on 21004.
      //
      // Each component was defensible alone; together they were a bypass.
      // Neither of us could see it from inside our own review.
      //
      // Detail now travels only over /events, which is already the payload path
      // and is pushed to attached viewers. /health stays a liveness probe, which
      // is what an unauthenticated caller legitimately wants from it.
      pending_permissions_count: pending.length,
      pending_age_s: pendingAt ? Math.round((Date.now() - pendingAt)/1000) : null,
      // Published so the UI states the real limit rather than a hardcoded one
      // that drifts out of agreement with the server.
      limits: { max_upload_bytes: MAX_UPLOAD_BYTES },
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
        send: cfg.allowSend,
        interrupt: cfg.allowInterrupt,
        commands: cfg.allowCommands ? [...cfg.commandAllow].sort() : false,
        // Loud on purpose: "STUB" here means identity is assumed, not proven.
        identity_source: (resolveIdentity(req) || { source: 'none' }).source,
        may_write: mayWrite(resolveIdentity(req)),
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
    // No replay in permissions mode. Nothing is appended to the log there, but
    // the FILE may still hold a full-mode history from an earlier run — and
    // serving that would defeat the entire point of the mode.
    const backlog = cfg.mode === 'full' ? eventLog.replay(afterSeq, REPLAY_LIMIT) : [];
    if (backlog.length) {
      // Tell the client where the window starts so it can offer "load earlier"
      // rather than silently pretending this is the whole conversation.
      sseWrite(client, { epoch: eventLog.epoch, seq: backlog[0].seq - 1,
                         type: 'window_start', ts: new Date().toISOString(),
                         body: { first_seq: backlog[0].seq, more: backlog[0].seq > 1,
                                 log_start: eventLog.firstTs() } });
    }
    for (const ev of backlog) sseWrite(client, ev);
    clients.add(client);
    stats.clients = clients.size;
    // Hand the new viewer the current pending state at once. /health no longer
    // carries the list, and ephemeral frames are never replayed, so without this
    // a freshly opened tab would show no cards until the next change — which,
    // for a session blocked on approval, could be forever.
    if (pending.length) { try { client.res.write(ephemeralFrame(permissionsEvent())); } catch { /* gone */ } }
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
      html = html.replace('__BASE_PATH__', cfg.basePath)
                 // Injected rather than discovered from /health, so the page is
                 // never briefly dressed as a full mirror before finding out it
                 // isn't one. The server-side gates are the actual control; this
                 // only makes the page tell the truth from the first paint.
                 .replace('__MIRROR_MODE__', cfg.mode)
                 .replace('__MIRROR_SEND__', String(cfg.allowSend));
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
  if (tailer) tailer.start({ fromStart: cfg.fromStart });
  else log('MODE=permissions — no transcript is read, nothing about this session is published');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    log(`${sig} — shutting down`);
    if (tailer) tailer.stop();

    // End the SSE streams FIRST.
    //
    // server.close() stops accepting new connections and then waits for the
    // open ones to finish — and an SSE stream never finishes, by design. So a
    // mirror with a browser attached would release its listening socket and
    // then live forever, invisible to `ss -lntp` but present in `ps`.
    //
    // Measured, not theorised: a SIGTERM'd mirror was still running four
    // minutes later, and the restart after it picked that pid instead of the
    // live one and failed EADDRINUSE against the process it meant to replace.
    // Silent, and it makes "just restart the mirror" advice wrong.
    for (const c of clients) { try { c.res.end(); } catch { /* already gone */ } }
    clients.clear();

    server.close(() => process.exit(0));
    // Backstop: no socket in a strange state gets to keep this process alive.
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
