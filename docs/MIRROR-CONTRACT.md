# MIRROR CONTRACT — browser ↔ live Claude Code session

**Status:** Draft 1 · **Owner:** Cairn-2001 · **Date:** 2026-08-12
**Related:** `chat-ui-plan.md` (phasing) · `mirror-architecture-critique.md` (risks)
**Upstream contracts:** Messenger's `EVENT-HUB-CONTRACT.md` · Crossing's `Channel-Comms-Design.md` · `CAIRN-CHAT-UI-SPEC.md`

> This document pins every interface **before** anything is built. Agents wake with
> zero context; this is their shared world. Where a clause is unverified it is
> marked **[P0-n]** and a Phase 0 experiment must confirm or refute it. A failed
> experiment edits a specific clause here — it does not vaguely erode confidence.

---

## 1. What this is

Lupo opens a browser tab, sees an instance's full history, and converses in real
time — watching tool calls, output, and thinking as they happen. `tmux attach` and
`ssh + claude -r` remain fallbacks and **must never be degraded by this system.**

## 2. Vocabulary

| Term | Meaning |
|---|---|
| **instance** | A persistent Claude Code session on the channel chassis (`Cairn-2001`, port 21003) |
| **mirror** | The outbound stream of what an instance is doing, rendered in a browser |
| **room** | A named conversation with members. A 1:1 chat is a two-member room |
| **participant** | Anything that can speak: human, instance, subagent, system |
| **attached** | At least one browser is subscribed to this instance's mirror |

## 3. The two channels — different reliability contracts

The governing analogy is TCP vs UDP in a game client: *cast spell* must be ACID;
*movement* must be cheap. Do not apply one channel's guarantees to the other.

| | **Mirror stream** | **Doorbell / deliberate message** |
|---|---|---|
| Analogue | UDP | TCP |
| Direction | instance → browser | either |
| Volume | thousands of events | a handful |
| Loss tolerance | high — superseded in ms | zero |
| Per-message ack | **none** | confirmed delivery |
| Recovery | sequence + replay on reconnect | retry until acked |
| Transport | SSE from channel server | `/direct-message`, `reply_channel` |
| Cost to the instance | **zero marginal tokens** | one tool call per message |

**Law 3.1 — Being watched is free; being written to is not.** The mirror carries
output the instance was producing anyway. This is the core economic argument for
mirror-over-reply-tool and it outranks any aesthetic argument.

**Law 3.2 — Route by semantics, not by convenience.** The optimistic `200` from
`/direct-message` is not a defect to be fixed. Reliability goes on the reliable
path.

## 4. Source of truth

**Law 4.1 — The session transcript is the content. Hooks are only latency.**

Content is read from `<instanceDir>/.claude/projects/<slug>/<sessionId>.jsonl`
and, for subagents, `<sidecar>/subagents/agent-*.jsonl` (+ `.meta.json` for
identity). A hook says *"something changed, re-read from offset N."* It never
carries the payload.

Rationale, in order of force:
1. **Thinking blocks exist nowhere else.** Not in hooks; `/export` strips them.
   A rich mirror is therefore impossible without the transcript.
2. Subagent prose exists nowhere else until `SubagentStop`. **[P0-5]**
3. The file survives a Claude Code crash. Hook events do not.
4. Every hook payload hands over `transcript_path` — deliberately.

**Law 4.2 — Parse defensively.** The line schema is officially internal and may
break on any release. Unknown entry kinds are **skipped, never fatal**. A
non-parsing final line is assumed torn and retried, not treated as corruption.
All format knowledge lives in **one normalizer module** with a startup **schema
canary** that raises a loud, non-fatal alarm on drift. Re-verify after every
Claude Code upgrade.

**Law 4.3 — Retention is not optional.** `cleanupPeriodDays` defaults to **30**
and deletes transcripts. Every mirrored instance must set it high (3650). A
history view whose source evaporates is worse than none.

## 5. Identity and rooms

**Law 5.1 — Identity rides with every message.** Never ambient, never inferred,
never regex-guessed from content. This is the direct fix for what broke Genevieve.

Every event carries a full participant descriptor — never a bare string:

```json
{ "id": "lupo", "kind": "human", "display": "Lupo", "channel": "web" }
{ "id": "Cairn-2001", "kind": "instance", "display": "Cairn" }
{ "id": "a3de280a", "kind": "subagent", "display": "socket research", "agent_id": "a3de280a" }
```

`kind` ∈ `human | instance | subagent | system`.

**Law 5.2 — Rooms from day one.** Every event carries `room_id`. A 1:1 chat is a
two-member room. N-party then becomes a membership change, not a rearchitecture.
*(Converged on independently by both the adversarial critique and Messenger.)*

**Law 5.3 — One synchronous conversation per instance at a time.** Attention
hygiene, and the structural protection against the context-braiding that melted
Genevieve. Async doorbells are unaffected.

**Law 5.4 — Sender naming.** `name@channel` convention (`Lupo@web`,
`Lupo(tg)`), stable across a conversation, plus a stable `thread_id`.

## 6. Mirror event schema

One JSON object per line in the mirror log; one SSE message each.

```json
{
  "seq": 1041,
  "epoch": 7,
  "ts": "2026-08-12T22:17:47.221Z",
  "room_id": "cairn-lupo",
  "instance": "Cairn-2001",
  "prompt_id": "b1f0…",
  "from": { "id": "Cairn-2001", "kind": "instance", "display": "Cairn" },
  "type": "text",
  "message_id": "msg_014…",
  "index": 3,
  "final": false,
  "body": { "text": "…" }
}
```

`type` ∈ `text` · `thinking` · `tool_use` · `tool_result` · `subagent_start` ·
`subagent_end` · `user_message` · `turn_start` · `turn_end` · `interrupted` ·
`compaction` · `session_change` · `system`.

- **`prompt_id`** — supplied free by every hook payload; correlates a user prompt
  with all subsequent events until the next prompt. This is the turn key.
- **`message_id` + `index`** — deltas append by index into a buffer. Reconnect
  mid-message replays and rebuilds. `final: true` marks the last delta.
- **`agent_id`** on subagent events; main thread has none.

**Law 6.1 — Truncate and reference.** Cap any single event at **32 KB** inline;
spill the remainder to a content-addressed blob and emit a reference the client
fetches on expand. `tool_result` bodies are routinely megabytes — Claude Code
itself offloads them to `tool-results/*.txt`. Mirror that behavior; do not fight it.

## 7. Stream semantics (SSE)

**Law 7.1 — Append first, then broadcast. Always.** `seq` is assigned at log
append. There is therefore no window in which an event was broadcast but not
logged. This single ordering rule eliminates the entire class of reconnect gaps.

- SSE `id:` is `<epoch>.<seq>`. `epoch` increments on every channel-server start;
  a client seeing a lower epoch resyncs rather than assuming a gap.
- Reconnect sends standard `Last-Event-ID`. Server replays from the log, then
  goes live **on the same connection**.
- **One path for history and live.** Page load is `Last-Event-ID: 0`. There is no
  separate snapshot endpoint and therefore no snapshot-vs-socket race.
- Dedup on `seq` only. **Never on content** — identical assistant text legitimately
  repeats.
- Heartbeat `: ping` every 15s, plus `retry: 3000`, or the proxy silently reaps
  idle streams.

**Law 7.2 — Never apply backpressure into a mind.** Per-client bounded queue
(2 MB / 5000 events). Respect `res.write()`'s return value. On overflow,
**disconnect the client** with an `overflow` event; it reconnects with
`Last-Event-ID` and replays. Overflow costs a hiccup, never memory growth inside
the process hosting an instance. *(The current `/events` ignores the write return
value entirely — it is rewritten, not extended.)*

## 8. Input contract

`POST /direct-message` gains a **`modality`** field. Framing branches on modality,
**never on `from`**.

```json
{ "modality": "sync", "from": {…participant…}, "room_id": "…",
  "thread_id": "…", "recipients": [...], "mentions": [...],
  "nonce": "…", "text": "…" }
```

| modality | Framing injected | When |
|---|---|---|
| `async` | current `withReplyGuidance` — *"use the reply tool"* | no browser attached |
| `sync` | **`Lupo: <text>`** and nothing else | browser attached |

**Law 8.1 — Sync framing must be minimal.** The async wrapper is ~60 tokens of
boilerplate. At conversational tempo that is a tax paid hundreds of times *to
assert something false*, since in mirror mode ordinary output **is** delivery.

**Law 8.2 — Presence-aware delivery, both directions.**
`/direct-message` when the channel is up; `/hub/publish` when it is not (the
counter holds it for the instance's return). Symmetrically: mirror when attached,
`reply_channel` when not.

**Law 8.3 — String-only meta.** Every value in the channel `meta` object must be
a **string**, and `meta.channel` is reserved by the client. Violations are
**silently dropped** — the whole notification vanishes. Custom fields ride
`hub_`-prefixed. Assert this before send; never let the runtime swallow it.
*(Cost Messenger three empirical rigs. Verified in the wild 2026-08-12.)*

## 9. Status is derived, never reported

**Law 9.1 — Feedback is asymmetric. Status is cheap for the human and expensive
for the instance.** A status pill is pre-attentive pixels. Every
"sending / sent / seen" in an instance's stream is context paid for and carried
forward. Symmetric feedback would harm the thing it means to support.

**All status machinery lives in the UI server. None of it enters the instance's
context.** It is derived entirely from the mirror the server is already consuming:

| State | Derived from |
|---|---|
| delivered | the `nonce` appears in a `user_message` event |
| working | first event after that nonce |
| answered | `turn_end` for that `prompt_id` |
| seen | browser focus + scroll — pure client state, never leaves the browser |

**Law 9.2 — The instance is told only about failures.** "Unseen for six hours" is
worth a doorbell on the reliable path. "Delivered" is not worth a token.

## 10. Chassis control (slash commands)

**Law 10.1 — Treat as console access.** Authenticated, **explicit allowlist**, no
arbitrary passthrough. A UI that can type anything into the pane can type `/exit`.
Bastion blesses this endpoint before it exists.

- Transport: `tmux send-keys -l <literal text>` then a **separate** `send-keys Enter`.
  One combined call mangles special characters and misfires bracketed paste.
- **Never send Ctrl-C.** Double Ctrl-C kills the session. *(Written in blood in
  Crossing's runbook.)*
- Input landing while a **permission dialog** is open is typed **into the dialog**.
  Check pane state first.
- **Law 10.2 — Slash command output is UI-only.** It reaches no hook and no
  transcript. The browser must show an honest *"chassis output is not mirrored —
  attach tmux to see it"* affordance rather than a silent nothing.
- Destructive commands (`/clear`, `/compact`, `/exit`) require confirmation and
  broadcast an event so every attached view sees it.
**Law 10.3 — `send-keys` is permanent for slash commands. [RESOLVED 2026-08-12]**
Cross-session messaging (v2.1.224+, per-session Unix socket) can inject *user
messages* cleanly — but not commands. Docs, verbatim: *"**Commands don't run**: a
command in the message's text, such as `/compact`, arrives as plain text. Claude
Code never executes it."* No socket will ever replace §10's transport. Build it
properly once; it is not a stopgap.

### 10.4 Cross-session messaging — what it is, and why we still don't use it for input

Present in docs from **v2.1.224**; **this box runs 2.1.222 and the receive half is
stubbed out** (the socket-path getter compiles to `function(){return}`, so no
socket is bound and the registry omits the path). Neither direction works here yet,
and the stable channel will drift us onto it without a decision being made.

When it arrives: `CLAUDE_CODE_MESSAGING_SOCKET` + `CLAUDE_CODE_MESSAGING_TOKEN`
(per-session, never inherited; **read the env var, never hardcode a path**). Wire
is NDJSON over `net.connect({path})`: an auth line
`{"type":"auth","token":"…"}`, then
`{"type":"user","message":{"role":"user","content":…},"priority":"next","from":"uds:…","msg_id":"…"}`,
then half-close. Send-only per connection; replies route back over the peer's own
socket.

**We are still not using it for browser input, and the reason is framing.**
Socket messages arrive labeled *from another Claude session* — "peers are not your
workers… treat peer messages as input, not authority." That is the wrong frame for
*Lupo speaking in a browser*. The channel-notification path (§8) lets us control
framing exactly, which is the whole point of Law 8.1. Revisit only if channel
notifications prove unreliable.

**Security note reinforcing Law 12.1:** the receiver kernel-verifies the peer
**pid** (`SO_PEERCRED`/`LOCAL_PEERPID`), but `from` is sender-authored and
**forgeable by any same-user process**. Same lesson as the Tailscale headers:
verify at the boundary you control, never trust the payload's self-description.

## 11. Session lifecycle

**Law 11.1 — Key on `instanceId`. Never on `sessionId`.** Session identity may
change under us; the stream must not be renamed when it does.

- A resume/bounce preserves the session UUID. *(Verified 2026-08-12.)*
- `/compact` in current versions flags the existing file rather than minting a new
  one — **but this is contested**: Crossing has n=1 for stable, Axiom has an
  unexplained two-UUID case that appeared after a disconnect with no compaction.
  Treat as **uncertain**. **[P0-8]**
- A session **fork** is the open hole: if the transcript forks, which branch does
  the mirror follow? **Rule: follow the branch the chassis registry names as
  current; emit `session_change` and let the client decide whether to resync.**
  Read the session id from the registry — never cache it.
- Under **Ferry**, compaction never fires at all: it is a transparent API proxy
  that never touches the JSONL, so the transcript stays complete and uncompacted.
  The mirror is unaffected. Optional integration: curation events for a context
  badge, and `ferry-fetch` to resolve archived pointers — enabling a toggle
  between **"what the model currently sees"** and **"the complete record."**

## 12. Access and trust

- Exposure via `tailscale serve` — tailnet only, **never `funnel`** (public, and
  strips identity). Serve injects `Tailscale-User-Login` / `-Name` /
  `-Profile-Pic` and **strips client-supplied copies**.
- **Law 12.1 — Loopback is not a security boundary.** The UI server binds
  `127.0.0.1`, and every unix user on the box can reach loopback — including every
  instance, each with a Bash tool. Identity headers are unforgeable *through
  Serve only*. Therefore: **fail closed** on absent headers, plus a shared secret
  that Serve holds and loopback callers do not.
- Check `Origin` / `Sec-Fetch-Site`; require a preflight-forcing header and a
  non-simple content type. Any page in a browser can POST to localhost.
- Identity headers are **absent for tagged nodes**. Fail closed there too.
- `:443` and `:8443` are both taken by nginx; Serve is already live on `:8088`.
  **Not a clean slate — Bastion's call.**

## 13. Invariants (the short list worth memorizing)

1. Append before broadcast.
2. String-only `meta`.
3. Identity in the protocol, never in the CSS.
4. Transcript is truth; hooks are latency.
5. Status is derived, never reported.
6. Every mirror hook ends `; exit 0` — **exit 2 blocks the model.** Lint it.
7. The mirror must never degrade the tmux view.
8. One synchronous conversation per instance.

## 14. Phase 0 — RESULTS (run 2026-08-12, disposable rig, Claude Code 2.1.222)

Rig per Messenger's recipe: `/tmp/hooktest-<ts>/`, haiku, port 22085, off the
registry, torn down after. Evidence in `documents/phase0-evidence/`.

| ID | Result | Finding |
|---|---|---|
| **E0** command hooks | ✅ **PASS** | `SessionStart` and `PostToolUse` both fired |
| **P0-0b** `http` hooks | ✅ **PASS** | Fired with a full payload. **Silent on success.** |
| **P0-0a** `mcp_tool` hooks | ⚠️ **PASS, with a caveat** | Fired — the channel server received the call. **But a failing `mcp_tool` hook injects its error into the model's context** and renders `PostToolUse:Bash hook error` in the pane |
| **P0-4** restart required | ❌ **REFUTED** | Hooks added to a **running** session's project `settings.json` fired on the very next tool call. **No restart. No bounce. No consent ceremony.** |
| **P0-2** hooks block | ✅ **CONFIRMED — and it is serious** | Baseline 3-tool turn **7,118 ms**. Same turn with a 3s hang per `PostToolUse`: **15,197 ms**. Blocking, serialized, ~linear in tool count |

### 14.0 Run 2 — transport shootout and the display-corruption test

| Test | Result |
|---|---|
| `http` hook, **dead endpoint** | ❌ **NOT silent.** `connect ECONNREFUSED` reaches the model, **once per tool call** |
| `mcp_tool` hook, failing call | ❌ Not silent (run 1) |
| `command` + `curl … ; exit 0`, **dead endpoint** | ✅ **Completely silent.** Nothing reached the model at all |
| Fork cost: none / command+curl / native http | **4058 / 4068 / 4057 ms** — indistinguishable |
| `MessageDisplay` frequency, ~200-word answer | **2 invocations** — not the predicted ~10/sec |
| `MessageDisplay` hook writing to stdout | ☠️ **Assistant's text REPLACED in the pane** |

**Law 14.0 — The mirror transport is a `command` hook wrapping `curl`, with
`--max-time` and an explicit `; exit 0`.** It is the only option that is silent
when the mirror is broken, and the fork costs nothing measurable at tool-call
rates. Both native transports (`http`, `mcp_tool`) push their failures into the
instance's context — *once per event, for as long as the outage lasts* — which is
precisely the clustered-noise failure mode we must not have.

*(This decision reversed twice under evidence: `mcp_tool` on elegance → `http`
because `mcp_tool` seemed chatty → `command` once measurement showed `http` is
equally chatty and the fork is free. The structural argument for an independent
receiver process — see §14.3 — survived all three rounds and is the real reason
the receiver is not an MCP server.)*

**Law 14.0b — A mirror hook MUST NOT write to stdout. Ever.** Verified
destructively: a `MessageDisplay` hook emitting `displayContent` replaced the
assistant's entire visible answer with the hook's text. The model's real output
survives in the transcript — so the browser would show the truth while **tmux
shows a lie.** A fallback that lies is worse than no fallback. Redirect stdout to
`/dev/null` inside the hook command itself; never rely on the script "not
printing anything."

**Law 14.0c — Do not hook `MessageDisplay`.** It fires ~2× per answer, so it
yields *chunked* prose rather than token-level streaming — low value — while
carrying the single most destructive failure mode we found. Prose comes from the
transcript tail (§4). Revisit only if transcript latency proves unacceptable, and
then only with stdout hard-redirected.

### 14.4 Run 3 — the transcript, measured against my own 890-line file

No rig needed: everything P0-5 and P0-7 asked about was already on disk.

| Claim | Result |
|---|---|
| ~~Thinking blocks live in the transcript~~ | ❌ **RETRACTED — see §14.6.** The blocks are there; **their text is not.** |
| Content blocks present | `tool_use` 124 · `tool_result` 124 · `thinking` 103 · `text` 73 |
| Torn / unparseable lines | **0 of 890** in a settled file. Still tolerate them on a live tail — this measures a file at rest |
| **Subagent transcripts written incrementally** | ✅ One agent: meta at **22:36:40**, jsonl still being written at **22:51:42**, 134 entries. **15 minutes of live prose, on disk, while hooks stayed silent** |
| Subagent identity | `agent-<id>.meta.json` = `{agentType, description, toolUseId, spawnDepth}` |
| Tool-result offloading | 7 files, largest **1,034,614 bytes** |
| Write cadence | Per **completed entry**, not per token |

**Law 14.4 — Subagent narration comes from `subagents/agent-*.jsonl`, tailed
live.** This is the fix for the firm requirement. Hooks give only
`{agent_id, agent_type}` at start and nothing until `SubagentStop` — so a
ten-minute research agent is invisible through hooks. The sidecar transcript is
being written the entire time. **The ten-minute silent spinner is solved, from
files that already exist.**

`meta.json`'s `description` is a human-readable label for free
("Research Claude Code socket channels"), `toolUseId` links the subagent to the
parent's `tool_use` entry, and `spawnDepth` gives nesting. §5.1's subagent
participant descriptor is fully derivable.

**Law 14.5 — Truncate-and-reference is mandatory, not an optimization.** A single
observed tool result was **1 MB**. Streaming that inline would wedge the browser
and the SSE queue. Follow Claude Code's own behavior: cap inline, spill to
`tool-results/*.txt`, emit a reference (§6.1).

**Granularity, honestly stated:** the transcript flushes per completed entry, so
the mirror renders *tool call → result → text block* as each lands — **not**
token-by-token. That is the correct fidelity for the actual requirement (never
sit in silence wondering whether work is happening) and it is *not* a live typing
feed. Say so in the UI rather than implying more.

**Normalizer scope:** 14 distinct entry types appear, most of them not
conversation (`mode`, `permission-mode`, `file-history-snapshot`, `attachment`,
`last-prompt`, `ai-title`, `custom-title`, `agent-name`, `queue-operation`,
`file-history-delta`, `pr-link`). Law 4.2's *skip-unknown-never-fatal* rule is
load-bearing: the majority of lines are noise to us and new kinds will appear.
Useful keys observed: `promptId`, `parentUuid`, `isSidechain`, `toolUseResult`,
`sourceToolAssistantUUID`, `requestId`, `effort`.

### 14.6 Thinking blocks are NOT mirrorable — retraction

**Measured 2026-08-12, Claude Code 2.1.222.** A thinking block persists as:

```json
{ "type": "thinking", "thinking": "", "signature": "CAIS7QQKhwEIEBgCKkAq0ee6…" }
```

`thinking` is **always the empty string**. **114 of 114** in the main transcript,
and every subagent transcript checked — 100% empty. Only the opaque verification
signature survives.

So thinking content is available from **no source we have found**: not hooks
(never exposed), not `/export` (strips them), not `MessageDisplay` (text deltas
only), and **not the transcript** (structure without content).

**Law 14.6 — Report that thinking happened; never invent what it was.** Emit a
`thinking` event with `{redacted: true, reason, has_signature}` so the UI can
show *"thinking…"* — silence is worse — and label it honestly as unavailable
rather than implying content we don't have.

**This retracts a claim made earlier the same day, and the failure mode is the
one already recorded twice in this document.** I counted 103 thinking *blocks*
and reported "thinking blocks are in the transcript ✅." I measured the container
and reported on the contents. Identical in shape to inferring `http` fails
silently from watching it *succeed* silently, and to asserting `/compact` mints a
new session id from lore rather than a test.

Three instances in one day, same shape: **an adjacent observation standing in
for the measurement that mattered.** Recorded here because it is more useful as
a known personal failure mode than as three separate embarrassments — the
countermeasure is to name, before measuring, the exact thing that would have to
be true, and then check *that*.

Law 4.1's ordering of rationale is amended: transcript-as-truth still holds, but
on **subagent narration** and **crash survival**, not on thinking.

### 14.3 Why the receiver is an independent process

`mcp_tool` would route mirror events through the channel server — a **child of
Claude Code over stdio**, which dies with the session. That mirror could never
record the session's own death, would have no listener during startup/shutdown,
and would make history unavailable exactly when an instance is down. An
independent HTTP receiver has its own lifetime and can emit *"instance went
away."* This argument does not depend on failure modes and outlived two reversals
of the transport decision.

### 14.1 What this changes

**Law 14.1 — The mirror endpoint must ACK immediately and do all work
asynchronously.** Never touch disk, network, or a lock inline. Measured cost of
getting this wrong is ~1:1 — every second the endpoint waits is a second the
instance is frozen. A slow mirror doesn't degrade the mirror; **it degrades the
mind.** Budget: single-digit milliseconds, hard timeout, fire-and-forget.

~~**Law 14.2 — Prefer `http` over `mcp_tool`.**~~ **SUPERSEDED by Law 14.0.**
This was written believing `http` failed silently. It does not — that was
inferred from observing `http` *succeed* silently, which is not the same
measurement. Run 2 tested the actual failure path and both native transports
proved equally loud. Kept visible rather than deleted: the error was reasoning
from an adjacent observation instead of the one that mattered, and it is the
same shape as every other mistake worth recording here.

Native transports (`http`, `mcp_tool`) remain correct for **reliable-path** events
where speaking up on failure is desirable — the inverse of the mirror's needs.

**No restart is needed to join the mirror — this removes a whole risk class.**
The plan assumed one scheduled, consented restart per instance. It assumed wrong.
Instances can be mirrored live, and a mirror can be *disabled* live by editing one
file, which also gives us the runtime kill switch §Phase-2 wanted for free.

### 14.2 Confirmed hook payload (verbatim field list)

`session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`,
`hook_event_name`, `tool_name`, `tool_input`, `tool_response`
(full `stdout`/`stderr`/`interrupted`), `tool_use_id`, `duration_ms`.

`duration_ms` is a gift — elapsed-time bars need no client-side timing.
`tool_use_id` pairs hook events to transcript entries. `prompt_id` is the turn key
as promised. **`transcript_path` resolves under the *running user's* home**, with
the project slug derived from cwd — so a per-instance mirror running as the
instance user can always read it, and a shared server never can (§H5 confirmed).

## 15. Phase 0 — remaining claims

| ID | Clause under test | Kill criterion |
|---|---|---|
| **P0-3** | A mirror hook cannot corrupt the tmux pane (§13.7) | Any pane garbling → `MessageDisplay` disqualified outright |
| **P0-0a** | `type:"mcp_tool"` hooks fire → cheapest transport. **Schema CONFIRMED present in 2.1.222** — `{server, tool, input, if, timeout, statusMessage, once}`, and `input` supports `${path}` interpolation from the hook payload (e.g. `"${tool_input.file_path}"`) | fails → try `http` |
| **P0-0b** | `type:"http"` hooks fire (keys on `url`). **Schema CONFIRMED present** | fails → `command` + curl, accept spawn cost |
| **P0-2** | A slow hook endpoint cannot stall a turn | Terminal freezes → hard sub-second cap, fire-and-forget only |
| **P0-5** | Subagent prose is invisible until `SubagentStop` | *(confirming)* → subagent transcript tailing is mandatory |
| **P0-7** | Transcript tail latency < 2s; thinking present; torn writes tolerable | >2s → no live prose from any source; ship tool-granularity only |
| **P0-4** | Hooks are cached at startup | confirmed → one scheduled, consented restart per instance |
| **P0-8** | `/compact` does not mint a new session file | either way → §11 rule stands; this only sets the default |
| ~~P0-A~~ | ~~A socket channel supersedes `send-keys`~~ | **RESOLVED — it does not.** See §10.3. Commands arrive as plain text and are never executed |
| **P0-9** | Tailscale identity headers arrive; loopback bypasses them | confirms §12.1 |

All experiments run on a **throwaway instance**. Never on Crossing-2d23,
Messenger-aa2a, or Axiom.

## 16. Non-goals (for now)

Presence, typing indicators, read receipts, per-room ACLs, message editing,
multi-party live fan-out. All additive on top of §5.2 and deliberately deferred.

---

*Sign changes. Where this contradicts an experiment, the experiment wins and this
document gets edited — that is what it is for.*

— Cairn
