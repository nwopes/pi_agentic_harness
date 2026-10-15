#!/usr/bin/env node
// Offline test for foreman/keys.ts: an OpenRouter key pasted into Pi's prompt is saved to <agentDir>/auth.json and is
// never sent to a model. Drives Pi over RPC; a local stand-in for OpenRouter records each request (including the key
// it carries) and answers HTTP 400, which ends the run. All keys here are fake.
//
//   node foreman/test/rpc-keys-test.mjs <pi-node> <pi-cli>
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [piNode, piCli] = process.argv.slice(2);
if (!piNode || !piCli) {
  console.error("usage: node rpc-keys-test.mjs <pi-node> <pi-cli>");
  process.exit(2);
}
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fakeKey = () => `sk-or-v1-${randomBytes(32).toString("hex")}`;

const requests = [];
const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    // Pi sends anthropic/* OpenRouter models in Anthropic Messages format (key in x-api-key), others with a Bearer token.
    requests.push({ path: req.url, key: String(req.headers["x-api-key"] ?? req.headers.authorization ?? "").replace(/^Bearer\s+/i, "") });
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "offline test stand-in" } }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

function newAgentDir() {
  const dir = mkdtempSync(join(tmpdir(), "foreman-keys-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ enableInstallTelemetry: false, packages: [repo] }, null, 2));
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: `http://127.0.0.1:${port}/api` } } }));
  return dir;
}

/**
 * One Pi RPC session on `agentDir`. A step is a string; a step that is a slash command or contains a key never starts
 * a run, so it is done when Pi answers the RPC call and the extension has notified. `envKey` sets OPENROUTER_API_KEY;
 * by default it is removed, so the only key Pi can find is the one in auth.json.
 */
function session(agentDir, steps, { envKey } = {}) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
  delete env.OPENROUTER_API_KEY;
  if (envKey) env.OPENROUTER_API_KEY = envKey;
  const child = spawn(piNode, [piCli, "--mode", "rpc", "--model", "openrouter/anthropic/claude-haiku-5.5", "--no-skills", "--no-session"], {
    cwd: agentDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = { notes: [], sent: [], stderr: "", exitCode: null };
  let buffer = "";
  let waiting = null;
  child.stderr.on("data", (d) => (out.stderr += d));
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("{")) continue;
      const msg = JSON.parse(line);
      if (msg.type === "extension_ui_request" && msg.method === "notify") out.notes.push(msg.message);
      waiting?.(msg);
    }
  });
  return new Promise((resolveSession) => {
    child.on("exit", (code) => {
      out.exitCode = code;
      resolveSession(out);
    });
    (async () => {
      for (const [i, step] of steps.entries()) {
        const before = requests.length;
        const notesBefore = out.notes.length;
        const noRun = step.startsWith("/") || /sk-or-v\d+-/.test(step);
        await new Promise((r) => {
          let answered = false;
          const finish = () => (waiting = null, r());
          waiting = (msg) => {
            if (msg.type === "response" && msg.id === `step-${i}`) answered = true;
            if (noRun ? answered && out.notes.length > notesBefore : msg.type === "agent_settled") finish();
          };
          child.stdin.write(JSON.stringify({ id: `step-${i}`, type: "prompt", message: step }) + "\n");
          setTimeout(finish, 20_000);
        });
        // Give a request that should NOT happen a moment to show up.
        if (noRun) await new Promise((r) => setTimeout(r, 500));
        out.sent.push(requests.slice(before));
      }
      child.kill();
    })();
  });
}

const savedKey = (dir) => {
  const file = join(dir, "auth.json");
  if (!existsSync(file)) return undefined;
  const entry = JSON.parse(readFileSync(file, "utf8")).openrouter;
  return entry?.type === "api_key" ? entry.key : `(unexpected entry: ${JSON.stringify(Object.keys(entry ?? {}))})`;
};
const mask = (k) => `${k.slice(0, 12)}…${k.slice(-4)}`;
const bearer = (sent) => sent.map((r) => r.key).filter(Boolean);

const results = [];
const check = (ok, name, detail = "") => {
  results.push(!!ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
};

const dir = newAgentDir();
const first = fakeKey();
const second = fakeKey();

// 1. Paste a key on its own, then use it in the same session.
let s = await session(dir, ["/team", first, "hello", "/team", `here is my new key ${second} thanks`]);
check(/OpenRouter key: none yet/.test(s.notes[0] ?? ""), "/team with no key says how to add one", (s.notes[0] ?? "").split("\n").find((l) => l.startsWith("OpenRouter key")) ?? s.notes.join(" | "));
check(s.sent[1].length === 0, "a pasted key is not sent to the model", `${s.sent[1].length} request(s) during that step`);
check(s.notes.some((n) => n.startsWith(`Saved your OpenRouter key ${mask(first)}`)), "Pi confirms the key was saved", s.notes.find((n) => n.startsWith("Saved")) ?? s.notes.join(" | "));
check(bearer(s.sent[2]).every((k) => k === first) && bearer(s.sent[2]).length > 0, "the next prompt in the same session uses the saved key", `keys sent: ${bearer(s.sent[2]).map(mask).join(", ") || "none"}`);
const teamAfter = s.notes.filter((n) => n.startsWith("Foreman team"))[1] ?? "";
check(teamAfter.includes(`OpenRouter key: saved, ${mask(first)}`), "/team shows the saved key, masked", teamAfter.split("\n").find((l) => l.startsWith("OpenRouter key")) ?? "(no /team output)");
check(s.sent[4].length === 0 && savedKey(dir) === second, "a key inside a longer message: message not sent, key saved", `requests: ${s.sent[4].length}, saved: ${savedKey(dir) ? mask(savedKey(dir)) : "none"}`);
check(s.notes.some((n) => n.includes(`replaces the key saved before (${mask(first)})`)), "replacing a key says so");
check(!s.stderr.includes(first) && !s.notes.some((n) => n.includes(first)), "the full key never appears in Pi's output");

// 2. A new Pi process on the same agent dir (what each worker is) finds the key with nothing in the environment.
s = await session(dir, ["hello again"]);
check(bearer(s.sent[0]).length > 0 && bearer(s.sent[0]).every((k) => k === second), "a new process on the same agent dir uses the saved key", `keys sent: ${bearer(s.sent[0]).map(mask).join(", ") || "none"}`);

// 3. Saved key and OPENROUTER_API_KEY both present: /team must name the key Pi really sends.
const envKey = fakeKey();
s = await session(dir, ["/team", "which key?"], { envKey });
const sentKeys = bearer(s.sent[1]);
const teamLine = (s.notes.find((n) => n.startsWith("Foreman team")) ?? "").split("\n").find((l) => l.startsWith("OpenRouter key")) ?? "";
const winner = sentKeys[0] === second ? "saved key" : sentKeys[0] === envKey ? "OPENROUTER_API_KEY" : "neither";
check(sentKeys.length > 0 && teamLine.includes(mask(sentKeys[0])), "with both set, /team reports the key Pi actually sends", `Pi sent the ${winner}; /team says "${teamLine}"`);

// 4. Two keys in one message: nothing sent, nothing changed.
s = await session(dir, [`${fakeKey()} ${fakeKey()}`]);
check(s.sent[0].length === 0 && savedKey(dir) === second, "two keys in one message: not sent, saved key unchanged");

rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
server.close();
const failed = results.filter((r) => !r).length;
console.log(failed ? `${failed} check(s) failed` : `ALL ${results.length} CHECKS PASSED`);
process.exit(failed ? 1 : 0);
