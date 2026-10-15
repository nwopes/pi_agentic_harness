// Foreman lead mode for Pi: a strong lead plans in BOARD.md and delegates to cheaper worker models.
//
//   /orchestrate [on|off]   toggle lead mode in this session (no argument flips it); persisted in the session
//   --orchestrate           start in lead mode, e.g. for headless `--mode json` runs
//   /team                   the lead's model, each worker's model, and where the OpenRouter key comes from
//
// package.json "pi.extensions" loads this file, then @mjakl/pi-subagent, then prompt.ts and keys.ts. This file must
// come first: it caps the delegation depth before pi-subagent reads it and copies the worker definitions before
// pi-subagent discovers agents at session_start.
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { maskKey, openRouterKey } from "./keys.ts";
import { isWorker, sharedState, STATE_ENTRY, syncWorkers, team } from "./shared.ts";

const TOOL = "subagent";
/**
 * Lets another extension report that it runs the workers on a different model than their agent files say. Listeners
 * receive { lead, redirect: {} } and may set redirect.model and redirect.by without awaiting anything (pi.events calls
 * them synchronously up to their first await). extensions/freellmapi does this while the lead is on FreeLLMAPI.
 */
export const WORKER_MODELS_EVENT = "foreman:worker-models";
interface WorkerModelsQuery {
  lead: string | undefined;
  redirect: { model?: string; by?: string };
}

export default function orchestrate(pi: ExtensionAPI) {
  // Registered in workers too: pi-subagent forwards unknown parent flags to its children, and Pi exits on an
  // option no loaded extension declares.
  pi.registerFlag("orchestrate", {
    type: "boolean",
    default: false,
    description: "Start in Foreman lead mode: plan in BOARD.md and delegate to the frontend/backend/tests workers",
  });

  const state = sharedState();
  if (isWorker()) {
    state.on = false; // workers never lead, even though the forwarded --orchestrate reaches them
    return;
  }

  // Lead -> workers only: workers get no subagent tool. pi-subagent reads this once, in its factory, so it must be
  // set before that runs. An explicit --subagent-max-depth or PI_SUBAGENT_MAX_DEPTH still wins.
  process.env.PI_SUBAGENT_MAX_DEPTH ??= "1";

  const report = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else process.stderr.write(`[foreman] ${level}: ${message}\n`);
  };

  /** Turn lead mode on or off: active tools now, system prompt from the next run on (prompt.ts). */
  const apply = (ctx: ExtensionContext, on: boolean) => {
    state.on = on;
    const active = new Set(pi.getActiveTools());
    if (on) {
      if (!pi.getAllTools().some((t) => t.name === TOOL)) {
        report(ctx, `Lead mode is on, but the "${TOOL}" tool is missing: is @mjakl/pi-subagent loaded, or is --tools excluding it?`, "error");
      }
      active.add(TOOL);
    } else {
      active.delete(TOOL);
    }
    pi.setActiveTools([...active]);
  };

  const describe = (ctx: ExtensionContext) => {
    // With no usable model (e.g. no key yet) Pi reports a placeholder "unknown/unknown".
    const lead = ctx.model && ctx.model.provider !== "unknown" ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const query: WorkerModelsQuery = { lead, redirect: {} };
    pi.events.emit(WORKER_MODELS_EVENT, query);
    const { model: redirected, by } = query.redirect;
    const workers = team(getAgentDir());
    const rows = workers.map((w) =>
      redirected
        ? `  ${w.name.padEnd(9)} ${redirected}   (${by ?? "another extension"}: instead of ${w.model})`
        : `  ${w.name.padEnd(9)} ${w.model}${w.source === "package" ? "" : `   (your override: ${w.source})`}`,
    );
    const usesOpenRouter = (lead?.startsWith("openrouter/") ?? false) || (!redirected && workers.some((w) => w.model.startsWith("openrouter/")));
    const key = openRouterKey();
    const keyLine = !usesOpenRouter
      ? "OpenRouter key: not used by this team"
      : key.source === "saved"
        ? `OpenRouter key: saved, ${maskKey(key.key!)}${key.envAlsoSet ? " (used instead of OPENROUTER_API_KEY)" : ""}`
        : key.source === "env"
          ? `OpenRouter key: from OPENROUTER_API_KEY, ${maskKey(key.key!)}`
          : "OpenRouter key: none yet. Paste your key into Pi (just the key) to save it.";
    return [
      `Foreman team: lead mode ${state.on ? "ON" : "OFF"}`,
      `  ${"lead".padEnd(9)} ${lead ?? "(no model selected)"}   (this session's model${state.on ? "" : "; working alone"})`,
      ...rows,
      keyLine,
      state.on ? "Workers can't delegate further. Toggle with /orchestrate." : "Turn on with /orchestrate (or start Pi with --orchestrate).",
    ].join("\n");
  };

  pi.on("session_start", async (_event, ctx) => {
    // Runs before pi-subagent's own session_start (load order), so it discovers the workers we copy here.
    const { userOverrides } = syncWorkers(getAgentDir());
    if (userOverrides.length) report(ctx, `Using your own worker definitions instead of Foreman's: ${userOverrides.join(", ")}`, "warning");

    // The flag sets the initial mode; a toggle saved in this session (e.g. on resume) wins, as in Pi's plan-mode example.
    let on = pi.getFlag("orchestrate") === true;
    for (const entry of ctx.sessionManager.getBranch()) {
      const data = (entry as { type: string; customType?: string; data?: { on?: unknown } }).data;
      if (entry.type === "custom" && (entry as { customType?: string }).customType === STATE_ENTRY && typeof data?.on === "boolean") on = data.on;
    }
    apply(ctx, on);
  });

  pi.registerCommand("orchestrate", {
    description: "Toggle Foreman lead mode: the lead plans in BOARD.md and delegates to cheaper worker models",
    getArgumentCompletions: (prefix) => ["on", "off"].filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s })),
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg && arg !== "on" && arg !== "off") return report(ctx, "Usage: /orchestrate [on|off]", "warning");
      const on = arg ? arg === "on" : !state.on;
      apply(ctx, on);
      pi.appendEntry(STATE_ENTRY, { on });
      report(ctx, describe(ctx));
    },
  });

  pi.registerCommand("team", {
    description: "Show which model the lead and each Foreman worker is using",
    handler: async (_args, ctx) => report(ctx, describe(ctx)),
  });
}
