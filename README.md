# pi_agentic_harness — Foreman MVP

Cheap models doing frontier-quality work. A strong **lead** model plans in `BOARD.md` and delegates to cheaper **worker** models (frontend, backend, tests), using [Pi](https://pi.dev) with OpenRouter and the `@mjakl/pi-subagent` extension. A `compare` runner runs the same task in several modes, grades every run with hidden acceptance tests, and reports cost and quality from logs only.

- **Spec:** [`prd_mvp.md`](prd_mvp.md)
- **Verified facts, deviations and the live-run log:** [`NOTES.md`](NOTES.md). Read this before changing any Pi flag.
- **Demo talk track:** [`demo/SCRIPT.md`](demo/SCRIPT.md)

## Status

| Milestone | State |
|---|---|
| 0: orchestration | Headless delegation verified live with `harness-lite`: backend ran on MiniMax M3, frontend on Kimi K2.7 Code (OpenRouter generation records), for $0.0059. **Open:** the same check with the Opus lead (needs more OpenRouter credit), and the interactive TUI run. |
| 1: task and hidden tests | `demo-tasks/habit-tracker`: reference implementation 20/20 (since deleted), empty fixture 0/20, stable across repeated grading. |
| 2: compare runner | Built; the stub self-test passes. **No live comparison has been run yet.** |
| 3: quality boosters | Not started; only needed if Milestone 2 shows a quality gap. |

## Modes (Pi config profiles in `pi-config/`)

| Mode | Lead / solo model | Workers | Use |
|---|---|---|---|
| `harness` | `anthropic/claude-opus-5.5` | frontend `moonshotai/kimi-k2.7-code`, backend `minimax/minimax-m3`, tests `anthropic/claude-haiku-5.5` | measurement |
| `strong-solo` | `anthropic/claude-opus-5.5` | none | measurement baseline |
| `cheap-solo` | `moonshotai/kimi-k2.7-code` | none | measurement baseline |
| `harness-lite` | `anthropic/claude-haiku-5.5`, all outputs capped at 16k tokens | same as `harness` | cheap rehearsals (cents) |
| `harness-free` | FreeLLMAPI `auto:smart` | FreeLLMAPI `auto:smart` / `auto:fast` | **incomplete**, see NOTES.md |

### Free models through FreeLLMAPI

[`extensions/freellmapi`](extensions/freellmapi/README.md) adds a `/login-with-freellm` command to Pi. It finds your local [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) router, gets a key (from the clipboard, a pasted key, or an email/password login that creates a separate revocable key for Pi), validates it, and switches Pi to a free model. Load it with `pi -e extensions/freellmapi`, or `pi install` it.

## Setup (Windows, Git Bash)

Pi 1.2.0 needs Node 22.19 or newer. It runs on an fnm-installed Node 22.23.3, so the system Node is untouched. The full commands are in NOTES.md under "Setup command".

```bash
npm ci                                  # runner deps (tsx, typescript)
cp .env.example .env                    # then set OPENROUTER_API_KEY (Pi does not read .env; the runner does)
# install Pi + the subagent extension into each harness profile: see NOTES.md "Setup command"
```

OpenRouter reserves `max_tokens × output price` before every request. Opus requests need about $3 of headroom on both the account balance and the key limit. The runner checks this before each run (`minHeadroomUsd`, default $5).

## Commands

```bash
npm run selftest                        # whole pipeline with a stub Pi, $0
npm run compare -- --task habit-tracker --modes harness,strong-solo,cheap-solo --runs 2
npm run report -- --task habit-tracker  # rebuild results/ from runs/ logs only
bash demo-tasks/habit-tracker/grade.sh <workspace> <out.json>
```

## Layout

```
pi-config/      Pi agent dirs, one per mode (LEAD.md, agents/*.md, settings.json, models.json)
demo-tasks/     habit-tracker (SPEC.md, fixture/, hidden-tests/, grade.sh) and quick (live-demo task)
scripts/        compare.ts, report.ts, screenshots.ts, lib/, selftest/
results/        generated report.md, results.json, index.html (committed)
runs/           generated per-run logs (gitignored)
```
