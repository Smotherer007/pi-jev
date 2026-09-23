import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { _resetConfigCache } from "../src/config.ts";
import { readLedger } from "../src/ledger.ts";
import { _resetDecisionMemory } from "../src/providers/index.ts";
import {
  _resetPruneMemory,
  currentTask,
  findCandidates,
  pruneContext,
  pruneMissFor,
  type Msg,
} from "../src/prune.ts";
import { stubProvider, withNoulStub, writeConfig } from "./helpers/stub.ts";
import { _resetTuning, _setTuning } from "../src/tuning.ts";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-prune-"));
  process.env.HOME = home;
  _resetConfigCache();
  _resetDecisionMemory();
  _resetPruneMemory();
  _resetTuning();
  // The test conversations are small; the real threshold would never fire.
  _setTuning({ prune: { minContextTokens: 100 } });
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const big = (label: string) => `${label}\n${"x".repeat(5_000)}`;

/** user → read auth.ts → read billing.ts → assistant text → assistant text. */
function conversation(): Msg[] {
  return [
    { role: "user", content: "Fix the rounding bug in billing" },
    { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "src/auth.ts" } }] },
    { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: big("AUTH") }] },
    { role: "assistant", content: [{ type: "toolCall", id: "t2", name: "read", arguments: { path: "src/billing.ts" } }] },
    { role: "toolResult", toolCallId: "t2", toolName: "read", content: [{ type: "text", text: big("BILLING") }] },
    { role: "assistant", content: [{ type: "text", text: "auth.ts is unrelated; the bug is in billing.ts" }] },
    { role: "assistant", content: [{ type: "text", text: "Editing billing.ts now" }] },
  ];
}

describe("finding what could be pruned", () => {
  it("considers only larger outputs older than the recent turns", () => {
    const messages = conversation();
    assert.deepEqual(
      findCandidates(messages, 2, 2_000).map((candidate) => candidate.label),
      ["read src/auth.ts", "read src/billing.ts"],
    );
    // With three recent turns protected, t2 is too recent to touch.
    assert.deepEqual(findCandidates(messages, 3, 2_000).map((c) => c.label), ["read src/auth.ts"]);
    assert.deepEqual(findCandidates(messages, 2, 10_000), []);
  });

  it("reads the task from the latest user message", () => {
    assert.equal(currentTask(conversation()).task, "Fix the rounding bug in billing");
    assert.match(currentTask(conversation()).progress, /Editing billing.ts/);
  });
});

describe("pruning the context", () => {
  const config = (url: string, extra: Record<string, unknown> = {}) =>
    writeConfig(home, {
      providers: stubProvider(url),
      shadow: { prune: false },
      ...extra,
    });

  // The model thinks auth.ts is done with and billing.ts still matters.
  const verdict = (id: string, body: Record<string, unknown>) => {
    const state = String(body.state ?? "");
    const label = new RegExp(`### ${id.toUpperCase()}: ([^\\n]+)`).exec(state)?.[1] ?? "";
    return label.includes("auth") ? 0.05 : 0.9;
  };

  it("stubs the output the task has moved past and keeps the one it still needs", async () => {
    await withNoulStub(verdict, async (url) => {
      config(url);
      const messages = conversation();
      const result = await pruneContext(messages, home);

      assert.equal(result.elided, 1);
      const stubbed = result.messages?.[2]?.content as Array<{ text: string }>;
      assert.match(stubbed[0]?.text ?? "", /pi-jev: output of read src\/auth.ts .* left out/);
      assert.match(JSON.stringify(result.messages?.[4]), /BILLING/);
      // The input was not mutated: pi's copy stays whole.
      assert.match(JSON.stringify(messages[2]), /AUTH/);
      assert.ok(result.savedChars > 4_000);
    });
  });

  it("judges each output once per task, so the next call costs nothing", async () => {
    await withNoulStub(verdict, async (url, bodies) => {
      config(url);
      await pruneContext(conversation(), home);
      const before = bodies.length;
      const again = await pruneContext(conversation(), home);
      assert.equal(bodies.length, before);
      assert.equal(again.elided, 1);
    });
  });

  it("counts reading a pruned file again as a miss signal", async () => {
    await withNoulStub(verdict, async (url) => {
      config(url);
      await pruneContext(conversation(), home);
      assert.ok(pruneMissFor("src/auth.ts", home));
      assert.equal(pruneMissFor("src/billing.ts", home), null);
    });
  });

  it("does nothing while the context is small", async () => {
    await withNoulStub(verdict, async (url, bodies) => {
      config(url);
      _setTuning({ prune: { minContextTokens: 1_000_000 } });
      const result = await pruneContext(conversation(), home);
      assert.equal(result.messages, undefined);
      assert.equal(bodies.length, 0);
    });
  });

  it("only measures in shadow mode, which is the default", async () => {
    await withNoulStub(verdict, async (url) => {
      writeConfig(home, { providers: stubProvider(url) });
      const result = await pruneContext(conversation(), home);
      assert.equal(result.messages, undefined);
      assert.equal(result.elided, 1);
      const decisions = readLedger().filter((entry) => entry.kind === "decision");
      assert.ok(decisions.every((entry) => entry.kind === "decision" && entry.shadow && entry.tool === "jev_prune"));
    });
  });

  it("leaves the context alone when no provider answers", async () => {
    config("http://127.0.0.1:1/v1");
    const result = await pruneContext(conversation(), home);
    assert.equal(result.messages, undefined);
    assert.equal(result.elided, 0);
  });
});
