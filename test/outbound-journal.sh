#!/usr/bin/env bash
# The last-resort copy of what a human typed.
#
# Written after 2026-08-23, when Lupo spent ten minutes composing a message to
# Crossing. The mirror accepted it (200), the channel accepted it (200), the
# mind never received it, and a page refresh destroyed the only remaining copy.
# Three components each assumed another was keeping the text. None were.
#
# What would have to be true for that to be impossible again:
#   1. an accepted send is on disk BEFORE the channel is called
#   2. it is still on disk when the channel REFUSES it   <- the case that lost it
#   3. it is still on disk when the channel is unreachable entirely
#   4. the journal is 0600 — it holds text that may never have reached anyone
#   5. the text is stored verbatim: newlines, quotes, unicode intact
#   6. a rejected send (empty / unauthenticated) is NOT journaled
#   7. the journal is never served over HTTP
set -u
DIR=$(mktemp -d)
PORT=22098
CHAN=22097
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then echo "  ok  $2"; pass=$((pass+1)); else echo "FAIL  $2"; fail=$((fail+1)); fi; }

printf '%s\n' '{"type":"summary","summary":"test"}' > "$DIR/session.jsonl"

# A stand-in channel whose verdict we control by writing to a file. The real
# failure returned 200, but 200 is not the interesting case for the journal —
# a REFUSED send is, because that is precisely when the text must survive.
cat > "$DIR/chan.mjs" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
const mode = process.argv[2];
http.createServer((req, res) => {
  let b = ''; req.on('data', d => b += d);
  req.on('end', () => {
    fs.appendFileSync(process.env.CHAN_LOG, b + '\n');
    if (mode === 'refuse') { res.writeHead(500); res.end('{"ok":false}'); return; }
    res.writeHead(200, {'Content-Type':'application/json'}); res.end('{"ok":true}');
  });
}).listen(Number(process.env.CHAN_PORT), '127.0.0.1');
EOF

start_mirror(){   # $1 = channel url ('' for none)
  MIRROR_INSTANCE=jtest MIRROR_DISPLAY=JTest \
  MIRROR_TRANSCRIPT="$DIR/session.jsonl" MIRROR_DATA_DIR="$DIR/data" \
  MIRROR_BIND=127.0.0.1 MIRROR_PORT=$PORT MIRROR_CHANNEL_URL="$1" \
  MIRROR_ALLOW_SEND=1 \
  node "$SRC/src/mirror-server.mjs" > "$DIR/server.log" 2>&1 &
  SRV=$!
  for _ in $(seq 1 40); do
    curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  echo "server never came up:"; cat "$DIR/server.log"; exit 1
}
send(){ curl -s -X POST "http://127.0.0.1:$PORT/send" \
          -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" \
          -d "$1"; }
jrnl="$DIR/data/sent.jsonl"

cleanup(){ kill ${SRV:-0} ${CH:-0} 2>/dev/null; rm -rf "$DIR"; }
trap cleanup EXIT

echo
echo "1. the happy path puts the text on disk"
CHAN_PORT=$CHAN CHAN_LOG="$DIR/chan.log" node "$DIR/chan.mjs" accept & CH=$!
sleep 0.6
start_mirror "http://127.0.0.1:$CHAN"
send '{"text":"hello from the journal test"}' >/dev/null
ok "$([ -f "$jrnl" ] && echo 1 || echo 0)" "sent.jsonl created"
ok "$(grep -qF 'hello from the journal test' "$jrnl" && echo 1 || echo 0)" "text present verbatim"

echo
echo "2. THE CASE THAT LOST LUPO'S MESSAGE: channel refuses, text must survive"
kill $CH 2>/dev/null; sleep 0.4
CHAN_PORT=$CHAN CHAN_LOG="$DIR/chan.log" node "$DIR/chan.mjs" refuse & CH=$!
sleep 0.6
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/send" \
       -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" \
       -d '{"text":"this one gets refused downstream"}')
ok "$([ "$CODE" = "502" ] && echo 1 || echo 0)" "caller told the truth: 502, not a false 200"
ok "$(grep -qF 'this one gets refused downstream' "$jrnl" && echo 1 || echo 0)" \
   "REFUSED text is still on disk"

echo
echo "3. channel unreachable entirely — text must still survive"
kill $CH 2>/dev/null; sleep 0.5
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/send" \
       -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" \
       -d '{"text":"nobody is listening downstream"}')
ok "$([ "$CODE" = "502" ] && echo 1 || echo 0)" "connection refused surfaces as 502"
ok "$(grep -qF 'nobody is listening downstream' "$jrnl" && echo 1 || echo 0)" \
   "unreachable-channel text is still on disk"

echo
echo "4. permissions: it holds undelivered human speech"
MODE=$(stat -c '%a' "$jrnl")
ok "$([ "$MODE" = "600" ] && echo 1 || echo 0)" "sent.jsonl is 0600 (got $MODE)"

echo
echo "5. stored verbatim — newlines, quotes, unicode"
send '{"text":"line one\nline two \"quoted\" — em dash 🪨"}' >/dev/null
GOT=$(node -e '
  const fs=require("fs");
  const ls=fs.readFileSync(process.argv[1],"utf8").trim().split("\n");
  process.stdout.write(JSON.parse(ls[ls.length-1]).text);
' "$jrnl")
ok "$([ "$GOT" = "$(printf 'line one\nline two "quoted" — em dash 🪨')" ] && echo 1 || echo 0)" \
   "multiline/quotes/unicode round-trip exactly"

echo
echo "6. rejected sends are NOT journaled"
BEFORE=$(wc -l < "$jrnl")
send '{"text":"   "}' >/dev/null
curl -s -o /dev/null -X POST "http://127.0.0.1:$PORT/send" \
     -H 'Content-Type: application/json' -d '{"text":"cross origin attempt"}' \
     -H 'Origin: http://evil.example'
AFTER=$(wc -l < "$jrnl")
ok "$([ "$BEFORE" = "$AFTER" ] && echo 1 || echo 0)" "empty + cross-origin added no lines ($BEFORE -> $AFTER)"
ok "$(grep -qF 'cross origin attempt' "$jrnl" && echo 0 || echo 1)" "cross-origin text never written"

echo
echo "7. the journal is not reachable over HTTP"
for u in "/file/sent.jsonl" "/file/inbox/../sent.jsonl" "/sent.jsonl"; do
  CODE=$(curl -s --path-as-is -o "$DIR/out" -w '%{http_code}' "http://127.0.0.1:$PORT$u")
  LEAK=$(grep -qF 'hello from the journal test' "$DIR/out" 2>/dev/null && echo 1 || echo 0)
  ok "$([ "$LEAK" = "0" ] && echo 1 || echo 0)" "$u -> $CODE, no leak"
done


echo
echo "8. /upload is a WRITE and needs its own grant (measured hole, 2026-08-24)"
# Before this: a mirror started with NO grants answered /send 403 and /upload 200,
# writing bytes into the instance's inbox. Full mode without --with-input is
# exactly the deployment someone picks to be watched and NOT written to.
kill $SRV 2>/dev/null; sleep 0.5
MIRROR_INSTANCE=jtest2 MIRROR_TRANSCRIPT="$DIR/session.jsonl" MIRROR_DATA_DIR="$DIR/data2" \
MIRROR_BIND=127.0.0.1 MIRROR_PORT=$PORT \
node "$SRC/src/mirror-server.mjs" > "$DIR/server2.log" 2>&1 &
SRV=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done
UP=$(curl -s -o "$DIR/up" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/upload" \
     -H 'X-Filename: probe.txt' -H 'Content-Type: application/octet-stream' \
     -H "Origin: http://127.0.0.1:$PORT" --data-binary 'PROBE')
ok "$([ "$UP" = "403" ] && echo 1 || echo 0)" "ungranted mirror refuses /upload (got $UP)"
ok "$([ ! -d "$DIR/data2/inbox" ] || [ -z "$(ls -A "$DIR/data2/inbox" 2>/dev/null)" ] && echo 1 || echo 0)" \
   "and wrote NOTHING to disk"
ok "$(curl -s "http://127.0.0.1:$PORT/health" | grep -q '"upload": false' && echo 1 || echo 0)" \
   "/health reports upload: false"

echo
echo "9. granting send grants uploads — no live mirror changes behaviour"
kill $SRV 2>/dev/null; sleep 0.5
CHAN_PORT=$CHAN CHAN_LOG="$DIR/chan.log" node "$DIR/chan.mjs" accept & CH=$!
sleep 0.5
MIRROR_INSTANCE=jtest3 MIRROR_TRANSCRIPT="$DIR/session.jsonl" MIRROR_DATA_DIR="$DIR/data3" \
MIRROR_BIND=127.0.0.1 MIRROR_PORT=$PORT MIRROR_CHANNEL_URL="http://127.0.0.1:$CHAN" \
MIRROR_ALLOW_SEND=1 \
node "$SRC/src/mirror-server.mjs" > "$DIR/server3.log" 2>&1 &
SRV=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done
UP2=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/upload" \
      -H 'X-Filename: probe.txt' -H 'Content-Type: application/octet-stream' \
      -H "Origin: http://127.0.0.1:$PORT" --data-binary 'PROBE')
ok "$([ "$UP2" = "200" ] && echo 1 || echo 0)" "send granted -> upload accepted (got $UP2)"

echo
echo "10. and the two can still be separated deliberately"
kill $SRV 2>/dev/null; sleep 0.5
MIRROR_INSTANCE=jtest4 MIRROR_TRANSCRIPT="$DIR/session.jsonl" MIRROR_DATA_DIR="$DIR/data4" \
MIRROR_BIND=127.0.0.1 MIRROR_PORT=$PORT MIRROR_CHANNEL_URL="http://127.0.0.1:$CHAN" \
MIRROR_ALLOW_SEND=1 MIRROR_ALLOW_UPLOAD=0 \
node "$SRC/src/mirror-server.mjs" > "$DIR/server4.log" 2>&1 &
SRV=$!
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done
S4=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/send" \
     -H 'Content-Type: application/json' -H "Origin: http://127.0.0.1:$PORT" -d '{"text":"still works"}')
U4=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/upload" \
     -H 'X-Filename: p.txt' -H 'Content-Type: application/octet-stream' \
     -H "Origin: http://127.0.0.1:$PORT" --data-binary 'P')
ok "$([ "$S4" = "200" ] && [ "$U4" = "403" ] && echo 1 || echo 0)" \
   "MIRROR_ALLOW_UPLOAD=0 with send on: send $S4, upload $U4"

echo

echo
echo "passed=$pass failed=$fail"
exit $([ "$fail" = "0" ] && echo 0 || echo 1)
