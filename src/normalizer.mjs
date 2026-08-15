/**
 * The ONLY module that knows Claude Code's transcript format.
 *
 * Anthropic documents the session JSONL as internal and explicitly warns that
 * parsers can break on any release. So every assumption about it is quarantined
 * here, behind two rules:
 *
 *   1. Unknown entry kinds are SKIPPED, never fatal. In a real 890-line
 *      transcript, 10 of the 14 entry types were not conversation at all
 *      (mode, ai-title, queue-operation, pr-link, file-history-delta, ...).
 *      Noise is the main code path, not the exception.
 *   2. A schema canary runs at startup and raises a loud, NON-FATAL alarm when
 *      the shape drifts. We want to hear about it before users do — without
 *      taking the mirror down over a field rename.
 *
 * Observed empirically against Claude Code 2.1.222 on 2026-08-12.
 * Re-verify after every Claude Code upgrade.
 *
 * Cairn-2001
 */

/** Entry types seen in the wild. Anything not here is skipped silently. */
export const KNOWN_ENTRY_TYPES = new Set([
  'user', 'assistant', 'system',
  // Present and deliberately ignored — not conversation:
  'mode', 'permission-mode', 'file-history-snapshot', 'attachment',
  'last-prompt', 'ai-title', 'custom-title', 'agent-name',
  'queue-operation', 'file-history-delta', 'pr-link', 'summary',
]);

/** Entry types we actually turn into mirror events. */
const CONVERSATIONAL = new Set(['user', 'assistant']);

/** Content block types we render. */
export const KNOWN_BLOCK_TYPES = new Set(['text', 'thinking', 'tool_use', 'tool_result']);

/**
 * Normalize one transcript entry into zero or more mirror events.
 *
 * @param {object} entry  a parsed transcript JSONL line
 * @param {object} ctx    { instance, roomId, speaker, agentId, agentLabel }
 * @returns {object[]} mirror events (without seq/epoch — the log stamps those)
 */

/**
 * Unwrap a hacs-channel envelope.
 *
 * Messages injected through the channel arrive wrapped:
 *
 *   [channel message from Lupo@web]
 *   <the actual message>
 *   [To answer Lupo@web, call the hacs-channel "reply" tool ...]
 *
 * That trailer is guidance for ASYNC senders and it is wrong for a browser
 * conversation — the human is watching this very stream, so ordinary output IS
 * the delivery. It also leaks into the sender's own bubble, which is just
 * noise they have to read past.
 *
 * Stripping it here is a display fix, not a protocol fix. The real repair is a
 * `modality` field on /direct-message so sync senders never get async framing;
 * that lives in the channel server and needs Crossing.
 *
 * Bonus: the envelope names the true sender, which beats any guess.
 *
 * @returns {{text: string, from: string|null}}
 */
export function unwrapChannelEnvelope(raw) {
  let text = String(raw ?? '');
  let from = null;

  // Layer 1 — the <channel …> XML wrapper the transcript actually stores.
  // Its from= attribute is the most reliable sender we get, so prefer it.
  const xml = /^\s*<channel\s+([^>]*)>\s*\n?/.exec(text);
  if (xml) {
    const attr = /\bfrom="([^"]*)"/.exec(xml[1]);
    if (attr) from = attr[1];
    text = text.slice(xml[0].length).replace(/\n*<\/channel>\s*$/, '');
  }

  // Layer 2 — the human-readable "[channel message from X]" header.
  const hdr = /^\s*\[channel message from ([^\]]+)\]\s*\n?/.exec(text);
  if (hdr) {
    from = from || hdr[1].trim();
    text = text.slice(hdr[0].length);
  }

  // Layer 3 — the async reply guidance. Wrong for a browser conversation (the
  // human is watching this very stream) and pure noise in their own bubble.
  text = text.replace(/\n*\[To answer [\s\S]*$/, '');

  return { text: text.trim(), from };
}

export function normalizeEntry(entry, ctx = {}) {
  const type = entry?.type;
  if (!CONVERSATIONAL.has(type)) return [];

  const msg = entry.message;
  if (!msg) return [];

  const base = {
    ts: entry.timestamp || new Date().toISOString(),
    room_id: ctx.roomId || 'default',
    prompt_id: entry.promptId || entry.prompt_id || null,
    message_id: msg.id || entry.uuid || null,
    source_uuid: entry.uuid || null,
    parent_uuid: entry.parentUuid ?? null,
    is_sidechain: Boolean(entry.isSidechain),
    agent_id: ctx.agentId || null,
  };

  const from = ctx.agentId
    ? { id: ctx.agentId, kind: 'subagent', display: ctx.agentLabel || 'subagent', agent_id: ctx.agentId }
    : type === 'user'
      ? { id: ctx.speaker?.id || 'user', kind: ctx.speaker?.kind || 'human', display: ctx.speaker?.display || 'User' }
      : { id: ctx.instance, kind: 'instance', display: ctx.instanceDisplay || ctx.instance };

  const content = msg.content;
  const events = [];

  // A bare-string user message (the common shape for typed input).
  if (typeof content === 'string') {
    if (content.trim()) {
      const un = unwrapChannelEnvelope(content);
      const speaker = un.from
        ? { id: un.from, kind: 'human', display: un.from.split('@')[0], channel: un.from.split('@')[1] || 'channel' }
        : from;
      if (un.text) events.push({ ...base, from: speaker, type: 'user_message', body: { text: un.text } });
    }
    return events;
  }

  if (!Array.isArray(content)) return [];

  content.forEach((block, index) => {
    if (!block || typeof block !== 'object') return;
    const bt = block.type;
    if (!KNOWN_BLOCK_TYPES.has(bt)) return; // unknown block: skip, never fatal

    if (bt === 'text') {
      if (!block.text?.trim()) return;
      if (type === 'user') {
        const un = unwrapChannelEnvelope(block.text);
        const speaker = un.from
          ? { id: un.from, kind: 'human', display: un.from.split('@')[0], channel: un.from.split('@')[1] || 'channel' }
          : from;
        if (un.text) events.push({ ...base, from: speaker, index, type: 'user_message', body: { text: un.text } });
      } else {
        events.push({ ...base, from, index, type: 'text', body: { text: block.text } });
      }
    } else if (bt === 'thinking') {
      // MEASURED 2026-08-12, Claude Code 2.1.222: thinking blocks are persisted
      // as STRUCTURE ONLY. `thinking` is always "" and only `signature` (an
      // opaque verification blob) survives. 114/114 empty in a real transcript,
      // and every subagent transcript too.
      //
      // So thinking CONTENT cannot be mirrored from the transcript. What we can
      // honestly report is that the instance thought, and where in the turn.
      // Emit the event — silence is worse than "thinking…" — but never invent
      // text, and mark it redacted so the UI can say so plainly.
      const text = typeof block.thinking === 'string' ? block.thinking : '';
      events.push({
        ...base, from, index, type: 'thinking',
        body: text.trim()
          ? { text }
          : { redacted: true, reason: 'not persisted by Claude Code', has_signature: Boolean(block.signature) },
      });
    } else if (bt === 'tool_use') {
      events.push({
        ...base, from, index, type: 'tool_use',
        body: { tool: block.name, tool_use_id: block.id, input: block.input ?? {} },
      });
    } else if (bt === 'tool_result') {
      // Tool results arrive inside `user`-role entries — that is an API
      // convention (results are fed back as user turns), NOT a speaker. The
      // human did not say this. Attributing it to them is exactly the
      // misattribution that confused Genevieve, so name the tool explicitly.
      events.push({
        ...base, index, type: 'tool_result',
        from: { id: 'tool', kind: 'system', display: 'tool' },
        body: {
          tool_use_id: block.tool_use_id,
          is_error: Boolean(block.is_error),
          output: stringifyResult(block.content),
        },
      });
    }
  });

  return events;
}

/** tool_result content is sometimes a string, sometimes an array of blocks. */
function stringifyResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(b => (typeof b === 'string' ? b : b?.type === 'text' ? b.text : `[${b?.type || 'block'}]`))
      .join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

/**
 * Schema canary — sample real transcript lines and report drift.
 *
 * Deliberately advisory. A renamed field should page us, not take the mirror
 * down; a mirror that degrades loudly beats one that refuses to start.
 *
 * @returns {{ok: boolean, warnings: string[], stats: object}}
 */
export function schemaCanary(sampleLines) {
  const warnings = [];
  const seenTypes = new Set();
  const seenBlocks = new Set();
  let parsed = 0, unparseable = 0, withTimestamp = 0;

  for (const line of sampleLines) {
    if (!line?.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { unparseable++; continue; }
    parsed++;
    if (d.type) seenTypes.add(d.type);
    if (d.timestamp) withTimestamp++;
    const c = d.message?.content;
    if (Array.isArray(c)) {
      for (const b of c) { if (b?.type) seenBlocks.add(b.type); }
    } else if (typeof c === 'string') {
      seenBlocks.add('(bare string)');
    }
  }

  for (const t of seenTypes) {
    if (!KNOWN_ENTRY_TYPES.has(t)) {
      warnings.push(`NEW transcript entry type "${t}" — unrecognized, being skipped. Check whether it carries conversation.`);
    }
  }
  for (const b of seenBlocks) {
    if (b !== '(bare string)' && !KNOWN_BLOCK_TYPES.has(b)) {
      warnings.push(`NEW content block type "${b}" — unrecognized, being skipped.`);
    }
  }
  if (parsed > 0 && !seenTypes.has('assistant')) {
    warnings.push('No "assistant" entries in sample — the shape we depend on may have changed.');
  }
  if (parsed > 0 && withTimestamp / parsed < 0.3) {
    warnings.push(`Only ${withTimestamp}/${parsed} entries carry "timestamp" — ordering may degrade.`);
  }

  return {
    ok: warnings.length === 0,
    warnings,
    stats: { parsed, unparseable, types: [...seenTypes], blocks: [...seenBlocks] },
  };
}

/**
 * Pull context accounting out of an assistant entry.
 *
 * Every assistant turn records what the API actually received, so the context
 * meter comes free from the file we already tail — no statusline script, no
 * extra process, no cost to the session.
 *
 * NOTE: this is the raw API total (fresh input + cache creation + cache reads +
 * output). Claude Code's own /context reports a smaller number because it
 * buckets differently. Label it as API context; do not claim they match.
 */
export function readUsage(entry) {
  if (entry?.type !== 'assistant') return null;
  const m = entry.message || {};
  const u = m.usage;
  if (!u) return null;
  const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0)
              + (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
  if (!total) return null;
  return {
    model: m.model || null,
    total,
    input: u.input_tokens || 0,
    cache_read: u.cache_read_input_tokens || 0,
    cache_write: u.cache_creation_input_tokens || 0,
    output: u.output_tokens || 0,
    at: entry.timestamp || new Date().toISOString(),
  };
}
