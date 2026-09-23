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
import { TUNING } from "../tuning.ts";

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
  /**
   * True when the answer came from the in-memory cache: an identical question
   * over an identical state, asked recently. No provider was called, nothing
   * was charged and nothing new was written to the ledger.
   */
  cached?: boolean;
}

/* ------------------------------------------------------------ speed layer */

/**
 * Two small memories that exist only to make decisions faster.
 *
 * The cache: the bash hook and repeated triage runs ask the same question about
 * the same state over and over in one session. The second answer is served from
 * memory in microseconds instead of a round trip, and is not written to the
 * ledger again — it is the same decision, not a new observation, and counting it
 * twice would skew calibration towards whatever gets asked most.
 *
 * The cooldown: a provider that just failed is skipped for a while. Without it, a
 * hosted provider that is down costs its full timeout on every decision before
 * the chain falls through to the local one; with it, it costs one.
 *
 * Both are keyed on the provider's id *and* URL and model, so reconfiguring a
 * provider is never answered from the previous configuration's memory.
 */
const CACHE_MAX_ENTRIES = 500;
const decisionCache = new Map<string, { at: number; outcome: DecideOutcome }>();
const cooldowns = new Map<string, number>();

function providerKey(entry: ProviderEntry): string {
  return `${entry.id}|${entry.baseUrl ?? ""}|${entry.model ?? ""}`;
}

function cacheKey(options: DecideOptions, chain: readonly ProviderEntry[]): string {
  return [
    options.tool,
    options.shadow ? "shadow" : "live",
    chain.map(providerKey).join(","),
    hashState(options.state),
    hashState(options.questions),
  ].join("\u0000");
}

function cacheGet(key: string, ttlMs: number): DecideOutcome | null {
  if (ttlMs <= 0) return null;
  const hit = decisionCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ttlMs) {
    decisionCache.delete(key);
    return null;
  }
  return hit.outcome;
}

function cachePut(key: string, outcome: DecideOutcome, ttlMs: number): void {
  if (ttlMs <= 0) return;
  // A degraded answer is a guess standing in for a probability; serving it again
  // would repeat the guess without the chance of a real answer this time.
  if (outcome.degraded) return;
  decisionCache.set(key, { at: Date.now(), outcome });
  // Map iteration order is insertion order, so the first key is the oldest.
  while (decisionCache.size > CACHE_MAX_ENTRIES) {
    const oldest = decisionCache.keys().next().value;
    if (oldest === undefined) break;
    decisionCache.delete(oldest);
  }
}

function coolingDown(entry: ProviderEntry, cooldownMs: number): number | null {
  if (cooldownMs <= 0) return null;
  const until = cooldowns.get(providerKey(entry));
  if (until === undefined) return null;
  const remaining = until - Date.now();
  if (remaining <= 0) {
    cooldowns.delete(providerKey(entry));
    return null;
  }
  return remaining;
}

/**
 * Open a connection to the first provider in the chain before the first real
 * decision needs it, so that decision does not also pay for DNS, TCP and TLS.
 * A provider that turns out to be unreachable goes straight into cooldown, so
 * the first decision falls through to the next provider instead of waiting out
 * a timeout. Never throws.
 */
export async function warmUp(): Promise<void> {
  const config = getConfig();
  const entry = providerChain(config)[0];
  if (!entry) return;
  try {
    const health = await buildProvider(entry).available();
    if (!health.ok && TUNING.providerCooldownMs > 0 && /unreachable/i.test(health.detail)) {
      cooldowns.set(providerKey(entry), Date.now() + TUNING.providerCooldownMs);
    }
  } catch {
    /* a warm-up is an optimisation; it has nothing to report */
  }
}

/** Forget cached answers and cooldowns. Test only. */
export function _resetDecisionMemory(): void {
  decisionCache.clear();
  cooldowns.clear();
}

/** How many decisions are cached and which providers are cooling down. */
export function decisionMemoryStats(): { cached: number; coolingDown: string[] } {
  const now = Date.now();
  return {
    cached: decisionCache.size,
    coolingDown: [...cooldowns.entries()].filter(([, until]) => until > now).map(([key]) => key.split("|")[0] ?? key),
  };
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
      "No provider configured. Ask the user to run /jev-setup, or add one by hand to ~/.pi/jev-config.json.",
    );
  }

  const key = cacheKey(options, chain);
  const hit = cacheGet(key, TUNING.cacheTtlMs);
  if (hit) {
    return { ...hit, latencyMs: 0, costUsd: 0, attempts: [], cached: true };
  }

  const attempts: Array<{ provider: string; error: string }> = [];
  const stateText = typeof options.state === "string" ? options.state : JSON.stringify(options.state) ?? "";

  for (const [index, entry] of chain.entries()) {
    // An explicitly requested provider is always tried: the caller asked for it
    // by name, and skipping it would answer a different question.
    const remaining = options.providerId ? null : coolingDown(entry, TUNING.providerCooldownMs);
    if (remaining !== null) {
      attempts.push({
        provider: entry.id,
        error: `skipped: failed recently, retrying in ${Math.ceil(remaining / 1000)} s`,
      });
      continue;
    }

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

      cooldowns.delete(providerKey(entry));
      const outcome: DecideOutcome = {
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
      cachePut(key, outcome, TUNING.cacheTtlMs);
      return outcome;
    } catch (error) {
      attempts.push({ provider: provider.id, error: (error as Error).message });
      // The caller cancelling is not the provider failing, so it earns no cooldown.
      if (!options.signal?.aborted && TUNING.providerCooldownMs > 0) {
        cooldowns.set(providerKey(entry), Date.now() + TUNING.providerCooldownMs);
      }
      // No retry on the same provider: Jev has no idempotency key, so a second
      // attempt may be charged twice. Move along the chain and let the caller
      // see which providers failed and why.
    }
  }

  const detail = attempts.map((attempt) => `  ${attempt.provider}: ${attempt.error}`).join("\n");
  throw new Error(`Every provider failed.\n${detail}`);
}

/** Health of the whole configured chain, for `/jev`. */
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
