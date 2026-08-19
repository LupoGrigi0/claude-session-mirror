#!/usr/bin/env bash
# End-to-end against a REAL running mirror, not a mock.
#
# What would have to be true:
#   1. an uploaded file comes back byte-identical
#   2. a traversal in the URL cannot reach outside the boxes
#   3. an oversize upload is REFUSED (413), not silently truncated
#   4. a file dropped in outbox/ is announced on the live SSE stream
#   5. SVG is served as a download, never as an inline image
#   6. an upload with no X-Filename is refused
set -u
DIR=$(mktemp -d)
PORT=22099
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then echo "  ok  $2"; pass=$((pass+1)); else echo "FAIL  $2"; fail=$((fail+1)); fi; }

printf '%s\n' '{"type":"summary","summary":"test"}' > "$DIR/session.jsonl"

MIRROR_INSTANCE=e2etest MIRROR_DISPLAY=E2E \
MIRROR_TRANSCRIPT="$DIR/session.jsonl" MIRROR_DATA_DIR="$DIR/data" \
MIRROR_BIND=127.0.0.1 MIRROR_PORT=$PORT MIRROR_MAX_UPLOAD=$((1024*1024)) \
node "$SRC/src/mirror-server.mjs" > "$DIR/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$DIR"' EXIT

for i in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$PORT/health" >/dev/null || { echo "server never came up:"; cat "$DIR/server.log"; exit 1; }

echo
echo "1. round trip is byte-identical"
head -c 300000 /dev/urandom > "$DIR/payload.bin"
RESP=$(curl -s -X POST "http://127.0.0.1:$PORT/upload" \
  -H "X-Filename: my%20photo.png" -H 'Content-Type: application/octet-stream' \
  --data-binary "@$DIR/payload.bin")
echo "     $RESP"
URL=$(printf '%s' "$RESP" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
ok "$([ -n "$URL" ] && echo 1 || echo 0)" "upload accepted, url returned"
curl -s "http://127.0.0.1:$PORT$URL" -o "$DIR/back.bin"
ok "$(cmp -s "$DIR/payload.bin" "$DIR/back.bin" && echo 1 || echo 0)" "downloaded bytes identical to uploaded ($(stat -c%s "$DIR/back.bin" 2>/dev/null) bytes)"
CT=$(curl -s -o /dev/null -D - "http://127.0.0.1:$PORT$URL" | tr -d '\r' | grep -i '^content-type:')
ok "$(echo "$CT" | grep -qi 'image/png' && echo 1 || echo 0)" "served as image/png (from extension) [$CT]"
NOSNIFF=$(curl -s -o /dev/null -D - "http://127.0.0.1:$PORT$URL" | tr -d '\r' | grep -ci 'x-content-type-options: nosniff')
ok "$([ "$NOSNIFF" = "1" ] && echo 1 || echo 0)" "nosniff header present"

echo
echo "2. traversal cannot escape the boxes"
echo "SECRET" > "$DIR/data/secret.txt"
for attack in "/file/inbox/../secret.txt" "/file/inbox/..%2fsecret.txt" "/file/../../etc/passwd" "/file/etc/passwd" "/file/inbox/%2e%2e%2fsecret.txt"; do
  CODE=$(curl -s --path-as-is -o "$DIR/out" -w '%{http_code}' "http://127.0.0.1:$PORT$attack")
  if grep -q SECRET "$DIR/out" 2>/dev/null; then LEAK=1; else LEAK=0; fi
  ok "$([ "$LEAK" = "0" ] && [ "$CODE" = "404" ] && echo 1 || echo 0)" "$attack -> $CODE, no leak"
done

echo
echo "3. oversize is refused, not truncated"
head -c 2000000 /dev/urandom > "$DIR/big.bin"
CODE=$(curl -s -o "$DIR/bigresp" -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/upload" \
  -H "X-Filename: big.bin" -H 'Content-Type: application/octet-stream' --data-binary "@$DIR/big.bin")
ok "$([ "$CODE" = "413" ] && echo 1 || echo 0)" "2 MB against a 1 MB cap -> HTTP $CODE"
ok "$([ "$(ls "$DIR/data/inbox" | grep -c big.bin)" = "0" ] && echo 1 || echo 0)" "no truncated file was stored"

echo
echo "4. outbox file is announced on the live stream"
( curl -sN --max-time 8 "http://127.0.0.1:$PORT/events" > "$DIR/sse.txt" ) &
sleep 1
echo "hello from the instance" > "$DIR/data/outbox/report.txt"
sleep 5
ok "$(grep -q '"direction":"out"' "$DIR/sse.txt" && echo 1 || echo 0)" "outbound file event reached the SSE stream"
ok "$(grep -q 'report.txt' "$DIR/sse.txt" && echo 1 || echo 0)" "event names the file"

echo
echo "5. svg downloads, never renders"
printf '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' > "$DIR/data/outbox/x.svg"
sleep 5
H=$(curl -s -o /dev/null -D - "http://127.0.0.1:$PORT/file/outbox/x.svg" | tr -d '\r')
ok "$(echo "$H" | grep -qi 'content-type: application/octet-stream' && echo 1 || echo 0)" "svg content-type is octet-stream"
ok "$(echo "$H" | grep -qi 'content-disposition: attachment' && echo 1 || echo 0)" "svg is content-disposition: attachment"
PNGH=$(curl -s -o /dev/null -D - "http://127.0.0.1:$PORT$URL" | tr -d '\r')
ok "$(echo "$PNGH" | grep -qi 'content-disposition: inline' && echo 1 || echo 0)" "png IS inline (so it renders in the feed)"

echo
echo "6. missing X-Filename is refused"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/upload" \
  -H 'Content-Type: application/octet-stream' --data-binary 'xyz')
ok "$([ "$CODE" = "400" ] && echo 1 || echo 0)" "no X-Filename -> HTTP $CODE"

echo
echo "7. permissions state is never written to the durable log"
ok "$(grep -q '"type":"permissions"' "$DIR/data/e2etest.jsonl" 2>/dev/null && echo 0 || echo 1)" "no permissions events persisted"

echo
echo "passed=$pass failed=$fail"
[ "$fail" = "0" ] || { echo; echo "--- server log ---"; cat "$DIR/server.log"; }
exit $([ "$fail" = "0" ] && echo 0 || echo 1)
