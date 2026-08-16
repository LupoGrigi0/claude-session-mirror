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
    id: login,
    kind: 'human',
    display: name,
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
  const token = bearer?.[1] || (cookie ? decodeURIComponent(cookie[1]) : null);
  if (!token || typeof lookup !== 'function') return null;

  const session = lookup(token);          // ← real session store plugs in here
  if (!session) return null;
  return {
    id: session.id,
    kind: 'human',
    display: session.display || session.id,
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
    id: id || 'user',
    kind: 'human',
    display: display || id || 'User',
    channel: 'web',
    source: 'STUB',        // surfaced in /health and logged — never silent
    trusted: false,        // downstream may refuse untrusted identities
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
 * Wire-format sender name. Law 5.4: `name@channel`, stable for a conversation.
 * Identity rides WITH the message — it is never ambient and never inferred
 * from styling. This is the fix for what confused Genevieve.
 */
export function senderAddress(participant) {
  return `${participant.display}@${participant.channel}`;
}
