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
for arg in "$@"; do
  case "$arg" in
    --with-input)       WITH_INPUT=1 ;;
    --permissions-only) PERMS_ONLY=1 ;;
    *) echo "error: unknown option $arg" >&2; exit 1 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }

# ---- who am I -----------------------------------------------------------------
[[ -f "$IDENTITY" ]] || die "no $IDENTITY — this script must run as an instance user"
INSTANCE=$(python3 -c "import json;print(json.load(open('$IDENTITY'))['instanceId'])")
CHANNEL_PORT=$(python3 -c "import json;print(json.load(open('$IDENTITY')).get('channelPort',''))")
[[ -n "$INSTANCE" ]] || die "could not read instanceId from $IDENTITY"

# ---- find my live transcript --------------------------------------------------
# Skipped entirely in permissions mode. Not "found and then ignored" — never
# located, never opened, never handed to the server. The privacy guarantee should
# be visible here too, not only in the code that would have read it.
TRANSCRIPT=""
if [[ $PERMS_ONLY -eq 0 ]]; then
  # The project slug is the cwd with every non-alphanumeric char replaced by '-'.
  # For chassis instances HOME *is* the cwd, which is what keeps the slug stable
  # across teleports.
  SLUG=$(echo "$HOME" | sed 's/[^a-zA-Z0-9]/-/g')
  PROJ="$HOME/.claude/projects/$SLUG"
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
export MIRROR_DATA_DIR="${MIRROR_DATA_DIR:-$HOME/.claude-mirror}"
export MIRROR_PORT="$PORT"
export MIRROR_BIND="$BIND"
export MIRROR_BASE_PATH="${MIRROR_BASE_PATH:-/${INSTANCE%%-*}}"
export MIRROR_ROOM="${MIRROR_ROOM:-$INSTANCE}"

if [[ $PERMS_ONLY -eq 1 ]]; then
  [[ -n "$CHANNEL_PORT" ]] || die "--permissions-only needs a channelPort in $IDENTITY"
  export MIRROR_MODE=permissions
  export MIRROR_CHANNEL_URL="http://127.0.0.1:${CHANNEL_PORT}"
  export MIRROR_STUB_IDENTITY="${MIRROR_STUB_IDENTITY:-lupo|Lupo}"
  # Approvals need the channel URL; that must not also grant message injection.
  # Explicit here so the default is visible rather than inferred.
  export MIRROR_ALLOW_SEND="${MIRROR_ALLOW_SEND:-0}"
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

cat <<EOF
instance   : $INSTANCE
mode       : $([[ $PERMS_ONLY -eq 1 ]] && echo "permissions-only — NOTHING about this session is published" || echo "full — this publishes your whole session")
transcript : ${TRANSCRIPT:-none (not read in permissions mode)}
url        : http://${BIND}:${PORT}${MIRROR_BASE_PATH}
input      : $([[ ${MIRROR_ALLOW_SEND:-0} == 1 ]] && echo "on (channel $CHANNEL_PORT)" || echo "off")
EOF

exec node "$MIRROR_HOME/src/mirror-server.mjs"
