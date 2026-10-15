# pi_agentic_harness — Foreman MVP

Cheap models doing frontier-quality work. A strong **lead** model plans in `BOARD.md` and delegates to cheaper **worker** models (frontend, backend, tests), using [Pi](https://pi.dev) with OpenRouter. This repo is **one Pi package** (Foreman) that adds lead mode to Pi, plus a `compare` runner that runs the same task in several modes, grades every run with hidden acceptance tests, and reports cost and quality from logs only.

- **Spec:** [`prd_mvp.md`](prd_mvp.md)
- **Verified facts, deviations and the live-run log:** [`NOTES.md`](NOTES.md). Read this before changing any Pi flag.
- **Demo talk track:** [`demo/SCRIPT.md`](demo/SCRIPT.md)

## Status

| Milestone | State |
|---|---|
| 0: orchestration | Verified live through the Foreman package (`harness-lite`, Haiku lead, `--orchestrate`): backend ran on MiniMax M3 and frontend on Kimi K2.7 Code (OpenRouter generation records), for $0.0051. **Open:** the same check with the Opus lead (needs more OpenRouter credit), and the interactive TUI run. |
| 1: task and hidden tests | `demo-tasks/habit-tracker`: reference implementation 20/20 (since deleted), empty fixture 0/20, stable across repeated grading. |
| 2: compare runner | Built; the stub self-test passes. **No live comparison has been run yet.** |
| 3: quality boosters | Not started; only needed if Milestone 2 shows a quality gap. |

## The Foreman Pi package

| | What it does |
|---|---|
| `/orchestrate [on\|off]` | Toggles lead mode in the current session (no argument flips it). **On:** the lead instructions ([`foreman/LEAD.md`](foreman/LEAD.md)) are added to the system prompt and the `subagent` tool is active. **Off:** both are gone, and Pi works alone. The setting is saved in the session, so resuming keeps it. |
| `--orchestrate` | Starts Pi with lead mode on. Used for headless runs and by the compare runner, so the demo and the measured runs share one setup. |
| `/team` | Shows the lead's model (this session's model) and each worker's model, and whether lead mode is on. |

Workers are defined in [`foreman/agents/`](foreman/agents/) (`frontend`, `backend`, `tests`, each with `model:` in its frontmatter). Delegation uses [`@mjakl/pi-subagent`](https://www.npmjs.com/package/@mjakl/pi-subagent) 3.1.0, declared as a normal npm dependency. Depth is capped at 1, so workers can't delegate further.

### Install

Pi 1.2 syntax, from Pi's `docs/packages.md`. Both forms were tested with Pi 1.2.0.

```bash
# from a local path (absolute, or relative to where you run it). Pi does not install dependencies for local
# packages, so run `npm ci` in the repo first.
pi install C:/path/to/pi_agentic_harness
pi install ./                         # from inside the repo

# from git. Pi clones the repo and runs `npm install --omit=dev`, which fetches @mjakl/pi-subagent.
pi install git:github.com/nwopes/pi_agentic_harness
pi install git:github.com/nwopes/pi_agentic_harness@<tag-or-commit>   # pinned
pi install https://github.com/nwopes/pi_agentic_harness              # same thing

pi -e C:/path/to/pi_agentic_harness   # one session only, without installing
```

`pi remove <same source>` uninstalls it. Pi can't install a *subfolder* of a git repo, so the repo root's `package.json` is the package manifest. It loads exactly three files, in this order: `foreman/orchestrate.ts` → `@mjakl/pi-subagent` → `foreman/prompt.ts`. Nothing else in the repo (for example `extensions/freellmapi`) is loaded.

### Good to know

- **Don't also install `@mjakl/pi-subagent` separately** in the same agent dir. Two copies both register `subagent`, and Pi refuses to start.
- **Workers are copied into `<agentDir>/agents/`** at startup. `@mjakl/pi-subagent` only looks there, and has no hook for other packages. The copies carry a `managed-by: pi-foreman` line and are refreshed on every start. A file of the same name *without* that line is yours: it is never overwritten, it overrides that worker, and `/team` says so.
- **`--orchestrate` placement:** don't put a prompt right after it (`pi --orchestrate "task"`). Pi would read the prompt as the flag's value. Put the flag before another option or after the prompt, or pipe the prompt on stdin, as the runner does.
- `--orchestrate=false` still turns lead mode **on**; leave the flag out instead.
- Pi's own footer and `/session` cost **exclude** worker spend (see NOTES.md).

## Modes (Pi config profiles in `pi-config/`)

| Mode | Lead / solo model | Workers | Setup | Use |
|---|---|---|---|---|
| `harness` | `anthropic/claude-opus-5.5` | frontend `moonshotai/kimi-k2.7-code`, backend `minimax/minimax-m3`, tests `anthropic/claude-haiku-5.5` | Foreman package + `--orchestrate` | measurement |
| `strong-solo` | `anthropic/claude-opus-5.5` | none | neutral `AGENTS.md`, no package | measurement baseline |
| `cheap-solo` | `moonshotai/kimi-k2.7-code` | none | neutral `AGENTS.md`, no package | measurement baseline |
| `harness-lite` | `anthropic/claude-haiku-5.5`, all outputs capped at 16k tokens | same as `harness` | Foreman package + `--orchestrate` | cheap rehearsals (cents) |
| `harness-free` | FreeLLMAPI `auto:smart` | FreeLLMAPI `auto:smart` / `auto:fast` | — | **incomplete, not part of the comparison**; see NOTES.md |

The `harness` profiles load the package with `"packages": ["../.."]` (the repo root) in their `settings.json`. The runner checks every harness run's own event log for proof that lead mode was really on (a `foreman-lead-applied` entry and an active `subagent` tool). A run without that proof is flagged `LEAD_MODE_MISSING` and excluded as a setup failure to re-run.

### Free models through FreeLLMAPI (optional, separate)

[`extensions/freellmapi`](extensions/freellmapi/README.md) adds a `/login-with-freellm` command. It is a separate extension, not part of the Foreman package, and never used in the comparison.

## Setup (Windows, Git Bash)

Pi 1.2.0 needs Node 22.19 or newer. It runs on an fnm-installed Node 22.23.3, so the system Node is untouched. The full commands are in NOTES.md under "Setup command".

```bash
npm ci                                  # runner deps + @mjakl/pi-subagent (the package's dependency)
cp .env.example .env                    # then set OPENROUTER_API_KEY (Pi does not read .env; the runner does)
```

The `harness` profiles need nothing else: their `settings.json` already points at this repo.

OpenRouter reserves `max_tokens × output price` before every request. Opus requests need about $3 of headroom on both the account balance and the key limit. The runner checks this before each run (`minHeadroomUsd`, default $5).

## Commands

```bash
npm run selftest                        # whole pipeline with a stub Pi, $0
npm run compare -- --task habit-tracker --modes harness,strong-solo,cheap-solo --runs 2
npm run report -- --task habit-tracker  # rebuild results/ from runs/ logs only
bash demo-tasks/habit-tracker/grade.sh <workspace> <out.json>
node foreman/test/rpc-orchestrate-test.mjs <pi-node> <pi-cli>   # package behaviour, offline, $0
```

## Layout

```
package.json    runner scripts AND the Pi package manifest ("pi" field, dependencies)
foreman/        the Pi package: orchestrate.ts, prompt.ts, shared.ts, LEAD.md, agents/*.md, test/
pi-config/      Pi agent dirs, one per mode (settings.json, models.json, neutral AGENTS.md for solo)
demo-tasks/     habit-tracker (SPEC.md, fixture/, hidden-tests/, grade.sh) and quick (live-demo task)
scripts/        compare.ts, report.ts, screenshots.ts, lib/, selftest/
extensions/     optional extras outside the package (freellmapi)
results/        generated report.md, results.json, index.html (committed)
runs/           generated per-run logs (gitignored)
```
