#!/usr/bin/env bash
# Adversarial test of permissions-only mode.
#
# The claim being tested is a NEGATIVE one — "nothing about the session is
# published" — so the setup is deliberately hostile to it:
#
#   * the data dir already holds a full-mode event log with real session content
#   * the outbox already holds a file
#   * a transcript exists on disk and MIRROR_TRANSCRIPT is even set
#
# If any route hands back a byte of that, the mode is a lie.
set -u
DIR=$(mktemp -d)
PORT=22097
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then echo "  ok  $2"; pass=$((pass+1)); else echo "FAIL  $2"; fail=$((fail+1)); fi; }

mkdir -p "$DIR/data/blobs" "$DIR/data/outbox" "$DIR/data/inbox"
printf '%s\n' '{"type":"summary","summary":"x"}' > "$DIR/session.jsonl"

# Pre-existing full-mode history containing a secret, as if this mirror had run
# in full mode yesterday. This is the trap the mode has to survive.
cat > "$DIR/data/permtest.jsonl" <<'EOF'
{"ts":"2026-08-18T10:00:00.000Z","type":"text","from":{"id":"i","kind":"instance","display":"P"},"body":{"text":"CLASSIFIED-PROSE"},"seq":1,"epoch":1,"instance":"permtest"}
{"ts":"2026-08-18T10:00:01.000Z","type":"tool_use","from":{"id":"i","kind":"instance","display":"P"},"body":{"tool":"Bash","input":{"command":"cat /etc/shadow"},"tool_use_id":"t1"},"seq":2,"epoch":1,"instance":"permtest"}
{"ts":"2026-08-18T10:00:02.000Z","type":"permissions","from":{"id":"system","kind":"system","display":"permissions"},"body":{"pending":[{"request_id":"STALE-1","tool_name":"Bash","input_preview":"rm -rf /"}]},"seq":3,"epoch":1,"instance":"permtest"}
EOF
echo "CLASSIFIED-BLOB" > "$DIR/data/blobs/1-2-output.txt"
echo "CLASSIFIED-FILE" > "$DIR/data/outbox/report.txt"

# Fake channel server: answers /pending-permissions so the panel has something.
cat > "$DIR/chan.mjs" <<'EOF'
import http from 'node:http';
http.createServer((req,res)=>{
  if (req.url === '/pending-permissions'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify({pending:[{request_id:'REQ-9',tool_name:'Bash',
      description:'restart nginx',input_preview:'systemctl restart nginx',
      received_at:new Date(0).toISOString()}]}));
    return;
  }
  res.writeHead(404).end('{}');
}).listen(21999,'127.0.0.1');
EOF
node "$DIR/chan.mjs" & CHAN=$!

# NOTE: MIRROR_TRANSCRIPT is deliberately SET. The mode must ignore it.
MIRROR_INSTANCE=permtest MIRROR_MODE=permissions \
MIRROR_TRANSCRIPT="$DIR/session.jsonl" MIRROR_DATA_DIR="$DIR/data" \
MIRROR_CHANNEL_URL=http://127.0.0.1:21999 \
MIRROR_BIND=127.0.0.1 MIRROR_PORT=$PORT \
node "$SRC/src/mirror-server.mjs" > "$DIR/log" 2>&1 &
SRV=$!
trap 'kill $SRV $CHAN 2>/dev/null; rm -rf "$DIR"' EXIT

for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "never came up"; cat "$DIR/log"; exit 1; }

echo
echo "1. it says what it is"
H=$(curl -s "http://127.0.0.1:$PORT/health")
ok "$(echo "$H" | grep -q '"mode": "permissions"' && echo 1 || echo 0)" "health reports mode=permissions"
ok "$(echo "$H" | grep -q '"publishes_session": false' && echo 1 || echo 0)" "health reports publishes_session=false"
ok "$(echo "$H" | grep -q '"send": false' && echo 1 || echo 0)" "send is off even though a channel URL is configured"

echo
echo "2. the transcript is never read"
ok "$(grep -q 'no transcript is read' "$DIR/log" && echo 1 || echo 0)" "startup states it is not reading the transcript"
ok "$(grep -qi 'tailing' "$DIR/log" && echo 0 || echo 1)" "never logged 'tailing'"

echo
echo "3. no route hands back the pre-existing history"
for path in "/history?before=99" "/blob/1-2-output.txt" "/file/outbox/report.txt" "/file/inbox/x"; do
  BODY=$(curl -s "http://127.0.0.1:$PORT$path")
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$path")
  CLEAN=1
  echo "$BODY" | grep -q 'CLASSIFIED' && CLEAN=0
  ok "$([ "$CLEAN" = "1" ] && [ "$CODE" = "404" ] && echo 1 || echo 0)" "$path -> $CODE, no session content"
done
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/upload" -H 'X-Filename: a.txt' --data-binary 'x')
ok "$([ "$CODE" = "404" ] && echo 1 || echo 0)" "POST /upload -> $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/send" -H 'Content-Type: application/json' --data '{"text":"hi"}')
ok "$([ "$CODE" = "403" ] && echo 1 || echo 0)" "POST /send -> $CODE (refused, not silently accepted)"

echo
echo "4. the SSE stream replays nothing, but does carry permissions"
curl -sN --max-time 6 "http://127.0.0.1:$PORT/events" > "$DIR/sse" &
sleep 5
ok "$(grep -q 'CLASSIFIED-PROSE' "$DIR/sse" && echo 0 || echo 1)" "no prose from the old log reached the stream"
ok "$(grep -q 'etc/shadow' "$DIR/sse" && echo 0 || echo 1)" "no tool input from the old log reached the stream"
ok "$(grep -q 'STALE-1' "$DIR/sse" && echo 0 || echo 1)" "the STALE permission snapshot was not replayed"
ok "$(grep -q 'REQ-9' "$DIR/sse" && echo 1 || echo 0)" "the LIVE permission request did arrive"
ok "$(grep -q '"ephemeral":true' "$DIR/sse" && echo 1 || echo 0)" "it arrived marked ephemeral"
ok "$(grep -q '^id:' "$DIR/sse" && echo 0 || echo 1)" "no id: frame — cannot advance a client's resume point"

echo
echo "5. the page tells the truth from the first paint"
P=$(curl -s "http://127.0.0.1:$PORT/")
ok "$(echo "$P" | grep -q "const MODE = 'permissions'" && echo 1 || echo 0)" "mode injected into the page"
ok "$(echo "$P" | grep -q '__MIRROR_MODE__' && echo 0 || echo 1)" "no unreplaced placeholder left behind"

echo
echo "6. the log file itself stays clean"
ok "$([ "$(wc -l < "$DIR/data/permtest.jsonl")" = "3" ] && echo 1 || echo 0)" "nothing new was appended to the event log"

echo
echo "7. read and write are orthogonal (F1, as Bastion corrected it)"
# The combination is LEGITIMATE — don't publish my session, but let me talk to
# you — and is what a root session wants. What must never happen is a write
# grant arriving by flag ORDERING rather than by being asked for.
TD2=$(mktemp -d); printf '{"instanceId":"Flag-0000","channelPort":21999}' > "$TD2/.hacs-identity"
run_flags(){ HOME=/tmp HACS_IDENTITY_FILE="$TD2/.hacs-identity" MIRROR_PORT=22094 \
  timeout 2 bash "$SRC/bin/mirror-start.sh" "$@" 2>&1 | head -12; }
A=$(run_flags --permissions-only)
B=$(run_flags --permissions-only --with-input)
C=$(run_flags --permissions-only --with-input --with-interrupt)
ok "$(echo "$A" | grep -q 'input      : off' && echo 1 || echo 0)" "--permissions-only alone: input off"
ok "$(echo "$B" | grep -q 'input      : on' && echo 1 || echo 0)" "--permissions-only --with-input: input ON (allowed, not refused)"
ok "$(echo "$B" | grep -q 'NOTHING about this session is published' && echo 1 || echo 0)" "...and still publishes nothing"
ok "$(echo "$B" | grep -q 'interrupt  : off' && echo 1 || echo 0)" "...and does NOT also grant interrupt"
ok "$(echo "$C" | grep -q 'interrupt  : on' && echo 1 || echo 0)" "interrupt only when asked for explicitly"
# The original footgun: a stray env var must not become a grant.
D=$(MIRROR_ALLOW_SEND=1 run_flags --permissions-only)
ok "$(echo "$D" | grep -q 'input      : off' && echo 1 || echo 0)" "an inherited MIRROR_ALLOW_SEND=1 does NOT grant send"
rm -rf "$TD2"

echo
echo "8. /health leaks a count, never the list (F2)"
ok "$(echo "$H" | grep -q '"pending_permissions_count"' && echo 1 || echo 0)" "health reports pending_permissions_count"
ok "$(echo "$H" | grep -q '"pending_permissions"' && echo 0 || echo 1)" "health does NOT contain the pending list"
ok "$(echo "$H" | grep -q 'systemctl restart nginx' && echo 0 || echo 1)" "the literal command is absent from /health"
ok "$(echo "$H" | grep -q 'REQ-9' && echo 0 || echo 1)" "the request_id is absent from /health"
ok "$(grep -q 'systemctl restart nginx' "$DIR/sse" && echo 1 || echo 0)" "but the panel still gets it over /events"

echo
echo "9. a NEWLY attached viewer is handed current state (F2 follow-on)"
curl -sN --max-time 3 "http://127.0.0.1:$PORT/events" > "$DIR/sse2"
ok "$(grep -q 'REQ-9' "$DIR/sse2" && echo 1 || echo 0)" "fresh connection receives the pending request immediately"
ok "$(grep -q '^id:' "$DIR/sse2" && echo 0 || echo 1)" "still with no id: frame"

echo
echo "10. interrupt needs its own grant (F3)"
ok "$(echo "$H" | grep -q '"interrupt": false' && echo 1 || echo 0)" "health reports interrupt disabled in permissions mode"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/interrupt" -H 'Content-Type: application/json' --data '{}')
ok "$([ "$CODE" = "403" ] && echo 1 || echo 0)" "POST /interrupt -> $CODE (refused, not console access to root)"

echo
echo "11. the mode is sticky in the data dir (F4)"
ok "$([ -f "$DIR/data/.permissions-only" ] && echo 1 || echo 0)" "marker written on first permissions start"
FULLOUT=$(MIRROR_INSTANCE=permtest MIRROR_TRANSCRIPT="$DIR/session.jsonl"   MIRROR_DATA_DIR="$DIR/data" MIRROR_BIND=127.0.0.1 MIRROR_PORT=22096   node "$SRC/src/mirror-server.mjs" 2>&1)
FRC=$?
ok "$([ "$FRC" != "0" ] && echo 1 || echo 0)" "a FULL-mode start against that dir refuses to boot ($FRC)"
ok "$(echo "$FULLOUT" | grep -qi 'refusing to start' && echo 1 || echo 0)" "and says so loudly"
ok "$(echo "$FULLOUT" | grep -q 'rm ' && echo 1 || echo 0)" "and states how to clear it deliberately"

echo
echo "passed=$pass failed=$fail"
[ "$fail" = "0" ] || { echo; echo "--- log ---"; cat "$DIR/log"; }
exit $([ "$fail" = "0" ] && echo 0 || echo 1)
