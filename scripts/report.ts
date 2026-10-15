/**
 * Regenerates results/<task>/results.json, results/<task>/report.md and results/index.html from runs/ alone.
 *   npm run report -- --task habit-tracker
 * Every number comes from files the runner wrote (meta.json, events.jsonl, grade.json, prices.json, pi-sessions/).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { analyzeRun, type RunRecord } from "./lib/analyze.ts";
import { barChartH, columnChart } from "./lib/charts.ts";
import { loadConfig, type ForemanConfig } from "./lib/config.ts";
import type { PriceSnapshot } from "./lib/openrouter.ts";
import { REPO_ROOT, argString, exists, fmtInt, fmtMs, fmtUsd, mean, parseArgv, readJsonIfExists, stats, writeJson, writeText } from "./lib/util.ts";

type Stats = ReturnType<typeof stats>;

interface ModeSummary {
  mode: string;
  /** All runs, failed ones included. */
  runs: number;
  /** Runs that count in the means (not failed; timeouts do count). */
  scoredRuns: number;
  /** Cost of record summed over ALL runs of the mode, failed ones included (real spend). */
  totalSpendUsd: number;
  testsTotal: number;
  testsPassed: Stats;
  costUsd: Stats;
  costSources: string[];
  wallMs: Stats;
  tokens: { input: Stats; output: Stats; cacheRead: Stats; cacheWrite: Stats };
  flaggedRuns: number;
  failedRuns: number;
}

interface RoleRow {
  role: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  meanCostUsd: number | null;
  share: number | null;
  pricing: string;
}

const FLAG_HELP: Record<string, string> = {
  TIMEOUT: "Pi hit the wall-clock limit; its process tree was killed. The run still counts.",
  AGENT_ERROR: "The last model response ended with stopReason error/aborted/length (Pi exits 0 in JSON mode even then).",
  FAILED_RUN: "Not a test score: the run failed (API/model error, crash, setup). Listed, but excluded from means and the headline.",
  BILLING_ERROR: "OpenRouter refused a request for credit/limit reasons (402). Check minHeadroomUsd, the key limit and the balance.",
  WORKER_MODEL_OVERRIDE: "The lead passed a per-call model/thinking to a worker, overriding its frontmatter model.",
  WORKER_ERRORS: "Some worker calls ended with an error or a non-zero exit.",
  SERVED_MODEL_MISMATCH: "OpenRouter's /generation record shows a served model that is not the configured one (dated suffixes allowed).",
  EXIT_n: "Pi exited non-zero.",
  SETUP_FAILED: "Workspace setup (npm ci) failed; Pi never started.",
  SPAWN_ERROR: "Pi could not be started.",
  RUNNER_ERROR: "The compare runner itself failed during this run (see meta.json runnerError).",
  NO_AGENT_END: "No agent_end event: Pi stopped mid-run.",
  NO_EVENTS: "No events.jsonl.",
  GRADE_ERROR: "grade.sh reported an error (install/import failure, manifest mismatch) or produced no grade.json; the score is what the grader counted (0 if none).",
  CONTAMINATION: "A tool call referenced hidden-tests, demo-tasks or the Foreman repo. Treat the score as suspect.",
  OUTSIDE_WORKSPACE: "Tool calls touched paths outside the workspace (heuristic; see results.json for details).",
  NO_KEY_COST: "Run without the OpenRouter key-usage delta; cost is an estimate from Pi events.",
  KEY_USAGE_UNAVAILABLE: "Key-usage snapshot failed; the cost shown is the event estimate.",
  KEY_USAGE_UNSTABLE: "Key usage never stabilised while polling; the delta may be incomplete.",
  KEY_LATE_USAGE: "Key usage arrived after the run's end snapshot and was attributed to this run.",
  BYOK_USAGE: "byok_usage moved during the run; BYOK spend is not in the credits delta.",
  COST_DISAGREE: "Event-derived cost differs from the key delta by more than the threshold.",
  MODEL_MISMATCH: "A response came from a different model than configured (lead or worker).",
  NON_OPENROUTER_PROVIDER: "Some responses did not go through OpenRouter, so the key delta misses them.",
  PI_FALLBACK_MODEL: "Pi did not know a model id and used cloned metadata; Pi's own cost numbers are wrong for it.",
  UNPRICED: "No OpenRouter price for these models; event-derived cost excludes them.",
  INCOMPLETE_USAGE: "A delegation call never returned (timeout/crash); worker usage from events is partial.",
  NO_DELEGATION: "Harness lead never delegated to a worker.",
  COMPACTION_UNCOUNTED: "Context compaction ran; its summarisation calls are not in the events (key delta still has them).",
  CONTEXT_FILES_IN_ANCESTORS: "AGENTS.md/CLAUDE.md in a parent of the workspace was loaded by Pi.",
  EVENT_PARSE_ERRORS: "Some events.jsonl lines were not JSON.",
};

function fmtNum(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

function rangeStr(s: Stats, f: (n: number) => string): string {
  if (s.mean === null) return "n/a";
  return s.n > 1 ? `${f(s.mean)} (${f(s.min!)}–${f(s.max!)})` : f(s.mean);
}

function shortModel(m: string): string {
  return m.includes("/") ? m.slice(m.indexOf("/") + 1) : m;
}

export async function analyzeTask(task: string, runsRoot: string, cfg: ForemanConfig): Promise<RunRecord[]> {
  const dir = path.join(runsRoot, task);
  if (!exists(dir)) return [];
  const runDirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && exists(path.join(dir, d.name, "meta.json")))
    .map((d) => path.join(dir, d.name));
  const recs: RunRecord[] = [];
  for (const rd of runDirs) recs.push(await analyzeRun(rd, { repoRoot: REPO_ROOT, threshold: cfg.costDisagreementThreshold, harnessMode: cfg.harnessMode }));
  const order = Object.keys(cfg.modes);
  const rank = (m: string) => (order.indexOf(m) === -1 ? 999 : order.indexOf(m));
  recs.sort((a, b) => rank(a.mode) - rank(b.mode) || a.mode.localeCompare(b.mode) || a.run - b.run);
  return recs;
}

function summarize(recs: RunRecord[], testsTotal: number): ModeSummary[] {
  const modes = [...new Set(recs.map((r) => r.mode))];
  return modes.map((mode) => {
    const all = recs.filter((r) => r.mode === mode);
    const rs = all.filter((r) => !r.failed);
    const costs = rs.map((r) => r.cost.ofRecordUsd).filter((x): x is number => x !== null);
    const walls = rs.map((r) => r.wallMs).filter((x): x is number => x !== null);
    return {
      mode,
      runs: all.length,
      scoredRuns: rs.length,
      totalSpendUsd: all.reduce((a, r) => a + (r.cost.ofRecordUsd ?? 0), 0),
      testsTotal,
      testsPassed: stats(rs.map((r) => r.tests.passed)),
      costUsd: stats(costs),
      costSources: [...new Set(rs.map((r) => r.cost.source))],
      wallMs: stats(walls),
      tokens: {
        input: stats(rs.map((r) => r.tokens.input)),
        output: stats(rs.map((r) => r.tokens.output)),
        cacheRead: stats(rs.map((r) => r.tokens.cacheRead)),
        cacheWrite: stats(rs.map((r) => r.tokens.cacheWrite)),
      },
      flaggedRuns: all.filter((r) => r.flags.some((f) => f !== "NO_KEY_COST")).length,
      failedRuns: all.filter((r) => r.failed).length,
    };
  });
}

function harnessBreakdown(recs: RunRecord[], harnessMode: string): { runs: number; rows: RoleRow[]; eventMeanUsd: number | null; recordMeanUsd: number | null } {
  const hr = recs.filter((r) => r.mode === harnessMode && !r.failed);
  const map = new Map<string, RoleRow & { sum: number | null }>();
  for (const r of hr) {
    for (const b of r.byRole) {
      const k = `${b.role}\u0000${b.model}`;
      let row = map.get(k);
      if (!row) {
        row = { role: b.role, model: b.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, meanCostUsd: null, share: null, pricing: b.pricing, sum: 0 };
        map.set(k, row);
      }
      row.input += b.input;
      row.output += b.output;
      row.cacheRead += b.cacheRead;
      row.cacheWrite += b.cacheWrite;
      if (b.costUsd === null) row.sum = null;
      else if (row.sum !== null) row.sum += b.costUsd;
      if (row.pricing !== b.pricing) row.pricing = "mixed";
    }
  }
  const n = Math.max(1, hr.length);
  const rows: RoleRow[] = [...map.values()].map(({ sum, ...row }) => ({
    ...row,
    input: row.input / n,
    output: row.output / n,
    cacheRead: row.cacheRead / n,
    cacheWrite: row.cacheWrite / n,
    meanCostUsd: sum === null ? null : sum / n,
  }));
  const total = rows.reduce((a, r) => a + (r.meanCostUsd ?? 0), 0);
  for (const r of rows) r.share = total > 0 && r.meanCostUsd !== null ? r.meanCostUsd / total : null;
  const leadFirst = (r: RoleRow) => (r.role === "lead" ? 0 : r.role.startsWith("lead:") ? 1 : 2);
  rows.sort((a, b) => leadFirst(a) - leadFirst(b) || (b.meanCostUsd ?? 0) - (a.meanCostUsd ?? 0));
  const ev = hr.map((r) => r.cost.eventPricedUsd).filter((x): x is number => x !== null);
  const rec = hr.map((r) => r.cost.ofRecordUsd).filter((x): x is number => x !== null);
  return { runs: hr.length, rows, eventMeanUsd: mean(ev), recordMeanUsd: mean(rec) };
}

function buildHeadline(summary: ModeSummary[], recs: RunRecord[], cfg: ForemanConfig, total: number): { text: string; parts: Record<string, unknown> } {
  const h = summary.find((s) => s.mode === cfg.harnessMode);
  const b = summary.find((s) => s.mode === cfg.baselineMode);
  const T = total > 0 ? String(total) : "?";
  const sentences: string[] = [];
  const parts: Record<string, unknown> = { testsTotal: total };
  const pct = (a: Stats, base: Stats) => (a.mean !== null && base.mean !== null && base.mean > 0 ? (a.mean / base.mean) * 100 : null);
  const runsPhrase = (a: ModeSummary, c?: ModeSummary) =>
    !c || a.scoredRuns === c.scoredRuns ? `${a.scoredRuns} run${a.scoredRuns === 1 ? "" : "s"}` : `${a.scoredRuns} ${a.mode} and ${c.scoredRuns} ${c.mode} runs`;
  if (h && b) {
    const z = pct(h.costUsd, b.costUsd);
    parts.harnessMeanPassed = h.testsPassed.mean;
    parts.baselineMeanPassed = b.testsPassed.mean;
    parts.costPercentOfBaseline = z;
    sentences.push(
      `Harness passed ${fmtNum(h.testsPassed.mean)}/${T} (${b.mode} ${fmtNum(b.testsPassed.mean)}/${T}) at ${z === null ? "n/a" : `${Math.round(z)}%`} of ${b.mode} cost on this task, across ${runsPhrase(h, b)}.`,
    );
  } else if (h || b) {
    const s = (h ?? b)!;
    sentences.push(`${s.mode} passed ${fmtNum(s.testsPassed.mean)}/${T} at ${fmtUsd(s.costUsd.mean)} mean cost, across ${runsPhrase(s)}.`);
  }
  for (const s of summary) {
    if (s === h || s === b) continue;
    const z = b ? pct(s.costUsd, b.costUsd) : null;
    sentences.push(`${s.mode} passed ${fmtNum(s.testsPassed.mean)}/${T}${b ? ` at ${z === null ? "n/a" : `${Math.round(z)}%`} of ${b.mode} cost` : ` at ${fmtUsd(s.costUsd.mean)}`}.`);
  }
  const sources = new Set(recs.map((r) => r.cost.source));
  if (sources.has("events-estimate") || sources.has("none")) {
    sentences.push(
      sources.size === 1 && sources.has("events-estimate")
        ? "Costs are ESTIMATES from Pi token events priced at OpenRouter list prices (no key-usage delta)."
        : "Some costs are estimates from Pi events (no key-usage delta for those runs).",
    );
  }
  const failed = recs.filter((r) => r.failed).length;
  if (failed) sentences.push(`${failed} failed run${failed === 1 ? "" : "s"} (billing, setup or runner failure, not a test score; re-run it) ${failed === 1 ? "is" : "are"} listed but excluded from the means.`);
  parts.failedRuns = failed;
  const flagged = recs.filter((r) => !r.failed && r.flags.some((f) => !f.startsWith("NO_KEY_COST"))).length;
  if (flagged) sentences.push(`${flagged} scored run${flagged === 1 ? "" : "s"} carry flags (see table).`);
  parts.flaggedRuns = flagged;
  parts.text = sentences.join(" ");
  return { text: sentences.join(" "), parts };
}

function mdTable(head: string[], rows: string[][]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
}

function unionPrices(task: string, runsRoot: string, recs: RunRecord[]): PriceSnapshot | null {
  let snap: PriceSnapshot | null = null;
  for (const r of recs) {
    const p = readJsonIfExists<PriceSnapshot>(path.join(runsRoot, task, r.runId, "prices.json"));
    if (!p) continue;
    snap ??= { fetchedAt: p.fetchedAt, source: p.source, models: {} };
    Object.assign(snap.models, p.models);
    if (p.fetchedAt < snap.fetchedAt) snap.fetchedAt = p.fetchedAt;
  }
  return snap;
}

type Breakdown = ReturnType<typeof harnessBreakdown>;

/** Modes that delegate (have worker definitions or are the configured harness mode), in config order. */
function delegatingModes(recs: RunRecord[], cfg: ForemanConfig): string[] {
  const modes = [...new Set(recs.map((r) => r.mode))];
  return modes.filter((m) => m === cfg.harnessMode || recs.some((r) => r.mode === m && Object.keys(r.models.workers ?? {}).length > 0));
}

function renderMarkdown(task: string, recs: RunRecord[], summary: ModeSummary[], breakdowns: Record<string, Breakdown>, headline: string, prices: PriceSnapshot | null, cfg: ForemanConfig, total: number, generatedAt: string): string {
  const T = total > 0 ? total : "?";
  const out: string[] = [];
  out.push(`# Foreman results: ${task}`, "");
  out.push(`Generated ${generatedAt} from \`runs/${task}/\` (${recs.length} runs) by \`npm run report -- --task ${task}\`. Do not hand-edit; regenerate.`, "");
  out.push(`**${headline}**`, "");
  out.push("## Runs", "");
  out.push(
    mdTable(
      ["Mode", "Run", "Status", "Tests", "Cost (of record)", "Cost source", "Event est.", "Wall", "Tokens in", "Cache read", "Cache write", "Tokens out", "Flags"],
      recs.map((r) => [
        r.mode,
        String(r.run),
        r.status,
        r.failed ? `failed${r.tests.graded ? ` (graded ${r.tests.passed}/${r.tests.total})` : ""}` : `${r.tests.passed}/${r.tests.total || T}`,
        fmtUsd(r.cost.ofRecordUsd),
        r.cost.source === "openrouter-key-delta" ? "key delta" : r.cost.source === "events-estimate" ? "estimate" : "none",
        fmtUsd(r.cost.eventPricedUsd),
        fmtMs(r.wallMs),
        fmtInt(r.tokens.input),
        fmtInt(r.tokens.cacheRead),
        fmtInt(r.tokens.cacheWrite),
        fmtInt(r.tokens.output),
        r.flags.join(" ") || "none",
      ]),
    ),
    "",
  );
  out.push("## Summary per mode (mean, min–max)", "");
  out.push(
    mdTable(
      ["Mode", "Runs (scored / all)", "Tests passed", "Cost", "Wall time", "Tokens in", "Cache read", "Tokens out", "Runs with flags", "Total spend (all runs)"],
      summary.map((s) => [
        s.mode,
        `${s.scoredRuns} / ${s.runs}`,
        `${rangeStr(s.testsPassed, (n) => fmtNum(n))} / ${T}`,
        rangeStr(s.costUsd, fmtUsd),
        rangeStr(s.wallMs, fmtMs),
        rangeStr(s.tokens.input, fmtInt),
        rangeStr(s.tokens.cacheRead, fmtInt),
        rangeStr(s.tokens.output, fmtInt),
        `${s.flaggedRuns}`,
        fmtUsd(s.totalSpendUsd),
      ]),
    ),
    "",
  );
  const bdModes = Object.keys(breakdowns);
  if (!bdModes.length) out.push("## Harness cost breakdown by role", "", "No harness runs.", "");
  for (const mode of bdModes) {
    const hb = breakdowns[mode];
    out.push(`## ${mode === cfg.harnessMode ? "Harness" : mode} cost breakdown by role (mean per scored run, ${hb.runs} run${hb.runs === 1 ? "" : "s"})`, "");
    if (!hb.runs) {
      out.push("No scored runs.", "");
      continue;
    }
    out.push(
      mdTable(
        ["Role", "Model", "Tokens in", "Cache read", "Cache write", "Tokens out", "Cost", "Share", "Pricing"],
        hb.rows.map((r) => [r.role, r.model, fmtInt(r.input), fmtInt(r.cacheRead), fmtInt(r.cacheWrite), fmtInt(r.output), fmtUsd(r.meanCostUsd), r.share === null ? "n/a" : `${Math.round(r.share * 100)}%`, r.pricing]),
      ),
      "",
    );
    out.push(
      `Breakdown source: token usage in the parent Pi event stream (lead: assistant \`message_end\` usage; workers: the subagent tool result \`details.results[]\`, per message when complete), priced with OpenRouter /models list prices snapshotted in each run's prices.json. Event-derived mean ${fmtUsd(hb.eventMeanUsd)} vs cost-of-record mean ${fmtUsd(hb.recordMeanUsd)}.`,
      "",
    );
  }
  // Served-model check (OpenRouter /generation lookups recorded by the runner).
  const sc = recs.filter((r) => r.servedCheck && r.servedCheck.checked > 0);
  out.push("## Served-model check", "");
  if (!sc.length) out.push("No OpenRouter /generation lookups recorded (needs an API key at run time).", "");
  else {
    const rows: string[][] = [];
    for (const r of sc) {
      for (const [role, br] of Object.entries(r.servedCheck!.byRole)) {
        rows.push([r.runId, role, br.configured, br.served.join(", ") || "n/a", br.providers.join(", ") || "n/a", String(br.verified), br.unverifiable ? `${br.unverifiable} (msg_ ids, not checkable via API)` : "0"]);
      }
    }
    out.push(mdTable(["Run", "Role", "Configured", "Served (OpenRouter)", "Providers", "Verified", "Unverifiable"], rows), "");
  }
  const failedRecs = recs.filter((r) => r.failed);
  out.push("## Failed runs", "");
  if (!failedRecs.length) out.push("None.", "");
  else {
    out.push("These runs produced no usable result (API/model error, crash or setup failure). They stay listed everywhere but are excluded from the means and the headline; their spend still counts in “Total spend”.", "");
    for (const r of failedRecs) {
      out.push(`- **${r.runId}** (status ${r.status}, cost ${fmtUsd(r.cost.ofRecordUsd)}): ${r.failureReason ?? "?"}`);
      if (r.errorMessage) out.push(`  - errorMessage: \`${r.errorMessage.replace(/`/g, "'").replace(/\s+/g, " ").slice(0, 500)}\``);
    }
    out.push("");
  }
  out.push("## Flags", "");
  const flagged = recs.filter((r) => r.flags.length);
  if (!flagged.length) out.push("No run carries a flag.", "");
  for (const r of flagged) {
    out.push(`- **${r.runId}**: ${r.flags.join(", ")}`);
    for (const f of r.contamination.flags.slice(0, 8)) out.push(`  - ${f.severity} ${f.kind} via \`${f.tool}\` (${f.origin}): \`${f.detail.replace(/`/g, "'").slice(0, 160)}\``);
    if (r.contamination.flags.length > 8) out.push(`  - … ${r.contamination.flags.length - 8} more in results.json`);
  }
  const used = new Set(recs.flatMap((r) => r.flags.map((f) => f.replace(/\(.*$/, "").replace(/^EXIT_\d+$/, "EXIT_n"))));
  if (used.size) {
    out.push("", "Flag meanings:", "");
    for (const f of [...used].sort()) if (FLAG_HELP[f]) out.push(`- \`${f}\`: ${FLAG_HELP[f]}`);
  }
  out.push("", "## How cost is measured", "");
  out.push(
    `- **Cost of record:** OpenRouter \`GET /api/v1/key\` \`data.usage\` (USD, all-time credits) read before and after each run, polled until ${cfg.keyUsagePolling.stableReads} consecutive reads agree. Covers the lead, every worker and anything else on the key; runs are strictly sequential.`,
    `- **Breakdown / estimate:** tokens from Pi JSON events (input, output, cache read, cache write kept separate) × OpenRouter list prices (\`prompt\`, \`completion\`, \`input_cache_read\`, \`input_cache_write\`). Long-context overrides are applied per lead request only.`,
    `- **Pi's own cost fields** (from Pi's built-in price table) are recorded as \`piReportedUsd\` in results.json for reference only.`,
    `- Runs whose event estimate and key delta differ by more than ${Math.round(cfg.costDisagreementThreshold * 100)}% are flagged \`COST_DISAGREE\`.`,
    "",
  );
  if (prices && Object.keys(prices.models).length) {
    out.push(`## Prices used (USD per 1M tokens, snapshot ${prices.fetchedAt})`, "");
    const per = (s: unknown) => (typeof s === "string" && s !== "" ? `$${(parseFloat(s) * 1e6).toFixed(3)}` : "n/a");
    out.push(
      mdTable(
        ["Model", "Input", "Output", "Cache read", "Cache write", "Overrides"],
        Object.entries(prices.models).map(([id, p]) => [id, per(p.prompt), per(p.completion), per(p.input_cache_read), per(p.input_cache_write), Array.isArray(p.overrides) && p.overrides.length ? "yes" : "no"]),
      ),
      "",
    );
  }
  return out.join("\n") + "\n";
}

// ---------------------------------------------------------------- HTML

const PAGE_CSS = `
:root{color-scheme:light;--page:#f9f9f7;--surface-1:#fcfcfb;--text-primary:#0b0b0b;--text-secondary:#52514e;--text-muted:#898781;--grid:#e1e0d9;--axis:#c3c2b7;--border:rgba(11,11,11,.10);--series-1:#2a78d6;--series-2:#eb6834;--series-3:#1baf7a;--series-4:#eda100;--series-5:#e87ba4;--series-6:#008300;--series-7:#6250d6;--series-8:#e34948;--critical:#d03b3b;--warning:#fab219}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){color-scheme:dark;--page:#0d0d0d;--surface-1:#1a1a19;--text-primary:#f0efec;--text-secondary:#c3c2b7;--text-muted:#898781;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--series-5:#d55181;--series-6:#008300;--series-7:#9085e9;--series-8:#e66767}}
:root[data-theme="dark"]{color-scheme:dark;--page:#0d0d0d;--surface-1:#1a1a19;--text-primary:#f0efec;--text-secondary:#c3c2b7;--text-muted:#898781;--grid:#2c2c2a;--axis:#383835;--border:rgba(255,255,255,.10);--series-1:#3987e5;--series-2:#d95926;--series-3:#199e70;--series-4:#c98500;--series-5:#d55181;--series-6:#008300;--series-7:#9085e9;--series-8:#e66767}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--text-primary);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1120px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 12px}h3{font-size:15px;margin:0 0 8px}
.meta{color:var(--text-secondary);font-size:13px;margin:0 0 16px}
.headline{font-size:17px;background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin:16px 0}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:16px}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:14px 16px;min-width:0}
.card p{color:var(--text-secondary);font-size:13px;margin:6px 0 0}
.chart{display:block;overflow:visible}
.chart .grid{stroke:var(--grid);stroke-width:1}
.chart .axis{stroke:var(--axis);stroke-width:1}
.chart .tick{fill:var(--text-muted);font-size:11px;font-variant-numeric:tabular-nums}
.chart .label{fill:var(--text-primary);font-size:12px}
.chart .sublabel{fill:var(--text-muted);font-size:11px}
.chart .value{fill:var(--text-secondary);font-size:12px;font-weight:600}
.chart .dot{stroke:var(--surface-1);stroke-width:2}
.chart .mark:hover path,.chart .mark:hover .dot{opacity:.8}
.tablewrap{overflow-x:auto;background:var(--surface-1);border:1px solid var(--border);border-radius:10px}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--grid);white-space:nowrap}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
th{color:var(--text-secondary);font-weight:600}
tr:last-child td{border-bottom:0}
.swatch{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;vertical-align:baseline}
.flag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:6px;border:1px solid var(--border);margin:1px 2px;color:var(--text-secondary)}
.flag.crit{border-color:var(--critical);color:var(--text-primary)}
.flag.crit::before{content:"\\26A0  ";color:var(--critical)}
.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:16px}
.shots figure{margin:0;background:var(--surface-1);border:1px solid var(--border);border-radius:10px;padding:10px}
.shots img{width:100%;height:auto;border-radius:6px;border:1px solid var(--border);display:block}
.shots figcaption{font-size:13px;color:var(--text-secondary);margin-top:6px}
.placeholder{aspect-ratio:16/10;display:flex;align-items:center;justify-content:center;text-align:center;padding:12px;border:1px dashed var(--axis);border-radius:6px;color:var(--text-muted);font-size:13px}
footer{color:var(--text-muted);font-size:12px;margin-top:32px}
code{font-size:12px}
`;

const h = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function modeColorVar(mode: string, cfg: ForemanConfig, allModes: string[]): string {
  const order = [...Object.keys(cfg.modes), ...allModes.filter((m) => !cfg.modes[m])];
  const i = order.indexOf(mode);
  return `--series-${(i % 8) + 1}`;
}

function flagHtml(f: string): string {
  const crit = /^(CONTAMINATION|TIMEOUT|GRADE_ERROR|AGENT_ERROR|SETUP_FAILED|RUNNER_ERROR|SPAWN_ERROR|MODEL_MISMATCH|COST_DISAGREE)/.test(f);
  const key = f.replace(/\(.*$/, "").replace(/^EXIT_\d+$/, "EXIT_n");
  return `<span class="flag${crit ? " crit" : ""}" title="${h(FLAG_HELP[key] ?? "")}">${h(f)}</span>`;
}

function screenshotFigure(runsRoot: string, task: string, r: { runId: string; mode: string; tests: { passed: number; total: number } }): string {
  const dir = path.join(runsRoot, task, r.runId);
  const png = path.join(dir, "screenshot.png");
  const info = readJsonIfExists<{ error?: string }>(path.join(dir, "screenshot.json"));
  const cap = `${h(r.runId)} · ${r.tests.passed}/${r.tests.total || "?"} tests`;
  if (exists(png)) {
    const b64 = fs.readFileSync(png).toString("base64");
    return `<figure><img alt="Finished app, ${h(r.runId)}" src="data:image/png;base64,${b64}"><figcaption>${cap}</figcaption></figure>`;
  }
  const why = info?.error ? `Screenshot failed: ${h(info.error.slice(0, 200))}` : "No screenshot yet. Run <code>npm run screenshots -- --task " + h(task) + "</code> (needs Playwright).";
  return `<figure><div class="placeholder"><span>${why}</span></div><figcaption>${cap}</figcaption></figure>`;
}

function renderTaskSection(task: string, results: any, cfg: ForemanConfig, runsRoot: string): string {
  const recs: any[] = results.runs ?? [];
  const summary: ModeSummary[] = results.summary ?? [];
  const total: number = results.testsTotal ?? 0;
  const modes = summary.map((s) => s.mode);
  const testsChart = columnChart({
    ariaLabel: `Tests passed by mode, ${task}`,
    categories: summary.map((s) => ({
      label: s.mode,
      colorVar: modeColorVar(s.mode, cfg, modes),
      mean: s.testsPassed.mean,
      values: recs.filter((r) => r.mode === s.mode && !r.failed).map((r) => ({ label: `run ${r.run}`, value: r.tests.passed })),
    })),
    yMax: total > 0 ? total : undefined,
    format: (n) => fmtNum(n),
    tickFormat: (n) => String(n),
  });
  const costChart = columnChart({
    ariaLabel: `Cost per run by mode, ${task}`,
    categories: summary.map((s) => ({
      label: s.mode,
      colorVar: modeColorVar(s.mode, cfg, modes),
      mean: s.costUsd.mean,
      values: recs.filter((r) => r.mode === s.mode && !r.failed).map((r) => ({ label: `run ${r.run}`, value: r.cost.ofRecordUsd })),
    })),
    format: (n) => fmtUsd(n),
    tickFormat: (n) => (n === 0 ? "$0" : n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(n < 10 ? 1 : 0)}`),
  });
  const bds: Record<string, any> = results.breakdowns ?? { [cfg.harnessMode]: results.harnessBreakdown };
  // Chart: the harness mode if it has scored runs, else the first delegating mode that does (e.g. harness-lite).
  const chartMode = bds[cfg.harnessMode]?.runs ? cfg.harnessMode : (Object.keys(bds).find((m) => bds[m]?.runs) ?? cfg.harnessMode);
  const hb = bds[chartMode];
  const roleRows = (hb?.rows ?? []).filter((r: RoleRow) => r.meanCostUsd !== null);
  const roleChart = roleRows.length
    ? barChartH({
        ariaLabel: `${chartMode} cost by role, ${task}`,
        rows: roleRows.map((r: RoleRow) => ({ label: r.role, sublabel: shortModel(r.model), value: r.meanCostUsd ?? 0, valueLabel: `${fmtUsd(r.meanCostUsd)}${r.share !== null ? ` · ${Math.round(r.share * 100)}%` : ""}` })),
        colorVar: modeColorVar(chartMode, cfg, modes),
        format: (n) => (n === 0 ? "$0" : n < 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(1)}`),
      })
    : `<div class="placeholder"><span>No priced harness usage.</span></div>`;
  const costNote = (results.costSources ?? []).includes("openrouter-key-delta")
    ? "Bars: mean cost of record (OpenRouter key-usage delta); dots: individual runs."
    : "Bars: mean ESTIMATED cost (Pi events × OpenRouter list prices; no key delta); dots: individual runs.";

  const summaryRows = summary
    .map(
      (s) => `<tr><td><span class="swatch" style="background:var(${modeColorVar(s.mode, cfg, modes)})"></span>${h(s.mode)}</td><td class="num">${s.scoredRuns}${s.failedRuns ? ` (+${s.failedRuns} failed)` : ""}</td>
<td class="num">${h(rangeStr(s.testsPassed, (n) => fmtNum(n)))} / ${total || "?"}</td><td class="num">${h(rangeStr(s.costUsd, fmtUsd))}</td>
<td class="num">${h(rangeStr(s.wallMs, fmtMs))}</td><td class="num">${h(rangeStr(s.tokens.input, fmtInt))}</td><td class="num">${h(rangeStr(s.tokens.cacheRead, fmtInt))}</td><td class="num">${h(rangeStr(s.tokens.output, fmtInt))}</td><td class="num">${s.flaggedRuns}</td></tr>`,
    )
    .join("\n");
  const runRows = recs
    .map(
      (r) => `<tr><td>${h(r.mode)}</td><td class="num">${r.run}</td><td>${h(r.status)}</td><td class="num">${r.failed ? `<span title="${h(r.failureReason ?? "")}">failed</span>` : `${r.tests.passed}/${r.tests.total || total || "?"}`}</td>
<td class="num">${h(fmtUsd(r.cost.ofRecordUsd))}</td><td>${r.cost.source === "openrouter-key-delta" ? "key delta" : r.cost.source === "events-estimate" ? "estimate" : "none"}</td><td class="num">${h(fmtUsd(r.cost.eventPricedUsd))}</td>
<td class="num">${h(fmtMs(r.wallMs))}</td><td class="num">${h(fmtInt(r.tokens.input))}</td><td class="num">${h(fmtInt(r.tokens.cacheRead))}</td><td class="num">${h(fmtInt(r.tokens.cacheWrite))}</td><td class="num">${h(fmtInt(r.tokens.output))}</td>
<td style="white-space:normal">${r.flags.length ? r.flags.map(flagHtml).join("") : "<span class=\"flag\">none</span>"}</td></tr>`,
    )
    .join("\n");
  const roleTables = Object.entries(bds)
    .map(([mode, b]: [string, any]) => {
      const rows = (b?.rows ?? [])
        .map(
          (r: RoleRow) =>
            `<tr><td>${h(r.role)}</td><td>${h(r.model)}</td><td class="num">${h(fmtInt(r.input))}</td><td class="num">${h(fmtInt(r.cacheRead))}</td><td class="num">${h(fmtInt(r.cacheWrite))}</td><td class="num">${h(fmtInt(r.output))}</td><td class="num">${h(fmtUsd(r.meanCostUsd))}</td><td class="num">${r.share === null ? "n/a" : `${Math.round(r.share * 100)}%`}</td></tr>`,
        )
        .join("\n");
      return `<h2>${h(mode === cfg.harnessMode ? "Harness" : mode)} cost by role <span class="meta">(mean per scored run, ${b?.runs ?? 0} runs)</span></h2>
<div class="tablewrap"><table><thead><tr><th>Role</th><th>Model</th><th class="num">Tokens in</th><th class="num">Cache read</th><th class="num">Cache write</th><th class="num">Tokens out</th><th class="num">Cost / run</th><th class="num">Share</th></tr></thead><tbody>
${rows || '<tr><td colspan="8">No scored runs.</td></tr>'}
</tbody></table></div>`;
    })
    .join("\n");
  const servedRows = recs
    .filter((r) => r.servedCheck && r.servedCheck.checked > 0)
    .flatMap((r) =>
      Object.entries(r.servedCheck.byRole).map(
        ([role, br]: [string, any]) =>
          `<tr><td>${h(r.runId)}</td><td>${h(role)}</td><td>${h(br.configured)}</td><td>${h(br.served.join(", ") || "n/a")}</td><td>${h(br.providers.join(", ") || "n/a")}</td><td class="num">${br.verified}</td><td class="num">${br.unverifiable}</td></tr>`,
      ),
    )
    .join("\n");
  const servedTable = servedRows
    ? `<div class="tablewrap"><table><thead><tr><th>Run</th><th>Role</th><th>Configured</th><th>Served (OpenRouter /generation)</th><th>Providers</th><th class="num">Verified</th><th class="num">Unverifiable (msg_ ids)</th></tr></thead><tbody>
${servedRows}
</tbody></table></div>`
    : `<p class="meta">No OpenRouter /generation lookups recorded (needs an API key at run time).</p>`;
  const shots = modes
    .map((m) => recs.filter((r) => r.mode === m).map((r) => screenshotFigure(runsRoot, task, r)).join("\n"))
    .join("\n");

  return `<section>
<h1>Foreman: ${h(task)}</h1>
<p class="meta">Generated ${h(results.generatedAt)} from <code>runs/${h(task)}/</code> (${recs.length} runs). Regenerate with <code>npm run report -- --task ${h(task)}</code>; never hand-edited.</p>
<div class="headline">${h(results.headline)}</div>
<div class="grid3">
<div class="card"><h3>Tests passed by mode</h3>${testsChart}<p>Bars: mean hidden tests passed (out of ${total || "?"}); dots: individual scored runs (timeouts and grade errors count; failed runs are listed in the table, not plotted).</p></div>
<div class="card"><h3>Cost per run by mode</h3>${costChart}<p>${costNote}</p></div>
<div class="card"><h3>${h(chartMode === cfg.harnessMode ? "Harness" : chartMode)} cost by role</h3>${roleChart}<p>Mean per scored ${h(chartMode)} run (${hb?.runs ?? 0} runs), from Pi token events × OpenRouter list prices. Event total ${h(fmtUsd(hb?.eventMeanUsd ?? null))} vs cost of record ${h(fmtUsd(hb?.recordMeanUsd ?? null))}.</p></div>
</div>
<h2>Summary per mode</h2>
<div class="tablewrap"><table><thead><tr><th>Mode</th><th class="num">Runs</th><th class="num">Tests (mean, min–max)</th><th class="num">Cost</th><th class="num">Wall time</th><th class="num">Tokens in</th><th class="num">Cache read</th><th class="num">Tokens out</th><th class="num">Flagged</th></tr></thead><tbody>
${summaryRows}
</tbody></table></div>
<h2>All runs</h2>
<div class="tablewrap"><table><thead><tr><th>Mode</th><th class="num">Run</th><th>Status</th><th class="num">Tests</th><th class="num">Cost</th><th>Source</th><th class="num">Event est.</th><th class="num">Wall</th><th class="num">Tokens in</th><th class="num">Cache read</th><th class="num">Cache write</th><th class="num">Tokens out</th><th>Flags</th></tr></thead><tbody>
${runRows}
</tbody></table></div>
${roleTables || "<h2>Harness cost by role</h2><p>No harness runs.</p>"}
<h2>Served-model check</h2>
${servedTable}
<h2>Finished apps</h2>
<div class="shots">
${shots}
</div>
</section>`;
}

export function renderIndexHtml(resultsRoot: string, runsRoot: string, cfg: ForemanConfig): string {
  const tasks = exists(resultsRoot)
    ? fs.readdirSync(resultsRoot, { withFileTypes: true }).filter((d) => d.isDirectory() && exists(path.join(resultsRoot, d.name, "results.json"))).map((d) => d.name).sort()
    : [];
  const sections = tasks.map((t) => renderTaskSection(t, readJsonIfExists(path.join(resultsRoot, t, "results.json")), cfg, runsRoot)).join("\n<hr style=\"border:0;border-top:1px solid var(--grid);margin:40px 0\">\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Foreman results</title>
<style>${PAGE_CSS}</style>
</head>
<body>
<main>
${sections || "<h1>Foreman results</h1><p>No results yet. Run <code>npm run compare</code>.</p>"}
<footer>Every number on this page comes from logs written by the compare runner (runs/&lt;task&gt;/&lt;mode&gt;-&lt;n&gt;/). Cost of record = OpenRouter key-usage delta unless marked estimate. Flags mark runs to read with care; no run is ever dropped.</footer>
</main>
</body>
</html>
`;
}

export async function generateReport(opts: { task: string; runsRoot: string; resultsRoot: string; cfg: ForemanConfig }) {
  const { task, runsRoot, resultsRoot, cfg } = opts;
  const recs = await analyzeTask(task, runsRoot, cfg);
  const total = Math.max(0, ...recs.map((r) => r.tests.total));
  const summary = summarize(recs, total);
  const breakdowns: Record<string, Breakdown> = {};
  for (const m of delegatingModes(recs, cfg)) breakdowns[m] = harnessBreakdown(recs, m);
  const hb = breakdowns[cfg.harnessMode] ?? harnessBreakdown(recs, cfg.harnessMode);
  const headline = buildHeadline(summary, recs, cfg, total);
  const prices = unionPrices(task, runsRoot, recs);
  const generatedAt = new Date().toISOString();
  const outDir = path.join(resultsRoot, task);
  const results = {
    schema: "foreman.results/1",
    task,
    generatedAt,
    generatedFrom: `runs/${task}/<mode>-<n>/ (meta.json, events.jsonl, stderr.log, grade.json, prices.json, pi-sessions/)`,
    headline: headline.text,
    headlineParts: headline.parts,
    testsTotal: total,
    baselineMode: cfg.baselineMode,
    harnessMode: cfg.harnessMode,
    costDisagreementThreshold: cfg.costDisagreementThreshold,
    costSources: [...new Set(recs.map((r) => r.cost.source))],
    costMethod: {
      ofRecord: "OpenRouter GET /api/v1/key data.usage (USD) after minus before each run, polled until stable; late-arriving usage attributed back and flagged",
      estimate: "Pi JSON event token usage (input/output/cacheRead/cacheWrite) x OpenRouter /models pricing (prompt/completion/input_cache_read/input_cache_write)",
      piReportedUsd: "Pi's own usage.cost (its built-in price table); reference only",
    },
    summary,
    harnessBreakdown: hb,
    breakdowns,
    runs: recs.map((r) => ({ ...r, dir: path.relative(REPO_ROOT, r.dir).replace(/\\/g, "/") })),
    prices,
  };
  writeJson(path.join(outDir, "results.json"), results);
  if (prices) writeJson(path.join(outDir, "prices.json"), prices);
  const md = renderMarkdown(task, recs, summary, breakdowns, headline.text, prices, cfg, total, generatedAt);
  writeText(path.join(outDir, "report.md"), md);
  const html = renderIndexHtml(resultsRoot, runsRoot, cfg);
  writeText(path.join(resultsRoot, "index.html"), html);
  return { resultsJson: path.join(outDir, "results.json"), reportMd: path.join(outDir, "report.md"), indexHtml: path.join(resultsRoot, "index.html"), headline: headline.text, runs: recs.length };
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const task = argString(args, "task");
  if (!task) {
    console.error("Usage: npm run report -- --task <name> [--runs-dir runs] [--results-dir results] [--config foreman.config.json]");
    process.exit(2);
  }
  const cfg = loadConfig(argString(args, "config"));
  const runsRoot = path.resolve(argString(args, "runs-dir") ?? path.join(REPO_ROOT, "runs"));
  const resultsRoot = path.resolve(argString(args, "results-dir") ?? path.join(REPO_ROOT, "results"));
  if (!exists(path.join(runsRoot, task))) {
    console.error(`No runs found in ${path.join(runsRoot, task)}`);
    process.exit(2);
  }
  const out = await generateReport({ task, runsRoot, resultsRoot, cfg });
  console.log(`${out.runs} runs -> ${out.reportMd}\n${out.resultsJson}\n${out.indexHtml}\n${out.headline}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
