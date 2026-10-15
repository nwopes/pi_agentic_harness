/**
 * OPTIONAL: screenshot each run's finished app for results/index.html.
 *   npm run screenshots -- --task habit-tracker [--only harness-1]
 * Needs Playwright, which is deliberately NOT a dependency:
 *   npm i -D --save-exact playwright@1.63.0 && npx playwright install chromium
 * Without it this prints a note and index.html keeps placeholders.
 * Starts the app from runs/<task>/<run>/workspace (copied before grading, so no hidden tests) in a temp dir,
 * sends the optional seed requests from foreman.config.json, captures, then kills the app's process tree.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type ScreenshotConfig } from "./lib/config.ts";
import { copyDir, removeInside } from "./lib/fsutil.ts";
import { killTree, runProcess } from "./lib/proc.ts";
import { REPO_ROOT, argString, exists, parseArgv, sleep, writeJson } from "./lib/util.ts";
import { generateReport } from "./report.ts";

const DEFAULTS: ScreenshotConfig = {
  install: "npm ci",
  build: "",
  start: "npm run dev",
  url: "http://localhost:5173/",
  readyTimeoutMs: 120000,
  settleMs: 2500,
  viewport: { width: 1280, height: 800 },
  seed: [],
};

async function responds(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function waitForUrl(url: string, timeoutMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await responds(url)) return true;
    await sleep(1000);
  }
  return false;
}

function utcDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
}

/** Send seed requests; {idN} = id of the N-th created object, {today} / {today-N} = UTC dates. */
async function seed(baseUrl: string, steps: NonNullable<ScreenshotConfig["seed"]>): Promise<string[]> {
  const ids: string[] = [];
  const problems: string[] = [];
  const sub = (s: string) =>
    s
      .replace(/\{id(\d+)\}/g, (_, n) => ids[Number(n)] ?? `missing-id-${n}`)
      .replace(/\{today(?:-(\d+))?\}/g, (_, n) => utcDate(-(Number(n ?? 0))));
  for (const step of steps) {
    const url = new URL(sub(step.path), baseUrl).toString();
    try {
      const r = await fetch(url, {
        method: step.method,
        headers: { "content-type": "application/json" },
        ...(step.body !== undefined ? { body: sub(JSON.stringify(step.body)) } : {}),
        signal: AbortSignal.timeout(5000),
      });
      const text = await r.text();
      if (!r.ok) problems.push(`${step.method} ${url} -> ${r.status}`);
      try {
        const j = JSON.parse(text);
        if (j && typeof j.id === "string") ids.push(j.id);
      } catch {
        /* not JSON */
      }
    } catch (e) {
      problems.push(`${step.method} ${url} -> ${(e as Error).message}`);
    }
  }
  return problems;
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  const task = argString(args, "task");
  if (!task) {
    console.error("Usage: npm run screenshots -- --task <name> [--only <mode-n>] [--runs-dir runs] [--results-dir results]");
    process.exit(2);
  }
  const cfg = loadConfig(argString(args, "config"));
  const runsRoot = path.resolve(argString(args, "runs-dir") ?? path.join(REPO_ROOT, "runs"));
  const resultsRoot = path.resolve(argString(args, "results-dir") ?? path.join(REPO_ROOT, "results"));
  const sc: ScreenshotConfig = { ...DEFAULTS, ...(cfg.screenshots?.default ?? {}), ...(cfg.screenshots?.[task] ?? {}) } as ScreenshotConfig;
  const only = argString(args, "only");

  let pw: any;
  try {
    const name = "playwright";
    pw = await import(name);
  } catch {
    console.log("Playwright is not installed; skipping screenshots (index.html shows placeholders).");
    console.log("To enable: npm i -D --save-exact playwright@1.63.0 && npx playwright install chromium");
    if (exists(path.join(runsRoot, task))) await generateReport({ task, runsRoot, resultsRoot, cfg });
    return;
  }
  const chromium = pw.chromium ?? pw.default?.chromium;
  const taskRuns = path.join(runsRoot, task);
  const runIds = fs.readdirSync(taskRuns).filter((d) => exists(path.join(taskRuns, d, "workspace")) && (!only || d === only)).sort();
  const tmpRoot = path.join(os.tmpdir(), "foreman-shots");
  fs.mkdirSync(tmpRoot, { recursive: true });

  for (const runId of runIds) {
    const runDir = path.join(taskRuns, runId);
    const app = path.join(tmpRoot, `${task}-${runId}`);
    const logFile = path.join(runDir, "screenshot.log");
    const info: any = { runId, startedAt: new Date().toISOString(), url: sc.url };
    let server: ReturnType<typeof spawn> | undefined;
    let browser: any;
    try {
      if (await responds(sc.url)) throw new Error(`${sc.url} already answers before the app was started (port busy); refusing to capture the wrong app`);
      removeInside(app, tmpRoot);
      copyDir(path.join(runDir, "workspace"), app, ["node_modules"]);
      let install = sc.install;
      if (/^npm ci\b/.test(install) && !exists(path.join(app, "package-lock.json"))) install = "npm install --no-audit --no-fund";
      const steps = [install, sc.build].filter(Boolean);
      for (const [i, cmd] of steps.entries()) {
        console.log(`${runId}: ${cmd}`);
        const r = await runProcess({ command: cmd, args: [], cwd: app, logFile: `${logFile}.${i}`, timeoutMs: 10 * 60000, shell: true });
        if (r.exitCode !== 0) throw new Error(`"${cmd}" failed (exit ${r.exitCode})`);
      }
      console.log(`${runId}: ${sc.start}`);
      const out = fs.openSync(logFile, "w");
      server = spawn(sc.start, [], { cwd: app, shell: true, stdio: ["ignore", out, out], windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, BROWSER: "none" } });
      if (!(await waitForUrl(sc.url, sc.readyTimeoutMs))) throw new Error(`app did not answer at ${sc.url} within ${sc.readyTimeoutMs} ms`);
      if (sc.seed?.length) {
        const problems = await seed(sc.url, sc.seed);
        info.seedProblems = problems;
        if (problems.length) console.log(`${runId}: seed problems: ${problems.join("; ")}`);
      }
      browser = await chromium.launch();
      const page = await browser.newPage({ viewport: sc.viewport });
      await page.goto(sc.url, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(sc.settleMs);
      await page.screenshot({ path: path.join(runDir, "screenshot.png") });
      info.ok = true;
      console.log(`${runId}: screenshot saved`);
    } catch (e) {
      info.ok = false;
      info.error = (e as Error).message;
      console.log(`${runId}: screenshot failed: ${info.error}`);
    } finally {
      await browser?.close().catch(() => {});
      if (server) killTree(server);
      info.finishedAt = new Date().toISOString();
      writeJson(path.join(runDir, "screenshot.json"), info);
      await sleep(1000);
      try {
        removeInside(app, tmpRoot);
      } catch {
        /* files may still be locked on Windows */
      }
    }
  }
  const out = await generateReport({ task, runsRoot, resultsRoot, cfg });
  console.log(`index regenerated: ${out.indexHtml}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
