// Pi extension: connect Pi to a self-hosted FreeLLMAPI router (https://github.com/tashfeenahmed/freellmapi).
//
//   /login-with-freellm                  guided: find the server, get a key, pick a model
//   /login-with-freellm <url> [key]      non-interactive (key falls back to $FREELLMAPI_API_KEY)
//   /login-with-freellm status | logout
//
// The connection is saved to <agentDir>/freellmapi.json (honours PI_CODING_AGENT_DIR) and re-registered on
// every start, so subagent workers that share the agent dir can use `freellmapi/<model>` too.
// FreeLLMAPI API facts (routes, key formats, ports) are from its source; see NOTES.md.
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { getAgentDir, readStoredCredential, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

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
function report(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info") {
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

async function chooseModel(ctx: ExtensionCommandContext, models: SavedModel[]): Promise<string> {
  const ids = providerModels(models).map((m) => m.id);
  const ordered = [...new Set([PREFERRED_MODEL, "auto", "auto:fast", ...ids.filter((id) => id.startsWith("auto")), ...ids])].filter((id) => ids.includes(id));
  if (!ctx.hasUI) return ordered[0];
  const picked = await ctx.ui.select("Switch to which FreeLLMAPI model? (auto:smart is a good default for coding)", ordered);
  return picked ?? ordered[0];
}

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

  pi.registerCommand("login-with-freellm", {
    description: "Connect Pi to your FreeLLMAPI router (free-tier models) and switch to one of its models",
    getArgumentCompletions: (prefix) =>
      ["status", "logout"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const [first, second] = args.trim().split(/\s+/).filter(Boolean);
      const current = loadConfig();

      if (first === "status") {
        report(ctx, current ? `Connected to ${current.baseUrl} with key ${maskKey(current.apiKey)}; ${current.models.length} models (saved ${current.savedAt}).` : "Not connected. Run /login-with-freellm.");
        return;
      }
      if (first === "logout") {
        if (existsSync(configPath())) rmSync(configPath());
        pi.unregisterProvider(PROVIDER);
        report(ctx, "Removed the saved FreeLLMAPI connection. A key made for Pi stays valid until you delete its client profile in the FreeLLMAPI dashboard.");
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

        const id = await chooseModel(ctx, models);
        const model = ctx.modelRegistry.find(PROVIDER, id);
        const switched = model ? await pi.setModel(model) : false;
        report(
          ctx,
          `Connected to ${root} (${models.length} models, key ${maskKey(apiKey)}). ${switched ? `Now using ${PROVIDER}/${id}.` : `Use /model to pick a ${PROVIDER}/… model.`}`,
          switched ? "info" : "warning",
        );
      } catch (err) {
        report(ctx, err instanceof Error ? err.message : String(err), "error");
      }
    },
  });
}
