#!/usr/bin/env bash
# A mind that is NOT RUNNING must not be reported as a deaf channel.
#
# Reported by Forge-ba0e 2026-09-28 from the Linux chassis: after `kill -9` his
# canary said DEAF "maybe frozen" while the registry already knew the mind was
# not running. The same hole was open here and worse — nothing in mirror-server
# consulted liveness at all; tmux was used only to WRITE into the session.
#
# Trace: the mind dies -> transcript stops growing -> its existing content still
# parses (readable) -> no events (quiet gate satisfied) -> CHANNEL APPEARS DEAF.
# The channel is fine. The mind is gone. The verdict points at the wrong component.
#
# Forge's rule: an instrument should use every independent ledger it has before
# it rules.
#
# What would have to be true:
#   1. no tmux session configured -> session_running is NULL, not false
#   2. a null liveness reading must NOT suppress a real deaf verdict
#      (otherwise the detector silently dies everywhere tmux is absent)
#   3. tmux says the session does not exist -> NOT-RUNNING, deaf WITHHELD (null)
set -u
DIR=$(mktemp -d)
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then echo "  ok  $2"; pass=$((pass+1)); else echo "FAIL  $2"; fail=$((fail+1)); fi; }

cat > "$DIR/deafchan.mjs" <<'EOF'
import http from 'node:http';
http.createServer((req,res)=>{ let b=''; req.on('data',d=>b+=d);
  req.on('end',()=>{ res.writeHead(200,{'Content-Type':'application/json'}); res.end('{"ok":true}'); });
}).listen(Number(process.env.CHAN_PORT),'127.0.0.1');
EOF

# ---- helper: boot a mirror with a given tmux session name, return its port
boot(){ # $1=port $2=chan $3=tmuxname(empty for none) $4=datadir
  printf '%s\n' '{"type":"summary","summary":"seed"}' > "$DIR/$4.jsonl"
  MIRROR_INSTANCE="live$4" MIRROR_DISPLAY=Live \
  MIRROR_TRANSCRIPT="$DIR/$4.jsonl" MIRROR_DATA_DIR="$DIR/$4" \
  MIRROR_BIND=127.0.0.1 MIRROR_PORT=$1 MIRROR_CHANNEL_URL="http://127.0.0.1:$2" \
  MIRROR_ALLOW_SEND=1 MIRROR_DEAF_AFTER_MS=2000 MIRROR_TMUX_SESSION="$3" \
  node "$SRC/src/mirror-server.mjs" > "$DIR/$4.log" 2>&1 &
  echo $!
}
w(){ curl -s "http://127.0.0.1:$1/health" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const w=JSON.parse(s).write_path;
    process.stdout.write(JSON.stringify([String(w.session_running),
                                         String(w.channel_appears_deaf)]));});'; }

CHAN=22090
CHAN_PORT=$CHAN node "$DIR/deafchan.mjs" & CH=$!
sleep 0.6
trap 'kill $CH ${S1:-} ${S2:-} 2>/dev/null; rm -rf "$DIR"' EXIT

echo "== 1/2. no tmux configured: null liveness, and deaf STILL works =="
S1=$(boot 22089 $CHAN "" a)
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:22089/health" >/dev/null 2>&1 && break; sleep 0.25; done
V=$(w 22089); echo "  before send: $V"
case "$V" in '["null",'*) ok 1 "session_running is null when unconfigured (not false)";; *) ok 0 "session_running is null when unconfigured (not false)";; esac
curl -s -X POST "http://127.0.0.1:22089/send" -H 'Content-Type: application/json' -d '{"text":"probe A"}' >/dev/null 2>&1
sleep 3.5
V=$(w 22089); echo "  after send : $V"
case "$V" in '["null","true"]') ok 1 "null liveness does NOT suppress a real deaf verdict";; *) ok 0 "null liveness does NOT suppress a real deaf verdict";; esac
kill $S1 2>/dev/null; S1=""

echo "== 3. tmux says the session does not exist -> NOT-RUNNING, deaf withheld =="
if ! command -v tmux >/dev/null 2>&1; then
  echo "  SKIP: tmux not installed on this box — cannot exercise the false branch"
  echo "  (this is itself the null case, covered above)"
else
  GONE="mirror-test-nosuch-$$"
  tmux has-session -t "$GONE" 2>/dev/null && tmux kill-session -t "$GONE"
  S2=$(boot 22088 $CHAN "$GONE" b)
  for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:22088/health" >/dev/null 2>&1 && break; sleep 0.25; done
  # Liveness is sampled only while a message is outstanding -- so send FIRST.
  # Before any send, session_running is legitimately null: nobody has looked.
  V=$(w 22088); echo "  before send: $V"
  case "$V" in '["null",'*) ok 1 "session_running null before anything is outstanding (not looked yet)";; *) ok 0 "session_running null before anything is outstanding (not looked yet)";; esac
  curl -s -X POST "http://127.0.0.1:22088/send" -H 'Content-Type: application/json' -d '{"text":"probe B"}' >/dev/null 2>&1
  sleep 3.5
  V=$(w 22088); echo "  liveness   : $V"
  case "$V" in '["false",'*) ok 1 "session_running false once sampled: tmux has no such session";; *) ok 0 "session_running false once sampled: tmux has no such session";; esac
  V=$(w 22088); echo "  verdict : $V"
  case "$V" in '["false","null"]') ok 1 "deaf WITHHELD (null) when the mind is not running";; *) ok 0 "deaf WITHHELD (null) when the mind is not running";; esac
  grep -q "SESSION IS NOT RUNNING" "$DIR/b.log" && ok 1 "names NOT RUNNING, not deaf" || ok 0 "names NOT RUNNING, not deaf"
  grep -q "NEVER seen arriving" "$DIR/b.log" && ok 0 "must NOT announce deaf" || ok 1 "must NOT announce deaf"
fi

echo
echo "passed=$pass failed=$fail"
[ "$fail" = "0" ]
