/**
 * File transfer — the ONLY module that decides what a file is and where it may live.
 *
 * Same quarantine pattern as normalizer.mjs (format) and identity.mjs (who):
 * every decision that could turn "receive a file" into "write anywhere" or
 * "serve anything" is made here, once, where it can be reviewed in one sitting.
 *
 * TWO DIRECTIONS, TWO DIRECTORIES, AND THE DIRECTORY *IS* THE INTENT:
 *
 *   inbox/   things a human sent us. Written by the mirror, read by the instance.
 *   outbox/  things the instance wants the human to have. Written by the
 *            instance, served by the mirror.
 *
 * The instance writes files constantly as ordinary work. Almost none of them are
 * meant for anyone. There is no signal in the transcript for "I want you to have
 * this" — so the outbox supplies one. Putting a file there IS the request to
 * publish it, which makes intent, transport, and security boundary the same
 * decision instead of three.
 *
 * WHAT THIS REFUSES TO TRUST:
 *   - the client's filename      (traversal, absolute paths, control characters)
 *   - the client's content-type  (type is derived from the extension, allowlisted)
 *   - string prefix checks       (symlinks escape those; realpath is the check)
 *   - inline rendering by default (only raster images; SVG can carry script and
 *     would be same-origin with the app, which is stored XSS with extra steps)
 *
 * Cairn-2001
 */

import fs from 'node:fs';
import path from 'node:path';

/** Upload ceiling. A phone screenshot is ~5 MB; 25 covers it with room. */
export const MAX_UPLOAD_BYTES = Number(process.env.MIRROR_MAX_UPLOAD || 25 * 1024 * 1024);

/**
 * Extensions we are willing to render in the page itself.
 *
 * Raster only, deliberately. SVG is an XML document that can carry <script>,
 * and it would be served from the mirror's own origin — the same origin as the
 * app that can POST into a live session. That is the XSS I already shipped
 * once, wearing a different hat. SVG downloads; it never renders.
 */
const INLINE_OK = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp']);

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8', json: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8', yaml: 'text/plain; charset=utf-8',
  yml: 'text/plain; charset=utf-8', pdf: 'application/pdf',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
};

/** Lowercased extension without the dot, or '' when there isn't one. */
export function extOf(name) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function isInlineImage(name) {
  return INLINE_OK.has(extOf(name));
}

/**
 * Reduce ANY client-supplied name to a safe leaf.
 *
 * Not a sanitizer that removes bad things — a constructor that only emits good
 * ones. Everything outside [A-Za-z0-9._-] is replaced, so there is no character
 * sequence a caller can supply that leaves the directory. Note the split on
 * BOTH separators: path.basename() alone leaves 'C:\evil\x.png' intact on POSIX.
 */
export function safeName(raw) {
  let s = String(raw || '').split(/[\\/]/).pop() || '';
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');       // control chars
  s = s.replace(/[^A-Za-z0-9._-]/g, '_');            // everything else
  if (s.length > 96) {                               // keep the extension
    const e = extOf(s);
    s = s.slice(0, e ? 96 - e.length - 1 : 96) + (e ? '.' + e : '');
  }
  // Collapse AFTER the length cap, not before.
  //
  // Axiom found this reading the function as an adversary: truncating a long
  // name can land the cut on a dot, and re-appending the extension then
  // MANUFACTURES a '..' the earlier collapse had already removed.
  // `'a'.repeat(91) + '.' + 'b'.repeat(30) + '.png'` came back as `aaa…aaa..png`.
  //
  // Not traversal — path.join keeps a two-dot FILENAME inside the directory and
  // it never becomes a '..' path SEGMENT. But the comment claimed no '..' could
  // survive, and an invariant a caller might one day trust has to be true rather
  // than nearly true. Reproduced before fixing.
  s = s.replace(/\.{2,}/g, '.');                     // no '..' can survive
  s = s.replace(/^[.\-_]+/, '');                     // no dotfiles, no leading '-'
  return s || 'file';
}

export class FileStore {
  /** @param {string} dataDir  the mirror's data directory */
  constructor(dataDir) {
    this.inbox = path.join(dataDir, 'inbox');
    this.outbox = path.join(dataDir, 'outbox');
    fs.mkdirSync(this.inbox, { recursive: true });
    fs.mkdirSync(this.outbox, { recursive: true });
    /** stored name -> size, for detecting a file that is still being written */
    this._outSeen = new Map();
    this._outAnnounced = new Set();
  }

  dirFor(box) {
    return box === 'outbox' ? this.outbox : box === 'inbox' ? this.inbox : null;
  }

  /**
   * Store an uploaded file. The stored name is timestamp-prefixed so a second
   * 'Screenshot.png' can never overwrite the first — silently losing a file the
   * human believes they sent is worse than an ugly name.
   *
   * @returns {{name:string, stored:string, path:string, bytes:number, inline:boolean}}
   */
  saveInbound(buf, rawName) {
    const name = safeName(rawName);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
    const stored = `${stamp}-${name}`;
    const full = path.join(this.inbox, stored);
    // 'wx' — never clobber. If the same name lands in the same second, fall
    // back to a counter rather than destroying the earlier one.
    let target = full, n = 1;
    while (true) {
      try { fs.writeFileSync(target, buf, { flag: 'wx' }); break; }
      catch (err) {
        if (err.code !== 'EEXIST' || n > 50) throw err;
        target = path.join(this.inbox, `${stamp}-${n++}-${name}`);
      }
    }
    return {
      name, stored: path.basename(target), path: target,
      bytes: buf.length, inline: isInlineImage(name),
    };
  }

  /**
   * Absolute path for a file being served, or null.
   *
   * realpath, not a string prefix: a symlink inside the box would satisfy
   * `startsWith(dir)` while pointing at ~/.ssh. The resolved path must actually
   * be inside the resolved box, and it must be a regular file.
   */
  resolveServable(box, rawName) {
    const dir = this.dirFor(box);
    if (!dir) return null;
    const name = safeName(rawName);
    try {
      const root = fs.realpathSync(dir);
      const full = fs.realpathSync(path.join(dir, name));
      if (full !== root && !full.startsWith(root + path.sep)) return null;
      if (!fs.statSync(full).isFile()) return null;
      return full;
    } catch { return null; }
  }

  /** Content type from the EXTENSION only. Unknown extensions download. */
  contentType(name) {
    return MIME[extOf(name)] || 'application/octet-stream';
  }

  /**
   * New, fully-written files in the outbox.
   *
   * Two-pass stability check: a file is only announced once its size has been
   * unchanged across consecutive scans. Announcing mid-write would publish a
   * truncated file and there would be no second event to correct it.
   */
  scanOutbox() {
    let names = [];
    try { names = fs.readdirSync(this.outbox); } catch { return []; }
    const fresh = [];
    const present = new Set();

    for (const n of names) {
      if (n.startsWith('.')) continue;               // editor temp files
      let st;
      try { st = fs.statSync(path.join(this.outbox, n)); } catch { continue; }
      if (!st.isFile()) continue;
      present.add(n);
      if (this._outAnnounced.has(n)) continue;

      const prev = this._outSeen.get(n);
      if (prev === st.size) {
        this._outAnnounced.add(n);
        fresh.push({
          name: n, bytes: st.size, inline: isInlineImage(n),
          at: new Date(st.mtimeMs).toISOString(),
        });
      } else {
        this._outSeen.set(n, st.size);              // still growing; wait a beat
      }
    }

    // Forget files that were removed, so re-adding the same name re-announces.
    for (const k of [...this._outSeen.keys()]) if (!present.has(k)) this._outSeen.delete(k);
    for (const k of [...this._outAnnounced]) if (!present.has(k)) this._outAnnounced.delete(k);
    return fresh;
  }

  /**
   * Adopt whatever is already in the outbox WITHOUT announcing it.
   *
   * Called once at startup. Otherwise every restart re-announces the entire
   * outbox — which is precisely the bug that duplicated 676 transcript entries,
   * arriving in new clothes. Restart-safety is a thing this codebase pays for
   * up front now.
   */
  primeOutbox() {
    let names = [];
    try { names = fs.readdirSync(this.outbox); } catch { return 0; }
    let n = 0;
    for (const name of names) {
      if (name.startsWith('.')) continue;
      try { if (!fs.statSync(path.join(this.outbox, name)).isFile()) continue; } catch { continue; }
      this._outAnnounced.add(name);
      n++;
    }
    return n;
  }
}
