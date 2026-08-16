/**
 * Append-only mirror event log.
 *
 * THE ONE ORDERING RULE: append first, then broadcast. `seq` is assigned at
 * append time, so there is never a window where an event was broadcast but not
 * logged — which is what makes reconnect-with-Last-Event-ID gapless.
 *
 * `epoch` increments on every server start. A client that sees an epoch lower
 * than the one it holds knows to resync rather than assume it missed events.
 * (The log survives restarts; in-memory state does not.)
 *
 * Cairn-2001
 */

import fs from 'node:fs';
import path from 'node:path';

/** Events larger than this are truncated and the remainder spilled to a blob. */
export const MAX_INLINE_BYTES = 32 * 1024;

export class EventLog {
  /**
   * @param {string} dataDir  directory for the log + blobs
   * @param {string} instanceId
   */
  constructor(dataDir, instanceId) {
    this.dataDir = dataDir;
    this.instanceId = instanceId;
    this.logPath = path.join(dataDir, `${instanceId}.jsonl`);
    this.blobDir = path.join(dataDir, 'blobs');
    this.statePath = path.join(dataDir, `${instanceId}.state.json`);

    fs.mkdirSync(this.blobDir, { recursive: true });

    this.seq = this._recoverSeq();
    this.epoch = this._bumpEpoch();
    this.listeners = new Set();
    this.fd = fs.openSync(this.logPath, 'a');
  }

  /**
   * Resume the sequence from the log itself rather than a sidecar counter —
   * the log is the thing that must not lie. Reads the tail only.
   */
  _recoverSeq() {
    try {
      const size = fs.statSync(this.logPath).size;
      if (!size) return 0;
      const window = Math.min(size, 64 * 1024);
      const buf = Buffer.alloc(window);
      const fd = fs.openSync(this.logPath, 'r');
      fs.readSync(fd, buf, 0, window, size - window);
      fs.closeSync(fd);
      const lines = buf.toString('utf8').split('\n').filter(Boolean);
      // Walk backwards: the final line may be torn (see Law 4.2).
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const seq = JSON.parse(lines[i]).seq;
          if (Number.isInteger(seq)) return seq;
        } catch { /* torn or partial — keep walking back */ }
      }
    } catch { /* no log yet */ }
    return 0;
  }

  _bumpEpoch() {
    let state = { epoch: 0 };
    try { state = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch { /* first run */ }
    const epoch = (state.epoch || 0) + 1;
    fs.writeFileSync(this.statePath, JSON.stringify({ epoch }, null, 2));
    return epoch;
  }

  /**
   * Append an event, then hand it to listeners. Never the other way round.
   * @returns {object} the stored event, with seq/epoch stamped on
   */
  append(event) {
    const stored = truncateEvent({
      ...event,
      seq: ++this.seq,
      epoch: this.epoch,
      instance: this.instanceId,
    }, this.blobDir);

    fs.writeSync(this.fd, JSON.stringify(stored) + '\n');

    for (const fn of this.listeners) {
      try { fn(stored); } catch { /* a bad listener must never stall the log */ }
    }
    return stored;
  }

  /**
   * Read a window of lines from the END of the log without loading the file.
   *
   * The log is append-only and never rotated — it passed 3.6 MB in three days.
   * Reading it whole on every connect blocked the event loop, and a phone that
   * wakes and retries does exactly that. Grows the read window until it has
   * enough lines or hits the head.
   */
  _tailLines(wanted) {
    let size;
    try { size = fs.statSync(this.logPath).size; } catch { return []; }
    if (!size) return [];
    const fd = fs.openSync(this.logPath, 'r');
    try {
      let window = 64 * 1024, lines = [];
      while (true) {
        const start = Math.max(0, size - window);
        const buf = Buffer.alloc(size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        lines = buf.toString('utf8').split('\n').filter(Boolean);
        // A partial first line is expected unless we reached the head.
        if (start > 0) lines.shift();
        if (lines.length >= wanted || start === 0 || window > 32 * 1024 * 1024) break;
        window *= 4;
      }
      return lines.slice(-wanted);
    } finally { fs.closeSync(fd); }
  }

  /**
   * Events after `afterSeq`, newest-biased and always bounded.
   * A fresh client gets the tail; a reconnect gets what it missed.
   */
  replay(afterSeq = 0, limit = 300) {
    const out = [];
    for (const line of this._tailLines(limit * 3)) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; } // torn line: skip, never fatal
      if (ev.seq > afterSeq) out.push(ev);
    }
    return out.slice(-limit);
  }

  /** A page of history strictly BEFORE `beforeSeq`, for scrolling upward. */
  history(beforeSeq, limit = 150) {
    const out = [];
    // Scan far enough back to be likely to cover the page; bounded either way.
    for (const line of this._tailLines(Math.max(2000, limit * 20))) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.seq < beforeSeq) out.push(ev);
    }
    return out.slice(-limit);
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/**
 * Cap an event's inline size, spilling the oversized field to a blob.
 * A single observed tool_result was 1 MB — streaming that inline would wedge
 * both the SSE queue and the browser, so this is mandatory, not an optimization.
 */
export function truncateEvent(event, blobDir) {
  const json = JSON.stringify(event);
  if (Buffer.byteLength(json, 'utf8') <= MAX_INLINE_BYTES) return event;

  const body = { ...(event.body || {}) };
  // Find the largest string field — that's what blew the budget.
  let biggest = null, biggestLen = 0;
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string' && v.length > biggestLen) { biggest = k; biggestLen = v.length; }
  }
  if (!biggest) return event;

  const full = body[biggest];
  const ref = `${event.epoch || 0}-${event.seq}-${biggest}.txt`;
  try {
    fs.writeFileSync(path.join(blobDir, ref), full);
  } catch {
    return event; // if we can't spill, better to send it large than to lose it
  }

  body[biggest] = full.slice(0, 4096);
  body.truncated = true;
  body.full_bytes = Buffer.byteLength(full, 'utf8');
  body.blob_ref = ref;
  return { ...event, body };
}
