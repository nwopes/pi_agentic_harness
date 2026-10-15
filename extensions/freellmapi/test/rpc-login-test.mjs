#!/usr/bin/env node
// Clicks through the interactive /login-with-freellm flow via Pi's RPC mode, against mock-freellmapi.mjs,
// answering each dialog the way a user would. Spends nothing: the mock serves all model calls.
//
//   node rpc-login-test.mjs <pi-node> <pi-cli>
//
// Needs the mock running on 127.0.0.1:3901 (one of the ports the command probes):
//   node mock-freellmapi.mjs 3901
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [piNode, piCli] = process.argv.slice(2);
if (!piNode || !piCli) {
  console.error("usage: node rpc-login-test.mjs <pi-node> <pi-cli>");
  process.exit(2);
}
const extension = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
const SERVER = "http://127.0.0.1:3901";
const UNIFIED_KEY = "freellmapi-" + "ab".repeat(24);

// Each answer: [method, title regex, response]. A dialog with no matching answer is cancelled and fails the test.
const scenarios = {
  "password login creates a Pi key": {
    answers: [
      ["select", /FreeLLMAPI server/, { value: `${SERVER}  (running)` }],
      ["select", /How do you want to sign in/, { pick: /email and password/ }],
      ["input", /email/i, { value: "me@example.com" }],
      ["input", /password/i, { value: "hunter22" }],
      ["select", /Switch to which/, { value: "auto:smart" }],
    ],
    expect: (r) => r.saved?.apiKey?.startsWith("sk-cp-") && r.model === "freellmapi/auto:smart" && r.notes.some((n) => /Now using freellmapi\/auto:smart/.test(n)),
  },
  "pasted unified key, non-default model": {
    answers: [
      ["select", /FreeLLMAPI server/, { value: `${SERVER}  (running)` }],
      ["select", /How do you want to sign in/, { pick: /Paste an API key/ }],
      ["input", /API key/, { value: UNIFIED_KEY }],
      ["select", /Switch to which/, { value: "auto:coding" }],
    ],
    expect: (r) => r.saved?.apiKey === UNIFIED_KEY && r.model === "freellmapi/auto:coding",
  },
  "wrong password is reported, nothing saved": {
    answers: [
      ["select", /FreeLLMAPI server/, { value: `${SERVER}  (running)` }],
      ["select", /How do you want to sign in/, { pick: /email and password/ }],
      ["input", /email/i, { value: "me@example.com" }],
      ["input", /password/i, { value: "wrong-password" }],
    ],
    expect: (r) => !r.saved && r.notes.some((n) => /Wrong email or password/.test(n)),
  },
};

function runScenario(name, { answers }) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-freellm-test-"));
  const child = spawn(piNode, [piCli, "--mode", "rpc", "-e", extension, "--no-skills", "--no-session"], {
    cwd: agentDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      FREELLMAPI_NO_CLIPBOARD: "1",
      // Non-interactive Pi modes exit without any usable model; this dummy key only satisfies that startup check.
      // No model is called before the login switches to freellmapi.
      OPENROUTER_API_KEY: "sk-or-dummy-for-startup-only",
      FREELLMAPI_API_KEY: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const result = { notes: [], unanswered: [], model: undefined, saved: undefined };
  let pending = [...answers];
  let buffer = "";

  return new Promise((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const cfg = join(agentDir, "freellmapi.json");
      result.saved = existsSync(cfg) ? JSON.parse(readFileSync(cfg, "utf8")) : undefined;
      // Windows keeps the dir locked while Pi (cwd = agentDir) is alive, so clean up after it exits.
      child.once("exit", () => {
        rmSync(agentDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        resolve(result);
      });
      child.kill();
    };
    const timer = setTimeout(() => {
      result.notes.push("TIMEOUT");
      finish();
    }, 30_000);

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        const msg = JSON.parse(line);
        if (msg.type === "extension_ui_request") {
          if (msg.method === "notify") {
            result.notes.push(`${msg.notifyType ?? msg.type_ ?? ""} ${msg.message}`.trim());
            if (/Connected to|Wrong email|rejected|failed|Cancelled|No FreeLLMAPI/.test(msg.message)) send({ id: "state", type: "get_state" });
            continue;
          }
          if (!["select", "confirm", "input", "editor"].includes(msg.method)) continue;
          const i = pending.findIndex(([method, title]) => method === msg.method && title.test(msg.title));
          if (i < 0) {
            result.unanswered.push(`${msg.method}: ${msg.title}`);
            send({ type: "extension_ui_response", id: msg.id, cancelled: true });
            continue;
          }
          const [, , answer] = pending.splice(i, 1)[0];
          const value = answer.pick ? msg.options.find((o) => answer.pick.test(o)) : answer.value;
          send({ type: "extension_ui_response", id: msg.id, ...(msg.method === "confirm" ? { confirmed: !!answer.confirmed } : { value }) });
        } else if (msg.type === "response" && msg.command === "get_state") {
          const m = msg.data?.model;
          result.model = m ? `${m.provider}/${m.id}` : undefined;
          finish();
        }
      }
    });
    child.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
    send({ id: "login", type: "prompt", message: "/login-with-freellm" });
  });
}

let failed = 0;
for (const [name, scenario] of Object.entries(scenarios)) {
  const r = await runScenario(name, scenario);
  const ok = scenario.expect(r) && r.unanswered.length === 0;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  console.log(`      model=${r.model ?? "-"} saved=${r.saved ? `${r.saved.baseUrl} key ${r.saved.apiKey.slice(0, 10)}… ${r.saved.models.length} models` : "no"}`);
  for (const n of r.notes) console.log(`      notify: ${n}`);
  for (const u of r.unanswered) console.log(`      UNANSWERED ${u}`);
}
console.log(failed ? `${failed} scenario(s) failed` : "ALL PASSED");
process.exit(failed ? 1 : 0);
