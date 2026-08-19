/**
 * Axiom's adversarial read of src/identity.mjs — four findings, pinned.
 *
 * She read it as an attacker trying to become trusted-Lupo, with the SSL /
 * client-auth transition in mind. A and B are the traps that bite specifically
 * when the module goes load-bearing; C is an injection into the identity
 * primitive itself; D is fail-closed hygiene.
 *
 * Control characters are BUILT, never typed — see test/hardening.mjs.
 */
import {
  fromTailscaleHeaders, fromSessionToken, stubIdentity, resolveIdentity,
  senderAddress, mayWrite, identityStartupRefusal, isPrivateBind,
} from '../src/identity.mjs';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : 'FAIL  '}${m}`); if (!c) fail++; };
const withEnv = (env, fn) => {
  const saved = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(saved)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

const CR = String.fromCharCode(13), LF = String.fromCharCode(10), NUL = String.fromCharCode(0);

console.log('\nA — "behind serve" must be ENFORCED, not claimed');
ok(identityStartupRefusal('100.86.133.26') === null,
   'tailnet bind, flag off -> starts (unchanged behaviour)');
withEnv({ MIRROR_BEHIND_TS_SERVE: '1' }, () => {
  const r = identityStartupRefusal('100.86.133.26');
  ok(Boolean(r) && /THROUGH serve/.test(r), 'flag ON + tailnet bind -> REFUSES to start');
  ok(identityStartupRefusal('127.0.0.1') === null, 'flag ON + loopback -> starts (the honest shape)');
});
withEnv({ MIRROR_REQUIRE_AUTH: undefined }, () => {
  const r = identityStartupRefusal('0.0.0.0');
  ok(Boolean(r) && /not a private interface/.test(r), 'public bind + stub -> REFUSES to start');
});
withEnv({ MIRROR_REQUIRE_AUTH: '1' }, () => {
  ok(identityStartupRefusal('0.0.0.0') === null, 'public bind + REQUIRE_AUTH -> allowed');
});
ok(isPrivateBind('100.86.133.26') && isPrivateBind('127.0.0.1') && isPrivateBind('10.1.2.3')
   && !isPrivateBind('8.8.8.8') && !isPrivateBind('0.0.0.0'),
   'isPrivateBind classifies tailnet/loopback/RFC1918 vs public');

console.log('\nB — authorisation, not mere presence');
const stub = stubIdentity();
ok(stub !== null && stub.trusted === false, 'stub exists and is honestly untrusted');
ok(mayWrite(stub) === true, 'stub MAY write today — Lupo keeps working (regression guard)');
ok(mayWrite(null) === false, 'null may not write');
ok(mayWrite({ trusted: true, source: 'tailscale-serve' }) === true, 'a trusted participant may write');
ok(mayWrite({ trusted: false, source: 'something-else' }) === false,
   'an UNTRUSTED non-stub participant may NOT write (the post-transition case)');
withEnv({ MIRROR_REQUIRE_AUTH: '1' }, () => {
  ok(stubIdentity() === null, 'REQUIRE_AUTH removes the stub entirely');
  ok(mayWrite({ trusted: false, source: 'STUB' }) === false,
     'and a stub-shaped object still may not write');
});

console.log('\nC — the identity STRING must not be forgeable through a display name');
withEnv({ MIRROR_BEHIND_TS_SERVE: '1' }, () => {
  const p = fromTailscaleHeaders({
    'tailscale-user-login': 'evil@web',
    'tailscale-user-name': `bad${CR}${LF}X: y@web`,
  });
  const addr = senderAddress(p);
  ok(!/[\r\n]/.test(addr), `no newline in address: ${JSON.stringify(addr)}`);
  ok(addr.split('@').length === 2, `exactly one '@' separator: ${JSON.stringify(addr)}`);
});
// NOTE: no NUL here. process.env values are C strings, so a NUL TRUNCATES the
// variable before any of this code runs — an earlier version of this test
// "passed" by exercising the OS rather than the sanitizer. Use characters that
// actually survive into the process.
withEnv({ MIRROR_STUB_IDENTITY: `lupo|Lu${LF}po@web evil` }, () => {
  const p = stubIdentity();
  const addr = senderAddress(p);
  ok(addr.split('@').length === 2 && !/[\r\n\s]/.test(addr),
     `hostile stub display neutralised: display=${JSON.stringify(p.display)} addr=${JSON.stringify(addr)}`);
  ok(p.display !== 'Lu\npo@web evil', 'the raw display did NOT survive verbatim');
});
ok(senderAddress({ display: 'Lupo', channel: 'web' }) === 'Lupo@web',
   'an ordinary name is untouched');

console.log('\nD — a malformed cookie fails CLOSED rather than throwing');
let threw = false, got;
try { got = fromSessionToken({ cookie: 'mirror_session=%E0%A4%A' }, () => ({ id: 'x' })); }
catch { threw = true; }
ok(!threw, 'a bad % sequence does not throw');
ok(got === null, 'and resolves to null (denied), not to an identity');
ok(resolveIdentity({ headers: { cookie: 'mirror_session=%ZZ' } }) !== undefined,
   'resolveIdentity survives it end to end');

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
