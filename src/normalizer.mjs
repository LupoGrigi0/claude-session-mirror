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
  // Anchored to the start of a line AND required to mention the reply tool.
  // The old unanchored form truncated any message that merely contained the
  // phrase "[To answer".
  text = text.replace(/\n*^\[To answer [^\]]*reply[\s\S]*$/m, '');

  return { text: text.trim(), from };
}

/**
 * Claude Code injects agent completions and system reminders as `user`-role
 * entries. They are NOT the human speaking — rendering them in Lupo's bubble
 * makes him appear to narrate XML about his own subagents. Same class of error
 * as attributing tool results to him: a structural field mistaken for a speaker.
 *
 * @returns {{kind:'agent'|'system', title:string, text:string}|null}
 */
export function detectSystemInjection(raw) {
  const t = String(raw ?? '');
  if (/^\s*<task-notification>/.test(t)) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(t)?.[1]?.trim();
    const result  = /<result>([\s\S]*?)<\/result>/.exec(t)?.[1]?.trim();
    const status  = /<status>([\s\S]*?)<\/status>/.exec(t)?.[1]?.trim();
    return {
      kind: 'agent',
      title: summary || `agent ${status || 'finished'}`,
      text: result || t,
    };
  }
  if (/^\s*<system-reminder>/.test(t)) {
    return { kind: 'system', title: 'system reminder',
             text: t.replace(/<\/?system-reminder>/g, '').trim() };
  }
  return null;
}

/**
 * A slash command, which Claude Code records as TWO separate `user` entries:
 * the invocation, then its output.
 *
 *   <command-name>/plan</command-name><command-message>…</command-message>
 *   <command-args></command-args>
 *   <local-command-stdout>Enabled plan mode</local-command-stdout>
 *
 * Both carry role `user`, so without this the mirror shows Lupo apparently
 * typing raw XML at himself. That is the FOURTH distinct thing Claude Code
 * routes through the user role — after tool results, agent completions and
 * system reminders. The role is a transport, and every new inbound kind has to
 * be checked rather than assumed.
 *
 * @returns {{kind:'invocation', name:string, args:string}|{kind:'output', text:string}|null}
 */
/**
 * The answer to an AskUserQuestion, which arrives as an ordinary tool_result:
 *   Your questions have been answered: "<question>"="<chosen label>" selected preview: …
 * Recognising it lets the UI say what was CHOSEN instead of printing the
 * machine sentence back at the person who chose it.
 */
export function detectQuestionAnswer(raw) {
  const t = String(raw ?? '');

  // TWO known prefixes, and a fallback for the next one.
  //
  //   2026-08-12  Your questions have been answered: "Q"="A" selected preview: …
  //   2026-08-21  The user answered: "Q"=(no option selected) notes: …
  //
  // I wrote this against the FIRST sample — the only one that existed — and it
  // silently stopped matching when the wording changed, so Lupo's answers
  // rendered as an anonymous "result" card and his NOTES, which carried all of
  // the actual reasoning, were never surfaced at all.
  //
  // normalizer.mjs's own header says this format is internal and unstable and
  // that parsers break on any release. I documented the risk and then wrote a
  // parser that took it anyway. So: match what we know, and when we do not
  // recognise the shape, say so VISIBLY rather than falling through to silence.
  const KNOWN = /^\s*(?:Your questions have been answered:|The user answered:)/;
  if (!KNOWN.test(t)) {
    // Unrecognised, but clearly an answer — surface it rather than hide it.
    if (/^\s*The user (?:answered|responded|selected)/.test(t)) {
      return { picks: [], raw: t.trim(), unrecognised: true };
    }
    return null;
  }

  // "question"="answer", where the answer may be (no option selected).
  const picks = [...t.matchAll(/"([^"]+)"=(?:"([^"]*)"|\(([^)]*)\))/g)].map(m => ({
    question: m[1],
    answer: m[2] !== undefined ? m[2] : `(${m[3]})`,
  }));

  // notes: — new in the 2026-08-21 format, and the field that carries the
  // substance when someone types rather than picks. Runs to the next
  // "question"= pair or the end.
  const notes = [...t.matchAll(/notes:\s*([\s\S]*?)(?=(?:,\s*"[^"]+"=)|$)/g)]
    .map(m => m[1].trim()).filter(Boolean);
  for (let i = 0; i < picks.length && i < notes.length; i++) picks[i].notes = notes[i];

  return picks.length ? { picks } : { picks: [], raw: t.trim(), unrecognised: true };
}

export function detectSlashCommand(raw) {
  const t = String(raw ?? '');
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(t)?.[1]?.trim();
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() || '';
    return { kind: 'invocation', name: name.replace(/^\/+/, ''), args };
  }
  const out = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(t);
  if (out) return { kind: 'output', text: out[1].trim() };
  return null;
}

/** One shape for both halves of a slash command, so the UI can pair them. */
function commandEvent(base, from, cmd, index) {
  return {
    ...base, ...(index === undefined ? {} : { index }),
    type: 'command',
    from: { id: 'chassis', kind: 'system', display: 'command' },
    body: cmd.kind === 'invocation'
      ? { name: cmd.name, args: cmd.args, invocation: true, by: from.display }
      : { output: cmd.text },
  };
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
      const cmd = detectSlashCommand(content);
      if (cmd) { events.push(commandEvent(base, from, cmd)); return events; }
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
        const cmd = detectSlashCommand(block.text);
        if (cmd) { events.push(commandEvent(base, from, cmd, index)); return; }
        const un = unwrapChannelEnvelope(block.text);
        const sys = detectSystemInjection(un.text || block.text);
        if (sys) {
          events.push({ ...base, index, type: 'agent_result',
            from: { id: sys.kind, kind: 'system', display: sys.title },
            body: { text: sys.text, title: sys.title } });
          return;
        }
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
    } else if (bt === 'tool_use' && block.name === 'AskUserQuestion') {
      // A QUESTION, not a tool call.
      //
      // AskUserQuestion is an ordinary tool, so unlike a permission prompt it is
      // written to the transcript in full — question, header, and every option
      // with its description. The mirror can therefore SEE questions by tailing;
      // no side channel is involved. Rendering it as a generic tool chip shows
      // the human a JSON blob of the decision they are being asked to make,
      // which is the display half of the bug slopus/happy#635 hit in its
      // response path.
      //
      // Emitted structured so the UI renders the OFFERED options — never a fixed
      // set of buttons. Anthropic omits options in some cases, so the option
      // list is data, not layout.
      const qs = Array.isArray(block.input?.questions) ? block.input.questions : [];
      events.push({ ...base, from, index, type: 'question',
        body: { tool_use_id: block.id || null,
                questions: qs.map(q => ({
                  question: String(q?.question || ''),
                  header: String(q?.header || ''),
                  multiSelect: Boolean(q?.multiSelect),
                  options: (Array.isArray(q?.options) ? q.options : []).map(o => ({
                    label: String(o?.label || ''),
                    description: String(o?.description || ''),
                    preview: typeof o?.preview === 'string' ? o.preview : null,
                  })),
                })) } });
    } else if (bt === 'tool_use') {
      events.push({
        ...base, from, index, type: 'tool_use',
        body: { tool: block.name, tool_use_id: block.id, input: block.input ?? {} },
      });
    } else if (bt === 'tool_result' && detectQuestionAnswer(
                 typeof block.content === 'string' ? block.content
                   : Array.isArray(block.content)
                     ? block.content.map(x => (x && x.type === 'text') ? x.text : '').join('')
                     : '')) {
      const raw = typeof block.content === 'string' ? block.content
                : block.content.map(x => (x && x.type === 'text') ? x.text : '').join('');
      events.push({ ...base, index, type: 'question',
        from: { id: ctx.speaker?.id || 'user', kind: ctx.speaker?.kind || 'human',
                display: ctx.speaker?.display || 'User' },
        body: (() => { const a = detectQuestionAnswer(raw);
                       return { tool_use_id: block.tool_use_id || null,
                                answered: a.picks,
                                unrecognised: Boolean(a.unrecognised),
                                raw: a.raw || null }; })() });
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
