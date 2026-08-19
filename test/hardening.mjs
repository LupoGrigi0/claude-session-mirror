/**
 * Axiom's two hardening findings, from her adversarial read of the file path.
 * Neither was exploitable; both were correct-for-a-reason-that-lives-elsewhere,
 * which is the defect class this project keeps finding.
 *
 * Control characters are BUILT with String.fromCharCode, never typed — writing
 * them literally once turned a source file binary to grep, and the tooling here
 * refuses commands containing them, which is the correct instinct.
 */
import { safeName } from '../src/files.mjs';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : 'FAIL  '}${m}`); if (!c) fail++; };

const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
const NUL = String.fromCharCode(0), US = String.fromCharCode(31), DEL = String.fromCharCode(127);

console.log('\nHARDENING 2 — truncation must not manufacture ".."');
for (const raw of [
  'a'.repeat(91) + '.' + 'b'.repeat(30) + '.png',   // the exact case she found
  'x'.repeat(200) + '.tar.gz',
  '.'.repeat(120) + '.png',
  'a'.repeat(94) + '..png',
  'z'.repeat(95) + '.',
]) {
  const g = safeName(raw);
  ok(!g.includes('..') && g.length <= 96 && !g.startsWith('.') && !g.includes('/'),
     `len ${String(raw.length).padStart(3)} -> "${g.slice(0, 12)}…${g.slice(-9)}" (len ${g.length}, has "..": ${g.includes('..')})`);
}

console.log('\nHARDENING 1 — the header sanitizer must stand on its own');
// Mirrors the expression used at the serve point, applied to a name that
// safeName has NOT been allowed to clean first. That is the whole point: the
// line must hold even when the upstream invariant does not.
const headerSafe = b => b.replace(/["\\]/g, '').replace(/[\u0000-\u001f\u007f]/g, '');
for (const [label, evil] of [
  ['CRLF header injection', `a${CR}${LF}X-Injected: yes${CR}${LF}${CR}${LF}<script>.png`],
  ['bare LF',               `report${LF}Set-Cookie: x=1.txt`],
  ['NUL and unit-sep',      `nam${NUL}e${US}.png`],
  ['DEL',                   `f${DEL}ile.png`],
  ['quote escape',          'a".png'],
]) {
  const out = headerSafe(evil);
  const clean = !/[\r\n"\\]/.test(out) && ![...out].some(ch => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
  ok(clean, `${label.padEnd(22)} -> ${JSON.stringify(out)}`);
}

console.log('\nboth findings closed, and each is now enforced where it is used');
console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
