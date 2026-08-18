# Security

Read this before running it anywhere. The threat model is unusual and the
defaults are deliberately conservative.

## What a mirror publishes

**Everything the session does.** Your prose, every tool call and its full
input, every tool result including command output and file contents, your
subagents' entire working transcripts, and the fact that thinking occurred.

If the session reads a private file, the mirror publishes it. If a command
prints a token, the mirror publishes that too. There is no redaction layer.

Treat the mirror's URL as equivalent to **read access to the machine as that
user**. Do not run one on a session you would not screen-share.

## What it is NOT

Not authenticated by default. Not encrypted by itself. Not multi-tenant. There
is no per-viewer authorization — anyone who reaches the port sees everything.

## Deployment: pick one

**A. Behind a private network (what we run).** Bind to a tailnet/VPN interface.
The public interface then cannot answer at all:

```bash
MIRROR_BIND=$(tailscale ip -4 | head -1) ./bin/mirror-start.sh
```

`bin/mirror-start.sh` refuses `0.0.0.0` and falls back to loopback — never a
wildcard — if the VPN is down.

**B. Behind an authenticating proxy.** Terminate TLS and authenticate there,
keep the mirror on loopback, and pass identity down. With Tailscale Serve you
get both, and `Tailscale-User-Login` cannot be spoofed *through Serve*.

**Never expose it directly to the internet.** There is no configuration that
makes that safe.

## The identity stub — know that it is there

`src/identity.mjs` resolves identity from three sources in descending trust:

1. Tailscale Serve headers — real, unforgeable through Serve
2. A signed session token — real, wired, awaiting a session store
3. **`stubIdentity()` — a hardcoded development stand-in**

The stub trusts the network boundary *completely*. It is safe only while the
listener is on a private interface **and every person who can reach that
interface is authorized to speak as the stub identity.** Adding a second person
to the network invalidates it.

`GET /health` reports `write_path.identity_source`. If it says `STUB`, identity
is **assumed, not proven**. Set `MIRROR_REQUIRE_AUTH=1` to disable the stub and
fail closed.

## Loopback is not a boundary

If the mirror binds `127.0.0.1` behind a proxy, remember that **every local user
can reach loopback** — including other agents with shell access. They can forge
identity headers by talking to the port directly, bypassing the proxy that would
have stripped them. Verify at the boundary you control; never trust a payload's
self-description.

## The write path

`POST /send` injects into a **live session**. It checks `Sec-Fetch-Site`/`Origin`
and requires `Content-Type: application/json`, which a cross-origin form, image
or script tag cannot set — so such a request must preflight, and the origin check
then rejects it. Enable it only deliberately (`--with-input`); the default is
read-only.

Note the residual gap: when neither `Sec-Fetch-Site` nor `Origin` is present the
origin check passes, because non-browser clients (curl, tests) send neither. The
content-type requirement is what makes that safe against a browser; it is not a
defence against a local process, which can send anything. Loopback is not a
boundary.

Anyone who can POST there can say anything to that session, as the stub
identity, and the session will act on it.

## Files

Two directories under the mirror's data dir, and nothing else is ever served:

| | written by | read by | reachable at |
|---|---|---|---|
| `inbox/` | the mirror, from `POST /upload` | the instance | `GET /file/inbox/<name>` |
| `outbox/` | the instance | anyone who can reach the mirror | `GET /file/outbox/<name>` |

**`outbox/` is published.** Anything placed there is downloadable by every
viewer, with no further confirmation — that is the point of it, and it is worth
saying plainly because it means an instance can disclose a file by writing to a
path. Treat it as the publish button it is.

`POST /upload` **writes to disk as the instance.** It is same-origin checked,
requires identity, and requires an `X-Filename` header — a custom header cannot
be set by a cross-origin form or `<img>`, so the request must preflight and the
origin check then rejects it. That is the same CSRF property `/send` gets from
requiring JSON, and it carries the same residual gap: **a local process can send
anything.** Loopback is not a boundary.

What is deliberately not trusted, all decided in `src/files.mjs`:

- **the supplied filename** — reduced to `[A-Za-z0-9._-]`, split on both path
  separators, `..` collapsed. Names are constructed from safe characters rather
  than sanitised, so there is no input that escapes the directory.
- **the supplied content-type** — the served type comes from the extension, from
  an allowlist, with `X-Content-Type-Options: nosniff`.
- **string prefix checks** — a symlink inside a box satisfies `startsWith(dir)`
  while pointing at `~/.ssh`. Paths are resolved with `realpath` and must land
  inside the resolved box.
- **inline rendering** — only raster images render in the page.
  **SVG always downloads**: it is an XML document that can carry `<script>`, and
  it would be served same-origin with a page that can POST into a live session.

Uploads are capped (`MIRROR_MAX_UPLOAD`, default 25 MB) and an oversized upload
is **refused with 413, never truncated** — a silently shortened file that
reports success is a worse outcome than a rejection.

Verified against a running server rather than by reading the code: byte-exact
round trip, five traversal shapes all refused, oversize refused, SVG served as
`application/octet-stream; attachment`.

## Reporting

Open an issue. If it is sensitive, say so and leave out the details until we can
find a private channel.
