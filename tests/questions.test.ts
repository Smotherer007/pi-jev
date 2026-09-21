import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  QuestionError,
  buildFallbackPrompt,
  extractJsonObject,
  findAnswersContainer,
  normaliseQuestion,
  normaliseQuestions,
  parseResponse,
  serialiseQuestion,
  serialiseQuestions,
} from "../src/questions.ts";
import type { QuestionSpec } from "../src/types.ts";

const noul: QuestionSpec = {
  id: "is_sponsor",
  type: "noul",
  instructions: "Does the description ask to sponsor the newsletter?",
};

const choice: QuestionSpec = {
  id: "dept",
  type: "choice",
  instructions: "Which team handles this?",
  criteria: { billing: "Charges and refunds", tech: "Bugs and outages" },
};

const score: QuestionSpec = {
  id: "severity",
  type: "score",
  instructions: "How severe is the bug?",
  criteria: { "0": "cosmetic", "1": "workaround exists", "2": "no workaround" },
};

describe("normaliseQuestion", () => {
  it("accepts a well-formed noul", () => {
    assert.equal(normaliseQuestion(noul, 0).id, "is_sponsor");
  });

  it("generates an id when none is given", () => {
    assert.equal(normaliseQuestion({ type: "noul", instructions: "x?" }, 2).id, "q3");
  });

  it("rejects an unknown type", () => {
    assert.throws(() => normaliseQuestion({ type: "boolean" as never, instructions: "x?" }, 0), QuestionError);
  });

  it("rejects empty instructions, because the id never reaches the model", () => {
    assert.throws(() => normaliseQuestion({ type: "noul", instructions: "   " }, 0), /never sees the id/);
  });

  it("requires criteria for a choice", () => {
    assert.throws(() => normaliseQuestion({ id: "d", type: "choice", instructions: "which?" }, 0), /needs criteria/);
  });

  it("requires at least two options for a choice", () => {
    assert.throws(
      () => normaliseQuestion({ id: "d", type: "choice", instructions: "which?", criteria: { only: "one" } }, 0),
      /at least two options/,
    );
  });

  it("allows criteria to be omitted for a noul", () => {
    assert.doesNotThrow(() => normaliseQuestion({ id: "n", type: "noul", instructions: "yes or no?" }, 0));
  });

  it("rejects an empty option meaning", () => {
    assert.throws(
      () => normaliseQuestion({ id: "c", type: "choice", instructions: "which?", criteria: { a: " ", b: "ok" } }, 0),
      /empty meaning/,
    );
  });

  it("rejects a list of criteria for a choice, which takes a map of options", () => {
    assert.throws(
      () => normaliseQuestion({ id: "c", type: "choice", instructions: "which?", criteria: ["a", "b"] as never }, 0),
      /only a score takes an ordered list/,
    );
  });

  it("numbers the levels of a score given as a list, because the position is the level", () => {
    const spec = normaliseQuestion(
      { id: "s", type: "score", instructions: "how bad?", criteria: ["low", "middling", "high"] as never },
      0,
    );
    assert.deepEqual(spec.criteria, { "0": "low", "1": "middling", "2": "high" });
  });

  it("rejects a score with more levels than the endpoint accepts", () => {
    const eleven = Array.from({ length: 11 }, (_, index) => `level ${index}`);
    assert.throws(
      () => normaliseQuestion({ id: "s", type: "score", instructions: "how bad?", criteria: eleven as never }, 0),
      /at most 10/,
    );
  });

  it("rejects an empty level description inside a score's list", () => {
    assert.throws(
      () => normaliseQuestion({ id: "s", type: "score", instructions: "how bad?", criteria: ["low", " "] as never }, 0),
      /empty level description at position 1/,
    );
  });

  it("keeps a noul's criteria as a map, which the endpoint does use", () => {
    const spec = normaliseQuestion(
      { id: "n", type: "noul", instructions: "is it urgent?", criteria: { true: "it is", false: "it is not" } },
      0,
    );
    assert.deepEqual(spec.criteria, { true: "it is", false: "it is not" });
  });
});

describe("normaliseQuestions", () => {
  it("rejects an empty list", () => {
    assert.throws(() => normaliseQuestions([]), QuestionError);
  });

  it("rejects duplicate ids, which would make answers ambiguous", () => {
    assert.throws(() => normaliseQuestions([noul, { ...noul }]), /Duplicate question id/);
  });

  it("keeps distinct questions apart", () => {
    assert.deepEqual(normaliseQuestions([noul, choice]).map((spec) => spec.id), ["is_sponsor", "dept"]);
  });
});

describe("serialiseQuestion", () => {
  it("omits the id, which is ours and not the model's", () => {
    const wire = serialiseQuestion(noul);
    assert.equal(wire.id, undefined);
    assert.equal(wire.type, "noul");
    assert.equal(wire.instructions, noul.instructions);
  });

  it("keeps a choice's criteria as the map that names its options", () => {
    assert.deepEqual(serialiseQuestion(choice).criteria, choice.criteria);
  });

  it("sends a score's levels as an ordered list, which is the only shape the endpoint takes", () => {
    // A map here is HTTP 422 before a single token is spent: the endpoint wants
    // the levels in order, and the position in that array is the level number.
    // The keys of our map are ours — the model never sees a level's number.
    const spec = normaliseQuestion(
      {
        id: "blast",
        type: "score",
        instructions: "How far does the damage reach?",
        criteria: { "1": "this machine", "2": "several files", "3": "a shared system", "4": "production" },
      },
      0,
    );
    assert.deepEqual(serialiseQuestion(spec).criteria, [
      "this machine",
      "several files",
      "a shared system",
      "production",
    ]);
  });

  it("keeps a noul's criteria as a map of what yes and no mean", () => {
    const spec = normaliseQuestion(
      { id: "safe", type: "noul", instructions: "is it safe?", criteria: { true: "safe", false: "confirm first" } },
      0,
    );
    assert.deepEqual(serialiseQuestion(spec).criteria, { true: "safe", false: "confirm first" });
  });

  it("keys the questions map by id", () => {
    const wire = serialiseQuestions([noul, choice]);
    assert.deepEqual(Object.keys(wire), ["is_sponsor", "dept"]);
  });
});

describe("findAnswersContainer", () => {
  it("finds a top-level answers object", () => {
    assert.deepEqual(findAnswersContainer({ answers: { a: 1 } }), { a: 1 });
  });

  it("finds answers nested under data", () => {
    assert.deepEqual(findAnswersContainer({ data: { answers: { a: 1 } } }), { a: 1 });
  });

  it("returns null when there is none", () => {
    assert.equal(findAnswersContainer({ result: {} }), null);
    assert.equal(findAnswersContainer("nonsense"), null);
  });
});

describe("parseResponse", () => {
  it("reads a noul and treats it as yes above one half", () => {
    const parsed = parseResponse({ answers: { is_sponsor: { type: "noul", noul: 0.93 } } }, [noul]);
    assert.equal(parsed.answers.is_sponsor?.p, 0.93);
    assert.equal(parsed.answers.is_sponsor?.value, true);
    assert.equal(parsed.degraded, false);
  });

  it("reads a no as false", () => {
    const parsed = parseResponse({ answers: { is_sponsor: { noul: 0.11 } } }, [noul]);
    assert.equal(parsed.answers.is_sponsor?.value, false);
    assert.equal(parsed.answers.is_sponsor?.p, 0.11);
  });

  it("reads a choice with its distribution", () => {
    const parsed = parseResponse(
      { answers: { dept: { type: "choice", choice: "billing", probabilities: { billing: 0.84, tech: 0.16 }, confidence: 0.6 } } },
      [choice],
    );
    const answer = parsed.answers.dept;
    assert.equal(answer?.value, "billing");
    assert.equal(answer?.p, 0.84);
    assert.equal(answer?.confidence, 0.6);
    assert.equal(answer?.probabilities?.tech, 0.16);
  });

  it("falls back to the distribution when no explicit probability is given", () => {
    const parsed = parseResponse(
      { answers: { dept: { choice: "tech", probabilities: { billing: 0.2, tech: 0.8 } } } },
      [choice],
    );
    assert.equal(parsed.answers.dept?.p, 0.8);
  });

  it("falls back to confidence when there is neither probability nor distribution", () => {
    const parsed = parseResponse({ data: { answers: { dept: { choice: "tech", confidence: 0.7 } } } }, [choice]);
    assert.equal(parsed.answers.dept?.p, 0.7);
    assert.equal(parsed.answers.dept?.degraded, undefined);
  });

  it("marks a choice with no probability at all as degraded rather than inventing confidence", () => {
    const parsed = parseResponse({ answers: { dept: { choice: "tech" } } }, [choice]);
    assert.equal(parsed.answers.dept?.degraded, true);
    assert.equal(parsed.answers.dept?.p, 0.5);
    assert.equal(parsed.degraded, true);
    assert.ok(parsed.notes.some((note) => note.includes("without a probability")));
  });

  it("marks a bare boolean noul as degraded", () => {
    const parsed = parseResponse({ answers: { is_sponsor: { value: true } } }, [noul]);
    assert.equal(parsed.answers.is_sponsor?.degraded, true);
    assert.equal(parsed.answers.is_sponsor?.p, 1);
  });

  it("reads a score as one of the caller's own levels, from the peak of the distribution", () => {
    // 0 x 0.0 + 1 x 0.57 + 2 x 0.43 = 1.43: the position sits between levels 1
    // and 2, so the distribution decides which level is reported. Captured from
    // the live endpoint, arithmetic and all.
    const parsed = parseResponse(
      {
        answers: {
          severity: {
            type: "score",
            score: 1.43,
            confidence: 0.35,
            legend: { 0: "cosmetic", 1: "workaround exists", 2: "no workaround" },
            probabilities: { 0: 0, 1: 0.57, 2: 0.43 },
          },
        },
      },
      [score],
    );
    assert.equal(parsed.answers.severity?.value, 1);
    assert.equal(parsed.answers.severity?.p, 0.57);
    assert.equal(parsed.answers.severity?.confidence, 0.35);
    // The criteria keys here are the level numbers themselves, so the
    // distribution comes back under the numbers it arrived with.
    assert.deepEqual(parsed.answers.severity?.probabilities, { "0": 0, "1": 0.57, "2": 0.43 });
    assert.equal(parsed.answers.severity?.degraded, undefined);
  });

  it("names the level it reports when the caller named its levels", () => {
    const named: QuestionSpec = {
      id: "severity",
      type: "score",
      instructions: "How severe is the bug?",
      criteria: { cosmetic: "looks wrong", "workaround exists": "broken, but there is a way round it", "no workaround": "nothing works" },
    };
    const parsed = parseResponse(
      { answers: { severity: { type: "score", score: 1.43, confidence: 0.35, probabilities: { 0: 0, 1: 0.57, 2: 0.43 } } } },
      [named],
    );
    // Level 1, in the caller's own vocabulary, with the probability of *that*
    // level rather than the confidence of the whole position.
    assert.equal(parsed.answers.severity?.value, "workaround exists");
    assert.equal(parsed.answers.severity?.p, 0.57);
    assert.deepEqual(parsed.answers.severity?.probabilities, {
      cosmetic: 0,
      "workaround exists": 0.57,
      "no workaround": 0.43,
    });
  });

  it("maps a score back to a named level, which is what jev_gate's blast radius is", () => {
    const blast: QuestionSpec = {
      id: "blast",
      type: "score",
      instructions: "How far does the damage reach?",
      criteria: { "1": "this machine", "2": "several files", "3": "a shared system", "4": "production" },
    };
    const parsed = parseResponse(
      {
        answers: {
          blast: {
            type: "score",
            score: 2.99,
            confidence: 0.99,
            probabilities: { 0: 0, 1: 0, 2: 0, 3: 1 },
          },
        },
      },
      [blast],
    );
    assert.equal(parsed.answers.blast?.value, 4);
    assert.equal(parsed.answers.blast?.p, 1);
  });

  it("rounds the position when no distribution comes back, because a level is what was asked for", () => {
    const parsed = parseResponse({ answers: { severity: { type: "score", score: 1.6, confidence: 0.55 } } }, [score]);
    assert.equal(parsed.answers.severity?.value, 2);
    assert.equal(parsed.answers.severity?.p, 0.55);
  });

  it("marks a score with neither a distribution nor a confidence as degraded", () => {
    const parsed = parseResponse({ answers: { severity: { score: 1.4 } } }, [score]);
    assert.equal(parsed.answers.severity?.value, 1);
    assert.equal(parsed.answers.severity?.p, 0.5);
    assert.equal(parsed.answers.severity?.degraded, true);
  });

  it("clamps probabilities into 0..1 instead of propagating nonsense", () => {
    const parsed = parseResponse({ answers: { is_sponsor: { noul: 1.7 } } }, [noul]);
    assert.equal(parsed.answers.is_sponsor?.p, 1);
  });

  it("accepts numbers as strings, because some endpoints stringify them", () => {
    const parsed = parseResponse({ answers: { is_sponsor: { noul: "0.42" } } }, [noul]);
    assert.equal(parsed.answers.is_sponsor?.p, 0.42);
  });

  it("collects a note for a question that got no usable answer", () => {
    const parsed = parseResponse({ answers: { dept: { choice: "" }, is_sponsor: { noul: 0.8 } } }, [choice, noul]);
    assert.equal(parsed.answers.is_sponsor?.p, 0.8);
    assert.equal(parsed.answers.dept, undefined);
    assert.ok(parsed.notes.some((note) => note.includes("dept")));
  });

  it("still answers the questions that did come back", () => {
    const parsed = parseResponse({ answers: { is_sponsor: { noul: 0.2 } } }, [choice, noul]);
    assert.ok(parsed.answers.is_sponsor);
    assert.equal(parsed.answers.dept, undefined);
    assert.equal(parsed.degraded, false);
  });

  it("throws when no answers object is present at all", () => {
    assert.throws(() => parseResponse({ result: "nope" }, [noul]), /no answers object/);
  });

  it("throws when nothing could be answered, naming every reason", () => {
    assert.throws(() => parseResponse({ answers: {} }, [noul]), /No question could be answered.*unreadable shape/s);
  });

  it("reads usage across the field-name spellings seen in the wild", () => {
    const a = parseResponse({ answers: { is_sponsor: { noul: 0.5 } }, usage: { inputTokens: 10, outputTokens: 2 } }, [noul]);
    assert.deepEqual({ i: a.inputTokens, o: a.outputTokens }, { i: 10, o: 2 });

    const b = parseResponse({ answers: { is_sponsor: { noul: 0.5 } }, usage: { input_tokens: 11, output_tokens: 3 } }, [noul]);
    assert.deepEqual({ i: b.inputTokens, o: b.outputTokens }, { i: 11, o: 3 });

    const c = parseResponse({ answers: { is_sponsor: { noul: 0.5 } }, usage: { prompt_tokens: 12, completion_tokens: 4 } }, [noul]);
    assert.deepEqual({ i: c.inputTokens, o: c.outputTokens }, { i: 12, o: 4 });
  });

  it("reports zero usage rather than throwing when usage is missing", () => {
    const parsed = parseResponse({ answers: { is_sponsor: { noul: 0.5 } } }, [noul]);
    assert.equal(parsed.inputTokens, 0);
  });

  it("picks up the model id when the endpoint reports one", () => {
    const parsed = parseResponse({ answers: { is_sponsor: { noul: 0.5 } }, model: "jev-1.13.0" }, [noul]);
    assert.equal(parsed.model, "jev-1.13.0");
  });
});

describe("extractJsonObject", () => {
  it("returns a bare object unchanged", () => {
    assert.equal(extractJsonObject('{"a":1}'), '{"a":1}');
  });

  it("unwraps a fenced code block", () => {
    assert.equal(extractJsonObject('Sure!\n```json\n{"a":1}\n```\nDone.'), '{"a":1}');
  });

  it("finds the object inside surrounding prose", () => {
    assert.equal(extractJsonObject('Here you go: {"a":{"b":2}} and that is it.'), '{"a":{"b":2}}');
  });

  it("is not fooled by braces inside strings", () => {
    assert.equal(extractJsonObject('{"a":"}{"}'), '{"a":"}{"}');
  });

  it("is not fooled by an escaped quote", () => {
    assert.equal(extractJsonObject('{"a":"say \\"hi\\" }"}'), '{"a":"say \\"hi\\" }"}');
  });

  it("returns null when there is no object", () => {
    assert.equal(extractJsonObject("no json here"), null);
  });

  it("returns null for an unterminated object rather than a partial one", () => {
    assert.equal(extractJsonObject('{"a":1'), null);
  });
});

describe("buildFallbackPrompt", () => {
  it("includes the state", () => {
    assert.match(buildFallbackPrompt("MY STATE", [noul]), /MY STATE/);
  });

  it("names each question and its options", () => {
    const prompt = buildFallbackPrompt({ a: 1 }, [noul, choice]);
    assert.match(prompt, /is_sponsor/);
    assert.match(prompt, /billing: Charges and refunds/);
  });

  it("demands a probability, because without one there is nothing to calibrate", () => {
    assert.match(buildFallbackPrompt("s", [noul]), /honest estimates/);
    assert.match(buildFallbackPrompt("s", [noul]), /noul.*0\.\.1/);
  });

  it("serialises a non-string state", () => {
    assert.match(buildFallbackPrompt({ key: "value" }, [noul]), /"key": "value"/);
  });

  it("numbers a score's levels from 0, the way the endpoint numbers them", () => {
    const prompt = buildFallbackPrompt("s", [score]);
    assert.match(prompt, /level 0: cosmetic/);
    assert.match(prompt, /level 2: no workaround/);
    assert.match(prompt, /0 for the first level/);
  });
});
