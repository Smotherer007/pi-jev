/**
 * jev_decide — the raw tool.
 *
 * Everything else in this package is a convenience wrapper around a shape of
 * question that turned out to be common. This is the unconstrained version: you
 * bring the state and the typed questions, and you get calibrated answers back.
 *
 * Worth reaching for when no wrapper fits, and worth *not* reaching for when a
 * wrapper does — a wrapper knows what to put in the ledger, so calibration per
 * use case stays readable.
 */

import { Type } from "typebox";
import { Type as T } from "typebox";

import { getConfig } from "../config.ts";
import { decide } from "../providers/index.ts";
import { normaliseQuestions } from "../questions.ts";
import { formatAnswer } from "../format.ts";
import type { QuestionSpec } from "../types.ts";
import { TUNING } from "../tuning.ts";

interface DecideParams {
  purpose: string;
  state: string;
  stateIsJson?: boolean;
  questions: Array<{
    id?: string;
    type: "noul" | "choice" | "score";
    instructions: string;
    criteria?: Record<string, string>;
  }>;
  provider?: string;
  shadow?: boolean;
}

export const JevDecideTool = {
  name: "jev_decide",
  label: "Ask Jev",
  description:
    "Ask a decision model typed questions about a piece of state and get back answers with calibrated probabilities. Answers are constrained to the options you define, so they cannot be malformed — but a confidently wrong answer is still possible, which is what the probability is for. Cheapest and fastest when many independent questions share one state: ask them all in one call.",
  promptSnippet: "Ask typed questions about state and get answers with probabilities",
  promptGuidelines: [
    "Use jev_decide when you need a bounded judgement about a piece of state — a classification, a routing choice, a yes/no with a probability — rather than generated text.",
    "Ask every independent question you already know you need in ONE jev_decide call: all questions run against the same state and each extra question costs only its own tokens.",
    "Do not use jev_decide for counting, arithmetic or open exploration; it is a decision primitive, not a calculator or a search.",
  ],
  parameters: Type.Object({
    purpose: Type.String({
      description: "What this decision is for, in one line. Lands in the ledger, so make it recognisable.",
    }),
    state: T.String({
      description: "The content the questions are about. Plain text, or a JSON string when stateIsJson is set.",
    }),
    stateIsJson: Type.Optional(
      Type.Boolean({
        description: "Parse state as JSON and send it structured. Preferable: the model can then reference fields by name.",
      }),
    ),
    questions: Type.Array(
      Type.Object({
        id: Type.Optional(
          Type.String({ description: "Stable id for your code. Never sent to the model, so put the full question in instructions." }),
        ),
        type: Type.Union([Type.Literal("noul"), Type.Literal("choice"), Type.Literal("score")]),
        instructions: Type.String({ description: "The complete question, in plain language" }),
        criteria: Type.Optional(
          Type.Record(Type.String(), Type.String(), {
            description: "For choice/score: option or level → what it means. Keep instructions and criteria saying the same thing.",
          }),
        ),
      }),
      { description: "The typed questions. Every one runs against the same state, in parallel." },
    ),
    provider: Type.Optional(Type.String({ description: "Force one configured provider id instead of walking the chain" })),
    shadow: Type.Optional(Type.Boolean({ description: "Record the decision but treat the answers as untrusted" })),
  }),
  async execute(_toolCallId: string, params: DecideParams, signal: AbortSignal) {
    const config = getConfig();
    let state: unknown = params.state;

    if (params.stateIsJson) {
      try {
        state = JSON.parse(params.state);
      } catch (error) {
        throw new Error(`stateIsJson was set but state is not valid JSON: ${(error as Error).message}`);
      }
    }

    const stateChars = params.state.length;
    if (stateChars > TUNING.maxStateChars) {
      throw new Error(
        `State is ${stateChars} characters, over the ${TUNING.maxStateChars} limit. ` +
          "Filter it in code first — accuracy drops as state fills with material unrelated to the decision, and the context window is finite.",
      );
    }

    const questions: QuestionSpec[] = normaliseQuestions(params.questions);

    const outcome = await decide({
      tool: "jev_decide",
      purpose: params.purpose,
      state,
      questions,
      ...(params.shadow !== undefined ? { shadow: params.shadow } : {}),
      ...(params.provider ? { providerId: params.provider } : {}),
      signal,
    });

    const lines: string[] = [];
    for (const spec of questions) {
      const answer = outcome.answers[spec.id];
      if (!answer) {
        lines.push(`${spec.id}: no answer returned`);
        continue;
      }
      lines.push(`${spec.id}: ${formatAnswer(answer)}`);
      if (answer.probabilities) {
        const distribution = Object.entries(answer.probabilities)
          .sort((a, b) => b[1] - a[1])
          .map(([option, p]) => `${option} ${p.toFixed(2)}`)
          .join(", ");
        lines.push(`  distribution: ${distribution}`);
      }
    }

    const footer = [
      `${outcome.provider}${outcome.fellBack ? " (fell back)" : ""} · ${outcome.model}`,
      `${outcome.latencyMs}ms · ${outcome.usage.inputTokens} in / ${outcome.usage.outputTokens} out tokens`,
    ];
    if (outcome.degraded) {
      footer.push(
        "The provider reported no usable probability for at least one answer, so those are placeholders rather than confidences.",
      );
    }
    if (outcome.attempts.length > 0) {
      footer.push(`Earlier providers failed: ${outcome.attempts.map((a) => `${a.provider} (${a.error})`).join("; ")}`);
    }
    footer.push(`decision ${outcome.decisionId}`);

    lines.push("");
    lines.push(footer.join("\n"));

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      details: {
        decisionId: outcome.decisionId,
        provider: outcome.provider,
        answers: outcome.answers,
        latencyMs: outcome.latencyMs,
        costUsd: outcome.costUsd,
      },
    };
  },
};
