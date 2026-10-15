# Demo script — Foreman (5 minutes)

> Talk track for the live demo. Every number you say on stage comes from `results/index.html`
> (generated from run logs). Never quote a number that isn't on that page.

## Before you go on stage

- [ ] Full comparison was pre-run the day before (`npm run compare -- --task habit-tracker --modes harness,strong-solo,cheap-solo --runs 2`). Never run the 20-minute task live.
- [ ] `results/index.html` opens locally and shows all runs, including bad ones.
- [ ] A backup screen recording of a successful `quick` run is on the desktop.
- [ ] Model IDs are unchanged since the measurement runs (check `foreman.config.json` and `pi-config/harness/agents/*.md` against `git log`).
- [ ] `OPENROUTER_API_KEY` is set and has credit. A fresh copy of the fixture is ready for the live task (see step 2).
- [ ] Terminal font is large; the OpenRouter activity page is open in a browser tab.

---

## 1. The problem — 30s

> "Frontier models write great code, and they're expensive. Cheap models are cheap and
> unreliable. Can we get frontier-quality results while paying mostly cheap-model prices?
>
> Foreman tries the obvious management answer: one expensive lead that plans, writes the contract
> and checks the work, and a team of cheap workers that do the typing."

## 2. Live — 2 min

Run the short task in Pi, in harness mode:

Run it in **Windows Terminal**: Git Bash's default mintty window may not give Pi a real console (see NOTES.md, "Windows specifics").

```bash
# from a fresh copy of the habit-tracker fixture (see demo-tasks/quick/SPEC.md for the expected directory)
REPO=C:/Users/Akshat/Desktop/pi_agentic_harness
PI_NODE=C:/Users/Akshat/AppData/Roaming/fnm/node-versions/v22.23.3/installation/node.exe
PI_CLI=C:/Users/Akshat/AppData/Roaming/fnm/node-versions/v22.23.3/installation/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
export OPENROUTER_API_KEY="$(grep -E '^OPENROUTER_API_KEY=' "$REPO/.env" | head -1 | cut -d= -f2- | tr -d '\r"')"

# on stage: the measured configuration (Opus lead) from the Foreman package; the same setup as `npm run compare`
PI_CODING_AGENT_DIR="$REPO/pi-config/harness" "$PI_NODE" "$PI_CLI" \
  --model openrouter/anthropic/claude-opus-5.5 --no-skills --orchestrate

# rehearsals: same package and workers, Haiku lead, 16k output cap (a hello-world delegation cost $0.005)
PI_CODING_AGENT_DIR="$REPO/pi-config/harness-lite" "$PI_NODE" "$PI_CLI" \
  --model openrouter/anthropic/claude-haiku-5.5 --no-skills --orchestrate
```

Keep `--orchestrate` last (or before another option): a prompt typed right after it would be swallowed as its value.
Alternatively start without it and type `/orchestrate` on stage. Switching lead mode on live is a nice beat.

The Pi footer's cost excludes worker spend (NOTES.md). Don't quote it on stage.

First type `/team`. It shows the lead's model and each worker's model: "One expensive lead, three cheap workers from three vendors."

Paste the contents of `demo-tasks/quick/SPEC.md` as the request. While it runs, narrate:

- **BOARD.md appears first.** "The lead doesn't write code yet. It writes the plan, the API contract and
  a task list with an owner for each task. Workers know nothing except what's written here."
- **Delegation.** Point at the subagent calls: "Frontend goes to Kimi, backend to MiniMax, tests to Haiku,
  in parallel where possible. Different vendors, a fraction of the price."
- **Verification.** "When workers report back, the lead runs the build and typecheck itself. Worker
  summaries are treated as data, not truth. If the build fails, the same worker gets the exact error."
- Optional: flip to the OpenRouter activity tab to show requests landing on each worker model.

If anything stalls for more than 30 seconds, switch to the backup recording without comment.

## 3. The numbers — 2 min

Open `results/index.html`.

1. **Tests passed by mode.** "Same spec, same hidden acceptance tests (about 20: API validation, streak
   edge cases and UI behaviour). No model ever saw them." Read the pass counts off the chart.
2. **Cost by mode.** "Cost of record is the OpenRouter key's spend before and after each run, so every
   worker call is included." Read the headline sentence at the top of the page exactly as written.
3. **Harness cost by role.** "Here's where the money went: lead versus each worker." Point out the lead's share.
4. **Honesty.** Mention the number of runs per mode, and point out any bad run or any flagged
   cost-source disagreement rather than skipping it.

## 4. How it works — 30s

> "Four ingredients: a strong lead, written contracts, cheap workers, and deterministic checks.
> The lead never trusts a worker's word, only the build, the typecheck and the tests. That's what
> lets cheap models do work you'd otherwise pay frontier prices for.
> Everything you saw is open source: Pi, an off-the-shelf subagent extension, and a few markdown files."
