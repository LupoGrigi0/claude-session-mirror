#!/usr/bin/env bash
# An unreadable transcript must NOT be reported as a deaf channel.
#
# The bug this pins: src/tailer.mjs skipped unparsable lines with a bare
# `continue` — no counter, no log. So if the transcript format changed or the
# file corrupted, every line was skipped, no entry reached confirmDelivery,
# stats.lastEventAt stopped advancing, the quiet gate was satisfied, and the
# mirror announced CHANNEL APPEARS DEAF with total confidence. The truth was
# "I cannot read the transcript", and the person reading that verdict would go
# and debug the CHANNEL — the wrong component entirely.
#
# Genevieve's third door, in my own tailer, under a comment justifying the
# silence. Found because Forge-ba0e added a parser self-test to Loadstone's V2
# canary for exactly this reason and I went looking for the same hole here.
#
# What would have to be true:
#   1. a healthy transcript reports readable, unparsable 0
#   2. garbage lines are COUNTED (not silently skipped) and logged
#   3. while unreadable, channel_appears_deaf is NULL — not false, not true
#   4. a later good line restores readable, and the deaf machinery works again
set -u
DIR=$(mktemp -d)
PORT=22093
CHAN=22092
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then echo "  ok  $2"; pass=$((pass+1)); else echo "FAIL  $2"; fail=$((fail+1)); fi; }

cat > "$DIR/deafchan.mjs" <<'EOF'
import http from 'node:http';
http.createServer((req,res)=>{ let b=''; req.on('data',d=>b+=d);
  req.on('end',()=>{ res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); });
}).listen(Number(process.env.CHAN_PORT),'127.0.0.1');
EOF
CHAN_PORT=$CHAN node "$DIR/deafchan.mjs" & CH=$!
sleep 0.6

printf '%s\n' '{"type":"summary","summary":"seed"}' > "$DIR/s.jsonl"
MIRROR_INSTANCE=unread MIRROR_DISPLAY=Unread \
MIRROR_TRANSCRIPT="$DIR/s.jsonl" MIRROR_DATA_DIR="$DIR/data" \
MIRROR_BIND=127.0.0.1 MIRROR_PORT=$PORT MIRROR_CHANNEL_URL="http://127.0.0.1:$CHAN" \
MIRROR_ALLOW_SEND=1 MIRROR_DEAF_AFTER_MS=2000 \
node "$SRC/src/mirror-server.mjs" > "$DIR/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV $CH 2>/dev/null; rm -rf "$DIR"' EXIT
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done

w(){ curl -s "http://127.0.0.1:$PORT/health" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const w=JSON.parse(s).write_path;
    process.stdout.write(JSON.stringify([String(w.transcript_readable),
      w.transcript_unparsable_lines, String(w.channel_appears_deaf)]));});'; }

echo "== 1. healthy transcript =="
V=$(w); echo "  $V"
case "$V" in '["true",0,'*) ok 1 "readable=true unparsable=0";; *) ok 0 "readable=true unparsable=0";; esac

echo "== 2. garbage lines are counted, not silently skipped =="
printf '%s\n' 'this is not json at all'      >> "$DIR/s.jsonl"
printf '%s\n' '{"broken": '                  >> "$DIR/s.jsonl"
sleep 1.2
V=$(w); echo "  $V"
case "$V" in '["false",2,'*) ok 1 "2 unparsable counted, readable=false";; *) ok 0 "2 unparsable counted, readable=false";; esac
grep -q "UNPARSABLE transcript line" "$DIR/server.log" && ok 1 "logs the unparsable line loudly" || ok 0 "logs the unparsable line loudly"

echo "== 3. while unreadable, the deaf verdict is WITHHELD (null) =="
curl -s -X POST "http://127.0.0.1:$PORT/send" -H 'Content-Type: application/json' \
     -d '{"text":"probe while unreadable"}' >/dev/null 2>&1
sleep 3.5
V=$(w); echo "  $V"
case "$V" in *',"null"]') ok 1 "channel_appears_deaf is null, not false or true";; *) ok 0 "channel_appears_deaf is null, not false or true";; esac
grep -q "CANNOT READ THE TRANSCRIPT" "$DIR/server.log" && ok 1 "says it cannot read, not that the channel is deaf" || ok 0 "says it cannot read, not that the channel is deaf"
grep -q "NEVER seen arriving" "$DIR/server.log" && ok 0 "must NOT announce deaf while unreadable" || ok 1 "must NOT announce deaf while unreadable"

echo "== 4. a good line restores readability, deaf machinery works again =="
printf '%s\n' '{"type":"summary","summary":"readable again"}' >> "$DIR/s.jsonl"
sleep 1.2
V=$(w); echo "  $V"
case "$V" in '["true",2,'*) ok 1 "readable=true again, count retained";; *) ok 0 "readable=true again, count retained";; esac
sleep 2.5
grep -q "NEVER seen arriving" "$DIR/server.log" && ok 1 "deaf verdict now reachable again" || ok 0 "deaf verdict now reachable again"

echo
echo "passed=$pass failed=$fail"
[ "$fail" = "0" ]
