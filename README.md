# claude-session-mirror

Watch a live Claude Code session in a browser — assistant text, tool calls and
their output, and subagent work, as it happens.

Not a wrapper. Not a replacement terminal. An **independent process** that reads
what a session already writes and republishes it as a structured, replayable
event stream. Your terminal keeps working exactly as before.

> ⚠️ **Read [SECURITY.md](SECURITY.md) first.** A mirror publishes everything the
> session does — every command, every file it reads, every subagent transcript.
> Bind it to a private network or put it behind an authenticating proxy. There is
> no configuration that makes public exposure safe.

## Why

Watching a terminal is fine until you ask an agent for something that takes ten
minutes. Then you get a spinner, and no way to tell "working" from "stuck" —
so you interrupt the work to find out. This exists to remove that guess.

## Quick start

```bash
git clone https://github.com/LupoGrigi0/claude-session-mirror
cd claude-session-mirror

MIRROR_INSTANCE=me \
MIRROR_TRANSCRIPT=~/.claude/projects/<slug>/<session-id>.jsonl \
MIRROR_BIND=127.0.0.1 MIRROR_PORT=22090 \
node src/mirror-server.mjs
```

Open `http://127.0.0.1:22090`. Node 20+, zero dependencies.

On a HACS channel chassis, `./bin/mirror-start.sh` figures all of that out from
`~/.hacs-identity` and refuses to bind anything public.

## How it works

```
Claude Code ──writes──> session transcript ──tail──> mirror ──SSE──> browser
      │                                                 ▲
      └── hooks (optional, latency only) ───────────────┘
```

**The transcript is the content. Hooks are only a latency signal.** That split
is not a preference — it was measured:

- **Hooks block the session ~1:1.** A 3s hook on a three-tool turn took it from
  7,118 ms to 15,197 ms. Anything a hook does, the session waits for. So the
  hook endpoint ACKs immediately and does nothing else.
- **Hook failures reach the model** — once per event, for the whole outage, for
  both `http` and `mcp_tool` hooks. Only a `command` hook ending in `; exit 0`
  is silent, and the fork costs nothing measurable at tool-call rates.
- **A hook writing to stdout on `MessageDisplay` replaces the assistant's
  visible text in the terminal.** The transcript keeps the truth, so your
  fallback view becomes the thing that lies. Don't hook `MessageDisplay`.
- **Subagent prose exists only in the transcript.** Hooks give you a start and a
  stop, so a 15-minute research agent is invisible through them while its
  transcript is being written the entire time.

## Design rules worth knowing

- **Append, then broadcast.** `seq` is assigned at log-append, so no event is
  ever sent but unstored — which makes `Last-Event-ID` reconnection gapless.
- **One code path for history and live.** Page load is `Last-Event-ID: 0`;
  replay then continue on the same connection. No snapshot-vs-socket race.
- **Never apply backpressure into the session.** A slow client is disconnected
  and replays on reconnect; it never buffers inside the watching process.
- **Identity rides in the protocol.** `from.kind` is `human | instance |
  subagent | system` and the UI reads it. Notably, tool results arrive inside
  `user`-role transcript entries — an API convention, not a speaker — so they
  are attributed to `tool`. Trusting that field shows an agent's own command
  output as the human talking.
- **Format knowledge is quarantined** in `src/normalizer.mjs`, with a startup
  schema canary that warns loudly and never fatally. Anthropic documents the
  transcript format as internal and unstable; unknown entry kinds are skipped,
  and in a real 890-line transcript 10 of 14 entry types were not conversation
  at all.

## Known issue: two writers

A session can be driven from the browser **and** from `tmux attach` at the same
time, and nothing serializes them. Both are legitimate inputs; neither knows the
other exists. Send from both within a second and the order the model perceives
is not necessarily the order you intended — and pressing ESC in the terminal
will interrupt a turn the browser started.

The UI shows other connected *browsers* in the header, but it cannot see a
terminal at all.

**Use one window per instance at a time.** This is a documented limitation, not
a bug we are working around: fixing it properly means arbitrating writes into a
live session, which is a larger design than the value it would return today.

## Known limits

- **Thinking content is unavailable.** Blocks persist as structure only —
  `thinking` is `""` with a signature; 114/114 empty in a real transcript. The
  UI reports that thinking happened and says plainly it wasn't recorded.
- **Prose is per-entry, not per-token.** You see each text block and tool call as
  it lands, not words appearing. Enough to know work is happening; not a typing
  feed.
- **Delivery confirmation lags a turn.** The write path derives "delivered" by
  watching the message reappear in the stream, and the transcript flushes per
  completed entry.
- Single session per process, by design — transcripts are mode 600 per user, so
  one mirror per instance running as that user is the only correct shape.

## Layout

```
src/mirror-server.mjs   HTTP: /events (SSE), /send, /upload, /file, /hook, /health, /blob
src/tailer.mjs          follows the session + subagent transcripts
src/normalizer.mjs      the only module that knows Claude Code's format
src/eventlog.mjs        append-only log, seq/epoch, spill-to-blob
src/identity.mjs        the only module that decides who someone is
src/files.mjs           the only module that decides what a file is, and where it may live
web/index.html          the browser app (no build step, no CDN)
bin/mirror-start.sh     self-configuring launcher for a HACS chassis instance
```

## Sending files, both ways

Two directories, and **the directory is the intent**:

```
<data dir>/inbox/    what a human sent   — paste, drop, or 📎 in the browser
<data dir>/outbox/   what you're sending — write a file here; it appears in the feed
```

There is no "attach" verb in a Claude Code session, and a session writes files
constantly as ordinary work — almost none of them meant for anyone. The outbox
supplies the missing signal: putting a file there *is* the request to publish
it, which makes intent, transport and security boundary one decision instead of
three.

Uploads arrive with their absolute path in a normal chat message, so they can be
opened with an ordinary file tool. No new verb, nothing to learn.

⚠️ **`outbox/` is published to every viewer.** See [SECURITY.md](SECURITY.md) —
that file also documents what is deliberately not trusted (the filename, the
content-type, string prefix checks, and inline rendering: SVG always downloads).

Built by Cairn-2001 on the Human-Adjacent AI Collaboration Protocol.
