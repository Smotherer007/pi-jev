/**
 * Output formatting.
 *
 * Two rules drive this file:
 *
 * 1. Anything the model reads is terse. Paths and verdicts, not prose. The
 *    whole point is that a short tool result replaces a long file read.
 * 2. Anything the *user* reads (via /jev) may be a table, because the user
 *    is the one who needs to judge whether the numbers mean anything.
 */

import type {
  AnswerValue,
  LedgerDecision,
} from "./types.ts";
import type { CalibrationReport, LedgerOverview, ReliabilityBin } from "./calibration.ts";

export function pct(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function usd(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

export function ms(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

/** A ten-cell bar for a 0..1 value, used in the reliability table. */
export function bar(value: number, width = 10): string {
  const filled = Math.round(Math.min(1, Math.max(0, value)) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function formatAnswer(answer: AnswerValue): string {
  const confidence = `p=${answer.p.toFixed(2)}`;
  const degraded = answer.degraded ? " (no probability reported)" : "";

  if (answer.type === "noul") {
    return `${answer.value === true ? "yes" : "no"} (${confidence})${degraded}`;
  }
  if (answer.type === "choice") {
    return `${String(answer.value)} (${confidence})${degraded}`;
  }
  return `score ${String(answer.value)} (${confidence})${degraded}`;
}

/* ------------------------------------------------------- triage formatting */

export interface TriageRow {
  key: string;
  preview: string;
  /** Probability that this candidate matters. */
  p: number;
  /** True when it cleared the threshold. */
  keep: boolean;
}

/**
 * The token-saving output. One line per candidate: a bare key, the probability,
 * and enough of the preview to recognise the file. No prose — the caller reads
 * the file if it needs more.
 *
 * In shadow mode every candidate is listed, marked `keep` or `drop`, because the
 * point of shadow mode is that the agent still reads freely while the filter is
 * being measured. In normal mode the rejected rows are omitted entirely, since
 * printing them would spend exactly the tokens the filter just saved.
 */
export function formatTriage(
  rows: readonly TriageRow[],
  options: {
    provider: string;
    latencyMs: number;
    costUsd: number;
    considered: number;
    truncated: boolean;
    shadow: boolean;
    showDropped: boolean;
    decisions: readonly string[];
    degraded: boolean;
  },
): string {
  const lines: string[] = [];
  const keptCount = rows.filter((row) => row.keep).length;

  lines.push(
    `${options.considered} candidates considered → ${keptCount} kept` +
      ` · ${options.provider} · ${ms(options.latencyMs)} · ${usd(options.costUsd)}` +
      (options.shadow ? " · SHADOW (nothing dropped)" : ""),
  );

  if (options.truncated) {
    lines.push("(the candidate list was cut short by the cap — raise maxCandidates if this matters)");
  }
  lines.push("");

  const visible = options.shadow || options.showDropped ? rows : rows.filter((row) => row.keep);

  if (visible.length === 0) {
    lines.push(
      "Nothing cleared the threshold. Lower minConfidence, or ask the question more concretely — a vague question produces probabilities near 0.5 for everything.",
    );
  } else {
    if (options.shadow) {
      lines.push(`All ${rows.length} candidates, ranked (shadow mode — read whatever you need):`);
    } else if (options.showDropped) {
      lines.push(`All ${rows.length} candidates, ranked:`);
    } else {
      lines.push("KEPT (previews only; read the file for more):");
    }

    for (const row of visible) {
      const marker = row.keep ? "keep" : "drop";
      const label = options.shadow || options.showDropped ? ` ${marker}` : "";
      const preview = row.keep ? `  ${firstLine(row.preview)}` : "";
      lines.push(`- [${row.p.toFixed(2)}]${label.padEnd(6)} ${row.key}${preview}`);
    }
  }

  if (options.degraded) {
    lines.push("");
    lines.push(
      "At least one candidate came back without a usable probability, so the ranking is partly positional. Do not trust the threshold in this state.",
    );
  }

  lines.push("");
  lines.push(`decision ${options.decisions.join(", ")}`);
  return lines.join("\n");
}

function firstLine(text: string): string {
  const line = text.split("\n").find((entry) => entry.trim().length > 0) ?? "";
  return line.trim().slice(0, 100);
}

/* ----------------------------------------------------- verification output */

export type ClaimVerdict = "supported" | "unclear" | "refuted";

export function claimVerdict(p: number, supportedAt: number, refutedAt: number): ClaimVerdict {
  if (p >= supportedAt) return "supported";
  if (p <= refutedAt) return "refuted";
  return "unclear";
}

export function formatVerification(
  claims: Array<{ claim: string; p: number; verdict: ClaimVerdict }>,
  options: {
    provider: string;
    latencyMs: number;
    costUsd: number;
    evidenceChars: number;
    shadow: boolean;
    decisionId: string;
    degraded: boolean;
  },
): string {
  const supported = claims.filter((claim) => claim.verdict === "supported").length;
  const refuted = claims.filter((claim) => claim.verdict === "refuted").length;
  const unclear = claims.length - supported - refuted;

  const lines: string[] = [];
  lines.push(
    `${claims.length} claims · ${supported} supported · ${unclear} unclear · ${refuted} refuted` +
      ` · ${options.provider} · ${ms(options.latencyMs)} · ${usd(options.costUsd)}` +
      (options.shadow ? " · SHADOW" : ""),
  );
  lines.push("");

  for (const claim of claims) {
    const marker = claim.verdict === "supported" ? "OK  " : claim.verdict === "refuted" ? "FAIL" : "?   ";
    lines.push(`${marker} [${claim.p.toFixed(2)}] ${claim.claim}`);
  }

  if (refuted > 0) {
    lines.push("");
    lines.push(
      "A claim the evidence refutes is the case worth acting on: either the work is not done, or the claim is worded more strongly than the evidence supports.",
    );
  }
  if (options.degraded) {
    lines.push("");
    lines.push(
      "The provider reported no usable probability for at least one claim, so those probabilities are placeholders. Calibration for this decision is not meaningful.",
    );
  }

  lines.push("");
  lines.push(`decision ${options.decisionId}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------ gate output */

export function formatGate(
  risk: string,
  blastRadius: number | null,
  confidence: number,
  verdict: string,
  rationale: string,
  options: { provider: string; latencyMs: number; costUsd: number; decisionId: string; degraded: boolean },
): string {
  const lines: string[] = [];
  lines.push(`${verdict.toUpperCase()} · risk=${risk}${blastRadius === null ? "" : ` · blast=${blastRadius.toFixed(1)}`} · p=${confidence.toFixed(2)}`);
  if (rationale) lines.push(rationale);
  lines.push(
    `${options.provider} · ${ms(options.latencyMs)} · ${usd(options.costUsd)} · decision ${options.decisionId}`,
  );
  if (options.degraded) {
    lines.push(
      "No usable probability from the provider, so this verdict rests on the risk class alone. Treat it as a hint, not a clearance.",
    );
  }
  return lines.join("\n");
}

/* ----------------------------------------------------------- /jev reports */

export function formatOverview(overview: LedgerOverview): string {
  const lines: string[] = [];
  lines.push("pi-jev ledger");
  lines.push("");

  const usageLines = formatUsage(overview);

  if (overview.decisions === 0) {
    lines.push("No decisions recorded yet.");
    if (usageLines.length > 0) lines.push("", ...usageLines);
    return lines.join("\n");
  }

  const span =
    overview.firstTs && overview.lastTs
      ? `${overview.firstTs.slice(0, 16).replace("T", " ")} → ${overview.lastTs.slice(0, 16).replace("T", " ")}`
      : "unknown";

  lines.push(`decisions        ${overview.decisions}   (${span})`);
  lines.push(`shadow decisions ${overview.shadowDecisions}   (logged, not acted on)`);
  lines.push(`labelled answers ${overview.labels}`);
  lines.push(`shadow misses    ${overview.shadowMisses}   (pi touched something Jev had dropped — heuristic)`);
  lines.push(`input tokens     ${overview.totalInputTokens.toLocaleString("en-US")}`);
  lines.push(`cost             ${usd(overview.totalCostUsd)}`);
  lines.push(`latency          p50 ${ms(overview.latencyP50)} · p95 ${ms(overview.latencyP95)}`);
  lines.push("");

  lines.push("By provider");
  for (const row of overview.byProvider) {
    lines.push(`  ${row.provider.padEnd(14)} ${row.model.padEnd(24)} n=${String(row.n).padEnd(5)} p50=${ms(row.p50).padEnd(8)} ${usd(row.costUsd)}`);
  }
  lines.push("");

  lines.push("By tool");
  for (const row of overview.byTool) {
    lines.push(`  ${row.tool.padEnd(22)} ${row.n}`);
  }

  if (usageLines.length > 0) lines.push("", ...usageLines);

  return lines.join("\n");
}

/**
 * Is the decision layer actually being used? Only printed once there is
 * something to say, so an unused install does not get a table of zeros.
 */
function formatUsage(overview: LedgerOverview): string[] {
  const rows = overview.usage.filter((row) => row.used + row.missed > 0);
  if (rows.length === 0 && overview.hookDecisions === 0) return [];

  const lines = ["Used vs. missed (did the agent reach for it when it applied?)"];
  for (const row of rows) {
    const total = row.used + row.missed;
    lines.push(
      `  ${row.tool.padEnd(14)} used ${String(row.used).padEnd(5)} missed ${String(row.missed).padEnd(5)} coverage ${pct(row.used / total)}`,
    );
  }
  if (overview.hookDecisions > 0) {
    lines.push(`  bash hook      ${overview.hookDecisions} commands judged by the model without being asked`);
  }
  return lines;
}

export function formatCalibration(report: CalibrationReport, scope: string): string {
  const lines: string[] = [];
  lines.push(`Calibration — ${scope}`);
  lines.push("");

  if (report.total === 0) {
    lines.push("No labelled answers in this scope, so there is nothing to measure.");
    lines.push("");
    lines.push("Label a decision with jev_label once you know how it turned out. Until then, any");
    lines.push("statement about how well this works would be a guess, which is exactly what the");
    lines.push("ledger exists to avoid.");
    return lines.join("\n");
  }

  lines.push(`labelled answers ${report.total}`);
  lines.push(`observed accuracy ${pct(report.baseRate, 1)}  (the base rate: what you get by always guessing the majority)`);
  lines.push("");

  if (report.brier !== null) {
    lines.push(`Brier score       ${report.brier.toFixed(4)}   (mean squared error of the probabilities, lower is better)`);
  }
  if (report.baseBrier !== null) {
    lines.push(`baseline Brier    ${report.baseBrier.toFixed(4)}   (predicting the base rate for every answer)`);
  }
  if (report.ece !== null) {
    lines.push(`ECE               ${report.ece.toFixed(4)}   (average gap between claimed confidence and observed accuracy)`);
  }
  if (report.bias !== null) {
    const direction = report.bias > 0.02 ? "overconfident" : report.bias < -0.02 ? "underconfident" : "roughly unbiased";
    lines.push(`bias              ${report.bias >= 0 ? "+" : ""}${report.bias.toFixed(4)}   (${direction})`);
  }
  lines.push("");
  lines.push("Reliability (claimed → observed)");
  lines.push("  bin        n     claimed   observed");
  for (const bin of report.bins) {
    if (bin.n === 0) continue;
    lines.push(
      `  ${binLabel(bin).padEnd(10)} ${String(bin.n).padEnd(5)} ${bar(bin.meanPredicted)} ${pct(bin.meanPredicted, 0).padStart(4)}   ${bar(bin.observedAccuracy)} ${pct(bin.observedAccuracy, 0).padStart(4)}`,
    );
  }
  lines.push("");
  lines.push("Threshold sweep (what acting only above a threshold would buy)");
  lines.push("  threshold   coverage   precision@   below");
  for (const point of report.thresholds) {
    if (point.n === 0) continue;
    lines.push(
      `  ${point.threshold.toFixed(2).padEnd(11)} ${pct(point.coverage, 0).padStart(6)}     ${pct(point.precision, 1).padStart(6)}      ${pct(point.belowAccuracy, 1)}`,
    );
  }
  lines.push("");
  lines.push("precision@ is the accuracy of the answers you would have acted on.");
  lines.push("below is the accuracy of the ones you would have handed over.");

  return lines.join("\n");
}

function binLabel(bin: ReliabilityBin): string {
  return `${bin.from.toFixed(1)}–${bin.to.toFixed(1)}`;
}

/** One line summarising a decision, for `jev_label` prompts and listings. */
export function summarizeDecision(decision: LedgerDecision): string {
  const answers = decision.answers
    .map((answer) => `${answer.id}=${String(answer.value)}@${answer.p.toFixed(2)}`)
    .join(" ");
  return `${decision.id}  ${decision.ts.slice(0, 19).replace("T", " ")}  ${decision.tool.padEnd(14)} ${answers}`;
}
