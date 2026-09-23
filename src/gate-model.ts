/**
 * The model layer of the gate, shared by `jev_gate` and the bash hook.
 *
 * It used to live inside the tool, which meant the model only ever judged a
 * command when the agent chose to ask. The hook needs the same judgement with
 * the same policy, and two copies of a policy drift, so it lives here once.
 *
 * What this module decides: the risk class and blast radius the model reports,
 * and the verdict the *config* maps them to. What it does not decide: anything
 * the deterministic rules already caught — callers run `hardGuard` first.
 */

import { getConfig } from "./config.ts";
import { decide, type DecideOutcome } from "./providers/index.ts";
import { RISK_CLASSES, type GateVerdict, type QuestionSpec, type RiskClass } from "./types.ts";

/** Ordered from safest to worst; used when comparing against `allowedRisk`. */
export const RISK_ORDER = ["read_only", "reversible", "destructive", "needs_human"] as const;

/**
 * Is this risk class above the ceiling the caller set?
 *
 * `allowedRisk` answers "how much risk may be cleared without asking", so it is
 * a ceiling on `allow` and nothing else. It never lowers a verdict.
 */
export function aboveCeiling(risk: string, allowed: string): boolean {
  return (
    RISK_ORDER.indexOf(risk as (typeof RISK_ORDER)[number]) >
    RISK_ORDER.indexOf(allowed as (typeof RISK_ORDER)[number])
  );
}

/** Apply the caller's ceiling to a verdict from either layer. */
export function applyAllowedRisk(risk: string, verdict: GateVerdict, allowed: string): GateVerdict {
  return aboveCeiling(risk, allowed) && verdict === "allow" ? "confirm" : verdict;
}

export const GATE_QUESTIONS: readonly QuestionSpec[] = [
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

export interface ModelGateOptions {
  action: string;
  context?: string;
  allowedRisk: RiskClass;
  /** Ledger label, so hook decisions and tool decisions stay distinguishable. */
  tool: string;
  shadow: boolean;
  provider?: string;
  signal?: AbortSignal;
}

export interface ModelGateResult {
  risk: RiskClass;
  blast: number | null;
  verdict: GateVerdict;
  /** Probability of the chosen risk class. */
  p: number;
  rationale: string[];
  outcome: DecideOutcome;
}

/**
 * Ask the decision model and turn its answer into a verdict.
 *
 * Throws when no provider answers; the caller owns the fail-safe, because only
 * the caller knows whether "confirm" means a dialog or a line of text.
 */
export async function classifyWithModel(options: ModelGateOptions): Promise<ModelGateResult> {
  const config = getConfig();

  const state = options.context
    ? `## ACTION\n${options.action}\n\n## CONTEXT\n${options.context}`
    : `## ACTION\n${options.action}`;

  const outcome = await decide({
    tool: options.tool,
    purpose: `gate: ${options.action.slice(0, 120)}`,
    state,
    questions: [...GATE_QUESTIONS],
    shadow: options.shadow,
    // Short deadline on purpose. A gate that waits for a local model to finish
    // thinking has stopped being a gate; callers fall back to "confirm".
    timeoutMs: config.limits.gateTimeoutMs,
    ...(options.provider ? { providerId: options.provider } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const riskRaw = typeof outcome.answers.risk?.value === "string" ? outcome.answers.risk.value : "";
  const risk: RiskClass = (RISK_CLASSES as readonly string[]).includes(riskRaw)
    ? (riskRaw as RiskClass)
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
  // Then the caller's own ceiling, which is what makes allowedRisk a policy.
  verdict = applyAllowedRisk(risk, verdict, options.allowedRisk);

  const p = outcome.answers.risk?.p ?? 0.5;
  const rationale: string[] = [];
  if (outcome.answers.risk && outcome.answers.risk.p < 0.6) {
    rationale.push(`the risk class was not a clear call (p=${outcome.answers.risk.p.toFixed(2)}), so the verdict leans cautious`);
  }
  if (aboveCeiling(risk, options.allowedRisk)) rationale.push(`above the allowedRisk you set (${options.allowedRisk})`);
  if (blast !== null && blast >= 3) rationale.push(`blast radius ${blast}/4`);

  return { risk, blast, verdict, p, rationale, outcome };
}

/* --------------------------------------------- which commands are worth it */

/**
 * Commands whose effect reaches past the working tree or is hard to undo.
 *
 * This is a *routing* list, not a safety list: matching it does not make a
 * command dangerous, it makes it worth ~100 ms of the model's attention before
 * it runs. Missing a pattern here costs nothing new — the command runs exactly
 * as it did before the hook existed — so the list errs towards being short and
 * cheap rather than complete. `hook.model: "all"` asks about everything.
 */
const CONSEQUENTIAL: readonly RegExp[] = [
  /\bgit\s+(push|reset|rebase|clean|filter-branch|filter-repo|stash\s+(drop|clear)|branch\s+-[dD]|tag\s+-d|checkout\s+--|restore)\b/,
  /\b(kubectl|helm|terraform|tofu|pulumi|ansible(-playbook)?|aws|gcloud|az|doctl|flyctl|heroku|vercel|netlify|wrangler)\b/,
  /\bdocker\s+(rm|rmi|push|system|volume|network\s+rm|compose\s+down)\b/,
  /\b(psql|mysql|mariadb|mongo(sh)?|redis-cli|sqlite3|cqlsh|clickhouse-client)\b/,
  /\b(ssh|scp|rsync|sftp)\b/,
  /\bcurl\b[^\n]*(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|(^|\s)(-d|--data\S*)\s)/,
  /\b(npm|pnpm|yarn|cargo|gem|twine|poetry)\s+(publish|unpublish|deprecate)\b/,
  /\b(rm|truncate|unlink)\s/,
  /\bfind\b[^\n]*\s-(delete\b|exec(dir)?\s+(rm|mv|chmod|chown|sed|truncate)\b)/,
  /\b(migrate|migration|deploy|release|rollback|seed|drop|purge|prune)\b/i,
];

export function isConsequential(command: string): boolean {
  return CONSEQUENTIAL.some((pattern) => pattern.test(command));
}
