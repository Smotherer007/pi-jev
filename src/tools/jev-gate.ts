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
import { decide } from "../providers/index.ts";
import { formatGate } from "../format.ts";
import { RISK_CLASSES, type QuestionSpec } from "../types.ts";

interface GateParams {
  action: string;
  context?: string;
  allowedRisk?: "read_only" | "reversible" | "destructive" | "needs_human";
  shadow?: boolean;
  provider?: string;
}

/** Ordered from safest to worst; used when comparing against `allowedRisk`. */
const ORDER = ["read_only", "reversible", "destructive", "needs_human"] as const;

const GUIDANCE: Record<string, string> = {
  allow: "\n\nCleared. Proceed.",
  confirm:
    "\n\nAsk the user before running this, and say what the blast radius is when you do.",
  block: "\n\nDo not run this. Explain what it would do and let the user decide or run it themselves.",
};

function ruleReport(hard: HardVerdict, action: string, allowed: string): string {
  const overAllowed = ORDER.indexOf(hard.risk) > ORDER.indexOf(allowed as (typeof ORDER)[number]);
  const rationale = [
    hard.reason,
    overAllowed ? `above the allowedRisk you set (${allowed})` : "",
    `blast radius ${hard.blast}/4`,
  ]
    .filter(Boolean)
    .join("; ");

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
      // A rule that says "allow" is only allowed to say so when the caller's
      // own policy permits a read-only action.
      const verdict = hard.verdict === "allow" && ORDER.indexOf(hard.risk) > ORDER.indexOf(allowed as never)
        ? "confirm"
        : hard.verdict;

      return {
        content: [
          {
            type: "text" as const,
            text:
              ruleReport(hard, params.action, allowed) +
              (verdict === hard.verdict ? "" : `\nEscalated to ${verdict} because it exceeds allowedRisk=${allowed}.`) +
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

    const questions: QuestionSpec[] = [
      {
        id: "risk",
        type: "choice",
        instructions:
          "Which risk class does this action belong to? Judge the effect, not the wording: " +
          "a command that reads like a read can still delete.",
        criteria: {
          read_only: "It cannot change state anywhere: reading, listing, searching, querying.",
          reversible:
            "It changes state, but the change is recoverable from version control, a backup, or a single inverse command.",
          destructive:
            "It changes state in a way that is hard or impossible to undo: deletions, overwrites without history, force operations, migrations.",
          needs_human:
            "Its effect cannot be judged from the action alone — the target matters more than the command.",
        },
      },
      {
        id: "blast",
        type: "score",
        instructions: "If this action is wrong or mis-targeted, how far does the damage reach?",
        criteria: {
          "1": "This machine only, one file or one process, trivially recreated.",
          "2": "This machine or repository, but broader: several files, a build output, a local database.",
          "3": "A shared system: a remote server, a shared repository, a deployed environment.",
          "4": "A production system, customer data, or something with no recent backup.",
        },
      },
    ];

    const state = params.context
      ? `## ACTION\n${params.action}\n\n## CONTEXT\n${params.context}`
      : `## ACTION\n${params.action}`;

    let outcome;
    try {
      outcome = await decide({
        tool: "jev_gate",
        purpose: `gate: ${params.action.slice(0, 120)}`,
        state,
        questions,
        shadow: params.shadow ?? config.shadow.gate,
        // Short deadline on purpose. A gate that waits for a local model to
        // finish thinking has stopped being a gate; on timeout the verdict
        // falls back to "confirm" below.
        timeoutMs: config.limits.gateTimeoutMs,
        ...(params.provider ? { providerId: params.provider } : {}),
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

    const riskRaw = typeof outcome.answers.risk?.value === "string" ? outcome.answers.risk.value : "";
    const risk = (RISK_CLASSES as readonly string[]).includes(riskRaw)
      ? (riskRaw as (typeof RISK_CLASSES)[number])
      : "needs_human";

    const blast =
      typeof outcome.answers.blast?.value === "number"
        ? Math.min(4, Math.max(1, outcome.answers.blast.value))
        : null;

    // Two independent reasons to escalate, and neither is allowed to argue the
    // other away: the declared risk class, and the blast radius.
    let verdict = config.gate[risk];
    if (blast !== null && blast >= 3 && verdict === "allow") verdict = "confirm";
    if (blast !== null && blast >= 4 && verdict === "confirm") verdict = "block";

    const overAllowed = ORDER.indexOf(risk) > ORDER.indexOf(allowed as (typeof ORDER)[number]);

    const rationaleParts: string[] = [];
    if (outcome.answers.risk && outcome.answers.risk.p < 0.6) {
      rationaleParts.push(
        `the risk class was not a clear call (p=${outcome.answers.risk.p.toFixed(2)}), so the verdict leans cautious`,
      );
    }
    if (overAllowed) rationaleParts.push(`above the allowedRisk you set (${allowed})`);
    if (blast !== null && blast >= 3) rationaleParts.push(`blast radius ${blast}/4`);

    const text = formatGate(risk, blast, outcome.answers.risk?.p ?? 0.5, verdict, rationaleParts.join("; "), {
      provider: `${outcome.provider}${outcome.fellBack ? " (fell back)" : ""}`,
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
