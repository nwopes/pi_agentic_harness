# Habit Tracker demo task

The gradable task for the Foreman comparison. Every mode gets the same `SPEC.md` and starts from a copy of `fixture/`. The hidden tests are added only at grading time.

| Path | What it is |
|---|---|
| `SPEC.md` | The prompt given verbatim to every model: the exact API and UI contract. |
| `fixture/` | Starter repo: Vite + React 19 + TypeScript frontend, Express 4 backend (`createApp()` with only `/api/health`), Vitest + supertest + Testing Library + jsdom, pinned versions, and `package-lock.json`. Scripts: `dev`, `build`, `typecheck`, `test`, `start`. Contains no habit code and no hidden tests. |
| `hidden-tests/` | 12 API tests (`api.hidden.test.ts`, vitest + supertest) and 8 UI tests (`ui.hidden.test.tsx`, Testing Library + jsdom with an in-memory fake `fetch`). Also a self-contained `vitest.hidden.config.mjs` and `manifest.json` (the fixed list of 20 test names). **Never copy this folder into a workspace.** |
| `grade.sh` | The grader (see below). |
| `verification/` | Grader output for the reference implementation and for the untouched fixture. |

## Grading

```bash
bash demo-tasks/habit-tracker/grade.sh <workspace-dir> <output-json-path>
```

- Copies the workspace without `node_modules`, `dist` or `.git` to a temp dir. The workspace itself is never modified.
- Adds the hidden tests and runs `npm install`. If that fails, it retries without the lockfile.
- Makes sure `vitest`, `supertest`, `jsdom` and `@testing-library/*` are present at the fixture's pinned versions (`npm install --no-save`).
- Runs Vitest with the hidden config and the JSON reporter, with `TZ=UTC`. The tests fake only `Date`, so "today" is fixed.
- Writes `{ passed, failed, total, durationMs, tests: [{ name, file: "api"|"ui", status }], error }`. `durationMs` is the wall time of the whole grading run, including the install.
- `total` always comes from `hidden-tests/manifest.json` (20), so a workspace that fails to install or import scores 0/20 (or 8/20, and so on), never 0/0. `error` says why: the install failure, a suite import error, or a manifest mismatch. It is `null` on a clean run.
- Exits 0 whenever grading ran, whatever the score. It exits non-zero only when the grader itself could not run (bad arguments, missing node/npm, missing workspace).
- Optional: `GRADE_LOG=<path>` keeps the full install and test log. `GRADE_STEP_TIMEOUT` sets the timeout in seconds for each install or test step (default 900).
- Needs `bash`, `node` and `npm`. It works in Git Bash on Windows and in bash on Linux/macOS. One run takes about 1.5 to 2.5 minutes, mostly `npm install`.

## Verified scores

These numbers come straight from the grader output in `verification/`:

| Workspace | Score | `error` |
|---|---|---|
| Reference implementation (written from `SPEC.md` only, kept outside the repo, then deleted) | **20/20** (`verification/reference.json`) | `null` |
| Untouched `fixture/` | **0/20** (`verification/fixture.json`) | `null` |

Each was graded twice and got the same per-test results both times.
