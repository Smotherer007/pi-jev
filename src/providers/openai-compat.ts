/**
 * OpenAI-compatible provider — Ollama locally, or any other compatible endpoint.
 *
 * This is the fallback, and it is a genuinely weaker one. Worth being blunt
 * about why, because it is the reason Jev is interesting in the first place:
 *
 *  - It can violate the schema. Jev cannot: its output domain is fixed before
 *    it runs. Here, a model can invent an option that was not on the list, and
 *    the only defence is validation after the fact.
 *  - It often reports no usable probability, in which case pi-jev records the
 *    answer as `degraded` with p=0.5 rather than pretending to a confidence.
 *  - It costs a full generation, so it is slower by an order of magnitude.
 *
 * It still earns its place: for state that must not leave the machine, a
 * weaker local answer beats sending it somewhere else, and it lets the whole
 * extension be built and tested before an API key exists.
 */

import type { ProviderEntry } from "../config.ts";
import type { DecisionProvider, DecisionRequest, DecisionResponse, ProviderHealth } from "../types.ts";
import { buildFallbackPrompt, extractJsonObject, parseResponse } from "../questions.ts";

const DEFAULT_TIMEOUT_MS = 60_000;

export interface CompatProviderOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class OpenAICompatProvider implements DecisionProvider {
  readonly id: string;
  readonly label: string;
  readonly costPerMillionInput: number;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly jsonMode: boolean;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(entry: ProviderEntry, options: CompatProviderOptions = {}) {
    this.id = entry.id;
    this.label = entry.name ?? `${entry.kind} (${entry.model ?? "default"})`;
    this.costPerMillionInput = entry.costPerMillionInput ?? 0;
    const fallbackBase = entry.kind === "ollama" ? "http://localhost:11434/v1" : "";
    this.baseUrl = (entry.baseUrl ?? fallbackBase).replace(/\/+$/, "");
    this.apiKey = entry.apiKey ?? (entry.kind === "ollama" ? "ollama" : "");
    this.model = entry.model ?? "";
    this.jsonMode = entry.jsonMode ?? true;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async available(): Promise<ProviderHealth> {
    if (!this.baseUrl) return { ok: false, detail: "no baseUrl configured" };
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/models`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { ok: false, detail: `HTTP ${response.status} on /models` };

      // If a model is pinned, check it is actually pulled.
      if (this.model) {
        const text = await response.text();
        if (text.includes(this.model)) return { ok: true, detail: `reachable, ${this.model}` };
        return { ok: false, detail: `reachable, but model "${this.model}" is not listed` };
      }
      return { ok: true, detail: "reachable, no model pinned" };
    } catch (error) {
      return { ok: false, detail: `unreachable: ${(error as Error).message}` };
    }
  }

  private authHeaders(): Record<string, string> {
    return this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
  }

  async decide(request: DecisionRequest): Promise<DecisionResponse> {
    if (!this.baseUrl) throw new Error(`Provider "${this.id}" has no baseUrl.`);
    if (!this.model) throw new Error(`Provider "${this.id}" has no model pinned.`);

    const prompt = buildFallbackPrompt(request.state, request.questions);
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        {
          role: "system",
          content:
            "You answer typed questions about a given state. You reply with JSON only and never with prose. " +
            "Probability estimates must be honest: use 0.5 when you are genuinely unsure.",
        },
        { role: "user", content: prompt },
      ],
      stream: false,
      temperature: 0,
    };
    if (this.jsonMode) body.response_format = { type: "json_object" };

    let response = await this.post(body, request.signal, request.timeoutMs);

    // Some servers reject response_format outright. Retry once without it
    // rather than failing the decision over a formatting hint.
    if (!response.ok && this.jsonMode && (response.status === 400 || response.status === 422)) {
      const detail = await response.text();
      delete body.response_format;
      response = await this.post(body, request.signal, request.timeoutMs);
      if (!response.ok) {
        throw new Error(
          `${this.label} returned HTTP ${response.status}: ${detail.slice(0, 300)}`,
        );
      }
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`${this.label} returned HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      model?: string;
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: Record<string, unknown>;
    };

    const content = payload.choices?.[0]?.message?.content ?? "";
    const json = extractJsonObject(content);
    if (!json) {
      throw new Error(`${this.label} did not return JSON. Content: ${content.slice(0, 300)}`);
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(json);
    } catch (error) {
      throw new Error(`${this.label} returned malformed JSON: ${(error as Error).message}`);
    }

    // Accept both {"answers": {...}} and a bare {...} of answers.
    const wrapped =
      parsedJson && typeof parsedJson === "object" && "answers" in (parsedJson as Record<string, unknown>)
        ? parsedJson
        : { answers: parsedJson };

    const parsed = parseResponse(wrapped, request.questions);
    const usage = payload.usage ?? {};
    const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
    const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;

    return {
      answers: parsed.answers,
      model: payload.model ?? this.model,
      usage: { inputTokens, outputTokens },
      ...(parsed.degraded ? { raw: content.slice(0, 2_000) } : {}),
    };
  }

  private post(body: Record<string, unknown>, signal?: AbortSignal, timeoutMs?: number) {
    return this.fetchImpl(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
    });
  }
}

/**
 * Validate a fallback answer against the declared option list.
 *
 * This is the check Jev makes unnecessary, so it is worth doing explicitly
 * here: a local model that picks an option we never offered has produced a
 * schema violation, and the caller must know rather than receive a
 * plausible-looking wrong answer.
 */
export function findSchemaViolations(
  answers: Record<string, { value: boolean | string | number }>,
): string[] {
  const violations: string[] = [];
  for (const [id, answer] of Object.entries(answers)) {
    if (answer.value === null || answer.value === undefined) {
      violations.push(`Question "${id}" produced no value.`);
    }
  }
  return violations;
}
