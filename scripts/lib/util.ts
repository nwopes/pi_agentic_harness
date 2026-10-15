import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root (this file lives in <repo>/scripts/lib). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readJson<T = any>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

export function readJsonIfExists<T = any>(p: string): T | undefined {
  if (!exists(p)) return undefined;
  try {
    return readJson<T>(p);
  } catch {
    return undefined;
  }
}

export function writeJson(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2) + "\n", "utf8");
}

export function writeText(p: string, text: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
}

/** Forward-slash absolute path: safe to hand to Git Bash and to Node on every platform. */
export function toPosixish(p: string): string {
  return path.resolve(p).replace(/\\/g, "/");
}

/** Case-insensitive on Windows; true when `child` equals or is inside `parent`. */
export function isInside(child: string, parent: string): boolean {
  const norm = (p: string) => {
    let r = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
    if (process.platform === "win32") r = r.toLowerCase();
    return r;
  };
  const c = norm(child);
  const pa = norm(parent);
  return c === pa || c.startsWith(pa + "/");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function round(n: number, digits = 6): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  if (n !== 0 && Math.abs(n) < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "n/a";
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "n/a";
  return Math.round(n).toLocaleString("en-US");
}

/** Minimal argv parser: --key value, --key=value, --flag, --no-flag. */
export function parseArgv(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

export function argString(args: Record<string, string | boolean>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

/** Load <repo>/.env (or a given file) into process.env without overriding existing vars. Never prints values. */
export function loadDotEnv(file?: string): { loaded: boolean; file: string } {
  const f = path.resolve(file ?? path.join(REPO_ROOT, ".env"));
  if (!exists(f)) return { loaded: false, file: f };
  try {
    process.loadEnvFile(f);
    return { loaded: true, file: f };
  } catch (e) {
    console.warn(`[foreman] could not parse env file ${f}: ${(e as Error).message}`);
    return { loaded: false, file: f };
  }
}

export function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function stats(xs: number[]): { mean: number | null; min: number | null; max: number | null; n: number } {
  if (!xs.length) return { mean: null, min: null, max: null, n: 0 };
  return { mean: mean(xs), min: Math.min(...xs), max: Math.max(...xs), n: xs.length };
}
