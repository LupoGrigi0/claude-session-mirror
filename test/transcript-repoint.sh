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
#   2. a mirror on the newest transcript reports tailing_is_newest_in_dir true
#   3. a NEWER SIBLING .jsonl flips it false and starts the clock -- and this is
#      NOT proof of a re-point: another session running in the same directory is
#      indistinguishable. Found 2026-10-03 when `claude mod list` (an unknown
#      subcommand is treated as a PROMPT) spawned two sessions in Cairn's own
#      project dir. The field was renamed because it claimed more than it knew.
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
      t===null?"null":String(t.tailing_is_newest_in_dir),
      t===null?"null":(t.sibling_appeared_for_s===null?"null":"num")]));});'; }

echo "== 1. the path is stated at all =="
V=$(t); echo "  $V"
case "$V" in '["set",'*) ok 1 "/health names the transcript it is tailing";; *) ok 0 "/health names the transcript it is tailing";; esac

echo "== 2. newest transcript -> tailing_is_newest_in_dir true =="
case "$V" in *'"true"'*) ok 1 "true while tailing the newest in dir";; *) ok 0 "true while tailing the newest in dir";; esac
case "$V" in *',"null"]') ok 1 "sibling_appeared_for_s null while healthy";; *) ok 0 "sibling_appeared_for_s null while healthy";; esac

echo "== 3. a newer .jsonl appears -> detected =="
sleep 1
printf '%s\n' '{"type":"summary","summary":"new session"}' > "$DIR/proj/new.jsonl"
sleep 1.2
V=$(t); echo "  $V"
case "$V" in *'"false"'*) ok 1 "flips false when a newer sibling appears";; *) ok 0 "flips false when a newer sibling appears";; esac
case "$V" in *',"num"]') ok 1 "sibling_appeared_for_s starts counting";; *) ok 0 "sibling_appeared_for_s starts counting";; esac
grep -q "NEWER SIBLING transcript appeared" "$DIR/server.log" && ok 1 "logs a sibling WITHOUT claiming a re-point" || ok 0 "logs a sibling WITHOUT claiming a re-point"
grep -q "TRANSCRIPT RE-POINTED" "$DIR/server.log" && ok 0 "must NOT assert a re-point from a sibling alone" || ok 1 "must NOT assert a re-point from a sibling alone"

echo "== 4. could-not-look is null, not false =="
# The whole directory becomes unreadable: readdir throws, so newestTranscript()
# returns null. That must render is_newest null -- reporting false here would
# claim a re-point that was never observed.
chmod 000 "$DIR/proj"
sleep 1.2
V=$(curl -s "http://127.0.0.1:$PORT/health" | node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const t=JSON.parse(s).transcript;
    process.stdout.write(JSON.stringify([t.newest_sibling_on_disk,t.tailing_is_newest_in_dir]));});')
chmod 755 "$DIR/proj"
echo "  $V"
case "$V" in '[null,null]') ok 1 "unreadable dir -> null (not false)";; *) ok 0 "unreadable dir -> null (not false)";; esac

echo
echo "passed=$pass failed=$fail"
[ "$fail" = "0" ]
