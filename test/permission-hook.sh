#!/usr/bin/env bash
# End-to-end test of the PermissionRequest hook + web-bridge permission side channel.
#
# Drives bin/permission-hook.mjs exactly as Claude Code would (request JSON on
# stdin) against a real bin/bridge-linux.mjs, and plays the mirror's part with
# curl. What must hold:
#   * a held request shows up as a card in /pending-permissions
#   * an "allow" / "deny" verdict produces the decision JSON Claude Code expects
#   * a cancelled hook (SIGTERM) prints NOTHING, so Claude Code falls back to its dialog
#   * a killed hook (SIGKILL, no cleanup) leaves no card behind once the bridge looks
#   * a verdict for an unknown id is a 404, which the mirror reports as "stale"
#   * a bridge restart does not lose a held request
set -u
DIR=$(mktemp -d)
PORT=22199
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PERM_HOOK_DIR="$DIR/perm" PERM_HOOK_POLL_MS=200
pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then echo "  ok  $2"; pass=$((pass+1)); else echo "FAIL  $2"; fail=$((fail+1)); fi; }

start_bridge(){
  BRIDGE_PORT=$PORT BRIDGE_TARGET=permtest BRIDGE_WORKDIR="$DIR" BRIDGE_LOG="$DIR/bridge.log" \
    node "$SRC/bin/bridge-linux.mjs" >> "$DIR/boot.log" 2>&1 &
  BP=$!
  for _ in $(seq 50); do curl -sf "localhost:$PORT/health" >/dev/null && return; sleep 0.1; done
}
# Callers background this with `&` and signal $!; exec makes $! the node process
# itself rather than a subshell that would swallow the signal.
hook(){ exec node "$SRC/bin/permission-hook.mjs" <<< "$1"; }
pending(){ curl -s "localhost:$PORT/pending-permissions"; }
id_for(){ pending | python3 -c "import sys,json; print(next((c['request_id'] for c in json.load(sys.stdin)['pending'] if c['tool_name']=='$1'),''))"; }
verdict(){ curl -s -o /dev/null -w '%{http_code}' -XPOST "localhost:$PORT/permission-verdict" \
             -H 'Content-Type: application/json' -d "{\"request_id\":\"$1\",\"behavior\":\"$2\"}"; }

start_bridge
ok "$(pending | grep -q '"pending":\[\]' && echo 1 || echo 0)" "no hook running: pending list is empty"

echo "1. allow"
hook '{"session_id":"s1","tool_name":"Write","tool_input":{"file_path":"/x/y.txt","content":"hi"}}' > "$DIR/out1" & H1=$!
sleep 0.8
W=$(id_for Write)
ok "$([ -n "$W" ] && echo 1 || echo 0)" "held Write request appears as a card ($W)"
ok "$(pending | grep -q '/x/y.txt' && echo 1 || echo 0)" "card preview shows the file path"
ok "$(pending | grep -q '"pid"' && echo 0 || echo 1)" "card does not leak the hook pid"
ok "$([ "$(verdict "$W" allow)" = 200 ] && echo 1 || echo 0)" "allow verdict accepted (200)"
wait $H1
ok "$(grep -q '"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}' "$DIR/out1" && echo 1 || echo 0)" "hook printed the allow decision"

echo "2. deny"
hook '{"tool_name":"Bash","tool_input":{"command":"ls","description":"List files"}}' > "$DIR/out2" & H2=$!
sleep 0.8
B=$(id_for Bash)
ok "$(pending | grep -q 'List files' && echo 1 || echo 0)" "card uses the tool's own description"
ok "$([ "$(verdict "$B" deny)" = 200 ] && echo 1 || echo 0)" "deny verdict accepted (200)"
wait $H2
ok "$(grep -q '"behavior":"deny","message"' "$DIR/out2" && echo 1 || echo 0)" "hook printed the deny decision with a message"

echo "3. cancelled hook falls through"
hook '{"tool_name":"Edit","tool_input":{"file_path":"/z"}}' > "$DIR/out3" & H3=$!
sleep 0.8
kill -TERM $H3; wait $H3; rc=$?
ok "$([ "$rc" = 0 ] && echo 1 || echo 0)" "SIGTERM exits 0"
ok "$([ -s "$DIR/out3" ] && echo 0 || echo 1)" "SIGTERM prints nothing (Claude Code shows its dialog)"
ok "$([ -z "$(id_for Edit)" ] && echo 1 || echo 0)" "SIGTERM removes its card"

echo "4. killed hook leaves no card"
hook '{"tool_name":"WebFetch","tool_input":{"url":"https://example.com"}}' > /dev/null & H4=$!
sleep 0.8
kill -9 $H4; wait $H4 2>/dev/null
ok "$([ -z "$(id_for WebFetch)" ] && echo 1 || echo 0)" "card for a dead hook is dropped by the bridge"
ok "$(find "$DIR/perm" -type f | grep -q . && echo 0 || echo 1)" "no files left on disk"

echo "5. unknown / malformed verdicts"
ok "$([ "$(verdict zzzzz allow)" = 404 ] && echo 1 || echo 0)" "unknown id is 404 (mirror shows 'stale')"
ok "$([ "$(verdict '../etc' allow)" = 400 ] && echo 1 || echo 0)" "path-like id is rejected (400)"

echo "6. bridge restart does not lose a held request"
hook '{"tool_name":"Write","tool_input":{"file_path":"/survives"}}' > "$DIR/out6" & H6=$!
sleep 0.8
kill $BP; wait $BP 2>/dev/null
start_bridge
R=$(id_for Write)
ok "$([ -n "$R" ] && echo 1 || echo 0)" "card is still listed after the bridge restarts"
ok "$([ "$(verdict "$R" allow)" = 200 ] && echo 1 || echo 0)" "and can still be answered"
wait $H6
ok "$(grep -q '"behavior":"allow"' "$DIR/out6" && echo 1 || echo 0)" "the held hook receives it"

kill $BP 2>/dev/null; wait $BP 2>/dev/null
rm -rf "$DIR"
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
