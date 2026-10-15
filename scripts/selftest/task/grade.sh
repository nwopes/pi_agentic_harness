#!/usr/bin/env bash
# Stub grader for the Foreman self-test. Same interface as demo-tasks/<task>/grade.sh:
#   grade.sh <workspace-dir> <output-json>  -> writes { passed, failed, total, durationMs, tests, error }, exit 0.
set -euo pipefail
WS="$1"
OUT="$2"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -r "$HERE/hidden-tests" "$WS/hidden-tests"
total=20
passed=0
if [ -f "$WS/.stub-score" ]; then passed="$(tr -dc '0-9' < "$WS/.stub-score")"; fi
failed=$((total - passed))
printf '{"passed":%d,"failed":%d,"total":%d,"durationMs":%d,"tests":[{"name":"stub","file":"hidden-tests/stub.test.js","status":"%s"}],"error":null}\n' \
  "$passed" "$failed" "$total" 5 "$([ "$passed" -gt 0 ] && echo passed || echo failed)" > "$OUT"
echo "stub grade: $passed/$total"
