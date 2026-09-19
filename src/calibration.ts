/**
 * Calibration maths.
 *
 * Pure functions over `{ p, correct }` pairs, so they can be tested without a
 * provider, a network or a session.
 *
 * The point of this file: a probability is only useful if it means something.
 * Everything here answers one of two questions — "when it said 0.9, how often
 * was it right?" and "if I only act above a threshold, what do I buy and what
 * do I lose?"
 */

import type { AnswerValue, LedgerDecision, LedgerEntry, LedgerLabel, QuestionType } from "./types.ts";

export interface ProbabilityPair {
  p: number;
  correct: boolean;
}

export interface ReliabilityBin {
  /** Lower edge of the bin, e.g. 0.7 for the 0.7–0.8 bin. */
  from: number;
  to: number;
  n: number;
  /** Mean predicted probability in this bin. */
  meanPredicted: number;
  /** Observed accuracy in this bin. */
  observedAccuracy: number;
}

export interface ThresholdPoint {
  threshold: number;
  /** Share of answers at or above the threshold. */
  coverage: number;
  /** Accuracy among those. */
  precision: number;
  /** Accuracy below the threshold — the part you would have handed to a human. */
  belowAccuracy: number;
  n: number;
}

export interface CalibrationReport {
  total: number;
  labelled: number;
  /** Mean squared error of the probabilities. Lower is better; 0.25 = coin flip. */
  brier: number | null;
  /** Expected calibration error: mean |predicted − observed| across bins. */
  ece: number | null;
  /** Always-answer-the-majority-class baseline, for comparison with brier. */
  baseRate: number;
  baseBrier: number | null;
  bins: ReliabilityBin[];
  thresholds: ThresholdPoint[];
  /** Signed mean(predicted − observed). Positive means overconfident. */
  bias: number | null;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function brierScore(pairs: readonly ProbabilityPair[]): number | null {
  if (pairs.length === 0) return null;
  let sum = 0;
  for (const { p, correct } of pairs) {
    const diff = clamp01(p) - (correct ? 1 : 0);
    sum += diff * diff;
  }
  return sum / pairs.length;
}

export function reliabilityBins(pairs: readonly ProbabilityPair[], binCount = 10): ReliabilityBin[] {
  const bins: ReliabilityBin[] = [];
  const width = 1 / binCount;

  for (let i = 0; i < binCount; i += 1) {
    const from = i * width;
    // The last bin is inclusive on both edges so a probability of exactly 1 lands somewhere.
    const to = i === binCount - 1 ? 1 : (i + 1) * width;
    const inBin = pairs.filter(({ p }) => {
      const value = clamp01(p);
      return i === binCount - 1 ? value >= from && value <= to : value >= from && value < to;
    });

    const n = inBin.length;
    bins.push({
      from,
      to,
      n,
      meanPredicted: n === 0 ? 0 : inBin.reduce((acc, pair) => acc + clamp01(pair.p), 0) / n,
      observedAccuracy: n === 0 ? 0 : inBin.filter((pair) => pair.correct).length / n,
    });
  }
  return bins;
}

export function expectedCalibrationError(bins: readonly ReliabilityBin[], total: number): number | null {
  if (total === 0) return null;
  let sum = 0;
  for (const bin of bins) {
    if (bin.n === 0) continue;
    sum += (bin.n / total) * Math.abs(bin.meanPredicted - bin.observedAccuracy);
  }
  return sum;
}

/**
 * Sweep the decision threshold. This is the table that turns calibration into
 * a policy: at 0.9 you act on a small share of answers and are right most of
 * the time; at 0.5 you act on everything and accept more mistakes.
 */
export function thresholdSweep(pairs: readonly ProbabilityPair[]): ThresholdPoint[] {
  const points: ThresholdPoint[] = [];
  for (let step = 5; step <= 95; step += 5) {
    const threshold = step / 100;
    const above = pairs.filter((pair) => clamp01(pair.p) >= threshold);
    const below = pairs.filter((pair) => clamp01(pair.p) < threshold);
    points.push({
      threshold,
      coverage: pairs.length === 0 ? 0 : above.length / pairs.length,
      precision: above.length === 0 ? 0 : above.filter((pair) => pair.correct).length / above.length,
      belowAccuracy: below.length === 0 ? 0 : below.filter((pair) => pair.correct).length / below.length,
      n: above.length,
    });
  }
  return points;
}

export function calibrationReport(pairs: readonly ProbabilityPair[]): CalibrationReport {
  const total = pairs.length;
  const labelled = total;
  const baseRate = total === 0 ? 0 : pairs.filter((pair) => pair.correct).length / total;
  const bins = reliabilityBins(pairs);

  return {
    total,
    labelled,
    brier: brierScore(pairs),
    ece: expectedCalibrationError(bins, total),
    baseRate,
    // Predicting the base rate for every answer is the floor any model has to beat.
    baseBrier: total === 0 ? null : baseRate * (1 - baseRate) ** 2 + (1 - baseRate) * baseRate ** 2,
    bins,
    thresholds: thresholdSweep(pairs),
    bias:
      total === 0
        ? null
        : pairs.reduce((acc, pair) => acc + clamp01(pair.p), 0) / total - baseRate,
  };
}

/* --------------------------------------------------- ledger → observations */

export interface LabelledAnswer extends ProbabilityPair {
  decisionId: string;
  questionId: string;
  tool: string;
  provider: string;
  model: string;
  type: QuestionType;
  value: boolean | string | number;
  shadow: boolean;
}

/**
 * Join decisions with their labels.
 *
 * A label without a decision is dropped rather than guessed at, and a decision
 * without a label contributes to cost and latency statistics but not to
 * calibration — that is the honest reading of "we do not know yet".
 */
export function joinLabels(entries: readonly LedgerEntry[]): LabelledAnswer[] {
  const decisions = new Map<string, LedgerDecision>();
  const labels: LedgerLabel[] = [];

  for (const entry of entries) {
    if (entry.kind === "decision") decisions.set(entry.id, entry);
    else if (entry.kind === "label") labels.push(entry);
  }

  const out: LabelledAnswer[] = [];
  for (const label of labels) {
    const decision = decisions.get(label.decisionId);
    if (!decision) continue;
    const answer = decision.answers.find((a) => a.id === label.questionId);
    if (!answer) continue;

    out.push({
      decisionId: decision.id,
      questionId: answer.id,
      tool: decision.tool,
      provider: decision.provider,
      model: decision.model,
      type: answer.type,
      value: answer.value,
      shadow: decision.shadow,
      p: answer.p,
      correct: label.correct,
    });
  }
  return out;
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index] ?? 0;
}

export interface LedgerOverview {
  decisions: number;
  labels: number;
  shadowMisses: number;
  shadowDecisions: number;
  /** Answers recorded in shadow mode: logged but not acted on. */
  shadowAnswers: number;
  totalInputTokens: number;
  totalCostUsd: number;
  latencyP50: number;
  latencyP95: number;
  byProvider: Array<{ provider: string; model: string; n: number; costUsd: number; p50: number }>;
  byTool: Array<{ tool: string; n: number }>;
  firstTs: string | null;
  lastTs: string | null;
}

export function ledgerOverview(entries: readonly LedgerEntry[]): LedgerOverview {
  const decisions = entries.filter((entry): entry is LedgerDecision => entry.kind === "decision");
  const labels = entries.filter((entry) => entry.kind === "label").length;
  const shadowMisses = entries.filter((entry) => entry.kind === "shadow-miss").length;

  const providerMap = new Map<string, { provider: string; model: string; n: number; costUsd: number; latencies: number[] }>();
  const toolMap = new Map<string, number>();

  let totalInputTokens = 0;
  let totalCostUsd = 0;
  const latencies: number[] = [];

  for (const decision of decisions) {
    totalInputTokens += decision.usage.inputTokens;
    totalCostUsd += decision.costUsd;
    latencies.push(decision.latencyMs);
    toolMap.set(decision.tool, (toolMap.get(decision.tool) ?? 0) + 1);

    const key = `${decision.provider}\u0000${decision.model}`;
    const bucket = providerMap.get(key) ?? {
      provider: decision.provider,
      model: decision.model,
      n: 0,
      costUsd: 0,
      latencies: [],
    };
    bucket.n += 1;
    bucket.costUsd += decision.costUsd;
    bucket.latencies.push(decision.latencyMs);
    providerMap.set(key, bucket);
  }

  const timestamps = decisions.map((d) => d.ts).sort();

  return {
    decisions: decisions.length,
    labels,
    shadowMisses,
    shadowDecisions: decisions.filter((d) => d.shadow).length,
    shadowAnswers: decisions.filter((d) => d.shadow).reduce((acc, d) => acc + d.answers.length, 0),
    totalInputTokens,
    totalCostUsd,
    latencyP50: percentile(latencies, 0.5),
    latencyP95: percentile(latencies, 0.95),
    byProvider: [...providerMap.values()]
      .map((bucket) => ({
        provider: bucket.provider,
        model: bucket.model,
        n: bucket.n,
        costUsd: bucket.costUsd,
        p50: percentile(bucket.latencies, 0.5),
      }))
      .sort((a, b) => b.n - a.n),
    byTool: [...toolMap.entries()].map(([tool, n]) => ({ tool, n })).sort((a, b) => b.n - a.n),
    firstTs: timestamps[0] ?? null,
    lastTs: timestamps[timestamps.length - 1] ?? null,
  };
}
