// Pi extension: connect Pi to a self-hosted FreeLLMAPI router (https://github.com/tashfeenahmed/freellmapi).
//
//   /login-with-freellm                  guided: find the server, get a key, pick a model
//   /login-with-freellm <url> [key]      non-interactive (key falls back to $FREELLMAPI_API_KEY)
//   /login-with-freellm status | logout
//   /freellm [off|all] [model]           free-only mode: "all" puts the lead on FreeLLMAPI at every start
//
// The connection is saved to <agentDir>/freellmapi.json (honours PI_CODING_AGENT_DIR) and re-registered on
// every start, so subagent workers that share the agent dir can use `freellmapi/<model>` too. The /freellm
// setting is saved to <agentDir>/freellmapi-mode.json. Which models Foreman's workers use is Foreman's /workers
// (its "freellm" preset runs them here); Foreman also keeps workers off paid models while the lead is on FreeLLMAPI.
// FreeLLMAPI API facts (routes, key formats, ports) are from its source; see NOTES.md.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { getAgentDir, readStoredCredential, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER = "freellmapi";
// Desktop app, the port this repo recommends for npm installs (3001 is the habit-tracker API), FreeLLMAPI's default.
const CANDIDATE_ROOTS = ["http://127.0.0.1:31415", "http://127.0.0.1:3901", "http://127.0.0.1:3001"];
// Accepted by FreeLLMAPI's router but not listed by /v1/models.
const ROUTER_STRATEGIES = ["auto:smart", "auto:fast"];
const PREFERRED_MODEL = "auto:smart";
const KEY_PATTERN = /^(freellmapi-[0-9a-f]{48}|sk-cp-[A-Za-z0-9_-]{8,})$/;
// FreeLLMAPI's /v1/models has no max-output field; its own setup-pi generator uses min(8192, context).
const MAX_OUTPUT_TOKENS = 8192;

interface SavedModel {
  id: string;
  name: string;
  contextWindow: number;
}
interface SavedConfig {
  baseUrl: string; // server root, without /v1
  apiKey: string;
  models: SavedModel[];
  savedAt: string;
}

const configPath = () => join(getAgentDir(), "freellmapi.json");

/** off: the lead is whatever you pick; all: the lead runs on FreeLLMAPI at every start (free only). Worker models: Foreman /workers. */
type Mode = "off" | "all";
const MODES: readonly Mode[] = ["off", "all"];
interface ModeSetting {
  mode: Mode;
  model: string; // FreeLLMAPI model id used by "all"
}
const modePath = () => join(getAgentDir(), "freellmapi-mode.json");

function loadMode(): ModeSetting {
  try {
    const s = JSON.parse(readFileSync(modePath(), "utf-8")) as Partial<ModeSetting>;
    if (MODES.includes(s.mode as Mode) && typeof s.model === "string" && s.model) return { mode: s.mode as Mode, model: s.model };
  } catch {
    // no setting saved yet
  }
  return { mode: "off", model: PREFERRED_MODEL };
}

const isWorkerProcess = () => Number(process.env.PI_SUBAGENT_DEPTH ?? 0) > 0;

function loadConfig(): SavedConfig | undefined {
  try {
    if (!existsSync(configPath())) return undefined;
    const cfg = JSON.parse(readFileSync(configPath(), "utf-8")) as SavedConfig;
    return typeof cfg.baseUrl === "string" && typeof cfg.apiKey === "string" && Array.isArray(cfg.models) ? cfg : undefined;
  } catch {
    return undefined;
  }
}

function saveConfig(cfg: SavedConfig) {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

function normalizeRoot(url: string): string {
  let u = url.trim();
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, "").replace(/\/v1$/i, "");
}

function isLoopback(root: string): boolean {
  const host = new URL(root).hostname;
  return host === "localhost" || host === "::1" || host === "[::1]" || host.startsWith("127.");
}

const maskKey = (key: string) => (key.length > 16 ? `${key.slice(0, 12)}…${key.slice(-4)}` : "…");

// Pi interpolates `$NAME` and a leading `!command` in apiKey strings; `$$` and `$!` are the escapes.
const escapeApiKey = (key: string) => key.replace(/\$/g, "$$$$").replace(/^!/, "$$!");

async function request(url: string, init: RequestInit = {}, timeoutMs = 10_000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    // non-JSON body; keep `text` for error messages
  }
  return { res, body, text };
}

/** True if a FreeLLMAPI server answers at this root (unauthenticated /livez, falling back to /api/ping). */
async function probe(root: string): Promise<boolean> {
  for (const path of ["/livez", "/api/ping"]) {
    try {
      const { res, body } = await request(`${root}${path}`, {}, 1500);
      if (res.ok && body && typeof body.status === "string") return true;
    } catch {
      // not reachable
    }
  }
  return false;
}

async function listModels(root: string, apiKey: string): Promise<SavedModel[]> {
  const { res, body, text } = await request(`${root}/v1/models?available=true`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (res.status === 401) throw new Error("FreeLLMAPI rejected the API key (401 Invalid API key).");
  if (!res.ok || !Array.isArray(body?.data)) throw new Error(`GET /v1/models failed: ${res.status} ${text.slice(0, 200)}`);
  return body.data
    .filter((m: any) => typeof m?.id === "string" && m.available !== false)
    .map((m: any) => ({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id,
      contextWindow: Number(m.context_length ?? m.context_window) || 128_000,
    }));
}

/** Email/password login → a separate, revocable client-profile key for Pi → logout. The password is never stored. */
async function keyFromPassword(root: string, email: string, password: string): Promise<string> {
  const login = await request(`${root}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (login.res.status === 429) {
    const wait = login.res.headers.get("retry-after");
    throw new Error(`Too many failed logins for this email; FreeLLMAPI locked it${wait ? ` for ${wait}s` : ""}.`);
  }
  if (login.res.status === 401) throw new Error("Wrong email or password.");
  const token = login.body?.token;
  if (!login.res.ok || typeof token !== "string") throw new Error(`Login failed: ${login.res.status} ${login.text.slice(0, 200)}`);
  const auth = { Authorization: `Bearer ${token}` };
  try {
    const profile = await request(`${root}/api/client-profiles`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: `pi (${hostname()})` }),
    });
    if (profile.res.ok && typeof profile.body?.key === "string") return profile.body.key;
    // Older servers without client profiles: fall back to the shared unified key.
    const unified = await request(`${root}/api/settings/api-key`, { headers: auth });
    if (unified.res.ok && typeof unified.body?.apiKey === "string") return unified.body.apiKey;
    throw new Error(`Could not obtain an API key: ${profile.res.status} ${profile.text.slice(0, 200)}`);
  } finally {
    await request(`${root}/api/auth/logout`, { method: "POST", headers: auth }).catch(() => undefined);
  }
}

/** Reads the clipboard (the desktop app's tray has "Copy API key"). Returns undefined on any failure or opt-out. */
function readClipboard(): Promise<string | undefined> {
  if (process.env.FREELLMAPI_NO_CLIPBOARD) return Promise.resolve(undefined);
  const [cmd, args] =
    process.platform === "win32"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]]
      : process.platform === "darwin"
        ? ["pbpaste", []]
        : ["sh", ["-c", "wl-paste --no-newline 2>/dev/null || xclip -o -selection clipboard 2>/dev/null"]];
  return new Promise((resolve) => {
    execFile(cmd, args as string[], { timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? undefined : String(stdout).trim()));
  });
}

function providerModels(models: SavedModel[]) {
  const ids = new Set(models.map((m) => m.id));
  const all = [...models, ...ROUTER_STRATEGIES.filter((id) => !ids.has(id)).map((id) => ({ id, name: `FreeLLMAPI ${id}`, contextWindow: 128_000 }))];
  return all.map((m) => ({
    id: m.id,
    name: m.name,
    // The router picks the upstream per request, so no model can promise a thinking API.
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: m.contextWindow,
    maxTokens: Math.min(MAX_OUTPUT_TOKENS, m.contextWindow),
  }));
}

function register(pi: ExtensionAPI, cfg: SavedConfig) {
  pi.registerProvider(PROVIDER, {
    name: "FreeLLMAPI",
    baseUrl: `${cfg.baseUrl}/v1`,
    api: "openai-completions",
    apiKey: escapeApiKey(cfg.apiKey),
    headers: { "User-Agent": "pi-coding-agent" },
    models: providerModels(cfg.models),
  });
}

/** Notifications are no-ops without a UI (print/JSON mode), so fall back to stderr there. */
function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else process.stderr.write(`[freellmapi] ${level}: ${message}\n`);
}

async function chooseServer(ctx: ExtensionCommandContext, saved?: SavedConfig): Promise<string | undefined> {
  const candidates = [...new Set([saved?.baseUrl, ...CANDIDATE_ROOTS].filter((u): u is string => !!u))];
  const found = (await Promise.all(candidates.map(async (u) => ((await probe(u)) ? u : undefined)))).filter((u): u is string => !!u);
  if (!ctx.hasUI) return found[0];
  if (!found.length) {
    ctx.ui.notify(
      "FreeLLMAPI doesn't seem to be running (nothing answered on 127.0.0.1:31415, :3901 or :3001). " +
        "Start the FreeLLMAPI desktop app (https://github.com/tashfeenahmed/freellmapi/releases), or a server install with PORT=3901, " +
        "add at least one provider key in its dashboard, then run /login-with-freellm again. Or enter its URL below.",
      "warning",
    );
  }
  const other = "Enter another URL…";
  const choice = found.length
    ? await ctx.ui.select("FreeLLMAPI server", [...found.map((u) => `${u}  (running)`), other])
    : other;
  if (choice === undefined) return undefined;
  if (choice !== other) return choice.replace(/\s+\(running\)$/, "");
  const typed = await ctx.ui.input(
    found.length ? "FreeLLMAPI URL" : "No FreeLLMAPI server found on 31415/3901/3001. Enter its URL",
    "http://127.0.0.1:31415",
  );
  return typed?.trim() ? normalizeRoot(typed) : undefined;
}

async function obtainKey(ctx: ExtensionCommandContext, root: string): Promise<string | undefined> {
  const clip = await readClipboard();
  if (clip && KEY_PATTERN.test(clip) && (await ctx.ui.confirm("Use the FreeLLMAPI key on your clipboard?", maskKey(clip)))) return clip;

  const paste = "Paste an API key (desktop app: tray menu → Copy API key; or the dashboard)";
  const password = "Sign in with email and password (creates a separate, revocable key for Pi)";
  const how = await ctx.ui.select("How do you want to sign in?", [paste, password]);
  if (how === paste) {
    return (await ctx.ui.input("FreeLLMAPI API key (typing is visible on screen)", "freellmapi-… or sk-cp-…"))?.trim() || undefined;
  }
  if (how === password) {
    const email = (await ctx.ui.input("FreeLLMAPI email"))?.trim();
    if (!email) return undefined;
    const pass = await ctx.ui.input("FreeLLMAPI password (NOT masked; it is used once and never stored)");
    if (!pass) return undefined;
    return keyFromPassword(root, email, pass);
  }
  return undefined;
}

async function chooseModel(
  ctx: ExtensionCommandContext,
  ids: string[],
  title = "Switch to which FreeLLMAPI model? (auto:smart is a good default for coding)",
): Promise<string | undefined> {
  const ordered = [...new Set([PREFERRED_MODEL, "auto", "auto:fast", ...ids.filter((id) => id.startsWith("auto")), ...ids])].filter((id) => ids.includes(id));
  if (!ctx.hasUI) return ordered[0];
  return ctx.ui.select(title, ordered);
}

/** FreeLLMAPI model ids Pi can use right now (empty when FreeLLMAPI isn't connected). */
const freeModelIds = (ctx: ExtensionContext) => ctx.modelRegistry.getAll().filter((m) => m.provider === PROVIDER).map((m) => m.id);

export default function freellmapi(pi: ExtensionAPI) {
  const saved = loadConfig();
  if (saved) register(pi, saved);
  // Headless use without a login: FREELLMAPI_API_KEY (+ optional FREELLMAPI_URL) registers the router strategies.
  else if (process.env.FREELLMAPI_API_KEY?.trim()) {
    register(pi, {
      baseUrl: normalizeRoot(process.env.FREELLMAPI_URL ?? CANDIDATE_ROOTS[0]),
      apiKey: process.env.FREELLMAPI_API_KEY.trim(),
      models: [{ id: "auto", name: "FreeLLMAPI auto", contextWindow: 128_000 }],
      savedAt: "env",
    });
  }

  const leadOf = (ctx: ExtensionContext) => (ctx.model && ctx.model.provider !== "unknown" ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

  const showStatus = (ctx: ExtensionContext) => {
    const s = loadMode();
    if (ctx.hasUI) ctx.ui.setStatus(PROVIDER, s.mode === "all" ? `FreeLLMAPI: everything (${s.model})` : undefined);
  };
  const describeMode = (s: ModeSetting) =>
    s.mode === "all"
      ? `FreeLLMAPI: all. The lead runs on ${PROVIDER}/${s.model}, and Pi switches to it at every start. Foreman's workers follow a FreeLLMAPI lead unless /workers picks other free models, so nothing is paid.`
      : `FreeLLMAPI: off. The lead is whatever you pick with /model. Choose the workers' models with /workers (freellm = FreeLLMAPI, free = free OpenRouter models).`;
  /** The lead the session had before "all" switched it to FreeLLMAPI, so "off" can switch back. */
  let previousLead: NonNullable<ExtensionContext["model"]> | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (isWorkerProcess()) return; // workers get their model from the lead's subagent call
    showStatus(ctx);
    const s = loadMode();
    if (s.mode !== "all" || ctx.model?.provider === PROVIDER) return;
    const free = ctx.modelRegistry.find(PROVIDER, s.model);
    if (!free) {
      report(ctx, `/freellm is set to "all", but FreeLLMAPI isn't connected, so this session starts on ${leadOf(ctx) ?? "no model"}. Run /login-with-freellm, or /freellm off.`, "warning");
      return;
    }
    previousLead = ctx.model;
    if (await pi.setModel(free)) report(ctx, `Free-only mode (/freellm all): using ${PROVIDER}/${s.model}.`);
  });

  pi.registerCommand("freellm", {
    description: "Free-only mode: /freellm all runs the lead (and so its workers) on FreeLLMAPI at every start; /freellm off undoes it",
    getArgumentCompletions: (prefix) => [...MODES, "status"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const [arg, modelArg] = args.trim().split(/\s+/).filter(Boolean);
      const current = loadMode();
      if (arg === "status" || (!arg && !ctx.hasUI)) return report(ctx, describeMode(current));
      if (arg === "workers") {
        return report(ctx, "Worker models are chosen with /workers now: /workers freellm runs every worker on FreeLLMAPI while your lead stays on the model you picked.", "warning");
      }

      let mode = arg as Mode | undefined;
      if (!mode) {
        const labels: Record<Mode, string> = {
          off: "off: the lead is whatever you pick with /model",
          all: "all: everything on FreeLLMAPI (free only)",
        };
        const picked = await ctx.ui.select(`Free-only mode? (now: ${current.mode})`, MODES.map((m) => labels[m]));
        if (!picked) return;
        mode = MODES.find((m) => labels[m] === picked);
      }
      if (!mode || !MODES.includes(mode)) return report(ctx, "Usage: /freellm [off|all] [model] | status   (worker models: /workers)", "warning");

      const next: ModeSetting = { mode, model: current.model };
      if (mode === "all") {
        const ids = freeModelIds(ctx);
        if (!ids.length) return report(ctx, "FreeLLMAPI isn't connected yet. Run /login-with-freellm first, then /freellm again.", "warning");
        const model = modelArg ?? (!arg ? await chooseModel(ctx, ids, "Which FreeLLMAPI model for everything?") : current.model);
        if (!model) return;
        if (!ids.includes(model)) return report(ctx, `${PROVIDER}/${model} isn't a FreeLLMAPI model Pi knows. Available: ${ids.join(", ")}`, "warning");
        next.model = model;
      }
      writeFileSync(modePath(), JSON.stringify(next, null, 2) + "\n");

      // Move the lead: onto FreeLLMAPI for "all", back to the lead it replaced for "off".
      const onFree = ctx.model?.provider === PROVIDER;
      if (mode === "all") {
        const free = ctx.modelRegistry.find(PROVIDER, next.model);
        if (free && !(onFree && ctx.model?.id === next.model)) {
          if (!onFree) previousLead = ctx.model;
          await pi.setModel(free);
        }
      } else if (onFree && previousLead) {
        await pi.setModel(previousLead);
        previousLead = undefined;
      }
      showStatus(ctx);
      const stillFree = mode === "off" && ctx.model?.provider === PROVIDER;
      report(ctx, describeMode(next) + (stillFree ? ` Your lead is still ${leadOf(ctx)}; pick a different one with /model.` : ""));
    },
  });

  pi.registerCommand("login-with-freellm", {
    description: "Connect Pi to your FreeLLMAPI router (free-tier models) and switch to one of its models",
    getArgumentCompletions: (prefix) =>
      ["status", "logout"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const [first, second] = args.trim().split(/\s+/).filter(Boolean);
      const current = loadConfig();

      if (first === "status") {
        report(
          ctx,
          (current ? `Connected to ${current.baseUrl} with key ${maskKey(current.apiKey)}; ${current.models.length} models (saved ${current.savedAt}).` : "Not connected. Run /login-with-freellm.") +
            `\n${describeMode(loadMode())}`,
        );
        return;
      }
      if (first === "logout") {
        for (const file of [configPath(), modePath()]) if (existsSync(file)) rmSync(file);
        pi.unregisterProvider(PROVIDER);
        showStatus(ctx);
        report(ctx, "Removed the saved FreeLLMAPI connection and set /freellm back to off. A key made for Pi stays valid until you delete its client profile in the FreeLLMAPI dashboard.");
        return;
      }

      try {
        const root = first ? normalizeRoot(first) : await chooseServer(ctx, current);
        if (!root) return report(ctx, ctx.hasUI ? "Cancelled." : "No FreeLLMAPI server found. Usage: /login-with-freellm <url> [key]", "warning");
        if (!(await probe(root))) return report(ctx, `No FreeLLMAPI server answered at ${root}/livez. Is it running?`, "error");
        if (!isLoopback(root) && !root.startsWith("https://")) report(ctx, `${root} is not local and not HTTPS: your key will travel unencrypted.`, "warning");

        const apiKey = second ?? (ctx.hasUI ? await obtainKey(ctx, root) : process.env.FREELLMAPI_API_KEY?.trim());
        if (!apiKey) return report(ctx, ctx.hasUI ? "Cancelled." : "No key: pass it as the second argument or set FREELLMAPI_API_KEY.", "warning");

        const models = await listModels(root, apiKey);
        const cfg: SavedConfig = { baseUrl: root, apiKey, models, savedAt: new Date().toISOString() };
        saveConfig(cfg);
        register(pi, cfg);

        const stored = readStoredCredential(PROVIDER) as { type?: string; key?: string } | undefined;
        if (stored?.key && stored.key !== apiKey) {
          report(ctx, "A FreeLLMAPI key saved earlier with /login takes precedence over this one. Run /logout and pick FreeLLMAPI to remove it.", "warning");
        }

        const id = (await chooseModel(ctx, providerModels(models).map((m) => m.id))) ?? PREFERRED_MODEL;
        const model = ctx.modelRegistry.find(PROVIDER, id);
        const switched = model ? await pi.setModel(model) : false;
        report(
          ctx,
          `Connected to ${root} (${models.length} models, key ${maskKey(apiKey)}). ${switched ? `Now using ${PROVIDER}/${id}.` : `Use /model to pick a ${PROVIDER}/… model.`} To keep a paid lead and run only the workers here, use /freellm workers.`,
          switched ? "info" : "warning",
        );
      } catch (err) {
        report(ctx, err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
