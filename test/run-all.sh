#!/usr/bin/env bash
# Run every suite, and LINT the suites themselves.
#
# Written 2026-08-30 after appending a test block below a stray `exit` for the
# FOURTH time. Each time the suite reported success and ran zero of the new
# assertions; each time I noticed by accident. Manual care demonstrably does not
# fix this, so the check is now mechanical.
#
# It also exists because I kept eyeballing `tail -1` of a suite's output to
# decide whether it passed — and files-e2e.sh ends with a server log line, so I
# once nearly reported seven failures as green. Read the verdict, never the last
# line.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fail=0

echo "== linting the suites =="
for f in test/*.sh; do
  [[ "$(basename "$f")" == run-all.sh ]] && continue
  bash -n "$f" || { echo "  SYNTAX  $f"; fail=1; continue; }
  # Any assertion after the exit is an assertion that never runs.
  ex=$(grep -n '^exit ' "$f" | head -1 | cut -d: -f1)
  if [[ -n "$ex" ]]; then
    after=$(awk -v n="$ex" 'NR>n && /^ *ok /' "$f" | wc -l)
    if [[ "$after" -gt 0 ]]; then
      echo "  DEAD    $f — $after assertion(s) below the exit on line $ex; they never run"
      fail=1
      continue
    fi
  fi
  echo "  ok      $f"
done

echo
echo "== running =="
total=0
for f in test/*.mjs; do
  printf '  %-26s ' "$f"
  if out=$(node "$f" 2>&1); then
    n=$(grep -c '^  ok' <<<"$out"); total=$((total+n)); echo "all passed ($n)"
  else
    echo "FAILED"; echo "$out" | grep -E '^FAIL' | sed 's/^/      /'; fail=1
  fi
done
for f in test/*.sh; do
  [[ "$(basename "$f")" == run-all.sh ]] && continue
  printf '  %-26s ' "$f"
  out=$(bash "$f" 2>&1); rc=$?
  # The VERDICT line, never the last line — they are not the same thing.
  v=$(grep -E '^passed=' <<<"$out" | tail -1)
  [[ -z "$v" ]] && { echo "NO VERDICT LINE — suite did not reach its summary"; fail=1; continue; }
  n=$(sed 's/passed=\([0-9]*\).*/\1/' <<<"$v"); total=$((total+n))
  echo "$v"
  [[ "$rc" -eq 0 ]] || { echo "$out" | grep -E '^FAIL' | sed 's/^/      /'; fail=1; }
done

echo
echo "TOTAL ASSERTIONS: $total"
[[ "$fail" -eq 0 ]] && echo "ALL GREEN" || echo "SOMETHING FAILED"
exit $fail
