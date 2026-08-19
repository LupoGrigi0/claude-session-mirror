/**
 * Identity resolution for inbound requests.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THIS IS THE ONLY FILE THAT DECIDES WHO SOMEONE IS.                      │
 * │  Everything downstream consumes the participant descriptor this returns.  │
 * │  When real authentication is added, it is added HERE and nowhere else.   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The resolver tries three sources in descending order of trust. The first two
 * are REAL and already wired — they simply don't fire in the current
 * deployment. The third is a hardcoded stand-in, and it is loud about it.
 *
 *   1. Tailscale Serve identity headers  — REAL, unforgeable *through Serve*
 *   2. A signed session token            — REAL, for non-tailnet deployments
 *   3. MIRROR_STUB_IDENTITY              — ⚠ DEVELOPMENT STUB ⚠
 *
 * Why the stub exists right now: the server binds directly to the tailnet
 * interface, which gives network-level access control (only listed devices on
 * the tailnet can reach it) but NOT identity headers — those only appear when
 * traffic passes through `tailscale serve`. One person is on this tailnet.
 * Rather than invent a fake auth flow, we name the assumption and mark it.
 *
 * ⚠ SECURITY: the stub trusts the network boundary completely. It is safe ONLY
 * while (a) the listener is bound to a private interface and (b) everyone who
 * can reach that interface is authorised to speak as the stub identity. Adding
 * a second person to the tailnet, or binding anywhere public, INVALIDATES IT.
 *
 * Cairn-2001
 */

/** @typedef {{id:string, kind:'human'|'instance'|'system', display:string,
 *             channel:string, source:string, trusted:boolean}} Participant */

/**
 * RFC 2047 encoded-words show up in these headers for non-ASCII names.
 * Minimal decode — enough for display purposes.
 */
function decodeHeader(v) {
  if (!v) return v;
  return String(v).replace(/=\?[^?]+\?[Bb]\?([^?]+)\?=/g, (_, b64) => {
    try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return _; }
  });
}

/**
 * Constrain a field that will become part of a wire identity.
 *
 * senderAddress() builds `${display}@${channel}`, and that string is what the
 * whole system trusts to say who is speaking. So a display name containing '@',
 * whitespace or a control character can forge structure inside the very
 * primitive this module exists to make trustworthy: a display of `evil@web`
 * yields `evil@web@web`, and a newline splits the address outright.
 *
 * Axiom found this reading the module as an attacker. It is the Genevieve
 * failure aimed at its own fix — and the same shape as the Content-Disposition
 * CRLF note: enforce the guarantee where the value is CONSTRUCTED, not by
 * hoping every upstream source is well-behaved. A session store is a future
 * upstream source, and it is not written yet.
 */
function addressSafe(v, fallback) {
  const s = String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')   // control chars, incl. CR/LF
    .replace(/[@\s]+/g, '_')                 // '@' and whitespace are structure
    .trim()
    .slice(0, 64);
  return s || fallback;
}

/** Loopback, RFC1918, or the tailscale CGNAT range — never the public internet. */
export function isPrivateBind(addr) {
  const a = String(addr || '');
  if (a === '::1' || a === 'localhost' || /^127\./.test(a)) return true;
  if (/^10\./.test(a) || /^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  const cg = /^100\.(\d+)\./.exec(a);          // 100.64.0.0/10 — tailscale
  if (cg && Number(cg[1]) >= 64 && Number(cg[1]) <= 127) return true;
  if (/^fd[0-9a-f]{2}:/i.test(a) || /^fe80:/i.test(a)) return true;
  return false;
}

/**
 * SOURCE 1 — Tailscale Serve.
 *
 * When traffic arrives via `tailscale serve`, tailscaled injects these headers
 * AND strips any client-supplied copies, so they cannot be spoofed through that
 * path. They are absent for tagged devices and when binding the listener
 * directly to the tailnet IP (our current setup).
 *
 * @returns {Participant|null}
 */
export function fromTailscaleHeaders(headers) {
  // These are only unforgeable when traffic passes THROUGH tailscale serve,
  // which strips client-supplied copies. Bound directly to a tailnet IP nothing
  // strips them, so any peer could set them by hand. Opt in explicitly rather
  // than trusting a header because of its name.
  if (process.env.MIRROR_BEHIND_TS_SERVE !== '1') return null;
  const login = decodeHeader(headers['tailscale-user-login']);
  if (!login) return null;
  const name = decodeHeader(headers['tailscale-user-name']) || login.split('@')[0];
  return {
    id: addressSafe(login, 'unknown'),
    kind: 'human',
    display: addressSafe(name, 'unknown'),
    channel: 'web',
    source: 'tailscale-serve',
    trusted: true,
  };
}

/**
 * SOURCE 2 — session token.
 *
 * For deployments that are NOT behind a tailnet (someone running this with
 * their own TLS cert and a login page). The transport is already wired: the
 * browser sends `Authorization: Bearer <token>` or a `mirror_session` cookie,
 * and this looks it up.
 *
 * TODO(auth): implement a real session store — issue on login, verify a
 * signature or look up a server-side session, honour expiry and revocation.
 * Everything on either side of this function is already shaped for it.
 *
 * @returns {Participant|null}
 */
export function fromSessionToken(headers, lookup) {
  const bearer = /^Bearer\s+(.+)$/i.exec(headers['authorization'] || '');
  const cookie = /(?:^|;\s*)mirror_session=([^;]+)/.exec(headers['cookie'] || '');
  // decodeURIComponent THROWS on a malformed % sequence. Unwrapped, a bad
  // mirror_session cookie became an unhandled exception per request. An auth
  // path must fail CLOSED on garbage, never throw — a crash is not a denial.
  let token = bearer?.[1] || null;
  if (!token && cookie) {
    try { token = decodeURIComponent(cookie[1]); } catch { return null; }
  }
  if (!token || typeof lookup !== 'function') return null;

  const session = lookup(token);          // ← real session store plugs in here
  if (!session) return null;
  return {
    // A session store is a FUTURE upstream source and is not written yet, so it
    // gets the same constraint as a header. Trusting a value because it came
    // from code we intend to write is the purest form of the invariant-that-
    // lives-elsewhere.
    id: addressSafe(session.id, 'unknown'),
    kind: 'human',
    display: addressSafe(session.display || session.id, 'unknown'),
    channel: 'web',
    source: 'session-token',
    trusted: true,
  };
}

/**
 * SOURCE 3 — ⚠ DEVELOPMENT STUB ⚠
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THIS IS THE FAKE. It is the entire fake. Delete this function and real
 * authentication is enforced everywhere, because nothing else invents identity.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Configure with MIRROR_STUB_IDENTITY="id|Display Name". Set
 * MIRROR_REQUIRE_AUTH=1 to disable it entirely and fail closed instead.
 *
 * @returns {Participant|null}
 */
export function stubIdentity() {
  if (process.env.MIRROR_REQUIRE_AUTH === '1') return null;   // fail closed
  const raw = process.env.MIRROR_STUB_IDENTITY || 'user|User';
  const [id, display] = raw.split('|');
  return {
    id: addressSafe(id, 'user'),
    kind: 'human',
    display: addressSafe(display || id, 'User'),
    channel: 'web',
    source: 'STUB',        // surfaced in /health and logged — never silent
    trusted: false,        // NOT a suggestion — see mayWrite() below
  };
}

/**
 * Resolve a participant for this request. Real sources first, stub last.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{sessionLookup?: Function}} [opts]
 * @returns {Participant|null} null = unauthenticated; caller MUST fail closed
 */
export function resolveIdentity(req, opts = {}) {
  const h = req.headers || {};
  return fromTailscaleHeaders(h)
      || fromSessionToken(h, opts.sessionLookup)
      || stubIdentity();
}

/**
 * MAY THIS PARTICIPANT ACT? — the single place that answers it.
 *
 * resolveIdentity() almost never returns null: without MIRROR_REQUIRE_AUTH it
 * falls through to the stub, so every caller sees a truthy participant. Five
 * write routes were therefore gating on `if (!who)` — presence, not trust — and
 * NOTHING in the server checked `.trusted` at all. Axiom found that: the
 * docstring promised "null = unauthenticated, caller MUST fail closed", and no
 * caller had ever seen null.
 *
 * Today that is survivable, because the stub IS the intended identity behind a
 * private boundary. It stops being survivable the moment source 1 goes live: a
 * forged header would arrive marked trusted:true, and presence-checking routes
 * would wave it through.
 *
 * So the policy lives here, once, instead of being re-derived by five handlers
 * — the same quarantine as files.mjs. A handler cannot forget a rule it does
 * not implement.
 */
export function mayWrite(participant) {
  if (!participant) return false;
  if (participant.trusted) return true;
  // The stub is acceptable ONLY while the network boundary is the authenticator.
  // MIRROR_REQUIRE_AUTH=1 already removes the stub entirely; this is belt to
  // that suspenders, so the rule is legible at the point of decision.
  return participant.source === 'STUB' && process.env.MIRROR_REQUIRE_AUTH !== '1';
}

/**
 * Refuse to start in a configuration whose safety nobody has stated.
 *
 * Two ways the deployment can quietly disagree with the code:
 *
 *  1. MIRROR_BEHIND_TS_SERVE=1 while bound to a NON-loopback address. The flag
 *     says "identity headers are unforgeable because serve strips them" — but
 *     that is only true of traffic that actually traversed serve. Bound to the
 *     tailnet IP, any peer (or any local process) reaches the listener directly
 *     and can set those headers by hand. `tailscale serve` proxies to loopback
 *     anyway, so loopback IS the honest shape behind serve. Enforced, because
 *     "documented" is precisely the false invariant we keep finding.
 *
 *  2. the stub active while bound somewhere public. The stub grants a name to
 *     anyone who can reach the port; that is only defensible behind a private
 *     interface.
 *
 * @returns {string|null} a reason to refuse, or null to proceed
 */
export function identityStartupRefusal(bind) {
  const priv = isPrivateBind(bind);
  if (process.env.MIRROR_BEHIND_TS_SERVE === '1' && !/^127\.|^::1$|^localhost$/.test(String(bind))) {
    return `MIRROR_BEHIND_TS_SERVE=1 but bound to ${bind}.\n` +
      `  Those headers are only unforgeable for traffic that came THROUGH serve.\n` +
      `  Bound to a non-loopback address, any peer can set them by hand.\n` +
      `  tailscale serve proxies to loopback — bind 127.0.0.1 instead.`;
  }
  if (!priv && process.env.MIRROR_REQUIRE_AUTH !== '1') {
    return `bound to ${bind}, which is not a private interface, with the identity\n` +
      `  stub still enabled. The stub grants a name to anyone who can reach the\n` +
      `  port. Set MIRROR_REQUIRE_AUTH=1, or bind somewhere private.`;
  }
  return null;
}

/**
 * Wire-format sender name. Law 5.4: `name@channel`, stable for a conversation.
 * Identity rides WITH the message — it is never ambient and never inferred
 * from styling. This is the fix for what confused Genevieve.
 */
export function senderAddress(participant) {
  return `${participant.display}@${participant.channel}`;
}
