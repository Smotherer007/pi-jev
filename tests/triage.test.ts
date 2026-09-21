import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { questionFor } from "../src/tools/jev-triage.ts";
import type { Candidate } from "../src/candidates.ts";

const candidate: Candidate = { key: "src/auth.ts", path: "src/auth.ts", preview: "export function login" };

/**
 * The wording of the question is the whole filter.
 *
 * A triage miss is silent — the agent reads five files instead of fifty, sees
 * only those five, and reaches a confident wrong conclusion with no error
 * anywhere — so the instruction has to name which of the two mistakes is the
 * expensive one. It used to say the opposite: it explained that a wrong drop
 * costs the answer and then asked for `false` when the excerpt was too thin to
 * tell, which withholds exactly the candidates the model could not judge.
 */
describe("the triage question", () => {
  it("keeps a candidate whose excerpt cannot decide the question", () => {
    const question = questionFor(0, candidate, { question: "where is authentication implemented?" });

    assert.match(question.instructions, /too thin to tell, answer true/);
    assert.match(question.criteria?.true ?? "", /too thin to rule it out/);
    assert.match(question.criteria?.false ?? "", /^The excerpt shows this candidate is not relevant/);
  });

  it("says why that asymmetry holds, rather than just asserting it", () => {
    const question = questionFor(0, candidate, { question: "q" });
    assert.match(question.instructions, /keeping a candidate that did not matter costs one file read/);
    assert.match(question.instructions, /dropping one that did costs the answer/);
  });

  it("takes the caller's own relevance criterion when they gave one", () => {
    const question = questionFor(3, candidate, { question: "q", criteria: "it shows the login handler" });
    assert.equal(question.id, "c3");
    assert.equal(question.type, "noul");
    assert.equal(question.criteria?.true, "it shows the login handler");
  });

  it("names the candidate in the question, so a batched call cannot mix them up", () => {
    const question = questionFor(7, { ...candidate, key: "src/billing.ts" }, { question: "where are invoices built?" });
    assert.equal(question.id, "c7");
    assert.match(question.instructions, /src\/billing\.ts/);
    assert.match(question.instructions, /where are invoices built\?/);
  });
});
