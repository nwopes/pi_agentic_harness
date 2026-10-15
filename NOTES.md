# NOTES

Verified facts and design decisions for developing the Foreman Pi package (`foreman/`) and the FreeLLMAPI extension (`extensions/freellmapi/`). Each fact cites where it came from.

> The MVP benchmark is preserved at git tag **`mvp-benchmark`** (commit e0554c4) and is not on `main`. That covers the compare runner, the habit-tracker task with its hidden tests, the demo script, the PRD and the solo/measurement profiles. Restore with `git checkout mvp-benchmark -- scripts demo-tasks demo prd_mvp.md foreman.config.json pi-config`.

**Check everything:** `npm run check` (`scripts/check.mjs`) typechecks `foreman/` and `extensions/` against the installed Pi's `dist/index.d.ts`, using a path mapping, because Pi must not be a dependency: `<pi>/docs/packages.md` says "A physical copy can bypass Pi's extension module mapping". It then runs all four offline RPC tests. It finds Pi via `PI_CLI`/`PI_NODE`, then `pi` on PATH, then fnm installs, and runs Pi on the Node next to it.

Path shorthands:

- `<pi>` = `C:/Users/Akshat/AppData/Roaming/fnm/node-versions/v22.23.3/installation/node_modules/@earendil-works/pi-coding-agent` (installed Pi 1.2.0)
- `<sub>` = `node_modules/@mjakl/pi-subagent` (3.1.0, a dependency of the repo-root package)

---

## The Foreman package (design)

- **Layout:** the repo root is the package; `package.json` holds the `pi` manifest. Its files are in `foreman/`: `orchestrate.ts`, `prompt.ts`, `keys.ts`, `shared.ts`, `LEAD.md`, `agents/*.md` and `test/`. Lead mode is `--orchestrate` (headless) or `/orchestrate` (interactive).
- **Why the repo root:** a Pi git source cannot point at a subdirectory. The parser yields only `{repo, host, path, ref}`, and the clone root is the package root (`<pi>/dist/core/package-manager.js:1566-1573,1804`).
- **Load order:** `package.json` `pi.extensions`, which Pi keeps in order (`package-manager.js:1962-1970`):
  1. `foreman/orchestrate.ts`
     - Registers `--orchestrate`, `/orchestrate` and `/team`.
     - Sets `PI_SUBAGENT_MAX_DEPTH=1` before pi-subagent's factory reads it. It uses `??=`, so an explicit value wins (`<sub>/index.ts:386-387,715`).
     - Copies the workers in at `session_start`, and toggles the `subagent` tool with `pi.setActiveTools`.
  2. `./node_modules/@mjakl/pi-subagent`. Pi reads that package's own `pi.extensions` (`package-manager.js:381-405`).
  3. `foreman/prompt.ts` (`before_agent_start`)
     - **On:** adds `LEAD.md` as a `<lead_mode>` section. If pi-subagent already replaced the whole prompt string (it returns `{systemPrompt: event.systemPrompt + list}`, `<sub>/index.ts:772-786`), the section is appended to that string instead.
     - **Off:** removes pi-subagent's `## Available Subagents` block, which it injects even while its tool is inactive.
  4. `foreman/keys.ts`: an `input` handler that saves a pasted OpenRouter key and never forwards the message to a model. It adds no tools and does not touch the prompt (see "OpenRouter key pasted into Pi").
- **LEAD.md goes only to the lead.** Workers are child Pi processes on the same agent dir (`<sub>/runner.ts` spawns with `{...process.env}`), so they would load an agent-dir `AGENTS.md` too. In the original mock run, a team prompt placed in `AGENTS.md` reached all three workers. Hence the prompt is injected by `prompt.ts` and skipped in workers.
- **Dependency, not vendored.**
  - Pi docs: "Other Pi packages used as dependencies must be included in the published tarball and referenced through their `node_modules` resource paths" (`<pi>/docs/packages.md:90`).
  - Git installs run `npm install --omit=dev --legacy-peer-deps` in the clone (`package-manager.js:1495-1496,1570-1573`).
  - Local paths are not installed for you (`packages.md:88`), so run `npm ci`.
  - Publishing to npm would need `bundledDependencies`.
  - Vendoring would also be allowed: the license is MIT, © 2026 Michael Jakl (`<sub>/LICENSE`).
  - Pi core packages are optional `peerDependencies` `"*"`. `packages.md:88` says not to bundle them; a physical copy can create duplicate classes and registries.
- **Worker discovery has no hook.** pi-subagent reads only `getAgentDir()/agents` and trusted project `.pi/agents` (`<sub>/agents.ts:152-166`).
  - So `orchestrate.ts` copies `foreman/agents/*.md` there at `session_start`, marked `managed-by: pi-foreman`. This happens before pi-subagent's own discovery, because of load order.
  - Files without the marker are the user's: never overwritten, they override that worker, and `/team` says so.
- **Workers load the package too.** They inherit `PI_CODING_AGENT_DIR`, and pi-subagent forwards unknown parent flags such as `--orchestrate` (`<sub>/runner-cli.js:273-286`).
  - The flag is therefore registered in workers as well; otherwise Pi exits with "Unknown option".
  - Everything else is skipped when `PI_SUBAGENT_DEPTH > 0`, which pi-subagent sets for children.
- **Lead-mode audit entry.** Pi's JSON log records the base system prompt, not extension edits (checked offline: no `<lead_mode>` in any event).
  - So `prompt.ts` writes a `foreman-lead-applied` session entry with the SHA-256 of `LEAD.md` each time it applies it, and Pi emits it as `entry_appended`.
  - The system message's `toolsAdded` shows whether `subagent` was active.
- **Toggle persistence.** `/orchestrate` writes a `foreman-orchestrate` session entry. On resume, the last saved toggle wins over the flag, as in Pi's plan-mode example; fresh sessions take the flag.
- **Flag parsing caveats** (`<pi>/dist/cli/args.js:247-251`; `agent-session-services.js:27-29`):
  - `--orchestrate "task"` consumes `"task"` as the flag's value. Put the flag last, or pipe the prompt on stdin.
  - A boolean extension flag is `true` whatever value is given, so `--orchestrate=false` is still on.
- **`/team` and other extensions.** `/team` emits `pi.events` `foreman:worker-models` with `{lead, redirect: {}}`. A listener may set `redirect.model`/`redirect.by` synchronously; the FreeLLMAPI extension does this.

### Verified

- **Offline tests** (local stand-in for OpenRouter, which records what Pi actually sends):
  - `foreman/test/rpc-orchestrate-test.mjs`, 11/11:
    - off by default;
    - `/orchestrate` on, then off, in one session (lead section, agent list and `subagent` tool in the request);
    - `/team` models;
    - `--orchestrate` on at start;
    - a simulated worker with a forwarded `--orchestrate` stays a worker, without "Unknown option";
    - depth 1 without `--subagent-max-depth`;
    - resume keeps ON, then `/orchestrate off`, then stays OFF.
  - `foreman/test/rpc-keys-test.mjs`: 11/11.
  - `extensions/freellmapi/test/rpc-workers-test.mjs`: 8/8.
- **Local install:** `pi install <abs path>` and `pi install ./` (stored relative to the agent dir). `--help` then lists `--orchestrate` and `--subagent-max-depth`.
- **Git install** (2026-10-15, commit 913c3d1, fresh agent dirs):
  - Installed in three forms: `pi install git:github.com/nwopes/pi_agentic_harness`, `@<commit>`-pinned, and `https://github.com/nwopes/pi_agentic_harness`.
  - Each cloned to `<agentDir>/git/github.com/nwopes/pi_agentic_harness`, with only `@mjakl` in `node_modules` (no devDependencies).
  - The offline test passed from the installed copy.
  - `pi remove <source>` left `packages: []`.
  - Updating one package is `pi update <source>`. Plain `pi update` updates Pi itself, and `pi update --extensions` updates all packages.
- **Live delegation, 2026-10-15**, `pi-config/dev` (Haiku lead, 16k cap), `--orchestrate`, hello-world prompt:
  - Exit 0 in about 20 s. `BOARD.md` and both files correct.
  - One `foreman-lead-applied` entry; `subagent` active; delegation `[{backend},{frontend}]` with no per-call model.
  - OpenRouter `/generation`: backend on `minimax/minimax-m3-20260531`, frontend on `moonshotai/kimi-k2.7-code-20260612`.
  - Key-usage delta **$0.005077**; Pi's estimate was $0.00550.
  - An earlier run of the same check, before the package existed, had served the same two models, and its delta was $0.0059.

## Pinned versions and models

| What | Pinned value | Pi model ref |
|---|---|---|
| Pi | `@earendil-works/pi-coding-agent@1.2.0` | n/a |
| Node used to run Pi | 22.23.3 (fnm) | n/a |
| Subagent package | `@mjakl/pi-subagent@3.1.0` (integrity `sha512-nXxtjCdOdnwEY0jcm4y8x9sOvP/0J6nBjoc2TPWtFmvypaF1EC9Aso54S6Vu0PawWkLxzaNlN+dKsaSCCBPScg==`) | n/a |
| Strong lead (user's choice) | OpenRouter `anthropic/claude-opus-5.5` | `openrouter/anthropic/claude-opus-5.5` |
| frontend worker | OpenRouter `moonshotai/kimi-k2.7-code` | `openrouter/moonshotai/kimi-k2.7-code` |
| backend worker | OpenRouter `minimax/minimax-m3` | `openrouter/minimax/minimax-m3` |
| tests worker | OpenRouter `anthropic/claude-haiku-5.5` | `openrouter/anthropic/claude-haiku-5.5` |

- **Where the ids come from:**
  - The user chose them.
  - All four are in Pi 1.2.0's built-in OpenRouter catalog (`<pi>/dist/bundle/chunks/chunk-TJXZSVTD.js`; RPC `get_available_models`).
  - The two Anthropic models use `api: anthropic-messages` with `baseUrl https://openrouter.ai/api`; Kimi and MiniMax use `api: openai-completions` with `https://openrouter.ai/api/v1` (same sources).
- **Catalog prices, per 1M tokens:** a snapshot from Pi's build time, I believe; check against OpenRouter `/api/v1/models`.
  - opus-5.5: 4 / 20 (input/output), cache read 0.2, cache write 5
  - kimi-k2.7-code: 0.6712 / 3.35, cache read 0.18
  - minimax-m3: 0.3 / 1.2, cache read 0.06
  - haiku-5.5: 0.1 / 0.5, cache read 0.01, cache write 0.125; 0.5 / 2.5 above 100k input tokens
- **Always use the `openrouter/` prefix.** Pi also has built-in `anthropic` and `minimax` providers; the prefixed form is unambiguous (`pi --help` "supports provider/id").

## Installing Pi (this machine)

- **`@mariozechner/pi-coding-agent` (0.73.1) is deprecated** in favour of `@earendil-works/pi-coding-agent` (`npm view … deprecated`). Both subagent candidates need Pi >= 0.87.1.
- **Pi >= 0.75.0 requires Node >= 22.19.0** (`<pi>/CHANGELOG.md` [0.75.0]; `engines`). System Node here is 22.12.0.
- **Install methods:**
  - Official installer: `irm https://pi.dev/install.ps1 | iex`. I read it but did not run it: with old Node it offers to prepend a standalone Node to the user PATH.
  - Instead, leaving system Node and PATH untouched:

    ```bash
    fnm install 22.23.3 && fnm default system
    PND=/c/Users/Akshat/AppData/Roaming/fnm/node-versions/v22.23.3/installation
    PATH="$PND:$PATH" "$PND/npm.cmd" install -g --ignore-scripts @earendil-works/pi-coding-agent@1.2.0
    ```

  - `fnm exec … npm` fails in Git Bash ("program not found"), so call `npm.cmd` directly.
- **Running it:**
  - Pi is not on PATH. The launchers `pi`, `pi.cmd` and `pi.ps1` are in `$PND` and use the `node.exe` next to them.
  - From scripts, run `"$PI_NODE" "$PI_CLI" …` with `PI_NODE=$PND/node.exe` and `PI_CLI=$PND/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`.
  - Don't spawn `pi.cmd` from Node without `shell:true`: Node refuses `.cmd` without a shell, and a shell breaks multi-line args.

## OpenRouter

- **Provider and credentials**
  - Built-in provider: "Authenticate with `/login openrouter` or `OPENROUTER_API_KEY`" (`<pi>/docs/providers.md` "OpenRouter").
  - **A key saved in `auth.json` beats `OPENROUTER_API_KEY`.** Verified in `rpc-keys-test.mjs`: with both set, Pi sent the saved key.
  - **Pi does not load `.env`.** There is no `dotenv`/`loadEnvFile` in `<pi>/dist`; the caller must export the key, or save it with the paste feature or `/login`.
  - Offline presence check: `pi auth check --provider openrouter --json` → `ready`/`not_ready`. It checks presence only (`<pi>/docs/cli.md` "Credential commands").
- **Model selection**
  - `--model openrouter/<vendor>/<model>`, or `--provider openrouter --model <vendor>/<model>`.
  - Always pass `--model` in automated runs. Pitfall: a nonexistent `PI_CODING_AGENT_DIR` is silently created, and Pi then falls back to OpenRouter's default `moonshotai/kimi-k2.6`.
- **Per-key model list** (new in 1.2.0): with a key, Pi lists only the models that key may use, from `/models/user`.
  - It refreshes at interactive startup, on `/model`, after `/login`, or with `pi update --models`.
  - The list is saved to `<agentDir>/models-store.json` and used offline and in `-p`/RPC mode (`providers.md` "OpenRouter").
- **Wire formats.** Pi sends `anthropic/*` models in Anthropic Messages format (`<baseUrl>/v1/messages`, key in `x-api-key`), and others to `<baseUrl>/chat/completions` with `Authorization: Bearer`. A local stand-in must serve both; point the provider at it with `models.json` `{"providers":{"openrouter":{"baseUrl":"http://127.0.0.1:<port>/…"}}}` (`<pi>/docs/models.md`).
- **402 from the `max_tokens` reservation.**
  - Pi sends each model's catalog `maxTokens` as `max_tokens` (Opus 5.5: 128000).
  - OpenRouter reserves `max_tokens × output price` before every request, about $2.56 for Opus, whatever the actual output.
  - With a small balance the request fails: `402 … You requested up to 128000 tokens, but can only afford 23656`.
  - Fix: more headroom on both the account balance and the key limit, or a `modelOverrides` `maxTokens` cap (see `pi-config/dev`).
- **Key endpoints:**
  - `GET /api/v1/key`: key `usage`, `limit`, `limit_remaining`. It reads info only and is not a model call.
  - `GET /api/v1/credits`: the account's `total_credits`/`total_usage`.
  - `GET /api/v1/generation?id=<gen-…>`: the served model, provider and `total_cost` per generation. It rejects Anthropic-style `msg_…` ids ("Invalid generation ID").
- **Key usage reads are not monotonic right after a run.** Reads at about 5 s intervals went 0.00070861 → 0 → 0.005857677 → 0.005857677. Accept a value only once it repeats, and never a decrease.
- **Pi's cost figures are estimates.** `usage.cost` is computed by Pi from catalog rates (`calculateCost`), not reported by OpenRouter; the key-usage delta is the cost of record.

## `PI_CODING_AGENT_DIR`, context files and trust

- **The agent dir.** `PI_CODING_AGENT_DIR` overrides it (default `~/.pi/agent`) (`<pi>/docs/environment-variables.md`, `configuration.md`).
  - It holds `settings.json`, `models.json`, `auth.json`, `mcp.json`, `AGENTS.md`/`CLAUDE.md`, `SYSTEM.md`, `APPEND_SYSTEM.md`, `extensions/`, `skills/`, `prompts/`, `themes/`, `sessions/`, `npm/`, `git/` and `trust.json`, plus `agents/` for pi-subagent.
  - With the override set, `~/.pi` is never read.
- **Global skills leak in.** Pi loads skills from `~/.agents/skills/` regardless (`<pi>/docs/skills.md`). This machine has `find-skills` there.
  - Pass `--no-skills`; @mjakl forwards it to workers.
- **Context files** (`<pi>/dist/core/resource-loader.js` `loadProjectContextFiles()`):
  - First, one of `AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD` from the agent dir.
  - Then one per directory **from the cwd up to the filesystem root**, with no stop at the git root.
  - So keep the repo root free of `AGENTS.md`/`CLAUDE.md`, and run test workspaces in OS temp.
  - `--no-context-files` disables all of them, including the agent-dir file.
- **Project trust.** Project `.pi/` resources load only after project trust. In print, JSON and RPC modes trust defaults to "skip"; `--no-approve` makes that explicit, and @mjakl forwards it (`<pi>/docs/security.md`).

## Non-interactive modes and where usage appears

Sources: `<pi>/docs/cli.md`, `cli-integration.md`, `json.md`, `rpc.md`, `message-types.md`.

- **The modes:** `-p` (print), `--mode json` (JSONL events, then exit), `--mode rpc` (a long-lived JSONL command/response channel).
- **JSON mode exits 0 even when the model call errored.** Check the last assistant `message_end.message.stopReason` (`error`, `aborted`, `length`).
- **The event stream:**
  - It starts with the session header, then `agent_start` … `agent_end`, `agent_settled`; `agent_settled` is the true end of a run.
  - Pi 1.2 also emits the lead's system prompt as a `message.role:"system"` message with `sections`.
- **Framing:** strict LF-delimited JSONL. Don't use Node `readline`, which splits on U+2028/2029.
- **Prompts on Windows:** pipe them on stdin (`readPipedStdin()` in `<pi>/dist/main.js`), and close stdin. Positional args break on newlines in `.cmd` shims.
- **Lead usage:** each assistant `message_end.message` has `provider`, `model`, `responseModel?`, `responseId?` and `usage`.
  - `usage` = `{input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost:{…, total}}`, in USD; `reasoning` is already inside `output`.
  - `turn_end`/`agent_end` repeat these messages, so count `message_end` once.
- **Worker usage** appears only inside the `subagent` tool result:
  - Where to read it: `tool_execution_end` (`toolName === "subagent"`) `result.details.results[]`. The same `details` is also on the `toolResult` `message_end`; read one of the two, keyed by `toolCallId`.
  - Each result has `agent`, `model` (the configured string, not the served model), `exitCode`, `stopReason`, `usage:{…, cost, contextTokens, turns}`, and `messages[]` with per-message `provider/model/responseModel/responseId/usage` (`<sub>/types.ts`).
  - `tool_execution_update` heartbeats carry partial results; never sum them.
  - The `toolResult` message has `usage: null`, so **Pi's footer and `/session` cost exclude worker spend.**
  - @mjakl gaps: worker compaction usage is not captured, and `messages[]` keeps only a rolling 5 MB window (the totals survive).
- **Errors and non-interactive startup:**
  - Non-interactive modes exit before running a command if no model is usable (`<pi>/dist/main.js:755`).
  - *But:* RPC mode with `--model openrouter/…` and no OpenRouter key did start and run commands (`rpc-keys-test.mjs`). The exit may apply only when no model is named; not checked.

## @mjakl/pi-subagent 3.1.0

- **Why this package** and not oira666_pi-subagent@0.5.14: oira666 ignores agent-file `model` whenever the parent model is known (`runner/arguments.ts` `resolveSubagentModel()` returns `currentParentModel ?? agentModel`). @mjakl uses `callModel ?? agentModel`, with the parent model as fallback only (`<sub>/runner.ts` `buildModelArgs()`). In the mock run, workers requested their own frontmatter models.
- **The tool:** `subagent` takes `{calls:[{agent, prompt, model?, thinking?, cwd?, initialContext?, session?, inactivityTimeout?, timeout?}]}`, with 1–8 calls per tool call at concurrency 4 (`<sub>/index.ts`).
  - **A per-call `model` overrides the agent file.** It cannot be disabled by config. The FreeLLMAPI extension relies on it.
- **Children:**
  - Each worker is a separate Pi process, `process.execPath <pi rpc-entry>` in RPC mode with `shell:false` (`<sub>/runner.ts` `resolvePiSpawn()`).
  - Its env is `{...process.env, PI_OFFLINE:"1", PI_SUBAGENT_DEPTH, …}`, so it inherits `PI_CODING_AGENT_DIR` and `OPENROUTER_API_KEY`.
  - The prompt goes over stdin. The agent body goes in via `--append-system-prompt <tmpfile>`.
- **Depth:** the default is 3, which lets workers delegate to each other. Depth propagates through `PI_SUBAGENT_MAX_DEPTH`, and the factory reads it once (`<sub>/index.ts` `canDelegate`). Foreman sets 1, so workers get only `read,bash,edit,write`.
- **Flags children inherit** (`<sub>/runner-cli.js`; parsed only when `PI_CODING_AGENT=true`, which Pi's CLI sets):
  - Forwarded: `--no-skills`, `-nc`, `--api-key`, `--models`, `--exclude-tools`, `--system-prompt`, `--session-dir`, `--no-approve`, and unknown flags (by a heuristic).
  - Fallbacks only: `--model`, `--thinking`, `--tools`. Workers inherit `--thinking X` unless their frontmatter sets `thinking:`.
  - Blocked: `--mode`, `-p`, `--append-system-prompt`, `--offline`, `--subagent-max-depth` and the session flags.
- **Frontmatter:** `name` and `description` (both required), `model`, `thinking`, `tools`, `noTools`, `inactivityTimeout`, `sessionPreference`, `sessionHint`. There is no provider field; prefix it in `model` (`<sub>/agents.ts` `parseAgentFile`).
- **Agent scopes:**
  - User agents: `<agentDir>/agents/*.md`.
  - Project agents: the nearest `.pi/agents/`. They win on a name clash, but only with explicit project trust (`<sub>/index.ts` `shouldIncludeProjectAgents`).
  - With no agents at all, @mjakl creates a starter `explore.md`.
- **Compatibility:** peer range `>=0.87.1`; runs on Pi 1.2.0.

## Pi extension and package API (as used here)

From `<pi>/dist/core/extensions/types.d.ts`, `<pi>/docs/extensions.md` and `<pi>/docs/packages.md`.

- **Exports and registration**
  - Package-root exports used: `getAgentDir()`, `readStoredCredential()`, `ModelRuntime`.
  - `pi.registerCommand`, `pi.registerFlag({type:"boolean"})`; `pi.getFlag` is valid from `session_start` on.
  - `pi.registerProvider` takes effect immediately at runtime; `pi.unregisterProvider`, `pi.setModel`, `ctx.modelRegistry.find/refresh`.
  - `pi.setActiveTools/getActiveTools/getAllTools`.
- **Session and UI**
  - `pi.appendEntry(customType, data)` appears as `entry_appended` in JSON mode; `ctx.sessionManager.getBranch()`.
  - `ctx.ui.notify/select/input/confirm`, `ctx.hasUI` (true in TUI and RPC), `ctx.model`.
  - **No masked input exists.**
- **Events**
  - `before_agent_start`: `event.systemPrompt` and `event.systemPromptOptions.sections` (mutable; rendered as `<name>…</name>`). Returning `{systemPrompt}`, or setting `forceSystemPrompt`, replaces the whole prompt for that run.
  - `input`: the result can be `{action:"continue"}`, `{action:"transform", text}` or `{action:"handled"}`; `handled` stops the message before any model sees it.
  - `tool_call`: "can mutate input or block execution". `ToolCallEventResult`: "To modify arguments, mutate `event.input` in place". A failing handler blocks the tool.
  - `pi.events`: a Node `EventEmitter` (`<pi>/dist/core/event-bus.js`). A listener runs synchronously inside `emit()` up to its first `await`.
- **Writing `auth.json`**
  - `ModelRuntime.create({authPath, modelsPath: null, refreshOnCreate: false}).login(provider, "api_key", {prompt, notify})` writes `<authPath>` under Pi's `proper-lockfile` lock. This is the same call interactive `/login` makes (`interactive-mode.js` `loginProvider`).
  - `AuthStorage` itself is not exported.
- **Packages**
  - Sources: `pi install ./path | git:github.com/u/r[@ref] | https://github.com/u/r`, plus `pi remove <source>`.
  - `PI_CODING_AGENT_DIR=<dir> pi install …` writes `<dir>/settings.json` `packages` and installs into `<dir>/npm/` or `<dir>/git/`.
  - A package declared in settings but not installed is auto-installed at startup when online. **With `PI_OFFLINE=1` it is silently skipped**, with no warning.
  - A provider registered with `apiKey` also appears in the built-in `/login`, and a key stored there takes precedence.

## Windows specifics

- **The bash tool** uses Git Bash: the `shellPath` setting, then `C:\Program Files\Git\bin\bash.exe`, then `bash.exe` on PATH (`<pi>/docs/windows.md`).
- **PATH and tools:** started as `"$PI_NODE" "$PI_CLI"` without PATH changes, the agent's shell sees the **system** `node` v22.12.0.
- **TTY:**
  - The interactive TUI needs a real console. With no `--mode`, a non-TTY stdin or stdout silently selects print mode (`<pi>/dist/main.js` `resolveAppMode`).
  - Run interactive Pi in Windows Terminal. I believe, but have not verified, that mintty doesn't give `node.exe` a console.
- **Killing a run:** kill the whole process tree (`taskkill /T /F /PID <pid>`); workers are child `node.exe` processes.
- **Git Bash quirks:**
  - MSYS path conversion rewrites `/…` arguments, for example `-p "/login-with-freellm status"`, into Windows paths. Set `MSYS_NO_PATHCONV=1`; then Pi paths must be `C:/...` and taskkill flags single-slash (`/F`).
  - Long paths: `pi install git:…` failed with `fetch-pack: invalid index-pack output` under a 186-character agent dir, because pack paths exceed 260 characters while `core.longpaths` is off. Use a shorter agent dir (the default `~/.pi/agent` is fine) or `git config --global core.longpaths true`.
- **Test cleanup:** directories stay locked until child processes exit. Clean up on `exit` with `rmSync(…, {maxRetries})`.

## Sessions

- **Where they go:** `<agentDir>/sessions/` by default, grouped by cwd.
  - Overrides, in order: `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, the `sessionDir` setting.
  - `--no-session` keeps the session in memory only (`<pi>/docs/cli.md`, `settings.md`).
- **Workers:** named worker sessions need a persisted parent session. Plain worker calls use `--no-session` (`<sub>/README.md`).
- **Settings changes:** Pi rewrites `settings.json` on `/model` (`settings-manager.js`). Check `git diff pi-config` after interactive use.

## `pi-config/dev` (run the package from the repo cheaply)

- **What it is:**
  - `settings.json` loads the repo root as a package (`"packages": ["../.."]`), with the default lead `openrouter/anthropic/claude-haiku-5.5`. Pass `--model openrouter/anthropic/claude-opus-5.5` for an Opus lead.
  - `models.json` `modelOverrides` caps `maxTokens` at 16384 for the four models (`<pi>/schemas/models.schema.json`).
- **What the cap saves:** it cuts OpenRouter's per-request reservation from $2.56 to $0.33 for Opus, $0.79 to $0.055 for Kimi, $0.61 to $0.02 for MiniMax, and $0.064 to $0.008 for Haiku.
- **Caveat:** an answer needing more than 16k output tokens (reasoning included) ends with `stopReason: "length"`.
- **Use:** `npm ci` in the repo, then `PI_CODING_AGENT_DIR=<repo>/pi-config/dev "$PI_NODE" "$PI_CLI" --no-skills --orchestrate`.
- **Gitignored runtime files:** Pi writes `auth.json` and `models-store.json` on any start, even `--help`, plus `sessions/`, `npm/`, `git/`, `trust.json` and `agents/` (the synced worker copies) under the profile. All are gitignored via `pi-config/*/…`.

## FreeLLMAPI extension (`extensions/freellmapi/`)

- **What it adds:** `/login-with-freellm` and the `freellmapi` provider. Usage is in `extensions/freellmapi/README.md`.
- **FreeLLMAPI facts**, read from its source via `gh api` (repo HEAD 5a3abac8b4, 2026-10-15):
  - **Client auth:** `Authorization: Bearer` (or `x-api-key`) with the unified key `freellmapi-<48 hex>` or a client-profile key `sk-cp-…`. A bad key gets 401 "Invalid API key" (`server/src/routes/proxy.ts`).
  - **Health:** unauthenticated `GET /livez` (`{status,version,uptime_s}`) and `/api/ping`.
  - **Models:** `GET /v1/models` gives `context_length` but **no max-output field**. `auto:smart`/`auto:fast` are accepted by the router (`services/router.ts`) but not listed.
  - **Login:** `POST /api/auth/login {email,password}` returns `{token}`, valid 30 days. `POST /api/client-profiles {name}` returns a separate revocable `sk-cp-` key, shown once. `GET /api/settings/api-key` returns the unified key. `POST /api/auth/logout`.
  - **Lockout:** 5 failed logins per email lock that email for 15 minutes (429 + `Retry-After`). No device-code flow exists.
  - **Ports:** npm/Docker default to 3001. The **desktop app uses 31415** (or the next free port, in `%APPDATA%/FreeLLMAPI/config.json`). Its account has a hidden random password, so the tray's *Copy API key* is the only route there.
- **Design:**
  - The connection is saved to `<agentDir>/freellmapi.json` (gitignored) and passed as `apiKey`. Escape it with `$$`/`$!`, because Pi interpolates `$NAME` and a leading `!`.
  - It was written before `ModelRuntime.login` was found (see the API section), so it does not use `auth.json`.
  - Max output is `min(8192, context)`, matching FreeLLMAPI's own `setup-pi` generator.
- **Workers stay off OpenRouter.** While `ctx.model.provider === "freellmapi"`, a `tool_call` handler sets every `subagent` call's `model` to `freellmapi/<lead model id>`, leaving explicit `freellmapi/…` models alone.
  - It answers Foreman's `foreman:worker-models` query, so `/team` shows the switch.
  - Workers get the provider because they inherit `PI_CODING_AGENT_DIR` and so load the same packages and `freellmapi.json`.
- **Verified offline:**
  - `test/rpc-login-test.mjs` against `test/mock-freellmapi.mjs`, 3/3: password login → separate key → model switch; pasted unified key; wrong password.
  - Print mode: login with args, a streamed turn using only the saved connection, `status`, `logout`, the env-only path, a wrong key, and no server.
  - `test/rpc-workers-test.mjs`, 8/8:
    - Lead on `freellmapi/auto:smart` with `--orchestrate`: a real worker process sent `auto:smart` to FreeLLMAPI with the FreeLLMAPI key, and **zero requests reached OpenRouter**, even though `OPENROUTER_API_KEY` was set.
    - Control run, lead on OpenRouter: the worker went to OpenRouter as `minimax/minimax-m3`.
- **Not tested against a real FreeLLMAPI install.**

## OpenRouter key pasted into Pi (`foreman/keys.ts`)

- **Built-in alternative:** Pi already has `/login openrouter`, which saves an `api_key` credential in `<agentDir>/auth.json`. Its prompt is a plain TUI `Input`, so the key is visible while typed (`login-dialog.js`).
- **The paste flow:** a message containing `sk-or-v<n>-<32+ alnum>` returns `{action:"handled"}`, so it never reaches a model.
  - The key is first checked with `GET https://openrouter.ai/api/v1/key`: refused on 401, saved anyway if OpenRouter can't be reached, and not checked under `PI_OFFLINE`.
  - It is then saved via `ModelRuntime.login("openrouter", "api_key")`. The only prompt is `{type:"secret", message:"Enter OpenRouter API key"}`, with no network call, and it writes `{"openrouter":{"type":"api_key","key":…}}`.
  - Workers (`PI_SUBAGENT_DEPTH>0`) don't register the handler.
- **Verified offline, `foreman/test/rpc-keys-test.mjs`, 11/11:**
  - A pasted key causes 0 model requests and lands in `auth.json`.
  - The next prompt in the same session sends it, with no restart.
  - A new process on the same agent dir (what a worker is) sends it.
  - A key inside a longer message is saved and not sent. Two keys: nothing sent, nothing saved.
  - The full key never appears in Pi's output; `/team` shows it masked.
  - With both set, Pi sends the saved key over `OPENROUTER_API_KEY`, and `/team` says so.
- **Not verified:** a real key through the paste flow (the `/api/v1/key` check was not run live) and the `/login` TUI dialog itself.

## Not yet verified (open)

- **The Opus lead live.** It needs about $3+ of headroom on the account balance and on the key limit; the balance was about $0.26.
- **The interactive TUI.** It has to be started by a person in Windows Terminal; everything here was driven over RPC or JSON.
- **`/orchestrate` toggled with a real model.** It was verified only against the stand-in; `--orchestrate` was verified live.
- **Real OpenRouter accepting Pi's request shapes for every model.** The stand-ins accepted anything. Anthropic models get an adaptive `reasoning` param on `/v1/messages`; Kimi and MiniMax get `reasoning:{effort:"medium"}` on `/chat/completions`.
- **A real FreeLLMAPI server, and a real OpenRouter key through the paste flow.**
