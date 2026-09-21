/**
 * jev_status — what is configured, what is reachable, what the ledger says.
 *
 * This is the tool to reach for when something looks wrong, so it is
 * deliberately noisy: it reports unavailable providers, missing keys and an
 * empty ledger as plain facts rather than raising.
 */

import { Type } from "typebox";

import { configPath, getConfig, maskKey } from "../config.ts";
import { chainHealth } from "../providers/index.ts";
import { ledgerPath, readLedger } from "../ledger.ts";
import { ledgerOverview } from "../calibration.ts";
import { formatOverview } from "../format.ts";

interface StatusParams {
  verbose?: boolean;
}

/**
 * The status report, as a string.
 *
 * Exported separately from the tool so `/jev-providers` can render the same
 * thing without calling a tool's `execute` with arguments it does not declare.
 */
export async function describeStatus(params: StatusParams = {}): Promise<string> {
  const config = getConfig();
  const lines: string[] = [];

  lines.push("pi-jev");
  lines.push("");
  lines.push(`config   ${configPath()}`);
  lines.push(`ledger   ${ledgerPath()}`);
  lines.push(
    `shadow   triage=${config.shadow.triage ? "on" : "off"} verify=${config.shadow.verify ? "on" : "off"} gate=${config.shadow.gate ? "on" : "off"}`,
  );
  lines.push(
    `limits   maxStateChars=${config.limits.maxStateChars} maxKeep=${config.limits.maxKeep} minConfidence=${config.limits.minConfidence} gateTimeoutMs=${config.limits.gateTimeoutMs}`,
  );
  lines.push(`verify   supported ≥ ${config.verify.supportedAt} · refuted ≤ ${config.verify.refutedAt}`);
  lines.push(
    `gate     read_only=${config.gate.read_only} reversible=${config.gate.reversible} destructive=${config.gate.destructive} needs_human=${config.gate.needs_human}`,
  );
  lines.push(
    `hook     bash=${config.hook.bash ? "on" : "off"}${config.hook.bash ? " (the deterministic rules run before every bash call)" : " (the rules are only consulted when jev_gate is called)"}`,
  );
  lines.push("");

  if (config.providers.length === 0) {
    lines.push("Providers: none configured. Add one with jev_setup (kind=jev or kind=ollama).");
    lines.push("The deterministic guard rules in jev_gate work regardless.");
  } else {
    lines.push("Providers (tried in order)");
    const health = await chainHealth();
    for (const [index, row] of health.entries()) {
      const status = row.skipped ? "manual" : row.ok ? "ready" : "DOWN";
      lines.push(
        `  ${index + 1}. ${row.entry.id.padEnd(12)} ${row.entry.kind.padEnd(14)} ${status.padEnd(8)} ${row.detail}`,
      );
      if (row.entry.kind === "jev") {
        lines.push(
          `     key ${maskKey(row.entry.apiKey)} · ${row.entry.baseUrl ?? "(default)"} · ${row.entry.model ?? "jev-latest"}`,
        );
      } else {
        lines.push(`     model ${row.entry.model ?? "(none)"} · ${row.entry.baseUrl ?? "(none)"}`);
      }
    }

    const ready = health.filter((row) => row.ok && !row.skipped).length;
    lines.push("");
    if (ready === 0) {
      lines.push(
        "No provider is reachable right now. Calls that need the model will fail rather than guess — a decision layer that invents an answer is worse than one that admits it cannot answer. jev_gate still decides unambiguous danger locally and asks for confirmation on everything else.",
      );
    } else {
      lines.push(`${ready} provider${ready === 1 ? "" : "s"} ready.`);
    }
  }

  lines.push("");
  lines.push("─".repeat(60));
  lines.push("");

  const entries = readLedger();
  lines.push(formatOverview(ledgerOverview(entries)));

  if (params.verbose) {
    const decisions = entries
      .filter((entry) => entry.kind === "decision")
      .slice(-10)
      .reverse();
    if (decisions.length > 0) {
      lines.push("");
      lines.push("Last decisions");
      for (const decision of decisions) {
        const answers = decision.answers
          .map((a) => `${a.id}=${String(a.value)}@${a.p.toFixed(2)}`)
          .join(" ");
        lines.push(
          `  ${decision.id} ${decision.ts.slice(0, 19).replace("T", " ")} ${decision.tool.padEnd(18)} ${answers}`,
        );
      }
    }
  }

  return lines.join("\n");
}

export const JevStatusTool = {
  name: "jev_status",
  label: "Jev status",
  description:
    "Show the pi-jev configuration, provider reachability and ledger statistics (decisions, cost, latency, labels, shadow misses). Use it to diagnose why a jev_* call is not working.",
  promptSnippet: "Show pi-jev configuration, provider health and ledger statistics",
  promptGuidelines: [
    "Use jev_status before jev_setup when a jev_* tool fails, to see whether the problem is configuration, reachability or the question itself.",
  ],
  parameters: Type.Object({
    verbose: Type.Optional(Type.Boolean({ description: "Also list the last 10 decisions with their answers" })),
  }),
  async execute(_toolCallId: string, params: StatusParams) {
    const text = await describeStatus(params);
    const config = getConfig();

    return {
      content: [{ type: "text" as const, text }],
      details: {
        providers: config.providers.length,
        decisions: ledgerOverview(readLedger()).decisions,
      },
    };
  },
};
