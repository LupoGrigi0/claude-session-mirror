/**
 * What would have to be true for files.mjs to be safe:
 *  1. No client-supplied name yields a path outside the box.
 *  2. A symlink inside the box does NOT become servable.
 *  3. SVG/HTML never render inline.
 *  4. A file still being written is never announced.
 *  5. A restart does not re-announce the whole outbox.
 *  6. Two uploads with the same name both survive.
 * Each is checked directly, not by proxy.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, safeName, isInlineImage } from '../src/files.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mirrorfiles-'));
const store = new FileStore(root);
let fail = 0;
const ok  = (c, m) => { console.log(`${c ? '  ok  ' : 'FAIL  '}${m}`); if (!c) fail++; };

console.log('\n1. safeName never escapes the directory');
for (const evil of [
  '../../../../etc/passwd', '..\\..\\windows\\system32\\config\\sam',
  '/etc/shadow', 'C:\\Users\\x\\.ssh\\id_rsa', '....//....//etc/passwd',
  'foo/../../bar.png', '.bashrc', '.....', '-rf', 'a\u0000b.png',
  'x'.repeat(400) + '.png', '', null, undefined, 'nor\nmal.png',
]) {
  const s = safeName(evil);
  const joined = path.join(store.inbox, s);
  const escapes = !path.resolve(joined).startsWith(path.resolve(store.inbox) + path.sep);
  ok(!escapes && !s.includes('/') && !s.includes('\\') && !s.includes('..') && s.length <= 96,
     `${JSON.stringify(String(evil).slice(0, 34))} -> ${JSON.stringify(s)}`);
}

console.log('\n2. symlinks inside the box are not servable');
fs.writeFileSync(path.join(root, 'SECRET.txt'), 'private key material');
fs.symlinkSync(path.join(root, 'SECRET.txt'), path.join(store.outbox, 'innocent.txt'));
ok(store.resolveServable('outbox', 'innocent.txt') === null, 'symlink to a file outside the box -> null');
fs.writeFileSync(path.join(store.outbox, 'real.txt'), 'fine');
ok(store.resolveServable('outbox', 'real.txt') !== null, 'a real file in the box -> served');
ok(store.resolveServable('outbox', '../SECRET.txt') === null, 'traversal in the served name -> null');
ok(store.resolveServable('inbox', 'real.txt') === null, 'right name, wrong box -> null');
ok(store.resolveServable('../..', 'real.txt') === null, 'invented box name -> null');
ok(store.resolveServable('outbox', 'nope.txt') === null, 'missing file -> null');

console.log('\n3. only raster images render inline');
for (const [n, want] of [['a.png', true], ['a.JPG', true], ['a.webp', true],
                         ['a.svg', false], ['a.html', false], ['a.htm', false],
                         ['a.js', false], ['a.pdf', false], ['noext', false]]) {
  ok(isInlineImage(n) === want, `${n} inline=${isInlineImage(n)} (want ${want})`);
}
ok(store.contentType('a.svg') === 'application/octet-stream', 'svg content-type is octet-stream, not image/svg+xml');

console.log('\n4. a file still being written is not announced');
const growing = path.join(store.outbox, 'growing.bin');
fs.writeFileSync(growing, Buffer.alloc(10));
ok(store.scanOutbox().every(f => f.name !== 'growing.bin'), 'first sight of a new file -> not announced');
fs.appendFileSync(growing, Buffer.alloc(10));
ok(store.scanOutbox().every(f => f.name !== 'growing.bin'), 'size changed -> still not announced');
const settled = store.scanOutbox();
ok(settled.some(f => f.name === 'growing.bin' && f.bytes === 20), 'size stable -> announced once, at full size');
ok(store.scanOutbox().every(f => f.name !== 'growing.bin'), 'not announced a second time');

console.log('\n5. restart does not re-announce the outbox');
const fresh = new FileStore(root);
const primed = fresh.primeOutbox();
ok(primed >= 2, `primeOutbox adopted ${primed} existing files`);
ok(fresh.scanOutbox().length === 0, 'after a restart, nothing is re-announced');

console.log('\n6. same-name uploads both survive');
const a = store.saveInbound(Buffer.from('first'), 'Screenshot.png');
const b = store.saveInbound(Buffer.from('second'), 'Screenshot.png');
ok(a.stored !== b.stored, `distinct stored names (${a.stored} / ${b.stored})`);
ok(fs.readFileSync(a.path, 'utf8') === 'first' && fs.readFileSync(b.path, 'utf8') === 'second',
   'neither file was clobbered');
const c = store.saveInbound(Buffer.from('x'), '../../../../etc/cron.d/evil');
ok(path.dirname(c.path) === store.inbox, `hostile upload name landed in inbox as ${path.basename(c.path)}`);

fs.rmSync(root, { recursive: true, force: true });
console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
