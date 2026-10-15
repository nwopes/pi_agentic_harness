// Foreman lead mode for Pi: a strong lead plans in BOARD.md and delegates to cheaper worker models.
//
//   /orchestrate [on|off]   toggle lead mode in this session (no argument flips it); persisted in the session
//   --orchestrate           start in lead mode, e.g. for headless `--mode json` runs
//   /team                   the lead's model, each worker's model (as /workers set them), sub-worker depth, and
//                           where the OpenRouter key comes from
//
// package.json "pi.extensions" loads this file, then @mjakl/pi-subagent, then prompt.ts, keys.ts and workers.ts. This
// file must come first: it sets the delegation depth ceiling before pi-subagent reads it and copies the worker
// definitions before pi-subagent discovers agents at session_start.
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWorker, sharedState, STATE_ENTRY, syncWorkers } from "./shared.ts";
import { describeTeam, loadSettings } from "./team.ts";

const TOOL = "subagent";

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

  // The delegation depth ceiling, from /workers (default 2: workers may use sub-workers). pi-subagent reads it once,
  // in its factory, and passes it to every child, so it must be set before that runs; an explicit
  // --subagent-max-depth or PI_SUBAGENT_MAX_DEPTH still wins. Which workers may actually delegate is decided per
  // worker process (workers.ts: only workers on free models). Above depth 1, a worker may also hand parts of its task
  // to another worker of the same kind (a frontend worker to frontend sub-workers), so pi-subagent's cycle check is
  // off; the depth ceiling still bounds the nesting.
  const ceiling = loadSettings().depth;
  process.env.PI_SUBAGENT_MAX_DEPTH ??= String(ceiling);
  if (ceiling > 1) process.env.PI_SUBAGENT_PREVENT_CYCLES ??= "0";
  state.depthCeiling = Number(process.env.PI_SUBAGENT_MAX_DEPTH) || ceiling;

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

  const describe = (ctx: ExtensionContext) => describeTeam(ctx, state.on);

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
    description: "Show the lead model, each worker's model (see /workers), sub-worker depth and the OpenRouter key",
    handler: async (_args, ctx) => report(ctx, describe(ctx)),
  });
}
