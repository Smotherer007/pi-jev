/**
 * Shared types for pi-jev.
 *
 * The vocabulary here is deliberately narrow. A Jev request is a piece of
 * *state* plus a set of *typed questions*; the answer to each question is a
 * value drawn from a set that was fixed before the model ran, plus the
 * probability the model assigns to it.
 *
 * We keep one normalised shape for every answer (`AnswerValue`) so that the
 * ledger, the calibration maths and the formatting code never need to branch
 * on provider or question type.
 */

/** The three answer shapes TypeSafe defines for a System One model. */
export type QuestionType = "noul" | "choice" | "score";

/**
 * One typed question.
 *
 * `id` is for the calling code and is never sent to the model, so
 * `instructions` has to carry the full question even when the id looks
 * self-explanatory.
 */
export interface QuestionSpec {
  id: string;
  type: QuestionType;
  instructions: string;
  /**
   * For `choice`: option -> meaning. For `score`: level -> meaning.
   * For `noul`: optionally `{ true: "...", false: "..." }`.
   */
  criteria?: Record<string, string>;
}

/**
 * A normalised answer.
 *
 * `p` is always "the probability the provider assigned to the answer it
 * chose", which is the quantity calibration is computed over:
 *  - `noul`   -> the reported probability of the positive class
 *  - `choice` -> the probability of the winning option
 *  - `score`  -> the reported confidence, or the winning level's probability
 */
export interface AnswerValue {
  type: QuestionType;
  /** Probability assigned to the chosen answer, clamped to 0..1. */
  p: number;
  /** Human-readable answer. */
  value: boolean | string | number;
  /** Full distribution when the provider reports one. */
  probabilities?: Record<string, number>;
  /** The provider's own confidence in its pick, when it reports one. */
  confidence?: number;
  /**
   * Set when the provider could not report a probability and pi-jev had to
   * substitute one. Fallback providers set this; Jev does not.
   */
  degraded?: boolean;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface DecisionRequest {
  state: unknown;
  questions: QuestionSpec[];
  /** Human-readable label for what this call is for; lands in the ledger. */
  purpose: string;
  /**
   * Per-call deadline. Matters more than it looks: a gate sits on the critical
   * path of every consequential action, while a triage call can afford to wait.
   * Without this, one shared default makes the gate as slow as the slowest
   * configured provider — which for a local 27B model is tens of seconds.
   */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DecisionResponse {
  answers: Record<string, AnswerValue>;
  model: string;
  usage: Usage;
  /** Raw provider payload, kept only when parsing needed to guess. */
  raw?: string;
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
}

export interface DecisionProvider {
  id: string;
  label: string;
  /** USD per million input tokens. Output is free on Jev, 0 locally. */
  costPerMillionInput: number;
  available(): Promise<ProviderHealth>;
  decide(request: DecisionRequest): Promise<DecisionResponse>;
}

/* ------------------------------------------------------------------ ledger */

export interface LedgerAnswer {
  id: string;
  type: QuestionType;
  p: number;
  value: boolean | string | number;
}

export interface LedgerDecision {
  kind: "decision";
  id: string;
  ts: string;
  /** Tool that produced the decision, e.g. "jev_triage". */
  tool: string;
  purpose: string;
  provider: string;
  model: string;
  /** True when the result was logged but not acted on. */
  shadow: boolean;
  /** sha256 of the state, first 16 hex chars. Lets us spot repeated states. */
  stateHash: string;
  stateChars: number;
  /** How many candidate items the state contained, for triage decisions. */
  itemCount?: number;
  latencyMs: number;
  usage: Usage;
  costUsd: number;
  answers: LedgerAnswer[];
  /** Triage only: what the provider kept, as stable item keys. */
  kept?: string[];
  /** Triage only: what the provider dropped, as stable item keys. */
  dropped?: string[];
  /** Present when a fallback provider produced an out-of-schema answer. */
  schemaViolation?: string;
}

export interface LedgerLabel {
  kind: "label";
  id: string;
  ts: string;
  decisionId: string;
  questionId: string;
  /** Was the answer the provider chose actually right? */
  correct: boolean;
  note?: string;
}

/**
 * Recorded when pi touches something Jev had dropped. That is a *candidate*
 * false negative: useful signal, not proof, because pi may read a dropped
 * path for an unrelated reason.
 */
export interface LedgerShadowMiss {
  kind: "shadow-miss";
  id: string;
  ts: string;
  decisionId: string;
  /** The dropped item pi went on to touch. */
  item: string;
  /** The tool pi used, e.g. "read". */
  via: string;
}

export type LedgerEntry = LedgerDecision | LedgerLabel | LedgerShadowMiss;

/* ------------------------------------------------------------------- risks */

export type RiskClass = "read_only" | "reversible" | "destructive" | "needs_human";
export type GateVerdict = "allow" | "confirm" | "block";

export const RISK_CLASSES: readonly RiskClass[] = [
  "read_only",
  "reversible",
  "destructive",
  "needs_human",
];
