#!/usr/bin/env bash
# Stop this instance's mirror, safely.
#
# WHY THIS EXISTS: the obvious incantation is wrong, and it is wrong in a way
# that looks like it worked.
#
#     pkill -f 'mirror-server.mjs'     # <-- DO NOT
#
# `pkill -f` matches against the FULL COMMAND LINE of every process, and the
# shell running that very command has "mirror-server.mjs" in its own command
# line. So it matches itself. Run it from a restart script and the script dies
# halfway through — mirror stopped, never restarted, and the terminal that would
# have told you is gone too.
#
# Two of us hit this independently within a day (Cairn killed his own shell
# mid-cleanup; Axiom's restart script killed itself and took her mirror dark for
# a minute). When two people find the same trap by falling into it, the fix is a
# tool, not a warning.
#
# It also refuses to touch other instances' mirrors: they run as other users, so
# it filters by uid as well as by executable.
#
# Cairn-2001

set -uo pipefail

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

# Match the EXECUTABLE (node) and then read each candidate's real command line
# from /proc. Never a pattern match against our own argv.
mirror_pids() {
  local p
  for p in $(pgrep -u "$(id -u)" -x node 2>/dev/null); do
    [[ "$p" == "$$" ]] && continue
    if tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q 'mirror-server\.mjs'; then
      echo "$p"
    fi
  done
}

PIDS=$(mirror_pids)
if [[ -z "$PIDS" ]]; then
  echo "no mirror running for $(id -un)"
  exit 0
fi

for p in $PIDS; do
  echo "stopping $p"
  kill "$p" 2>/dev/null
done

# Give the graceful path a chance. A mirror ends its SSE streams first and then
# exits, with a 3s internal backstop — so 6s is generous, not hopeful.
for _ in $(seq 1 24); do
  [[ -z "$(mirror_pids)" ]] && break
  sleep 0.25
done

LEFT=$(mirror_pids)
if [[ -n "$LEFT" ]]; then
  if [[ $FORCE -eq 1 ]]; then
    for p in $LEFT; do echo "forcing $p"; kill -9 "$p" 2>/dev/null; done
  else
    echo "still running: $LEFT" >&2
    echo "A build older than commit 596503c hangs on SIGTERM while a browser is" >&2
    echo "attached — server.close() waits for streams that never end. That is" >&2
    echo "the one case where SIGKILL is correct: re-run with --force." >&2
    exit 1
  fi
fi

echo "stopped"
