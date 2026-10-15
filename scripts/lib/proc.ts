import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { exists } from "./util.ts";

export interface ProcResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  spawnError?: string;
}

export interface ProcOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Text written to stdin, then stdin is closed. If omitted stdin is ignored. */
  stdinText?: string;
  stdoutFile?: string;
  stderrFile?: string;
  /** Write both streams to one file (ignored if stdoutFile/stderrFile given). */
  logFile?: string;
  timeoutMs?: number;
  shell?: boolean;
}

/** Children that must die if the runner is interrupted (Ctrl+C), so nothing keeps spending. */
const activeChildren = new Set<ChildProcess>();
let signalHandlersInstalled = false;

function installSignalHandlers() {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  const handler = (sig: string) => {
    for (const c of activeChildren) killTree(c);
    console.error(`\n[foreman] ${sig}: killed ${activeChildren.size} child process tree(s). Exiting.`);
    process.exit(130);
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

/** Kill a whole process tree. Windows needs taskkill /T /F; POSIX children are spawned detached (own group). */
export function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
}

export function runProcess(opts: ProcOptions): Promise<ProcResult> {
  installSignalHandlers();
  const started = Date.now();
  return new Promise((resolve) => {
    const outPath = opts.stdoutFile ?? opts.logFile;
    const errPath = opts.stderrFile ?? opts.logFile;
    for (const p of [outPath, errPath]) if (p) fs.mkdirSync(path.dirname(p), { recursive: true });
    const outStream = outPath ? fs.createWriteStream(outPath, { flags: "w" }) : undefined;
    const errStream = errPath ? (errPath === outPath ? outStream : fs.createWriteStream(errPath, { flags: "w" })) : undefined;

    let child: ChildProcess;
    try {
      child = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env ?? process.env,
        stdio: [opts.stdinText !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
        shell: opts.shell ?? false,
        windowsHide: true,
        detached: process.platform !== "win32",
      });
    } catch (e) {
      outStream?.end();
      if (errStream && errStream !== outStream) errStream.end();
      resolve({ exitCode: null, signal: null, timedOut: false, durationMs: 0, spawnError: (e as Error).message });
      return;
    }
    activeChildren.add(child);

    let timedOut = false;
    let settled = false;
    let spawnError: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      activeChildren.delete(child);
      const done = () =>
        resolve({ exitCode, signal, timedOut, durationMs: Date.now() - started, ...(spawnError ? { spawnError } : {}) });
      const closeStream = (s?: fs.WriteStream) => new Promise<void>((r) => (s ? s.end(r) : r()));
      Promise.all([closeStream(outStream), errStream !== outStream ? closeStream(errStream) : Promise.resolve()]).then(done, done);
    };

    if (outStream) child.stdout?.pipe(outStream, { end: false });
    else child.stdout?.resume();
    if (errStream) child.stderr?.pipe(errStream, { end: false });
    else child.stderr?.resume();

    child.on("error", (e) => {
      spawnError = e.message;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    if (opts.stdinText !== undefined && child.stdin) {
      child.stdin.on("error", () => {
        /* child may exit before reading stdin */
      });
      child.stdin.end(opts.stdinText, "utf8");
    }

    if (opts.timeoutMs && opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        // If a grandchild keeps the pipes open, don't wait forever.
        forceTimer = setTimeout(() => finish(null, "SIGKILL"), 15000);
      }, opts.timeoutMs);
    }
  });
}

/** Run a short command and capture stdout (for git, version checks...). */
export function capture(command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv, shell = false) {
  const r = spawnSync(command, args, { cwd, env: env ?? process.env, encoding: "utf8", windowsHide: true, shell });
  return { status: r.status, stdout: (r.stdout ?? "").toString(), stderr: (r.stderr ?? "").toString(), error: r.error?.message };
}

/**
 * Resolve Git Bash explicitly. On Windows `bash` on PATH may be WSL's (C:\Windows\System32\bash.exe),
 * which cannot see Windows paths the same way. Override with FOREMAN_BASH.
 */
export function resolveBash(): string {
  const override = process.env.FOREMAN_BASH;
  if (override) {
    if (!exists(override)) throw new Error(`FOREMAN_BASH points to a missing file: ${override}`);
    return override;
  }
  if (process.platform !== "win32") return "bash";
  const candidates: string[] = [];
  const execPath = capture("git", ["--exec-path"], process.cwd()).stdout.trim();
  if (execPath) {
    // e.g. C:/Program Files/Git/mingw64/libexec/git-core -> walk up to C:/Program Files/Git/bin/bash.exe
    let dir = path.resolve(execPath);
    for (let i = 0; i < 5; i++) {
      candidates.push(path.join(dir, "bin", "bash.exe"));
      dir = path.dirname(dir);
    }
  }
  candidates.push(
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  );
  const found = candidates.find((c) => exists(c));
  if (!found) throw new Error("Git Bash not found. Install Git for Windows or set FOREMAN_BASH to bash.exe.");
  return found;
}

export interface ResolvedExecutable {
  command: string;
  prefixArgs: string[];
  shell: boolean;
  /** Human-readable description of how it was resolved. */
  how: string;
}

/**
 * Turn a binary name or path into something spawn() can run without a shell where possible:
 *  - *.js/*.mjs/*.cjs  -> <node> <file>   (node = the given Node binary, else the runner's own)
 *  - Windows npm shim  -> <node.exe next to the shim, else given node, else ours> <the shim's target .js>; else cmd shell
 *  - anything else     -> as is
 */
export function resolveExecutable(bin: string, node?: string | null): ResolvedExecutable {
  if (node && !exists(node)) throw new Error(`Node binary not found: ${node}`);
  if (/\.(m|c)?js$/i.test(bin)) {
    const abs = path.resolve(bin);
    if (!exists(abs)) throw new Error(`Script not found: ${abs}`);
    const n = node || process.execPath;
    return { command: n, prefixArgs: [abs], shell: false, how: `${n} ${abs}` };
  }
  if (process.platform !== "win32") return { command: bin, prefixArgs: [], shell: false, how: bin };

  let candidates: string[] = [];
  if (/[\\/]/.test(bin)) candidates = [path.resolve(bin)];
  else {
    const w = capture("where.exe", [bin], process.cwd());
    candidates = w.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  }
  const cmdShim = candidates.find((c) => /\.cmd$/i.test(c)) ?? (exists(bin + ".cmd") ? bin + ".cmd" : undefined);
  if (cmdShim) {
    const text = fs.readFileSync(cmdShim, "utf8");
    const m = /"%dp0%\\([^"]+?\.(?:m|c)?js)"/i.exec(text);
    if (m) {
      const target = path.join(path.dirname(cmdShim), m[1]);
      // npm shims prefer the node.exe sitting next to them (e.g. an fnm-installed Node).
      const adjacent = path.join(path.dirname(cmdShim), "node.exe");
      const n = exists(adjacent) ? adjacent : node || process.execPath;
      if (exists(target)) return { command: n, prefixArgs: [target], shell: false, how: `${n} ${target} (from ${cmdShim})` };
    }
    return { command: cmdShim, prefixArgs: [], shell: true, how: `${cmdShim} via cmd shell` };
  }
  const exe = candidates.find((c) => /\.exe$/i.test(c));
  if (exe) return { command: exe, prefixArgs: [], shell: false, how: exe };
  throw new Error(`Could not resolve executable "${bin}" on PATH.`);
}

/** npm on Windows is npm.cmd and must go through a shell; arguments here are fixed strings. */
export function npmCommand(): { command: string; shell: boolean } {
  return process.platform === "win32" ? { command: "npm.cmd", shell: true } : { command: "npm", shell: false };
}
