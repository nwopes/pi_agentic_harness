// Which models Foreman's workers run on, and whether free workers may hand parts of their task to sub-workers.
//
//   /workers                             pick from a list: preset, one worker's model, or sub-worker depth
//   /workers paid | free | freellm       paid OpenRouter models / free OpenRouter models / FreeLLMAPI
//   /workers <worker> <model|default>    one worker's model within the current preset
//   /workers depth <1-3>                 1 = no sub-workers; 2 = free workers may use sub-workers; 3 = one level more
//   /workers status
//
// The setting is saved in <agentDir>/foreman-workers.json. A tool_call handler puts the chosen model on every
// subagent call (a call's `model` overrides the agent file's in @mjakl/pi-subagent), so a change applies to the next
// delegation. Inside a worker process, sub-workers are allowed only when that worker's own model is free; they run
// on the same free model, so nesting never adds cost.
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWorker, sharedState, team } from "./shared.ts";
import {
  defaults,
  describeTeam,
  effectiveTeam,
  isFree,
  loadSettings,
  MAX_DEPTH,
  PRESETS,
  saveSettings,
  splitModel,
  unavailable,
  type Preset,
} from "./team.ts";

const TOOL = "subagent";

function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else process.stderr.write(`[foreman] ${level}: ${message}\n`);
}

const callsOf = (input: unknown) => {
  const calls = (input as { calls?: unknown } | undefined)?.calls;
  return Array.isArray(calls) ? (calls.filter((c) => c && typeof c === "object") as { agent?: unknown; model?: unknown }[]) : [];
};

export default function workers(pi: ExtensionAPI) {
  const state = sharedState();

  if (isWorker()) {
    // A worker may delegate only if its own model is free and the depth setting allows another level. pi-subagent
    // registers the tool whenever its inherited depth ceiling allows; Foreman narrows that here.
    pi.on("session_start", async (_event, ctx) => {
      const own = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
      const depth = Number(process.env.PI_SUBAGENT_DEPTH ?? 0);
      state.subWorkers = !!own && isFree(ctx, own) && depth < loadSettings().depth && pi.getAllTools().some((t) => t.name === TOOL);
      if (!state.subWorkers) pi.setActiveTools(pi.getActiveTools().filter((t) => t !== TOOL));
    });
    pi.on("tool_call", (event, ctx) => {
      if (event.toolName !== TOOL) return;
      if (!state.subWorkers || !ctx.model) {
        return { block: true, reason: "Sub-workers are only available to workers running on free models (/workers). Do this part yourself." };
      }
      for (const call of callsOf(event.input)) call.model = `${ctx.model.provider}/${ctx.model.id}`;
    });
    return;
  }

  // The lead: every call to a Foreman worker goes to the model /workers chose.
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== TOOL) return;
    const rows = new Map(effectiveTeam(ctx).map((r) => [r.name, r]));
    const problems: string[] = [];
    for (const call of callsOf(event.input)) {
      const row = rows.get(String(call.agent));
      if (!row) continue; // not a Foreman worker: leave it to the agent file
      const problem = unavailable(ctx, row.effective);
      if (problem) problems.push(`${row.name}: ${problem}`);
      call.model = row.effective;
    }
    if (problems.length) {
      // Never fall back to other (possibly paid) models: stop and say why.
      const reason = `Workers can't start: ${problems.join("; ")}. Fix that, or choose other workers with /workers.`;
      report(ctx, reason, "error");
      return { block: true, reason };
    }
  });

  const show = (ctx: ExtensionContext) => report(ctx, describeTeam(ctx, state.on));

  async function pickModel(ctx: ExtensionCommandContext, preset: Preset, worker: string): Promise<string | undefined> {
    const ids = ctx.modelRegistry
      .getAll()
      .filter((m) => (preset === "freellm" ? m.provider === "freellmapi" : preset === "free" ? m.provider === "openrouter" && m.cost.input === 0 && m.cost.output === 0 : false))
      .map((m) => `${m.provider}/${m.id}`)
      .sort();
    const reset = "default (the preset's model)";
    if (!ids.length) {
      const typed = await ctx.ui.input(`Model for ${worker} (provider/id, e.g. openrouter/minimax/minimax-m3)`);
      return typed?.trim() || undefined;
    }
    const picked = await ctx.ui.select(`Model for ${worker} (${preset})`, [reset, ...ids]);
    return picked === reset ? "default" : picked;
  }

  /** Validate and save one worker's model for the current preset. Returns false (after reporting) if refused. */
  function setModel(ctx: ExtensionContext, worker: string, model: string): boolean {
    const s = loadSettings();
    const names = effectiveTeam(ctx, s).map((r) => r.name);
    if (!names.includes(worker)) return report(ctx, `No worker called "${worker}". Workers: ${names.join(", ")}.`, "warning"), false;
    const forPreset = { ...(s.models[s.preset] ?? {}) };
    if (model === "default") delete forPreset[worker];
    else {
      if (!ctx.modelRegistry.find(...splitModel(model))) return report(ctx, `Pi doesn't know ${model}. Use provider/id as /model lists it.`, "warning"), false;
      if (s.preset === "free" && !isFree(ctx, model)) return report(ctx, `${model} isn't free. Pick a $0 model, or use /workers paid first to choose paid models.`, "warning"), false;
      if (s.preset === "freellm" && splitModel(model)[0] !== "freellmapi") return report(ctx, `The freellm preset only takes freellmapi/… models.`, "warning"), false;
      forPreset[worker] = model;
    }
    saveSettings({ ...s, models: { ...s.models, [s.preset]: forPreset } });
    return true;
  }

  function setPreset(ctx: ExtensionContext, preset: Preset): boolean {
    if (preset === "freellm" && !ctx.modelRegistry.getAll().some((m) => m.provider === "freellmapi")) {
      report(ctx, "FreeLLMAPI isn't connected. Run /login-with-freellm first, then /workers freellm.", "warning");
      return false;
    }
    saveSettings({ ...loadSettings(), preset });
    return true;
  }

  function setDepth(ctx: ExtensionContext, depth: number): boolean {
    if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) return report(ctx, `Depth must be 1 to ${MAX_DEPTH}.`, "warning"), false;
    saveSettings({ ...loadSettings(), depth });
    // pi-subagent fixes the ceiling when Pi starts (orchestrate.ts sets it from this setting).
    if (depth > state.depthCeiling) report(ctx, `Depth ${depth} takes effect after you restart Pi (this session started with ${state.depthCeiling}).`, "warning");
    return true;
  }

  pi.registerCommand("workers", {
    description: "Choose the workers' models (paid, free OpenRouter, FreeLLMAPI, or per worker) and sub-worker depth",
    getArgumentCompletions: (prefix) =>
      [...PRESETS, "depth", "status", ...team(getAgentDir()).map((w) => w.name)].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const [first, second] = args.trim().split(/\s+/).filter(Boolean);
      if (first === "status" || (!first && !ctx.hasUI)) return show(ctx);

      if (!first) {
        const d = defaults();
        const s = loadSettings();
        const presetLabel = (p: Preset) => `${p}: ${d.presets[p].label}${p === s.preset ? "  (current)" : ""}`;
        const changeOne = "Change one worker's model…";
        const depthLabel = `Sub-worker depth for free workers… (now ${s.depth})`;
        const picked = await ctx.ui.select("Workers", [...PRESETS.map(presetLabel), changeOne, depthLabel]);
        if (!picked) return;
        const preset = PRESETS.find((p) => picked === presetLabel(p));
        if (preset) {
          if (setPreset(ctx, preset)) show(ctx);
          return;
        }
        if (picked === changeOne) {
          const worker = await ctx.ui.select("Which worker?", effectiveTeam(ctx).map((r) => r.name));
          if (!worker) return;
          const model = await pickModel(ctx, s.preset, worker);
          if (model && setModel(ctx, worker, model)) show(ctx);
          return;
        }
        const depthOptions = ["1: no sub-workers", "2: free workers may use sub-workers", "3: and those sub-workers may use their own"];
        const depth = await ctx.ui.select("How deep may free workers delegate?", depthOptions);
        if (depth && setDepth(ctx, Number(depth[0]))) show(ctx);
        return;
      }

      if (PRESETS.includes(first as Preset)) {
        if (setPreset(ctx, first as Preset)) show(ctx);
        return;
      }
      if (first === "depth") {
        if (setDepth(ctx, Number(second))) show(ctx);
        return;
      }
      if (second) {
        if (setModel(ctx, first, second)) show(ctx);
        return;
      }
      report(ctx, "Usage: /workers [paid|free|freellm] | /workers <worker> <model|default> | /workers depth <1-3> | /workers status", "warning");
    },
  });
}
