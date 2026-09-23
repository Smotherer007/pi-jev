import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  brierScore,
  calibrationReport,
  expectedCalibrationError,
  joinLabels,
  ledgerOverview,
  percentile,
  reliabilityBins,
  thresholdSweep,
  type ProbabilityPair,
} from "../src/calibration.ts";
import type { LedgerDecision, LedgerEntry, LedgerLabel } from "../src/types.ts";

function decision(overrides: Partial<LedgerDecision> = {}): LedgerDecision {
  return {
    kind: "decision",
    id: "dec_1",
    ts: "2026-09-19T10:00:00.000Z",
    tool: "jev_verify",
    purpose: "verify 1 claim",
    provider: "jev",
    model: "jev-latest",
    shadow: false,
    stateHash: "abc123",
    stateChars: 100,
    latencyMs: 120,
    usage: { inputTokens: 1_000, outputTokens: 0 },
    costUsd: 0.000042,
    answers: [{ id: "claim0", type: "noul", p: 0.9, value: true }],
    ...overrides,
  };
}

function label(overrides: Partial<LedgerLabel> = {}): LedgerLabel {
  return {
    kind: "label",
    id: "lbl_1",
    ts: "2026-09-19T11:00:00.000Z",
    decisionId: "dec_1",
    questionId: "claim0",
    correct: true,
    ...overrides,
  };
}

describe("brierScore", () => {
  it("returns null for no observations", () => {
    assert.equal(brierScore([]), null);
  });

  it("is zero for perfectly confident correct answers", () => {
    const pairs: ProbabilityPair[] = [
      { p: 1, correct: true },
      { p: 0, correct: false },
    ];
    assert.equal(brierScore(pairs), 0);
  });

  it("is 0.25 when every answer is a coin flip", () => {
    const pairs: ProbabilityPair[] = [
      { p: 0.5, correct: true },
      { p: 0.5, correct: false },
    ];
    assert.equal(brierScore(pairs), 0.25);
  });

  it("penalises a confident wrong answer more than an unsure one", () => {
    const confident = brierScore([{ p: 0.95, correct: false }]) ?? 0;
    const unsure = brierScore([{ p: 0.6, correct: false }]) ?? 0;
    assert.ok(confident > unsure);
  });

  it("clamps out-of-range probabilities instead of trusting them", () => {
    assert.equal(brierScore([{ p: 5, correct: true }]), 0);
    assert.equal(brierScore([{ p: -1, correct: false }]), 0);
  });
});

describe("reliabilityBins", () => {
  it("always returns the requested number of bins", () => {
    assert.equal(reliabilityBins([], 10).length, 10);
    assert.equal(reliabilityBins([{ p: 0.5, correct: true }], 5).length, 5);
  });

  it("places an answer of exactly 1 in the last bin", () => {
    const bins = reliabilityBins([{ p: 1, correct: true }], 10);
    assert.equal(bins[9]?.n, 1);
    assert.equal(bins.reduce((sum, bin) => sum + bin.n, 0), 1);
  });

  it("reports observed accuracy per bin", () => {
    const pairs: ProbabilityPair[] = [
      { p: 0.75, correct: true },
      { p: 0.75, correct: true },
      { p: 0.75, correct: false },
      { p: 0.75, correct: false },
    ];
    const bin = reliabilityBins(pairs, 10)[7];
    assert.equal(bin?.n, 4);
    assert.equal(bin?.meanPredicted, 0.75);
    assert.equal(bin?.observedAccuracy, 0.5);
  });

  it("leaves empty bins at zero rather than dropping them", () => {
    const bin = reliabilityBins([{ p: 0.15, correct: true }], 10)[5];
    assert.equal(bin?.n, 0);
    assert.equal(bin?.observedAccuracy, 0);
  });
});

describe("expectedCalibrationError", () => {
  it("is null with no observations", () => {
    assert.equal(expectedCalibrationError(reliabilityBins([]), 0), null);
  });

  it("is zero for a perfectly calibrated set", () => {
    // Ten answers at 0.3 of which exactly three are correct.
    const pairs: ProbabilityPair[] = Array.from({ length: 10 }, (_, index) => ({ p: 0.3, correct: index < 3 }));
    const bins = reliabilityBins(pairs);
    const ece = expectedCalibrationError(bins, pairs.length) ?? 1;
    assert.ok(ece < 0.001, `expected near zero, got ${ece}`);
  });

  it("grows as calibration gets worse", () => {
    const good: ProbabilityPair[] = Array.from({ length: 10 }, (_, index) => ({ p: 0.9, correct: index < 9 }));
    const bad: ProbabilityPair[] = Array.from({ length: 10 }, (_, index) => ({ p: 0.9, correct: index < 2 }));
    const goodEce = expectedCalibrationError(reliabilityBins(good), good.length) ?? 0;
    const badEce = expectedCalibrationError(reliabilityBins(bad), bad.length) ?? 0;
    assert.ok(badEce > goodEce);
  });
});

describe("thresholdSweep", () => {
  it("covers the whole set at the lowest threshold and less as it rises", () => {
    const pairs: ProbabilityPair[] = [
      { p: 0.1, correct: false },
      { p: 0.5, correct: true },
      { p: 0.9, correct: true },
    ];
    const sweep = thresholdSweep(pairs);
    const low = sweep[0];
    const high = sweep[sweep.length - 1];
    assert.equal(low?.threshold, 0.05);
    assert.equal(low?.coverage, 1);
    assert.ok((high?.coverage ?? 0) < (low?.coverage ?? 0));
  });

  it("reports how accurate the below-threshold answers were", () => {
    const pairs: ProbabilityPair[] = [
      { p: 0.9, correct: true },
      { p: 0.2, correct: false },
    ];
    const point = thresholdSweep(pairs).find((entry) => entry.threshold === 0.5);
    assert.equal(point?.n, 1);
    assert.equal(point?.precision, 1);
    assert.equal(point?.belowAccuracy, 0);
  });
});

describe("calibrationReport", () => {
  it("beats the base-rate baseline when the probabilities carry information", () => {
    const pairs: ProbabilityPair[] = [
      ...Array.from({ length: 10 }, () => ({ p: 0.9, correct: true })),
      ...Array.from({ length: 10 }, () => ({ p: 0.1, correct: false })),
    ];
    const report = calibrationReport(pairs);
    assert.ok(report.brier !== null && report.baseBrier !== null);
    assert.ok(report.brier < report.baseBrier);
    assert.equal(report.baseRate, 0.5);
  });

  it("loses to the baseline when the probabilities are anti-correlated", () => {
    const pairs: ProbabilityPair[] = [
      ...Array.from({ length: 10 }, () => ({ p: 0.9, correct: false })),
      ...Array.from({ length: 10 }, () => ({ p: 0.1, correct: true })),
    ];
    const report = calibrationReport(pairs);
    assert.ok(report.brier !== null && report.baseBrier !== null);
    assert.ok(report.brier > report.baseBrier);
    // Anti-correlation is not the same as overconfidence: the average claim is
    // still 0.5 and the base rate is 0.5, so bias is zero. Only the Brier score
    // reveals that the probabilities point the wrong way.
    assert.ok(Math.abs(report.bias ?? 1) < 1e-9, `expected ~0, got ${report.bias}`);
  });

  it("reports positive bias when the model claims more certainty than it has", () => {
    const pairs: ProbabilityPair[] = [
      ...Array.from({ length: 10 }, () => ({ p: 0.9, correct: false })),
      ...Array.from({ length: 10 }, () => ({ p: 0.8, correct: true })),
    ];
    const report = calibrationReport(pairs);
    assert.ok((report.bias ?? 0) > 0, "claiming 0.85 while being right half the time is overconfidence");
  });

  it("reports negative bias when the model hedges more than it needs to", () => {
    const pairs: ProbabilityPair[] = [
      ...Array.from({ length: 10 }, () => ({ p: 0.2, correct: false })),
      ...Array.from({ length: 10 }, () => ({ p: 0.3, correct: true })),
    ];
    const report = calibrationReport(pairs);
    assert.ok((report.bias ?? 0) < 0);
  });
});

describe("percentile", () => {
  it("handles the empty case without throwing", () => {
    assert.equal(percentile([], 0.5), 0);
  });

  it("returns the median and the maximum", () => {
    assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
    assert.equal(percentile([1, 2, 3, 4, 5], 1), 5);
  });
});

describe("joinLabels", () => {
  it("pairs a label with its decision", () => {
    const entries: LedgerEntry[] = [decision(), label()];
    const joined = joinLabels(entries);
    assert.equal(joined.length, 1);
    assert.equal(joined[0]?.p, 0.9);
    assert.equal(joined[0]?.correct, true);
    assert.equal(joined[0]?.tool, "jev_verify");
  });

  it("drops a label whose decision is gone rather than guessing", () => {
    const entries: LedgerEntry[] = [label({ decisionId: "dec_missing" })];
    assert.deepEqual(joinLabels(entries), []);
  });

  it("drops a label naming a question the decision does not have", () => {
    const entries: LedgerEntry[] = [decision(), label({ questionId: "nope" })];
    assert.deepEqual(joinLabels(entries), []);
  });

  it("ignores decisions that were never labelled", () => {
    const entries: LedgerEntry[] = [decision(), decision({ id: "dec_2" })];
    assert.deepEqual(joinLabels(entries), []);
  });
});

describe("ledgerOverview", () => {
  it("is all zeroes for an empty ledger", () => {
    const overview = ledgerOverview([]);
    assert.equal(overview.decisions, 0);
    assert.equal(overview.totalCostUsd, 0);
    assert.equal(overview.firstTs, null);
  });

  it("aggregates cost, tokens, latency and grouping keys", () => {
    const entries: LedgerEntry[] = [
      decision(),
      decision({ id: "dec_2", provider: "local", model: "local-model", latencyMs: 900, costUsd: 0, tool: "jev_triage", shadow: true }),
      decision({ id: "dec_3", provider: "local", model: "local-model", latencyMs: 1_100, costUsd: 0, tool: "jev_triage" }),
      label(),
    ];
    const overview = ledgerOverview(entries);
    assert.equal(overview.decisions, 3);
    assert.equal(overview.labels, 1);
    assert.equal(overview.shadowDecisions, 1);
    assert.equal(overview.totalInputTokens, 3_000);
    assert.equal(overview.byProvider.length, 2);
    assert.equal(overview.byProvider[0]?.n, 2);
    assert.equal(overview.byTool[0]?.tool, "jev_triage");
    assert.equal(overview.byTool[0]?.n, 2);
    assert.equal(overview.firstTs, "2026-09-19T10:00:00.000Z");
  });

  it("counts shadow misses separately from decisions", () => {
    const entries: LedgerEntry[] = [
      decision(),
      { kind: "shadow-miss", id: "shm_1", ts: "2026-09-19T12:00:00.000Z", decisionId: "dec_1", item: "src/x.ts", via: "read" },
    ];
    assert.equal(ledgerOverview(entries).shadowMisses, 1);
    assert.equal(ledgerOverview(entries).decisions, 1);
  });
});

describe("used versus missed", () => {
  it("counts one triage call once, however many chunks it wrote", () => {
    const entries: LedgerEntry[] = [
      decision({ id: "d1", tool: "jev_triage", purpose: "triage: auth", ts: "2026-09-19T10:00:00.000Z" }),
      decision({ id: "d2", tool: "jev_triage", purpose: "triage: auth", ts: "2026-09-19T10:00:00.400Z" }),
      decision({ id: "d3", tool: "jev_triage", purpose: "triage: billing", ts: "2026-09-19T10:05:00.000Z" }),
      decision({ id: "d4", tool: "jev_verify" }),
      decision({ id: "d5", tool: "jev_gate_hook" }),
      { kind: "opportunity", id: "o1", ts: "2026-09-19T11:00:00.000Z", tool: "jev_triage", detail: "grep: 40 results" },
      { kind: "opportunity", id: "o2", ts: "2026-09-19T11:00:00.000Z", tool: "jev_verify", detail: "2 edits, no verify" },
    ];
    const overview = ledgerOverview(entries);
    assert.deepEqual(overview.usage, [
      { tool: "jev_triage", used: 2, missed: 1 },
      { tool: "jev_verify", used: 1, missed: 1 },
    ]);
    assert.equal(overview.hookDecisions, 1);
    // Opportunities are not decisions.
    assert.equal(overview.decisions, 5);
  });
});
