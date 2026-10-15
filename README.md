# Foreman for Pi

A [Pi](https://pi.dev) package that turns Pi into a small team. A strong **lead** model plans in `BOARD.md` and delegates to cheaper or free **worker** models (frontend, backend, tests), then checks their work itself. Workers can run on paid OpenRouter models, free OpenRouter models or [FreeLLMAPI](extensions/freellmapi/README.md). Workers on free models can split their task among sub-workers. A built-in website guide teaches workers to build a clean, modern site without consulting a big model.

- **Verified Pi facts and design notes:** [`NOTES.md`](NOTES.md). Read this before changing a Pi flag or hook.
- **Status:** delegation was verified live with a Haiku lead (`--orchestrate`): the backend ran on MiniMax M3 and the frontend on Kimi K2.7 Code, according to OpenRouter's generation records, for about half a cent. Everything else, including free workers, sub-workers and FreeLLMAPI routing, is covered by offline tests (`npm run check`). Not yet verified live: an Opus lead, free OpenRouter or FreeLLMAPI workers against the real services, and the interactive TUI.
- The earlier MVP benchmark (compare runner, habit-tracker task with hidden tests, demo script, PRD) is preserved at git tag [`mvp-benchmark`](https://github.com/nwopes/pi_agentic_harness/tree/mvp-benchmark).

## What it adds to Pi

| | What it does |
|---|---|
| `/orchestrate [on\|off]` | Toggles lead mode in the current session (no argument flips it). **On:** the lead instructions ([`foreman/LEAD.md`](foreman/LEAD.md)) are added to the system prompt and the `subagent` tool is active. **Off:** both are gone, and Pi works alone. The setting is saved in the session, so resuming keeps it. |
| `--orchestrate` | Starts Pi with lead mode on, e.g. for headless `--mode json` runs. |
| `/workers` | Chooses what the workers run on: `paid` (default), `free` or `freellm`; one worker's model; how deep free workers may delegate. See [Workers](#workers-paid-free-or-freellmapi) below. |
| `/team` | Shows the lead's model (this session's model), each worker's model as `/workers` set it (and whether it's free), the sub-worker depth, and where the OpenRouter key comes from. |
| **Website guide** | A Pi skill, [`foreman/skills/website`](foreman/skills/website/SKILL.md), that walks a worker through building a clean, modern site step by step: themes with fixed values, components, copy rules and a checker script. For website tasks the lead tells the UI workers to follow it, and the frontend worker's instructions name it too. |
| **Paste your OpenRouter key** | Paste the key (`sk-or-v1-…`) into Pi's prompt and send it. Pi saves it and **never sends it to a model**: the message stops at the extension, whichever model is selected. The key goes into `<agentDir>/auth.json` through Pi's own credential store, the same place `/login openrouter` writes. The lead and every worker use it from then on, with no environment variable needed. Pi checks it with OpenRouter's key-info call first and refuses one that OpenRouter rejects. `/logout` removes it. |

Workers are defined in [`foreman/agents/`](foreman/agents/) (`frontend`, `backend`, `tests`; the `model:` there is the paid default). Delegation uses [`@mjakl/pi-subagent`](https://www.npmjs.com/package/@mjakl/pi-subagent) 3.1.0, declared as a normal npm dependency.

## Workers: paid, free, or FreeLLMAPI

| Command | Workers run on | Cost |
|---|---|---|
| `/workers paid` (default) | the pinned models in `foreman/agents/` (Kimi K2.7 Code, MiniMax M3, Haiku 5.5) via OpenRouter | paid |
| `/workers free` | free OpenRouter models ([`foreman/workers.json`](foreman/workers.json): north-mini-code, laguna-s-2.1, gemma-4-31b; all `:free`) | $0, rate-limited by OpenRouter |
| `/workers freellm` | FreeLLMAPI `auto:smart` (tests: `auto:fast`); needs `/login-with-freellm` | $0 |

- **`/workers` on its own** opens a list: a preset, *Change one worker's model…*, or *Sub-worker depth…*.
- **One worker's model:** `/workers frontend openrouter/<model>:free` changes just that worker within the current preset, and `/workers frontend default` undoes it. The free preset accepts only $0 models, and freellm only `freellmapi/…` ones. To customise paid models, `/workers paid` first.
- **Sub-workers (multilevel):** a worker whose own model is free may split its task among sub-workers, which run on that same free model, so nesting never adds cost. Paid workers never delegate.
  - `/workers depth 1` turns sub-workers off; `2` (the default) allows them; `3` lets sub-workers use their own.
  - Lowering the depth applies to the next worker. Raising it above what Pi started with needs a restart, because pi-subagent fixes its ceiling at startup.
- **Never a silent fallback to paid models.** If a worker's model isn't available, delegation stops and the lead is told why. That happens when FreeLLMAPI isn't connected, there's no OpenRouter key, or a free model was retired.
- **A FreeLLMAPI lead keeps paid workers off:** with the `paid` preset and a `freellmapi/…` lead, the workers follow the lead, so nothing reaches OpenRouter.
- **The setting is saved** in `<agentDir>/foreman-workers.json` and applies from the next delegation. `/team` always shows the effective models.
- **Free model churn:** OpenRouter's free list changes often. The defaults were picked on 2026-10-16 from what was free and could call tools, judged by name and specs only. `/team` flags a default that disappears as NOT AVAILABLE; pick another with `/workers <worker> <model>`.
- **Rate limits:** I believe free OpenRouter models are limited to roughly 20 requests a minute plus a daily cap that depends on whether you've bought credits. Lead mode with sub-workers makes many requests, so check OpenRouter's current limits.

## Install

Pi 1.2 syntax, from Pi's `docs/packages.md`. Every form was tested with Pi 1.2.0.

```bash
pi install git:github.com/nwopes/pi_agentic_harness                  # Pi clones it and runs `npm install --omit=dev`
pi install git:github.com/nwopes/pi_agentic_harness@<tag-or-commit>   # pinned
pi install https://github.com/nwopes/pi_agentic_harness              # same as the first

pi install C:/path/to/pi_agentic_harness   # local path; Pi doesn't install deps for these, so `npm ci` in the repo first
pi -e C:/path/to/pi_agentic_harness        # one session only, without installing

pi update git:github.com/nwopes/pi_agentic_harness   # pull the latest (plain `pi update` updates Pi itself)
pi remove git:github.com/nwopes/pi_agentic_harness
```

Pi can't install a *subfolder* of a git repo, so the repo root's `package.json` is the package manifest. It loads five extension files, in this order: `foreman/orchestrate.ts` → `@mjakl/pi-subagent` → `foreman/prompt.ts` → `foreman/keys.ts` → `foreman/workers.ts`. It also loads one skill directory, `foreman/skills`. `extensions/freellmapi` is not part of it.

### Good to know

- **Don't also install `@mjakl/pi-subagent` separately** in the same agent dir. Two copies both register `subagent`, and Pi refuses to start.
- **Workers are copied into `<agentDir>/agents/`** at startup. `@mjakl/pi-subagent` only looks there, and has no hook for other packages. The copies carry a `managed-by: pi-foreman` line and are refreshed on every start. A file of the same name *without* that line is yours: it is never overwritten, it overrides that worker, and `/team` says so.
- **`--orchestrate` placement:** don't put a prompt right after it (`pi --orchestrate "task"`). Pi would read the prompt as the flag's value. Put the flag before another option or after the prompt, or pipe the prompt on stdin.
- `--orchestrate=false` still turns lead mode **on**; leave the flag out instead.
- **A saved key beats `OPENROUTER_API_KEY`.** Tested: with both present, Pi sends the saved one, and `/team` says so.
- **OpenRouter reserves `max_tokens × output price` before every request** and refuses it (402) if your balance can't cover that. Uncapped worker models can need more than a dollar of headroom per request. The `pi-config/dev` profile below caps outputs at 16k tokens, which brings that down to cents.
- Pi's own footer and `/session` cost **exclude** worker spend (see NOTES.md).
- **Windows:** if `pi install git:…` fails with `fetch-pack: invalid index-pack output`, the agent dir's path is too long for git; the 260-character limit applies while `core.longpaths` is off. Use a shorter agent dir or run `git config --global core.longpaths true`. The default `~/.pi/agent` is fine.

## Free models through FreeLLMAPI (optional, separate extension)

[`extensions/freellmapi`](extensions/freellmapi/README.md) adds `/login-with-freellm`, which connects Pi to a self-hosted [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) router. Install it on its own: `pi install <repo>/extensions/freellmapi`.

- **Workers on FreeLLMAPI:** `/workers freellm`, while your lead stays on the model you picked.
- **Everything on FreeLLMAPI:** `/freellm all`. It puts the lead on FreeLLMAPI at every start (saved), and with the `paid` preset the workers follow it. `/freellm off` switches back.

Pi sends each provider only its own key, so your OpenRouter key never goes to FreeLLMAPI.

## Develop

Pi 1.2 needs Node 22.19 or newer (here: an fnm-installed Node 22.23.3; the system Node can stay older).

```bash
npm ci              # @mjakl/pi-subagent (the package's dependency) + TypeScript for the typecheck
npm run check       # typecheck against the installed Pi's types, then every offline test ($0, no network)
npm run typecheck   # typecheck only
```

`npm run check` finds Pi via `PI_CLI` (and optionally `PI_NODE`), then `pi` on PATH, then an fnm-installed Node. Pi is deliberately **not** a dependency: Pi's docs say a physical copy can bypass its extension module mapping. The tests:

| Test | Checks |
|---|---|
| `foreman/test/rpc-orchestrate-test.mjs` | Lead mode off by default, `/orchestrate` on/off, `/team`, `--orchestrate`, workers never lead, the depth ceiling, resume keeps the toggle, and the website guide path in the lead and frontend prompts (13) |
| `foreman/test/rpc-keys-test.mjs` | A pasted key is saved and never sent, is used at once and by new processes, and wins over the env var (11) |
| `foreman/test/rpc-workers-test.mjs` | Where the lead, the workers and the sub-workers really send requests under `/workers paid/free/freellm`, a per-worker model, depth 1, a FreeLLMAPI lead, not-connected blocking, the pickers, and `/freellm all/off` (24) |
| `extensions/freellmapi/test/rpc-login-test.mjs` | The `/login-with-freellm` flows against a mock FreeLLMAPI (3) |

Each test drives Pi over RPC against local stand-ins and checks what Pi actually sends.

**Run the package from the repo without installing it:** `pi-config/dev` is a Pi agent dir that loads this repo (`"packages": ["../.."]`), defaults to a Haiku lead, and caps every model's output at 16k tokens:

```bash
PI_CODING_AGENT_DIR=<repo>/pi-config/dev pi --orchestrate
```

Paste your OpenRouter key into that session once; it is saved in `pi-config/dev/auth.json`, which is gitignored like all of Pi's runtime state there.

## Layout

```
package.json          Pi package manifest ("pi" field, dependencies) and the dev scripts
foreman/              the package: orchestrate.ts (/orchestrate, --orchestrate, /team), workers.ts (/workers, routing,
                      sub-workers), prompt.ts (lead/sub-lead prompts), keys.ts (paste-to-save key), team.ts, shared.ts,
                      LEAD.md, SUBLEAD.md, workers.json (presets), agents/*.md, skills/website/, test/
extensions/freellmapi/  optional FreeLLMAPI provider + /login-with-freellm, with its tests and mock server
pi-config/dev/        agent dir for running the package from the repo (16k output caps)
scripts/check.mjs     typecheck + all offline tests
NOTES.md              verified Pi facts, design decisions, what is and isn't verified
```
