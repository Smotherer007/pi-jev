/**
 * jev_label — attach ground truth to a recorded decision.
 *
 * Nothing can label a decision automatically. Whether a classification was
 * right, whether a kept file mattered, whether a gated command turned out to
 * be fine: that is knowledge that arrives later, from the user or from a later
 * event. So the honest design is a tool that records it when it is known, and a
 * report that says "no labelled answers yet" until it is.
 *
 * This is the least glamorous tool in the package and the only one that makes
 * the other four falsifiable.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

import { readLedger, recordLabel } from "../ledger.ts";
import { summarizeDecision } from "../format.ts";
import type { LedgerDecision } from "../types.ts";

interface LabelParams {
  action: "list" | "label";
  decisionId?: string;
  questionId?: string;
  correct?: boolean;
  note?: string;
  limit?: number;
}

export const JevLabelTool = {
  name: "jev_label",
  label: "Label a decision",
  description:
    "Attach ground truth to a recorded pi-jev decision so calibration can be computed. Without labels the ledger can report cost and latency but not whether any of it was right. List recent decisions first, then label the ones whose outcome you now know.",
  promptSnippet: "Record whether a past Jev decision turned out to be right",
  promptGuidelines: [
    "Use jev_label when the outcome of a past jev_* decision becomes known — a triage survivor turned out to be irrelevant, a verified claim turned out false, a gated command turned out to have been safe.",
    "Prefer labelling a few decisions in jev_label honestly over labelling many loosely: an optimistic label corrupts the calibration it is meant to measure.",
  ],
  parameters: Type.Object({
    action: StringEnum(["list", "label"] as const),
    decisionId: Type.Optional(Type.String({ description: "For action=label: the decision id, as printed by the jev_* tools" })),
    questionId: Type.Optional(
      Type.String({ description: "For action=label: which question, e.g. \"risk\" or \"claim0\". Omit with a single-question decision." }),
    ),
    correct: Type.Optional(
      Type.Boolean({
        description:
          "For action=label: was the answer the model chose actually right? For a noul, was its yes/no right. For a choice, was the option right.",
      }),
    ),
    note: Type.Optional(Type.String({ description: "Why, in a few words. Useful when reading the ledger back months later." })),
    limit: Type.Optional(Type.Number({ description: "For action=list: how many recent decisions to show (default 15)" })),
  }),
  async execute(_toolCallId: string, params: LabelParams) {
    if (params.action === "list") {
      const limit = params.limit ?? 15;
      const decisions = readLedger()
        .filter((entry): entry is LedgerDecision => entry.kind === "decision")
        .slice(-limit)
        .reverse();

      if (decisions.length === 0) {
        return {
          content: [{ type: "text" as const, text: "The ledger is empty, so there is nothing to label yet." }],
          details: { listed: 0 },
        };
      }

      const lines = [`Recent decisions (${decisions.length} of the newest first)`, ""];
      for (const decision of decisions) {
        lines.push(summarizeDecision(decision));
        lines.push(`    ${decision.purpose}`);
      }
      lines.push("");
      lines.push("Label one with jev_label action=label decisionId=<id> correct=<true|false>.");

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { listed: decisions.length, decisions },
      };
    }

    // action === "label"
    if (!params.decisionId) throw new Error("action=label needs a decisionId. Use action=list to find one.");
    if (params.correct === undefined) throw new Error("action=label needs correct=true or correct=false.");

    const decisions = readLedger().filter((entry): entry is LedgerDecision => entry.kind === "decision");
    const decision = decisions.find((entry) => entry.id === params.decisionId);
    if (!decision) {
      const recent = decisions.slice(-5).map((entry) => entry.id).join(", ");
      throw new Error(`No decision "${params.decisionId}". Recent ids: ${recent || "none"}`);
    }

    // Default to the only question when the caller does not name one — that is
    // the common case for jev_gate and jev_verify with a single claim.
    const questionId = params.questionId ?? (decision.answers.length === 1 ? decision.answers[0]?.id : undefined);
    if (!questionId) {
      const available = decision.answers.map((answer) => answer.id).join(", ");
      throw new Error(
        `Decision ${decision.id} has ${decision.answers.length} questions (${available}); name one with questionId.`,
      );
    }

    const answer = decision.answers.find((entry) => entry.id === questionId);
    if (!answer) {
      throw new Error(
        `Decision ${decision.id} has no question "${questionId}". Available: ${decision.answers.map((a) => a.id).join(", ")}`,
      );
    }

    const label = recordLabel(decision.id, questionId, params.correct, params.note);

    return {
      content: [
        {
          type: "text" as const,
          text:
            `Labelled ${decision.id} / ${questionId}: the answer was ${String(answer.value)} at p=${answer.p.toFixed(2)}, ` +
            `recorded as ${params.correct ? "correct" : "incorrect"}.\n\n` +
            "Run /jev-calibration to see the reliability curve and the threshold sweep. A handful of labels is enough to see whether the probabilities mean anything; it is not enough to set a threshold with confidence.",
        },
      ],
      details: { label, decisionId: decision.id, questionId, correct: params.correct },
    };
  },
};
