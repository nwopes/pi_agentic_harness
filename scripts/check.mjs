#!/usr/bin/env node
// One command for development: typecheck the extensions against the installed Pi's own types, then run every offline
// test (local stand-ins for OpenRouter and FreeLLMAPI; no network, $0).
//
//   npm run check                 typecheck + all tests
//   npm run typecheck             typecheck only
//
// Pi is found via PI_CLI (and optionally PI_NODE), else `pi` on PATH, else an fnm-installed Node. Pi 1.2 needs
// Node >= 22.19, so the tests run Pi on the Node that ships next to it when there is one.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = ["node_modules", "@earendil-works", "pi-coding-agent"];
const CLI = ["dist", "bundle", "cli.js"];

function findPi() {
  if (process.env.PI_CLI) return { cli: resolve(process.env.PI_CLI), node: process.env.PI_NODE };
  const candidates = [];
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["pi"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    for (const bin of out.split(/\r?\n/).filter(Boolean)) {
      candidates.push(join(dirname(bin), ...PKG)); // Windows npm shims and fnm/nvm installs: <bin dir>/node_modules/...
      try {
        candidates.push(resolve(dirname(realpathSync(bin)), "..", "..")); // POSIX symlink into lib/node_modules/<pkg>/dist/...
      } catch {}
    }
  } catch {}
  const fnmRoots = [process.env.FNM_DIR, process.env.APPDATA && join(process.env.APPDATA, "fnm"), join(homedir(), ".local", "share", "fnm")].filter(Boolean);
  for (const root of fnmRoots) {
    const versions = join(root, "node-versions");
    if (!existsSync(versions)) continue;
    for (const v of readdirSync(versions).sort().reverse()) {
      candidates.push(join(versions, v, "installation", ...PKG), join(versions, v, "installation", "lib", ...PKG));
    }
  }
  for (const pkg of candidates) {
    const cli = join(pkg, ...CLI);
    if (!existsSync(cli)) continue;
    const install = pkg.slice(0, pkg.lastIndexOf("node_modules") - 1);
    const node = [join(install, "node.exe"), join(install, "node"), join(install, "bin", "node")].find(existsSync);
    return { cli, node };
  }
  return undefined;
}

const pi = findPi();
if (!pi) {
  console.error("Could not find Pi. Install it (npm i -g @earendil-works/pi-coding-agent) or set PI_CLI to its dist/bundle/cli.js.");
  process.exit(2);
}
pi.node ??= process.execPath;
const piPkg = resolve(dirname(pi.cli), "..", "..");
const nodeVersion = execFileSync(pi.node, ["--version"], { encoding: "utf8" }).trim();
console.log(`Pi: ${pi.cli}\nNode for Pi: ${pi.node} (${nodeVersion})\n`);

let failed = 0;
const step = (name, ok) => {
  console.log(`${ok ? "OK  " : "FAIL"}  ${name}\n`);
  if (!ok) failed++;
};

// Typecheck: the repo's tsconfig plus a path mapping to the installed Pi's declarations (Pi must not be a dependency).
const tmp = mkdtempSync(join(tmpdir(), "pi-foreman-check-"));
const tsconfig = join(tmp, "tsconfig.json");
writeFileSync(tsconfig, JSON.stringify({
  extends: join(repo, "tsconfig.json"),
  compilerOptions: { typeRoots: [join(repo, "node_modules", "@types")], paths: { "@earendil-works/pi-coding-agent": [join(piPkg, "dist", "index.d.ts")] } },
}));
const tsc = spawnSync(process.execPath, [join(repo, "node_modules", "typescript", "bin", "tsc"), "-p", tsconfig], { cwd: repo, stdio: "inherit" });
rmSync(tmp, { recursive: true, force: true });
step("typecheck foreman/ and extensions/ against Pi's types", tsc.status === 0);
if (process.argv.includes("--types-only")) process.exit(failed ? 1 : 0);

const run = (file) => spawnSync(pi.node, [join(repo, file), pi.node, pi.cli], { cwd: repo, stdio: "inherit" }).status === 0;
for (const file of ["foreman/test/rpc-orchestrate-test.mjs", "foreman/test/rpc-keys-test.mjs", "extensions/freellmapi/test/rpc-workers-test.mjs"]) {
  console.log(`== ${file}`);
  step(file, run(file));
}

// The login test probes fixed ports, so it needs the mock FreeLLMAPI on 3901.
console.log("== extensions/freellmapi/test/rpc-login-test.mjs (mock FreeLLMAPI on 127.0.0.1:3901)");
const mock = spawn(pi.node, [join(repo, "extensions/freellmapi/test/mock-freellmapi.mjs"), "3901"], { stdio: ["ignore", "pipe", "pipe"] });
const listening = await new Promise((r) => {
  mock.stdout.on("data", (d) => String(d).includes("mock FreeLLMAPI on") && r(true));
  mock.on("exit", () => r(false));
  setTimeout(() => r(false), 10_000);
});
if (!listening) console.log("The mock could not start; is something else using port 3901?");
step("extensions/freellmapi/test/rpc-login-test.mjs", listening && run("extensions/freellmapi/test/rpc-login-test.mjs"));
mock.kill();

console.log(failed ? `${failed} step(s) failed` : "ALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
