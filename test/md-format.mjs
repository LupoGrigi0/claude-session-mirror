/**
 * What would have to be true for the web UI's md() renderer to be safe:
 *  1. HTML in user text is escaped BEFORE any markup is produced.
 *  2. Code fences and inline code are immune to every inline rule.
 *  3. Each inline rule fires on its own syntax and on nothing else.
 *  4. Adjacent spans do not merge into one (the greedy-regex bug).
 *  5. An unclosed marker renders as literal text, never as dangling markup.
 * Each is checked against the REAL function, extracted from web/index.html.
 *
 * WHY THIS SUITE EXISTS, 2026-10-06: md() had NO test at all. It is the function
 * that renders every word Lupo and I say to each other, and it was the one
 * untested surface in a repo with eleven suites. Found while adding ~~strike~~.
 *
 * WHY IT EXTRACTS RATHER THAN IMPORTS: md() lives inline in web/index.html —
 * no CDN, no dependency, no CSP fight (deliberate, see the comment on it there).
 * So this suite brace-matches it out of the page. THAT MAKES THE EXTRACTION A
 * PLACE THIS TEST CAN GO BLIND, so extraction failure is a LOUD FAILURE below
 * and never an empty pass. A suite that cannot find its subject must not report
 * success — that is this project's most expensive bug class.
 */
import fs from 'node:fs';

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : 'FAIL  '}${m}`); if (!c) fail++; };

const page = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const start = page.indexOf('function md(s){');
if (start < 0) {
  console.log('FAIL  could not find md() in web/index.html — EXTRACTION FAILED, not "no bugs"');
  console.log('\n1 FAILED\n');
  process.exit(1);
}
let depth = 0, end = -1;
for (let i = page.indexOf('{', start); i < page.length; i++) {
  if (page[i] === '{') depth++;
  else if (page[i] === '}' && --depth === 0) { end = i; break; }
}
if (end < 0) {
  console.log('FAIL  md() braces never closed — EXTRACTION FAILED, not "no bugs"');
  console.log('\n1 FAILED\n');
  process.exit(1);
}
const md = new Function(`${page.slice(start, end + 1)}; return md;`)();
ok(typeof md === 'function', 'md() extracted from web/index.html (the real renderer, not a copy)');

// 1. escaping comes first
ok(md('<script>x</script>').includes('&lt;script&gt;'), 'raw HTML is escaped');
ok(!md('<img onerror=1>').includes('<img'), 'no attacker-supplied tag survives');
ok(md('~~<b>~~').trim() === '<del>&lt;b&gt;</del>', 'escaping happens before markup, not after');

// 2. code is immune
ok(md('`~~x~~`').includes('~~x~~'), 'inline code is immune to strike');
ok(md('```\n~~x~~\n```').includes('~~x~~'), 'fenced code is immune to strike');
ok(md('`**x**`').includes('**x**'), 'inline code is immune to bold');

// 3. each rule on its own syntax
ok(md('**b**').trim() === '<strong>b</strong>', '**bold**');
ok(md('__b__').trim() === '<strong>b</strong>', '__bold__');
ok(md('_i_').trim() === '<em>i</em>', '_italic_');
ok(md('~~s~~').trim() === '<del>s</del>', '~~strike~~ renders as <del>');
ok(md('it was ~~right~~ wrong').trim() === 'it was <del>right</del> wrong', 'strike mid-sentence');
ok(md('~~**x**~~').trim() === '<del><strong>x</strong></del>', 'strike composes with bold');

// 4. adjacent spans must not merge — the greedy-regex bug
ok(md('~~a~~ and ~~b~~').trim() === '<del>a</del> and <del>b</del>', 'two strikes do NOT merge into one');
ok(md('**a** and **b**').trim() === '<strong>a</strong> and <strong>b</strong>', 'two bolds do NOT merge');

// 5. unclosed / lone markers stay literal
ok(md('~x~').trim() === '~x~', 'a single tilde is not strike');
ok(md('~~x').trim() === '~~x', 'unclosed strike stays literal');
ok(!md('~~a\nb~~').includes('<del>'), 'no <del> is formed across a newline');
// (md() renders \n as <br>, which is correct — so assert the ABSENCE of <del>,
//  not the exact string. The first version of this assertion was wrong and would
//  have recruited me into "fixing" working newline handling. Pilot's Guide §2.)

console.log(fail ? `\n${fail} FAILED\n` : '\nall passed\n');
process.exit(fail ? 1 : 0);
