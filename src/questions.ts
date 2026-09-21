/**
 * Question construction, request building and answer parsing.
 *
 * A note on honesty, because this file is where it matters.
 *
 * TypeSafe's public documentation describes the request shape (model, state,
 * questions with a type, instructions and criteria) but the *response* shape is
 * only shown in prose and blog code samples. Field names such as
 * `usage.inputTokens` versus `usage.input_tokens` are therefore inferred, not
 * verified against a live account.
 *
 * So the parser is written to accept every plausible spelling and to say so
 * when it had to guess, instead of silently coercing a wrong number into a
 * confident-looking probability.
 *
 * Both shapes below are now checked against the live endpoint and the published
 * documentation (`docs.typesafe.ai/primitives`), which is worth stating because
 * the two question types that carry criteria do *not* carry them the same way:
 *
 *   choice  criteria = map    option → meaning
 *   score   criteria = list   level descriptions, in order, and the order is
 *                             the numbering: level i is the i-th entry
 *   noul    criteria = map    optionally what yes and no mean
 *
 * Sending a score's levels as a map is rejected outright — HTTP 422, before any
 * tokens are spent — so `serialiseQuestion` converts, and the level a score
 * answer comes back as is recovered from the level numbering here.
 */

import type { AnswerValue, QuestionSpec, QuestionType } from "./types.ts";

/* ------------------------------------------------------------- normalising */

export class QuestionError extends Error {}

const TYPES: readonly QuestionType[] = ["noul", "choice", "score"];

export function isQuestionType(value: unknown): value is QuestionType {
  return typeof value === "string" && (TYPES as readonly string[]).includes(value);
}

/**
 * Validate and fill in a question. `criteria` is required for `choice` and
 * `score` because an option list without meanings is the single most common
 * way to get a useless answer out of a decision model.
 */
/** The endpoint answers HTTP 400 past this many score levels. */
export const MAX_SCORE_LEVELS = 10;

/**
 * Bring criteria into the one shape the rest of the package uses: a map keyed
 * by the option or level the caller named.
 *
 * The endpoint takes a different shape per question type, and getting that
 * wrong is not cosmetic — a score whose levels are sent as a map is refused
 * with HTTP 422 before a single token is spent on a decision. So the conversion
 * happens here, once, and no caller has to know which type wants what:
 *
 *  - `choice` needs a map. A list is rejected, because an unordered answer set
 *    with no labels is the most common way to get a useless answer.
 *  - `score` needs an ordered list. A list is therefore accepted and keyed
 *    "0".."n-1", because the position *is* the level number; a map is kept as
 *    written, and its key order is the level order.
 *  - `noul` optionally takes a map describing what yes and no mean. That is a
 *    real field, not decoration: it moves the reported probability, so it is
 *    sent rather than dropped.
 */
function normaliseCriteria(id: string, type: QuestionType, input: unknown): Record<string, string> | undefined {
  if (input === undefined) {
    if (type === "choice" || type === "score") {
      throw new QuestionError(
        `Question "${id}" is a ${type} and needs criteria: the options or levels with their meaning.`,
      );
    }
    return undefined;
  }

  let criteria: Record<string, string>;
  if (Array.isArray(input)) {
    if (type !== "score") {
      throw new QuestionError(
        `Question "${id}" is a ${type} and needs criteria as an object of option → meaning; ` +
          "only a score takes an ordered list of levels.",
      );
    }
    criteria = {};
    for (const [position, level] of input.entries()) {
      if (typeof level !== "string" || level.trim().length === 0) {
        throw new QuestionError(`Question "${id}" has an empty level description at position ${position}.`);
      }
      criteria[String(position)] = level;
    }
  } else if (typeof input === "object" && input !== null) {
    criteria = { ...(input as Record<string, string>) };
    for (const [option, meaning] of Object.entries(criteria)) {
      if (typeof meaning !== "string" || meaning.trim().length === 0) {
        throw new QuestionError(`Question "${id}" has an empty meaning for option "${option}".`);
      }
    }
  } else {
    throw new QuestionError(
      `Question "${id}" has criteria that are neither an object of option → meaning nor a list of levels.`,
    );
  }

  const count = Object.keys(criteria).length;
  if ((type === "choice" || type === "score") && count < 2) {
    throw new QuestionError(`Question "${id}" is a ${type} and needs at least two options.`);
  }
  if (type === "score" && count > MAX_SCORE_LEVELS) {
    throw new QuestionError(
      `Question "${id}" is a score with ${count} levels, and the endpoint accepts at most ${MAX_SCORE_LEVELS}. ` +
        "Fold together the levels you cannot describe distinctly, or split the judgement into two questions.",
    );
  }
  return criteria;
}

export function normaliseQuestion(input: Partial<QuestionSpec> & { id?: string }, index: number): QuestionSpec {
  const id = (input.id ?? `q${index + 1}`).trim();
  if (id.length === 0) throw new QuestionError("A question id must not be empty.");
  if (!isQuestionType(input.type)) {
    throw new QuestionError(`Question "${id}" needs a type of ${TYPES.join(", ")}.`);
  }
  const instructions = (input.instructions ?? "").trim();
  if (instructions.length === 0) {
    throw new QuestionError(`Question "${id}" needs instructions; the model never sees the id.`);
  }

  const criteria = normaliseCriteria(id, input.type, input.criteria);

  const spec: QuestionSpec = { id, type: input.type, instructions };
  if (criteria) spec.criteria = criteria;
  return spec;
}

export function normaliseQuestions(inputs: Array<Partial<QuestionSpec>>): QuestionSpec[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new QuestionError("At least one question is required.");
  }
  const specs = inputs.map((input, index) => normaliseQuestion(input, index));
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec.id)) throw new QuestionError(`Duplicate question id "${spec.id}".`);
    seen.add(spec.id);
  }
  return specs;
}

/* ---------------------------------------------------------------- payloads */

/**
 * Criteria in the shape the endpoint wants for this question type.
 *
 * A score's levels travel as an ordered array of descriptions, from the low end
 * of the scale to the high end, and the position in that array is the level
 * number. The keys of the map are ours: the model never sees a level's number,
 * which is why they are dropped here rather than folded into the description.
 */
function wireCriteria(spec: QuestionSpec): unknown {
  if (!spec.criteria) return undefined;
  if (spec.type !== "score") return spec.criteria;
  return Object.keys(spec.criteria).map((level) => spec.criteria?.[level] ?? "");
}

/**
 * The wire shape for one question. `id` is intentionally absent — the key of
 * the questions map carries it and the model gains nothing from a slug.
 */
export function serialiseQuestion(spec: QuestionSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: spec.type,
    instructions: spec.instructions,
  };
  const criteria = wireCriteria(spec);
  if (criteria) out.criteria = criteria;
  return out;
}

export function serialiseQuestions(specs: readonly QuestionSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of specs) out[spec.id] = serialiseQuestion(spec);
  return out;
}

/* ---------------------------------------------------------------- parsing */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pickNumber(source: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normaliseProbabilities(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record)) {
    const num = typeof raw === "number" ? raw : Number(raw);
    if (Number.isFinite(num)) out[key] = clamp01(num);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export interface ParsedAnswers {
  answers: Record<string, AnswerValue>;
  /** Set when one or more answers needed a substituted probability. */
  degraded: boolean;
  /** Human-readable notes about what could not be read. */
  notes: string[];
}

/**
 * Turn one raw answer object into an `AnswerValue`, or explain why it could
 * not be done. Never invents a probability: a missing one becomes `degraded`
 * with p=0.5 and a note, so the ledger shows it rather than hiding it.
 */
function argmaxKey(record: Record<string, number>): string | null {
  let best: string | null = null;
  for (const [key, value] of Object.entries(record)) {
    if (best === null || value > (record[best] ?? 0)) best = key;
  }
  return best;
}

/** "3" → 3, so a level that is a number stays one for arithmetic downstream. */
function numericOrText(value: string): string | number {
  const num = Number(value);
  return value.trim() !== "" && Number.isFinite(num) ? num : value;
}

/** Relabel a level distribution with the descriptions the caller declared. */
function relabelLevels(probabilities: Record<string, number>, levels: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(probabilities)) {
    const index = Number(key);
    const label = Number.isInteger(index) ? levels[index] : undefined;
    out[label ?? key] = value;
  }
  return out;
}

function parseAnswer(spec: QuestionSpec, raw: unknown, notes: string[]): AnswerValue | null {
  const id = spec.id;
  const expected = spec.type;
  const record = asRecord(raw);
  if (record === null) {
    // Some endpoints may return the bare value rather than an envelope.
    if (typeof raw === "number") {
      return { type: expected, p: clamp01(raw), value: expected === "noul" ? clamp01(raw) >= 0.5 : raw, degraded: true };
    }
    if (typeof raw === "boolean" || typeof raw === "string") {
      notes.push(`Answer "${id}" arrived as a bare ${typeof raw}; no probability was reported.`);
      return { type: expected, p: 0.5, value: raw, degraded: true };
    }
    notes.push(`Answer "${id}" has an unreadable shape.`);
    return null;
  }

  const probabilities = normaliseProbabilities(record.probabilities ?? record.distribution ?? record.probs);
  const confidence = pickNumber(record, ["confidence", "certainty"]);

  if (expected === "noul") {
    const p = pickNumber(record, ["noul", "probability", "prob", "p", "yes", "true"]);
    if (p === null) {
      const bool = record.value ?? record.answer;
      if (typeof bool === "boolean") {
        notes.push(`Answer "${id}" reported a boolean with no probability.`);
        return { type: "noul", p: bool ? 1 : 0, value: bool, degraded: true, ...(probabilities ? { probabilities } : {}) };
      }
      notes.push(`Answer "${id}" has no probability; the fallback provider may not emit one.`);
      return { type: "noul", p: 0.5, value: null === bool ? false : Boolean(bool), degraded: true };
    }
    const value = clamp01(p);
    const answer: AnswerValue = { type: "noul", p: value, value: value >= 0.5 };
    if (probabilities) answer.probabilities = probabilities;
    if (confidence !== null) answer.confidence = clamp01(confidence);
    return answer;
  }

  if (expected === "choice") {
    const choice = record.choice ?? record.option ?? record.answer ?? record.value ?? record.selected;
    if (typeof choice !== "string" || choice.length === 0) {
      notes.push(`Answer "${id}" is a choice but no option came back.`);
      return null;
    }
    // Trust the reported probability of the chosen option; fall back to the
    // distribution, then to confidence.
    let p = pickNumber(record, ["probability", "prob", "p"]);
    if (p === null && probabilities && probabilities[choice] !== undefined) p = probabilities[choice] ?? null;
    if (p === null && confidence !== null) p = confidence;
    const degraded = p === null;
    if (degraded) notes.push(`Answer "${id}" came back without a probability for the chosen option.`);
    const answer: AnswerValue = { type: "choice", p: clamp01(p ?? 0.5), value: choice };
    if (probabilities) answer.probabilities = probabilities;
    if (confidence !== null) answer.confidence = clamp01(confidence);
    if (degraded) answer.degraded = true;
    return answer;
  }

  // score
  //
  // The endpoint answers with a *position on the level number line*, not with a
  // level: `score` is each level number multiplied by its probability, so it can
  // land between two levels (the documented example is 0 x 0.0 + 1 x 0.57 +
  // 2 x 0.43 = 1.43 on a three-level scale). Code that needs one outcome rounds
  // it, which is what the API documentation recommends and what `value` here
  // carries, as one of the caller's own level names.
  //
  // `probabilities` is the distribution over level numbers, and where it is
  // present the peak is a better reading than the rounded mean: a score of 1.0
  // can mean all the weight is on level 1, or half of it on each of levels 0
  // and 2, and those are not the same claim. Reading the peak also gives the
  // probability that belongs to the level we report, which is the quantity
  // calibration is computed over.
  const position = pickNumber(record, ["score", "value", "level", "rating"]);
  if (position === null) {
    notes.push(`Answer "${id}" is a score but no numeric value came back.`);
    return null;
  }

  const levels = Object.keys(spec.criteria ?? {});
  const peak = probabilities ? argmaxKey(probabilities) : null;
  const peakIndex = peak === null ? Number.NaN : Number(peak);
  // Fall back to the rounded position when there is no distribution to read, or
  // when a provider keyed its levels by something that is not a level number.
  const levelIndex = Number.isInteger(peakIndex) ? peakIndex : Math.round(position);

  const label = levels[levelIndex];
  const scored: AnswerValue = {
    type: "score",
    p: clamp01(peak !== null ? probabilities?.[peak] ?? 0.5 : confidence ?? 0.5),
    value: label === undefined ? levelIndex : numericOrText(label),
  };
  if (probabilities) scored.probabilities = relabelLevels(probabilities, levels);
  if (confidence !== null) scored.confidence = clamp01(confidence);

  const scoreProbability = peak !== null ? probabilities?.[peak] ?? null : confidence;
  if (scoreProbability === null) {
    notes.push(`Answer "${id}" came back without a probability for the chosen level.`);
    scored.degraded = true;
  }
  return scored;
}

export interface ParseResult {
  answers: Record<string, AnswerValue>;
  model: string;
  inputTokens: number;
  outputTokens: number;
  degraded: boolean;
  notes: string[];
}

/** Find the answers map in a response that may or may not wrap it in `data`. */
export function findAnswersContainer(payload: unknown): Record<string, unknown> | null {
  const root = asRecord(payload);
  if (!root) return null;
  const direct = asRecord(root.answers);
  if (direct) return direct;
  const data = asRecord(root.data);
  if (data) {
    const nested = asRecord(data.answers);
    if (nested) return nested;
  }
  return null;
}

export function parseResponse(payload: unknown, specs: readonly QuestionSpec[]): ParseResult {
  const notes: string[] = [];
  const root = asRecord(payload) ?? {};
  const container = findAnswersContainer(payload);

  if (!container) {
    throw new Error(
      `The response carried no answers object. Raw payload: ${JSON.stringify(payload).slice(0, 400)}`,
    );
  }

  const answers: Record<string, AnswerValue> = {};
  let degraded = false;

  for (const spec of specs) {
    // Providers may key by question id or by position; the id is the contract.
    const parsed = parseAnswer(spec, container[spec.id], notes);
    if (parsed === null) {
      notes.push(`Question "${spec.id}" got no usable answer.`);
      continue;
    }
    if (parsed.degraded) degraded = true;
    answers[spec.id] = parsed;
  }

  if (Object.keys(answers).length === 0) {
    throw new Error(`No question could be answered. Notes: ${notes.join(" ")}`);
  }

  const usageSource = asRecord(root.usage) ?? asRecord(asRecord(root.data)?.usage) ?? {};
  const inputTokens = pickNumber(usageSource, ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "input"]) ?? 0;
  const outputTokens = pickNumber(usageSource, ["outputTokens", "output_tokens", "completionTokens", "completion_tokens", "output"]) ?? 0;

  const model =
    (typeof root.model === "string" && root.model) ||
    (typeof asRecord(root.data)?.model === "string" && (asRecord(root.data)?.model as string)) ||
    "unknown";

  return { answers, model, inputTokens, outputTokens, degraded, notes };
}

/* --------------------------------------------------------- loose fallback */

/**
 * Extract the first JSON object from free text. Local models wrap JSON in
 * prose or fences often enough that a strict `JSON.parse` wastes a whole turn.
 */
export function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();

  const start = candidate.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const char = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Render questions as instructions for a plain chat model. Explicit about
 * probabilities, because a model that only returns an option gives us nothing
 * to calibrate on.
 */
export function buildFallbackPrompt(state: unknown, specs: readonly QuestionSpec[]): string {
  const lines: string[] = [];
  lines.push("You are answering typed questions about the STATE below.");
  lines.push("Answer every question. Reply with JSON only, no prose, no code fences.");
  lines.push("");
  lines.push("## STATE");
  lines.push(typeof state === "string" ? state : JSON.stringify(state, null, 2));
  lines.push("");
  lines.push("## QUESTIONS");
  for (const spec of specs) {
    lines.push("");
    lines.push(`### ${spec.id} (type: ${spec.type})`);
    lines.push(spec.instructions);
    if (spec.criteria) {
      lines.push(spec.type === "score" ? "Levels, in order from low to high:" : "Options:");
      let position = 0;
      for (const [option, meaning] of Object.entries(spec.criteria)) {
        // A score's levels are numbered from 0 by their position, the same way
        // the endpoint numbers them, so the local model answers in the same
        // numbering the rest of this file reads back.
        lines.push(spec.type === "score" ? `  - level ${position}: ${meaning}` : `  - ${option}: ${meaning}`);
        position += 1;
      }
    }
  }
  lines.push("");
  lines.push("## OUTPUT");
  lines.push('Reply with {"answers": { ... }} where each entry matches its type:');
  lines.push('  noul   -> {"noul": <probability 0..1>}');
  lines.push('  choice -> {"choice": "<option>", "probabilities": {"<option>": <probability 0..1>, ...}}');
  lines.push('  score  -> {"score": <level number, 0 for the first level>, "confidence": <probability 0..1>}');
  lines.push("Probabilities must be honest estimates, not 1.0 by default.");

  if (!specs.some((spec) => spec.type !== "noul")) {
    lines.push('');
    lines.push('Example: {"answers": {' + specs.map((spec) => `"${spec.id}": {"noul": 0.82}`).join(", ") + "}}");
  }
  return lines.join("\n");
}
