#!/usr/bin/env bash
# Start a session mirror for the instance running this script.
#
# Run it AS YOURSELF. Session transcripts are mode 600 owned by the instance
# user, so a mirror can only read the session it belongs to — by design. Nobody
# needs root, and no single process ever holds the whole team's inner life.
#
#   ./bin/mirror-start.sh                    # read-only mirror
#   ./bin/mirror-start.sh --with-input       # also accept messages from the browser
#   ./bin/mirror-start.sh --permissions-only # publish NOTHING; approvals panel only
#   ./bin/mirror-start.sh --permissions-only --with-input
#                                            # approvals + conversation, still no
#                                            # transcript. What a root session wants.
#
# WHAT THIS PUBLISHES: everything in your session — your prose, every tool call
# and its output, your subagents' work, and the fact (not content) of thinking —
# to anyone who can reach the port. Bound to the tailnet, that's Lupo's devices.
# Read that sentence again before you run it. Your session, your call.
#
# --permissions-only publishes NONE of that. No transcript is read at all. The
# page shows pending permission requests and Allow/Deny, and nothing else about
# your session. Built for a root session, where a transcript mirror would put
# every config read and every path on the box onto a web page — but the approval
# panel is exactly the thing that session needs.
#
# Cairn-2001

set -euo pipefail

MIRROR_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IDENTITY="${HACS_IDENTITY_FILE:-$HOME/.hacs-identity}"
WITH_INPUT=0
PERMS_ONLY=0
WITH_INTERRUPT=0
for arg in "$@"; do
  case "$arg" in
    --with-input)       WITH_INPUT=1 ;;
    --permissions-only) PERMS_ONLY=1 ;;
    --with-interrupt)   WITH_INTERRUPT=1 ;;
    *) echo "error: unknown option $arg" >&2; exit 1 ;;
  esac
done

# PUBLISHING and INPUT are orthogonal axes, not opposites.
#
#   --permissions-only is a READ decision:  does the transcript reach a viewer?
#   --with-input       is a WRITE decision: can a viewer reach the session?
#
# "Don't publish my session, but do let me talk to you" is a coherent request —
# and it is precisely what a root session wants: the approval panel plus a
# composer, and no transcript.
#
# This briefly REFUSED the combination. Bastion recommended that, then corrected
# himself: the bug he actually found was --with-input silently overriding the
# send=0 default through flag ORDERING, with no warning. That is a real footgun,
# but the fix is that a write grant must be STATED rather than acquired as a side
# effect — not that a legitimate combination is forbidden. He caught his own
# over-correction before a feature request could reveal it, which is the same
# discipline as catching mine.
#
# So every grant below is decided ONCE, from the flags, in one place. Nothing is
# granted by being exported later than something else.

die() { echo "error: $*" >&2; exit 1; }

# ---- who am I -----------------------------------------------------------------
[[ -f "$IDENTITY" ]] || die "no $IDENTITY — this script must run as an instance user"
INSTANCE=$(python3 -c "import json;print(json.load(open('$IDENTITY'))['instanceId'])")
CHANNEL_PORT=$(python3 -c "import json;print(json.load(open('$IDENTITY')).get('channelPort',''))")
[[ -n "$INSTANCE" ]] || die "could not read instanceId from $IDENTITY"

# State lives beside the IDENTITY FILE, not beside $HOME.
#
# For every instance so far those are the same directory, so this changes
# nothing for them. They are NOT the same for Bastion: he runs as root with
# HOME=/root while his instance dir and .hacs-identity live under
# /mnt/.../Bastion-3012. Keying off $HOME would scatter his mirror state into
# /root and — the part that actually matters — would put the permissions-only
# marker somewhere other than beside the instance it is meant to protect.
INSTANCE_DIR="$(cd "$(dirname "$IDENTITY")" && pwd)"

# ---- find my live transcript --------------------------------------------------
# Skipped entirely in permissions mode. Not "found and then ignored" — never
# located, never opened, never handed to the server. The privacy guarantee should
# be visible here too, not only in the code that would have read it.
TRANSCRIPT=""
if [[ $PERMS_ONLY -eq 0 ]]; then
  # The project slug is the session's cwd with every non-alphanumeric char
  # replaced by '-'. For a chassis instance the instance directory IS the cwd,
  # which is what keeps the slug stable across teleports — and it stays correct
  # for a detached home, where $HOME would have pointed somewhere else entirely.
  SLUG=$(echo "$INSTANCE_DIR" | sed 's/[^a-zA-Z0-9]/-/g')
  PROJ="$INSTANCE_DIR/.claude/projects/$SLUG"
  [[ -d "$PROJ" ]] || die "no project dir at $PROJ"

  # Newest .jsonl = the live session. Never cache a session id: teleports and
  # forks can re-point it, so resolve it fresh at start.
  TRANSCRIPT=$(ls -t "$PROJ"/*.jsonl 2>/dev/null | head -1)
  [[ -n "$TRANSCRIPT" ]] || die "no transcript found in $PROJ"

  # …but say so when the choice is AMBIGUOUS.
  #
  # `ls -t | head -1` is a heuristic wearing the costume of an answer. It is
  # right whenever exactly one session is live, and silently wrong when two are:
  # a second `claude` started by hand in the same project directory produces a
  # second growing transcript, and this would mirror whichever touched disk most
  # recently — which can alternate between them minute to minute.
  #
  # Bastion is solving the sharper version of this for `--resume`, where picking
  # wrong means a mind waking up inside someone else's conversation. For a mirror
  # the cost is lower (wrong session published) but the ambiguity is identical,
  # so the least it can do is refuse to be quietly confident.
  RECENT=$(find "$PROJ" -maxdepth 1 -name '*.jsonl' -newermt '-10 minutes' 2>/dev/null | wc -l)
  if [[ "$RECENT" -gt 1 ]]; then
    echo "!! WARNING: $RECENT transcripts in this project were written in the last 10 minutes." >&2
    echo "!!          More than one session may be live. Mirroring the most recent:" >&2
    echo "!!            $TRANSCRIPT" >&2
    echo "!!          If that is the wrong one, set MIRROR_TRANSCRIPT explicitly." >&2
  fi
  AGE_S=$(( $(date +%s) - $(stat -c %Y "$TRANSCRIPT") ))
fi

# ---- pick a port --------------------------------------------------------------
# Convention: mirror port = channel port + 1000 (21003 -> 22003), so the mapping
# stays obvious and collisions stay unlikely.
if [[ -n "$CHANNEL_PORT" ]]; then
  PORT=${MIRROR_PORT:-$((CHANNEL_PORT + 1000))}
else
  PORT=${MIRROR_PORT:?set MIRROR_PORT — no channelPort in identity}
fi

# ---- bind to the tailnet, never to 0.0.0.0 ------------------------------------
# Binding to the tailscale interface means the public interface cannot answer at
# all. Falls back to loopback if tailscale isn't up — never to a wildcard.
TS_IP=$(tailscale ip -4 2>/dev/null | head -1 || true)
BIND=${MIRROR_BIND:-${TS_IP:-127.0.0.1}}
[[ "$BIND" == "0.0.0.0" ]] && die "refusing to bind 0.0.0.0 — that is the public internet"

export MIRROR_INSTANCE="$INSTANCE"
export MIRROR_DISPLAY="${MIRROR_DISPLAY:-${INSTANCE%%-*}}"
export MIRROR_TRANSCRIPT="$TRANSCRIPT"
export MIRROR_DATA_DIR="${MIRROR_DATA_DIR:-$INSTANCE_DIR/.claude-mirror}"
export MIRROR_PORT="$PORT"
export MIRROR_BIND="$BIND"
export MIRROR_BASE_PATH="${MIRROR_BASE_PATH:-/${INSTANCE%%-*}}"
export MIRROR_ROOM="${MIRROR_ROOM:-$INSTANCE}"

# ---- grants: each decided once, from the flags -------------------------------
# A write capability is granted ONLY by asking for it. Never by flag ordering,
# never inherited from the caller's environment.
ALLOW_SEND=$WITH_INPUT
ALLOW_INTERRUPT=$WITH_INTERRUPT
# Full mode keeps its historical default: interrupt available when there is a
# tmux session to interrupt. Permissions mode grants nothing it wasn't asked for.
if [[ $PERMS_ONLY -eq 0 && $WITH_INTERRUPT -eq 0 ]]; then ALLOW_INTERRUPT=1; fi

if [[ $PERMS_ONLY -eq 1 ]]; then
  export MIRROR_MODE=permissions
else
  export MIRROR_TRANSCRIPT="$TRANSCRIPT"
fi

# The channel URL is needed by BOTH the permission poll and the send path, which
# is exactly why "has a channel URL" must never imply "may write" — the server
# reads MIRROR_ALLOW_SEND, and only that.
if [[ $PERMS_ONLY -eq 1 || $ALLOW_SEND -eq 1 ]]; then
  [[ -n "$CHANNEL_PORT" ]] || die "this mode needs a channelPort in $IDENTITY"
  export MIRROR_CHANNEL_URL="http://127.0.0.1:${CHANNEL_PORT}"
  export MIRROR_STUB_IDENTITY="${MIRROR_STUB_IDENTITY:-lupo|Lupo}"
fi

export MIRROR_ALLOW_SEND="$ALLOW_SEND"
export MIRROR_ALLOW_INTERRUPT="$ALLOW_INTERRUPT"

if [[ $ALLOW_SEND -eq 1 ]]; then
  echo "!! input ENABLED — the browser can inject messages into your live session."
  echo "!! identity is a STUB (${MIRROR_STUB_IDENTITY%%|*}); it trusts the network boundary."
fi
if [[ $ALLOW_INTERRUPT -eq 1 && $PERMS_ONLY -eq 1 ]]; then
  echo "!! interrupt ENABLED — the browser can send ESC to your live session."
fi

cat <<EOF
instance   : $INSTANCE
mode       : $([[ $PERMS_ONLY -eq 1 ]] && echo "permissions-only — NOTHING about this session is published" || echo "full — this publishes your whole session")
transcript : ${TRANSCRIPT:-none (not read in permissions mode)}${AGE_S:+  (last written ${AGE_S}s ago)}
url        : http://${BIND}:${PORT}${MIRROR_BASE_PATH}
input      : $([[ ${MIRROR_ALLOW_SEND:-0} == 1 ]] && echo "on (channel $CHANNEL_PORT)" || echo "off")
interrupt  : $([[ $WITH_INTERRUPT -eq 1 ]] && echo "on" || { [[ $PERMS_ONLY -eq 1 ]] && echo "off (pass --with-interrupt to enable)" || echo "on (full mode default)"; })
EOF

exec node "$MIRROR_HOME/src/mirror-server.mjs"
