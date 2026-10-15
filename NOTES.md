# NOTES

Findings, verified flags, and decisions. Each fact cites where it came from.

Path shorthands used below:

- `<pi>` = `C:/Users/Akshat/AppData/Roaming/fnm/node-versions/v22.23.3/installation/node_modules/@earendil-works/pi-coding-agent` (installed Pi 1.2.0)
- `<sub>` = `node_modules/@mjakl/pi-subagent` (subagent package 3.1.0, now a dependency of the repo-root Pi package; until 2026-10-15 it was installed per profile under `pi-config/harness/npm/`)
- oira666 sources were read from `npm pack oira666_pi-subagent@0.5.14` (not installed)

---

## Current harness setup: the Foreman Pi package (2026-10-15)

This **supersedes** the hand-built harness described further down ("Harness prompt layout", "Setup command", "Command lines"). Those sections are kept as the record of how Milestone 0 was first verified.

- **What changed:** `pi-config/harness` used to hold `LEAD.md` + `agents/*.md` and needed `--append-system-prompt LEAD.md --subagent-max-depth 1` on every launch. Now the repo root is one Pi package. Its files are in `foreman/`: `orchestrate.ts`, `prompt.ts`, `shared.ts`, `LEAD.md` and `agents/*.md`. The `harness` profiles load it via `settings.json` `"packages": ["../.."]`, and lead mode is `--orchestrate` (headless) or `/orchestrate` (interactive). The demo and the measured runs therefore share one setup.
- **Why the repo root is the package:** Pi's git source cannot point at a subdirectory. The parser yields only `{repo, host, path, ref}`, and the clone root is the package root (`<pi>/dist/core/package-manager.js:1566-1573,1804`). So `package.json` carries the `pi` manifest next to the runner scripts.
- **Load order** (`package.json` `pi.extensions`, which Pi keeps in order: `package-manager.js:1962-1970`):
  1. `foreman/orchestrate.ts`: registers `--orchestrate`, `/orchestrate`, `/team`; sets `PI_SUBAGENT_MAX_DEPTH=1` (`??=`, so an explicit value wins) before pi-subagent's factory reads it (`<sub>/index.ts:386-387,715`); copies the workers in at `session_start`; toggles the `subagent` tool with `pi.setActiveTools`.
  2. `./node_modules/@mjakl/pi-subagent`: Pi reads that package's own `pi.extensions` (`package-manager.js:381-405`).
  3. `foreman/prompt.ts`: `before_agent_start`. When lead mode is on, it adds `LEAD.md` as a `<lead_mode>` section. If pi-subagent already replaced the whole prompt string (it returns `{systemPrompt: event.systemPrompt + list}`, `<sub>/index.ts:772-786`), the section is appended to that string instead. When lead mode is off, it removes pi-subagent's `## Available Subagents` block, which pi-subagent injects even when its tool is inactive.
- **Dependency, not vendored.**
  - Pi docs: "Other Pi packages used as dependencies must be included in the published tarball and referenced through their `node_modules` resource paths" (`<pi>/docs/packages.md:90`).
  - Pi installs a package's dependencies for npm and git sources: git runs `npm install --omit=dev --legacy-peer-deps` in the clone (`package-manager.js:1495-1496,1570-1573`). Local paths are not installed for you (`packages.md:88`), hence `npm ci`.
  - Publishing to npm later would need `bundledDependencies`.
  - Vendoring would also have been allowed: the license is MIT, © 2026 Michael Jakl (`<sub>/LICENSE`).
  - Pi core is an optional `peerDependency` (`"*"`), per `packages.md:88`, so `npm ci` doesn't pull Pi into the repo.
- **Worker discovery has no hook.** pi-subagent reads only `getAgentDir()/agents` and trusted project `.pi/agents` (`<sub>/agents.ts:152-166`). So `orchestrate.ts` copies `foreman/agents/*.md` there at `session_start`, marking each copy with `managed-by: pi-foreman`. It runs before pi-subagent's own `session_start` discovery, in load order. Files without the marker are the user's: they are never overwritten, and they override that worker.
  - The runner's preflight refuses an `--orchestrate` profile whose `agents/` holds such a file, because it would silently change a measured worker's model.
- **Workers load the package too.** They inherit `PI_CODING_AGENT_DIR`, and pi-subagent forwards unknown parent flags such as `--orchestrate` (`<sub>/runner-cli.js:273-286`).
  - The flag is therefore registered in workers as well; otherwise Pi exits with "Unknown option".
  - Everything else is skipped when `PI_SUBAGENT_DEPTH > 0`, the variable pi-subagent sets for children.
- **Proof of lead mode per run.** Pi's JSON log records the base system prompt, *not* extension edits; checked offline, no `<lead_mode>` appears in any event. So `prompt.ts` writes a `foreman-lead-applied` session entry with the SHA-256 of `LEAD.md` each time it applies it, and Pi emits that entry as `entry_appended`. The system message's `toolsAdded` shows whether `subagent` was active.
  - `scripts/lib/analyze.ts` requires both for runs started with `--orchestrate` (`LEAD_MODE_MISSING`) and neither for solo runs (`LEAD_MODE_UNEXPECTED`). Either mismatch excludes the run as a setup failure to re-run, and `results.json` records `leadMode` with the hash.
- **Flag parsing caveats** (`<pi>/dist/cli/args.js:247-251`; `agent-session-services.js:27-29`):
  - `--orchestrate "task"` consumes `"task"` as the flag's value.
  - Boolean extension flags are set to `true` whatever value is given, so `--orchestrate=false` is still on.
  - The runner pipes the prompt on stdin, so neither caveat applies there.
- **Verified:**
  - **Offline**, `foreman/test/rpc-orchestrate-test.mjs` captures what Pi actually sends to the model through a local stand-in for OpenRouter. 8/8 checks pass:
    - off by default;
    - `/orchestrate` on, then off, in one session, checked by the lead section, pi-subagent's list and the `subagent` tool in the request;
    - `/team` models;
    - `--orchestrate` on at start;
    - a simulated worker with a forwarded `--orchestrate` stays a worker, without "Unknown option";
    - depth 1 without `--subagent-max-depth`.
  - **Self-test:** `npm run selftest` passes, including the new lead-mode checks in both directions and the hand-written-worker preflight.
  - **Install:** `pi install <abs path>` and `pi install ./` (stored relative to the agent dir), then `--help` lists `--orchestrate` and `--subagent-max-depth`.
  - **Live, 2026-10-15:** `harness-lite` (Haiku lead) with `--orchestrate` and the step-3 hello-world prompt.
    - Exit 0 after 20 s. Both files correct; `BOARD.md` written.
    - One `foreman-lead-applied` entry; `subagent` active; delegation `[{backend},{frontend}]` with no per-call model.
    - OpenRouter `/generation`: backend 3× `minimax/minimax-m3-20260531`; frontend 3× `moonshotai/kimi-k2.7-code-20260612`.
    - Key usage delta **$0.005077** (reads 0.005857677 → 0.010934685, stable for 3 reads). Pi estimate $0.00550 (+8%).
  - **Git install, 2026-10-15** (commit 913c3d1 on GitHub; fresh agent dirs):
    - `pi install git:github.com/nwopes/pi_agentic_harness`, the `@913c3d1`-pinned form and `https://github.com/nwopes/pi_agentic_harness` all installed.
    - Each cloned to `<agentDir>/git/github.com/nwopes/pi_agentic_harness` at 913c3d1. `node_modules` held only `@mjakl` (no devDependencies). `settings.json` records the source string, and `--help` lists `--orchestrate` and `--subagent-max-depth`.
    - `foreman/test/rpc-orchestrate-test.mjs` run from the git-installed copy: 8/8.
    - `pi remove git:github.com/nwopes/pi_agentic_harness` left `packages: []`.
  - **Windows gotcha:** the first attempt used a 186-character agent-dir path and failed in Pi's `git clone` with `fatal: fetch-pack: invalid index-pack output` (code 128). git's pack files push the path past 260 characters while `core.longpaths` is unset. A plain clone to a short path worked. The normal `~/.pi/agent/git/...` path is about 75 characters. Fix: a shorter agent dir, or `git config --global core.longpaths true`.
  - **Resume, 2026-10-15:** now part of `rpc-orchestrate-test.mjs`, 11/11. A persisted session with `/orchestrate on`, reopened with `--continue` and no flag, is still in lead mode. `/orchestrate off` there turns it off, and a second `--continue` stays off.
  - Precedence, as in Pi's plan-mode example: a toggle saved in the session wins over `--orchestrate` when resuming. Fresh sessions, including every compare run, take the flag.

## Milestone 0, configuration part: status (2026-10-15)

- Done offline: Pi installed, OpenRouter wired through `OPENROUTER_API_KEY`, `pi-config/{harness,strong-solo,cheap-solo}` created, subagent package installed into `harness`.
- Delegation verified **end to end against a local mock of OpenRouter**, with no real model calls (see "Offline validation"). Workers request their own frontmatter models, not the lead's.
- Still needs the live key: everything under "Pending live verification".

## Pinned versions and models

| What | Pinned value | Pi model ref (what Pi/agent files use) |
|---|---|---|
| Pi | `@earendil-works/pi-coding-agent@1.2.0` | n/a |
| Node used to run Pi | 22.23.3 (fnm) | n/a |
| Subagent package | `@mjakl/pi-subagent@3.1.0` (npm integrity `sha512-nXxtjCdOdnwEY0jcm4y8x9sOvP/0J6nBjoc2TPWtFmvypaF1EC9Aso54S6Vu0PawWkLxzaNlN+dKsaSCCBPScg==`) | n/a |
| Lead (harness) and strong-solo | OpenRouter `anthropic/claude-opus-5.5` | `openrouter/anthropic/claude-opus-5.5` |
| frontend worker, and cheap-solo | OpenRouter `moonshotai/kimi-k2.7-code` | `openrouter/moonshotai/kimi-k2.7-code` |
| backend worker | OpenRouter `minimax/minimax-m3` | `openrouter/minimax/minimax-m3` |
| tests worker | OpenRouter `anthropic/claude-haiku-5.5` | `openrouter/anthropic/claude-haiku-5.5` |

- Model ids were chosen by the user. The coordinator reported them live on OpenRouter with tool calling. I did not re-check OpenRouter.
- All four ids are in Pi 1.2.0's **built-in** OpenRouter catalog under `provider: "openrouter"`. Source: `<pi>/dist/bundle/chunks/chunk-TJXZSVTD.js`, and RPC `get_available_models` (offline probe).
- The two Anthropic models use `api: anthropic-messages` with `baseUrl https://openrouter.ai/api`. Kimi and MiniMax use `api: openai-completions` with `baseUrl https://openrouter.ai/api/v1` (same sources).
- Pi's catalog prices per 1M tokens, which I believe are a snapshot from Pi's build time; check them against OpenRouter `/api/v1/models`:

  | Model | input | output | cacheRead | cacheWrite |
  |---|---|---|---|---|
  | opus-5.5 | 4 | 20 | 0.2 | 5 |
  | kimi-k2.7-code | 0.6712 | 3.35 | 0.18 | 0 |
  | minimax-m3 | 0.3 | 1.2 | 0.06 | 0 |
  | haiku-5.5 | 0.1 | 0.5 | 0.01 | 0.125 |

  haiku-5.5 has a higher tier above 100k input tokens: 0.5 / 2.5.
- **Always use the `openrouter/` prefix.** Pi also has built-in `anthropic` and `minimax` providers. A bare `minimax/minimax-m3` resolved to openrouter in my probe only because OpenRouter was the only provider with a key. The prefixed form is unambiguous. Sources: `pi --help` ("supports provider/id") and the @mjakl README section "Per-call model override".
- The runner reads worker models from agent frontmatter. To get the OpenRouter id, strip the leading `openrouter/`.

## Installing Pi

- **`@mariozechner/pi-coding-agent` (0.73.1) is deprecated.** `npm view @mariozechner/pi-coding-agent deprecated` returns "please use @earendil-works/pi-coding-agent instead going forward". The latest release is `@earendil-works/pi-coding-agent@1.2.0` (2026-10-12).
- Both candidate subagent packages import `@earendil-works/*` and require Pi >= 0.87.1. Sources: oira666 `README.md` and `package.json`; `<sub>/README.md` "Requires Pi 0.87.1 or newer" and its `peerDependencies`. So 0.73.1 cannot load either package. I installed 0.73.1 briefly, then uninstalled it.
- **Pi >= 0.75.0 requires Node >= 22.19.0.** Sources: `<pi>/CHANGELOG.md` [0.75.0] "Breaking Changes", and `engines` in `package.json`. This machine's system Node is 22.12.0.
- Official install methods (`<pi>/README.md` "Getting started"):
  - Windows installer: `powershell -c "irm https://pi.dev/install.ps1 | iex"`.
  - Documented npm alternative: `npm install -g --ignore-scripts @earendil-works/pi-coding-agent`.
- I read `install.ps1` without running it. With Node < 22.19 it errors when non-interactive. Interactively it offers to install a standalone Node into `%LOCALAPPDATA%\pi-node\current` and **prepend it to the user PATH** (`Install-NodeStandalone`, `Add-UserPathEntry -Prepend`). I avoided that.
- What I ran instead, which leaves system Node and PATH untouched:

  ```bash
  fnm install 22.23.3 && fnm default system        # fnm 1.37.1 was already installed; first install had made 22.23.3 the default, so I reset it
  PND=/c/Users/Akshat/AppData/Roaming/fnm/node-versions/v22.23.3/installation
  PATH="$PND:$PATH" "$PND/npm.cmd" install -g --ignore-scripts @earendil-works/pi-coding-agent@1.2.0
  "$PND/node.exe" "$PND/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" --version   # -> 1.2.0
  ```

  - `fnm exec --using=22.23.3 -- npm ...` fails in Git Bash ("program not found"), so call `npm.cmd` directly.
  - Pi is **not on the default PATH**. Launchers live in `$PND`: `pi`, `pi.cmd` and `pi.ps1`. They run with the `node.exe` next to them.
- For scripts, invoke Pi like this:
  - `PI_NODE=C:/Users/Akshat/AppData/Roaming/fnm/node-versions/v22.23.3/installation/node.exe`
  - `PI_CLI=C:/Users/Akshat/AppData/Roaming/fnm/node-versions/v22.23.3/installation/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`
  - Run `"$PI_NODE" "$PI_CLI" ...`. Do not spawn `pi.cmd` from Node without `shell:true`: Node refuses `.cmd` files without a shell, and a shell breaks multi-line args. `foreman.config.json` currently has `"piBin": "pi"`, which will not resolve.
- Alternative: upgrade system Node to >= 22.19, then use the npm one-liner above and plain `pi`. That is the user's call, since it changes the machine.

## OpenRouter as the provider

- OpenRouter is a built-in provider: "Authenticate with `/login openrouter` or `OPENROUTER_API_KEY`". Sources: `<pi>/docs/providers.md` "OpenRouter"; `pi --help` env list. The key mapping is in the bundle: `envApiKeyAuth("OpenRouter API key",["OPENROUTER_API_KEY"])`.
- Credential order: CLI `--api-key`, then `auth.json`, then the env var. Source: the 0.73.1 `docs/providers.md` "Resolution Order". I did not find that section in the 1.2 docs, so I have not confirmed the order is unchanged. It doesn't matter here because no `auth.json` key is used.
- **Pi does not load `.env`.** There is no `dotenv` or `loadEnvFile` anywhere in `<pi>/dist`. CHANGELOG 1.1.0 says "Fixed standalone binaries loading `.env`..." (that was a Bun-binary bug, now removed). **The caller must export `OPENROUTER_API_KEY`** from the repo-root `.env`. Example for Git Bash, which strips CR and quotes:

  ```bash
  export OPENROUTER_API_KEY="$(grep -E '^OPENROUTER_API_KEY=' .env | head -1 | cut -d= -f2- | tr -d '\r"')"
  ```

- I created no `auth.json` with a key, and none should be committed. Pi writes an empty `auth.json` (`{}`) by itself (see gitignore list).
- Offline preflight that the key is visible: `pi auth check --provider openrouter --json` prints `{"status":"ready",...}` and exits 0, or `not_ready` and exits 1. Verified with a placeholder value. It only checks presence, not validity (`<pi>/docs/cli.md` "Credential commands").
- Model selection is `--model openrouter/<vendor>/<model>`, or `--provider openrouter --model <vendor>/<model>`. Both resolved correctly in the RPC `get_state` probe. `--provider` without `--model` is an error since 1.0.0 (CHANGELOG [1.0.0]).
- Per-key model list (new in 1.2.0): with a key, Pi lists only the models that key may use, with the key's prices, from OpenRouter `/models/user`. Pi refreshes it only in interactive startup, on `/model`, after `/login`, or with `pi update --models`. "The last list is saved and used offline and in `pi -p` and RPC mode." It is saved to `<agentDir>/models-store.json` (`FileModelsStore` in the bundle). Without a saved list, Pi uses the built-in catalog. Source: `<pi>/docs/providers.md` "OpenRouter".
- `settings.json` `defaultProvider`/`defaultModel` are honored when auth is configured (`<pi>/dist/core/model-resolver.js` `findInitialModel`). Verified via `get_state`.
- Pitfall: if `PI_CODING_AGENT_DIR` points to a **nonexistent** dir, Pi silently creates it and falls back to OpenRouter's provider default `moonshotai/kimi-k2.6`. I hit this through a quoting bug. **Always pass `--model` explicitly in automated runs.**

## `PI_CODING_AGENT_DIR` and mode isolation

- `PI_CODING_AGENT_DIR` overrides the agent dir (default `~/.pi/agent`). Sources: `<pi>/docs/environment-variables.md`, `<pi>/docs/configuration.md`.
- What lives in it (`configuration.md` "Agent directory"):
  - `settings.json`, `keybindings.json`, `mcp.json`, `models.json`, `auth.json`
  - `AGENTS.override.md` / `AGENTS.md` / `CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`
  - `extensions/`, `skills/`, `prompts/`, `themes/`
  - Also `sessions/`, `npm/` and `trust.json` (see gitignore list)
  - Subagent agents go in `<agentDir>/agents/` (`<sub>/agents.ts` `getUserAgentsDir()` = `getAgentDir()/agents`)
- With the override set, `~/.pi` was never read or created. `~/.pi` still does not exist on this machine after all runs.
- **One leak outside the agent dir: global skills in `~/.agents/skills/`.** Pi loads them regardless of `PI_CODING_AGENT_DIR` (`<pi>/docs/skills.md`: "Pi also supports the Agent Skills locations `~/.agents/skills/`..."). This machine has `C:\Users\Akshat\.agents\skills\find-skills`. **Pass `--no-skills` in every mode.** @mjakl forwards it to workers (`<sub>/runner-cli.js` alwaysProxy list). The mock run confirmed `find-skills` is absent from the prompt.
- Project-local `.pi/` resources (settings, extensions, skills and so on, read from the cwd) load only after project trust. In print, JSON and RPC modes, trust defaults to "skip" unless `--approve` is given. Pass `--no-approve` to make that explicit; @mjakl forwards it. Source: `<pi>/docs/security.md` "Project trust without an interactive prompt".

## Context files (AGENTS.md / CLAUDE.md)

- Source: `<pi>/dist/core/resource-loader.js` `loadProjectContextFiles()`.
- Pi loads the first of `AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD` from the agent dir.
- It then loads one per directory **from the cwd up to the filesystem root**. There is no stop at the git root; the only special case is git-worktree de-duplication. No project trust is needed (`configuration.md` "Context files").
- **Consequence for runs:** workspaces under `runs/` inherit any context file in `runs/`, the repo root, `Desktop`, `C:\Users\Akshat` and so on.
  - Today none exist: I checked the repo, `Desktop`, `C:\Users\Akshat`, `C:\Users` and `C:\`.
  - **Keep the repo root free of `AGENTS.md`/`CLAUDE.md`**, or put workspaces outside the repo.
- `--no-context-files` / `-nc` disables **all** context files, including the agent-dir one: `agentsFiles: this.noContextFiles ? [] : ...`. So it cannot be used to drop only the ancestor files.

## Harness prompt layout (deviation from the PRD's literal layout, on purpose)

> **Superseded (2026-10-15)** by "Current harness setup: the Foreman Pi package" above; kept as the record of the original Milestone 0 setup.

- Workers are child Pi processes that inherit the parent's env, including `PI_CODING_AGENT_DIR` (`<sub>/runner.ts` `spawn(..., env: {...process.env, ...})`). So they also load `<agentDir>/AGENTS.md`.
- The mock run confirmed it: with the team prompt at `pi-config/harness/AGENTS.md`, all three worker requests contained "You are the LEAD of a small engineering team".
- **Fix:** §7.1 is stored verbatim as `pi-config/harness/LEAD.md` and passed only to the lead with `--append-system-prompt <abs path>/LEAD.md`.
  - @mjakl never forwards `--append-system-prompt` to children (`<sub>/runner-cli.js` blocked list).
  - Mock run result: the lead has the prompt, and no worker does.
- §7.1 says "the subagent tool". The package's tool is literally named `subagent`, so no wording changed.
- `pi-config/harness` deliberately has **no** `AGENTS.md`. The solo modes keep the neutral §7.3 `AGENTS.md`.
- **`--subagent-max-depth 1` is required on the lead.** The default depth is 3, which lets workers delegate to each other: the mock run without the flag showed every worker getting the `subagent` tool and the agent list.
  - With the flag, workers have only `read,bash,edit,write`.
  - The depth propagates to children through `PI_SUBAGENT_MAX_DEPTH`. Sources: `<sub>/runner.ts` spawn env; `<sub>/index.ts` `canDelegate`.

## Non-interactive modes

Sources: `<pi>/docs/cli.md`, `<pi>/docs/cli-integration.md`, `<pi>/docs/json.md`, `<pi>/docs/rpc.md`.

- Print mode: `-p` / `--print` writes final text and exits. JSON mode: `--mode json` writes JSONL events and exits. RPC mode: `--mode rpc` keeps a long-lived JSONL command/response channel.
- **JSON mode exits 0 even if the assistant errored.** Inspect the final assistant `message_end.message.stopReason` (`error`, `aborted`, `length`). The first mock run confirmed this: a 404 still gave exit=0.
- JSON stream contents:
  - First record: the session header `{"type":"session","version":3,"id","timestamp","cwd"}`.
  - Then: `agent_start`, `turn_start`, `message_start`, `message_update` (delta-only), `message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end` (has `durationMs`), `turn_end`, `agent_end`, `agent_settled`.
  - Also possible: `queue_update`, `compaction_start`/`compaction_end`, `auto_retry_start`/`auto_retry_end`, `summarization_retry_*`, `entry_appended`, `session_info_changed`, `thinking_level_changed`.
  - `agent_settled` (with `aborted`) marks the true end of a run.
  - Pi 1.2 also emits the lead's full system prompt as a `message_start`/`message_end` with `message.role:"system"` and `message.sections` = `{preamble, tools, rules, docs, addendum, cwd}`. The LEAD.md text lands in `sections.addendum` (seen in mock events). Useful for auditing prompts per run.
- Framing: strict LF-delimited JSONL. **Do not use Node `readline`**: it splits on U+2028/2029. Read stdout continuously (`json.md` "Framing").
- **Prompt input on Windows: pipe it on stdin.**
  - `readPipedStdin()` in `<pi>/dist/main.js` reads stdin in print and JSON modes, `.trim()`s it, and puts it before any `@file` text or positional message (`buildInitialMessage`).
  - Verified: a 2-line prompt from `< prompt.txt` arrived intact.
  - Avoid a positional argument for long or multi-line prompts: `.cmd` shims break newlines, and Windows limits the command line to about 32K characters.
  - `@SPEC.md` also works, but adds the file as file text.
  - Close stdin, or use `stdio[0]="ignore"`. Otherwise Pi waits for EOF.

### Where token usage and cost appear

- **Lead/solo usage:** each assistant `message_end.message` has `provider`, `model`, `responseModel?`, `responseId?` and `usage`.
  - `usage` = `{input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost:{input, output, cacheRead, cacheWrite, total}}`.
  - Cost is USD. `reasoning` is already included in `output`. Source: `<pi>/docs/message-types.md`.
  - Example from the mock:

    ```json
    {"provider":"openrouter","model":"anthropic/claude-opus-5.5","responseId":"msg_mock_1","stopReason":"toolUse","usage":{"input":4000,"output":300,"cacheRead":0,"cacheWrite":0,"totalTokens":4300,"cost":{"input":0.016,"output":0.006,"cacheRead":0,"cacheWrite":0,"total":0.022},"cacheWrite1h":0}}
    ```

  - `turn_end.message` and `agent_end.messages` repeat the same messages. Count each assistant message once (use `message_end`).
- **`usage.cost` is computed by Pi**, not reported by OpenRouter: `calculateCost(model, usage)` multiplies catalog per-1M rates by token counts (bundle). It is an estimate. OpenRouter's key-usage delta stays the cost of record.
- `responseModel` is set only when the provider reports a different concrete model id. The mock returned `minimax/minimax-m3-served-variant`, and Pi recorded it as `responseModel`. `responseId` is the provider response id: `gen-...` for chat completions, `msg_...` for the Anthropic-style endpoint, as seen in the mock.
- `compaction_end.result.usage` carries the cost of summarization calls. Include it if compaction happens.

### Worker usage in the parent stream (@mjakl/pi-subagent)

- Worker usage appears **only** inside the `subagent` tool result, never as separate events. Verified in the mock run.
- Read it from `tool_execution_end` where `toolName === "subagent"`: `result.details = {kind:"pi-subagent", projectAgentsDir, results: SingleResult[], failed?}`.
- The same `details` also appears on `message_end` with `message.role === "toolResult"` and `message.toolName === "subagent"`. **Read one of the two, not both** (key on `toolCallId`).
- `SingleResult`, from `<sub>/types.ts`:
  - `agent` (`"frontend"` etc.), `agentSource` (`user` or `project`)
  - `model`: the configured string, e.g. `"openrouter/minimax/minimax-m3"`. It is **not** the served model.
  - `exitCode`, `stopReason`, `errorMessage`
  - `usage:{input, output, cacheRead, cacheWrite, cost, contextTokens, turns}`. Here `cost` is a number in USD. `contextTokens` is the last snapshot; do not sum it.
  - `messages[]`: the child's assistant messages, each with `provider`, `model`, `responseModel?`, `responseId`, `usage`.
- Example result from the mock:

  ```json
  {"agent":"backend","agentSource":"user","model":"openrouter/minimax/minimax-m3","exitCode":0,"stopReason":"stop","usage":{"input":900,"output":30,"cacheRead":0,"cacheWrite":0,"cost":0.000306,"contextTokens":930,"turns":1},
   "messages":[{"provider":"openrouter","model":"minimax/minimax-m3","responseModel":"minimax/minimax-m3-served-variant","responseId":"gen-mock-4","usage":{...}}]}
  ```

- `tool_execution_update` with toolName `subagent` arrives about every second: a heartbeat with partial `partialResult.details.results`. **Never sum these.** The mock run had 16 of them.
- The toolResult message has `usage: null`. So Pi's own session totals (`get_session_stats`, the interactive footer) **exclude worker cost**. Do not show the footer cost as the harness total.
- Accounting gaps in @mjakl:
  - Worker usage is summed from the child's assistant `message_end`/`turn_end`/`agent_end`, de-duplicated by message hash (`<sub>/runner-events.js` `addAssistantMessage`).
  - **Worker compaction usage is not captured.**
  - `messages[]` keeps only a rolling 5 MB window. `usage` totals survive truncation.
- The lead can override a worker's model with a per-call `model` argument (`<sub>/README.md`: "A per-call `model` overrides the agent file's default model"). It cannot be disabled by config. **The runner should flag any `tool_execution_start` (toolName `subagent`) whose `args.calls[i].model` or `.thinking` is set.**

## Windows specifics

- The bash tool uses Git Bash.
  - Lookup order: `shellPath` setting, then `C:\Program Files\Git\bin\bash.exe`, then `bash.exe` on PATH (`<pi>/docs/windows.md`).
  - Verified via the RPC `bash` command: `/usr/bin/bash` 5.2.26, `MINGW64_NT-10.0-26200`.
- When Pi is started as `"$PI_NODE" "$PI_CLI"` without changing PATH, the agent's shell sees the **system** `node` v22.12.0 and `npm` 11.7.0 (verified). So workspaces build with the same toolchain as `grade.sh`.
  - If you instead prepend the fnm dir to PATH, the agent gets Node 22.23.3 and that Node's npm.
- No permission prompts exist ("No permission popups", README philosophy).
  - Headless: `--approve`/`--no-approve` avoids any trust question.
  - Workers: @mjakl cancels extension UI requests in children (`<sub>/README.md` "How Subagents Run").
- TTY behavior:
  - The interactive TUI needs a real console.
  - With no `--mode`, a non-TTY stdin or stdout silently selects **print** mode (`<pi>/dist/main.js` `resolveAppMode`).
  - I believe, but did not verify, that Git Bash's default mintty window does not give native `node.exe` a console TTY. **Run interactive demos in Windows Terminal (PowerShell or Git Bash profile), or use `winpty`.**
- To kill a timed-out run, kill the whole process tree (`taskkill /T /F /PID <pid>`). Workers are child `node.exe` processes. @mjakl itself uses `taskkill /T /F` on Windows (`<sub>/README.md` "Liveness Timeouts").

## Sessions

- By default sessions are saved under `<agentDir>/sessions/`, grouped by cwd. That would put them inside `pi-config/<mode>/sessions/` (bundle: `getAgentDir(),"sessions"`).
- Overrides, in precedence order: `--session-dir <dir>`, then `PI_CODING_AGENT_SESSION_DIR`, then the `sessionDir` setting. `--no-session` keeps the session in memory only. Sources: `<pi>/docs/cli.md`, `settings.md`.
- For automated runs use `--session-dir "$RUN/pi-sessions"`. The lead JSONL then lands in the run folder. Named worker sessions (if the lead ever passes `session`) need a persisted parent session and land in the same dir (`<sub>/README.md` "Session storage"). Plain ephemeral worker calls always use `--no-session`.
- In the mock run, `--session-dir` wrote one file, `<dir>/2026-...Z_<uuid>.jsonl`. Nothing was written into the workspace except what the agent writes.

## Extensions and packages in a specific agent dir

- Install the supported way: `PI_CODING_AGENT_DIR=<dir> pi install npm:<pkg>@<ver>`.
  - It writes `"packages": ["npm:<pkg>@<ver>"]` into `<dir>/settings.json`.
  - It installs into `<dir>/npm/`: `package.json`, `package-lock.json`, `node_modules/`, plus a self-written `.gitignore` containing `*` and `!.gitignore`.
  - Verified, along with `<pi>/docs/packages.md` and CHANGELOG [0.75.0] ("user-scoped npm pi packages install under `~/.pi/agent/npm/`").
- Re-running `pi install` is idempotent: no duplicate settings entry (verified). `pi list` prints the resolved install path.
- If the package is declared in `settings.json` but `npm/` is missing:
  - **Online:** Pi auto-installs it at startup. Verified with `pi --help` on a fresh copy.
  - **With `PI_OFFLINE=1`:** it is **silently skipped**, and harness then has no `subagent` tool, with no warning. Verified.
- Local extension files can instead go in `<dir>/extensions/`, or be listed in settings `extensions`. Not used here.

## Subagent package choice: `@mjakl/pi-subagent@3.1.0`

- **oira666_pi-subagent@0.5.14 is unsuitable for this PRD.** Agent frontmatter `model` is ignored whenever the parent's model is known.
  - Its `docs/configuration.md` says: "`model` | Parent's active model | Legacy fallback when live parent context is unavailable" and "`--model`: replaced by the live parent model".
  - Its source `runner/arguments.ts` `resolveSubagentModel()` returns `currentParentModel ?? agentModel ?? ...`, with the comment "The active parent model is authoritative".
  - Per-role models are only possible through "intelligence presets" (`subagents-models` in `pi-subagent.json`). The **lead LLM** picks one per call, not bound to the agent file. That is the PRD §3 step 5 trap by design.
  - Its strengths, for the record: tool `subagents` with `tasks[]` (default 30 tasks per call, concurrency 8, per its `docs/configuration.md`); richer usage (`aggregatedUsage`, `usageTree` in `docs/usage.md`); children spawned via `process.execPath`.
- **@mjakl/pi-subagent@3.1.0 does what the PRD needs:**
  - Agent `model:` is the agent's default; only an explicit per-call `model` beats it. Source: `<sub>/runner.ts` `buildModelArgs()`, `callModel ?? agentModel` before the parent model.
  - The parent's `--model`/`--provider` are fallbacks only. Values containing `/` are passed without `--provider` (same function, plus `<sub>/runner-cli.js`).
  - **Verified in the mock run:** with the lead started as `--model openrouter/anthropic/claude-opus-5.5`, the workers' requests carried `moonshotai/kimi-k2.7-code`, `minimax/minimax-m3` and `anthropic/claude-haiku-5.5`.
- Tool and parallelism:
  - The tool is named `subagent` and takes `{calls:[{agent, prompt, model?, thinking?, cwd?, initialContext?, session?, inactivityTimeout?, timeout?}]}`.
  - 1–8 calls per tool call, run with concurrency 4 (`<sub>/index.ts` `MAX_CALLS=8`, `MAX_CONCURRENCY=4`). The mock showed the three workers running in parallel.
- How children are spawned:
  - Each child is a separate Pi process: `process.execPath <pi rpc-entry>` in RPC mode, `shell:false`, so there is no PATH dependency (`<sub>/runner.ts` `resolvePiSpawn()`).
  - The child gets `env = {...process.env, PI_OFFLINE:"1", PI_SUBAGENT_DEPTH, ...}`, so it **inherits `PI_CODING_AGENT_DIR`** and `OPENROUTER_API_KEY`.
  - The prompt is sent over RPC stdin. The agent body plus a "Subagent runtime" note go in through `--append-system-prompt <tmpfile>`.
- Which parent CLI flags children inherit (`<sub>/runner-cli.js`):
  - Parsed only when `PI_CODING_AGENT=true`, which Pi's CLI sets (`<pi>/docs/environment-variables.md` "Process Marker").
  - Forwarded: `--no-skills`, `-nc`, `--api-key`, `--models`, `--exclude-tools`, `--system-prompt`, `--session-dir` and `--no-approve`. Unknown flags are forwarded by a heuristic, so **avoid unknown flags right before positional args**.
  - Fallbacks only: `--model`, `--thinking` and `--tools`. **If the runner passes `--thinking X` to the lead, workers inherit X unless their frontmatter sets `thinking:`.**
  - Blocked: `--mode`, `-p`, `--append-system-prompt`, `--offline`, `--subagent-max-depth` and the session flags.
- Supported frontmatter (`<sub>/agents.ts` `parseAgentFile`, README "Frontmatter Fields"):
  - `name`, `description` (both required), `model`, `thinking`, `tools`, `noTools`, `inactivityTimeout`, `sessionPreference`, `sessionHint`.
  - There is no separate provider field; put the provider prefix in `model`. Our files use only `name`, `description` and `model`.
- Agent scopes:
  - **User agents:** `$PI_CODING_AGENT_DIR/agents/*.md`.
  - **Project agents:** the nearest `.pi/agents/` walking up from cwd. These win on name clash, but **only with explicit project trust** (`--approve` or the trust store). With `--no-approve` they are never loaded (`<sub>/index.ts` `shouldIncludeProjectAgents`).
  - If no agents are found, @mjakl creates a starter `explore.md` in the user agents dir. That does not apply here, since three agents exist.
- Discovered agents are listed in the lead's system prompt through `before_agent_start`. Workers at max depth get no tool and no list.
- Pi 1.2.0 compatibility: the package loaded and ran on 1.2.0 in the mock run. @mjakl peer range `>=0.87.1`; its devDeps use `^0.87.1`.

## Files created under `pi-config/`

```
pi-config/
├── harness/
│   ├── settings.json      # defaultProvider/defaultModel, enableInstallTelemetry:false, packages:[npm:@mjakl/pi-subagent@3.1.0]
│   ├── LEAD.md            # PRD §7.1 verbatim; passed with --append-system-prompt (NOT named AGENTS.md, see above)
│   ├── agents/frontend.md # model: openrouter/moonshotai/kimi-k2.7-code
│   ├── agents/backend.md  # model: openrouter/minimax/minimax-m3
│   ├── agents/tests.md    # model: openrouter/anthropic/claude-haiku-5.5
│   └── npm/               # installed package (runtime, self-gitignored by Pi)
├── strong-solo/  settings.json (default openrouter/anthropic/claude-opus-5.5), AGENTS.md (§7.3)
└── cheap-solo/   settings.json (default openrouter/moonshotai/kimi-k2.7-code), AGENTS.md (§7.3)
```

- No secrets anywhere.
- Pi can rewrite `settings.json` in interactive use: `/model` saves the new default (`settings-manager.js` `setDefaultProvider`/`setDefaultModel`). Check `git diff pi-config` after demos.

### Paths Pi writes at runtime under `pi-config/` (add to `.gitignore`)

These come from the bundle's `getAgentDir()` joins and from observation.

```gitignore
# Pi runtime state in per-mode agent dirs
pi-config/*/auth.json
pi-config/*/oauth.json
pi-config/*/models-store.json
pi-config/*/trust.json
pi-config/*/sessions/
pi-config/*/npm/
pi-config/*/git/
pi-config/*/bin/
pi-config/*/tools/
pi-config/*/tmp/
pi-config/*/crashes.json
pi-config/*/mcp.log
pi-config/*/mcp-auth.json
```

- `auth.json` and `models-store.json` (`{}`) are created by **any** Pi start, even `--help`. I deleted the ones my probes created.
- `npm/` must exist for the harness to load, but it should **not** be committed: it holds `node_modules`, and Pi already self-ignores it. Recreate it with the setup command below.
- @mjakl writes its temporary prompt files to the OS temp dir, not into `pi-config`.

### Setup command (fresh clone or new machine)

> **Superseded (2026-10-15)** by "Current harness setup: the Foreman Pi package" above; kept as the record of the original Milestone 0 setup.

```bash
REPO=C:/Users/Akshat/Desktop/pi_agentic_harness
PND=/c/Users/Akshat/AppData/Roaming/fnm/node-versions/v22.23.3/installation
fnm install 22.23.3 && fnm default system                      # only if missing; keeps system Node as default
PATH="$PND:$PATH" "$PND/npm.cmd" install -g --ignore-scripts @earendil-works/pi-coding-agent@1.2.0
PI_CODING_AGENT_DIR="$REPO/pi-config/harness" PATH="$PND:$PATH" pi install npm:@mjakl/pi-subagent@3.1.0
PI_OFFLINE=1 PI_CODING_AGENT_DIR="$REPO/pi-config/harness" PATH="$PND:$PATH" pi list   # must print .../harness/npm/node_modules/@mjakl/pi-subagent
```

## Offline validation performed (no live model calls)

1. `pi --version` returns 1.2.0. `PI_CODING_AGENT_DIR=<mode> pi --help` shows `--subagent-max-depth` / `--subagent-prevent-cycles` (extension flags) **only for harness**, not for strong-solo or cheap-solo.
2. RPC probe (`get_state`, `get_commands`, `get_available_models`; no `prompt`; placeholder `OPENROUTER_API_KEY`; `PI_OFFLINE=1`):
   - harness and strong-solo start on `openrouter / anthropic/claude-opus-5.5`; cheap-solo starts on `openrouter / moonshotai/kimi-k2.7-code`. Thinking defaults to `medium`.
   - All four model ids are available under openrouter.
3. **Mock end-to-end run.** A scratch copy of `pi-config/harness` was given a `models.json` override `{"providers":{"openrouter":{"baseUrl":"http://127.0.0.1:18765/api"}}}` (`<pi>/docs/models.md` "Overriding built-in providers"), pointing at a local mock speaking OpenRouter's Anthropic-messages and chat-completions SSE. The lead ran headless with the exact (b) command below. The mock logged:
   - The lead request: model `anthropic/claude-opus-5.5`, tools `read,bash,edit,write,subagent`, LEAD prompt present, `find-skills` absent.
   - Three parallel worker requests:
     - tests → `anthropic/claude-haiku-5.5` (`/api/v1/messages`)
     - frontend → `moonshotai/kimi-k2.7-code` (`/api/chat/completions`)
     - backend → `minimax/minimax-m3`
     - Each had tools `read,bash,edit,write` only, its own worker prompt, and **no** LEAD prompt.
   - The lead's second turn carried the tool result.
   - JSON event counts: `session 1, agent_start 1, turn_start 2, message_start 5, message_end 5, message_update 9, tool_execution_start 1, tool_execution_update 16, tool_execution_end 1, turn_end 2, agent_end 1, agent_settled 1`. Exit code 0.
4. **Mock strong-solo run:** tools `read,bash,edit,write` only. The neutral AGENTS.md was present. A forced `subagent` call returned "Tool subagent not found".
5. Mock controls: without `--subagent-max-depth 1`, workers got the `subagent` tool. With the lead prompt as `harness/AGENTS.md`, every worker got the LEAD prompt. Both outcomes motivated the layout above.

The scratch artifacts (mock server, probes, event logs) are in the session scratchpad. They are not part of the repo.

## Command lines

> **Superseded (2026-10-15)** by "Current harness setup: the Foreman Pi package" above; kept as the record of the original Milestone 0 setup.

Common setup for Git Bash. Run from the workspace directory, which is the cwd Pi works in.

```bash
REPO=C:/Users/Akshat/Desktop/pi_agentic_harness
PI_NODE=C:/Users/Akshat/AppData/Roaming/fnm/node-versions/v22.23.3/installation/node.exe
PI_CLI=C:/Users/Akshat/AppData/Roaming/fnm/node-versions/v22.23.3/installation/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js
export OPENROUTER_API_KEY="$(grep -E '^OPENROUTER_API_KEY=' "$REPO/.env" | head -1 | cut -d= -f2- | tr -d '\r"')"
```

### (a) Interactive sessions

Use Windows Terminal (see TTY note).

```bash
# harness (lead + workers)
PI_CODING_AGENT_DIR="$REPO/pi-config/harness" "$PI_NODE" "$PI_CLI" \
  --model openrouter/anthropic/claude-opus-5.5 \
  --append-system-prompt "$REPO/pi-config/harness/LEAD.md" \
  --subagent-max-depth 1 --no-skills

# strong-solo
PI_CODING_AGENT_DIR="$REPO/pi-config/strong-solo" "$PI_NODE" "$PI_CLI" --model openrouter/anthropic/claude-opus-5.5 --no-skills

# cheap-solo
PI_CODING_AGENT_DIR="$REPO/pi-config/cheap-solo" "$PI_NODE" "$PI_CLI" --model openrouter/moonshotai/kimi-k2.7-code --no-skills
```

The same in PowerShell, for the harness. `pi.cmd` uses the adjacent Node 22.23.3.

```powershell
$env:PI_CODING_AGENT_DIR = "C:\Users\Akshat\Desktop\pi_agentic_harness\pi-config\harness"
$env:OPENROUTER_API_KEY = ((Get-Content C:\Users\Akshat\Desktop\pi_agentic_harness\.env | Select-String '^OPENROUTER_API_KEY=').Line -split '=',2)[1].Trim('"')
& "C:\Users\Akshat\AppData\Roaming\fnm\node-versions\v22.23.3\installation\pi.cmd" --model openrouter/anthropic/claude-opus-5.5 --append-system-prompt "C:\Users\Akshat\Desktop\pi_agentic_harness\pi-config\harness\LEAD.md" --subagent-max-depth 1 --no-skills
```

- Interactive sessions are saved under `pi-config/<mode>/sessions/` (gitignored) unless you add `--session-dir`.
- The footer cost **excludes worker spend**.

### (b) Headless JSON-event run of a prompt read from a file

The compare runner uses this form.

```bash
RUN=$REPO/runs/habit-tracker/harness-1          # suggestion: keep logs OUTSIDE the workspace, e.g. $RUN/workspace + $RUN/events.jsonl
SPEC=$REPO/demo-tasks/habit-tracker/SPEC.md
cd "$RUN/workspace"

# harness
PI_CODING_AGENT_DIR="$REPO/pi-config/harness" PI_OFFLINE=1 PI_TELEMETRY=0 \
"$PI_NODE" "$PI_CLI" --mode json \
  --model openrouter/anthropic/claude-opus-5.5 \
  --append-system-prompt "$REPO/pi-config/harness/LEAD.md" \
  --subagent-max-depth 1 --no-skills --no-approve \
  --session-dir "$RUN/pi-sessions" \
  < "$SPEC" > "$RUN/events.jsonl" 2> "$RUN/pi-stderr.log"

# strong-solo
PI_CODING_AGENT_DIR="$REPO/pi-config/strong-solo" PI_OFFLINE=1 PI_TELEMETRY=0 \
"$PI_NODE" "$PI_CLI" --mode json --model openrouter/anthropic/claude-opus-5.5 \
  --no-skills --no-approve --session-dir "$RUN/pi-sessions" \
  < "$SPEC" > "$RUN/events.jsonl" 2> "$RUN/pi-stderr.log"

# cheap-solo
PI_CODING_AGENT_DIR="$REPO/pi-config/cheap-solo" PI_OFFLINE=1 PI_TELEMETRY=0 \
"$PI_NODE" "$PI_CLI" --mode json --model openrouter/moonshotai/kimi-k2.7-code \
  --no-skills --no-approve --session-dir "$RUN/pi-sessions" \
  < "$SPEC" > "$RUN/events.jsonl" 2> "$RUN/pi-stderr.log"
```

From Node, use `spawn(PI_NODE, [PI_CLI, ...args], {cwd, env, stdio:["pipe","pipe","pipe"]})`, write the SPEC to stdin, then call `stdin.end()`. Use absolute paths for every path argument.

Runner notes, mapped to `foreman.config.json`:

- `extraPiArgs`:
  - harness: `["--append-system-prompt","<abs>/pi-config/harness/LEAD.md","--subagent-max-depth","1","--no-skills","--no-approve"]`
  - solo modes: `["--no-skills","--no-approve"]`
- Pass the model as `openrouter/<id>`, or `--provider openrouter --model <id>`.
- `PI_OFFLINE=1` disables startup network work: version check, telemetry, catalog refresh, package auto-install. Inference calls are unaffected. Pair it with a **preflight**:
  - `test -f "$REPO/pi-config/harness/npm/node_modules/@mjakl/pi-subagent/package.json"`
  - `pi auth check --provider openrouter`
  - Without the preflight, a missing package silently disables delegation.
- Do **not** pass `--thinking` unless it is meant for workers too: they inherit it as a fallback. Pi's default is `medium` everywhere.
- Treat the run as failed if the last assistant `message_end` has `stopReason` `error`, `aborted` or `length`. The exit code alone is not enough.
- A minimal usage extractor (Node, no jq here):

  ```js
  // lead: sum message_end where message.role==="assistant" -> message.usage (key by message.provider+"/"+message.model)
  // workers: for each tool_execution_end with toolName==="subagent" -> result.details.results[] -> r.agent, r.model, r.usage
  // skip tool_execution_update; don't also read the toolResult message_end (same details)
  ```

## Live verification log

- **2026-10-15, attempt 1 of the served-model check (step 3 below): blocked by billing, $0 charged.**
  - Preflight passed: `pi auth check` → `ready`; package installed; no context files above the scratch workspace.
  - The lead's first request failed with OpenRouter `402 payment_required`: "You requested up to 128000 tokens, but can only afford 23656". `metadata.limit_source` was `openrouter_credits`.
  - Pi sends each model's catalog `maxTokens` as `max_tokens`; for Opus 5.5 that is 128000. **OpenRouter reserves `max_tokens × output price` before each request** (about $2.56 for Opus at $20/M output), regardless of actual output.
  - State at the time, from `GET /api/v1/key` and `GET /api/v1/credits`: key usage $0, key limit $1; account `total_credits` 5, `total_usage` 4.727 (spend from before this project).
  - Pi exited 0 after 2.6 s with the error only in the assistant `message_end` (`stopReason: "error"`, `errorMessage`). This confirms the runner must check `stopReason`.
  - **To unblock:** keep more than ~$3 of headroom on BOTH the account balance and the key limit for every Opus request.
- **2026-10-15, attempt 2 of the served-model check, with `harness-lite` (Haiku lead, 16k output cap): PASSED. Cost $0.0059.**
  - Same prompt as step 3 below. Command: the harness (b) form with `PI_CODING_AGENT_DIR=pi-config/harness-lite` and `--model openrouter/anthropic/claude-haiku-5.5`. Exit 0 after 24 s. Last `stopReason` was `stop`.
  - Workspace result: `BOARD.md` (plan, contract, task table with both tasks `done`), `hello-backend.txt` = "hello from backend", `hello-frontend.txt` = "hello from frontend".
  - Delegation: a single `subagent` call with `[{agent:"backend"},{agent:"frontend"}]`. No per-call `model` or `thinking`.
  - **Served models, from OpenRouter `GET /api/v1/generation?id=` (authoritative):**
    - backend: 2 generations, `minimax/minimax-m3-20260531`, provider CoreWeave.
    - frontend: 2 generations, `moonshotai/kimi-k2.7-code-20260612`, provider Novita.
  - Lead (Haiku), 3 messages: `/generation` rejects its Anthropic-style `msg_...` ids (400 "Invalid generation ID"). Its model is attested only by Pi's `message_end` (`provider: openrouter`, `model: anthropic/claude-haiku-5.5`, no `responseModel`) and by the key-usage delta.
  - Cost agreement:
    - Key usage delta: $0.005857677 (cost of record).
    - Pi estimate: lead $0.00146 + workers $0.00419 = $0.00564 (3.7% under).
    - Worker generations `total_cost` sum: $0.00440, against Pi's worker estimate of $0.00419.
  - **Key usage is not monotonic right after a run.** Reads at ~5 s intervals: 0.00070861 → 0 → 0.005857677 → 0.005857677. A stale replica can return a lower value. The runner accepts a value only once it repeats on consecutive reads, and never accepts a decrease.
  - Still open for Milestone 0: the same check with the **Opus** lead (needs about $3+ headroom, see attempt 1), and the interactive TUI run (must be started by a person in Windows Terminal).

## Low-cost and free profiles (added 2026-10-15, at the user's request)

- **`pi-config/harness-lite/`** is for cheap demos and plumbing checks. Use it for rehearsals; it does not replace measurement runs.
  - Same three workers and models as `harness`, and the same lead prompt (pass `pi-config/harness/LEAD.md` with `--append-system-prompt`).
  - Default lead is `openrouter/anthropic/claude-haiku-5.5`. Pass `--model openrouter/anthropic/claude-opus-5.5` for an Opus lead.
  - `models.json` uses `modelOverrides` to cap `maxTokens` at 16384 for all four models (supported field: `<pi>/schemas/models.schema.json`; `--list-models` shows "16.4K" here, 128K/512K in `harness`). That cuts OpenRouter's per-request reservation (max_tokens × output price) from $2.56 to $0.33 for Opus, $0.79 to $0.055 for Kimi, $0.61 to $0.02 for MiniMax, and $0.064 to $0.008 for Haiku.
  - Setup: `PI_CODING_AGENT_DIR=<repo>/pi-config/harness-lite pi install npm:@mjakl/pi-subagent@3.1.0`, same as `harness`.
  - Caveat: a response that needs more than 16k output tokens (reasoning included) ends with `stopReason: "length"`. That's fine for small demos; it's the reason measurement runs stay uncapped.
- **`pi-config/harness-free/` (incomplete): every role through a local FreeLLMAPI router** (github.com/tashfeenahmed/freellmapi, MIT). The router uses the user's own free-tier provider keys and exposes OpenAI-compatible `/v1`.
  - The provider now comes from the **`extensions/freellmapi` Pi extension** (below), not from a static `models.json`; that file was removed to avoid two definitions of `freellmapi`.
  - Worker models: `freellmapi/auto:smart` for frontend and backend, `freellmapi/auto:fast` for tests. Pi tries an exact model-id match before treating `:suffix` as a thinking level (`<pi>/dist/core/model-resolver.js` `parseModelPattern`), so the colon ids resolve.
  - Missing: `settings.json`, whose `packages` must list `npm:@mjakl/pi-subagent@3.1.0` and the extension so workers load it too. Writing it was blocked by the session's auto-mode permission classifier ("Traffic Redirection"), pending the user's decision.

## FreeLLMAPI login extension (`extensions/freellmapi/`, added 2026-10-15)

- Adds `/login-with-freellm` and the `freellmapi` provider. Usage is in `extensions/freellmapi/README.md`.
- FreeLLMAPI facts, read from its source via `gh api` (repo HEAD 5a3abac8b4, 2026-10-15):
  - Client auth is `Authorization: Bearer` (or `x-api-key`) with the unified key `freellmapi-<48 hex>` or a client-profile key `sk-cp-…`. A bad key gets 401 `{"error":{"message":"Invalid API key",...}}` (`server/src/routes/proxy.ts`).
  - Health: unauthenticated `GET /livez` returns `{status,version,uptime_s}`; `/api/ping` returns `{status:"ok"}`. `GET /v1/models` returns `context_length` but **no max-output field**.
  - `auto:smart`/`auto:fast` are accepted by the router (`services/router.ts`) but are not listed in `/v1/models`.
  - Login: `POST /api/auth/login {email,password}` returns `{token}`, valid 30 days. `POST /api/client-profiles {name}` returns a separate revocable `sk-cp-` key (`key` field, shown once). `GET /api/settings/api-key` returns the shared unified key. `POST /api/auth/logout`.
  - Lockout: 5 failed logins per email lock that email for 15 minutes (429 + `Retry-After`).
  - No device-code or pairing flow exists.
  - Ports: npm/Docker default to `PORT` 3001. **The desktop app uses 31415**, or the next free port, saved in `%APPDATA%/FreeLLMAPI/config.json`. The desktop account is a hidden `desktop@localhost` user with a random password, so password login can't work there; the tray's *Copy API key* is the route.
- Pi facts, read from `<pi>/dist/core/extensions/types.d.ts` and the docs:
  - `pi.registerCommand`, `ctx.ui.select/confirm/input/notify`, `pi.registerProvider` (callable at runtime; takes effect immediately), `pi.unregisterProvider`, `pi.setModel`, `ctx.modelRegistry.find`, and `getAgentDir()`/`readStoredCredential()` exported from the package root.
  - **Pi has no masked input, and no public API for extensions to write `auth.json`.** So the connection is saved to `<agentDir>/freellmapi.json` (gitignored) and passed as `apiKey`, escaped with `$$`/`$!` because Pi interpolates `$NAME` and a leading `!`.
  - A provider registered with `apiKey` also appears in the built-in `/login`, and a key stored there takes precedence. The command warns when they differ.
  - Non-interactive modes exit before running a command if no model is usable (`<pi>/dist/main.js:755`). Interactive mode starts anyway.
- Verified offline against `extensions/freellmapi/test/mock-freellmapi.mjs` (API shapes copied from FreeLLMAPI's source):
  - `test/rpc-login-test.mjs` drives the interactive flow over Pi's RPC mode, 3/3 scenarios passing: password login → separate `sk-cp-` key → model switch; pasted unified key with a non-default model; wrong password reported and nothing saved.
  - Print mode: login with args; a real streamed chat turn after a fresh start using only the saved connection (no OpenRouter key); `status`; `logout`; the env-only path; a wrong key (401 message); and no server at the URL.
  - **Not yet tested against a real FreeLLMAPI install.**
- Testing pitfall: Git Bash's MSYS path conversion turns a `-p "/login-with-freellm status"` argument into a Windows path, so Pi sends it to the model as a chat message. Set `MSYS_NO_PATHCONV=1`, and then pass Pi's paths as `C:/...`, not `/c/...`.

## Pending live verification (needs `OPENROUTER_API_KEY`)

1. Key visible to Pi: `pi auth check --provider openrouter --json` should report `ready`.
2. Optional, a network call but not inference: refresh the per-key catalog so Pi's prices match the key. Run `PI_CODING_AGENT_DIR=$REPO/pi-config/<mode> "$PI_NODE" "$PI_CLI" update --models` for each mode. It writes `models-store.json` (gitignored). Then check that all four ids are still listed: `"$PI_NODE" "$PI_CLI" --list-models kimi-k2.7` and similar.
3. **PRD §3 step 5, served-model check.** In a scratch git workspace outside the repo, run the harness (b) command with this prompt in `prompt.txt`:

   > Create BOARD.md with a two-task plan. Then, in ONE subagent tool call, delegate in parallel: backend writes hello-backend.txt containing exactly "hello from backend"; frontend writes hello-frontend.txt containing exactly "hello from frontend". Do not pass a model. Verify both files exist, update BOARD.md, and stop.

   Then:
   - From `events.jsonl`, list each `subagent` result's `agent`, `model`, and per-message `provider`/`model`/`responseModel`/`responseId`/`usage.cost.total`. Expect:
     - backend → `minimax/minimax-m3`
     - frontend → `moonshotai/kimi-k2.7-code`
     - lead `message_end` → `anthropic/claude-opus-5.5`
     - `responseModel`, if present, should be a variant of the same family

     One-liner for this:

     ```bash
     node -e 'const L=require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean).map(JSON.parse);for(const e of L){if(e.type==="message_end"&&e.message.role==="assistant")console.log("lead",e.message.model,e.message.responseModel??"",e.message.responseId??"",e.message.usage.cost.total);if(e.type==="tool_execution_start"&&e.toolName==="subagent")console.log("calls",JSON.stringify(e.args.calls.map(c=>({agent:c.agent,model:c.model??null}))));if(e.type==="tool_execution_end"&&e.toolName==="subagent")for(const r of e.result.details.results)for(const m of r.messages)console.log("worker",r.agent,r.model,"->",m.provider,m.model,m.responseModel??"",m.responseId??"",m.usage.cost.total)}' "$RUN/events.jsonl"
     ```

   - The strongest proof is OpenRouter's own record per `responseId`: `curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" "https://openrouter.ai/api/v1/generation?id=<responseId>"`. I am fairly but not fully certain of this endpoint and its fields (`model`, `provider_name`, `total_cost`); check OpenRouter's API docs. I also have not confirmed that ids from the Anthropic-compatible endpoint (`msg_...` style in the mock) are accepted there.
   - Cross-check by hand in the OpenRouter activity dashboard: there should be 3+ generations on three different models.
   - Confirm `hello-backend.txt`, `hello-frontend.txt` and `BOARD.md` exist in the workspace.
4. Repeat interactively with command (a) and watch delegation in the TUI. The PRD requires both modes.
5. Confirm real OpenRouter accepts Pi's request shapes for each model (the mock accepted anything):
   - Anthropic models: adaptive `reasoning` param on `/api/v1/messages`.
   - Kimi and MiniMax: `reasoning:{effort:"medium"}` on `/api/v1/chat/completions`.
6. Check that the OpenRouter key-usage delta for the tiny run roughly matches lead `usage.cost.total` plus the sum of worker `r.usage.cost`. Both are Pi estimates from catalog prices.

## Compare runner (Milestone 2)

- `npm run compare -- --task habit-tracker --modes harness,strong-solo,cheap-solo --runs 2`. Then `npm run report -- --task habit-tracker` rebuilds `results/` from `runs/` logs alone. `npm run selftest` exercises the whole pipeline with a stub Pi and spends $0 (62 checks).
- Pi is invoked only in `scripts/lib/pi.ts`, in the (b) form above. Paths and models come from `foreman.config.json`; worker models come from each profile's `agents/*.md` frontmatter.
- Workspaces live in `%TEMP%/foreman-runs/<task>/`, outside the repo; see "Context files". A copy of the source, without `node_modules`, is kept under `runs/`.
  - Caveat: `PI_CODING_AGENT_DIR` still reveals the repo path to the agent. The contamination check flags any tool call that touches the repo, `demo-tasks/` or the hidden tests (`CONTAMINATION`), and anything outside the workspace (`OUTSIDE_WORKSPACE`).
  - Worker tool calls are visible only through the messages in the subagent results, so the check is a heuristic.
- Preflight aborts before spending if any of these fail:
  - Pi's Node is at least 22.19.
  - Required profile files exist.
  - `pi --help` lists the extension flag (catches the silent `PI_OFFLINE` package skip).
  - The key is present.
  - Both the key's `limit_remaining` and the account's `total_credits − total_usage` are at least `minHeadroomUsd` (default $5; override with `--min-headroom`).
- After a 402 billing error, the remaining runs are skipped.
- **Cost of record** is the change in the key's `/api/v1/key` `data.usage` across a run. Snapshots ignore stale lower reads and need 3 identical consecutive reads (see "Live verification log"). Every raw read is saved in `meta.json`.
- **Breakdown and estimate:** Pi `message_end` usage (lead) plus subagent `details.results[]` (workers, deduplicated by `toolCallId`), priced from OpenRouter `/api/v1/models` with separate cache-read and cache-write prices and long-context tiers. The report flags any difference above 15% from the key delta.
- **Served-model check:** OpenRouter `/api/v1/generation` is called for up to 3 `gen-` ids per role. `msg_` ids are reported as unverifiable.
- **Which runs count** (changed by the coordinator after review, for honesty): only runs that measured nothing about the mode are excluded from means and the headline. That means billing errors (402) and setup, spawn or runner failures; they are listed with the reason and should be re-run. Timeouts, Pi crashes and model-side stops (`stopReason` error, aborted or length) keep their graded score and are flagged. So a mode that often fails can't look better by having those runs dropped.
- `npm run screenshots` is optional. It needs `npm i -D --save-exact playwright@1.63.0 && npx playwright install chromium`; without it, `index.html` shows placeholders.

## Booster changelog (Milestone 3)

- (none yet)
