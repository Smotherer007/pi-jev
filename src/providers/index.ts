/**
 * Provider resolution and the single `decide()` entry point.
 *
 * Every tool goes through here. That is the point of the whole layering: the
 * tools describe *what* they need decided, and this module decides *who*
 * answers — and writes down what happened either way.
 */

import { getConfig, providerChain, type ProviderEntry } from "../config.ts";
import { costOf, estimateTokens, hashState, newId, recordDecision } from "../ledger.ts";
import type {
  AnswerValue,
  DecisionProvider,
  QuestionSpec,
  Usage,
} from "../types.ts";
import { JevProvider } from "./jev.ts";
import { OpenAICompatProvider } from "./openai-compat.ts";

export function buildProvider(entry: ProviderEntry): DecisionProvider {
  switch (entry.kind) {
    case "jev":
      return new JevProvider(entry);
    case "ollama":
    case "openai-compat":
      return new OpenAICompatProvider(entry);
    default: {
      // Exhaustiveness: adding a kind without a client is a compile error, and
      // a runtime error rather than a silent fallthrough.
      const exhaustive: never = entry.kind;
      throw new Error(`Unsupported provider kind: ${String(exhaustive)}`);
    }
  }
}

export interface DecideOptions {
  /** Ledger label for the tool that asked. */
  tool: string;
  purpose: string;
  state: unknown;
  questions: QuestionSpec[];
  /** Log the decision but do not let the caller act on it. */
  shadow?: boolean;
  /** Force one provider by id instead of walking the chain. */
  providerId?: string;
  /** Per-call deadline, passed through to whichever provider answers. */
  timeoutMs?: number;
  signal?: AbortSignal;
  itemCount?: number;
  /**
   * Called with the answers just before they are written to the ledger, so a
   * tool can attach derived bookkeeping without duplicating the recording
   * logic. `jev_triage` uses it to note which candidates the filter rejected.
   */
  annotate?: (answers: Record<string, AnswerValue>) => { kept?: string[]; dropped?: string[] };
}

export interface DecideOutcome {
  decisionId: string;
  provider: string;
  model: string;
  answers: Record<string, AnswerValue>;
  latencyMs: number;
  usage: Usage;
  costUsd: number;
  /** True when a probability had to be substituted. */
  degraded: boolean;
  /** Providers that were tried and failed, in order. */
  attempts: Array<{ provider: string; error: string }>;
  /** True when a later provider in the chain answered. */
  fellBack: boolean;
}

/** Rough character cost of the state, used to record size next to the hash. */
function stateSize(state: unknown): number {
  return (typeof state === "string" ? state : JSON.stringify(state) ?? "").length;
}

export async function decide(options: DecideOptions): Promise<DecideOutcome> {
  const config = getConfig();
  const chain = providerChain(config, options.providerId);

  if (chain.length === 0) {
    throw new Error(
      "No provider configured. Run jev_setup first, or add one by hand to ~/.pi/jev-config.json.",
    );
  }

  const attempts: Array<{ provider: string; error: string }> = [];
  const stateText = typeof options.state === "string" ? options.state : JSON.stringify(options.state) ?? "";

  for (const [index, entry] of chain.entries()) {
    const provider = buildProvider(entry);
    const started = Date.now();

    try {
      const response = await provider.decide({
        state: options.state,
        questions: options.questions,
        purpose: options.purpose,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const latencyMs = Date.now() - started;

      // Some endpoints report no usage at all. Fall back to an estimate so the
      // cost column stays meaningful instead of silently reading zero.
      const usage: Usage =
        response.usage.inputTokens === 0 && stateText.length > 0
          ? { inputTokens: estimateTokens(stateText), outputTokens: response.usage.outputTokens }
          : response.usage;

      const decisionId = newId("dec");
      const costUsd = costOf(usage.inputTokens, provider.costPerMillionInput);
      const annotation = options.annotate ? options.annotate(response.answers) : {};

      recordDecision({
        kind: "decision",
        id: decisionId,
        ts: new Date().toISOString(),
        tool: options.tool,
        purpose: options.purpose,
        provider: provider.id,
        model: response.model,
        shadow: options.shadow ?? false,
        stateHash: hashState(options.state),
        stateChars: stateSize(options.state),
        latencyMs,
        usage,
        costUsd,
        answers: Object.entries(response.answers).map(([id, answer]) => ({
          id,
          type: answer.type,
          p: answer.p,
          value: answer.value,
        })),
        ...(options.itemCount !== undefined ? { itemCount: options.itemCount } : {}),
        ...(annotation.kept ? { kept: annotation.kept } : {}),
        ...(annotation.dropped ? { dropped: annotation.dropped } : {}),
        ...(response.raw ? { schemaViolation: "provider reported no usable probability" } : {}),
      });

      return {
        decisionId,
        provider: provider.id,
        model: response.model,
        answers: response.answers,
        latencyMs,
        usage,
        costUsd,
        degraded: Object.values(response.answers).some((answer) => answer.degraded === true),
        attempts,
        fellBack: index > 0,
      };
    } catch (error) {
      attempts.push({ provider: provider.id, error: (error as Error).message });
      // No retry on the same provider: Jev has no idempotency key, so a second
      // attempt may be charged twice. Move along the chain and let the caller
      // see which providers failed and why.
    }
  }

  const detail = attempts.map((attempt) => `  ${attempt.provider}: ${attempt.error}`).join("\n");
  throw new Error(`Every provider failed.\n${detail}`);
}

/** Health of the whole configured chain, for `jev_status`. */
export async function chainHealth(): Promise<
  Array<{ entry: ProviderEntry; ok: boolean; detail: string; skipped: boolean }>
> {
  const config = getConfig();
  const results = [];

  for (const entry of config.providers) {
    if (entry.manual) {
      results.push({ entry, ok: false, detail: "manual only, never chosen automatically", skipped: true });
      continue;
    }
    const health = await buildProvider(entry).available();
    results.push({ entry, ok: health.ok, detail: health.detail, skipped: false });
  }
  return results;
}
