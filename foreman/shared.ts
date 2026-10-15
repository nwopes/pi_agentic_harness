// Helpers shared by orchestrate.ts and prompt.ts. Pi may load each extension file as its own module instance, so
// state that both need lives on globalThis rather than in a module variable.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
export const AGENTS_DIR = join(PACKAGE_DIR, "agents");
export const LEAD_FILE = join(PACKAGE_DIR, "LEAD.md");
/** Session entry that persists the /orchestrate toggle (not sent to the model). */
export const STATE_ENTRY = "foreman-orchestrate";
/** XML tag around the lead instructions in the system prompt. */
export const LEAD_TAG = "lead_mode";
/** Session entry written each time the lead instructions are applied to a run: proof in a headless run's JSON log. */
export const LEAD_APPLIED_ENTRY = "foreman-lead-applied";
/** Frontmatter line marking worker files this package copied into <agentDir>/agents (safe to overwrite). */
export const MANAGED_MARK = "managed-by: pi-foreman";

interface ForemanState {
  on: boolean;
}

export function sharedState(): ForemanState {
  const g = globalThis as Record<symbol, ForemanState | undefined>;
  const key = Symbol.for("pi-foreman.state");
  return (g[key] ??= { on: false });
}

/** True inside a worker process spawned by @mjakl/pi-subagent (it sets PI_SUBAGENT_DEPTH for children). */
export function isWorker(): boolean {
  return Number(process.env.PI_SUBAGENT_DEPTH ?? 0) > 0;
}

export function readFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text.replace(/^﻿/, ""));
  const out: Record<string, string> = {};
  for (const line of m?.[1].split(/\r?\n/) ?? []) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["'](.*)["']$/, "$1");
  }
  return out;
}

export interface Worker {
  name: string;
  description: string;
  model: string;
  file: string;
  /** "package" = this package's definition is in effect; otherwise the path of a user file that overrides it. */
  source: string;
}

const mdFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md")).sort() : []);

/** The package's workers, with any user-written file of the same name in <agentDir>/agents taking precedence. */
export function team(agentDir: string): Worker[] {
  const userDir = join(agentDir, "agents");
  const userByName = new Map<string, { file: string; fm: Record<string, string> }>();
  for (const f of mdFiles(userDir)) {
    const text = readFileSync(join(userDir, f), "utf8");
    if (text.includes(MANAGED_MARK)) continue;
    const fm = readFrontmatter(text);
    if (fm.name) userByName.set(fm.name, { file: join(userDir, f), fm });
  }
  return mdFiles(AGENTS_DIR).map((f) => {
    const fm = readFrontmatter(readFileSync(join(AGENTS_DIR, f), "utf8"));
    const name = fm.name || f.replace(/\.md$/i, "");
    const user = userByName.get(name);
    const eff = user?.fm ?? fm;
    return { name, description: eff.description ?? "", model: eff.model ?? "(lead's model)", file: user?.file ?? join(AGENTS_DIR, f), source: user ? user.file : "package" };
  });
}

/**
 * @mjakl/pi-subagent only discovers workers in <agentDir>/agents (and trusted project dirs) and has no hook for
 * other packages, so copy ours there. Files without MANAGED_MARK were written by the user and are never touched.
 */
export function syncWorkers(agentDir: string): { written: string[]; userOverrides: string[] } {
  const target = join(agentDir, "agents");
  mkdirSync(target, { recursive: true });
  const written: string[] = [];
  const userOverrides: string[] = [];
  for (const f of mdFiles(AGENTS_DIR)) {
    const managed = readFileSync(join(AGENTS_DIR, f), "utf8").replace(/^---\r?\n/, `---\n${MANAGED_MARK}\n`);
    const dst = join(target, f);
    if (existsSync(dst)) {
      const current = readFileSync(dst, "utf8");
      if (!current.includes(MANAGED_MARK)) {
        userOverrides.push(dst);
        continue;
      }
      if (current === managed) continue;
    }
    writeFileSync(dst, managed);
    written.push(dst);
  }
  return { written, userOverrides };
}
