// The OpenRouter key, the easy way: paste it into Pi's prompt and it is saved. It is never sent to a model.
//
// The key is stored with Pi's own credential store: ModelRuntime.login("openrouter", "api_key"), the call `/login
// openrouter` makes. So it lands in <agentDir>/auth.json, `/logout` removes it, and every Pi process on that agent dir
// uses it, the lead and each worker alike. Pi sends a provider's key only to that provider.
import { join } from "node:path";
import { getAgentDir, ModelRuntime, readStoredCredential, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWorker } from "./shared.ts";

const PROVIDER = "openrouter";
/** OpenRouter keys are sk-or-v1-<64 hex>; this also matches a later key version. */
const KEY_PATTERN = /sk-or-v\d+-[A-Za-z0-9]{32,}/g;

export const maskKey = (key: string) => `${key.slice(0, 12)}…${key.slice(-4)}`;

/** Where Pi would get an OpenRouter key from right now: the key saved in auth.json, else OPENROUTER_API_KEY. */
export function openRouterKey(): { source: "saved" | "env" | "none"; key?: string; envAlsoSet: boolean } {
  const stored = readStoredCredential(PROVIDER) as { type?: string; key?: string } | undefined;
  const env = process.env.OPENROUTER_API_KEY?.trim();
  if (stored?.type === "api_key" && stored.key) return { source: "saved", key: stored.key, envAlsoSet: !!env };
  if (env) return { source: "env", key: env, envAlsoSet: true };
  return { source: "none", envAlsoSet: false };
}

/** Ask OpenRouter whether the key is valid. GET /api/v1/key only reads the key's info and costs nothing. */
async function check(key: string): Promise<{ valid: boolean; note: string }> {
  if (process.env.PI_OFFLINE) return { valid: true, note: "not checked: PI_OFFLINE is set" };
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401) return { valid: false, note: "OpenRouter says this key is invalid or revoked (401)" };
    return { valid: true, note: res.ok ? "OpenRouter accepted it" : `not checked: OpenRouter answered ${res.status}` };
  } catch {
    return { valid: true, note: "not checked: OpenRouter could not be reached" };
  }
}

async function save(key: string) {
  const runtime = await ModelRuntime.create({ authPath: join(getAgentDir(), "auth.json"), modelsPath: null, refreshOnCreate: false });
  await runtime.login(PROVIDER, "api_key", {
    prompt: async (p) => {
      if (p.type !== "secret" && p.type !== "text") throw new Error(`Pi's OpenRouter login asked something unexpected: ${p.message}`);
      return key;
    },
    notify: () => {},
  });
}

function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else process.stderr.write(`[foreman] ${level}: ${message}\n`);
}

export default function keys(pi: ExtensionAPI) {
  if (isWorker()) return; // workers get their prompts from the lead, never from you

  pi.on("input", async (event, ctx) => {
    const found = [...new Set(event.text.match(KEY_PATTERN) ?? [])];
    if (!found.length) return { action: "continue" };
    // From here on the message is never forwarded: a key in a prompt would go to whichever model is selected.
    if (found.length > 1) {
      report(ctx, "That message had more than one OpenRouter key, so it was not sent and nothing was saved. Paste one key on its own.", "warning");
      return { action: "handled" };
    }
    const key = found[0];
    const { valid, note } = await check(key);
    if (!valid) {
      report(ctx, `Not saved: ${note}. Your message was not sent to the model.`, "error");
      return { action: "handled" };
    }
    const previous = openRouterKey();
    try {
      await save(key);
      await ctx.modelRegistry.refresh({ providers: [PROVIDER], allowNetwork: !process.env.PI_OFFLINE }).catch(() => undefined);
    } catch (err) {
      report(ctx, `Could not save the OpenRouter key: ${err instanceof Error ? err.message : String(err)}. Your message was not sent to the model.`, "error");
      return { action: "handled" };
    }
    const replaced = previous.source === "saved" && previous.key !== key ? ` It replaces the key saved before (${maskKey(previous.key!)}).` : "";
    report(
      ctx,
      `Saved your OpenRouter key ${maskKey(key)} to ${join(getAgentDir(), "auth.json")} (${note}). It was not sent to the model.${replaced}\n` +
        "Pi uses it only for openrouter/… models, including Foreman's workers. /logout removes it.",
    );
    return { action: "handled" };
  });
}
