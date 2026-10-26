# Permission requests from the web mirror (PermissionRequest hook)

Status: **prototype**, branch `lupo/permission-hook`. Offline test passes
(`bash test/permission-hook.sh`, 19 checks). Not yet tested against a live
Claude Code session — see "Open questions" below.

## The problem

Claude Code's permission dialog is synchronous: one terminal, one mind, a human
at the keyboard. An independent mind's human may not see a request for days.

The mirror's permission panel polls `channelUrl/pending-permissions`. On a
`--bg` mind, `channelUrl` is web-bridge, which always answered `pending: []`.
The cards used to come from the hacs-channel MCP server, through
`claude/channel/permission`. That only works for a session **born** with
`--dangerously-load-development-channels`. A `--bg` resume can't add the flag
without forking the mind, and the flag is being phased out anyway.

`PreToolUse` → `permissionDecision: "defer"` is the asynchronous primitive
Claude Code does ship. But 2.1.285 ignores it in interactive sessions
(`defer is print-mode only`), so `--bg` minds can't use it.

## The design

A `PermissionRequest` hook is a plain `settings.json` entry, so the session
needs no birth flag. Claude Code runs it when it is about to ask for
permission. It is not Claude Code's own MCP-based relay, which needs the
channel flag.

```
Claude Code ──stdin──> bin/permission-hook.mjs ──writes──> ~/.web-bridge/permissions/pending/<id>.json
                              │ waits (forever by default)            │
                              │                                        ▼
                              │                      web-bridge GET /pending-permissions ──> mirror panel
                              │                                                                 │ Lupo taps
                              ▼                                                                 ▼
       decision JSON <── reads verdicts/<id>.json <── web-bridge POST /permission-verdict <── mirror /permission
```

* **State is on disk.** If the bridge restarts, the hook keeps waiting and the
  restarted bridge lists the card again.
* **The hook never decides by itself.** It prints a decision only when a
  verdict exists. On error, on SIGTERM (Claude Code cancelling it), or when
  `PERM_HOOK_MAX_WAIT_S` runs out, it removes its card and exits 0 with no
  output, so Claude Code falls back to its normal dialog.
* **No stale cards.** If the hook process is gone (session restarted, hook
  killed), the bridge deletes the card the next time it lists. A card never
  outlives the request that made it, which is Bastion's rule.
* **No changes to the mirror.** The card and verdict formats match
  hacs-channel's `/pending-permissions` and `/permission-verdict`, and the ids
  use the same 5-letter alphabet.

## Install (per mind, by its human)

1. Run web-bridge from this branch: stop the old bridge, then start
   `bin/bridge-linux.mjs` as before (same `BRIDGE_TARGET` / `BRIDGE_PORT`).
2. Add to the mind's `~/.claude/settings.json`:

```json
"hooks": {
  "PermissionRequest": [
    { "matcher": "*",
      "hooks": [ { "type": "command",
                   "command": "node ~/claude-session-mirror/bin/permission-hook.mjs; exit 0",
                   "timeout": 604800 } ] }
  ]
}
```

`timeout` is in seconds (604800 = 7 days). The trailing `; exit 0` matters:
the mirror README measured that a failing hook is reported to the model once
per event, and only a `command` hook ending in `exit 0` stays silent.

3. Trigger something that needs approval, such as a `Write` that isn't on the
   allow list, and watch the panel.

## Open questions (need a live session to answer)

1. **Does the console dialog appear while the hook holds?** The 2.1.285 binary
   has "Dialog teardown" and "PermissionRequest hooks cancelled" paths, which
   suggests the hook and the dialog may run at the same time, first answer
   wins. If so, the hook's SIGTERM path already handles a console answer. If
   not, the console shows nothing until the hook returns, which suits an
   unattended `--bg` mind but not an attended one. Set `PERM_HOOK_MAX_WAIT_S`
   for those.
2. **Is the hook `timeout` capped?** It's unverified whether 604800 is honored
   or clamped. Test with a value longer than 10 minutes and watch whether the
   hook gets a SIGTERM early.
3. **Subagents.** Their permission requests should run the same hook. The card
   doesn't yet say which agent is asking.
4. **Trust.** Like the rest of the mirror, verdicts rest on the tailnet
   boundary until the executive API key lands.
