/**
 * What would have to be true for the UI to be safe to trust about WHO SPOKE:
 *  1. Only positive evidence attributes a message to the human.
 *  2. A harness-injected `user` entry NEVER renders as the human.
 *  3. A channel message is attributed to its real sender, not the human.
 *  4. An agent completion is attributed to the agent, not the human.
 *  5. Legacy entries (no provenance fields) keep working — a deliberate,
 *     documented compromise, asserted so it cannot drift silently.
 *
 * WHY THIS SUITE EXISTS. Bastion-3012, 2026-10-05: a harness string ("The
 * previous response failed to produce a valid tool call. Please retry the tool
 * call now.") rendered in this UI attributed to Lupo and timestamped as his.
 * A misattributed tool RESULT is cosmetic; a misattributed IMPERATIVE is a
 * trust-boundary bug — the permission model rests on a mind being able to tell
 * the human's instructions from machine text, and the recipient cannot test for
 * it from the inside. So it is fixed here or not at all.
 *
 * THE LIVE SPECIMEN is case 2 below: this mirror's own heartbeat cron, which
 * arrives as bare `user` text with promptSource 'system' and no wrapper. Four of
 * them rendered as Lupo before this was found. It is kept as a real entry shape,
 * copied from the transcript, not as an invented one.
 */
import { attributeUserEntry } from '../src/normalizer.mjs';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : 'FAIL  '}${m}`); if (!c) fail++; };
const ctx = { speaker: { id: 'lupo', kind: 'human', display: 'Lupo' } };

// 1. positive evidence -> the human
ok(attributeUserEntry({ origin: { kind: 'human' }, promptSource: 'typed' }, ctx).kind === 'human',
   "origin.kind 'human' + typed  -> the human");
ok(attributeUserEntry({ origin: { kind: 'human' }, promptSource: 'queued' }, ctx).display === 'Lupo',
   "a QUEUED human message is still the human");

// 2. THE LIVE SPECIMEN — real entry shape, from the transcript
const heartbeat = { origin: undefined, promptSource: 'system', isMeta: true,
                    userType: 'external', timestamp: '2026-10-06T02:47:34.797Z' };
ok(attributeUserEntry(heartbeat, ctx).kind !== 'human',
   'the heartbeat cron is NOT the human (the live specimen)');
ok(attributeUserEntry(heartbeat, ctx).display === 'harness',
   'the heartbeat cron is labelled harness');

// 2b. the general case Bastion found: bare text, system-sourced
ok(attributeUserEntry({ promptSource: 'system' }, ctx).kind === 'system',
   'any bare promptSource=system entry is system, never human');

// 3. channel messages name their real sender
const chan = { origin: { kind: 'channel', server: 'hacs-channel' }, promptSource: 'system' };
ok(attributeUserEntry(chan, ctx).kind === 'channel', 'a channel entry is kind channel');
ok(attributeUserEntry(chan, ctx).display === 'hacs-channel', 'a channel entry names its server');
ok(attributeUserEntry(chan, ctx).kind !== 'human', 'a channel entry is NEVER the human');

// 4. agent completions
const taskn = { origin: { kind: 'task-notification' }, promptSource: 'system' };
ok(attributeUserEntry(taskn, ctx).display === 'agent', 'a task-notification is the agent');
ok(attributeUserEntry(taskn, ctx).kind !== 'human', 'a task-notification is NEVER the human');

// 4b. an origin.kind we have never seen must still not become the human
ok(attributeUserEntry({ origin: { kind: 'something-new-in-2.2' } }, ctx).kind === 'system',
   'an UNKNOWN origin.kind is system, not human (the next one is not in our patterns)');

// 5. legacy — documented compromise, asserted so it cannot drift silently
ok(attributeUserEntry({}, ctx).kind === 'human',
   'LEGACY: no provenance fields at all -> the human (deliberate; see normalizer.mjs)');
ok(attributeUserEntry({ promptSource: null, origin: null }, ctx).display === 'Lupo',
   'LEGACY: explicit nulls behave as absent');

// 6. ctx fallbacks must not silently invent a different human
ok(attributeUserEntry({ origin: { kind: 'human' } }, {}).display === 'User',
   'with no ctx speaker the human falls back to "User", not to empty');

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
