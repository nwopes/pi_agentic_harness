# Foreman for Pi

A [Pi](https://pi.dev) package that turns Pi into a small team. A strong **lead** model plans in `BOARD.md` and delegates to cheaper **worker** models (frontend, backend, tests) through OpenRouter, then checks their work itself.

- **Verified Pi facts and design notes:** [`NOTES.md`](NOTES.md). Read this before changing a Pi flag or hook.
- **Status:** delegation was verified live with a Haiku lead (`--orchestrate`): the backend ran on MiniMax M3 and the frontend on Kimi K2.7 Code, according to OpenRouter's generation records, for about half a cent. Everything else is covered by offline tests (`npm run check`). Not yet verified live: an Opus lead (it needs more OpenRouter credit) and the interactive TUI.
- The earlier MVP benchmark (compare runner, habit-tracker task with hidden tests, demo script, PRD) is preserved at git tag [`mvp-benchmark`](https://github.com/nwopes/pi_agentic_harness/tree/mvp-benchmark).

## What it adds to Pi

| | What it does |
|---|---|
| `/orchestrate [on\|off]` | Toggles lead mode in the current session (no argument flips it). **On:** the lead instructions ([`foreman/LEAD.md`](foreman/LEAD.md)) are added to the system prompt and the `subagent` tool is active. **Off:** both are gone, and Pi works alone. The setting is saved in the session, so resuming keeps it. |
| `--orchestrate` | Starts Pi with lead mode on, e.g. for headless `--mode json` runs. |
| `/team` | Shows the lead's model (this session's model), each worker's model, whether lead mode is on, and where the OpenRouter key comes from. |
| **Paste your OpenRouter key** | Paste the key (`sk-or-v1-…`) into Pi's prompt and send it. Pi saves it and **never sends it to a model**: the message stops at the extension, whichever model is selected. The key goes into `<agentDir>/auth.json` through Pi's own credential store, the same place `/login openrouter` writes. The lead and every worker use it from then on, with no environment variable needed. Pi checks it with OpenRouter's key-info call first and refuses one that OpenRouter rejects. `/logout` removes it. |

Workers are defined in [`foreman/agents/`](foreman/agents/) (`frontend`, `backend`, `tests`, each with `model:` in its frontmatter). Delegation uses [`@mjakl/pi-subagent`](https://www.npmjs.com/package/@mjakl/pi-subagent) 3.1.0, declared as a normal npm dependency. Depth is capped at 1, so workers can't delegate further.

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

Pi can't install a *subfolder* of a git repo, so the repo root's `package.json` is the package manifest. It loads exactly four files, in this order: `foreman/orchestrate.ts` → `@mjakl/pi-subagent` → `foreman/prompt.ts` → `foreman/keys.ts`. `extensions/freellmapi` is not part of it.

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

**On FreeLLMAPI, OpenRouter is not used.** Pi sends a provider's key only to that provider, so the lead never sends your OpenRouter key to FreeLLMAPI. With both installed, while the session's model is a `freellmapi/…` model, the extension also moves every worker call onto that same model. Foreman's workers are otherwise pinned to OpenRouter, so this keeps lead mode free. `/team` shows the switch. Tested offline: a real worker process went to FreeLLMAPI, and zero requests reached OpenRouter.

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
| `foreman/test/rpc-orchestrate-test.mjs` | Lead mode off by default, `/orchestrate` on/off, `/team`, `--orchestrate`, workers never lead, depth 1, resume keeps the toggle (11) |
| `foreman/test/rpc-keys-test.mjs` | A pasted key is saved and never sent, is used at once and by new processes, and wins over the env var (11) |
| `extensions/freellmapi/test/rpc-workers-test.mjs` | FreeLLMAPI lead → a real worker process goes to FreeLLMAPI, zero OpenRouter requests; control run (8) |
| `extensions/freellmapi/test/rpc-login-test.mjs` | The `/login-with-freellm` flows against a mock FreeLLMAPI (3) |

Each test drives Pi over RPC against local stand-ins and checks what Pi actually sends.

**Run the package from the repo without installing it:** `pi-config/dev` is a Pi agent dir that loads this repo (`"packages": ["../.."]`), defaults to a Haiku lead, and caps every model's output at 16k tokens:

```bash
PI_CODING_AGENT_DIR=<repo>/pi-config/dev pi --no-skills --orchestrate
```

Paste your OpenRouter key into that session once; it is saved in `pi-config/dev/auth.json`, which is gitignored like all of Pi's runtime state there.

## Layout

```
package.json          Pi package manifest ("pi" field, dependencies) and the dev scripts
foreman/              the package: orchestrate.ts (/orchestrate, --orchestrate, /team), prompt.ts (lead prompt),
                      keys.ts (paste-to-save key), shared.ts, LEAD.md, agents/*.md, test/
extensions/freellmapi/  optional FreeLLMAPI provider + /login-with-freellm, with its tests and mock server
pi-config/dev/        agent dir for running the package from the repo (16k output caps)
scripts/check.mjs     typecheck + all offline tests
NOTES.md              verified Pi facts, design decisions, what is and isn't verified
```
