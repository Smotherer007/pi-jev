/**
 * /jev — what is configured, what is reachable, what the ledger says.
 *
 * The command to reach for when something looks wrong, so it is deliberately
 * noisy: it reports unavailable providers, missing keys and an empty ledger as
 * plain facts rather than raising.
 */

import { configPath, getConfig, maskKey } from "../config.ts";
import { chainHealth, decisionMemoryStats } from "../providers/index.ts";
import { ledgerPath, readLedger } from "../ledger.ts";
import { ledgerOverview } from "../calibration.ts";
import { formatOverview } from "../format.ts";

export interface StatusParams {
  verbose?: boolean;
}

/**
 * The status report, as a string.
 *
 * `verbose` also lists the last ten decisions with their answers.
 */
export async function describeStatus(params: StatusParams = {}): Promise<string> {
  const config = getConfig();
  const lines: string[] = [];

  lines.push("pi-jev");
  lines.push("");
  lines.push(`config   ${configPath()}`);
  lines.push(`ledger   ${ledgerPath()}`);
  const on = (value: boolean) => (value ? "on" : "off");
  const memory = decisionMemoryStats();
  lines.push(
    `auto     bash rules=${on(config.hook.bash)} · bash model=${config.hook.model} · triage hint=${on(config.hook.triageHint)} · ` +
      `trim=${on(config.hook.trim)} · prune=${on(config.hook.prune)} · prompt=${on(config.hook.prompt)}`,
  );
  lines.push(`shadow   ${Object.entries(config.shadow).map(([name, value]) => `${name}=${on(value)}`).join(" ")}`);
  lines.push(
    `gate     read_only=${config.gate.read_only} reversible=${config.gate.reversible} destructive=${config.gate.destructive} needs_human=${config.gate.needs_human} · deadline ${config.limits.gateTimeoutMs} ms`,
  );
  lines.push(
    `limits   triage keeps p ≥ ${config.limits.minConfidence} · verify supported ≥ ${config.verify.supportedAt}, refuted ≤ ${config.verify.refutedAt}`,
  );
  lines.push(
    `memory   ${memory.cached} cached decisions` +
      (memory.coolingDown.length > 0 ? ` · cooling down: ${memory.coolingDown.join(", ")}` : ""),
  );
  lines.push("");

  if (config.providers.length === 0) {
    lines.push("Providers: none configured. Add one with /jev-setup add jev, or /jev-setup add ollama model=<name>.");
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
