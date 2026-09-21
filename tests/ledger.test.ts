import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  _resetDropMemory,
  clearLedger,
  costOf,
  estimateTokens,
  findShadowMiss,
  hashState,
  ledgerPath,
  readLedger,
  recordDecision,
  recordLabel,
  recordShadowMiss,
  rememberDrops,
} from "../src/ledger.ts";
import type { LedgerDecision } from "../src/types.ts";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-ledger-"));
  process.env.HOME = home;
  _resetDropMemory();
});

afterEach(() => {
  _resetDropMemory();
  fs.rmSync(home, { recursive: true, force: true });
});

function decision(overrides: Partial<LedgerDecision> = {}): LedgerDecision {
  return {
    kind: "decision",
    id: "dec_1",
    ts: "2026-09-19T10:00:00.000Z",
    tool: "jev_decide",
    purpose: "test",
    provider: "jev",
    model: "jev-latest",
    shadow: false,
    stateHash: "hash",
    stateChars: 10,
    latencyMs: 100,
    usage: { inputTokens: 100, outputTokens: 0 },
    costUsd: 0.0000042,
    answers: [{ id: "q", type: "noul", p: 0.9, value: true }],
    ...overrides,
  };
}

describe("hashState", () => {
  it("is stable for the same input", () => {
    assert.equal(hashState({ a: 1 }), hashState({ a: 1 }));
  });

  it("differs for different input", () => {
    assert.notEqual(hashState("one"), hashState("two"));
  });

  it("is 16 hex characters", () => {
    assert.match(hashState("x"), /^[0-9a-f]{16}$/);
  });

  it("treats a string and its JSON form differently, which is correct", () => {
    assert.notEqual(hashState("abc"), hashState({ toString: () => "abc" }));
  });
});

describe("costOf", () => {
  it("computes Jev's published price", () => {
    // $0.042 per million input tokens.
    const close = (actual: number, expected: number) => Math.abs(actual - expected) < 1e-12;
    assert.ok(close(costOf(1_000_000, 0.042), 0.042));
    assert.ok(close(costOf(60_000, 0.042), 0.00252));
    assert.ok(close(costOf(250_000, 0.042), 0.0105));
  });

  it("stays negligible for a realistic triage call", () => {
    // 40 candidates, ~400 characters of preview each: roughly 4k tokens, which
    // is the shape of the calls this package makes most often.
    const cost = costOf(4_000, 0.042);
    assert.ok(cost < 0.001, `a triage call should cost well under a tenth of a cent, got ${cost}`);
    assert.ok(Math.abs(cost - 0.000168) < 1e-9);
  });

  it("is zero for a free provider", () => {
    assert.equal(costOf(1_000_000, 0), 0);
  });
});

describe("estimateTokens", () => {
  it("approximates four characters per token", () => {
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens(""), 0);
  });
});

describe("recording", () => {
  it("appends a decision and reads it back", () => {
    recordDecision(decision());
    const entries = readLedger();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "decision");
  });

  it("appends labels and shadow misses to the same file", () => {
    recordDecision(decision());
    recordLabel("dec_1", "q", true, "looked right");
    recordShadowMiss("dec_1", "src/x.ts", "read");
    const kinds = readLedger().map((entry) => entry.kind);
    assert.deepEqual(kinds, ["decision", "label", "shadow-miss"]);
  });

  it("writes one JSON object per line", () => {
    recordDecision(decision());
    recordLabel("dec_1", "q", false);
    const lines = fs.readFileSync(ledgerPath(), "utf-8").trim().split("\n");
    assert.equal(lines.length, 2);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  });

  it("skips a corrupt line instead of failing the whole read", () => {
    recordDecision(decision());
    fs.appendFileSync(ledgerPath(), "{ truncated mid-wri", "utf-8");
    recordDecision(decision({ id: "dec_2" }));
    const entries = readLedger();
    assert.equal(entries.length, 2);
  });

  it("returns an empty array when there is no ledger", () => {
    assert.deepEqual(readLedger(), []);
  });

  it("returns the newest entries when a limit is given", () => {
    recordDecision(decision({ id: "a" }));
    recordDecision(decision({ id: "b" }));
    recordDecision(decision({ id: "c" }));
    const entries = readLedger(2);
    assert.equal(entries.length, 2);
  });

  it("clears the ledger", () => {
    recordDecision(decision());
    clearLedger();
    assert.deepEqual(readLedger(), []);
  });

  it("does not throw when the ledger cannot be written", () => {
    // HOME pointing at a regular file makes the ledger directory impossible to
    // create. A failed write must not take the decision down with it.
    //
    // Note: pointing HOME at a path under /proc also fails, but mkdirSync on
    // /proc hangs rather than throwing, so it would block the whole run.
    const blocker = path.join(home, "not-a-directory");
    fs.writeFileSync(blocker, "x", "utf-8");
    process.env.HOME = blocker;

    assert.doesNotThrow(() => recordDecision(decision()));
    assert.deepEqual(readLedger(), []);
  });

  it("keeps the read path safe when the ledger is unreadable", () => {
    const blocker = path.join(home, "not-a-directory");
    fs.writeFileSync(blocker, "x", "utf-8");
    process.env.HOME = blocker;
    assert.deepEqual(readLedger(), []);
  });

  it("creates a readable ledger file for its owner", () => {
    recordDecision(decision());
    assert.ok(fs.statSync(ledgerPath()).isFile());
  });
});

describe("shadow-miss detection", () => {
  it("finds a dropped item that is read afterwards", () => {
    rememberDrops("dec_1", ["src/auth.ts", "src/billing.ts"], "jev_triage");
    assert.deepEqual(findShadowMiss("src/auth.ts"), { decisionId: "dec_1", item: "src/auth.ts" });
  });

  it("matches an absolute path against a relative drop", () => {
    rememberDrops("dec_1", ["src/auth.ts"], "jev_triage");
    assert.ok(findShadowMiss("/home/pat/project/src/auth.ts"));
  });

  it("matches a relative path against an absolute drop", () => {
    rememberDrops("dec_1", ["/home/pat/project/src/auth.ts"], "jev_triage");
    assert.ok(findShadowMiss("src/auth.ts"));
  });

  it("does not report a miss just because two files share a name", () => {
    // A file name is not an identity: `index.ts`, `types.ts` and `README.md`
    // appear several times over in most projects. Counting one as a miss for
    // another inflates the only number that decides whether keeping the filter
    // is justifiable.
    rememberDrops("dec_1", ["src/tools/index.ts"], "jev_triage");
    assert.equal(findShadowMiss("src/graph/index.ts"), null);

    rememberDrops("dec_2", ["src/types.ts"], "jev_triage");
    assert.equal(findShadowMiss("src/graph/types.ts"), null);
  });

  it("does not match a bare name against a path that ends with it", () => {
    // Without a root nothing says whether `src/auth.ts` is the dropped `auth.ts`
    // or a different file of the same name one directory over, so it does not
    // count. With a root it does — see the resolution tests below.
    rememberDrops("dec_1", ["auth.ts"], "jev_triage");
    assert.equal(findShadowMiss("src/auth.ts"), null);
  });

  it("resolves both sides against a known root, so a bare key still matches", () => {
    // A triage key is relative to the search root; the path a read carries is
    // relative to the working directory or absolute. Resolving both is what makes
    // the comparison mean anything.
    rememberDrops("dec_1", ["auth.ts"], "jev_triage", "/home/pat/project/src");
    assert.deepEqual(findShadowMiss("src/auth.ts", "/home/pat/project"), { decisionId: "dec_1", item: "auth.ts" });
    assert.deepEqual(findShadowMiss("/home/pat/project/src/auth.ts", "/home/pat/project"), {
      decisionId: "dec_1",
      item: "auth.ts",
    });
  });

  it("does not match across roots even when the trailing path agrees", () => {
    // `src/types.ts` in another package is another file, and with the root known
    // the comparison can say so instead of guessing from the suffix.
    rememberDrops("dec_1", ["src/types.ts"], "jev_triage", "/home/pat/project");
    assert.equal(findShadowMiss("/home/pat/other/packages/api/src/types.ts", "/home/pat/other"), null);
  });

  it("returns null for an item that was kept", () => {
    rememberDrops("dec_1", ["src/auth.ts"], "jev_triage");
    assert.equal(findShadowMiss("src/other.ts"), null);
  });

  it("returns null once the memory has been cleared", () => {
    rememberDrops("dec_1", ["src/auth.ts"], "jev_triage");
    _resetDropMemory();
    assert.equal(findShadowMiss("src/auth.ts"), null);
  });

  it("does not record anything when nothing was dropped", () => {
    rememberDrops("dec_1", [], "jev_triage");
    assert.equal(findShadowMiss("src/auth.ts"), null);
  });

  it("normalises windows separators", () => {
    rememberDrops("dec_1", ["src\\auth.ts"], "jev_triage");
    assert.ok(findShadowMiss("src/auth.ts"));
  });
});
