/**
 * OpenRouter endpoints used (verified 2026-10-15 against https://openrouter.ai/openapi.json and
 * https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key):
 *  - GET https://openrouter.ai/api/v1/key    (Bearer key) -> { data: { usage, byok_usage, usage_daily, limit, limit_remaining, ... } }
 *      `usage` = "Total OpenRouter credit usage (in USD) for the API key"  <- cost of record (after - before)
 *      `byok_usage` = external BYOK usage (USD), recorded separately
 *  - GET https://openrouter.ai/api/v1/models (public, no key) -> { data: [{ id, pricing: { prompt, completion,
 *      input_cache_read?, input_cache_write?, input_cache_write_1h?, request?, discount?, overrides? } }] }
 *      Prices are USD per token, as strings.
 */
import { sleep } from "./util.ts";

const BASE = "https://openrouter.ai/api/v1";

export interface KeyRead {
  at: string;
  usage: number | null;
  byokUsage: number | null;
  error?: string;
  /** Lower than the highest value already seen (or than the floor): a stale replica answered. Never accepted. */
  stale?: boolean;
}

export interface KeySnapshot {
  usage: number | null;
  byokUsage: number | null;
  stable: boolean;
  /** Every raw read, in order, for auditing. */
  reads: KeyRead[];
  staleReads: number;
  /** Lower bound used (the previous accepted snapshot), if any. */
  floor: number | null;
  waitedMs: number;
}

export async function readKeyOnce(apiKey: string): Promise<KeyRead> {
  const at = new Date().toISOString();
  try {
    const res = await fetch(`${BASE}/key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { at, usage: null, byokUsage: null, error: `HTTP ${res.status}` };
    const body: any = await res.json();
    const d = body?.data ?? {};
    return {
      at,
      usage: typeof d.usage === "number" ? d.usage : null,
      byokUsage: typeof d.byok_usage === "number" ? d.byok_usage : null,
      ...(typeof d.usage === "number" ? {} : { error: "no numeric data.usage in response" }),
    };
  } catch (e) {
    return { at, usage: null, byokUsage: null, error: (e as Error).message };
  }
}

/**
 * Settle the key's usage. It lags a few seconds behind the last request AND is not monotonic between reads (live
 * log in NOTES.md: 0.00070861 -> 0 -> 0.005857677 -> 0.005857677, a stale replica answering). So:
 *  - a read lower than the highest value seen so far, or lower than `floor` (the previous accepted snapshot),
 *    is marked stale and never accepted;
 *  - a value is accepted once it is the highest seen and has repeated on `stableReads` consecutive non-stale reads;
 *  - otherwise give up after maxWaitMs and return the highest value seen, marked unstable.
 * Every raw read is kept in the result (and so in meta.json).
 */
export async function settleKeyUsage(
  apiKey: string,
  opts: { initialDelayMs: number; intervalMs: number; stableReads: number; maxWaitMs: number },
  log: (s: string) => void = () => {},
  floor: number | null = null,
  readOnce: (key: string) => Promise<KeyRead> = readKeyOnce,
): Promise<KeySnapshot> {
  const start = Date.now();
  if (opts.initialDelayMs > 0) await sleep(opts.initialDelayMs);
  const reads: KeyRead[] = [];
  let max = floor ?? -Infinity;
  let maxByok: number | null = null;
  let streak = 0;
  let staleReads = 0;
  for (;;) {
    const r = await readOnce(apiKey);
    reads.push(r);
    if (r.usage !== null) {
      if (r.usage < max - 1e-12) {
        r.stale = true;
        staleReads++;
      } else if (r.usage > max + 1e-12) {
        max = r.usage;
        maxByok = r.byokUsage;
        streak = 1;
      } else {
        if (maxByok === null) maxByok = r.byokUsage;
        streak++;
      }
    }
    if (streak >= opts.stableReads) {
      return { usage: max, byokUsage: maxByok, stable: true, reads, staleReads, floor, waitedMs: Date.now() - start };
    }
    if (Date.now() - start > opts.maxWaitMs) {
      const seen = reads.some((x) => x.usage !== null);
      log(`key usage did not stabilise within ${opts.maxWaitMs} ms (${reads.length} reads, ${staleReads} stale)`);
      return { usage: seen && Number.isFinite(max) ? max : null, byokUsage: maxByok, stable: false, reads, staleReads, floor, waitedMs: Date.now() - start };
    }
    await sleep(opts.intervalMs);
  }
}

export interface GenerationInfo {
  responseId: string;
  verifiable: boolean;
  model?: string;
  provider?: string | null;
  totalCostUsd?: number;
  error?: string;
}

/**
 * GET /api/v1/generation?id=<gen-...> -> data.model (dated served id, e.g. minimax/minimax-m3-20260531),
 * data.provider_name, data.total_cost. Only `gen-` ids are valid (OpenAPI pattern ^gen-[0-9A-Za-z-]+$);
 * the Anthropic-style `msg_...` ids of Opus/Haiku responses return 400, so they are "unverifiable via API".
 */
export async function fetchGeneration(apiKey: string, responseId: string): Promise<GenerationInfo> {
  if (!/^gen-[0-9A-Za-z-]+$/.test(responseId)) return { responseId, verifiable: false, error: "unverifiable via API (not a gen- id)" };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}/generation?id=${encodeURIComponent(responseId)}`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20000) });
      if (r.status === 404 && attempt < 2) {
        await sleep(3000); // generation stats can appear a little after the response
        continue;
      }
      if (!r.ok) return { responseId, verifiable: true, error: `HTTP ${r.status}` };
      const d: any = ((await r.json()) as any)?.data ?? {};
      return { responseId, verifiable: true, model: d.model, provider: d.provider_name ?? null, totalCostUsd: typeof d.total_cost === "number" ? d.total_cost : undefined };
    } catch (e) {
      if (attempt === 2) return { responseId, verifiable: true, error: (e as Error).message };
    }
  }
  return { responseId, verifiable: true, error: "not found" };
}

/** Served id matches configured id exactly or with a dated suffix (minimax/minimax-m3 -> minimax/minimax-m3-20260531). */
export function servedMatches(configured: string, served: string): boolean {
  const c = configured.toLowerCase();
  const s = served.toLowerCase();
  return s === c || (s.startsWith(c + "-") && /^-\d{4,}/.test(s.slice(c.length)));
}

export interface Budget {
  at: string;
  /** Key spending limit left (USD); null = the key has no limit. */
  keyLimitRemaining: number | null;
  keyLimit: number | null;
  /** Account balance: /credits total_credits - total_usage (USD); null if unavailable. */
  accountRemaining: number | null;
  keyError?: string;
  accountError?: string;
}

/**
 * Spending headroom. OpenRouter reserves max_tokens x output price before each request (NOTES.md live log: a 402
 * "can only afford N tokens" ended a run in 2.6 s with exit code 0), so we check BOTH limits before every run.
 *  - GET /api/v1/key     data.limit_remaining ("Remaining spending limit in USD", null = no limit)
 *  - GET /api/v1/credits data.total_credits - data.total_usage (docs say a management key is required; it answered
 *    200 for a normal key in this project — if it fails we report "unknown" instead of guessing)
 */
export async function readBudget(apiKey: string): Promise<Budget> {
  const at = new Date().toISOString();
  const out: Budget = { at, keyLimitRemaining: null, keyLimit: null, accountRemaining: null };
  try {
    const r = await fetch(`${BASE}/key`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) out.keyError = `GET /key HTTP ${r.status}`;
    else {
      const d: any = ((await r.json()) as any)?.data ?? {};
      out.keyLimit = typeof d.limit === "number" ? d.limit : null;
      out.keyLimitRemaining = typeof d.limit_remaining === "number" ? d.limit_remaining : null;
    }
  } catch (e) {
    out.keyError = (e as Error).message;
  }
  try {
    const r = await fetch(`${BASE}/credits`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) out.accountError = `GET /credits HTTP ${r.status}`;
    else {
      const d: any = ((await r.json()) as any)?.data ?? {};
      if (typeof d.total_credits === "number" && typeof d.total_usage === "number") out.accountRemaining = d.total_credits - d.total_usage;
      else out.accountError = "no numeric total_credits/total_usage";
    }
  } catch (e) {
    out.accountError = (e as Error).message;
  }
  return out;
}

/** Problems that must stop a run before it starts (empty = OK). */
export function budgetProblems(b: Budget, minHeadroomUsd: number): string[] {
  const out: string[] = [];
  if (b.keyError) out.push(`could not read the key limit (${b.keyError})`);
  if (b.keyLimitRemaining !== null && b.keyLimitRemaining < minHeadroomUsd)
    out.push(`OpenRouter KEY limit is short: limit_remaining $${b.keyLimitRemaining.toFixed(2)} (limit $${b.keyLimit ?? "?"}) < minHeadroomUsd $${minHeadroomUsd}. Raise the key's limit in OpenRouter settings.`);
  if (b.accountRemaining !== null && b.accountRemaining < minHeadroomUsd)
    out.push(`OpenRouter ACCOUNT balance is short: total_credits - total_usage = $${b.accountRemaining.toFixed(2)} < minHeadroomUsd $${minHeadroomUsd}. Add credits.`);
  return out;
}

/** OpenRouter billing / credit errors as they surface in Pi's assistant errorMessage. */
export function isBillingError(msg: string | undefined | null): boolean {
  return !!msg && /\b402\b|payment_required|billing|can only afford|insufficient (credits|funds)/i.test(msg);
}

export interface PriceOverride {
  min_prompt_tokens?: number;
  utc_start?: string;
  utc_end?: string;
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  [k: string]: unknown;
}

export interface ModelPricing {
  prompt: string;
  completion: string;
  input_cache_read?: string;
  input_cache_write?: string;
  input_cache_write_1h?: string;
  request?: string;
  discount?: number;
  overrides?: PriceOverride[];
  [k: string]: unknown;
}

export interface PriceSnapshot {
  fetchedAt: string;
  source: string;
  models: Record<string, ModelPricing>;
}

/** Fetch the public model list (no key, no spend). */
export async function fetchAllPrices(): Promise<PriceSnapshot> {
  const res = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`GET /models -> HTTP ${res.status}`);
  const body: any = await res.json();
  const models: Record<string, ModelPricing> = {};
  for (const m of body?.data ?? []) if (m?.id && m?.pricing) models[m.id] = m.pricing;
  return { fetchedAt: new Date().toISOString(), source: `${BASE}/models`, models };
}

export function subsetPrices(all: PriceSnapshot | null, ids: string[]): PriceSnapshot {
  const models: Record<string, ModelPricing> = {};
  if (all) for (const id of ids) if (all.models[id]) models[id] = all.models[id];
  return { fetchedAt: all?.fetchedAt ?? new Date().toISOString(), source: all?.source ?? "unavailable", models };
}
