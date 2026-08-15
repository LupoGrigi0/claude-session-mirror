/**
 * Transcript tailer — follows a Claude Code session JSONL from a byte offset,
 * plus every subagent transcript that appears beside it.
 *
 * Why tail files instead of taking content from hooks:
 *  - Subagent narration exists ONLY here. Hooks give {agent_id, agent_type} at
 *    start and nothing until SubagentStop, so a 15-minute research agent is
 *    invisible through hooks while its transcript is being written the whole
 *    time. (Measured: meta at 22:36:40, jsonl still appending at 22:51:42.)
 *  - Files survive a Claude Code crash. Hook events don't.
 *
 * TORN LINES ARE NORMAL. The file is append-mostly and a read can land
 * mid-append, so the trailing fragment is held back and re-joined with the next
 * chunk rather than treated as corruption.
 *
 * Cairn-2001
 */

import fs from 'node:fs';
import path from 'node:path';
import { normalizeEntry, readUsage } from './normalizer.mjs';

const POLL_MS = 250;

export class TranscriptTailer {
  /**
   * @param {object} opts
   * @param {string} opts.transcriptPath  main session .jsonl
   * @param {object} opts.ctx             normalizer context (instance, room, speaker)
   * @param {(events: object[]) => void} opts.onEvents
   * @param {(msg: string) => void} [opts.log]
   */
  constructor({ transcriptPath, ctx, onEvents, onUsage = () => {}, log = () => {} }) {
    this.onUsage = onUsage;
    this.transcriptPath = transcriptPath;
    this.ctx = ctx;
    this.onEvents = onEvents;
    this.log = log;

    // sidecar dir: same path minus ".jsonl"
    this.sidecarDir = transcriptPath.replace(/\.jsonl$/, '');
    this.subagentDir = path.join(this.sidecarDir, 'subagents');

    /** @type {Map<string, {offset:number, partial:string, ctx:object}>} */
    this.files = new Map();
    this.timer = null;
  }

  /**
   * @param {boolean} fromStart  false = only new activity (default for live use)
   */
  start({ fromStart = false } = {}) {
    this._track(this.transcriptPath, this.ctx, fromStart);
    this._scanSubagents(fromStart);
    this.timer = setInterval(() => this._tick(), POLL_MS);
    this.log(`tailing ${this.transcriptPath} (fromStart=${fromStart})`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  _track(file, ctx, fromStart) {
    if (this.files.has(file)) return;
    let offset = 0;
    if (!fromStart) {
      try { offset = fs.statSync(file).size; } catch { offset = 0; }
    }
    this.files.set(file, { offset, partial: '', ctx });
  }

  /** New subagents appear mid-session; discover them as they show up. */
  _scanSubagents(fromStart = false) {
    let entries;
    try { entries = fs.readdirSync(this.subagentDir); } catch { return; }

    for (const name of entries) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(this.subagentDir, name);
      if (this.files.has(file)) continue;

      const agentId = name.replace(/^agent-/, '').replace(/\.jsonl$/, '');
      let label = 'subagent';
      try {
        const meta = JSON.parse(fs.readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
        // description is a human-written summary of the task — ideal UI label
        label = meta.description || meta.agentType || label;
      } catch { /* meta may not exist yet; the transcript can appear first */ }

      this._track(file, { ...this.ctx, agentId, agentLabel: label }, fromStart);
      this.log(`subagent joined: ${label} (${agentId.slice(0, 8)})`);
      this.onEvents([{
        ts: new Date().toISOString(),
        room_id: this.ctx.roomId,
        type: 'subagent_start',
        from: { id: agentId, kind: 'subagent', display: label, agent_id: agentId },
        agent_id: agentId,
        body: { label },
      }]);
    }
  }

  _tick() {
    this._scanSubagents(false);
    for (const [file, state] of this.files) {
      try { this._drain(file, state); }
      catch (err) { this.log(`tail error ${path.basename(file)}: ${err.message}`); }
    }
  }

  _drain(file, state) {
    let size;
    try { size = fs.statSync(file).size; } catch { return; }

    // Truncated/replaced underneath us (e.g. a fresh session at the same path).
    if (size < state.offset) {
      this.log(`${path.basename(file)} shrank — resetting offset`);
      state.offset = 0;
      state.partial = '';
    }
    if (size === state.offset) return;

    const fd = fs.openSync(file, 'r');
    const len = size - state.offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, state.offset);
    fs.closeSync(fd);
    state.offset = size;

    const chunk = state.partial + buf.toString('utf8');
    const lines = chunk.split('\n');
    // Last element is either '' (clean boundary) or a torn line — hold it back.
    state.partial = lines.pop() ?? '';

    const out = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); }
      catch { continue; } // unparseable: skip, never fatal (Law 4.2)
      try { out.push(...normalizeEntry(entry, state.ctx)); }
      catch (err) { this.log(`normalize error: ${err.message}`); }
      // Context accounting rides along in the transcript — no statusline
      // script needed, and it is what the API actually received.
      if (!state.ctx.agentId) {
        const u = readUsage(entry);
        if (u) { try { this.onUsage(u); } catch { /* never break the tail */ } }
      }
    }
    if (out.length) this.onEvents(out);
  }
}
