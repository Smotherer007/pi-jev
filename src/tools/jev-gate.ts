/**
 * jev_gate — classify an action's risk before it runs.
 *
 * Two layers, in this order:
 *
 *   1. Deterministic rules (`guard.ts`). Danger that is visible in the string
 *      is decided here, before any provider is consulted, and cannot be argued
 *      away by surrounding context. This also means the gate works with no
 *      provider configured and no network.
 *   2. A decision model, for what the rules cannot see: is this migration
 *      routine or one-way, is this cleanup or a catastrophe. Intent is not in
 *      the string, and that is the part worth a model call.
 *
 * When the model is unreachable the verdict is *confirm*, never *allow*. A
 * guardrail that opens up when its brain is offline is not a guardrail — which
 * is the opposite of the usual "fail open" advice, and deliberately so. The
 * deterministic layer already handled everything that is dangerous on its
 * face, so what remains is genuinely ambiguous, and asking is correct.
 *
 * The verdict is a *policy* decision, not a model decision: the model reports a
 * risk class and a blast radius, and the mapping from class to allow/confirm/
 * block lives in the config where it can be read and reviewed.
 */

import { Type } from "typebox";

import { getConfig } from "../config.ts";
import { hardGuard, type HardVerdict } from "../guard.ts";
import { aboveCeiling, applyAllowedRisk, classifyWithModel } from "../gate-model.ts";
import { formatGate } from "../format.ts";

interface GateParams {
  action: string;
  context?: string;
  allowedRisk?: "read_only" | "reversible" | "destructive" | "needs_human";
  shadow?: boolean;
  provider?: string;
}

/** The consequence of a ceiling, stated once, whether or not it changed anything. */
function ceilingNote(risk: string, verdict: string, allowed: string): string {
  if (!aboveCeiling(risk, allowed)) return "";
  return (
    `\n\nAbove the allowedRisk you set (${allowed})` +
    (verdict === "allow" ? "" : `, so this is not cleared: ${verdict}.`)
  );
}

const GUIDANCE: Record<string, string> = {
  allow: "\n\nCleared. Proceed.",
  confirm:
    "\n\nAsk the user before running this, and say what the blast radius is when you do.",
  block: "\n\nDo not run this. Explain what it would do and let the user decide or run it themselves.",
};

function ruleReport(hard: HardVerdict, action: string): string {
  const rationale = [hard.reason, `blast radius ${hard.blast}/4`].filter(Boolean).join("; ");

  return formatGate(hard.risk, hard.blast, 1, hard.verdict, rationale, {
    provider: "local rules (no model called)",
    latencyMs: 0,
    costUsd: 0,
    decisionId: `rule:${action.slice(0, 40)}`,
    degraded: false,
  });
}

export const JevGateTool = {
  name: "jev_gate",
  label: "Check action risk",
  description:
    "Classify an action or shell command as read_only, reversible, destructive or needs_human, with a blast-radius estimate, and get a policy verdict of allow, confirm or block. Unambiguous danger is decided by local rules with no model call and no network; anything ambiguous is judged by a decision model. Cheap enough to call before every consequential command.",
  promptSnippet: "Classify an action's risk and get an allow/confirm/block verdict",
  promptGuidelines: [
    "Use jev_gate before running a shell command whose effect is not obvious from its name — recursive deletes, migrations, force-pushes, infrastructure changes, anything touching a remote system.",
    "Treat a jev_gate verdict of block as a reason to ask the user, not as a reason to rephrase the command until it passes.",
  ],
  parameters: Type.Object({
    action: Type.String({ description: "The command or action, verbatim, e.g. \"git push --force origin main\"" }),
    context: Type.Optional(
      Type.String({ description: "Where it runs and against what, e.g. \"production SAP system, no recent backup\"" }),
    ),
    allowedRisk: Type.Optional(
      Type.Union(
        [
          Type.Literal("read_only"),
          Type.Literal("reversible"),
          Type.Literal("destructive"),
          Type.Literal("needs_human"),
        ],
        { description: "Highest risk class to allow without asking. Default: read_only." },
      ),
    ),
    shadow: Type.Optional(Type.Boolean({ description: "Record the decision but do not act on the verdict" })),
    provider: Type.Optional(Type.String({ description: "Force one configured provider id" })),
  }),
  async execute(_toolCallId: string, params: GateParams, signal: AbortSignal) {
    const config = getConfig();
    const allowed = params.allowedRisk ?? "read_only";

    /* ---------------------------------------------- layer 1: local rules */

    const hard = hardGuard({ action: params.action, ...(params.context ? { context: params.context } : {}) });

    if (hard) {
      const verdict = applyAllowedRisk(hard.risk, hard.verdict, allowed);

      return {
        content: [
          {
            type: "text" as const,
            text:
              ruleReport(hard, params.action) +
              ceilingNote(hard.risk, verdict, allowed) +
              (GUIDANCE[verdict] ?? ""),
          },
        ],
        details: {
          source: "rule",
          risk: hard.risk,
          blast: hard.blast,
          verdict,
          matched: hard.matched,
          allowedRisk: allowed,
          costUsd: 0,
        },
      };
    }

    /* -------------------------------------------- layer 2: decision model */

    let result;
    try {
      result = await classifyWithModel({
        action: params.action,
        ...(params.context ? { context: params.context } : {}),
        allowedRisk: allowed,
        tool: "jev_gate",
        shadow: params.shadow ?? config.shadow.gate,
        ...(params.provider ? { provider: params.provider } : {}),
        signal,
      });
    } catch (error) {
      // Deliberate fail-safe: an unavailable model must not become a clearance.
      const text = [
        "CONFIRM · risk=unknown · the risk classifier could not be reached",
        "",
        `Reason: ${(error as Error).message}`,
        "",
        "The local rules found nothing unambiguous about this action, so the only remaining " +
          "judgement would have come from the model — and it is unavailable. Ask the user before " +
          "running it. This is deliberately not a fail-open path: a guardrail that clears things " +
          "when its brain is offline is not a guardrail.",
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: {
          source: "unavailable",
          risk: "needs_human",
          blast: null,
          verdict: "confirm",
          allowedRisk: allowed,
          error: (error as Error).message,
        },
      };
    }

    const { risk, blast, verdict, outcome } = result;
    const rationaleParts = result.rationale;

    const text = formatGate(risk, blast, result.p, verdict, rationaleParts.join("; "), {
      provider: `${outcome.provider}${outcome.fellBack ? " (fell back)" : ""}${outcome.cached ? " (cached)" : ""}`,
      latencyMs: outcome.latencyMs,
      costUsd: outcome.costUsd,
      decisionId: outcome.decisionId,
      degraded: outcome.degraded,
    });

    return {
      content: [{ type: "text" as const, text: text + (GUIDANCE[verdict] ?? "") }],
      details: {
        source: "model",
        decisionId: outcome.decisionId,
        risk,
        blast,
        verdict,
        allowedRisk: allowed,
        provider: outcome.provider,
        latencyMs: outcome.latencyMs,
        costUsd: outcome.costUsd,
      },
    };
  },
};
