#!/usr/bin/env bash
# The launcher's REFUSAL paths.
#
# Written 2026-08-30 because Lodestone-8ec9 found a bug in a diagnostic that had
# never once been executed. bash -n passed it. shellcheck would have passed it.
# The happy path never touches it. It only runs for someone whose session id
# names no transcript — already lost, about to go verify paths — and it handed
# them a spliced path that cannot exist plus a session id wearing a directory's
# clothes.
#
# A diagnostic is code. An untested diagnostic misdirects with confidence at the
# exact moment someone is relying on it.
#
# What would have to be true:
#   1. a session id present in NO candidate refuses, and names each real path
#   2. those paths are WELL FORMED — no spliced candidates, no bare session id
#   3. no session id + two candidate dirs is fatally ambiguous, not a guess
#   4. no session id + one candidate proceeds
#   5. the chassis layout wins when the transcript is in both
set -u
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
ok(){ if [ "$1" = "1" ]; then echo "  ok  $2"; pass=$((pass+1)); else echo "FAIL  $2"; fail=$((fail+1)); fi; }

DIR=$(mktemp -d); trap 'rm -rf "$DIR"' EXIT
INST="$DIR/inst"; FAKEHOME="$DIR/home"
mkdir -p "$INST" "$FAKEHOME"
printf '{"instanceId":"lt","channelPort":21999}\n' > "$INST/.hacs-identity"
SLUG=$(echo "$INST" | sed 's/[^a-zA-Z0-9]/-/g')
CH="$INST/.claude/projects/$SLUG"; UH="$FAKEHOME/.claude/projects/$SLUG"

run(){  # run the launcher with a controlled environment, capture stderr
  env -i PATH="$PATH" HOME="$FAKEHOME" \
      HACS_IDENTITY_FILE="$INST/.hacs-identity" \
      ${1:+CLAUDE_CODE_SESSION_ID="$1"} \
      MIRROR_BIND=127.0.0.1 MIRROR_PORT=22087 \
      timeout 10 "$SRC/bin/mirror-start.sh" --with-input 2>&1
}

echo
echo "1. a session id present in NO candidate refuses, and names each path"
mkdir -p "$CH" "$UH"
OUT=$(run "deadbeef")
ok "$(grep -q 'names no transcript' <<<"$OUT" && echo 1 || echo 0)" "refuses rather than falling back"
ok "$(grep -qF "$CH/deadbeef.jsonl" <<<"$OUT" && echo 1 || echo 0)" "names the chassis candidate correctly"
ok "$(grep -qF "$UH/deadbeef.jsonl" <<<"$OUT" && echo 1 || echo 0)" "names the user-profile candidate correctly"

echo
echo "2. the paths are WELL FORMED (the printf-recycling bug)"
# The broken version spliced both candidates into one path and printed the
# session id as if it were a directory.
ok "$(grep -q "${CH}/${UH}" <<<"$OUT" && echo 0 || echo 1)" "no two candidates spliced into one path"
ok "$(grep -qE '^\s*deadbeef/\.jsonl' <<<"$OUT" && echo 0 || echo 1)" "no bare 'deadbeef/.jsonl' line"
ok "$([ "$(grep -c 'deadbeef\.jsonl' <<<"$OUT")" = "2" ] && echo 1 || echo 0)" \
   "exactly 2 candidate lines, one per layout (got $(grep -c 'deadbeef\.jsonl' <<<"$OUT"))"

echo
echo "3. no session id + TWO candidate dirs is fatally ambiguous"
# Rung 2 of the trust ladder RECORDS the id, on purpose ("leave it for the
# machine" — a unit at boot has no session to ask). So test 1 left a
# .claude-session-id behind and the no-SID cases below inherited it. That is the
# launcher working as designed and the TEST leaking state; clear it explicitly
# so "no session id" means what it says.
rm -f "$INST/.claude-session-id"
OUT2=$(run "")
ok "$(grep -q 'refusing to guess twice' <<<"$OUT2" && echo 1 || echo 0)" "refuses to guess the dir AND the transcript"
ok "$(grep -qF "$CH" <<<"$OUT2" && grep -qF "$UH" <<<"$OUT2" && echo 1 || echo 0)" "and names both"

echo
echo "4. no session id + ONE candidate proceeds to the mtime rung"
rm -rf "$UH"
rm -f "$INST/.claude-session-id"
printf '%s\n' '{"type":"summary","summary":"t"}' > "$CH/only.jsonl"
OUT3=$(run "")
ok "$(grep -q 'refusing to guess twice' <<<"$OUT3" && echo 0 || echo 1)" "not ambiguous with one candidate"
ok "$(grep -qF "$CH/only.jsonl" <<<"$OUT3" && echo 1 || echo 0)" "resolved the only transcript there is"

echo
echo "5. the transcript is found under the USER PROFILE when it lives there (Bastion's real case)"
rm -rf "$CH"; mkdir -p "$UH"
printf '%s\n' '{"type":"summary","summary":"t"}' > "$UH/sid1.jsonl"
OUT4=$(run "sid1")
ok "$(grep -qF "$UH/sid1.jsonl" <<<"$OUT4" && echo 1 || echo 0)" "user-profile layout resolves"

echo
echo "6. chassis WINS when the transcript exists in both"
mkdir -p "$CH"; printf '%s\n' '{"type":"summary","summary":"t"}' > "$CH/sid1.jsonl"
OUT5=$(run "sid1")
ok "$(grep -qF "$CH/sid1.jsonl" <<<"$OUT5" && echo 1 || echo 0)" "order of authority preserved"

echo
echo "passed=$pass failed=$fail"
exit $([ "$fail" = "0" ] && echo 0 || echo 1)
