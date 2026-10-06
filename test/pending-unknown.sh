#!/usr/bin/env bash
# "An empty pending-list must mean UNKNOWN, not OK."  — Bastion-3012, 2026-10-05
#
# The claim under test is that /health can DISTINGUISH these four states, which
# were previously byte-identical (`pending_permissions_count: 0`):
#
#   A. there are genuinely no pending requests          -> known, 0
#   B. the last poll FAILED                             -> stale, not OK
#   C. no poll has EVER succeeded                       -> unknown
#   D. no channel URL is configured, so nothing is EVER polled  -> unknown
#
# D is the purest false green in the component: a mirror that has never once
# looked, reporting "0 pending" cheerfully, forever.
#
# WHAT THIS COST IN REALITY. Bastion spawned three digest agents at 02:50; one
# blocked on a permission approval and sat ~21 HOURS. He reported it "still
# waiting" four times without reading its pane. The agent could not say it was
# stuck, Lupo could not see it was asking, and the only actor who could approve it
# was the one calling it slow. His framing, which is the part that matters:
# strip his inattention out and the path is still there.
#
# THE DECISIVE ASSERTION is section 5: A and D must be DISTINGUISHABLE. Every
# other check here could pass while the bug survives.
set -u
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then echo "  ok  $2"; pass=$((pass+1)); else echo "FAIL  $2"; fail=$((fail+1)); fi; }

DIR=$(mktemp -d)
trap 'pkill -P $$ 2>/dev/null; rm -rf "$DIR"' EXIT
printf '%s\n' '{"type":"summary","summary":"x"}' > "$DIR/session.jsonl"
mkdir -p "$DIR/dataA" "$DIR/dataD" "$DIR/dataE" "$DIR/dataF"

# A fake channel whose behaviour is chosen by the file MODE contains.
cat > "$DIR/chan.mjs" <<'EOF'
import http from 'node:http'; import fs from 'node:fs';
const modeFile = process.argv[2];
http.createServer((req,res)=>{
  if (req.url !== '/pending-permissions') { res.writeHead(404).end('{}'); return; }
  const m = fs.readFileSync(modeFile,'utf8').trim();
  if (m === 'boom') { res.writeHead(500).end('{}'); return; }
  const pending = m === 'one'
    ? [{request_id:'REQ-1',tool_name:'Bash',input_preview:'systemctl restart nginx'}]
    : [];
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({pending}));
}).listen(Number(process.argv[3]),'127.0.0.1');
EOF

boot(){ # boot <port> <datadir> [channelUrl]
  local port=$1 data=$2 chan=${3:-}
  if [ -n "$chan" ]; then
    MIRROR_INSTANCE=pendtest MIRROR_TRANSCRIPT="$DIR/session.jsonl" MIRROR_DATA_DIR="$data" \
    MIRROR_CHANNEL_URL="$chan" MIRROR_BIND=127.0.0.1 MIRROR_PORT=$port \
    node "$SRC/src/mirror-server.mjs" > "$DIR/log.$port" 2>&1 &
  else
    MIRROR_INSTANCE=pendtest MIRROR_TRANSCRIPT="$DIR/session.jsonl" MIRROR_DATA_DIR="$data" \
    MIRROR_BIND=127.0.0.1 MIRROR_PORT=$port \
    node "$SRC/src/mirror-server.mjs" > "$DIR/log.$port" 2>&1 &
  fi
  for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1 && return 0; sleep 0.25; done
  echo "FAIL  server on $port never came up"; cat "$DIR/log.$port"; return 1
}
field(){ python3 -c "import json,sys;d=json.load(sys.stdin);k='$1';print(json.dumps(d.get(k)) if k in d else '<MISSING>')"; }

echo
echo "1. CONTROL: the fields exist at all (a missing field would pass every check below by accident)"
echo ok > "$DIR/mode"; node "$DIR/chan.mjs" "$DIR/mode" 21991 & sleep 0.6
boot 22091 "$DIR/dataA" http://127.0.0.1:21991 || exit 1
sleep 2.5
HA=$(curl -s http://127.0.0.1:22091/health)
for f in pending_permissions_known pending_poll_ok pending_poll_error pending_permissions_scope pending_subagents_enumerated; do
  ok "$([ "$(echo "$HA" | field $f)" != "<MISSING>" ] && echo 1 || echo 0)" "/health carries $f"
done

echo
echo "2. A — channel reachable, list genuinely empty: the ONLY case where 0 means OK"
ok "$([ "$(echo "$HA" | field pending_permissions_known)" = "true" ] && echo 1 || echo 0)" "known=true after a successful poll"
ok "$([ "$(echo "$HA" | field pending_permissions_count)" = "0" ] && echo 1 || echo 0)" "count=0"
ok "$([ "$(echo "$HA" | field pending_poll_error)" = "null" ] && echo 1 || echo 0)" "no poll error"

echo
echo "3. D — NO channel URL at all: never looked once, must NOT read as OK"
boot 22092 "$DIR/dataD" || exit 1
sleep 2.5
HD=$(curl -s http://127.0.0.1:22092/health)
ok "$([ "$(echo "$HD" | field pending_permissions_known)" = "false" ] && echo 1 || echo 0)" "known=false with no channel URL"
ok "$([ "$(echo "$HD" | field pending_permissions_count)" = "0" ] && echo 1 || echo 0)" "count is still 0 (which is why count alone cannot be trusted)"
ok "$(echo "$HD" | field pending_poll_error | grep -qi 'MIRROR_CHANNEL_URL' && echo 1 || echo 0)" "the error NAMES the missing config"

echo
echo "4. C/B — channel present but failing: HTTP 500, then unreachable"
echo boom > "$DIR/mode2"; node "$DIR/chan.mjs" "$DIR/mode2" 21992 & sleep 0.6
boot 22093 "$DIR/dataE" http://127.0.0.1:21992 || exit 1
sleep 2.5
HE=$(curl -s http://127.0.0.1:22093/health)
ok "$([ "$(echo "$HE" | field pending_permissions_known)" = "false" ] && echo 1 || echo 0)" "known=false when the channel 500s and never succeeded"
ok "$(echo "$HE" | field pending_poll_error | grep -q '500' && echo 1 || echo 0)" "the error carries the HTTP status"
boot 22094 "$DIR/dataF" http://127.0.0.1:21999 || exit 1   # nothing listening on 21999
sleep 2.5
HF=$(curl -s http://127.0.0.1:22094/health)
ok "$([ "$(echo "$HF" | field pending_permissions_known)" = "false" ] && echo 1 || echo 0)" "known=false when nothing is listening"
ok "$(echo "$HF" | field pending_poll_error | grep -qi 'unreachable' && echo 1 || echo 0)" "the error says unreachable"

echo
echo "5. ⭐ THE DECISIVE ONE: 'no requests' and 'never looked' must be DISTINGUISHABLE"
ok "$([ "$(echo "$HA" | field pending_permissions_count)" = "$(echo "$HD" | field pending_permissions_count)" ] && echo 1 || echo 0)" \
   "both report count=0 (confirming the OLD field cannot tell them apart)"
ok "$([ "$(echo "$HA" | field pending_permissions_known)" != "$(echo "$HD" | field pending_permissions_known)" ] && echo 1 || echo 0)" \
   "but pending_permissions_known DOES tell them apart"

echo
echo "6. SCOPE is stated, so a clean list is not silently misread as covering sub-agents"
ok "$([ "$(echo "$HA" | field pending_permissions_scope)" = '"session"' ] && echo 1 || echo 0)" "scope is declared 'session', not 'tree'"
ok "$([ "$(echo "$HA" | field pending_subagents_enumerated)" = "false" ] && echo 1 || echo 0)" "pending_subagents_enumerated=false — the omission is explicit, not silent"

echo
echo "7. a real request still shows up (the fix must not break the working path)"
echo one > "$DIR/mode"; sleep 3
H2=$(curl -s http://127.0.0.1:22091/health)
ok "$([ "$(echo "$H2" | field pending_permissions_count)" = "1" ] && echo 1 || echo 0)" "count rises to 1"
ok "$([ "$(echo "$H2" | field pending_permissions_known)" = "true" ] && echo 1 || echo 0)" "and it is still known=true"

echo
echo "passed=$pass failed=$fail"
exit $([ "$fail" = "0" ] && echo 0 || echo 1)
