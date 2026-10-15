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
