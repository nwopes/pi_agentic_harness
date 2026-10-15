/**
 * ALL token-usage parsing lives here, because the subagent package may change.
 *
 * Sources (parent Pi `--mode json` stream, events.jsonl):
 *  1. Lead / solo agent: every `message_end` whose message.role === "assistant" carries message.usage =
 *     { input, output, cacheRead, cacheWrite, cacheWrite1h?, reasoning?, totalTokens, cost: {..., total} } plus
 *     message.provider / model / responseModel? / responseId? (Pi docs/message-types.md). `input` excludes cache
 *     reads/writes (pi-ai providers normalise to disjoint counts); `cacheWrite1h` is a SUBSET of `cacheWrite`;
 *     `reasoning` is already inside `output`. turn_end/agent_end repeat the same messages, so only message_end counts.
 *  2. Workers: subagents are separate Pi processes; the parent only sees the delegation tool's result. Per-worker
 *     usage sits in the tool result `details.results[]`:
 *       - @mjakl/pi-subagent 3.1.0 (the package in use): tool "subagent", details = { kind: "pi-subagent", results:
 *         [{ agent, model: "openrouter/<id>" (configured), exitCode, stopReason, usage: { input, output, cacheRead,
 *         cacheWrite, cost, contextTokens, turns }, messages: [child assistant messages with provider/model/
 *         responseModel/responseId/usage] }] } (types.ts; NOTES.md mock run). messages[] is a rolling 5 MB window;
 *         usage totals survive truncation.
 *       - oira666_pi-subagent 0.5.14 (evaluated, not used): tools "subagents"/"resume_subagents"; durable details
 *         { schemaVersion: 3, results: [{ agent, model, usage, subtreeUsageSummary }] } without messages.
 *     The final result is read from `tool_execution_end` result.details or the toolResult `message_end` (same
 *     object; deduplicated by toolCallId). `tool_execution_update` heartbeats are only a fallback for calls that never
 *     finished (timeout), and are then marked partial.
 *  Pi's usage.cost (and the workers' usage.cost) come from Pi's built-in price table; we keep them as "piCostUsd" and
 *  re-price every token with OpenRouter /models prices ("pricedCostUsd").
 */
import { normalizeModelId } from "./config.ts";
import { forEachJsonLine } from "./jsonl.ts";
import type { ModelPricing, PriceSnapshot } from "./openrouter.ts";

export const SUBAGENT_TOOL_NAMES = new Set(["subagent", "subagents", "resume_subagents"]);

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Subset of cacheWrite written with 1-hour retention (priced at input_cache_write_1h when listed). */
  cacheWrite1h?: number;
}

export interface UsageBucket extends Tokens {
  role: string;
  model: string;
  requests: number;
  piCostUsd: number;
  pricedCostUsd: number | null;
  /** per-request: each LLM response priced on its own (long-context overrides applied); aggregate: totals only. */
  pricing: "per-request" | "aggregate" | "unpriced";
  source: string;
}

export interface WorkerCall extends Tokens {
  toolCallId: string;
  toolName: string;
  agent: string;
  name?: string;
  /** Configured model (normalised), from the result or, failing that, the agent's frontmatter. */
  model: string;
  modelSource: "event" | "frontmatter" | "unknown";
  /** Models reported on the worker's own assistant messages (message.model / responseModel). */
  servedModels: string[];
  costUsd: number;
  turns: number;
  exitCode?: number;
  stopReason?: string;
  errorMessage?: string;
  partial: boolean;
  nested: boolean;
  pricing: "per-request" | "aggregate";
}

export interface ToolCall {
  id: string;
  name: string;
  args: any;
  origin: string;
}

export interface UsageReport {
  eventsFile: string;
  lines: number;
  parseErrors: number;
  sessionId?: string;
  sessionCwd?: string;
  subagentPackage: string | null;
  buckets: UsageBucket[];
  totals: Tokens & { requests: number; piCostUsd: number; pricedCostUsd: number | null; unpricedModels: string[] };
  lead: { role: string; modelsSeen: string[]; responseModelsSeen: string[]; providersSeen: string[]; assistantMessages: number };
  workers: WorkerCall[];
  subagentCalls: { started: number; completed: number; incomplete: number };
  /** Delegation calls where the lead passed a per-call model/thinking (overrides the worker's frontmatter). */
  workerOverrides: { toolCallId: string; agent: string; model?: string; thinking?: string }[];
  toolCalls: ToolCall[];
  /** Provider response ids (gen-... / msg_...) per role, for served-model checks via OpenRouter /generation. */
  responses: { role: string; model: string; responseId: string; responseModel?: string }[];
  agent: { ended: boolean; settled: boolean; lastStopReason?: string; lastErrorMessage?: string; retries: number; compactions: number; errorMessages: number };
  notes: string[];
}

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const p = (s: unknown) => {
  const n = typeof s === "string" ? parseFloat(s) : typeof s === "number" ? s : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const tokensOf = (u: any): Tokens => ({
  input: num(u?.input),
  output: num(u?.output),
  cacheRead: num(u?.cacheRead),
  cacheWrite: num(u?.cacheWrite),
  cacheWrite1h: num(u?.cacheWrite1h),
});
const promptTokens = (t: Tokens) => t.input + t.cacheRead + t.cacheWrite;

function effectivePricing(pr: ModelPricing, prompt?: number): ModelPricing {
  if (prompt === undefined || !Array.isArray(pr.overrides)) return pr;
  let best: any;
  for (const o of pr.overrides) {
    if (o.utc_start || o.utc_end) continue; // time-based overrides not modelled
    if (typeof o.min_prompt_tokens === "number" && prompt >= o.min_prompt_tokens) {
      if (!best || o.min_prompt_tokens > best.min_prompt_tokens) best = o;
    }
  }
  return best ? ({ ...pr, ...best } as ModelPricing) : pr;
}

/**
 * USD for a token bundle. cacheRead -> input_cache_read; cacheWrite -> input_cache_write (5-minute rate), with its
 * cacheWrite1h subset at input_cache_write_1h when listed. Missing cache prices fall back to the prompt price.
 * `prompt` (one request's total prompt tokens) enables long-context overrides; leave undefined for aggregates.
 */
export function priceTokens(pr: ModelPricing | undefined, t: Tokens, requests: number, prompt?: number): number | null {
  if (!pr) return null;
  const e = effectivePricing(pr, prompt);
  const inP = p(e.prompt);
  const outP = p(e.completion);
  if (inP === undefined || outP === undefined) return null;
  const readP = p(e.input_cache_read) ?? inP;
  const writeP = p(e.input_cache_write) ?? inP;
  const write1hP = p(e.input_cache_write_1h) ?? writeP;
  const w1h = Math.min(t.cacheWrite1h ?? 0, t.cacheWrite);
  const perRequest = p(e.request) ?? 0;
  let usd = t.input * inP + t.output * outP + t.cacheRead * readP + (t.cacheWrite - w1h) * writeP + w1h * write1hP + requests * perRequest;
  const discount = typeof e.discount === "number" ? e.discount : 0;
  if (discount > 0 && discount < 1) usd *= 1 - discount;
  return usd;
}

export interface ParseOptions {
  eventsFile: string;
  leadRole: string;
  /** Frontmatter models by agent name (pi-config/harness/agents/*.md), normalised. */
  workerModels: Record<string, string | null>;
  prices: PriceSnapshot | null;
}

export async function parseRunUsage(opts: ParseOptions): Promise<UsageReport> {
  const buckets = new Map<string, UsageBucket>();
  const notes: string[] = [];
  const modelsSeen = new Set<string>();
  const responseModelsSeen = new Set<string>();
  const providersSeen = new Set<string>();
  const toolCalls = new Map<string, ToolCall>();
  const finalDetails = new Map<string, { toolName: string; details: any }>();
  const partialDetails = new Map<string, { toolName: string; details: any }>();
  const startedSubagentCalls = new Set<string>();
  const workerOverrides: UsageReport["workerOverrides"] = [];
  const responses: UsageReport["responses"] = [];
  const agentEndMessages: any[] = [];
  let assistantMessages = 0;
  let sessionId: string | undefined;
  let sessionCwd: string | undefined;
  let subagentPackage: string | null = null;
  const agent: UsageReport["agent"] = { ended: false, settled: false, retries: 0, compactions: 0, errorMessages: 0 };
  let lastLeadModel = "unknown";

  const priceOf = (model: string) => opts.prices?.models[model];

  /**
   * Add tokens to the (role, model) bucket. `perRequestPrompt` = this is ONE request with that many prompt tokens
   * (enables long-context overrides). `priceModel` = price with another model id than the bucket's (e.g. a worker
   * message's own model while the row stays keyed on the configured model); falls back to the bucket model's price.
   */
  const addToBucket = (role: string, model: string, t: Tokens, requests: number, piCost: number, source: string, perRequestPrompt?: number, priceModel?: string) => {
    const key = `${role}\u0000${model}`;
    const pr = (priceModel ? priceOf(priceModel) : undefined) ?? priceOf(model);
    const pricing: UsageBucket["pricing"] = !pr ? "unpriced" : perRequestPrompt !== undefined ? "per-request" : "aggregate";
    let b = buckets.get(key);
    if (!b) {
      b = { role, model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, requests: 0, piCostUsd: 0, pricedCostUsd: pr ? 0 : null, pricing, source };
      buckets.set(key, b);
    }
    b.input += t.input;
    b.output += t.output;
    b.cacheRead += t.cacheRead;
    b.cacheWrite += t.cacheWrite;
    b.cacheWrite1h = (b.cacheWrite1h ?? 0) + (t.cacheWrite1h ?? 0);
    b.requests += requests;
    b.piCostUsd += piCost;
    const c = priceTokens(pr, t, requests, perRequestPrompt);
    if (c === null) b.pricedCostUsd = null;
    else if (b.pricedCostUsd !== null) b.pricedCostUsd += c;
    if (b.pricing !== pricing) b.pricing = b.pricing === "unpriced" || pricing === "unpriced" ? "unpriced" : "aggregate";
    if (!b.source.includes(source)) b.source += `; ${source}`;
  };

  const collectToolCalls = (m: any, origin: string) => {
    for (const c of Array.isArray(m?.content) ? m.content : []) {
      if (c?.type === "toolCall" && c.id) {
        const key = `${origin}|${c.id}`;
        if (!toolCalls.has(key)) toolCalls.set(key, { id: c.id, name: c.name, args: c.arguments, origin });
      }
    }
  };

  const recordAssistant = (m: any) => {
    assistantMessages++;
    const model = normalizeModelId(m.model);
    modelsSeen.add(model);
    if (m.responseModel) responseModelsSeen.add(String(m.responseModel));
    if (m.provider) providersSeen.add(String(m.provider));
    lastLeadModel = model;
    if (m.stopReason) agent.lastStopReason = m.stopReason;
    if (m.stopReason === "error") {
      agent.errorMessages++;
      agent.lastErrorMessage = m.errorMessage;
    }
    const t = tokensOf(m.usage);
    addToBucket(opts.leadRole, model, t, 1, num(m.usage?.cost?.total), "pi:message_end(assistant).usage", promptTokens(t));
    collectToolCalls(m, "lead");
    if (m.responseId) responses.push({ role: opts.leadRole, model, responseId: String(m.responseId), ...(m.responseModel ? { responseModel: String(m.responseModel) } : {}) });
  };

  const noteDetails = (toolCallId: string, toolName: string, details: any, partial: boolean) => {
    if (!details || typeof details !== "object") return;
    if (!subagentPackage) {
      if (details.kind === "pi-subagent") subagentPackage = "@mjakl/pi-subagent";
      else if (details.schemaVersion !== undefined || details.usageSummary || toolName !== "subagent") subagentPackage = "oira666_pi-subagent";
      else if (Array.isArray(details.results)) subagentPackage = "unknown (details.results[] present)";
    }
    if (partial) partialDetails.set(toolCallId, { toolName, details });
    else if (!finalDetails.has(toolCallId)) finalDetails.set(toolCallId, { toolName, details });
  };

  const { lines, parseErrors } = await forEachJsonLine(opts.eventsFile, (ev) => {
    switch (ev?.type) {
      case "session":
        sessionId = ev.id;
        sessionCwd = ev.cwd;
        break;
      case "message_end": {
        const m = ev.message;
        if (m?.role === "assistant") recordAssistant(m);
        else if (m?.role === "toolResult") {
          if (SUBAGENT_TOOL_NAMES.has(m.toolName)) noteDetails(m.toolCallId, m.toolName, m.details, false);
          else if (m.usage && typeof m.usage === "object") {
            // "Tool results can contain usage when the tool performed nested model work" (Pi message-types.md).
            const t = tokensOf(m.usage);
            if (promptTokens(t) + t.output > 0) addToBucket(`${opts.leadRole}:tool:${m.toolName}`, "unknown", t, 1, num(m.usage?.cost?.total), "pi:message_end(toolResult).usage");
          }
        }
        break;
      }
      case "tool_execution_start": {
        const key = `lead|${ev.toolCallId}`;
        if (ev.toolCallId && !toolCalls.has(key)) toolCalls.set(key, { id: ev.toolCallId, name: ev.toolName, args: ev.args, origin: "lead" });
        if (SUBAGENT_TOOL_NAMES.has(ev.toolName)) {
          startedSubagentCalls.add(ev.toolCallId);
          const items = Array.isArray(ev.args?.calls) ? ev.args.calls : Array.isArray(ev.args?.tasks) ? ev.args.tasks : [];
          for (const c of items) {
            if (c && (c.model || c.thinking)) workerOverrides.push({ toolCallId: ev.toolCallId, agent: String(c.agent ?? "?"), ...(c.model ? { model: String(c.model) } : {}), ...(c.thinking ? { thinking: String(c.thinking) } : {}) });
          }
        }
        break;
      }
      case "tool_execution_update":
        if (SUBAGENT_TOOL_NAMES.has(ev.toolName)) noteDetails(ev.toolCallId, ev.toolName, ev.partialResult?.details, true);
        break;
      case "tool_execution_end":
        if (SUBAGENT_TOOL_NAMES.has(ev.toolName)) noteDetails(ev.toolCallId, ev.toolName, ev.result?.details, false);
        break;
      case "agent_end":
        agent.ended = true;
        if (Array.isArray(ev.messages)) agentEndMessages.push(...ev.messages);
        break;
      case "agent_settled":
        agent.settled = true;
        break;
      case "auto_retry_start":
        agent.retries++;
        break;
      case "compaction_end":
        agent.compactions++;
        if (ev.result?.usage) {
          const t = tokensOf(ev.result.usage);
          addToBucket(`${opts.leadRole}:compaction`, lastLeadModel, t, 1, num(ev.result.usage?.cost?.total), "pi:compaction_end.result.usage", promptTokens(t));
        }
        break;
    }
  });

  if (assistantMessages === 0 && agentEndMessages.length) {
    notes.push("No assistant message_end events; used agent_end.messages instead.");
    for (const m of agentEndMessages) if (m?.role === "assistant") recordAssistant(m);
  }
  if (agent.compactions > 0 && ![...buckets.keys()].some((k) => k.includes(":compaction"))) {
    notes.push(`${agent.compactions} compaction(s) happened without usage in the events, so the event-derived cost undercounts them.`);
  }

  // ---- Workers
  const workers: WorkerCall[] = [];
  let incomplete = 0;
  let aggregateWorkers = 0;
  const allCallIds = new Set([...startedSubagentCalls, ...finalDetails.keys(), ...partialDetails.keys()]);
  for (const id of allCallIds) {
    let entry: { toolName: string; details: any; partial: boolean } | undefined;
    const fin = finalDetails.get(id);
    if (fin) entry = { ...fin, partial: false };
    else {
      incomplete++;
      const part = partialDetails.get(id);
      if (part) entry = { ...part, partial: true };
    }
    if (!entry) continue;
    const results = Array.isArray(entry.details?.results) ? entry.details.results : [];
    for (const r of results) {
      const agentName = String(r?.agent ?? "worker");
      const t = tokensOf(r?.usage);
      const fm = opts.workerModels[agentName] ?? null;
      const model = r?.model ? normalizeModelId(r.model) : fm ?? "unknown";
      const msgs = (Array.isArray(r?.messages) ? r.messages : []).filter((m: any) => m?.role === "assistant" && m.usage);
      const served = new Set<string>();
      for (const m of msgs) {
        if (m.model) served.add(normalizeModelId(m.model));
        if (m.responseModel) served.add(String(m.responseModel));
        collectToolCalls(m, `worker:${agentName}`);
        if (m.responseId) responses.push({ role: agentName, model, responseId: String(m.responseId), ...(m.responseModel ? { responseModel: String(m.responseModel) } : {}) });
      }
      // Per-request pricing when the captured messages account for every token (no truncation).
      const sum = msgs.reduce((a: Tokens, m: any) => {
        const mt = tokensOf(m.usage);
        return { input: a.input + mt.input, output: a.output + mt.output, cacheRead: a.cacheRead + mt.cacheRead, cacheWrite: a.cacheWrite + mt.cacheWrite };
      }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      const complete = msgs.length > 0 && sum.input === t.input && sum.output === t.output && sum.cacheRead === t.cacheRead && sum.cacheWrite === t.cacheWrite;
      const source = `subagent:${entry.toolName}.details.results[]${complete ? ".messages[].usage" : ".usage"}`;
      if (complete) {
        const totalPi = num(r?.usage?.cost);
        const msgPi = msgs.reduce((a: number, m: any) => a + num(m.usage?.cost?.total), 0);
        for (const m of msgs) {
          const mt = tokensOf(m.usage);
          // Row keyed on the configured model (stable roles); priced with the message's own model when listed.
          const msgModel = m.model ? normalizeModelId(m.model) : model;
          addToBucket(agentName, model, mt, 1, msgPi > 0 ? num(m.usage?.cost?.total) : 0, source, promptTokens(mt), msgModel);
        }
        if (msgPi === 0 && totalPi > 0) buckets.get(`${agentName}\u0000${model}`)!.piCostUsd += totalPi;
      } else {
        aggregateWorkers++;
        addToBucket(agentName, model, t, Math.max(1, num(r?.usage?.turns)), num(r?.usage?.cost), source);
      }
      const w: WorkerCall = {
        toolCallId: id,
        toolName: entry.toolName,
        agent: agentName,
        ...(r?.name ? { name: String(r.name) } : {}),
        model,
        modelSource: r?.model ? "event" : fm ? "frontmatter" : "unknown",
        servedModels: [...served],
        ...t,
        costUsd: num(r?.usage?.cost),
        turns: num(r?.usage?.turns),
        ...(typeof r?.exitCode === "number" ? { exitCode: r.exitCode } : {}),
        ...(r?.stopReason ? { stopReason: String(r.stopReason) } : {}),
        ...(r?.errorMessage ? { errorMessage: String(r.errorMessage).slice(0, 500) } : {}),
        partial: entry.partial,
        nested: false,
        pricing: complete ? "per-request" : "aggregate",
      };
      workers.push(w);
      // oira: subtreeUsageSummary = own + descendants. Attribute any excess to "<agent>>nested".
      const s = r?.subtreeUsageSummary;
      if (s && typeof s === "object") {
        const d = {
          input: Math.max(0, num(s.inputTokens) - t.input),
          output: Math.max(0, num(s.outputTokens) - t.output),
          cacheRead: Math.max(0, num(s.cacheReadTokens) - t.cacheRead),
          cacheWrite: Math.max(0, num(s.cacheWriteTokens) - t.cacheWrite),
        };
        const dCost = Math.max(0, num(s.costUsd) - w.costUsd);
        if (d.input + d.output + d.cacheRead + d.cacheWrite > 0) {
          workers.push({ ...w, agent: `${agentName}>nested`, model: "unknown", modelSource: "unknown", servedModels: [], ...d, cacheWrite1h: 0, costUsd: dCost, turns: Math.max(0, num(s.turns) - w.turns), nested: true });
          addToBucket(`${agentName}>nested`, "unknown", d, 0, dCost, "subagent:subtreeUsageSummary minus own usage");
          notes.push(`Worker ${agentName} launched nested subagents; their tokens are unpriced (model unknown).`);
        }
      }
    }
  }
  if (incomplete) notes.push(`${incomplete} delegation call(s) never returned a final result (timeout/crash); worker usage for them is partial or missing.`);
  if (aggregateWorkers) notes.push(`${aggregateWorkers} worker result(s) had no complete per-message usage, so they are priced from totals (long-context price overrides not applied).`);
  if (workers.length) notes.push("Worker-side context compaction is not reported by the subagent package; the key delta still includes it.");

  const list = [...buckets.values()];
  const totals = list.reduce(
    (a, b) => {
      a.input += b.input;
      a.output += b.output;
      a.cacheRead += b.cacheRead;
      a.cacheWrite += b.cacheWrite;
      a.cacheWrite1h = (a.cacheWrite1h ?? 0) + (b.cacheWrite1h ?? 0);
      a.requests += b.requests;
      a.piCostUsd += b.piCostUsd;
      if (b.pricedCostUsd === null) {
        if (b.input + b.output + b.cacheRead + b.cacheWrite > 0 && !a.unpricedModels.includes(b.model)) a.unpricedModels.push(b.model);
      } else a.pricedCostUsd = (a.pricedCostUsd ?? 0) + b.pricedCostUsd;
      return a;
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, requests: 0, piCostUsd: 0, pricedCostUsd: null as number | null, unpricedModels: [] as string[] },
  );
  if (totals.pricedCostUsd === null && list.length === 0) totals.pricedCostUsd = 0;

  return {
    eventsFile: opts.eventsFile,
    lines,
    parseErrors,
    sessionId,
    sessionCwd,
    subagentPackage,
    buckets: list,
    totals,
    lead: { role: opts.leadRole, modelsSeen: [...modelsSeen], responseModelsSeen: [...responseModelsSeen], providersSeen: [...providersSeen], assistantMessages },
    workers,
    subagentCalls: { started: allCallIds.size, completed: finalDetails.size, incomplete },
    workerOverrides,
    toolCalls: [...toolCalls.values()],
    responses,
    agent,
    notes,
  };
}

/** Tool calls recorded in Pi session JSONL files (e.g. worker sessions, if the subagent package persists them). */
export async function toolCallsFromSessionFile(file: string, origin: string): Promise<{ calls: ToolCall[]; cwd?: string }> {
  const calls: ToolCall[] = [];
  let cwd: string | undefined;
  const visit = (node: any, depth: number) => {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, depth + 1);
      return;
    }
    if (node.type === "toolCall" && typeof node.name === "string") {
      calls.push({ id: String(node.id ?? `${origin}#${calls.length}`), name: node.name, args: node.arguments, origin });
      return;
    }
    for (const k of Object.keys(node)) visit(node[k], depth + 1);
  };
  await forEachJsonLine(file, (rec) => {
    if (rec?.type === "session" && typeof rec.cwd === "string" && !cwd) cwd = rec.cwd;
    if (rec?.type === "message" || rec?.message) visit(rec.message ?? rec, 0);
  });
  return { calls, cwd };
}
