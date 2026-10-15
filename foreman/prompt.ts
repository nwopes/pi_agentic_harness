// Foreman system-prompt edits. Loaded AFTER @mjakl/pi-subagent (package.json "pi.extensions"), because
// pi-subagent replaces the whole prompt string to append its "## Available Subagents" list, and this file has to
// see that result.
//
// Lead mode on:  the lead instructions (LEAD.md) are added in a <lead_mode> section.
// Lead mode off: pi-subagent's list is removed, so the prompt doesn't advertise a tool that is switched off.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isWorker, LEAD_APPLIED_ENTRY, LEAD_FILE, LEAD_TAG, sharedState } from "./shared.ts";

// Starts and ends of the block pi-subagent appends (contract.ts formatAvailableSubagentsPrompt).
const SUBAGENT_LIST = /\n\n## Available Subagents\n\nThe following subagents are available via the `subagent` tool:[\s\S]*?\n- Current delegation stack: [^\n]*\n?/;

export default function foremanPrompt(pi: ExtensionAPI) {
  if (isWorker()) return;
  const lead = readFileSync(LEAD_FILE, "utf8").trim();
  const leadSha256 = createHash("sha256").update(lead).digest("hex");

  pi.on("before_agent_start", async (event) => {
    const options = event.systemPromptOptions;
    if (sharedState().on) {
      // Pi's JSON event log records the base prompt, not extension edits, so leave an auditable record per run.
      pi.appendEntry(LEAD_APPLIED_ENTRY, { leadSha256 });
      // Without an earlier full-prompt override, a section is the composable route (Pi renders it as <lead_mode>…).
      if (options.forceSystemPrompt === undefined) {
        options.sections[LEAD_TAG] = lead;
        return;
      }
      return { systemPrompt: `${event.systemPrompt}\n\n<${LEAD_TAG}>\n${lead}\n</${LEAD_TAG}>\n` };
    }
    delete options.sections[LEAD_TAG];
    if (SUBAGENT_LIST.test(event.systemPrompt)) return { systemPrompt: event.systemPrompt.replace(SUBAGENT_LIST, "\n") };
  });
}
