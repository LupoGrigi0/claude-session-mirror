#!/usr/bin/env node
/**
 * permission-hook -- a Claude Code PermissionRequest hook that HOLDS a permission
 * prompt until a human answers it from the web mirror, however long that takes.
 *
 * WHY
 *   Claude Code's permission model is synchronous: one terminal, one mind, a human
 *   at the keyboard. An independent mind's human may be travelling and not see a
 *   request for days. The channel relay (claude/channel/permission) needed a
 *   session BORN with --dangerously-load-development-channels, which a --bg resume
 *   cannot add without forking the mind, and the flag is on its way out anyway.
 *   PreToolUse permissionDecision="defer" exists but is print-mode only
 *   ("defer is print-mode only" in 2.1.285), so it does not apply to --bg minds.
 *   A PermissionRequest hook is a plain settings.json entry: no birth flag.
 *
 * HOW
 *   Claude Code runs this when it is about to show a permission dialog, with the
 *   request as JSON on stdin. We write a pending card to disk, then wait for a
 *   verdict file. web-bridge serves the cards to the mirror's permission panel
 *   (GET /pending-permissions) and writes the verdict (POST /permission-verdict).
 *
 *     ~/.web-bridge/permissions/pending/<id>.json   written here, read by the bridge
 *     ~/.web-bridge/permissions/verdicts/<id>.json  written by the bridge, read here
 *
 *   State is on disk, not in the bridge's memory, so a bridge restart loses
 *   nothing: the hook keeps waiting and the restarted bridge re-reads the cards.
 *
 * NO VERDICT, NO OPINION
 *   On any error, on SIGTERM/SIGINT (Claude Code cancelling the hook, e.g. its
 *   timeout, or the request being answered at the console), or on reaching
 *   PERM_HOOK_MAX_WAIT_S, we remove our card and exit 0 with NO output. Claude
 *   Code then falls back to its normal dialog. This script never decides on its
 *   own; only a human's verdict produces output.
 *
 * ENV
 *   PERM_HOOK_DIR         default ~/.web-bridge/permissions
 *   PERM_HOOK_MAX_WAIT_S  default 0 = wait forever (bounded only by the hook's
 *                         `timeout` in settings.json -- set that high too)
 *   PERM_HOOK_POLL_MS     default 1000
 *
 * Zero dependencies.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';

const HOME = process.env.HOME || '/tmp';
const DIR = process.env.PERM_HOOK_DIR || join(HOME, '.web-bridge', 'permissions');
const PENDING = join(DIR, 'pending');
const VERDICTS = join(DIR, 'verdicts');
const MAX_WAIT_MS = Number(process.env.PERM_HOOK_MAX_WAIT_S || 0) * 1000;
const POLL_MS = Number(process.env.PERM_HOOK_POLL_MS || 1000);

// Same id format as the channel server (and Telegram/Discord plugins):
// 5 letters a-z minus 'l', so "yes abcde" text verdicts stay possible later.
const ALPHA = 'abcdefghijkmnopqrstuvwxyz';
const newId = () => Array.from({ length: 5 }, () => ALPHA[randomInt(ALPHA.length)]).join('');

let cardPath = null, verdictPath = null;
function cleanup() {
  for (const p of [cardPath, verdictPath]) if (p) { try { rmSync(p, { force: true }); } catch {} }
}
function fallThrough() { cleanup(); process.exit(0); }   // no output: Claude Code shows its dialog
process.on('SIGTERM', fallThrough);
process.on('SIGINT', fallThrough);
process.on('SIGHUP', fallThrough);

/** One line a human can judge from a phone: the command, the path, or the JSON. */
function preview(tool, input) {
  if (!input || typeof input !== 'object') return '';
  const s = input.command ?? input.file_path ?? input.url ?? input.pattern ?? JSON.stringify(input);
  return String(s).slice(0, 2000);
}

function writeAtomic(path, obj) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

async function main() {
  let req;
  try { req = JSON.parse(readFileSync(0, 'utf8')); } catch { return fallThrough(); }

  mkdirSync(PENDING, { recursive: true, mode: 0o700 });
  mkdirSync(VERDICTS, { recursive: true, mode: 0o700 });

  let id;
  do { id = newId(); } while (existsSync(join(PENDING, id + '.json')));
  cardPath = join(PENDING, id + '.json');
  verdictPath = join(VERDICTS, id + '.json');

  const tool = req.tool_name || 'unknown';
  writeAtomic(cardPath, {
    request_id: id,
    tool_name: tool,
    description: req.tool_input?.description || `${tool} wants permission`,
    input_preview: preview(tool, req.tool_input),
    received_at: new Date().toISOString(),
    session_id: req.session_id || null,
    cwd: req.cwd || null,
    pid: process.pid,          // the bridge drops cards whose hook is gone
  });

  const started = Date.now();
  for (;;) {
    if (MAX_WAIT_MS && Date.now() - started > MAX_WAIT_MS) return fallThrough();
    let v = null;
    try { v = JSON.parse(readFileSync(verdictPath, 'utf8')); } catch {}
    if (v && (v.behavior === 'allow' || v.behavior === 'deny')) {
      cleanup();
      const decision = v.behavior === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: v.message || 'Denied from the web mirror.' };
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
      }) + '\n');
      process.exit(0);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(() => fallThrough());
