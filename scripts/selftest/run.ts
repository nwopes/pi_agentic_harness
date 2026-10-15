/**
 * Zero-spend end-to-end self-test of compare -> report -> index.html, with a stub Pi and a stub task.
 *   npm run selftest                 # all output in a temp dir, deleted afterwards
 *   npm run selftest -- --in-repo    # write to <repo>/runs/selftest and <repo>/results/selftest, then delete them
 *   npm run selftest -- --keep       # keep the output for inspection
 * Makes no model calls and never uses the OpenRouter key (it is blanked for every child process).
 * It does fetch OpenRouter's public /models price list (free, no key).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeRun } from "../lib/analyze.ts";
import { _internal as contaminationInternal } from "../lib/contamination.ts";
import { loadConfig } from "../lib/config.ts";
import { budgetProblems, isBillingError, servedMatches, settleKeyUsage } from "../lib/openrouter.ts";
import { priceTokens } from "../lib/usage.ts";
import { REPO_ROOT, exists, parseArgv, readJson, writeJson } from "../lib/util.ts";
import { renderIndexHtml } from "../report.ts";

const args = parseArgv(process.argv.slice(2));
const inRepo = args["in-repo"] === true;
const keep = args.keep === true;
const TASK = "selftest";
const here = path.join(REPO_ROOT, "scripts", "selftest");
const scratch = path.join(os.tmpdir(), `foreman-selftest-${Date.now()}`);
const runsRoot = inRepo ? path.join(REPO_ROOT, "runs") : path.join(scratch, "runs");
const resultsRoot = inRepo ? path.join(REPO_ROOT, "results") : path.join(scratch, "results");
const workdir = path.join(scratch, "work");
const tsx = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const failures: string[] = [];
const check = (cond: unknown, msg: string) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
  if (!cond) failures.push(msg);
};

const preexisting = {
  runs: exists(runsRoot),
  results: exists(resultsRoot),
  index: exists(path.join(resultsRoot, "index.html")),
};
if (exists(path.join(runsRoot, TASK)) || exists(path.join(resultsRoot, TASK))) {
  console.error(`Refusing to run: ${path.join(runsRoot, TASK)} or ${path.join(resultsRoot, TASK)} already exists.`);
  process.exit(2);
}

// --- scratch Pi config dirs mirroring pi-config/ (harness: settings.json loading the Foreman package, whose
// worker definitions live in the package's agents/ dir; solo: neutral AGENTS.md)
const base = loadConfig();
const piCfg = path.join(scratch, "pi-config");
const pkgAgents = path.join(scratch, "foreman", "agents");
fs.mkdirSync(pkgAgents, { recursive: true });
fs.mkdirSync(path.join(piCfg, "harness"), { recursive: true });
fs.mkdirSync(path.join(piCfg, "strong-solo"), { recursive: true });
fs.writeFileSync(path.join(piCfg, "harness", "settings.json"), JSON.stringify({ packages: ["../../foreman"] }));
fs.writeFileSync(path.join(piCfg, "strong-solo", "AGENTS.md"), "Implement the user's request completely.\n");
const workers: Record<string, string> = { frontend: "moonshotai/kimi-k2.7-code", backend: "minimax/minimax-m3", tests: "anthropic/claude-haiku-5.5" };
for (const [name, model] of Object.entries(workers)) {
  fs.writeFileSync(path.join(pkgAgents, `${name}.md`), `---\nname: ${name}\ndescription: stub ${name} worker\nmodel: openrouter/${model}\n---\nYou are the ${name} worker.\n`);
}
// A profile whose agents/ holds a hand-written worker file (not a managed copy): preflight must refuse it.
fs.mkdirSync(path.join(piCfg, "harness-rogue", "agents"), { recursive: true });
fs.writeFileSync(path.join(piCfg, "harness-rogue", "settings.json"), JSON.stringify({ packages: ["../../foreman"] }));
fs.writeFileSync(path.join(piCfg, "harness-rogue", "agents", "frontend.md"), "---\nname: frontend\ndescription: hand-written\nmodel: openrouter/some/other-model\n---\nx\n");
const mkConfig = (file: string, overrides: Record<string, any> = {}) => {
  writeJson(file, {
    ...base,
    _path: undefined,
    pi: { node: null, cli: path.join(here, "stub-pi.mjs"), env: base.pi.env },
    timeoutMinutes: 0.25,
    keyUsagePolling: { initialDelayMs: 0, intervalMs: 200, stableReads: 2, maxWaitMs: 2000 },
    modes: {
      harness: { ...base.modes.harness, piConfigDir: path.join(piCfg, overrides.harnessDir ?? "harness"), workerAgentsDir: pkgAgents, requiredFiles: ["settings.json"] },
      "strong-solo": { ...base.modes["strong-solo"], piConfigDir: path.join(piCfg, "strong-solo"), ...(overrides.strongSolo ?? {}) },
    },
  });
  return file;
};
const cfgPath = mkConfig(path.join(scratch, "foreman.selftest.json"));
const badCfgPath = mkConfig(path.join(scratch, "foreman.selftest.bad.json"), { strongSolo: { requiredHelpFlags: ["--subagent-max-depth"] } });
const rogueCfgPath = mkConfig(path.join(scratch, "foreman.selftest.rogue.json"), { harnessDir: "harness-rogue" });
const pidFile = path.join(scratch, "grandchild.pid");

const common = (cfg: string) => ["--config", cfg, "--task", TASK, "--task-dir", path.join(here, "task"), "--runs-dir", runsRoot, "--results-dir", resultsRoot, "--workdir", workdir, "--dotenv", path.join(scratch, "no.env")];
const run = (script: string, extra: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [tsx, path.join(REPO_ROOT, "scripts", script), ...extra], { cwd: REPO_ROOT, env, encoding: "utf8", timeout: 10 * 60000 });
const envNoKey = { ...process.env, OPENROUTER_API_KEY: "" };
const show = (out: string) => console.log(out.split("\n").map((l) => "    | " + l).join("\n"));

try {
  // 0. Unit checks
  const pricing = {
    prompt: "0.0000001",
    completion: "0.0000005",
    input_cache_read: "0.00000001",
    input_cache_write: "0.000000125",
    input_cache_write_1h: "0.0000002",
    overrides: [{ min_prompt_tokens: 100000, prompt: "0.0000005", completion: "0.0000025", input_cache_read: "0.00000005" }],
  };
  const small = priceTokens(pricing as any, { input: 1000, output: 100, cacheRead: 10000, cacheWrite: 0 }, 1, 11000)!;
  check(Math.abs(small - (1000 * 1e-7 + 100 * 5e-7 + 10000 * 1e-8)) < 1e-12, "cache-read tokens are priced at input_cache_read, not full input price");
  const big = priceTokens(pricing as any, { input: 120000, output: 100, cacheRead: 0, cacheWrite: 0 }, 1, 120000)!;
  check(Math.abs(big - (120000 * 5e-7 + 100 * 2.5e-6)) < 1e-12, "long-context override applies per request (>= min_prompt_tokens)");
  const w1h = priceTokens(pricing as any, { input: 0, output: 0, cacheRead: 0, cacheWrite: 1000, cacheWrite1h: 400 }, 1, 1000)!;
  check(Math.abs(w1h - (600 * 1.25e-7 + 400 * 2e-7)) < 1e-12, "cacheWrite1h (subset of cacheWrite) priced at input_cache_write_1h");
  const p1 = contaminationInternal.pathsInCommand("cat > a.ts <<'EOF'\nfetch('/api/x'); const z = {...a};\nEOF\nnpm test");
  check(p1.length === 0, "heredoc bodies and URL paths are not treated as filesystem paths");
  const p2 = contaminationInternal.pathsInCommand("ls ../other && cat C:\\Users\\x\\demo.txt && ls /c/Users");
  check(p2.length === 3, `parent-relative, Windows and Git-Bash paths are extracted (${JSON.stringify(p2)})`);
  const bp = budgetProblems({ at: "", keyLimitRemaining: 1, keyLimit: 1, accountRemaining: 0.27 }, 5);
  check(bp.length === 2 && /KEY limit/.test(bp[0]) && /ACCOUNT balance/.test(bp[1]), "budget check names both the key limit and the account balance when short");
  check(budgetProblems({ at: "", keyLimitRemaining: null, keyLimit: null, accountRemaining: 50 }, 5).length === 0, "budget check passes with no key limit and enough balance");
  check(isBillingError("402 ... You requested up to 128000 tokens, but can only afford 23656") && !isBillingError("500 internal"), "402/credit errors are recognised as billing errors");
  // Key usage is not monotonic right after a run (NOTES.md live log): 0.00070861 -> 0 -> 0.005857677 -> 0.005857677.
  const fakeReads = (vals: number[]) => {
    let i = 0;
    return async () => ({ at: new Date().toISOString(), usage: vals[Math.min(i++, vals.length - 1)], byokUsage: 0 });
  };
  const snap = await settleKeyUsage("k", { initialDelayMs: 0, intervalMs: 0, stableReads: 2, maxWaitMs: 5000 }, () => {}, null, fakeReads([0.00070861, 0, 0.005857677, 0.005857677]));
  check(snap.stable && snap.usage === 0.005857677 && snap.staleReads === 1 && snap.reads.length === 4 && snap.reads[1].stale === true, "key usage: a lower read is stale, value accepted only after repeating; all raw reads kept");
  const snap2 = await settleKeyUsage("k", { initialDelayMs: 0, intervalMs: 0, stableReads: 2, maxWaitMs: 5000 }, () => {}, 0.01, fakeReads([0.002, 0.01, 0.01]));
  check(snap2.stable && snap2.usage === 0.01 && snap2.staleReads === 1, "key usage: reads below the previous snapshot (floor) are never accepted");
  check(servedMatches("minimax/minimax-m3", "minimax/minimax-m3-20260531") && !servedMatches("moonshotai/kimi-k2.7", "moonshotai/kimi-k2.7-code-20260612"), "served-model match allows dated suffixes only");

  // Lead-mode evidence in both directions, on synthetic run dirs (analyzeRun reads only the files a run left).
  const synth = (mode: string, invocation: string, evidence: boolean) => {
    const dir = path.join(scratch, "synthetic", mode);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "meta.json"), { mode, run: 1, status: "ok", pi: { invocation }, models: { lead: "anthropic/claude-opus-5.5", workers: {} } });
    const events = [
      { type: "session", version: 3, id: "s", cwd: dir },
      { type: "message_end", message: { role: "system", content: "x", toolsAdded: [{ name: "read" }, ...(evidence ? [{ name: "subagent" }] : [])] } },
      ...(evidence ? [{ type: "entry_appended", entry: { type: "custom", customType: "foreman-lead-applied", data: { leadSha256: "abc" } } }] : []),
      { type: "message_end", message: { role: "assistant", content: [], provider: "openrouter", model: "anthropic/claude-opus-5.5", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } }, stopReason: "stop" } },
      { type: "agent_end", messages: [] },
    ];
    fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    return dir;
  };
  const analyzeOpts = { repoRoot: REPO_ROOT, threshold: 0.15, harnessMode: "harness" };
  const noLead = await analyzeRun(synth("harness", "pi --mode json --orchestrate --no-skills", false), analyzeOpts);
  check(noLead.failed && noLead.flags.includes("LEAD_MODE_MISSING") && /lead mode was not active/.test(noLead.failureReason ?? ""), "started with --orchestrate but no lead-mode evidence -> LEAD_MODE_MISSING, excluded with a re-run reason");
  const leaked = await analyzeRun(synth("strong-solo", "pi --mode json --no-skills", true), analyzeOpts);
  check(leaked.failed && leaked.flags.includes("LEAD_MODE_UNEXPECTED"), "solo run that shows lead mode -> LEAD_MODE_UNEXPECTED, excluded");
  const withLead = await analyzeRun(synth("harness-lite", "pi --mode json --orchestrate", true), analyzeOpts);
  check(!withLead.flags.some((f) => f.startsWith("LEAD_MODE")) && withLead.leadMode.leadSha256 === "abc", "lead-mode evidence present -> no LEAD_MODE flag, LEAD.md hash recorded");

  // 1. Missing key without --no-key-cost must fail fast, before creating anything.
  const a = run("compare.ts", [...common(cfgPath), "--modes", "harness,strong-solo", "--runs", "1"], envNoKey);
  check(a.status === 2, `missing OPENROUTER_API_KEY -> exit 2 (got ${a.status})`);
  check(/OPENROUTER_API_KEY is not set/.test(a.stderr), "missing key -> clear message mentioning OPENROUTER_API_KEY and --no-key-cost");
  check(!exists(path.join(runsRoot, TASK)), "missing key -> no run directories created");
  if (a.status !== 2) show(a.stdout + a.stderr);

  // 2. Preflight: a mode whose required extension flag is missing from `pi --help` must abort.
  const pf = run("compare.ts", [...common(badCfgPath), "--modes", "strong-solo", "--runs", "1", "--no-key-cost"], envNoKey);
  check(pf.status === 2 && /does not list --subagent-max-depth/.test(pf.stderr), "preflight: missing extension flag in `pi --help` -> abort before any run");
  const rg = run("compare.ts", [...common(rogueCfgPath), "--modes", "harness", "--runs", "1", "--no-key-cost", "--dry-run"], envNoKey);
  check(rg.status === 2 && /not managed by the foreman package/.test(rg.stderr), "preflight: a hand-written worker file in an --orchestrate profile's agents/ -> abort (it would replace a package worker's model)");

  // 2b. Pi >= 0.75 on a Node < 22.19 must abort (only testable when the runner's own Node is older).
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 19)) {
    const nv = run("compare.ts", [...common(cfgPath), "--modes", "strong-solo", "--runs", "1", "--no-key-cost", "--dry-run"], { ...envNoKey, STUB_VERSION: "1.2.0" });
    check(nv.status === 2 && /needs Node >= 22\.19/.test(nv.stderr), "Pi 1.2.0 on Node < 22.19 -> abort with a clear message (set pi.node)");
  }

  // 3. Dry run prints the exact Pi invocation and runs nothing.
  const d = run("compare.ts", [...common(cfgPath), "--modes", "harness,strong-solo", "--runs", "1", "--no-key-cost", "--dry-run"], envNoKey);
  check(
    d.status === 0 &&
      /dry-run harness: PI_OFFLINE=1 PI_TELEMETRY=0 PI_CODING_AGENT_DIR=\S+ pi --mode json --model openrouter\/anthropic\/claude-opus-5\.5 --orchestrate --no-skills --no-approve --session-dir \S+ < SPEC\.md/.test(d.stdout),
    "--dry-run prints the harness invocation (Foreman package via --orchestrate)",
  );
  check(/dry-run strong-solo: .*--model openrouter\/anthropic\/claude-opus-5\.5 --no-skills --no-approve --session-dir/.test(d.stdout), "--dry-run prints the solo invocation (no harness-only flags)");
  check(!exists(path.join(runsRoot, TASK)), "--dry-run creates no run directories");
  if (d.status !== 0) show(d.stdout + d.stderr);

  // 4. Full flow: 2 modes x 2 runs with the stub Pi, no key. (The stub exits 64 if the invocation shape is wrong.)
  const t0 = Date.now();
  const b = run("compare.ts", [...common(cfgPath), "--modes", "harness,strong-solo", "--runs", "2", "--no-key-cost"], { ...envNoKey, STUB_PID_FILE: pidFile });
  show(b.stdout);
  if (b.stderr.trim()) console.log(b.stderr);
  check(b.status === 0, `compare exit 0 (got ${b.status}) in ${Math.round((Date.now() - t0) / 1000)}s`);

  // 5. A run that fails like the live 402 (exit 0, stopReason error): FAILED, excluded from means; compare stops (exit 3).
  const c = run("compare.ts", [...common(cfgPath), "--modes", "strong-solo,harness", "--runs", "1", "--no-key-cost"], { ...envNoKey, STUB_FAIL: "billing" });
  show(c.stdout);
  check(c.status === 3 && /STOPPED: .*billing error/.test(c.stderr), `billing failure stops the remaining runs (exit ${c.status})`);
  check(!exists(path.join(runsRoot, TASK, "harness-3")), "no run was started after the billing failure");

  const taskRuns = path.join(runsRoot, TASK);
  for (const id of ["harness-1", "harness-2", "strong-solo-1", "strong-solo-2", "strong-solo-3"]) {
    const rd = path.join(taskRuns, id);
    const need = ["meta.json", "events.jsonl", "stderr.log", "grade.json", "grade.log", "diffstat.txt", "prices.json", "npm-ci.log", "workspace"];
    if (id.startsWith("harness")) need.push("BOARD.md", "pi-sessions");
    const missing = need.filter((f) => !exists(path.join(rd, f)));
    check(missing.length === 0, `${id}: artifacts present${missing.length ? ` (missing ${missing.join(", ")})` : ""}`);
    check(!exists(path.join(rd, "workspace", "hidden-tests")) && !exists(path.join(rd, "workspace", "node_modules")), `${id}: workspace copy has no hidden-tests and no node_modules`);
  }
  const leftovers = exists(path.join(workdir, TASK)) ? fs.readdirSync(path.join(workdir, TASK)).filter((f) => f !== ".foreman-workroot") : [];
  check(leftovers.length === 0, `temporary workspaces deleted after grading (${leftovers.join(", ") || "none left"})`);
  if (exists(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    check(!alive, `timed-out run: grandchild process ${pid} was killed with the tree`);
  } else check(false, "timed-out run wrote its grandchild pid");

  const resultsJson = path.join(resultsRoot, TASK, "results.json");
  check(exists(resultsJson) && exists(path.join(resultsRoot, TASK, "report.md")) && exists(path.join(resultsRoot, "index.html")), "results.json, report.md and index.html written");
  const res: any = readJson(resultsJson);
  const byId = Object.fromEntries(res.runs.map((r: any) => [r.runId, r]));
  check(res.runs.length === 5, `results.json has all 5 runs (got ${res.runs.length})`);
  const m1 = readJson(path.join(taskRuns, "harness-1", "meta.json"));
  check(m1.status === "ok" && /--orchestrate --no-skills --no-approve/.test(m1.pi.invocation), "harness-1: status ok with the --orchestrate invocation recorded in meta.json");
  check(byId["harness-1"]?.leadMode?.expected && byId["harness-1"].leadMode.applied && byId["harness-1"].leadMode.subagentTool, "harness-1: lead mode verified from the run's own events (foreman-lead-applied entry + subagent tool)");
  check(res.runs.every((r: any) => !r.flags.some((f: string) => f.startsWith("LEAD_MODE"))) && byId["strong-solo-1"]?.leadMode?.expected === false && !byId["strong-solo-1"].leadMode.applied, "no LEAD_MODE_* flags on correctly configured runs; solo runs show no lead mode");
  check(JSON.stringify(byId["harness-1"]?.flags) === JSON.stringify(["NO_KEY_COST"]), `clean @mjakl-shaped harness run carries no other flag (${byId["harness-1"]?.flags.join(" ")})`);
  check(byId["harness-1"]?.delegation.package === "@mjakl/pi-subagent" && byId["harness-1"].delegation.workerResults === 3, "@mjakl/pi-subagent details parsed: 3 worker results (heartbeats and toolResult copy not double counted)");
  check(byId["strong-solo-2"]?.status === "timeout" && byId["strong-solo-2"].flags.includes("TIMEOUT") && !byId["strong-solo-2"].failed, "timed-out run is kept, flagged TIMEOUT, and scored (not 'failed')");
  check(byId["strong-solo-2"]?.tests.graded === true && byId["strong-solo-2"].tests.passed === 0, "timed-out run is still graded (0/20)");
  const s3 = byId["strong-solo-3"];
  check(
    s3?.failed && s3.status === "agent_error" && s3.flags.includes("FAILED_RUN") && s3.flags.includes("BILLING_ERROR") && s3.flags.includes("AGENT_ERROR(error)"),
    "402 run (exit 0) is classified failed: FAILED_RUN, AGENT_ERROR(error), BILLING_ERROR",
  );
  check(/can only afford/.test(s3?.errorMessage ?? "") && /can only afford/.test(readJson(path.join(taskRuns, "strong-solo-3", "meta.json")).agentErrorMessage ?? ""), "errorMessage (first 500 chars) stored in meta.json and results.json");
  const ss = res.summary.find((x: any) => x.mode === "strong-solo");
  check(ss.runs === 3 && ss.scoredRuns === 2 && ss.failedRuns === 1 && ss.testsPassed.mean === 9.5, "failed run excluded from the strong-solo means (2 scored of 3)");
  check(byId["harness-2"]?.flags.some((f: string) => f.startsWith("CONTAMINATION")), "worker transcript touching demo-tasks/hidden-tests -> CONTAMINATION flag");
  check(byId["harness-2"]?.flags.includes("WORKER_MODEL_OVERRIDE(1)"), "per-call worker model override -> WORKER_MODEL_OVERRIDE flag");
  check(byId["harness-2"]?.flags.includes("PI_FALLBACK_MODEL"), "Pi 'Using custom model id' warning -> PI_FALLBACK_MODEL flag");
  check(byId["strong-solo-1"]?.flags.some((f: string) => f.startsWith("OUTSIDE_WORKSPACE")), "`ls ..` -> OUTSIDE_WORKSPACE warning");
  check(res.runs.every((r: any) => r.flags.includes("NO_KEY_COST") && r.cost.source === "events-estimate"), "no key -> every run flagged NO_KEY_COST, cost source events-estimate");
  const roles = (byId["harness-1"]?.byRole ?? []).map((x: any) => `${x.role}=${x.model}:${x.pricing}`).sort();
  check(
    JSON.stringify(roles) ===
      JSON.stringify(["backend=minimax/minimax-m3:per-request", "frontend=moonshotai/kimi-k2.7-code:per-request", `lead=${base.modes.harness.model}:per-request`, "tests=anthropic/claude-haiku-5.5:per-request"]),
    `harness byRole = lead + 3 workers, frontmatter models, priced per request (${roles.join(", ")})`,
  );
  const lead = byId["harness-1"].byRole.find((x: any) => x.role === "lead");
  check(lead.input === 1500 * 3 + 2500 + 3000 && lead.cacheRead === 4000 * 3 + 6000 + 9000, "lead tokens summed from message_end only (message_update usage ignored)");
  const prices = readJson(path.join(taskRuns, "harness-1", "prices.json")).models;
  const lp = prices[base.modes.harness.model];
  if (lp) {
    const expect = lead.input * +lp.prompt + lead.output * +lp.completion + lead.cacheRead * +(lp.input_cache_read ?? lp.prompt) + lead.cacheWrite * +(lp.input_cache_write ?? lp.prompt);
    check(Math.abs(lead.costUsd - expect) < 1e-6, `lead cost uses separate cache prices ($${lead.costUsd.toFixed(5)})`);
  } else check(false, `price for ${base.modes.harness.model} in prices.json`);
  const hp = prices["anthropic/claude-haiku-5.5"];
  const testsRole = byId["harness-1"].byRole.find((x: any) => x.role === "tests");
  if (hp && testsRole) {
    // The tests worker's first request has 110k input + 20k cache read = 130k prompt tokens.
    const ov = (Array.isArray(hp.overrides) ? hp.overrides : []).filter((o: any) => typeof o.min_prompt_tokens === "number" && !o.utc_start && 130000 >= o.min_prompt_tokens).sort((x: any, y: any) => y.min_prompt_tokens - x.min_prompt_tokens)[0];
    const eff = { ...hp, ...(ov ?? {}) };
    const m1c = 110000 * +eff.prompt + 1500 * +eff.completion + 20000 * +(eff.input_cache_read ?? eff.prompt);
    const m2c = 6000 * +hp.prompt + 500 * +hp.completion + 10000 * +(hp.input_cache_read ?? hp.prompt);
    check(Math.abs(testsRole.costUsd - (m1c + m2c)) < 1e-6, `worker priced per message incl. long-context override for the 130k-prompt request ($${testsRole.costUsd.toFixed(5)})`);
  } else check(false, "haiku price + tests role present");
  const served = byId["harness-1"].models.workerServed;
  check(served.backend?.includes("minimax/minimax-m3-served-variant") && !byId["harness-1"].flags.includes("MODEL_MISMATCH"), "worker responseModel recorded; a served variant is not a model mismatch");
  check(
    /^Harness passed 17\.5\/20 \(strong-solo 9\.5\/20\) at \d+% of strong-solo cost on this task, across 2 runs\..*1 failed run .* excluded from the means/.test(res.headline),
    `computed headline: "${res.headline}"`,
  );
  const md = fs.readFileSync(path.join(resultsRoot, TASK, "report.md"), "utf8");
  check(md.includes("## Harness cost breakdown by role") && md.includes("ESTIMATES") && md.includes("## Failed runs") && md.includes("can only afford"), "report.md: breakdown, estimate note, failed runs with errorMessage");
  const html = fs.readFileSync(path.join(resultsRoot, "index.html"), "utf8");
  check((html.match(/<svg/g) ?? []).length === 3 && html.includes("No screenshot yet"), "index.html: 3 inline SVG charts + screenshot placeholders");
  check(!/<script[^>]+src=|<link[^>]+href=["']https?:/.test(html), "index.html is self-contained");

  // 6. report regenerates from runs/ alone, identically.
  const before = JSON.stringify({ ...res, generatedAt: 0 });
  const r = run("report.ts", ["--config", cfgPath, "--task", TASK, "--runs-dir", runsRoot, "--results-dir", resultsRoot], envNoKey);
  const res2: any = readJson(resultsJson);
  check(r.status === 0 && JSON.stringify({ ...res2, generatedAt: 0 }) === before, "npm run report regenerates identical results.json from runs/");

  // 6b. Served-model check parsing: generations.json is written by the runner only when a key is present, so the
  //     self-test drops a fixture one into harness-1 (shape of fetchGeneration results) and regenerates the report.
  writeJson(path.join(taskRuns, "harness-1", "generations.json"), {
    checkedAt: new Date().toISOString(),
    source: "selftest fixture",
    maxPerRole: 3,
    entries: [
      { role: "lead", configuredModel: base.modes.harness.model, responseId: "msg_01abc", verifiable: false, error: "unverifiable via API (not a gen- id)" },
      { role: "backend", configuredModel: "minimax/minimax-m3", responseId: "gen-1", verifiable: true, model: "minimax/minimax-m3-20260531", provider: "CoreWeave", totalCostUsd: 0.001 },
      { role: "frontend", configuredModel: "moonshotai/kimi-k2.7-code", responseId: "gen-2", verifiable: true, model: "moonshotai/kimi-k2.6", provider: "Novita", totalCostUsd: 0.002 },
    ],
  });
  const r2 = run("report.ts", ["--config", cfgPath, "--task", TASK, "--runs-dir", runsRoot, "--results-dir", resultsRoot], envNoKey);
  const res3: any = readJson(resultsJson);
  const h1 = res3.runs.find((x: any) => x.runId === "harness-1");
  check(
    r2.status === 0 && h1.flags.includes("SERVED_MODEL_MISMATCH(1)") && h1.servedCheck.verified === 2 && h1.servedCheck.unverifiable === 1 && h1.servedCheck.byRole.backend.providers[0] === "CoreWeave",
    "served-model check: dated variant accepted, wrong model flagged, msg_ ids counted as unverifiable",
  );
  check(fs.readFileSync(path.join(resultsRoot, TASK, "report.md"), "utf8").includes("## Served-model check"), "report.md has the served-model table");

  // 7. screenshots step without Playwright: graceful.
  const s = run("screenshots.ts", ["--config", cfgPath, "--task", TASK, "--runs-dir", runsRoot, "--results-dir", resultsRoot], envNoKey);
  check(s.status === 0, `screenshots step exits 0 without Playwright (${(s.stdout.split("\n")[0] ?? "").trim()})`);
} finally {
  if (!keep) {
    fs.rmSync(path.join(runsRoot, TASK), { recursive: true, force: true });
    fs.rmSync(path.join(resultsRoot, TASK), { recursive: true, force: true });
    if (inRepo) {
      const otherTasks = exists(resultsRoot) ? fs.readdirSync(resultsRoot).filter((t) => exists(path.join(resultsRoot, t, "results.json"))) : [];
      if (otherTasks.length) fs.writeFileSync(path.join(resultsRoot, "index.html"), renderIndexHtml(resultsRoot, runsRoot, loadConfig()));
      else if (!preexisting.index) fs.rmSync(path.join(resultsRoot, "index.html"), { force: true });
      for (const [dir, existed] of [
        [runsRoot, preexisting.runs],
        [resultsRoot, preexisting.results],
      ] as const) {
        if (!existed && exists(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    console.log(`cleaned up self-test output${inRepo ? " (runs/selftest, results/selftest)" : ""}`);
  } else console.log(`kept: ${runsRoot}, ${resultsRoot}, ${scratch}`);
}

console.log(failures.length ? `\nSELFTEST FAILED (${failures.length}):\n - ${failures.join("\n - ")}` : "\nSELFTEST PASSED");
process.exit(failures.length ? 1 : 0);
