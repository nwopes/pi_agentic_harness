/**
 * Foreman compare runner.
 *   npm run compare -- --task habit-tracker --modes harness,strong-solo,cheap-solo --runs 2
 * Runs strictly sequentially, one fresh workspace per (mode, run), outside the repo.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeRun } from "./lib/analyze.ts";
import { expandPiArgs, loadConfig, normalizeModelId, readWorkerDefs, resolveFromConfig, type ForemanConfig } from "./lib/config.ts";
import { ancestorContextFiles, copyDir, removeInside } from "./lib/fsutil.ts";
import {
  budgetProblems,
  fetchAllPrices,
  fetchGeneration,
  isBillingError,
  readBudget,
  readKeyOnce,
  settleKeyUsage,
  subsetPrices,
  type KeySnapshot,
  type PriceSnapshot,
} from "./lib/openrouter.ts";
import { buildPiInvocation, nodeVersion, piHelpHasFlags, piVersion, runPi } from "./lib/pi.ts";
import { capture, npmCommand, resolveBash, resolveExecutable, runProcess } from "./lib/proc.ts";
import { parseRunUsage } from "./lib/usage.ts";
import { REPO_ROOT, argString, exists, fmtMs, fmtUsd, isInside, loadDotEnv, nowIso, parseArgv, readJson, toPosixish, writeJson, writeText } from "./lib/util.ts";
import { generateReport } from "./report.ts";

const HELP = `Usage: npm run compare -- --task <name> [options]

  --task <name>          task under demo-tasks/<name> (SPEC.md, fixture/, grade.sh)
  --modes a,b,c          modes from foreman.config.json (default: config defaultModes)
  --runs <n>             runs per mode (default 1); runs are numbered after any existing ones
  --timeout-min <m>      wall-clock limit per Pi run (default: config timeoutMinutes = 30)
  --min-headroom <usd>   override minHeadroomUsd (budget gate before every run; e.g. 0.5 for harness-lite rehearsals)
  --no-key-cost          do not use the OpenRouter key-usage delta (cost becomes an estimate from Pi events)
  --pi-bin <path>        Pi CLI (default: $FOREMAN_PI_BIN or config pi.cli); .js/.mjs is run with --pi-node
  --pi-node <path>       Node that runs Pi (default: $FOREMAN_PI_NODE or config pi.node)
  --workdir <dir>        where workspaces are created (default: <os tmp>/foreman-runs); must be outside the repo
  --keep-workspaces      keep the temporary workspaces after grading (they then contain the hidden tests!)
  --fresh                move existing runs/<task> to runs/_archive/ before starting
  --dry-run              run all checks and print the exact Pi invocations, then stop (no Pi runs, no spend)
  --config <file>        alternative foreman.config.json
  --task-dir <dir>       alternative task directory (default demo-tasks/<task>)
  --runs-dir <dir>       default <repo>/runs
  --results-dir <dir>    default <repo>/results
  --dotenv <file>        default <repo>/.env (loaded if present; existing env vars win; Pi itself does not read .env)
`;

const log = (s: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
const FAILED_STOP_REASONS = new Set(["error", "aborted", "length"]);

interface Ctx {
  cfg: ForemanConfig;
  task: string;
  taskDir: string;
  runsRoot: string;
  resultsRoot: string;
  taskWorkRoot: string;
  piCli: string;
  piNode: string | null;
  piVersion: string | null;
  piNodeVersion: string | null;
  bash: string;
  /** Key for the cost of record (null with --no-key-cost). */
  apiKey: string | null;
  /** Key for the budget check (also used with --no-key-cost when a key is present). */
  budgetKey: string | null;
  timeoutMs: number;
  keep: boolean;
  allPrices: PriceSnapshot | null;
}

function git(ws: string, args: string[], env?: NodeJS.ProcessEnv) {
  const r = capture("git", args, ws, env ? { ...process.env, ...env } : undefined);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.error}`);
  return r.stdout.trim();
}

function workerModelsFor(cfg: ForemanConfig, mode: string): Record<string, string | null> {
  const m = cfg.modes[mode];
  const out: Record<string, string | null> = {};
  if (!m.workerAgentsDir) return out;
  for (const w of readWorkerDefs(resolveFromConfig(cfg, m.workerAgentsDir))) out[w.name] = w.model;
  return out;
}

function nextRunIndex(runsTaskDir: string, mode: string): number {
  if (!exists(runsTaskDir)) return 1;
  let max = 0;
  const esc = mode.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const d of fs.readdirSync(runsTaskDir)) {
    const m = new RegExp(`^${esc}-(\\d+)$`).exec(d);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function versionAtLeast(v: string | null, min: [number, number, number]): boolean | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? "");
  if (!m) return null;
  const a = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (a[i] !== min[i]) return a[i] > min[i];
  return true;
}

/** Budget gate before every run: both the key limit and the account balance need headroom. */
async function checkBudget(ctx: Ctx): Promise<string[]> {
  if (!ctx.budgetKey) return [];
  const b = await readBudget(ctx.budgetKey);
  const problems = budgetProblems(b, ctx.cfg.minHeadroomUsd);
  const keyStr = b.keyLimitRemaining === null ? "no key limit" : `key limit remaining $${b.keyLimitRemaining.toFixed(2)}`;
  const accStr = b.accountRemaining === null ? `account balance unknown (${b.accountError ?? "n/a"})` : `account balance $${b.accountRemaining.toFixed(2)}`;
  log(`  budget: ${keyStr}; ${accStr}; need >= $${ctx.cfg.minHeadroomUsd}`);
  return problems;
}

async function runOne(ctx: Ctx, mode: string, n: number, prevAfter: { runDir: string; usage: number | null } | null) {
  const { cfg } = ctx;
  const modeCfg = cfg.modes[mode];
  const runId = `${mode}-${n}`;
  const runDir = path.join(ctx.runsRoot, ctx.task, runId);
  const ws = path.join(ctx.taskWorkRoot, runId);
  const sessDir = path.join(ctx.taskWorkRoot, `${runId}.pi-sessions`);
  const agentDir = resolveFromConfig(cfg, modeCfg.piConfigDir);
  const workers = workerModelsFor(cfg, mode);
  const timeoutMs = ctx.timeoutMs;
  fs.mkdirSync(runDir, { recursive: true });

  const meta: any = {
    schema: "foreman.run/1",
    task: ctx.task,
    mode,
    run: n,
    runId,
    leadRole: modeCfg.leadRole ?? (mode === cfg.harnessMode ? "lead" : "solo"),
    workspacePath: ws,
    taskDir: ctx.taskDir,
    piConfigDir: agentDir,
    models: { provider: cfg.provider, lead: normalizeModelId(modeCfg.model), workers },
    timeoutMs,
    status: "running",
    setup: {},
    keyUsage: { enabled: !!ctx.apiKey },
    createdAt: nowIso(),
  };
  const saveMeta = () => writeJson(path.join(runDir, "meta.json"), meta);
  saveMeta();
  let afterUsage: number | null = null;
  let billingError = false;

  try {
    // 1. Fresh workspace outside the repo: fixture copy, git baseline, npm ci.
    removeInside(ws, ctx.taskWorkRoot);
    removeInside(sessDir, ctx.taskWorkRoot);
    const t0 = Date.now();
    copyDir(path.join(ctx.taskDir, "fixture"), ws, ["node_modules", ".git", "dist"]);
    git(ws, ["init", "-q"]);
    git(ws, ["config", "core.autocrlf", "false"]);
    git(ws, ["config", "core.safecrlf", "false"]);
    fs.writeFileSync(path.join(ws, ".git", "info", "exclude"), "node_modules/\ndist/\n");
    git(ws, ["add", "-A"]);
    const ident = { GIT_AUTHOR_NAME: "Foreman runner", GIT_AUTHOR_EMAIL: "foreman@localhost", GIT_COMMITTER_NAME: "Foreman runner", GIT_COMMITTER_EMAIL: "foreman@localhost" };
    git(ws, ["commit", "-q", "-m", "foreman: fixture baseline"], ident);
    meta.setup.baselineCommit = git(ws, ["rev-parse", "HEAD"]);
    meta.setup.copyMs = Date.now() - t0;
    meta.setup.ancestorContextFiles = ancestorContextFiles(ws);
    meta.setup.workspaceContextFiles = ["AGENTS.md", "CLAUDE.md", ".pi"].filter((f) => exists(path.join(ws, f)));
    if (meta.setup.ancestorContextFiles.length) log(`  WARNING: Pi will also load ${meta.setup.ancestorContextFiles.join(", ")}`);

    const npm = npmCommand();
    log(`  ${runId}: npm ci (same for every mode, before the agent starts)`);
    const ci = await runProcess({ command: npm.command, args: ["ci", "--no-audit", "--no-fund"], cwd: ws, logFile: path.join(runDir, "npm-ci.log"), timeoutMs: 15 * 60000, shell: npm.shell });
    meta.setup.npmCi = { exitCode: ci.exitCode, durationMs: ci.durationMs, timedOut: ci.timedOut, ...(ci.spawnError ? { spawnError: ci.spawnError } : {}) };
    saveMeta();
    if (ci.exitCode !== 0) {
      meta.status = "setup_failed";
      meta.error = `npm ci failed (exit ${ci.exitCode}); see npm-ci.log. Pi was not started (no spend).`;
      log(`  ${runId}: ${meta.error}`);
      return { runDir, afterUsage: null, billingError };
    }

    // 2. Starting cost snapshot (poll until stable). Usage that arrives after the previous run's end snapshot
    //    is attributed back to that run and flagged (runs are sequential; nothing else should use the key).
    if (ctx.apiKey) {
      log(`  ${runId}: settling OpenRouter key usage (before)`);
      const before = await settleKeyUsage(ctx.apiKey, { ...cfg.keyUsagePolling, initialDelayMs: 0 }, (s) => log(`  ${s}`), prevAfter?.usage ?? null);
      meta.keyUsage.before = before;
      if (prevAfter && prevAfter.usage !== null && before.usage !== null && before.usage > prevAfter.usage + 1e-9) {
        attributeLateUsage(prevAfter.runDir, before.usage - prevAfter.usage, "next run's start snapshot");
      }
    }

    // 3. Pi, non-interactively.
    const prompt = fs.readFileSync(path.join(ctx.taskDir, "SPEC.md"), "utf8");
    const inv = buildPiInvocation({
      cli: ctx.piCli,
      node: ctx.piNode,
      agentDir,
      provider: cfg.provider,
      model: modeCfg.model,
      prompt,
      sessionDir: sessDir,
      extraArgs: expandPiArgs(modeCfg.extraPiArgs, agentDir),
      extraEnv: cfg.pi.env,
    });
    meta.pi = { invocation: inv.display, resolvedAs: inv.resolvedHow, version: ctx.piVersion, nodeVersion: ctx.piNodeVersion };
    meta.startedAt = nowIso();
    saveMeta();
    log(`  ${runId}: running Pi (${normalizeModelId(modeCfg.model)}, timeout ${fmtMs(timeoutMs)})`);
    const r = await runPi(inv, ws, path.join(runDir, "events.jsonl"), path.join(runDir, "stderr.log"), timeoutMs);
    meta.endedAt = nowIso();
    meta.wallMs = r.durationMs;
    meta.exitCode = r.exitCode;
    meta.signal = r.signal;
    meta.timedOut = r.timedOut;
    if (r.spawnError) meta.spawnError = r.spawnError;
    saveMeta();
    log(`  ${runId}: Pi finished in ${fmtMs(r.durationMs)} (exit ${r.exitCode}${r.timedOut ? ", TIMED OUT" : ""})`);

    // 4. Ending cost snapshot.
    if (ctx.apiKey) {
      log(`  ${runId}: settling OpenRouter key usage (after)`);
      const after: KeySnapshot = await settleKeyUsage(ctx.apiKey, cfg.keyUsagePolling, (s) => log(`  ${s}`), meta.keyUsage.before?.usage ?? null);
      meta.keyUsage.after = after;
      const b = meta.keyUsage.before?.usage;
      if (typeof b === "number" && after.usage !== null) meta.keyUsage.deltaUsd = after.usage - b;
      afterUsage = after.usage;
      saveMeta();
    }

    // 6 (before grading, which copies hidden tests into the workspace): diffstat, BOARD.md, workspace copy, sessions.
    try {
      git(ws, ["add", "-A"]);
      const stat = git(ws, ["diff", "--cached", "--stat=200", meta.setup.baselineCommit]);
      writeText(path.join(runDir, "diffstat.txt"), (stat || "(no changes)") + "\n");
    } catch (e) {
      writeText(path.join(runDir, "diffstat.txt"), `diffstat unavailable: ${(e as Error).message}\n`);
    }
    const board = fs.readdirSync(ws).find((f) => f.toLowerCase() === "board.md");
    if (board) fs.copyFileSync(path.join(ws, board), path.join(runDir, "BOARD.md"));
    meta.artifacts = { boardMd: !!board };
    const copied = copyDir(ws, path.join(runDir, "workspace"), ["node_modules", "dist", ".git", "coverage"]);
    meta.artifacts.workspaceFiles = copied.files;
    if (exists(sessDir)) {
      copyDir(sessDir, path.join(runDir, "pi-sessions"));
      meta.artifacts.piSessions = true;
    }

    // Prices used (public endpoint snapshot, subset for models configured or seen).
    const pre = await parseRunUsage({ eventsFile: path.join(runDir, "events.jsonl"), leadRole: meta.leadRole, workerModels: workers, prices: null });
    const ids = new Set<string>([normalizeModelId(modeCfg.model), ...Object.values(workers).filter((x): x is string => !!x), ...pre.lead.modelsSeen, ...pre.workers.map((w) => w.model)]);
    for (const w of pre.workers) for (const s of w.servedModels) ids.add(s);
    ids.delete("unknown");
    writeJson(path.join(runDir, "prices.json"), subsetPrices(ctx.allPrices, [...ids].sort()));

    // Served-model check: OpenRouter's own record of a sample of responses per role (gen- ids only; no spend).
    if (ctx.budgetKey && pre.responses.length) {
      const perRole = new Map<string, number>();
      const entries: any[] = [];
      for (const r of pre.responses) {
        const n = perRole.get(r.role) ?? 0;
        if (n >= cfg.servedModelCheck.maxPerRole) continue;
        perRole.set(r.role, n + 1);
        const g = await fetchGeneration(ctx.budgetKey, r.responseId);
        entries.push({ role: r.role, configuredModel: r.model, ...g });
      }
      writeJson(path.join(runDir, "generations.json"), { checkedAt: nowIso(), source: "GET https://openrouter.ai/api/v1/generation?id=", maxPerRole: cfg.servedModelCheck.maxPerRole, entries });
    }

    // Status. Pi exits 0 in JSON mode even when the model call failed, so the last assistant stopReason decides.
    meta.lastStopReason = pre.agent.lastStopReason ?? null;
    if (pre.agent.lastErrorMessage) meta.agentErrorMessage = String(pre.agent.lastErrorMessage).slice(0, 500);
    if (r.spawnError) meta.status = "spawn_error";
    else if (r.timedOut) meta.status = "timeout";
    else if (r.exitCode !== 0) meta.status = "nonzero_exit";
    else if (FAILED_STOP_REASONS.has(pre.agent.lastStopReason ?? "")) meta.status = "agent_error";
    else if (pre.lead.assistantMessages === 0) {
      meta.status = "agent_error";
      meta.agentErrorMessage ??= "Pi produced no assistant message (see stderr.log).";
    } else meta.status = "ok";
    billingError = meta.status === "agent_error" && isBillingError(meta.agentErrorMessage);
    if (meta.agentErrorMessage) log(`  ${runId}: agent error (${meta.lastStopReason}): ${meta.agentErrorMessage.slice(0, 200)}`);
    saveMeta();

    // 5. Grade with the hidden tests (Git Bash explicitly). Failed runs are graded too, for the record.
    log(`  ${runId}: grading`);
    const gradeJson = path.join(runDir, "grade.json");
    const g = await runProcess({
      command: ctx.bash,
      args: [toPosixish(path.join(ctx.taskDir, "grade.sh")), toPosixish(ws), toPosixish(gradeJson)],
      cwd: ctx.taskDir,
      env: { ...process.env, GRADE_LOG: toPosixish(path.join(runDir, "grade-full.log")) },
      logFile: path.join(runDir, "grade.log"),
      timeoutMs: cfg.gradeTimeoutMinutes * 60000,
    });
    meta.grade = { exitCode: g.exitCode, durationMs: g.durationMs, timedOut: g.timedOut };
    if (!exists(gradeJson)) meta.grade.error = `grade.sh produced no grade.json (exit ${g.exitCode}); see grade.log`;
    else {
      try {
        readJson(gradeJson);
      } catch (e) {
        meta.grade.error = `grade.json is not valid JSON: ${(e as Error).message}`;
      }
    }
    saveMeta();

    // 7. Analysis snapshot (the report recomputes all of this from the same files).
    const rec = await analyzeRun(runDir, { repoRoot: REPO_ROOT, threshold: cfg.costDisagreementThreshold, harnessMode: cfg.harnessMode });
    meta.tokens = rec.tokens;
    meta.usage = { eventPricedUsd: rec.cost.eventPricedUsd, piReportedUsd: rec.cost.piReportedUsd, byRole: rec.byRole, delegation: rec.delegation };
    meta.contamination = rec.contamination;
    meta.flags = rec.flags;
    meta.tests = rec.tests;
    saveMeta();
    log(
      `  ${runId}: ${rec.failed ? `FAILED RUN (${rec.failureReason})` : `tests ${rec.tests.passed}/${rec.tests.total}`}, cost ${fmtUsd(rec.cost.ofRecordUsd)} (${rec.cost.source})${rec.flags.length ? `, flags: ${rec.flags.join(" ")}` : ""}`,
    );
  } catch (e) {
    meta.status = meta.status === "running" || !meta.status ? "runner_error" : meta.status;
    meta.runnerError = (e as Error).stack ?? String(e);
    log(`  ${runId}: RUNNER ERROR ${(e as Error).message}`);
  } finally {
    meta.finishedAt = nowIso();
    saveMeta();
    if (!ctx.keep) {
      try {
        removeInside(ws, ctx.taskWorkRoot);
        removeInside(sessDir, ctx.taskWorkRoot);
      } catch (e) {
        log(`  could not remove workspace: ${(e as Error).message}`);
      }
    }
  }
  return { runDir, afterUsage, billingError };
}

function attributeLateUsage(runDir: string, usd: number, how: string) {
  const p = path.join(runDir, "meta.json");
  const meta: any = readJson(p);
  meta.keyUsage ??= {};
  meta.keyUsage.lateUsd = (meta.keyUsage.lateUsd ?? 0) + usd;
  meta.keyUsage.lateNote = `+$${usd.toFixed(6)} of key usage appeared after this run's end snapshot (seen at ${how}); attributed to this run and flagged.`;
  writeJson(p, meta);
  log(`  late key usage +$${usd.toFixed(6)} attributed to ${path.basename(runDir)}`);
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(HELP);
    return;
  }
  loadDotEnv(argString(args, "dotenv"));
  const cfg = loadConfig(argString(args, "config"));
  const task = argString(args, "task");
  const errors: string[] = [];
  if (!task) errors.push("--task is required");
  const modes = (argString(args, "modes") ?? (cfg.defaultModes?.length ? cfg.defaultModes : Object.keys(cfg.modes)).join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const runs = Number(argString(args, "runs") ?? "1");
  if (!Number.isInteger(runs) || runs < 1) errors.push("--runs must be a positive integer");
  const timeoutMin = Number(argString(args, "timeout-min") ?? cfg.timeoutMinutes);
  if (!(timeoutMin > 0)) errors.push("--timeout-min must be > 0");
  const noKeyCost = args["no-key-cost"] === true;
  const minHeadroom = argString(args, "min-headroom");
  if (minHeadroom !== undefined) {
    const v = Number(minHeadroom);
    if (!(v >= 0)) errors.push("--min-headroom must be a number >= 0");
    else cfg.minHeadroomUsd = v;
  }
  const dryRun = args["dry-run"] === true;
  const taskDir = path.resolve(argString(args, "task-dir") ?? path.join(REPO_ROOT, "demo-tasks", task ?? "?"));
  const runsRoot = path.resolve(argString(args, "runs-dir") ?? path.join(REPO_ROOT, "runs"));
  const resultsRoot = path.resolve(argString(args, "results-dir") ?? path.join(REPO_ROOT, "results"));
  const workRoot = path.resolve(argString(args, "workdir") ?? path.join(os.tmpdir(), "foreman-runs"));
  const piCli = argString(args, "pi-bin") ?? process.env.FOREMAN_PI_BIN ?? cfg.pi.cli;
  const piNodeRaw = argString(args, "pi-node") ?? process.env.FOREMAN_PI_NODE ?? cfg.pi.node;
  const piNode = piNodeRaw ? piNodeRaw : null;

  for (const m of modes) if (!cfg.modes[m]) errors.push(`unknown mode "${m}" (config has: ${Object.keys(cfg.modes).join(", ")})`);
  if (task) {
    for (const f of ["SPEC.md", "fixture", "grade.sh"]) if (!exists(path.join(taskDir, f))) errors.push(`missing ${path.join(taskDir, f)}`);
    if (exists(path.join(taskDir, "fixture")) && !exists(path.join(taskDir, "fixture", "package-lock.json"))) errors.push(`fixture has no package-lock.json (npm ci needs it): ${path.join(taskDir, "fixture")}`);
  }
  if (isInside(workRoot, REPO_ROOT)) errors.push(`--workdir ${workRoot} is inside the repo; agents could find demo-tasks/ and hidden tests. Use a directory outside ${REPO_ROOT}.`);

  // Pi binary + Node version (Pi >= 0.75 needs Node >= 22.19).
  let piOk = true;
  try {
    resolveExecutable(piCli, piNode);
  } catch (e) {
    piOk = false;
    errors.push(`Pi: ${(e as Error).message} (set pi.cli/pi.node in foreman.config.json, --pi-bin/--pi-node, or FOREMAN_PI_BIN/FOREMAN_PI_NODE)`);
  }
  const anyDir = modes.find((m) => cfg.modes[m]);
  const version = piOk && anyDir ? piVersion(piCli, piNode, os.tmpdir(), resolveFromConfig(cfg, cfg.modes[anyDir].piConfigDir)) : null;
  const nodeV = piOk && /\.(m|c)?js$/i.test(piCli) ? nodeVersion(piNode) : null;
  if (piOk && versionAtLeast(version, [0, 75, 0]) && versionAtLeast(nodeV, [22, 19, 0]) === false) {
    errors.push(`Pi ${version} needs Node >= 22.19 but would run on ${nodeV} (${piNode ?? process.execPath}). Set pi.node.`);
  }

  // Per-mode preflight: config dir, required files (installed packages), extension flags in --help.
  for (const m of modes) {
    const mc = cfg.modes[m];
    if (!mc) continue;
    const dir = resolveFromConfig(cfg, mc.piConfigDir);
    if (!exists(dir)) {
      errors.push(`mode ${m}: Pi config dir not found: ${dir}`);
      continue;
    }
    for (const f of expandPiArgs(mc.requiredFiles, dir)) {
      const p = path.isAbsolute(f) ? f : path.join(dir, f);
      if (!exists(p)) errors.push(`mode ${m}: required file missing: ${p} (see README "Install the Foreman package" / NOTES.md setup)`);
    }
    // Lead-mode runs take worker models from the package (workerAgentsDir). A hand-written file in the profile's
    // agents/ dir would silently replace one; the package only overwrites its own managed copies.
    if (mc.extraPiArgs?.includes("--orchestrate") && exists(path.join(dir, "agents"))) {
      for (const f of fs.readdirSync(path.join(dir, "agents")).filter((x) => x.toLowerCase().endsWith(".md"))) {
        if (!fs.readFileSync(path.join(dir, "agents", f), "utf8").includes("managed-by: pi-foreman")) {
          errors.push(`mode ${m}: ${path.join(dir, "agents", f)} is not managed by the foreman package and would override its workers; move it out or into foreman/agents/`);
        }
      }
    }
    // Pi prefers a key saved in <agentDir>/auth.json (/login openrouter, or one pasted into Pi with the Foreman package)
    // over OPENROUTER_API_KEY. A different saved key would be billed while the runner measures the env key's usage.
    const authFile = path.join(dir, "auth.json");
    if (exists(authFile)) {
      let stored: { type?: string; key?: string } | undefined;
      try {
        stored = JSON.parse(fs.readFileSync(authFile, "utf8"))?.openrouter;
      } catch {
        errors.push(`mode ${m}: ${authFile} is not valid JSON`);
      }
      if (stored && !(stored.type === "api_key" && stored.key === process.env.OPENROUTER_API_KEY?.trim())) {
        errors.push(`mode ${m}: ${authFile} holds an OpenRouter credential other than OPENROUTER_API_KEY; Pi would bill it instead of the key the runner measures. Remove it (/logout in that profile, or delete the "openrouter" entry).`);
      }
    }
    if (piOk && mc.requiredHelpFlags?.length) {
      const h = piHelpHasFlags(piCli, piNode, os.tmpdir(), dir, cfg.pi.env, mc.requiredHelpFlags);
      if (!h.ok) errors.push(`mode ${m}: \`pi --help\` does not list ${h.missing.join(", ")}; the extension did not load (with PI_OFFLINE=1 a missing package is skipped silently)${h.error ? `: ${h.error}` : ""}`);
    }
    if (mc.workerAgentsDir) {
      const defs = readWorkerDefs(resolveFromConfig(cfg, mc.workerAgentsDir));
      if (!defs.length) log(`WARNING: mode ${m}: no worker definitions in ${mc.workerAgentsDir}; cost breakdown will have no worker models`);
      for (const d of defs) if (!d.model) log(`WARNING: worker ${d.name} (${d.file}) has no model: in frontmatter`);
    }
  }

  const envKey = process.env.OPENROUTER_API_KEY?.trim() || null;
  const apiKey = noKeyCost ? null : envKey;
  if (!noKeyCost && !envKey) {
    errors.push(
      "OPENROUTER_API_KEY is not set (looked in the environment and in .env). The OpenRouter key-usage delta is the cost of record. " +
        "Put the key in .env, or pass --no-key-cost to run without it (cost will be an estimate from Pi events and every run is flagged NO_KEY_COST).",
    );
  }
  let bash = "";
  try {
    bash = resolveBash();
  } catch (e) {
    errors.push((e as Error).message);
  }
  if (errors.length) {
    console.error("[foreman] cannot start:\n  - " + errors.join("\n  - "));
    process.exit(2);
  }
  if (apiKey) {
    const r = await readKeyOnce(apiKey);
    if (r.usage === null) {
      console.error(`[foreman] cannot start: OpenRouter key check failed (GET /api/v1/key: ${r.error}).`);
      process.exit(2);
    }
  }

  let allPrices: PriceSnapshot | null = null;
  try {
    allPrices = await fetchAllPrices();
  } catch (e) {
    log(`WARNING: could not fetch OpenRouter model prices (${(e as Error).message}); event-derived costs will be UNPRICED`);
  }
  if (allPrices) {
    for (const m of modes) {
      const ids = [normalizeModelId(cfg.modes[m].model), ...Object.values(workerModelsFor(cfg, m)).filter((x): x is string => !!x)];
      for (const id of ids) if (!allPrices.models[id]) log(`WARNING: model "${id}" (mode ${m}) is not in OpenRouter's /models list`);
    }
  }

  const taskWorkRoot = path.join(workRoot, task!);
  const runsTaskDir = path.join(runsRoot, task!);
  const start: Record<string, number> = {};
  for (const m of modes) start[m] = nextRunIndex(runsTaskDir, m);
  if (args.fresh === true && !dryRun && exists(runsTaskDir)) {
    const dest = path.join(runsRoot, "_archive", `${task}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(runsTaskDir, dest);
    log(`moved previous runs to ${dest}`);
    for (const m of modes) start[m] = 1;
  }
  // Interleave modes (h1, s1, c1, h2, s2, c2...) to spread provider load/time-of-day effects evenly.
  const plan: { mode: string; n: number }[] = [];
  for (let i = 0; i < runs; i++) for (const m of modes) plan.push({ mode: m, n: start[m] + i });

  log(`task ${task}: ${plan.length} run(s): ${plan.map((p) => `${p.mode}-${p.n}`).join(", ")}`);
  log(`Pi ${version ?? "(version unknown)"} via ${resolveExecutable(piCli, piNode).how}${nodeV ? ` (node ${nodeV})` : ""}; Git Bash ${bash}`);
  log(`workspaces under ${taskWorkRoot}; cost of record: ${apiKey ? "OpenRouter key-usage delta" : "ESTIMATE from Pi events (--no-key-cost)"}`);
  for (const m of modes) {
    const w = workerModelsFor(cfg, m);
    log(`  ${m}: ${normalizeModelId(cfg.modes[m].model)}${Object.keys(w).length ? `; workers ${Object.entries(w).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""}`);
  }

  const ctx: Ctx = {
    cfg,
    task: task!,
    taskDir,
    runsRoot,
    resultsRoot,
    taskWorkRoot,
    piCli,
    piNode,
    piVersion: version,
    piNodeVersion: nodeV,
    bash,
    apiKey,
    budgetKey: envKey,
    timeoutMs: Math.round(timeoutMin * 60000),
    keep: args["keep-workspaces"] === true,
    allPrices,
  };

  if (dryRun) {
    for (const m of modes) {
      const dir = resolveFromConfig(cfg, cfg.modes[m].piConfigDir);
      const inv = buildPiInvocation({
        cli: piCli,
        node: piNode,
        agentDir: dir,
        provider: cfg.provider,
        model: cfg.modes[m].model,
        prompt: "<SPEC.md>",
        sessionDir: path.join(taskWorkRoot, `${m}-N.pi-sessions`),
        extraArgs: expandPiArgs(cfg.modes[m].extraPiArgs, dir),
        extraEnv: cfg.pi.env,
      });
      log(`dry-run ${m}: ${inv.display}`);
    }
    const problems = await checkBudget(ctx);
    for (const p of problems) log(`dry-run budget problem: ${p}`);
    log("dry run: nothing executed");
    return;
  }

  // Our own temp area: wipe leftovers (they may contain graded hidden tests from a crashed run).
  fs.mkdirSync(taskWorkRoot, { recursive: true });
  const marker = path.join(taskWorkRoot, ".foreman-workroot");
  if (!exists(marker)) {
    if (fs.readdirSync(taskWorkRoot).length) {
      console.error(`[foreman] ${taskWorkRoot} is not empty and was not created by Foreman; refusing to use it.`);
      process.exit(2);
    }
    fs.writeFileSync(marker, "Foreman temporary workspaces. Safe to delete.\n");
  }
  for (const e of fs.readdirSync(taskWorkRoot)) if (e !== ".foreman-workroot") removeInside(path.join(taskWorkRoot, e), taskWorkRoot);

  let prev: { runDir: string; usage: number | null } | null = null;
  let abortReason: string | null = null;
  for (const [i, p] of plan.entries()) {
    log(`(${i + 1}/${plan.length}) ${p.mode}-${p.n}`);
    const problems = await checkBudget(ctx);
    if (problems.length) {
      abortReason = `budget check failed before ${p.mode}-${p.n}:\n  - ${problems.join("\n  - ")}`;
      break;
    }
    const res = await runOne(ctx, p.mode, p.n, prev);
    prev = res.afterUsage !== null ? { runDir: res.runDir, usage: res.afterUsage } : prev;
    if (res.billingError) {
      abortReason = `${p.mode}-${p.n} failed with an OpenRouter billing error (402 / credits); the remaining runs would fail the same way.`;
      break;
    }
  }
  if (apiKey && prev && prev.usage !== null) {
    log("final settle of OpenRouter key usage (late-arriving usage of the last run)");
    const fin = await settleKeyUsage(apiKey, cfg.keyUsagePolling, (s) => log(`  ${s}`), prev.usage);
    if (fin.usage !== null && fin.usage > prev.usage + 1e-9) attributeLateUsage(prev.runDir, fin.usage - prev.usage, "final settle");
  }

  if (exists(runsTaskDir)) {
    const out = await generateReport({ task: task!, runsRoot, resultsRoot, cfg });
    log(`report: ${out.reportMd}`);
    log(`html:   ${out.indexHtml}`);
    log(out.headline);
  }
  if (abortReason) {
    console.error(`[foreman] STOPPED: ${abortReason}`);
    process.exit(3);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
