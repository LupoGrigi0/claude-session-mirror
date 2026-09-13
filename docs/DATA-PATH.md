# The inbound data path: what separates from what

*Written 2026-09-13 by Cairn-2001, because Lupo asked the right question:
"I'm not sure of your architecture — does your tailer separate **formatting**
from **view** from **capture everything in the log**?"*

Short answer: **yes, into four stages — but there is one gap, and it is exactly
the gap that blocks Crossing.** Stated plainly below so nobody has to read 3000
lines to find it.

---

## The four stages

```
  session .jsonl                 written by Claude Code, not by us
        |
   [1] tailer.mjs        198 ln  BYTES. follow files, track offsets, split
        |                        lines, JSON.parse. Knows nothing about meaning.
        |
        +--> onRaw ------------> EVERY entry, including ones we do not understand
        |                        (used for delivery confirmation)
        |
   [2] normalizer.mjs    463 ln  MEANING. one raw entry -> zero or more events.
        |                        Owns KNOWN_ENTRY_TYPES, KNOWN_BLOCK_TYPES,
        |                        slash-command / system-injection detection,
        |                        and schemaCanary() for upstream drift.
        |
   [3] eventlog.mjs      208 ln  ORDER + PERSISTENCE. assigns seq, appends to
        |                        disk, replay()/history()/subscribe().
        |                        Big blobs spill to files (MAX_INLINE_BYTES).
        |
   [4] web/index.html            VIEW ONLY. consumes events over SSE.
                                 No parsing of transcript format anywhere.
```

**The separation is real.** The renderer has never seen a transcript entry; the
tailer has never heard of a tool call. Upstream can change the transcript format
and only stage 2 needs touching — which is the point, and why `schemaCanary()`
lives there and warns instead of crashing.

---

## THE GAP: the raw tap is a pass-through, not a store

Stage 1 has two outputs, and they are not equal:

| tap | sees | kept? |
|---|---|---|
| `onRaw` | **every** entry | **NO — nothing persists it** |
| `onEvents` | only what normalizes | yes, in the event log |

`onRaw` exists so delivery confirmation can see entries the renderer does not
understand. It is a *tee*, and the water runs out the bottom.

**So the only durable record is the normalized one.** Anything the normalizer
does not model is observed and then gone.

Three consequences, all live:

1. **Crossing cannot build his vector store on the event stream as it exists.**
   He needs raw transcript entries, not rendered events, and raw is not stored.
   That is a missing component, not a tuning problem.
2. **Blocking prompts are never on disk while they block**, so no amount of
   storing helps there — the side channel is a separate piece of work.
3. **We have no independent copy of the transcript.** Which matters because:

## The transcript is NOT append-only, and stage 1 assumes it is

Observed by Lupo, 2026-09-13: Claude Code writes a *"login expired, please
/login"* state into the `.jsonl`, the mirror renders it, and after the human
completes `/login` **Claude Code removes the evidence from the log** and the
message disappears from the web UI. Screenshots exist; Bastion captured a log
from an instance frozen by it.

`tailer.mjs` handles exactly one non-append case:

```js
if (size < state.offset) { /* file replaced — start over */ }
```

**A shrink resets the offset to 0 and re-reads the whole file.** Every event
would be re-emitted with fresh seq numbers — a visible duplication storm, which
nobody has reported. So either the removal does not shrink the file, or it does
and we have not caught it yet. **Both possibilities are untested.** A rewrite
that keeps the file the same size or larger is read as ordinary new content and
mis-parsed silently, which is the worse of the two.

**This is measurement work, not design work, and it must land before the
re-resolution repair is called done.** Filed as a task.

---

## What the tailer does NOT do, deliberately

- **It does not re-resolve its own path.** Resolved once by the launcher, held
  forever. As of `cf81558` `/health` at least *reports* this (`transcript.tailing`,
  `.newest_on_disk`, `.is_newest`), so the deafness cannot be silent — but the
  repair is not written. **Measured 2026-09-12: `/compact` does not re-point on
  current Claude Code**, same uuid across 13 days and many compactions, so the
  case everyone feared is not the live one. `--resume` remains untested.
- **It does not interpret.** Correct, and worth defending.
- **It does not own the sidecar scan.** Subagent transcripts are tracked from a
  sibling directory; same offset machinery, different `ctx`.

---

## If you are changing this

The invariant worth protecting: **each stage should be replaceable without the
others noticing.** The one place that is currently false is the raw tap — it has
no consumer that stores, so adding one is additive rather than a refactor.

*— Cairn, who would rather write the map than answer the question four times.*
