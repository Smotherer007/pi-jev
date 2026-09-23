/**
 * /jev-label — attach ground truth to a recorded decision.
 *
 * Nothing can label a decision automatically. Whether a classification was
 * right, whether a kept file mattered, whether a gated command turned out to
 * be fine: that is knowledge that arrives later, and it is the user's. So this
 * is a command, not a tool — an agent grading its own decision model is not
 * ground truth.
 *
 * The least glamorous part of the package and the only one that makes the
 * rest falsifiable.
 */

import { readLedger, recordLabel } from "../ledger.ts";
import { summarizeDecision } from "../format.ts";
import type { LedgerDecision } from "../types.ts";

export interface LabelParams {
  decisionId: string;
  questionId?: string;
  correct: boolean;
  note?: string;
}

export const LABEL_USAGE = [
  "Usage:",
  "  /jev-label [list] [n]                        recent decisions, newest first",
  "  /jev-label <decisionId> ok|wrong [q=<questionId>] [note…]",
].join("\n");

const YES = new Set(["ok", "yes", "true", "right", "correct", "y"]);
const NO = new Set(["wrong", "no", "false", "incorrect", "n"]);

export function parseLabelArgs(args: string): ({ action: "list"; limit: number }) | ({ action: "label" } & LabelParams) {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens[0] === "list") {
    const limit = Number(tokens[1] ?? 15);
    return { action: "list", limit: Number.isFinite(limit) && limit > 0 ? limit : 15 };
  }

  const [decisionId = "", verdict = "", ...rest] = tokens;
  const word = verdict.toLowerCase();
  if (!YES.has(word) && !NO.has(word)) throw new Error(`Say whether ${decisionId} was right: ok or wrong.`);

  let questionId: string | undefined;
  if (rest[0]?.startsWith("q=")) questionId = rest.shift()?.slice(2);
  const note = rest.join(" ").trim();

  return {
    action: "label",
    decisionId,
    correct: YES.has(word),
    ...(questionId ? { questionId } : {}),
    ...(note ? { note } : {}),
  };
}

export function listDecisions(limit = 15): string {
  const decisions = readLedger()
    .filter((entry): entry is LedgerDecision => entry.kind === "decision")
    .slice(-limit)
    .reverse();

  if (decisions.length === 0) return "The ledger is empty, so there is nothing to label yet.";

  const lines = [`Recent decisions (${decisions.length}, newest first)`, ""];
  for (const decision of decisions) {
    lines.push(summarizeDecision(decision));
    lines.push(`    ${decision.purpose}`);
  }
  lines.push("", "Label one with /jev-label <id> ok|wrong [q=<questionId>] [note].");
  return lines.join("\n");
}

/** Record a label. Throws when the decision or question does not exist. */
export function labelDecision(params: LabelParams): string {
  const decisions = readLedger().filter((entry): entry is LedgerDecision => entry.kind === "decision");
  const decision = decisions.find((entry) => entry.id === params.decisionId);
  if (!decision) {
    const recent = decisions.slice(-5).map((entry) => entry.id).join(", ");
    throw new Error(`No decision "${params.decisionId}". Recent ids: ${recent || "none"}`);
  }

  // Default to the only question when none is named — the common case for
  // jev_gate and a single-claim jev_verify.
  const questionId = params.questionId ?? (decision.answers.length === 1 ? decision.answers[0]?.id : undefined);
  if (!questionId) {
    const available = decision.answers.map((answer) => answer.id).join(", ");
    throw new Error(`Decision ${decision.id} has ${decision.answers.length} questions (${available}); name one with q=<id>.`);
  }

  const answer = decision.answers.find((entry) => entry.id === questionId);
  if (!answer) {
    throw new Error(
      `Decision ${decision.id} has no question "${questionId}". Available: ${decision.answers.map((a) => a.id).join(", ")}`,
    );
  }

  recordLabel(decision.id, questionId, params.correct, params.note);

  return (
    `Labelled ${decision.id} / ${questionId}: the answer was ${String(answer.value)} at p=${answer.p.toFixed(2)}, ` +
    `recorded as ${params.correct ? "correct" : "incorrect"}.\n\n` +
    "Run /jev-calibration to see the reliability curve and the threshold sweep. A handful of labels shows whether the " +
    "probabilities mean anything; it is not enough to set a threshold with confidence."
  );
}
