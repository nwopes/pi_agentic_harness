// Which model each worker really runs on, given the /workers setting, and how /team describes the team.
// A helper module, not an extension: orchestrate.ts and workers.ts import it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { maskKey, openRouterKey } from "./keys.ts";
import { PACKAGE_DIR, team, type Worker } from "./shared.ts";

export type Preset = "paid" | "free" | "freellm";
export const PRESETS: readonly Preset[] = ["paid", "free", "freellm"];
/** Delegation depth Foreman allows at most: 1 = workers only, 2 = workers may use sub-workers, 3 = one level more. */
export const MAX_DEPTH = 3;

interface PresetDefaults {
  label: string;
  /** Model per worker name. "paid" has none: the agent files' own models are the paid defaults. */
  models?: Record<string, string>;
}
interface Defaults {
  presets: Record<Preset, PresetDefaults>;
  depth: number;
}
/** The user's choice, saved in <agentDir>/foreman-workers.json. */
export interface WorkerSettings {
  preset: Preset;
  /** Per-preset model choices that replace the defaults, e.g. { free: { frontend: "openrouter/x:free" } }. */
  models: Partial<Record<Preset, Record<string, string>>>;
  /** How deep free workers may delegate (1..MAX_DEPTH). */
  depth: number;
}

export const defaults = (): Defaults => JSON.parse(readFileSync(join(PACKAGE_DIR, "workers.json"), "utf8"));
const settingsPath = () => join(getAgentDir(), "foreman-workers.json");

export function loadSettings(): WorkerSettings {
  const d = defaults();
  const fallback: WorkerSettings = { preset: "paid", models: {}, depth: d.depth };
  try {
    if (!existsSync(settingsPath())) return fallback;
    const s = JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<WorkerSettings>;
    return {
      preset: PRESETS.includes(s.preset as Preset) ? (s.preset as Preset) : "paid",
      models: s.models && typeof s.models === "object" ? s.models : {},
      depth: Number.isInteger(s.depth) && s.depth! >= 1 && s.depth! <= MAX_DEPTH ? s.depth! : d.depth,
    };
  } catch {
    return fallback;
  }
}

export const saveSettings = (s: WorkerSettings) => writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + "\n");

/** "openrouter/cohere/x:free" -> ["openrouter", "cohere/x:free"]. */
export const splitModel = (model: string): [string, string] => {
  const i = model.indexOf("/");
  return i < 0 ? ["", model] : [model.slice(0, i), model.slice(i + 1)];
};

export const leadOf = (ctx: ExtensionContext) =>
  // With no usable model (e.g. no key yet) Pi reports a placeholder "unknown/unknown".
  ctx.model && ctx.model.provider !== "unknown" ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

/** True when Pi knows the model and it costs nothing (FreeLLMAPI models, OpenRouter :free models). */
export function isFree(ctx: ExtensionContext, model: string): boolean {
  const m = ctx.modelRegistry.find(...splitModel(model));
  return !!m && m.cost.input === 0 && m.cost.output === 0;
}

/** Why a worker can't run on this model right now, or undefined if it can. */
export function unavailable(ctx: ExtensionContext, model: string): string | undefined {
  const [provider] = splitModel(model);
  const m = ctx.modelRegistry.find(...splitModel(model));
  if (!m) {
    return provider === "freellmapi"
      ? `${model} isn't available because FreeLLMAPI isn't connected (run /login-with-freellm)`
      : `${model} isn't a model Pi knows (mistyped, or no longer offered)`;
  }
  if (!ctx.modelRegistry.hasConfiguredAuth(m)) {
    return provider === "openrouter" ? `${model} needs an OpenRouter key (paste your key into Pi to save it)` : `${model} has no credentials for ${provider}`;
  }
  return undefined;
}

export interface TeamRow extends Worker {
  /** The model this worker runs on now. */
  effective: string;
  /** Why it is that model. */
  why: "preset" | "your choice" | "agent file" | "follows your FreeLLMAPI lead";
}

/** Each package worker with the model it runs on under the current setting. */
export function effectiveTeam(ctx: ExtensionContext, s = loadSettings()): TeamRow[] {
  const d = defaults();
  const lead = leadOf(ctx);
  return team(getAgentDir()).map((w) => {
    const chosen = s.models[s.preset]?.[w.name];
    if (chosen) return { ...w, effective: chosen, why: "your choice" };
    // A FreeLLMAPI lead never spends OpenRouter credit: with paid workers, they follow the lead instead.
    if (s.preset === "paid" && lead?.startsWith("freellmapi/")) return { ...w, effective: lead, why: "follows your FreeLLMAPI lead" };
    const preset = d.presets[s.preset].models?.[w.name];
    return preset ? { ...w, effective: preset, why: "preset" } : { ...w, effective: w.model, why: "agent file" };
  });
}

/** The /team and /workers text. */
export function describeTeam(ctx: ExtensionContext, leadModeOn: boolean): string {
  const s = loadSettings();
  const d = defaults();
  const lead = leadOf(ctx);
  const rows = effectiveTeam(ctx, s);
  const width = Math.max(...rows.map((r) => r.effective.length), (lead ?? "").length, 20);
  const lines = rows.map((r) => {
    const notes = [isFree(ctx, r.effective) ? "free" : "", r.why === "preset" || r.why === "agent file" ? "" : r.why, r.source === "package" ? "" : `your file: ${r.source}`, unavailable(ctx, r.effective) ? "NOT AVAILABLE" : ""];
    const note = notes.filter(Boolean).join(", ");
    return `  ${r.name.padEnd(9)} ${r.effective.padEnd(width)}${note ? `   (${note})` : ""}`;
  });
  const anyFree = rows.some((r) => isFree(ctx, r.effective));
  const depthLine =
    s.depth > 1
      ? `Sub-workers: workers on free models may split their task, up to depth ${s.depth}${anyFree ? "" : " (none of these workers is free, so none will)"}.`
      : "Sub-workers: off (depth 1).";
  const usesOpenRouter = (lead?.startsWith("openrouter/") ?? false) || rows.some((r) => r.effective.startsWith("openrouter/"));
  const key = openRouterKey();
  const keyLine = !usesOpenRouter
    ? "OpenRouter key: not used by this team"
    : key.source === "saved"
      ? `OpenRouter key: saved, ${maskKey(key.key!)}${key.envAlsoSet ? " (used instead of OPENROUTER_API_KEY)" : ""}`
      : key.source === "env"
        ? `OpenRouter key: from OPENROUTER_API_KEY, ${maskKey(key.key!)}`
        : "OpenRouter key: none yet. Paste your key into Pi (just the key) to save it.";
  const problems = rows.map((r) => unavailable(ctx, r.effective)).filter((p): p is string => !!p);
  return [
    `Foreman team: lead mode ${leadModeOn ? "ON" : "OFF"}; workers: ${s.preset} (${d.presets[s.preset].label})`,
    `  ${"lead".padEnd(9)} ${(lead ?? "(no model selected)").padEnd(width)}   (this session's model${leadModeOn ? "" : "; working alone"})`,
    ...lines,
    depthLine,
    keyLine,
    ...(problems.length ? [`Not available: ${[...new Set(problems)].join("; ")}. Delegation to those workers is blocked until fixed, or pick others with /workers.`] : []),
    leadModeOn ? "Change workers with /workers; toggle lead mode with /orchestrate." : "Turn on with /orchestrate (or start Pi with --orchestrate). Change workers with /workers.",
  ].join("\n");
}
