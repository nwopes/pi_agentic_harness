// Foreman system-prompt edits. Loaded AFTER @mjakl/pi-subagent (package.json "pi.extensions"), because
// pi-subagent replaces the whole prompt string to append its "## Available Subagents" list, and this file has to
// see that result.
//
// Lead, lead mode on:  the lead instructions (LEAD.md) are added in a <lead_mode> section.
// Lead, lead mode off: pi-subagent's list is removed, so the prompt doesn't advertise a tool that is switched off.
// Worker allowed sub-workers (workers.ts decides: free model, depth left): SUBLEAD.md is added in <sub_workers>.
// Any other worker: pi-subagent's list is removed (its tool is switched off there).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fillPaths, isWorker, LEAD_APPLIED_ENTRY, LEAD_FILE, LEAD_TAG, PACKAGE_DIR, sharedState } from "./shared.ts";

// Starts and ends of the block pi-subagent appends (contract.ts formatAvailableSubagentsPrompt).
const SUBAGENT_LIST = /\n\n## Available Subagents\n\nThe following subagents are available via the `subagent` tool:[\s\S]*?\n- Current delegation stack: [^\n]*\n?/;
const SUB_TAG = "sub_workers";

/** Add `text` as a <tag> section, or append it to the prompt if an earlier handler already replaced the whole string. */
function addSection(event: BeforeAgentStartEvent, tag: string, text: string) {
  const options = event.systemPromptOptions;
  if (options.forceSystemPrompt === undefined) {
    options.sections[tag] = text;
    return undefined;
  }
  return { systemPrompt: `${event.systemPrompt}\n\n<${tag}>\n${text}\n</${tag}>\n` };
}
const withoutList = (event: BeforeAgentStartEvent) =>
  SUBAGENT_LIST.test(event.systemPrompt) ? { systemPrompt: event.systemPrompt.replace(SUBAGENT_LIST, "\n") } : undefined;

export default function foremanPrompt(pi: ExtensionAPI) {
  if (isWorker()) {
    const sublead = fillPaths(readFileSync(join(PACKAGE_DIR, "SUBLEAD.md"), "utf8").trim());
    pi.on("before_agent_start", async (event) => (sharedState().subWorkers ? addSection(event, SUB_TAG, sublead) : withoutList(event)));
    return;
  }

  const lead = fillPaths(readFileSync(LEAD_FILE, "utf8").trim());
  const leadSha256 = createHash("sha256").update(lead).digest("hex");

  pi.on("before_agent_start", async (event) => {
    if (sharedState().on) {
      // Pi's JSON event log records the base prompt, not extension edits, so leave an auditable record per run.
      pi.appendEntry(LEAD_APPLIED_ENTRY, { leadSha256 });
      return addSection(event, LEAD_TAG, lead);
    }
    delete event.systemPromptOptions.sections[LEAD_TAG];
    return withoutList(event);
  });
}
