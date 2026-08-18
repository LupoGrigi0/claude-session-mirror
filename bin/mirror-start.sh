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

# REFUSE the contradictory combination rather than resolving it.
#
# Found by Bastion reviewing this as an adversary: the arg loop accepted both,
# and the --with-input export ran afterwards and unconditionally, so
# `--permissions-only --with-input` produced permissions mode WITH message
# injection into a root session — the exact outcome the decoupling exists to
# prevent. The guard was real; the arg parser walked around it.
#
# An operator who typed both flags does not have a coherent request, so this
# does not pick a winner. It stops.
if [[ $PERMS_ONLY -eq 1 && $WITH_INPUT -eq 1 ]]; then
  echo "error: --permissions-only and --with-input contradict each other." >&2
  echo "       --permissions-only publishes nothing and accepts no messages;" >&2
  echo "       --with-input injects into your live session. Pick one." >&2
  exit 1
fi

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

if [[ $PERMS_ONLY -eq 1 ]]; then
  [[ -n "$CHANNEL_PORT" ]] || die "--permissions-only needs a channelPort in $IDENTITY"
  export MIRROR_MODE=permissions
  export MIRROR_CHANNEL_URL="http://127.0.0.1:${CHANNEL_PORT}"
  export MIRROR_STUB_IDENTITY="${MIRROR_STUB_IDENTITY:-lupo|Lupo}"
  # SET, never defaulted from the environment. `${MIRROR_ALLOW_SEND:-0}` would
  # inherit a value an operator happened to export in their shell, so "defaults
  # off in this mode" would only be true when unset. It is now unconditional.
  export MIRROR_ALLOW_SEND=0
else
  export MIRROR_TRANSCRIPT="$TRANSCRIPT"
fi

if [[ $WITH_INPUT -eq 1 ]]; then
  [[ -n "$CHANNEL_PORT" ]] || die "--with-input needs a channelPort in $IDENTITY"
  export MIRROR_CHANNEL_URL="http://127.0.0.1:${CHANNEL_PORT}"
  export MIRROR_STUB_IDENTITY="${MIRROR_STUB_IDENTITY:-lupo|Lupo}"
  export MIRROR_ALLOW_SEND=1
  echo "!! input ENABLED — the browser can inject messages into your live session."
  echo "!! identity is a STUB (${MIRROR_STUB_IDENTITY%%|*}); it trusts the network boundary."
fi

# Interrupt is a WRITE into a live session — console access, one fixed keystroke.
# It used to be enabled by merely knowing the tmux session name, which meant
# permissions mode refused message injection while still offering ESC to a root
# session. Both are writes; both now need a grant. Explicit opt-in here.
if [[ $WITH_INTERRUPT -eq 1 ]]; then
  export MIRROR_ALLOW_INTERRUPT=1
  echo "!! interrupt ENABLED — the browser can send ESC to your live session."
elif [[ $PERMS_ONLY -eq 1 ]]; then
  export MIRROR_ALLOW_INTERRUPT=0
fi

cat <<EOF
instance   : $INSTANCE
mode       : $([[ $PERMS_ONLY -eq 1 ]] && echo "permissions-only — NOTHING about this session is published" || echo "full — this publishes your whole session")
transcript : ${TRANSCRIPT:-none (not read in permissions mode)}
url        : http://${BIND}:${PORT}${MIRROR_BASE_PATH}
input      : $([[ ${MIRROR_ALLOW_SEND:-0} == 1 ]] && echo "on (channel $CHANNEL_PORT)" || echo "off")
interrupt  : $([[ $WITH_INTERRUPT -eq 1 ]] && echo "on" || { [[ $PERMS_ONLY -eq 1 ]] && echo "off (pass --with-interrupt to enable)" || echo "on (full mode default)"; })
EOF

exec node "$MIRROR_HOME/src/mirror-server.mjs"
