# pi-freellmapi: `/login-with-freellm` for Pi

A Pi extension that connects Pi to a self-hosted [FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) router, so Pi can run on free-tier models using your own provider keys.

## Use it

```bash
pi -e <repo>/extensions/freellmapi            # just this session
pi install <repo>/extensions/freellmapi       # every session for this agent dir (writes settings.json)
```

In Pi, run `/login-with-freellm`. It:

1. **Finds your server.** It probes `127.0.0.1:31415` (desktop app), `:3901` (the port this repo recommends) and `:3001` (FreeLLMAPI's default) via the unauthenticated `/livez`, or you type a URL. You're warned if the URL is neither local nor HTTPS.
2. **Gets a key**, whichever way you choose:
   - **Clipboard:** if your clipboard holds a FreeLLMAPI key (the desktop tray has *Copy API key*), it asks to use it and shows only a masked preview.
   - **Paste** a `freellmapi-…` or `sk-cp-…` key. Pi has no masked input, so typing is visible.
   - **Email and password** (server/Docker installs): it logs in, creates a **separate, revocable key just for Pi** (a FreeLLMAPI client profile named `pi (<hostname>)`), and logs out. The password is never stored and is also typed visibly. This can't work on the desktop app, whose account has a hidden random password, so use the clipboard there.
3. **Validates** the key with `GET /v1/models?available=true`.
4. **Saves** the connection to `<agentDir>/freellmapi.json` (gitignored under `pi-config/`), registers the `freellmapi` provider, and switches the session to the model you pick. `auto:smart` is listed first.

Other forms:

| Command | Effect |
|---|---|
| `/login-with-freellm <url> [key]` | No prompts. The key falls back to `$FREELLMAPI_API_KEY`. Works in print and JSON mode. |
| `/login-with-freellm status` | Shows the URL, a masked key, and the model count. |
| `/login-with-freellm logout` | Deletes the saved connection. A Pi-specific key stays valid until you delete its client profile in the dashboard. |
| `FREELLMAPI_API_KEY` (+ `FREELLMAPI_URL`) | With no saved connection, registers `freellmapi/auto`, `auto:smart` and `auto:fast` at startup. No login is needed for headless runs. |

Models: whatever `/v1/models` lists (`auto`, `auto:<profile>`, catalog ids), plus `auto:smart` and `auto:fast`. The router accepts those two but doesn't list them. All are registered as zero-cost, text-only and non-reasoning, with max output `min(8192, context)`, matching FreeLLMAPI's own `setup-pi` generator.

## How much should FreeLLMAPI do? `/freellm`

| Setting | Lead (orchestration) | Workers | Use it when |
|---|---|---|---|
| `/freellm off` (default) | the model you picked | their own models (Foreman's: OpenRouter, paid) | you want the best results |
| `/freellm workers` | the model you picked, e.g. Opus on OpenRouter | **FreeLLMAPI, free** | a good model plans and checks, free models do the typing |
| `/freellm all` | **FreeLLMAPI, free** | **FreeLLMAPI, free** | free only: nothing goes to OpenRouter |

- **`/freellm` on its own** opens a list: pick the setting, then the FreeLLMAPI model (`auto:smart` first).
- **`/freellm workers auto:fast`** sets the setting and the model in one go. Without a model, the last one you chose is used (default `auto:smart`). `/freellm status` shows the current setting.
- **It's saved.** The setting is stored in `<agentDir>/freellmapi-mode.json` and applies to every session until you change it. The footer shows it while it isn't `off`.
- **`all` also moves the lead.** It switches the session to FreeLLMAPI right away and at every start, even when Pi is launched with a paid `--model`. `off` and `workers` switch back to the lead you had before, if `all` replaced it in this session.
- **A FreeLLMAPI lead always takes its workers along,** even with `off`: if you pick a `freellmapi/…` model yourself, nothing goes to OpenRouter.
- **Never a silent fallback to paid models.** If the setting says workers run on FreeLLMAPI but FreeLLMAPI isn't connected, worker calls are blocked with a message saying why. They don't quietly run on OpenRouter. `/freellm workers` or `all` is refused until you've run `/login-with-freellm`. `/login-with-freellm logout` also resets the setting to `off`.
- Foreman's `/team` shows the effective worker models, for example `backend freellmapi/auto:smart (FreeLLMAPI, /freellm workers: instead of openrouter/minimax/minimax-m3)`.

## Your OpenRouter key stays out of it

- **The lead:** Pi sends each provider only its own key. A `freellmapi/…` session talks to FreeLLMAPI with the FreeLLMAPI key, and your OpenRouter key never goes there.
- **Workers:** when they run on FreeLLMAPI (see `/freellm` above), every `subagent` call is moved onto the FreeLLMAPI model before it runs. A call that already names a `freellmapi/…` model is left alone.
- **How it works:** a `tool_call` handler sets each call's `model` field, and `@mjakl/pi-subagent` lets a per-call model override the agent file's. Worker processes share the agent dir, so they load this extension and its saved connection too.
- **Pi may still contact OpenRouter in the background,** for example to refresh its OpenRouter model list at startup when it has a key. That call reads the model list and is not a model request.

## Troubleshooting

- **"Error: No API key found for the selected model" right after typing `/login-with-freellm`:** the extension isn't loaded, so Pi sent your text to the model as a chat message. Pi's startup header lists loaded extensions under `[Extensions]`; if that section is missing, start Pi with `-e <repo>/extensions/freellmapi` or `pi install` it. In PowerShell, run the launcher as `& "<path>\pi.cmd" ...`. In cmd.exe, drop the `&`.
- **"FreeLLMAPI doesn't seem to be running":** start the desktop app, or a server install with `PORT=3901`, and add at least one provider key in its dashboard first.

## Good to know

- **Non-interactive Pi needs a usable model to start.** In print, JSON and RPC mode, Pi exits before running any command if no provider has credentials (`dist/main.js:755`). The very first login therefore has to happen in the interactive TUI, or you pass `FREELLMAPI_API_KEY`. Interactive Pi starts without one.
- **A key saved with `/login` wins.** Once this provider is registered, it also appears in Pi's built-in `/login` list, and a key stored there overrides this one. The command warns you if they differ; remove the old one with `/logout`.
- **Git Bash mangles `/…` arguments.** When scripting `pi -p "/login-with-freellm …"` from Git Bash, MSYS rewrites the leading `/` into a Windows path unless you set `MSYS_NO_PATHCONV=1`. This doesn't affect the TUI.
- **Subagent workers** load extensions from the agent dir's `settings.json`, not from `-e`. Use `pi install` for a harness profile so workers can use `freellmapi/...` models.
- Set `FREELLMAPI_NO_CLIPBOARD=1` to skip the clipboard check.

## Tests (offline, $0)

```bash
node test/mock-freellmapi.mjs 3901 &                         # fake FreeLLMAPI: me@example.com / hunter22
node test/rpc-login-test.mjs <pi-node> <pi-cli>              # clicks through the interactive flow over Pi's RPC mode
```

`rpc-login-test.mjs` covers three scenarios: password login → separate Pi key → model switch; pasted unified key with a non-default model; wrong password (error shown, nothing saved).

```bash
node test/rpc-workers-test.mjs <pi-node> <pi-cli>            # self-contained; needs no mock running
```

`rpc-workers-test.mjs` (21 checks) loads the Foreman package and this extension. One local server stands in for both FreeLLMAPI and OpenRouter, and the lead answers each prompt with a real `subagent` call.
- **Lead on FreeLLMAPI:** the worker process's request reaches FreeLLMAPI as `auto:smart` with the FreeLLMAPI key, and zero requests reach OpenRouter.
- **Control run, lead on OpenRouter:** the worker goes to OpenRouter as `minimax/minimax-m3`, so the test would catch a leak.
- **`/freellm workers`:** the lead's requests stay on OpenRouter and the worker's go to FreeLLMAPI. `/team`, the notice and the footer all show it, and the setting survives a restart.
- **`/freellm all`, then `off`:** after `all`, lead and worker are both on FreeLLMAPI with zero OpenRouter requests. After `off`, the paid lead and paid workers are back.
- **Saved `all`:** a session launched with a paid model starts on FreeLLMAPI.
- **Plain `/freellm`:** picking from both lists works.
- **Not connected:** the command is refused, and a saved `workers` setting blocks delegation instead of paying.
