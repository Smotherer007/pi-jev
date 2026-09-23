import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { _resetConfigCache, getConfig } from "../src/config.ts";
import { recordDecision, readLedger } from "../src/ledger.ts";
import { parseSetupArgs, setupProvider } from "../src/commands/setup.ts";
import { labelDecision, listDecisions, parseLabelArgs } from "../src/commands/label.ts";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-cmd-"));
  process.env.HOME = home;
  _resetConfigCache();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("/jev-setup arguments", () => {
  it("lists with no arguments", () => {
    assert.deepEqual(parseSetupArgs(""), { action: "list" });
    assert.deepEqual(parseSetupArgs("  list "), { action: "list" });
  });

  it("reads kind and key=value options, with sensible default ids", () => {
    assert.deepEqual(parseSetupArgs("add jev apiKey=abc"), { action: "add", kind: "jev", apiKey: "abc", id: "jev" });
    assert.deepEqual(parseSetupArgs('add ollama model="qwen3:8b"'), { action: "add", kind: "ollama", model: "qwen3:8b", id: "local" });
    const compat = parseSetupArgs("add openai-compat id=lm url=http://x/v1 model=m position=0 manual=true cost=0.1");
    assert.equal(compat.id, "lm");
    assert.equal(compat.position, 0);
    assert.equal(compat.manual, true);
    assert.equal(compat.costPerMillionInput, 0.1);
  });

  it("says what is wrong instead of guessing", () => {
    assert.throws(() => parseSetupArgs("add"), /needs a kind/);
    assert.throws(() => parseSetupArgs("add jev colour=blue"), /Unknown option "colour"/);
    assert.throws(() => parseSetupArgs("add jev apiKey"), /key=value/);
    assert.throws(() => parseSetupArgs("remove"), /provider id/);
    assert.throws(() => parseSetupArgs("frobnicate"), /Unknown action/);
  });

  it("adds and removes a provider", async () => {
    await setupProvider(parseSetupArgs("add openai-compat id=lm url=http://127.0.0.1:1/v1 model=m"));
    assert.equal(getConfig().providers[0]?.id, "lm");
    await setupProvider(parseSetupArgs("remove lm"));
    assert.equal(getConfig().providers.length, 0);
  });

  it("refuses an ollama provider without a model rather than guessing one", async () => {
    await assert.rejects(() => setupProvider(parseSetupArgs("add ollama")), /needs a model/);
  });
});

describe("/jev-label", () => {
  const decision = (id: string, answers = [{ id: "risk", type: "choice" as const, p: 0.8, value: "reversible" }]) =>
    recordDecision({
      kind: "decision",
      id,
      ts: new Date().toISOString(),
      tool: "jev_gate",
      purpose: `gate: ${id}`,
      provider: "jev",
      model: "m",
      shadow: false,
      stateHash: "h",
      stateChars: 1,
      latencyMs: 1,
      usage: { inputTokens: 1, outputTokens: 0 },
      costUsd: 0,
      answers,
    });

  it("parses ok/wrong, an optional question and a note", () => {
    assert.deepEqual(parseLabelArgs(""), { action: "list", limit: 15 });
    assert.deepEqual(parseLabelArgs("list 3"), { action: "list", limit: 3 });
    assert.deepEqual(parseLabelArgs("dec_1 ok"), { action: "label", decisionId: "dec_1", correct: true });
    assert.deepEqual(parseLabelArgs("dec_1 wrong q=claim0 was a rename"), {
      action: "label",
      decisionId: "dec_1",
      correct: false,
      questionId: "claim0",
      note: "was a rename",
    });
    assert.throws(() => parseLabelArgs("dec_1 maybe"), /ok or wrong/);
  });

  it("labels the only question without being told which", () => {
    decision("dec_1");
    assert.match(labelDecision({ decisionId: "dec_1", correct: true }), /recorded as correct/);
    assert.equal(readLedger().filter((entry) => entry.kind === "label").length, 1);
  });

  it("asks which question when there are several, and names unknown ids", () => {
    decision("dec_2", [
      { id: "risk", type: "choice", p: 0.8, value: "reversible" },
      { id: "blast", type: "score", p: 0.6, value: 2 },
    ] as never);
    assert.throws(() => labelDecision({ decisionId: "dec_2", correct: true }), /name one with q=/);
    assert.throws(() => labelDecision({ decisionId: "nope", correct: true }), /No decision "nope"/);
  });

  it("lists recent decisions, newest first", () => {
    assert.match(listDecisions(), /ledger is empty/);
    decision("dec_a");
    decision("dec_b");
    const text = listDecisions();
    assert.ok(text.indexOf("dec_b") < text.indexOf("dec_a"));
  });
});
