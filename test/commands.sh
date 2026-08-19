#!/usr/bin/env bash
# Slash commands: the one endpoint that types text into a live pane.
#
# What would have to be true for it not to be a remote shell:
#   1. off unless explicitly granted
#   2. only allowlisted NAMES run; everything else is refused BY NAME
#   3. a newline in args cannot submit extra lines (a newline IS an Enter press)
#   4. what reaches tmux is exactly "/<name> <sanitised args>" and nothing else
#   5. the normalizer renders commands as commands, never as the human talking
set -u
DIR=$(mktemp -d)
PORT=22091
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then echo "  ok  $2"; pass=$((pass+1)); else echo "FAIL  $2"; fail=$((fail+1)); fi; }

printf '%s\n' '{"type":"summary"}' > "$DIR/s.jsonl"

# A fake `tmux` that records its argv instead of touching a real pane.
mkdir -p "$DIR/bin"
cat > "$DIR/bin/tmux" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_LOG"
EOF
chmod +x "$DIR/bin/tmux"
export TMUX_LOG="$DIR/tmux.log"; : > "$TMUX_LOG"

start(){ # $1 = extra env
  env PATH="$DIR/bin:$PATH" TMUX_LOG="$TMUX_LOG" \
    MIRROR_INSTANCE=cmdtest MIRROR_TRANSCRIPT="$DIR/s.jsonl" MIRROR_DATA_DIR="$DIR/d$2" \
    MIRROR_BIND=127.0.0.1 MIRROR_PORT=$PORT MIRROR_TMUX_SESSION=fakesess $1 \
    node "$SRC/src/mirror-server.mjs" > "$DIR/log$2" 2>&1 &
  SRV=$!
  for i in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return; sleep 0.25; done
  echo "server never came up"; cat "$DIR/log$2"; exit 1
}
stop(){ kill $SRV 2>/dev/null; wait $SRV 2>/dev/null; sleep 0.5; }
trap 'kill $SRV 2>/dev/null; rm -rf "$DIR"' EXIT

post(){ curl -s -o "$DIR/resp" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/command" \
          -H 'Content-Type: application/json' --data "$1"; }

echo
echo "1. off unless granted"
start "" 1
CODE=$(post '{"name":"context"}')
ok "$([ "$CODE" = "403" ] && echo 1 || echo 0)" "POST /command -> $CODE with no grant"
ok "$([ ! -s "$TMUX_LOG" ] && echo 1 || echo 0)" "nothing was sent to tmux"
ok "$(curl -s "http://127.0.0.1:$PORT/health" | grep -q '"commands": false' && echo 1 || echo 0)" "health reports commands: false"
stop

echo
echo "2. granted: allowlist admits and refuses BY NAME"
: > "$TMUX_LOG"
start "MIRROR_ALLOW_COMMANDS=1" 2
CODE=$(post '{"name":"context"}')
ok "$([ "$CODE" = "200" ] && echo 1 || echo 0)" "/context -> $CODE"
for bad in clear exit quit config model login "rm -rf /" "../../etc" "context;ls"; do
  CODE=$(post "{\"name\":\"$bad\"}")
  ok "$([ "$CODE" = "403" ] && echo 1 || echo 0)" "$(printf '%-12s' "/$bad") -> $CODE refused"
done
ok "$(grep -q 'allowed' "$DIR/resp" && echo 1 || echo 0)" "the refusal names what IS allowed"

echo
echo "3. a newline in args cannot submit another line"
: > "$TMUX_LOG"
post '{"name":"export","args":"file\nclear\nrm -rf /"}' > /dev/null
# The danger is not the WORD "clear" — it arrives harmlessly as an argument to
# /export. The danger is a SECOND SUBMITTED LINE. So assert on that, not on a
# substring: the text must be one line, and exactly one Enter may be sent.
ok "$([ "$(grep -c 'send-keys' "$TMUX_LOG")" = "2" ] && echo 1 || echo 0)" "exactly two tmux calls, not four"
ok "$([ "$(grep -c 'Enter' "$TMUX_LOG")" = "1" ] && echo 1 || echo 0)" "exactly ONE Enter was sent"
ok "$([ "$(grep -c -- '-l --' "$TMUX_LOG")" = "1" ] && echo 1 || echo 0)" "the args collapsed to a SINGLE literal line"
echo "     tmux received:"; sed 's/^/       /' "$TMUX_LOG"

echo
echo "4. what reaches the pane is literal and single-line"
: > "$TMUX_LOG"
post '{"name":"compact","args":"keep the design notes"}' > /dev/null
ok "$(grep -q -- '-l -- /compact keep the design notes' "$TMUX_LOG" && echo 1 || echo 0)" "sent literally with -l"
ok "$([ "$(wc -l < "$TMUX_LOG")" = "2" ] && echo 1 || echo 0)" "exactly two tmux calls (text, then Enter)"
stop

echo
echo "5. the normalizer renders commands as commands"
node --input-type=module -e "
import { normalizeEntry } from '$SRC/src/normalizer.mjs';
const ctx={speaker:{id:'lupo',kind:'human',display:'Lupo'},instance:'i'};
const inv=normalizeEntry({type:'user',timestamp:'t',message:{role:'user',content:'<command-name>/context</command-name>\n<command-args></command-args>'}},ctx)[0];
const out=normalizeEntry({type:'user',timestamp:'t',message:{role:'user',content:'<local-command-stdout>ok</local-command-stdout>'}},ctx)[0];
const plain=normalizeEntry({type:'user',timestamp:'t',message:{role:'user',content:'hello'}},ctx)[0];
const r=[];
r.push([inv.type==='command'&&inv.body.name==='context','invocation -> type=command']);
r.push([inv.from.kind==='system','invocation is NOT attributed to the human']);
r.push([out.type==='command'&&out.body.output==='ok','output -> type=command']);
r.push([plain.type==='user_message','a normal message is still a user_message']);
for (const [good,label] of r) console.log((good?'  ok  ':'FAIL  ')+label);
process.exit(r.every(x=>x[0])?0:1)
" && pass=$((pass+4)) || fail=$((fail+1))

echo
echo "passed=$pass failed=$fail"
[ "$fail" = "0" ] || { echo; echo "--- server log ---"; cat "$DIR/log2" 2>/dev/null; }
exit $([ "$fail" = "0" ] && echo 0 || echo 1)
