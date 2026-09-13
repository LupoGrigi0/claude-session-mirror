# Seeing a blocked session from outside

*2026-09-13. Researched after Orla froze on `/login` and Lupo concluded a healthy
mirror had gone deaf — twice in one day, the same wrong diagnosis.*

**The class:** the session is blocked on something that exists only in the TTY.
The mirror can neither see it nor answer it, so a blocked mind and a deaf mirror
are indistinguishable from outside. Both incidents were diagnosed as deafness.

## The finding: hooks DO surface it. The transcript does not.

Blocking prompts are not written to the `.jsonl` while they block — that part of
my earlier note was right. But there is a second channel, and it carries both
the CONTENT and the STUCK signal:

| hook | fires | gives us |
|---|---|---|
| `PreToolUse` matcher `AskUserQuestion\|ExitPlanMode` | before the permission flow | **the full question set / full plan text** in `tool_input` |
| `PermissionRequest` | the moment a decision is needed | "a block is starting", zero latency |
| `Notification` matcher `permission_prompt` | **6 s after** an unanswered prompt | **"still stuck"** — the detector |
| `PostToolUse` | after | "answered, clear it" |

Every payload carries `session_id`, `transcript_path`, `cwd`, `permission_mode`.

## The constraint that used to make this a non-starter is gone

Measured previously and still true: **hooks run synchronously by default and
block the session roughly 1:1 with their own runtime.** That is why the standing
advice has been "do not hook anything chatty."

But `async: true` exists: spawned and abandoned, output and exit code ignored,
timeout not enforced. **An async hook cannot block the mind.** There is also an
`http` hook type that POSTs the event JSON directly — which is exactly the shape
the mirror already consumes for pending permissions.

So the design is small:

```
  async http hooks  ──POST──>  mirror /permissions-ish endpoint
    PreToolUse(AskUserQuestion|ExitPlanMode)   content
    PermissionRequest                          block begins
    Notification(permission_prompt)            still blocked at 6s
    PostToolUse                                resolved
```

**This is not a new capability.** The mirror already surfaces pending permissions
and lets a human answer them remotely. Plan-mode questions are an UNHANDLED CASE
in a mechanism that exists and is tested — which is why this is cheap.

## What must be TESTED before building. Do not skip these.

The research verified field schemas against the installed binary (v2.1.241)
because the rendered docs disagree with the binary on `Notification` field names.
That is good evidence and it is also version-specific. Untested:

1. **Does `PermissionRequest` actually fire for `ExitPlanMode` and
   `AskUserQuestion`?** Both route through the generic `can_use_tool` path, so it
   *should*. Nobody traced it and no doc says so. **Test before relying on it.**
2. **The 6 s delay is a hardcoded constant** (`AZn=6000`) in the bundle, not a
   documented setting. It can change on any update, silently.
3. **`transcript_path` is documented only as "path to conversation JSON"** — the
   `.jsonl` extension is inference, not documentation.
4. Field names come from binary Zod schemas at one version. **Pin the version you
   tested against and re-check after a Claude Code update.**

Kill switch that would disable the stuck detector without warning:
`CLAUDE_CODE_DISABLE_PERMISSION_PROMPT_NOTIFY_HOOKS`.

## Risk on the way in

A malformed `hooks.json` affects a LIVE MIND. Use `async: true` from the first
experiment so a mistake cannot wedge the session, test on a scratch instance
before any mirror-owning one, and change one hook at a time.

*A capability that exists but is undiscoverable does not exist (Bastion). This
one existed the whole time; nobody had looked.*
