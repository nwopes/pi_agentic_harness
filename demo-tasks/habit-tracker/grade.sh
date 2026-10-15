#!/usr/bin/env bash
# Grade a habit-tracker workspace against the hidden acceptance tests.
#
#   usage: grade.sh <workspace-dir> <output-json-path>
#
# The workspace is never modified: it is copied (without node_modules, dist, .git)
# to a fresh temp dir, the hidden tests are added there, dependencies are installed,
# and Vitest runs with hidden-tests/vitest.hidden.config.mjs and TZ=UTC.
#
# Output JSON:
#   { "passed": n, "failed": n, "total": N, "durationMs": n,
#     "tests": [{ "name": "...", "file": "api|ui", "status": "passed|failed" }],
#     "error": string|null }
# "total" always equals the number of tests in hidden-tests/manifest.json, so a
# workspace that fails to install or load scores 0/N.
#
# Exit status: 0 whenever grading ran (whatever the score); non-zero only if the
# grader itself could not run (bad arguments, missing node/npm, unwritable output...).
# Optional env: GRADE_LOG=<path> keeps a copy of the full install/test log.
# Works under Git Bash on Windows and plain bash on Linux/macOS. Requires node + npm.

set -uo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <workspace-dir> <output-json-path>" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HIDDEN_DIR="$SCRIPT_DIR/hidden-tests"
FIXTURE_PKG="$SCRIPT_DIR/fixture/package.json"
HIDDEN_NAME="__hidden_tests__"
STEP_TIMEOUT_SECONDS="${GRADE_STEP_TIMEOUT:-900}"

for tool in node npm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "grade.sh: '$tool' not found on PATH" >&2
    exit 2
  fi
done
if [ ! -f "$HIDDEN_DIR/manifest.json" ] || [ ! -f "$FIXTURE_PKG" ]; then
  echo "grade.sh: hidden-tests/manifest.json or fixture/package.json missing next to grade.sh" >&2
  exit 2
fi

# Paths handed to node must be native on Windows (C:/...); elsewhere they are unchanged.
native() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s\n' "$1"; fi
}

OUT_DIR="$(dirname "$2")"
mkdir -p "$OUT_DIR" || { echo "grade.sh: cannot create $OUT_DIR" >&2; exit 2; }
OUT="$(cd "$OUT_DIR" && pwd)/$(basename "$2")"

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/foreman-grade.XXXXXX")" || { echo "grade.sh: mktemp failed" >&2; exit 2; }
cleanup() {
  cd / 2>/dev/null || true
  rm -rf "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT TERM

GRADER="$TMP_ROOT/grader"
WORK="$TMP_ROOT/ws"
mkdir -p "$GRADER" "$WORK"
LOG="$GRADER/grade.log"
ERRORS="$GRADER/errors.txt"
REPORT="$GRADER/vitest-report.json"
HELPER="$GRADER/helper.mjs"
: >"$LOG"
: >"$ERRORS"

cat >"$HELPER" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const [cmd, ...args] = process.argv.slice(2);

function tail(file, lines = 30) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

if (cmd === 'now') {
  process.stdout.write(String(Date.now()));
} else if (cmd === 'copy') {
  // Copy a workspace without node_modules (any depth), top-level dist/.git, or a stale hidden dir.
  const [src, dst, hiddenName] = args;
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (p) => {
      const rel = path.relative(src, p);
      if (!rel) return true;
      const parts = rel.split(/[\\/]/);
      const base = parts[parts.length - 1];
      if (base === 'node_modules') return false;
      if (parts.length === 1 && ['dist', '.git', hiddenName].includes(base)) return false;
      return true;
    },
  });
} else if (cmd === 'missing-deps') {
  // Print "name@version" for each grading dev dependency that is absent or not at the pinned version.
  const [fixturePkg, workDir] = args;
  const pinned = JSON.parse(fs.readFileSync(fixturePkg, 'utf8')).devDependencies || {};
  const wanted = Object.keys(pinned).filter(
    (n) => ['vitest', 'supertest', 'jsdom'].includes(n) || n.startsWith('@testing-library/'),
  );
  for (const name of wanted) {
    let version = null;
    try {
      version = JSON.parse(fs.readFileSync(path.join(workDir, 'node_modules', name, 'package.json'), 'utf8')).version;
    } catch {}
    if (version !== pinned[name]) console.log(`${name}@${pinned[name]}`);
  }
} else if (cmd === 'summarize') {
  const [manifestPath, reportPath, outPath, startMs, errorsPath, logPath, ranTests] = args;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const errors = fs.readFileSync(errorsPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  const fileKey = (name) => {
    const base = path.basename(String(name || ''));
    return base.startsWith('api.') ? 'api' : base.startsWith('ui.') ? 'ui' : base;
  };
  const results = new Map();
  if (ranTests === '1') {
    let report = null;
    if (fs.existsSync(reportPath)) {
      try {
        report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      } catch (e) {
        errors.push(`could not parse the vitest JSON report: ${e.message}`);
      }
    } else {
      errors.push(`vitest produced no JSON report. Log tail:\n${tail(logPath)}`);
    }
    for (const suite of report?.testResults ?? []) {
      const key = fileKey(suite.name);
      if (suite.status === 'failed' && suite.message) {
        errors.push(`${key} suite error: ${String(suite.message).split('\n').slice(0, 8).join('\n')}`);
      }
      for (const t of suite.assertionResults ?? []) {
        results.set(`${key}\u0000${t.title}`, t.status);
        if (t.fullName && t.fullName !== t.title) results.set(`${key}\u0000${t.fullName}`, t.status);
      }
    }
    if (report) {
      const known = new Set(manifest.tests.map((t) => `${t.file}\u0000${t.name}`));
      const unknown = [...results.keys()].filter((k) => !known.has(k));
      const notRun = manifest.tests.filter((t) => !results.has(`${t.file}\u0000${t.name}`));
      if (unknown.length) errors.push(`manifest mismatch: tests not in manifest: ${unknown.map((k) => k.replace('\u0000', ': ')).join(' | ')}`);
      if (notRun.length && notRun.length < manifest.tests.length && !errors.some((e) => e.includes('suite error'))) {
        errors.push(`tests missing from the report: ${notRun.map((t) => `${t.file}: ${t.name}`).join(' | ')}`);
      }
    }
  }
  const tests = manifest.tests.map((t) => ({
    name: t.name,
    file: t.file,
    status: results.get(`${t.file}\u0000${t.name}`) === 'passed' ? 'passed' : 'failed',
  }));
  const passed = tests.filter((t) => t.status === 'passed').length;
  const total = manifest.tests.length;
  const result = {
    passed,
    failed: total - passed,
    total,
    durationMs: Math.max(0, Date.now() - Number(startMs)),
    tests,
    error: errors.length ? errors.join('\n').slice(0, 6000) : null,
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`grade: ${passed}/${total} passed${result.error ? ' (with errors, see "error")' : ''}`);
} else {
  console.error(`helper: unknown command ${cmd}`);
  process.exit(2);
}
NODE

helper() { node "$(native "$HELPER")" "$@"; }

# Run a command with a wall-clock limit when GNU timeout is available.
with_timeout() {
  if timeout --version >/dev/null 2>&1; then
    timeout "$STEP_TIMEOUT_SECONDS" "$@"
  elif gtimeout --version >/dev/null 2>&1; then
    gtimeout "$STEP_TIMEOUT_SECONDS" "$@"
  else
    "$@"
  fi
}

START_MS="$(helper now)" || { echo "grade.sh: node failed to run" >&2; exit 2; }
RAN_TESTS=0

finish() {
  local code="$1"
  if [ -n "${GRADE_LOG:-}" ]; then cp "$LOG" "$GRADE_LOG" 2>/dev/null || true; fi
  if ! helper summarize "$(native "$HIDDEN_DIR/manifest.json")" "$(native "$REPORT")" "$(native "$OUT")" \
      "$START_MS" "$(native "$ERRORS")" "$(native "$LOG")" "$RAN_TESTS"; then
    echo "grade.sh: failed to write $OUT" >&2
    exit 2
  fi
  exit "$code"
}

log_tail() { tail -n 25 "$LOG" | tr -d '\r'; }

# 1. Copy the workspace.
if [ ! -d "$1" ]; then
  echo "workspace directory not found: $1" >>"$ERRORS"
  finish 2
fi
WS="$(cd "$1" && pwd)"
if ! helper copy "$(native "$WS")" "$(native "$WORK")" "$HIDDEN_NAME" >>"$LOG" 2>&1; then
  { echo "copying the workspace failed:"; log_tail; } >>"$ERRORS"
  finish 0
fi

# 2. Add the hidden tests; drop files that could redirect Vitest away from them.
rm -rf "$WORK/$HIDDEN_NAME"
mkdir -p "$WORK/$HIDDEN_NAME"
cp -R "$HIDDEN_DIR/." "$WORK/$HIDDEN_NAME/"
rm -f "$WORK"/vitest.workspace.* "$WORK"/vitest.projects.*

cd "$WORK" || exit 2
export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false

# 3. Install the workspace's dependencies (retry without the lockfile if it is stale or broken).
echo "== npm install" >>"$LOG"
if ! with_timeout npm install --no-audit --no-fund --loglevel=error >>"$LOG" 2>&1; then
  echo "== npm install failed; retrying without package-lock.json" >>"$LOG"
  rm -rf node_modules package-lock.json
  if ! with_timeout npm install --no-audit --no-fund --loglevel=error >>"$LOG" 2>&1; then
    { echo "npm install failed:"; log_tail; } >>"$ERRORS"
    finish 0
  fi
fi

# 4. Make sure the grading dev dependencies exist at the fixture's pinned versions.
MISSING="$(helper missing-deps "$(native "$FIXTURE_PKG")" "$(native "$WORK")" | tr -d '\r' | tr '\n' ' ')"
if [ -n "${MISSING// /}" ]; then
  echo "== installing grading deps: $MISSING" >>"$LOG"
  # shellcheck disable=SC2086
  if ! with_timeout npm install --no-save --no-audit --no-fund --loglevel=error $MISSING >>"$LOG" 2>&1; then
    # shellcheck disable=SC2086
    if ! with_timeout npm install --no-save --no-audit --no-fund --loglevel=error --legacy-peer-deps $MISSING >>"$LOG" 2>&1; then
      { echo "warning: could not install grading deps ($MISSING):"; log_tail; } >>"$ERRORS"
    fi
  fi
fi

# 5. Run the hidden tests.
VITEST_BIN="node_modules/vitest/vitest.mjs"
if [ ! -f "$VITEST_BIN" ]; then
  echo "vitest is not installed in the workspace copy" >>"$ERRORS"
  finish 0
fi
echo "== vitest" >>"$LOG"
RAN_TESTS=1
TZ=UTC CI=true NO_COLOR=1 FORCE_COLOR=0 with_timeout node "$VITEST_BIN" run \
  --config "$HIDDEN_NAME/vitest.hidden.config.mjs" \
  --reporter=default --reporter=json --outputFile.json="$(native "$REPORT")" >>"$LOG" 2>&1
VITEST_STATUS=$?
echo "== vitest exit status $VITEST_STATUS" >>"$LOG"
if [ "$VITEST_STATUS" -eq 124 ]; then
  echo "vitest timed out after ${STEP_TIMEOUT_SECONDS}s" >>"$ERRORS"
fi

finish 0
