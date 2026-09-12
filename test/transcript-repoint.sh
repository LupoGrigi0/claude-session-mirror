#!/usr/bin/env bash
# The mirror must SAY which transcript it is reading, and notice when that is
# no longer the session's current one.
#
# The oldest known bug here: the transcript path is resolved once, by the
# launcher, and the tailer holds it forever. If the session re-points to a new
# .jsonl the tailer keeps stat'ing a file nothing writes any more — it publishes
# nothing, forever, while the process stays up and /health stays green. It looks
# fine, which is the worst failure shape available.
#
# MEASURED 2026-09-12: /compact does NOT re-point on the current Claude Code,
# so this has never fired in the case everyone worried about. It is still
# reachable by --resume, and by whatever produced Axiom's two-uuid case.
#
# This tests the DETECTION, which deliberately landed before the repair: until
# it existed there was no question you could ask the mirror that would reveal
# the failure at all.
#
# What would have to be true:
#   1. /health states the path being tailed  (it exposed nothing before)
#   2. a mirror on the newest transcript reports is_newest true
#   3. a NEWER .jsonl appearing flips is_newest false and starts the clock
#   4. "could not look" is null, NEVER false — absence and unreadable differ
set -u
DIR=$(mktemp -d)
PORT=22094
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then echo "  ok  $2"; pass=$((pass+1)); else echo "FAIL  $2"; fail=$((fail+1)); fi; }

mkdir -p "$DIR/proj"
printf '%s\n' '{"type":"summary","summary":"test"}' > "$DIR/proj/old.jsonl"

# 400ms instead of the production 30s so the poll is genuinely EXERCISED.
MIRROR_INSTANCE=reptest MIRROR_DISPLAY=Rep \
MIRROR_TRANSCRIPT="$DIR/proj/old.jsonl" MIRROR_DATA_DIR="$DIR/data" \
MIRROR_BIND=127.0.0.1 MIRROR_PORT=$PORT MIRROR_REPOINT_POLL_MS=400 \
node "$SRC/src/mirror-server.mjs" > "$DIR/server.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null; rm -rf "$DIR"' EXIT
for _ in $(seq 1 40); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done

t(){ curl -s "http://127.0.0.1:$PORT/health" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const t=JSON.parse(s).transcript;
    process.stdout.write(JSON.stringify([
      t===null?"null":(t.tailing?"set":"unset"),
      t===null?"null":String(t.is_newest),
      t===null?"null":(t.repointed_for_s===null?"null":"num")]));});'; }

echo "== 1. the path is stated at all =="
V=$(t); echo "  $V"
case "$V" in '["set",'*) ok 1 "/health names the transcript it is tailing";; *) ok 0 "/health names the transcript it is tailing";; esac

echo "== 2. newest transcript -> is_newest true =="
case "$V" in *'"true"'*) ok 1 "is_newest true while tailing the newest";; *) ok 0 "is_newest true while tailing the newest";; esac
case "$V" in *',"null"]') ok 1 "repointed_for_s null while healthy";; *) ok 0 "repointed_for_s null while healthy";; esac

echo "== 3. a newer .jsonl appears -> detected =="
sleep 1
printf '%s\n' '{"type":"summary","summary":"new session"}' > "$DIR/proj/new.jsonl"
sleep 1.2
V=$(t); echo "  $V"
case "$V" in *'"false"'*) ok 1 "is_newest flips false when the session re-points";; *) ok 0 "is_newest flips false when the session re-points";; esac
case "$V" in *',"num"]') ok 1 "repointed_for_s starts counting";; *) ok 0 "repointed_for_s starts counting";; esac
grep -q "TRANSCRIPT RE-POINTED" "$DIR/server.log" && ok 1 "logs the re-point loudly" || ok 0 "logs the re-point loudly"

echo "== 4. could-not-look is null, not false =="
# The whole directory becomes unreadable: readdir throws, so newestTranscript()
# returns null. That must render is_newest null -- reporting false here would
# claim a re-point that was never observed.
chmod 000 "$DIR/proj"
sleep 1.2
V=$(curl -s "http://127.0.0.1:$PORT/health" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const t=JSON.parse(s).transcript;
    process.stdout.write(JSON.stringify([t.newest_on_disk,t.is_newest]));});')
chmod 755 "$DIR/proj"
echo "  $V"
case "$V" in '[null,null]') ok 1 "unreadable dir -> is_newest null (not false)";; *) ok 0 "unreadable dir -> is_newest null (not false)";; esac

echo
echo "passed=$pass failed=$fail"
[ "$fail" = "0" ]
