/**
 * TypeSafe Jev provider.
 *
 * Two deliberate choices:
 *
 * 1. **No automatic retries.** TypeSafe documents that the endpoint has no
 *    idempotency key, so a retry may be charged twice for the same decision.
 *    A failed call is reported as failed; the caller decides whether to try a
 *    different provider.
 *
 * 2. **A hard timeout.** Jev is advertised at 70–500 ms. A call that takes
 *    thirty seconds is not slow Jev, it is an unreachable endpoint, and the
 *    fallback provider should get the turn instead.
 */

import type { ProviderEntry } from "../config.ts";
import type { DecisionProvider, DecisionRequest, DecisionResponse, ProviderHealth } from "../types.ts";
import { parseResponse, serialiseQuestions } from "../questions.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

export interface JevProviderOptions {
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

export class JevProvider implements DecisionProvider {
  readonly id: string;
  readonly label: string;
  readonly costPerMillionInput: number;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(entry: ProviderEntry, options: JevProviderOptions = {}) {
    this.id = entry.id;
    this.label = entry.name ?? `Jev (${entry.model ?? "jev-latest"})`;
    this.costPerMillionInput = entry.costPerMillionInput ?? 0.042;
    this.baseUrl = (entry.baseUrl ?? "https://api.typesafe.ai/v1").replace(/\/+$/, "");
    this.apiKey = entry.apiKey ?? "";
    this.model = entry.model ?? "jev-latest";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async available(): Promise<ProviderHealth> {
    if (!this.apiKey) return { ok: false, detail: "no API key configured" };
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) return { ok: true, detail: `reachable, ${this.model}` };
      if (response.status === 401 || response.status === 403) {
        return { ok: false, detail: `rejected the API key (HTTP ${response.status})` };
      }
      // A missing /models listing does not mean the systemone endpoint is down.
      return { ok: true, detail: `HTTP ${response.status} on /models, but the key was not rejected` };
    } catch (error) {
      return { ok: false, detail: `unreachable: ${(error as Error).message}` };
    }
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    if (!this.apiKey) throw new Error(`Provider "${this.id}" has no API key.`);

    const body = {
      model: this.model,
      state: request.state,
      questions: serialiseQuestions(request.questions),
    };

    const started = Date.now();
    const response = await this.fetchImpl(`${this.baseUrl}/systemone`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: request.signal ?? AbortSignal.timeout(request.timeoutMs ?? this.timeoutMs),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `Jev returned HTTP ${response.status} after ${Date.now() - started}ms: ${text.slice(0, 400)}`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Jev returned a non-JSON body: ${text.slice(0, 400)}`);
    }

    const parsed = parseResponse(payload, request.questions);

    return {
      answers: parsed.answers,
      model: parsed.model === "unknown" ? this.model : parsed.model,
      usage: { inputTokens: parsed.inputTokens, outputTokens: parsed.outputTokens },
      // Keep the raw body whenever a probability had to be substituted, so the
      // ledger can be used to fix the parser instead of guessing at it again.
      ...(parsed.degraded ? { raw: text.slice(0, 2_000) } : {}),
    };
  }
}
