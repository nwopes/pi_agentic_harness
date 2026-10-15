import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, exists, readJson } from "./util.ts";

export interface ModeConfig {
  piConfigDir: string;
  model: string;
  /** Role name used for the top-level agent's own usage ("lead" in harness, "solo" otherwise). */
  leadRole?: string;
  /** Directory of worker agent definitions (*.md with `model:` frontmatter). Harness only. */
  workerAgentsDir?: string;
  /** Extra Pi CLI args. Placeholders: {piConfigDir} (absolute mode config dir), {repo} (repo root). */
  extraPiArgs?: string[];
  /** Files (relative to piConfigDir) that must exist before any run, e.g. the installed subagent package. */
  requiredFiles?: string[];
  /** Flags that `pi --help` must list for this mode (proves the extension loaded; with PI_OFFLINE=1 a missing package is skipped silently). */
  requiredHelpFlags?: string[];
}

export interface PiConfig {
  /** Node binary that runs the Pi CLI (Pi >= 0.75 needs Node >= 22.19). null/"" = the runner's own node. */
  node: string | null;
  /** Pi CLI: a .js entry point (run with `node`), an npm .cmd shim, or a name on PATH. */
  cli: string;
  /** Extra environment for every Pi process (e.g. PI_OFFLINE=1, PI_TELEMETRY=0). */
  env: Record<string, string>;
}

export interface ScreenshotConfig {
  install: string;
  build: string;
  start: string;
  url: string;
  readyTimeoutMs: number;
  settleMs: number;
  viewport: { width: number; height: number };
  /** API requests sent after the app is up and before the capture ({idN}, {today}, {today-N} placeholders). */
  seed?: { method: string; path: string; body?: unknown }[];
}

export interface ForemanConfig {
  provider: string;
  pi: PiConfig;
  timeoutMinutes: number;
  gradeTimeoutMinutes: number;
  baselineMode: string;
  harnessMode: string;
  costDisagreementThreshold: number;
  /** Abort before a run if the OpenRouter key limit or account balance has less headroom than this (USD). */
  minHeadroomUsd: number;
  keyUsagePolling: { initialDelayMs: number; intervalMs: number; stableReads: number; maxWaitMs: number };
  modes: Record<string, ModeConfig>;
  /** Modes run when --modes is not given. */
  defaultModes?: string[];
  /** Served-model check via OpenRouter /generation: how many responses per role to look up after each run. */
  servedModelCheck: { maxPerRole: number };
  screenshots?: Record<string, Partial<ScreenshotConfig>>;
  /** Absolute path of the loaded config file (filled in by loadConfig). */
  _path?: string;
}

export function loadConfig(configPath?: string): ForemanConfig {
  const p = path.resolve(configPath ?? path.join(REPO_ROOT, "foreman.config.json"));
  if (!exists(p)) throw new Error(`Config not found: ${p}`);
  const cfg = readJson<ForemanConfig>(p);
  cfg._path = p;
  cfg.provider ??= "openrouter";
  cfg.pi = Object.assign({ node: null, cli: "pi", env: {} }, cfg.pi ?? {}) as PiConfig;
  cfg.timeoutMinutes ??= 30;
  cfg.gradeTimeoutMinutes ??= 15;
  cfg.baselineMode ??= "strong-solo";
  cfg.harnessMode ??= "harness";
  cfg.costDisagreementThreshold ??= 0.15;
  cfg.minHeadroomUsd ??= 5;
  cfg.servedModelCheck = Object.assign({ maxPerRole: 3 }, cfg.servedModelCheck ?? {});
  const defaults = { initialDelayMs: 10000, intervalMs: 5000, stableReads: 3, maxWaitMs: 180000 };
  cfg.keyUsagePolling = Object.assign(defaults, cfg.keyUsagePolling ?? {});
  for (const [name, m] of Object.entries(cfg.modes ?? {})) {
    if (!m.piConfigDir || !m.model) throw new Error(`Mode "${name}" needs piConfigDir and model in ${p}`);
    if (/^__.*__$/.test(m.model)) throw new Error(`Mode "${name}" still has placeholder model "${m.model}" in ${p}`);
  }
  return cfg;
}

/** Substitute {piConfigDir} and {repo} in extra Pi args. */
export function expandPiArgs(args: string[] | undefined, piConfigDir: string): string[] {
  return (args ?? []).map((a) => {
    const placeholder = a.startsWith("{piConfigDir}") || a.startsWith("{repo}");
    const out = a.split("{piConfigDir}").join(piConfigDir).split("{repo}").join(REPO_ROOT);
    return placeholder ? path.normalize(out) : out;
  });
}

/** Resolve a config-relative path (relative paths are relative to the config file's directory). */
export function resolveFromConfig(cfg: ForemanConfig, p: string): string {
  return path.resolve(path.dirname(cfg._path ?? path.join(REPO_ROOT, "x")), p);
}

/** OpenRouter model ids sometimes carry the provider prefix ("openrouter/anthropic/x"); strip it. */
export function normalizeModelId(model: string | undefined | null): string {
  if (!model) return "unknown";
  let m = String(model).trim();
  if (m.toLowerCase().startsWith("openrouter/")) m = m.slice("openrouter/".length);
  return m;
}

export interface WorkerDef {
  name: string;
  model: string | null;
  file: string;
}

/** Tiny YAML-frontmatter reader: only flat `key: value` pairs are needed (name, model). */
export function readFrontmatter(file: string): Record<string, string> {
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    // strip trailing comments and matching quotes
    if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, "");
    v = v.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    out[kv[1]] = v;
  }
  return out;
}

/** Worker definitions (single source of truth for worker models): <agentsDir>/*.md frontmatter. */
export function readWorkerDefs(agentsDir: string | undefined): WorkerDef[] {
  if (!agentsDir || !exists(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir)
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .sort()
    .map((f) => {
      const file = path.join(agentsDir, f);
      const fm = readFrontmatter(file);
      return { name: fm.name || f.replace(/\.md$/i, ""), model: fm.model ? normalizeModelId(fm.model) : null, file };
    });
}
