import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { _resetConfigCache } from "../src/config.ts";
import { readLedger } from "../src/ledger.ts";
import { _resetDecisionMemory } from "../src/providers/index.ts";
import { _resetTrimMemory, planTrim, renderKept, trimMissFor, trimOutput } from "../src/trim.ts";
import { stubProvider, withNoulStub, writeConfig } from "./helpers/stub.ts";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-trim-"));
  process.env.HOME = home;
  _resetConfigCache();
  _resetDecisionMemory();
  _resetTrimMemory();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

/** 300 lines of progress noise with one failure buried in the middle. */
function noisyOutput(): string {
  const lines: string[] = [];
  for (let i = 0; i < 300; i += 1) lines.push(`  compiling module_${i} ... ok`);
  lines[150] = "  error: expected `;` in src/billing.ts:42";
  return lines.join("\n");
}

describe("planning a trim", () => {
  it("always keeps head and tail, keeps signal blocks by regex, and asks about the rest", () => {
    const lines = noisyOutput().split("\n");
    const plan = planTrim(lines, 25, 10, 40);

    assert.deepEqual(plan.alwaysKeep[0], [0, 10]);
    assert.deepEqual(plan.alwaysKeep.at(-1), [260, 300]);
    // The block holding line 150 is kept without a model call.
    assert.ok(plan.alwaysKeep.some(([start, end]) => start <= 150 && 150 < end));
    assert.ok(plan.ask.every((block) => !block.lines.some((line) => line.includes("error"))));
    assert.equal(plan.ask.reduce((n, block) => n + block.lines.length, 0) + 10 + 40 + 25, 300);
  });

  it("marks what was left out, with the count", () => {
    const lines = ["a", "b", "c", "d", "e"];
    assert.equal(
      renderKept(lines, [[0, 1], [3, 4]], (n) => `[${n}]`),
      "a\n[2]\nd\n[1]",
    );
  });
});

describe("trimming an output", () => {
  it("drops the blocks the model calls noise and says where the full output is", async () => {
    await withNoulStub(() => 0.05, async (url, bodies) => {
      writeConfig(home, { providers: stubProvider(url), shadow: { trim: false } });

      const result = await trimOutput(noisyOutput(), "npm run build");

      assert.ok(result.text, "a live trim returns replacement text");
      assert.ok(bodies.length >= 1);
      assert.match(result.text ?? "", /error: expected `;`/);
      assert.match(result.text ?? "", /omitted by pi-jev/);
      assert.match(result.text ?? "", /Full output: /);
      assert.ok(result.droppedLines > 100);

      const full = /Full output: (\S+)/.exec(result.text ?? "")?.[1] ?? "";
      assert.equal(fs.readFileSync(full, "utf-8"), noisyOutput());
      // Reading the full output afterwards is the miss signal.
      assert.ok(trimMissFor(full, home));
    });
  });

  it("keeps a block the model is unsure about", async () => {
    await withNoulStub(() => 0.4, async (url) => {
      writeConfig(home, { providers: stubProvider(url), shadow: { trim: false } });
      const result = await trimOutput(noisyOutput(), "npm run build");
      assert.equal(result.text, undefined);
      assert.equal(result.droppedLines, 0);
    });
  });

  it("only measures in shadow mode, which is the default", async () => {
    await withNoulStub(() => 0.05, async (url) => {
      writeConfig(home, { providers: stubProvider(url) });
      const result = await trimOutput(noisyOutput(), "npm run build");
      assert.equal(result.text, undefined);
      assert.ok(result.droppedLines > 100);
      const decisions = readLedger().filter((entry) => entry.kind === "decision");
      assert.ok(decisions.length > 0);
      assert.ok(decisions.every((entry) => entry.kind === "decision" && entry.shadow && entry.tool === "jev_trim"));
    });
  });

  it("leaves short output alone without a call", async () => {
    await withNoulStub(() => 0.05, async (url, bodies) => {
      writeConfig(home, { providers: stubProvider(url), shadow: { trim: false } });
      const result = await trimOutput("one\ntwo\nthree", "ls");
      assert.equal(result.text, undefined);
      assert.equal(bodies.length, 0);
    });
  });

  it("returns the output untouched when no provider answers", async () => {
    writeConfig(home, { providers: stubProvider("http://127.0.0.1:1/v1"), shadow: { trim: false } });
    const result = await trimOutput(noisyOutput(), "npm run build");
    assert.equal(result.text, undefined);
  });
});
