#!/usr/bin/env bash
# Detecting a channel that accepts messages and delivers none of them.
#
# 2026-08-23: Crossing's channel took three messages from three independent
# transports, answered {"ok":true} to every health probe, and delivered nothing.
# Its /health returns `ok: true` from a hardcoded literal, and a JSON-RPC
# notification has no reply, so no sender could possibly tell.
#
# The mirror is the only component that sees BOTH sides — it posts to the
# channel and tails the transcript the session writes — so it is the only thing
# that can derive the answer. It must never ASK anyone (Law 9.1).
#
# What would have to be true:
#   1. a healthy send that comes back out of the session is CONFIRMED
#   2. a send that never comes back is reported deaf, without asking anyone
#   3. the deaf verdict survives the sender's browser going away  (it's server state)
#   4. delivery arriving late CLEARS the verdict — no latching
#   5. the channel answering {"ok":true} does not suppress any of the above
set -u
DIR=$(mktemp -d)
PORT=22096
CHAN=22095
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then echo "  ok  $2"; pass=$((pass+1)); else echo "FAIL  $2"; fail=$((fail+1)); fi; }

# A channel that behaves EXACTLY like Crossing's did: 200, {"ok":true}, and the
# message goes nowhere. It never writes to the transcript.
cat > "$DIR/deafchan.mjs" <<'EOF'
import http from 'node:http';
http.createServer((req,res)=>{
  let b=''; req.on('data',d=>b+=d);
  req.on('end',()=>{ res.writeHead(200,{'Content-Type':'application/json'});
                     res.end('{"ok":true}'); });
}).listen(Number(process.env.CHAN_PORT),'127.0.0.1');
EOF

printf '%s\n' '{"type":"summary","summary":"test"}' > "$DIR/session.jsonl"
CHAN_PORT=$CHAN node "$DIR/deafchan.mjs" & CH=$!
sleep 0.6

# 2s instead of the production 90s, so the announcement path is genuinely
# EXERCISED rather than merely present. A threshold no test crosses is a
# threshold nobody knows is wired up.
MIRROR_INSTANCE=deaftest MIRROR_DISPLAY=Deaf \
MIRROR_TRANSCRIPT="$DIR/session.jsonl" MIRROR_DATA_DIR="$DIR/data" \
MIRROR_BIND=127.0.0.1 MIRROR_PORT=$PORT MIRROR_CHANNEL_URL="http://127.0.0.1:$CHAN" \
MIRROR_ALLOW_SEND=1 MIRROR_DEAF_AFTER_MS=2000 \
node "$SRC/src/mirror-server.mjs" > "$DIR/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV $CH 2>/dev/null; rm -rf "$DIR"' EXIT
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done

h(){ curl -s "http://127.0.0.1:$PORT/health" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const w=JSON.parse(s).write_path;
    process.stdout.write(JSON.stringify([w.unconfirmed,w.channel_appears_deaf,
      w.last_confirmed_delivery===null?"null":"set"]));});'; }

echo
echo "1. baseline: nothing sent, nothing outstanding"
ok "$([ "$(h)" = '[0,false,"null"]' ] && echo 1 || echo 0)" "clean start $(h)"

echo
echo "2. THE CROSSING CASE: channel says ok:true, message never arrives"
CODE=$(curl -s -o "$DIR/r1" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/send" \
  -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" \
  -d '{"text":"a message that will be silently dropped"}')
ok "$([ "$CODE" = "200" ] && grep -q '"ok":true' "$DIR/r1" && echo 1 || echo 0)" \
   "the channel reported success, as Crossing's did"
ok "$(h | grep -q '^\[1,' && echo 1 || echo 0)" "mirror is tracking 1 unconfirmed $(h)"
ok "$(curl -s "http://127.0.0.1:$PORT/health" | grep -q '"oldest_unconfirmed_s": 0' && echo 1 || echo 0)" \
   "oldest_unconfirmed_s is being computed, not cached"

echo
echo "2b. the verdict actually FLIPS — the announcement path, exercised"
for _ in $(seq 1 40); do h | grep -q ',true,' && break; sleep 0.25; done
ok "$(h | grep -q ',true,' && echo 1 || echo 0)" "channel_appears_deaf became true $(h)"
ok "$(grep -q 'NEVER seen arriving in the session' "$DIR/server.log" && echo 1 || echo 0)" \
   "warning logged, naming the channel's healthy report as not-evidence"

echo
echo "3. the text is on disk regardless of the lie"
ok "$(grep -qF 'a message that will be silently dropped' "$DIR/data/sent.jsonl" && echo 1 || echo 0)" \
   "journaled even though delivery never happened"

echo
echo "4. the verdict is SERVER state — it outlives any browser"
# No client has ever connected in this test. That is the point.
ok "$(curl -s "http://127.0.0.1:$PORT/health" | grep -q '"clients": 0' && echo 1 || echo 0)" \
   "zero clients connected, and the mirror still knows"

echo
echo "5. late delivery CLEARS it — the session finally writes the message out"
cat >> "$DIR/session.jsonl" <<'EOF'
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"a message that will be silently dropped"}]},"timestamp":"2026-08-23T23:59:00.000Z","uuid":"deaf-1","sessionId":"s"}
EOF
for _ in $(seq 1 40); do h | grep -q '^\[0,' && break; sleep 0.25; done
ok "$(h | grep -q '^\[0,' && echo 1 || echo 0)" "unconfirmed back to zero $(h)"
ok "$(h | grep -q 'set' && echo 1 || echo 0)" "last_confirmed_delivery recorded"
ok "$(grep -q 'delivery CONFIRMED' "$DIR/server.log" && echo 1 || echo 0)" "confirmation logged"
ok "$(h | grep -q ',false,' && echo 1 || echo 0)" "deaf verdict CLEARED, not latched $(h)"
ok "$(grep -q 'channel is answering again' "$DIR/server.log" && echo 1 || echo 0)" "recovery logged"

echo
echo "6. confirmation is by CONTENT, not by counting"
curl -s -o /dev/null -X POST "http://127.0.0.1:$PORT/send" \
  -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" \
  -d '{"text":"first distinct message"}'
curl -s -o /dev/null -X POST "http://127.0.0.1:$PORT/send" \
  -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" \
  -d '{"text":"second distinct message"}'
ok "$(h | grep -q '^\[2,' && echo 1 || echo 0)" "two outstanding $(h)"
cat >> "$DIR/session.jsonl" <<'EOF'
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"second distinct message"}]},"timestamp":"2026-08-23T23:59:30.000Z","uuid":"deaf-2","sessionId":"s"}
EOF
for _ in $(seq 1 40); do h | grep -q '^\[1,' && break; sleep 0.25; done
ok "$(h | grep -q '^\[1,' && echo 1 || echo 0)" \
   "only the message that ACTUALLY arrived was cleared $(h)"

echo
echo "7. a BUSY session is not a deaf one (Crossing: enqueue->surface = 45s)"
# An inbound message surfaces at a TURN BOUNDARY. A session grinding through a
# long turn has legitimately not surfaced it yet. Announcing deafness there is a
# false alarm during exactly the long turns a human is most likely to send into.
kill $SRV 2>/dev/null; sleep 0.5
rm -rf "$DIR/data5"; printf '%s\n' '{"type":"summary","summary":"t"}' > "$DIR/busy.jsonl"
MIRROR_INSTANCE=busytest MIRROR_TRANSCRIPT="$DIR/busy.jsonl" MIRROR_DATA_DIR="$DIR/data5" \
MIRROR_BIND=127.0.0.1 MIRROR_PORT=$PORT MIRROR_CHANNEL_URL="http://127.0.0.1:$CHAN" \
MIRROR_ALLOW_SEND=1 MIRROR_DEAF_AFTER_MS=2000 \
node "$SRC/src/mirror-server.mjs" > "$DIR/server5.log" 2>&1 &
SRV=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -s -o /dev/null -X POST "http://127.0.0.1:$PORT/send" \
  -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" \
  -d '{"text":"queued behind a long turn"}'
# Keep the transcript moving for well past the deaf threshold, WITHOUT ever
# writing the sent message. This is a busy session, not a deaf channel.
for i in 1 2 3 4 5 6; do
  cat >> "$DIR/busy.jsonl" <<EOJ
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"still working, step $i"}]},"timestamp":"2026-08-24T03:00:0$i.000Z","uuid":"busy-$i","sessionId":"s"}
EOJ
  sleep 0.7
done
BUSY=$(h)
ok "$(echo "$BUSY" | grep -q ',false,' && echo 1 || echo 0)" "busy session NOT declared deaf $BUSY"
ok "$(echo "$BUSY" | grep -q '^\[1,' && echo 1 || echo 0)" "and the message is still tracked as unconfirmed"
ok "$(grep -q 'NEVER seen arriving' "$DIR/server5.log" && echo 0 || echo 1)" "no false alarm logged"

echo
echo "7b. once it goes QUIET, deafness is announced"
sleep 3
QUIET=$(h)
ok "$(echo "$QUIET" | grep -q ',true,' && echo 1 || echo 0)" "silent session IS declared deaf $QUIET"

echo
echo "passed=$pass failed=$fail"
[ "$fail" = "0" ]
