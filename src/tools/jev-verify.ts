/**
 * jev_verify — check claims against evidence before acting on them.
 *
 * This is the first tool to trust, for a reason that is about failure modes
 * rather than usefulness: a wrong "not supported" costs one repair round, while
 * a wrong "supported" is caught by the next test. Neither is silent. A wrong
 * filter drop, by contrast, is invisible — which is why triage ships in shadow
 * mode and this does not.
 *
 * The gap it closes: an agent that says "I fixed the auth bug and added tests"
 * is making claims the test suite does not check. Tests say whether the code
 * runs; they do not say whether the summary matches the diff.
 */

import { Type } from "typebox";

import { getConfig } from "../config.ts";
import { readTextFile } from "../candidates.ts";
import { collectGitDiff, run } from "../exec.ts";
import { decide } from "../providers/index.ts";
import { claimVerdict, formatVerification } from "../format.ts";
import type { QuestionSpec } from "../types.ts";
import { TUNING } from "../tuning.ts";

interface VerifyParams {
  claims: string[];
  evidence?: string;
  evidenceFrom?: {
    kind: "git-diff" | "file" | "command";
    path?: string;
    command?: string;
    args?: string[];
  };
  shadow?: boolean;
  provider?: string;
}

interface Evidence {
  text: string;
  source: string;
  truncated: boolean;
  note?: string;
}

async function gatherEvidence(params: VerifyParams, cwd: string, maxChars: number): Promise<Evidence> {
  if (params.evidence !== undefined) {
    return {
      text: params.evidence.slice(0, maxChars),
      source: "provided inline",
      truncated: params.evidence.length > maxChars,
    };
  }

  const spec = params.evidenceFrom;
  if (!spec) {
    // Default to the working tree: that is what an agent's claims are usually about.
    const diff = await collectGitDiff(cwd, maxChars);
    return {
      text: diff.text,
      source: `git working tree (${diff.files} changed files)`,
      truncated: diff.truncated,
      ...(diff.note ? { note: diff.note } : {}),
    };
  }

  if (spec.kind === "git-diff") {
    const diff = await collectGitDiff(cwd, maxChars);
    return {
      text: diff.text,
      source: `git working tree (${diff.files} changed files)`,
      truncated: diff.truncated,
      ...(diff.note ? { note: diff.note } : {}),
    };
  }

  if (spec.kind === "file") {
    if (!spec.path) throw new Error("evidenceFrom.kind=file needs a path.");
    const text = readTextFile(spec.path.startsWith("/") ? spec.path : `${cwd}/${spec.path}`, maxChars * 2);
    if (text === null) throw new Error(`Could not read ${spec.path} (missing, binary, or too large).`);
    return {
      text: text.slice(0, maxChars),
      source: spec.path,
      truncated: text.length > maxChars,
    };
  }

  if (!spec.command) throw new Error("evidenceFrom.kind=command needs a command.");
  const result = await run(spec.command, spec.args ?? [], { cwd, maxBytes: maxChars * 2 });
  const text = [result.stdout, result.stderr].filter(Boolean).join("\n");
  return {
    text: text.slice(0, maxChars),
    source: `${spec.command} ${(spec.args ?? []).join(" ")}`.trim(),
    truncated: text.length > maxChars,
    ...(result.ok ? {} : { note: `the command exited non-zero (code ${result.code})` }),
  };
}

export const JevVerifyTool = {
  name: "jev_verify",
  label: "Verify claims",
  description:
    "Check whether specific claims are supported by evidence — by default the current git diff, including new files. Answers per claim with a probability and a verdict of supported, unclear or refuted. Use it before reporting work as done: the test suite proves the code runs, not that your summary is true.",
  promptSnippet: "Check whether your claims are actually supported by the diff",
  promptGuidelines: [
    "Use jev_verify before telling the user that work is complete, whenever your summary makes claims a test suite would not catch (\"added tests\", \"handles the edge case\", \"no behaviour change\").",
    "Phrase each jev_verify claim as a single checkable assertion; a claim that bundles several facts gets one probability that means nothing.",
    "A jev_verify verdict of refuted means the diff does not show it — either finish the work or weaken the claim. Do not report it as done.",
  ],
  parameters: Type.Object({
    claims: Type.Array(Type.String(), {
      description: "One checkable assertion per entry, e.g. \"a test covers the empty-list case\"",
    }),
    evidence: Type.Optional(
      Type.String({ description: "Evidence inline. Overrides evidenceFrom when both are given." }),
    ),
    evidenceFrom: Type.Optional(
      Type.Object({
        kind: Type.Union([Type.Literal("git-diff"), Type.Literal("file"), Type.Literal("command")]),
        path: Type.Optional(Type.String({ description: "For kind=file" })),
        command: Type.Optional(Type.String({ description: "For kind=command" })),
        args: Type.Optional(Type.Array(Type.String(), { description: "Arguments for kind=command" })),
      }),
    ),
    shadow: Type.Optional(Type.Boolean({ description: "Record the decision but treat the verdicts as untrusted" })),
    provider: Type.Optional(Type.String({ description: "Force one configured provider id" })),
  }),
  async execute(_toolCallId: string, params: VerifyParams, signal: AbortSignal, _onUpdate: unknown, ctx: { cwd: string }) {
    const config = getConfig();

    if (params.claims.length === 0) throw new Error("At least one claim is required.");

    // Resolved once, so the ledger and the output cannot disagree about whether
    // this decision was made in shadow mode — /jev-calibration splits on that
    // flag, and a decision logged as trusted while the tool told the agent to
    // distrust it corrupts exactly the measurement the ledger exists for.
    const shadow = params.shadow ?? config.shadow.verify;

    const evidence = await gatherEvidence(params, ctx.cwd, TUNING.maxStateChars);

    if (evidence.text.trim().length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text:
              `No evidence to check against (${evidence.source})` +
              (evidence.note ? `: ${evidence.note}.` : ".") +
              " With nothing to compare against, every claim is unverified by construction — report the work as unverified rather than as done.",
          },
        ],
        details: { claims: params.claims.length, evidenceChars: 0, verdict: "no-evidence" },
      };
    }

    const questions: QuestionSpec[] = params.claims.map((claim, index) => ({
      id: `claim${index}`,
      type: "noul",
      instructions:
        `Does the EVIDENCE support this claim: "${claim}"? ` +
        "Judge only what the evidence shows, not what is plausible. " +
        "Answer false when the evidence is silent about it.",
      criteria: {
        true: "The evidence explicitly shows the claim to be true.",
        false: "The evidence does not show it, shows something weaker, or contradicts it.",
      },
    }));

    const state = `## EVIDENCE (${evidence.source})\n\n${evidence.text}`;

    const outcome = await decide({
      tool: "jev_verify",
      purpose: `verify ${params.claims.length} claim(s)`.slice(0, 180),
      state,
      questions,
      shadow,
      ...(params.provider ? { providerId: params.provider } : {}),
      signal,
    });

    const results = params.claims.map((claim, index) => {
      const answer = outcome.answers[`claim${index}`];
      const p = answer?.p ?? 0.5;
      return { claim, p, verdict: claimVerdict(p, config.verify.supportedAt, config.verify.refutedAt) };
    });

    const text = formatVerification(results, {
      provider: `${outcome.provider}${outcome.fellBack ? " (fell back)" : ""}`,
      latencyMs: outcome.latencyMs,
      costUsd: outcome.costUsd,
      evidenceChars: evidence.text.length,
      shadow,
      decisionId: outcome.decisionId,
      degraded: outcome.degraded,
    });

    const notes: string[] = [];
    if (evidence.truncated) {
      notes.push("");
      notes.push("The evidence was truncated to fit the state budget, so a refuted verdict may just mean the relevant part was cut off.");
    }
    if (evidence.note) {
      notes.push("");
      notes.push(`Evidence note: ${evidence.note}`);
    }
    if (outcome.attempts.length > 0) {
      notes.push("");
      notes.push(`Earlier providers failed: ${outcome.attempts.map((a) => `${a.provider} (${a.error})`).join("; ")}`);
    }

    return {
      content: [{ type: "text" as const, text: text + notes.join("\n") }],
      details: {
        decisionId: outcome.decisionId,
        provider: outcome.provider,
        verdicts: results,
        evidenceChars: evidence.text.length,
        costUsd: outcome.costUsd,
      },
    };
  },
};
