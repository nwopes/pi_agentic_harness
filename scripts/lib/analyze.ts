/**
 * Turn one run directory (runs/<task>/<mode>-<n>/) into a run record using ONLY the files the runner wrote:
 * meta.json, events.jsonl, stderr.log, grade.json, prices.json, pi-sessions/**.jsonl.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkToolCalls, type ContaminationResult } from "./contamination.ts";
import { normalizeModelId } from "./config.ts";
import { isBillingError, servedMatches, type PriceSnapshot } from "./openrouter.ts";
import { parseRunUsage, toolCallsFromSessionFile, type ToolCall, type UsageReport } from "./usage.ts";
import { exists, isInside, readJsonIfExists, round } from "./util.ts";

export interface RoleCost {
  role: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
  costUsd: number | null;
  piCostUsd: number;
  pricing: string;
}

export interface RunRecord {
  task: string;
  mode: string;
  run: number;
  runId: string;
  dir: string;
  status: string;
  /**
   * Infrastructure failure that says nothing about the mode (billing error, setup/spawn/runner failure, incomplete logs):
   * listed but excluded from means. Everything else is scored as graded, including timeouts, Pi crashes and
   * model-side stops (error/aborted/length), which are flagged instead.
   */
  failed: boolean;
  failureReason: string | null;
  /** First ~500 chars of the final assistant errorMessage, if any. */
  errorMessage: string | null;
  timedOut: boolean;
  exitCode: number | null;
  startedAt: string | null;
  wallMs: number | null;
  tests: { passed: number; failed: number; total: number; graded: boolean; error: string | null };
  cost: {
    ofRecordUsd: number | null;
    source: "openrouter-key-delta" | "events-estimate" | "none";
    keyDeltaUsd: number | null;
    keyLateUsd: number;
    eventPricedUsd: number | null;
    piReportedUsd: number;
    disagreement: number | null;
  };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; requests: number };
  byRole: RoleCost[];
  models: {
    configuredLead: string | null;
    leadSeen: string[];
    leadResponseModels: string[];
    providersSeen: string[];
    workers: Record<string, string | null>;
    workerServed: Record<string, string[]>;
  };
  delegation: { package: string | null; calls: number; incomplete: number; workerResults: number };
  flags: string[];
  contamination: ContaminationResult;
  diffstat: string | null;
  /** OpenRouter /generation lookups made by the runner (generations.json). */
  servedCheck: {
    checked: number;
    verified: number;
    unverifiable: number;
    errors: number;
    mismatches: { role: string; configured: string; served: string }[];
    byRole: Record<string, { configured: string; served: string[]; providers: string[]; verified: number; unverifiable: number }>;
  } | null;
  notes: string[];
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function listJsonl(dir: string): string[] {
  if (!exists(dir)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(p);
    }
  };
  walk(dir);
  return out.sort();
}

export async function analyzeRun(
  runDir: string,
  opts: { repoRoot: string; threshold: number; harnessMode: string },
): Promise<RunRecord> {
  const meta: any = readJsonIfExists(path.join(runDir, "meta.json")) ?? {};
  const grade: any = readJsonIfExists(path.join(runDir, "grade.json"));
  const prices: PriceSnapshot | null = readJsonIfExists(path.join(runDir, "prices.json")) ?? null;
  const flags: string[] = [];
  const notes: string[] = [];
  const workerModels: Record<string, string | null> = meta?.models?.workers ?? {};
  const leadRole: string = meta?.leadRole ?? (meta.mode === opts.harnessMode ? "lead" : "solo");

  // --- usage from events
  const eventsFile = path.join(runDir, "events.jsonl");
  let usage: UsageReport | null = null;
  if (exists(eventsFile)) {
    usage = await parseRunUsage({ eventsFile, leadRole, workerModels, prices });
    notes.push(...usage.notes);
    if (usage.parseErrors > 0) flags.push(`EVENT_PARSE_ERRORS(${usage.parseErrors})`);
  } else if (meta.status !== "setup_failed") {
    flags.push("NO_EVENTS");
  }

  // --- contamination (lead events + any saved Pi session files, which include worker transcripts if persisted)
  const calls: ToolCall[] = [...(usage?.toolCalls ?? [])];
  const seen = new Set(calls.map((c) => `${c.id}|${JSON.stringify(c.args ?? null)}`));
  const workspace: string = meta.workspacePath ?? path.join(os.tmpdir(), "unknown-workspace");
  const sessionsDir = path.join(runDir, "pi-sessions");
  let workerCwdIssues = 0;
  for (const f of listJsonl(sessionsDir)) {
    const rel = path.relative(sessionsDir, f).replace(/\\/g, "/");
    const { calls: sc, cwd } = await toolCallsFromSessionFile(f, `session:${rel}`);
    if (cwd && !isInside(cwd, workspace)) workerCwdIssues++;
    for (const c of sc) {
      const k = `${c.id}|${JSON.stringify(c.args ?? null)}`;
      if (!seen.has(k)) {
        seen.add(k);
        calls.push(c);
      }
    }
  }
  const contamination = checkToolCalls(calls, {
    workspace,
    repoRoot: opts.repoRoot,
    taskDir: meta.taskDir,
    homeDir: os.homedir(),
  });
  if (workerCwdIssues) {
    contamination.flags.push({ severity: "warning", kind: "worker-cwd", tool: "session", origin: "pi-sessions", detail: `${workerCwdIssues} saved session(s) ran outside the workspace` });
    contamination.warnings++;
  }
  if (contamination.critical) flags.push(`CONTAMINATION(${contamination.critical})`);
  if (contamination.warnings) flags.push(`OUTSIDE_WORKSPACE(${contamination.warnings})`);

  // --- status flags
  // Pi exits 0 in JSON mode even when the model call failed: the final assistant stopReason decides.
  let status: string = meta.status ?? "unknown";
  const lastStop = usage?.agent.lastStopReason;
  if (status === "ok" && lastStop && ["error", "aborted", "length"].includes(lastStop)) status = "agent_error";
  const errorMessage: string | null = meta.agentErrorMessage ?? (usage?.agent.lastErrorMessage ? String(usage.agent.lastErrorMessage).slice(0, 500) : null);
  // Only exclude runs that measured nothing about the mode. A model that overflows its context or cuts off its
  // own output (agent_error) or crashes Pi (nonzero_exit) keeps its graded score, so failures can't flatter a mode.
  const failed =
    ["spawn_error", "setup_failed", "runner_error", "unknown", "running"].includes(status) ||
    (status === "agent_error" && isBillingError(errorMessage));
  const failureReason = !failed
    ? null
    : status === "agent_error"
      ? `model call ended with stopReason "${lastStop ?? "?"}"${errorMessage ? `: ${errorMessage.slice(0, 160)}` : ""}`
      : status === "setup_failed"
        ? String(meta.error ?? "workspace setup failed")
        : status === "runner_error"
          ? String(meta.runnerError ?? "runner error").split(/\r?\n/)[0]
          : status === "nonzero_exit"
            ? `Pi exited with code ${meta.exitCode}`
            : status === "spawn_error"
              ? `Pi could not start: ${meta.spawnError ?? "?"}`
              : `incomplete run (status ${status})`;
  if (failed) flags.push("FAILED_RUN");
  if (meta.timedOut) flags.push("TIMEOUT");
  if (status === "setup_failed") flags.push("SETUP_FAILED");
  if (status === "spawn_error") flags.push("SPAWN_ERROR");
  if (status === "runner_error") flags.push("RUNNER_ERROR");
  if (!meta.timedOut && typeof meta.exitCode === "number" && meta.exitCode !== 0) flags.push(`EXIT_${meta.exitCode}`);
  if (status === "agent_error") flags.push(`AGENT_ERROR(${lastStop ?? "?"})`);
  if (isBillingError(errorMessage)) flags.push("BILLING_ERROR");
  if (usage && !usage.agent.ended && !meta.timedOut && status !== "setup_failed") flags.push("NO_AGENT_END");
  if ((meta.setup?.ancestorContextFiles ?? []).length) flags.push("CONTEXT_FILES_IN_ANCESTORS");

  // --- grade
  const total = typeof grade?.total === "number" ? grade.total : 0;
  const tests = {
    passed: typeof grade?.passed === "number" ? grade.passed : 0,
    failed: typeof grade?.failed === "number" ? grade.failed : 0,
    total,
    graded: !!grade && total > 0,
    error: grade?.error ? String(grade.error) : grade ? null : meta.grade?.error ?? "no grade.json",
  };
  if (!tests.graded || tests.error) flags.push("GRADE_ERROR");

  // --- models
  const configuredLead = meta?.models?.lead ? normalizeModelId(meta.models.lead) : null;
  const leadSeen = usage?.lead.modelsSeen ?? [];
  const providersSeen = usage?.lead.providersSeen ?? [];
  let mismatch = configuredLead !== null && leadSeen.some((m) => m !== configuredLead);
  const workerServed: Record<string, string[]> = {};
  let workerErrors = 0;
  for (const w of usage?.workers ?? []) {
    workerServed[w.agent] = [...new Set([...(workerServed[w.agent] ?? []), ...w.servedModels])];
    // message.model on the worker's own responses must be the configured model (responseModel variants are informational).
    const expectedW = normalizeModelId(w.model);
    const msgModels = w.servedModels.filter((m) => !m.includes(":") && m.split("/").length === 2);
    if (w.modelSource === "event" && msgModels.length && !msgModels.includes(expectedW)) mismatch = true;
    if ((typeof w.exitCode === "number" && w.exitCode !== 0) || (w.stopReason && ["error", "aborted"].includes(w.stopReason))) workerErrors++;
    const expected = workerModels[w.agent];
    if (expected && w.modelSource === "event" && normalizeModelId(w.model) !== normalizeModelId(expected)) mismatch = true;
  }
  if (mismatch) flags.push("MODEL_MISMATCH");
  if (usage?.workerOverrides.length) flags.push(`WORKER_MODEL_OVERRIDE(${usage.workerOverrides.length})`);
  if (workerErrors) flags.push(`WORKER_ERRORS(${workerErrors})`);
  if (providersSeen.some((p) => p !== "openrouter")) flags.push("NON_OPENROUTER_PROVIDER");
  const stderr = readText(path.join(runDir, "stderr.log")) ?? "";
  if (/Using custom model id/i.test(stderr)) {
    flags.push("PI_FALLBACK_MODEL");
    notes.push("Pi did not know a model id and cloned another model's metadata (stderr: 'Using custom model id'); Pi's own cost fields are not trustworthy for it.");
  }
  if (usage && usage.totals.unpricedModels.length) flags.push(`UNPRICED(${usage.totals.unpricedModels.join(",")})`);
  if (usage && usage.subagentCalls.incomplete) flags.push("INCOMPLETE_USAGE");
  const delegating = Object.keys(workerModels).length > 0 || meta.mode === opts.harnessMode;
  if (delegating && usage && usage.workers.length === 0 && !failed && status !== "setup_failed") flags.push("NO_DELEGATION");

  // --- served-model check (generations.json written by the runner from OpenRouter /generation)
  const gen: any = readJsonIfExists(path.join(runDir, "generations.json"));
  let servedCheck: RunRecord["servedCheck"] = null;
  if (gen && Array.isArray(gen.entries)) {
    servedCheck = { checked: gen.entries.length, verified: 0, unverifiable: 0, errors: 0, mismatches: [], byRole: {} };
    for (const e of gen.entries) {
      const role = String(e.role);
      const br = (servedCheck.byRole[role] ??= { configured: String(e.configuredModel), served: [], providers: [], verified: 0, unverifiable: 0 });
      if (!e.verifiable) {
        servedCheck.unverifiable++;
        br.unverifiable++;
        continue;
      }
      if (e.error || !e.model) {
        servedCheck.errors++;
        continue;
      }
      servedCheck.verified++;
      br.verified++;
      if (!br.served.includes(e.model)) br.served.push(e.model);
      if (e.provider && !br.providers.includes(e.provider)) br.providers.push(e.provider);
      if (!servedMatches(normalizeModelId(e.configuredModel), String(e.model))) servedCheck.mismatches.push({ role, configured: e.configuredModel, served: e.model });
    }
    if (servedCheck.mismatches.length) flags.push(`SERVED_MODEL_MISMATCH(${servedCheck.mismatches.length})`);
  }
  if (usage && usage.agent.compactions > 0 && !usage.buckets.some((b) => b.role.endsWith(":compaction"))) flags.push(`COMPACTION_UNCOUNTED(${usage.agent.compactions})`);

  // --- cost
  const ku = meta.keyUsage ?? {};
  const before = ku.before?.usage;
  const after = ku.after?.usage;
  const keyDeltaUsd = ku.enabled && typeof before === "number" && typeof after === "number" ? after - before : null;
  const keyLateUsd = typeof ku.lateUsd === "number" ? ku.lateUsd : 0;
  const eventPricedUsd = usage ? usage.totals.pricedCostUsd : null;
  const piReportedUsd = usage ? usage.totals.piCostUsd : 0;
  let ofRecordUsd: number | null;
  let source: RunRecord["cost"]["source"];
  if (keyDeltaUsd !== null) {
    ofRecordUsd = keyDeltaUsd + keyLateUsd;
    source = "openrouter-key-delta";
  } else if (eventPricedUsd !== null) {
    ofRecordUsd = eventPricedUsd;
    source = "events-estimate";
  } else {
    ofRecordUsd = null;
    source = "none";
  }
  if (!ku.enabled) flags.push("NO_KEY_COST");
  else {
    if (keyDeltaUsd === null) flags.push("KEY_USAGE_UNAVAILABLE");
    if (ku.before && ku.before.stable === false) flags.push("KEY_USAGE_UNSTABLE");
    if (ku.after && ku.after.stable === false) flags.push("KEY_USAGE_UNSTABLE");
    if (keyLateUsd > 0) flags.push(`KEY_LATE_USAGE(+$${keyLateUsd.toFixed(4)})`);
    const byokB = ku.before?.byokUsage;
    const byokA = ku.after?.byokUsage;
    if (typeof byokB === "number" && typeof byokA === "number" && byokA - byokB > 0) flags.push("BYOK_USAGE");
  }
  let disagreement: number | null = null;
  if (source === "openrouter-key-delta" && ofRecordUsd !== null && eventPricedUsd !== null) {
    if (ofRecordUsd > 0) disagreement = (eventPricedUsd - ofRecordUsd) / ofRecordUsd;
    else if (eventPricedUsd > 0.001) disagreement = Infinity;
    if (disagreement !== null && Math.abs(disagreement) > opts.threshold) {
      flags.push(Number.isFinite(disagreement) ? `COST_DISAGREE(${disagreement > 0 ? "+" : ""}${Math.round(disagreement * 100)}%)` : "COST_DISAGREE(key $0)");
    }
  }

  const byRole: RoleCost[] = (usage?.buckets ?? []).map((b) => ({
    role: b.role,
    model: b.model,
    input: b.input,
    output: b.output,
    cacheRead: b.cacheRead,
    cacheWrite: b.cacheWrite,
    requests: b.requests,
    costUsd: b.pricedCostUsd === null ? null : round(b.pricedCostUsd, 6),
    piCostUsd: round(b.piCostUsd, 6),
    pricing: b.pricing,
  }));

  const diffText = readText(path.join(runDir, "diffstat.txt"));
  const diffSummary = diffText ? (diffText.trim().split(/\r?\n/).pop() ?? "").trim() : null;

  return {
    task: meta.task ?? path.basename(path.dirname(runDir)),
    mode: meta.mode ?? path.basename(runDir).replace(/-\d+$/, ""),
    run: meta.run ?? Number(/-(\d+)$/.exec(path.basename(runDir))?.[1] ?? 0),
    runId: path.basename(runDir),
    dir: runDir,
    status,
    failed,
    failureReason,
    errorMessage,
    timedOut: !!meta.timedOut,
    exitCode: typeof meta.exitCode === "number" ? meta.exitCode : null,
    startedAt: meta.startedAt ?? null,
    wallMs: typeof meta.wallMs === "number" ? meta.wallMs : null,
    tests,
    cost: {
      ofRecordUsd: ofRecordUsd === null ? null : round(ofRecordUsd, 6),
      source,
      keyDeltaUsd: keyDeltaUsd === null ? null : round(keyDeltaUsd, 6),
      keyLateUsd: round(keyLateUsd, 6),
      eventPricedUsd: eventPricedUsd === null ? null : round(eventPricedUsd, 6),
      piReportedUsd: round(piReportedUsd, 6),
      disagreement: disagreement === null ? null : Number.isFinite(disagreement) ? round(disagreement, 4) : null,
    },
    tokens: {
      input: usage?.totals.input ?? 0,
      output: usage?.totals.output ?? 0,
      cacheRead: usage?.totals.cacheRead ?? 0,
      cacheWrite: usage?.totals.cacheWrite ?? 0,
      requests: usage?.totals.requests ?? 0,
    },
    byRole,
    models: { configuredLead, leadSeen, leadResponseModels: usage?.lead.responseModelsSeen ?? [], providersSeen, workers: workerModels, workerServed },
    delegation: {
      package: usage?.subagentPackage ?? null,
      calls: usage?.subagentCalls.started ?? 0,
      incomplete: usage?.subagentCalls.incomplete ?? 0,
      workerResults: usage?.workers.length ?? 0,
    },
    flags,
    contamination,
    diffstat: diffSummary,
    servedCheck,
    notes: [...new Set(notes)],
  };
}
