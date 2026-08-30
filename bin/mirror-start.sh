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
#   ./bin/mirror-start.sh --with-commands   # allow /context, /compact ... from the browser
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
WITH_COMMANDS=0
WITH_UPLOADS=-1   # -1 = follow --with-input; 0/1 = explicit
for arg in "$@"; do
  case "$arg" in
    --with-input)       WITH_INPUT=1 ;;
    --permissions-only) PERMS_ONLY=1 ;;
    --with-interrupt)   WITH_INTERRUPT=1 ;;
    --with-commands)    WITH_COMMANDS=1 ;;
    --with-uploads)     WITH_UPLOADS=1 ;;
    --no-uploads)       WITH_UPLOADS=0 ;;
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
INSTANCE=$(python3 -c "import json,io;print(json.load(io.open('$IDENTITY',encoding='utf-8-sig'))['instanceId'])")
# encoding='utf-8-sig' because PowerShell 5.1's `-Encoding utf8` writes a UTF-8
# BOM (verified ef bb bf by Lodestone on lupos-lap), and python's json.load then
# fails with "Expecting value: line 1 column 1 (char 0)" — which reads as a
# CORRUPT FILE rather than an encoding problem, and sends you looking in the
# wrong place. Harmless on files without a BOM.
CHANNEL_PORT=$(python3 -c "import json,io;print(json.load(io.open('$IDENTITY',encoding='utf-8-sig')).get('channelPort',''))")
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
  # DO NOT add a platform branch here. Verified by Lodestone-8ec9 on Windows:
  # this collapses BOTH "D:\Lupo\source\AI\x" and "D:/Lupo/source/AI/x" to
  # "D--Lupo-source-AI-x", byte-identical to the slug Claude Code itself writes
  # there. It looks POSIX-flavoured and is already correct on both platforms;
  # "fixing" it would break Windows.
  SLUG=$(echo "$INSTANCE_DIR" | sed 's/[^a-zA-Z0-9]/-/g')
  PROJ="$INSTANCE_DIR/.claude/projects/$SLUG"
  [[ -d "$PROJ" ]] || die "no project dir at $PROJ"

  # ---- which transcript? A TRUST LADDER, not a guess ---------------------------
  #
  # 1. CLAUDE_CODE_SESSION_ID from our own environment. Authoritative: it is the
  #    session's own name for itself, and it survives --resume. Present whenever
  #    this script is run BY the session it mirrors — which is the normal case,
  #    since an instance starts its own mirror from its own shell.
  #
  #    Note it canNOT be read from outside: Claude Code injects it into the
  #    environment given to CHILD processes, so /proc/<pid>/environ of a running
  #    `claude` does not contain it. Bastion tested that before either of us
  #    could build on it.
  #
  # 2. A recorded id, for starts from outside any session (a systemd unit at
  #    boot). Written by layer 1 below, so an instance that has ever started its
  #    own mirror leaves the answer behind for the machine.
  #
  # 3. Newest .jsonl by mtime. A heuristic wearing the costume of an answer:
  #    correct whenever exactly one session is live, silently wrong when two are.
  #    Kept as the last resort, and it says so.
  SESSION_ID_FILE="$INSTANCE_DIR/.claude-session-id"
  SID=""; SID_SRC=""
  if [[ -n "${CLAUDE_CODE_SESSION_ID:-}" ]]; then
    SID="$CLAUDE_CODE_SESSION_ID"; SID_SRC="session environment (authoritative)"
    # Leave it for the machine. A unit at boot has no session to ask.
    printf '%s\n' "$SID" > "$SESSION_ID_FILE" 2>/dev/null || true
  elif [[ -r "$SESSION_ID_FILE" ]]; then
    SID="$(head -1 "$SESSION_ID_FILE" | tr -d '[:space:]')"; SID_SRC="recorded id"
  fi

  if [[ -n "$SID" ]]; then
    TRANSCRIPT="$PROJ/$SID.jsonl"
    # A named session whose transcript is missing is an ERROR, never a reason to
    # quietly fall back to guessing — that is how you mirror the wrong mind.
    [[ -f "$TRANSCRIPT" ]] || die "session id $SID names no transcript at $TRANSCRIPT
       (from $SID_SRC). Refusing to guess — set MIRROR_TRANSCRIPT if you know better."
  else
    SID_SRC="newest by mtime (GUESS — no session id available)"
    TRANSCRIPT=$(ls -t "$PROJ"/*.jsonl 2>/dev/null | head -1)
    [[ -n "$TRANSCRIPT" ]] || die "no transcript found in $PROJ"
  fi

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
  # Still worth saying even when we HAVE an authoritative answer: a positive
  # signal does not make the negative detection worthless, it makes it the check
  # on the positive signal, which is where it belongs.
  RECENT=$(find "$PROJ" -maxdepth 1 -name '*.jsonl' -newermt '-10 minutes' 2>/dev/null | wc -l)
  if [[ "$RECENT" -gt 1 ]]; then
    echo "!! NOTE: $RECENT transcripts here were written in the last 10 minutes —" >&2
    echo "!!       more than one session may be live." >&2
    echo "!!       Mirroring: $TRANSCRIPT" >&2
    echo "!!       chosen by: $SID_SRC" >&2
    [[ "$SID_SRC" == newest* ]] && echo "!!       That is a GUESS. Set MIRROR_TRANSCRIPT to be certain." >&2
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
# Slash commands type into the pane. Own grant, off unless asked for, in every
# mode — never inherited from --with-input or from the environment.
ALLOW_COMMANDS=$WITH_COMMANDS
# Uploads follow --with-input unless named explicitly. Putting a FILE into an
# instance is at least as much a write as putting TEXT into it, and this route
# was ungated entirely until 2026-08-24 — a read-only mirror accepted files.
if [[ $WITH_UPLOADS -eq -1 ]]; then ALLOW_UPLOAD=$WITH_INPUT; else ALLOW_UPLOAD=$WITH_UPLOADS; fi
# Interrupt is OFF unless asked for, in EVERY mode. It used to default ON in
# full mode, justified as "there is a tmux session to interrupt" — but
# MIRROR_TMUX_SESSION falls back to the instance id, so that premise was a NAME,
# never a verified session. Bastion found this exact shape in permissions mode
# ("enabled by merely knowing the tmux session name"); I fixed it there and left
# it standing here, eight lines below my own comment saying a capability is
# granted only by asking.
#
# Lodestone-8ec9 hit it porting to Windows, where there is no tmux at all: a
# write capability defaulting ON because of a component that does not exist. They
# diverged loudly rather than inheriting it, and were right to. Upstream now
# matches their port.

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
export MIRROR_ALLOW_COMMANDS="$ALLOW_COMMANDS"
export MIRROR_ALLOW_UPLOAD="$ALLOW_UPLOAD"

if [[ $ALLOW_SEND -eq 1 ]]; then
  echo "!! input ENABLED — the browser can inject messages into your live session."
  echo "!! identity is a STUB (${MIRROR_STUB_IDENTITY%%|*}); it trusts the network boundary."
fi
if [[ $ALLOW_INTERRUPT -eq 1 && $PERMS_ONLY -eq 1 ]]; then
  echo "!! interrupt ENABLED — the browser can send ESC to your live session."
fi
if [[ $ALLOW_UPLOAD -eq 1 ]]; then
  echo "!! uploads ENABLED — the browser can write files into your inbox/."
fi

cat <<EOF
instance   : $INSTANCE
mode       : $([[ $PERMS_ONLY -eq 1 ]] && echo "permissions-only — NOTHING about this session is published" || echo "full — this publishes your whole session")
transcript : ${TRANSCRIPT:-none (not read in permissions mode)}${AGE_S:+  (last written ${AGE_S}s ago)}${SID_SRC:+
  chosen by: $SID_SRC}
url        : http://${BIND}:${PORT}${MIRROR_BASE_PATH}
input      : $([[ ${MIRROR_ALLOW_SEND:-0} == 1 ]] && echo "on (channel $CHANNEL_PORT)" || echo "off")
interrupt  : $([[ $ALLOW_INTERRUPT -eq 1 ]] && echo "on" || echo "off (pass --with-interrupt to enable)")
commands   : $([[ $ALLOW_COMMANDS -eq 1 ]] && echo "on (allowlisted only)" || echo "off (pass --with-commands to enable)")
EOF

exec node "$MIRROR_HOME/src/mirror-server.mjs"
