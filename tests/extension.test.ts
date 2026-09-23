import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import extension, { _disableWarmup, promptSection } from "../index.ts";
import { _resetConfigCache } from "../src/config.ts";
import { _resetDecisionMemory } from "../src/providers/index.ts";
import { _resetDropMemory, readLedger, rememberDrops } from "../src/ledger.ts";

/**
 * A stand-in for pi's ExtensionAPI, recording what the extension registers.
 *
 * Worth having as a test rather than trusting `pi -e` by eye: the failure this
 * catches is a tool that never registers because the factory threw halfway
 * through, which looks like "the extension works" until you notice that four
 * of the seven tools are missing.
 */
interface FakePi {
  api: Record<string, unknown>;
  tools: Map<string, Record<string, unknown>>;
  commands: Map<string, Record<string, unknown>>;
  handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
  notifications: string[];
  statuses: Array<{ key: string; text: string | undefined }>;
}

function makeFakePi(): FakePi {
  const tools = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const notifications: string[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];

  return {
    api: {
      registerTool: (tool: Record<string, unknown>) => tools.set(String(tool.name), tool),
      registerCommand: (name: string, options: Record<string, unknown>) => commands.set(name, options),
      on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      },
      registerProvider: () => {},
      getAllTools: () => [],
      getActiveTools: () => [],
      setActiveTools: () => {},
    },
    tools,
    commands,
    handlers,
    notifications,
    statuses,
  };
}

function fakeContext(cwd: string) {
  return {
    cwd,
    mode: "tui" as const,
    hasUI: true,
    ui: {
      notify: (text: string) => {
        notifications.push(text);
      },
      setStatus: (key: string, text: string | undefined) => {
        statuses.push({ key, text });
      },
      confirm: async (_title: string, _message?: string) => true,
      select: async () => undefined,
      input: async () => undefined,
    },
    isProjectTrusted: () => true,
    sessionManager: { getEntries: () => [] },
    signal: undefined,
  };
}

// session_start would otherwise open a connection to whatever a test configured.
_disableWarmup();

let home: string;
let notifications: string[];
let statuses: Array<{ key: string; text: string | undefined }>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-ext-"));
  process.env.HOME = home;
  // The config is cached per process, so each test needs it dropped or it would
  // keep reading the previous test's HOME.
  _resetConfigCache();
  // Same for the dropped-path memory, which is what shadow-miss matching reads.
  _resetDropMemory();
  // Cached answers and provider cooldowns are process-wide too.
  _resetDecisionMemory();
  notifications = [];
  statuses = [];
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const EXPECTED_TOOLS = [
  "jev_setup",
  "jev_status",
  "jev_decide",
  "jev_triage",
  "jev_verify",
  "jev_gate",
  "jev_label",
];

/**
 * The extension registers two `tool_call` handlers, and the order is part of the
 * design: the guard goes first, because a dangerous command should be refused
 * before anything else looks at it, and shadow-miss detection second, because it
 * is bookkeeping. Tests reach for one through these helpers, so the coupling is
 * stated once instead of guessed at in every test.
 */
type ToolCallHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

function toolCallHandler(pi: FakePi, which: "guard" | "shadow"): ToolCallHandler {
  const handlers = pi.handlers.get("tool_call") ?? [];
  const handler = which === "guard" ? handlers[0] : handlers[1];
  assert.ok(handler, `no ${which} tool_call handler was registered`);
  return handler as ToolCallHandler;
}

/** What a guard handler returns when it wants a call stopped. */
interface BlockedCall {
  block?: boolean;
  reason?: string;
}

describe("extension factory", () => {
  it("loads without throwing", () => {
    assert.equal(typeof extension, "function");
    assert.doesNotThrow(() => extension(makeFakePi().api as never));
  });

  it("registers every documented tool", () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    assert.deepEqual([...pi.tools.keys()].sort(), [...EXPECTED_TOOLS].sort());
  });

  it("gives every tool the metadata pi needs", () => {
    const pi = makeFakePi();
    extension(pi.api as never);

    for (const [name, tool] of pi.tools) {
      assert.equal(tool.name, name);
      assert.equal(typeof tool.label, "string", `${name} needs a label`);
      assert.ok(String(tool.description).length > 40, `${name} needs a real description`);
      assert.ok(tool.parameters, `${name} needs a parameter schema`);
      assert.equal(typeof tool.execute, "function", `${name} needs an execute`);
    }
  });

  it("names the tool in each prompt guideline, because they are appended flat", () => {
    const pi = makeFakePi();
    extension(pi.api as never);

    for (const [name, tool] of pi.tools) {
      const guidelines = (tool.promptGuidelines ?? []) as string[];
      for (const guideline of guidelines) {
        assert.ok(
          guideline.includes(name),
          `guideline on ${name} does not name the tool, so the model cannot tell which "this" means: ${guideline}`,
        );
        assert.ok(!/\bthis tool\b/i.test(guideline), `guideline on ${name} says "this tool"`);
      }
    }
  });

  it("registers the commands", () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    assert.deepEqual(
      [...pi.commands.keys()].sort(),
      ["jev", "jev-calibration", "jev-providers", "jev-shadow"],
    );
  });

  it("subscribes to session_start and tool_call", () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    assert.equal(pi.handlers.get("session_start")?.length, 1);
    // The guard, shadow-miss detection and usage bookkeeping, in that order: a
    // dangerous command is refused before anything else looks at it.
    assert.equal(pi.handlers.get("tool_call")?.length, 3);
    assert.equal(pi.handlers.get("before_agent_start")?.length, 1);
    assert.equal(pi.handlers.get("tool_result")?.length, 1);
    assert.equal(pi.handlers.get("agent_end")?.length, 1);
  });
});

describe("session_start", () => {
  it("creates a discoverable config file on first run", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);

    await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, fakeContext(home));

    const configPath = path.join(home, ".pi", "jev-config.json");
    assert.ok(fs.existsSync(configPath), "a first run should leave a discoverable config file");
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);

    // No provider is invented: guessing a local model name would fail later,
    // at call time, instead of here.
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.deepEqual(config.providers, []);
  });

  it("tells the user what to do when nothing is configured", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    const ctx = fakeContext(home);
    ctx.ui.notify = (text: string) => notifications.push(text);

    await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
    assert.ok(notifications.some((text) => text.includes("jev_setup")));
  });

  it("does not overwrite an existing config", async () => {
    const configPath = path.join(home, ".pi", "jev-config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ providers: [{ id: "mine", kind: "jev", apiKey: "k" }] }), "utf-8");
    _resetConfigCache();

    const pi = makeFakePi();
    extension(pi.api as never);
    await pi.handlers.get("session_start")?.[0]?.({ reason: "startup" }, fakeContext(home));

    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.equal(config.providers[0].id, "mine");
    assert.equal(config.providers.length, 1);
  });

  it("stays quiet on a restart", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    await pi.handlers.get("session_start")?.[0]?.({ reason: "resume" }, fakeContext(home));
    assert.equal(fs.existsSync(path.join(home, ".pi", "jev-config.json")), false);
  });
});

describe("commands", () => {
  async function runCommand(name: string, args: string) {
    const pi = makeFakePi();
    extension(pi.api as never);
    const command = pi.commands.get(name) as { handler: (args: string, ctx: unknown) => Promise<void> };
    const ctx = fakeContext(home);
    // Capture notifications through the shared collector.
    ctx.ui.notify = (text: string) => {
      notifications.push(text);
      pi.notifications.push(text);
    };
    await command.handler(args, ctx);
    return pi;
  }

  it("/jev reports the ledger without throwing on an empty one", async () => {
    await runCommand("jev", "");
    assert.ok(notifications.some((text) => text.includes("No decisions recorded yet")));
  });

  it("/jev-calibration explains that there is nothing to measure yet", async () => {
    await runCommand("jev-calibration", "");
    assert.ok(notifications.some((text) => text.includes("no labelled answers") || text.includes("No labelled answers")));
  });

  it("/jev-shadow with no argument reports the current state", async () => {
    await runCommand("jev-shadow", "");
    assert.ok(notifications.some((text) => text.includes("shadow mode") || text.includes("Shadow mode")));
  });

  it("/jev-shadow triage on persists the change", async () => {
    await runCommand("jev-shadow", "triage on");
    const config = JSON.parse(fs.readFileSync(path.join(home, ".pi", "jev-config.json"), "utf-8"));
    assert.equal(config.shadow.triage, true);
    assert.equal(config.shadow.verify, false);
  });

  it("/jev-shadow all off clears every flag", async () => {
    await runCommand("jev-shadow", "all on");
    await runCommand("jev-shadow", "all off");
    const config = JSON.parse(fs.readFileSync(path.join(home, ".pi", "jev-config.json"), "utf-8"));
    assert.deepEqual(config.shadow, { triage: false, verify: false, gate: false });
  });

  it("/jev-shadow rejects an unknown target instead of silently doing nothing", async () => {
    await runCommand("jev-shadow", "nonsense on");
    assert.ok(notifications.some((text) => text.includes("Unknown target")));
  });

  it("/jev-shadow sets a footer status when shadow mode is on", async () => {
    await runCommand("jev-shadow", "triage on");
    assert.ok(statuses.some((entry) => entry.key === "jev-shadow" && entry.text?.includes("triage")));
  });

  it("/jev-shadow none switches every flag off instead of on", async () => {
    await runCommand("jev-shadow", "all on");
    await runCommand("jev-shadow", "none");
    const config = JSON.parse(fs.readFileSync(path.join(home, ".pi", "jev-config.json"), "utf-8"));
    assert.deepEqual(config.shadow, { triage: false, verify: false, gate: false });
  });

  it("/jev-shadow none on still switches them on, because an explicit state wins", async () => {
    await runCommand("jev-shadow", "none on");
    const config = JSON.parse(fs.readFileSync(path.join(home, ".pi", "jev-config.json"), "utf-8"));
    assert.deepEqual(config.shadow, { triage: true, verify: true, gate: true });
  });

  it("/jev-providers prints the chain", async () => {
    await runCommand("jev-providers", "");
    assert.ok(notifications.some((text) => text.includes("pi-jev")));
  });
});

describe("shadow-miss detection", () => {
  it("ignores tool calls whose name is unrelated", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    const handler = toolCallHandler(pi, "shadow");
    assert.doesNotReject(() => handler({ toolName: "ls", input: {} }, fakeContext(home)));
  });

  it("ignores a read when shadow mode is off, so nothing is misattributed", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    const handler = toolCallHandler(pi, "shadow");
    await handler({ toolName: "read", input: { path: "src/anything.ts" } }, fakeContext(home));

    const ledger = path.join(home, ".pi", "jev-ledger.jsonl");
    assert.equal(fs.existsSync(ledger), false);
  });

  it("survives a tool call with no useful path", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    const handler = toolCallHandler(pi, "shadow");
    await handler({ toolName: "read", input: {} }, fakeContext(home));
    await handler({ toolName: "read" }, fakeContext(home));
    await handler({ toolName: "grep", input: { path: 42 } }, fakeContext(home));
  });

  /** Shadow mode on, with a triage run's drops already in memory. */
  function withShadowOn(): { pi: FakePi; root: string; cwd: string } {
    const configPath = path.join(home, ".pi", "jev-config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ shadow: { triage: true } }), "utf-8");
    _resetConfigCache();

    const pi = makeFakePi();
    extension(pi.api as never);
    return { pi, root: path.join(home, "project", "src"), cwd: path.join(home, "project") };
  }

  function shadowMisses() {
    return readLedger().filter((entry) => entry.kind === "shadow-miss");
  }

  it("records a miss when the agent reads a file the filter had withheld", async () => {
    // This is the wiring the whole measurement rests on: shadow mode on, a drop
    // key resolved against the root triage used, and an entry in the ledger.
    const { pi, root, cwd } = withShadowOn();
    rememberDrops("dec_read", ["candidates.ts", "format.ts"], "jev_triage", root);

    await toolCallHandler(pi, "shadow")({ toolName: "read", input: { path: "src/candidates.ts" } }, { ...fakeContext(home), cwd });

    const misses = shadowMisses();
    assert.equal(misses.length, 1, "a read of a withheld file must be recorded");
    assert.equal((misses[0] as { item?: string }).item, "candidates.ts");
  });

  it("records nothing when the file that was read only shares a name", async () => {
    // A false hit here inflates the number that decides whether keeping the
    // filter is justifiable, which is worse than a miss.
    const { pi, root } = withShadowOn();
    rememberDrops("dec_read", ["types.ts"], "jev_triage", root);
    const handler = toolCallHandler(pi, "shadow");

    await handler(
      { toolName: "read", input: { path: "/somewhere/else/packages/api/src/types.ts" } },
      { ...fakeContext(home), cwd: path.join(home, "elsewhere") },
    );
    // And a file the filter kept is not a miss either.
    await handler({ toolName: "read", input: { path: "src/questions.ts" } }, { ...fakeContext(home), cwd: path.join(home, "project") });

    assert.deepEqual(shadowMisses(), []);
  });
});

describe("the guard hook on bash", () => {
  it("blocks an unambiguously destructive command before it runs", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);

    const result = (await toolCallHandler(pi, "guard")(
      { toolName: "bash", input: { command: "rm -rf /" } },
      fakeContext(home),
    )) as BlockedCall | undefined;

    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /recursive force delete/);
    // The model is told that a rule decided this, so rephrasing is not a way past it.
    assert.match(result?.reason ?? "", /Local rules decided this/);
  });

  it("leaves what the rules cannot judge to the model, where jev_gate still has an answer", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    const handler = toolCallHandler(pi, "guard");

    assert.equal(await handler({ toolName: "bash", input: { command: "./scripts/migrate.sh" } }, fakeContext(home)), undefined);
    assert.equal(await handler({ toolName: "bash", input: { command: "git status" } }, fakeContext(home)), undefined);
  });

  it("asks about danger it is not certain of, and refuses when the user says no", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    const ctx = fakeContext(home);
    const asked: string[] = [];
    ctx.ui.confirm = async (title: string, message?: string) => {
      asked.push(`${title} :: ${message ?? ""}`);
      return false;
    };

    const result = (await toolCallHandler(pi, "guard")(
      { toolName: "bash", input: { command: "git push --force origin main" } },
      ctx,
    )) as BlockedCall | undefined;

    assert.equal(asked.length, 1, "the user must be asked exactly once");
    assert.match(asked[0] ?? "", /rewrites published history/);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /declined/);
  });

  it("runs a confirm-tier command when there is no UI to ask through, but never a blocked one", async () => {
    // Deliberate, and the one place the doctrine is relaxed: those rules mean
    // "worth a look", and refusing every sudo in a session that cannot ask is how
    // a guardrail gets uninstalled.
    const pi = makeFakePi();
    extension(pi.api as never);
    const ctx = { ...fakeContext(home), hasUI: false };
    const handler = toolCallHandler(pi, "guard");

    assert.equal(await handler({ toolName: "bash", input: { command: "sudo systemctl restart nginx" } }, ctx), undefined);
    const blocked = (await handler({ toolName: "bash", input: { command: "rm -rf /" } }, ctx)) as BlockedCall | undefined;
    assert.equal(blocked?.block, true);
  });

  it("ignores everything that is not a bash command", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    const handler = toolCallHandler(pi, "guard");

    assert.equal(await handler({ toolName: "read", input: { path: "x" } }, fakeContext(home)), undefined);
    assert.equal(await handler({ toolName: "bash", input: {} }, fakeContext(home)), undefined);
    assert.equal(await handler({ toolName: "bash", input: { command: "   " } }, fakeContext(home)), undefined);
  });

  it("can be turned off, because it is the user's machine", async () => {
    const configPath = path.join(home, ".pi", "jev-config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ hook: { bash: false } }), "utf-8");
    _resetConfigCache();

    const pi = makeFakePi();
    extension(pi.api as never);
    assert.equal(
      await toolCallHandler(pi, "guard")({ toolName: "bash", input: { command: "rm -rf /" } }, fakeContext(home)),
      undefined,
    );
  });
});

describe("tool invocation without a provider", () => {
  it("jev_gate still decides a dangerous command with rules alone", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    const gate = pi.tools.get("jev_gate") as {
      execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown) => Promise<{
        content: Array<{ text: string }>;
        details: Record<string, unknown>;
      }>;
    };

    const result = await gate.execute(
      "call1",
      { action: "rm -rf /" },
      undefined,
      undefined,
      fakeContext(home),
    );

    assert.equal(result.details.verdict, "block");
    assert.equal(result.details.source, "rule");
    assert.equal(result.details.costUsd, 0);
    assert.match(result.content[0]?.text ?? "", /recursive force delete/);
  });

  it("jev_gate clears a read-only command with rules alone", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    const gate = pi.tools.get("jev_gate") as {
      execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown) => Promise<{
        details: Record<string, unknown>;
      }>;
    };

    const result = await gate.execute("call1", { action: "git status" }, undefined, undefined, fakeContext(home));
    assert.equal(result.details.verdict, "allow");
    assert.equal(result.details.source, "rule");
  });

  it("jev_gate reports a clear failure instead of a crash when no provider can be reached", async () => {
    // Point at a closed port so the failure is immediate and reproducible. The
    // earlier version of this test relied on whatever Ollama happened to be
    // running locally, and waited sixty seconds for a 27B model to answer —
    // which is itself the reason the gate now carries its own deadline.
    const configPath = path.join(home, ".pi", "jev-config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        providers: [
          { id: "dead", kind: "ollama", baseUrl: "http://127.0.0.1:1/v1", apiKey: "x", model: "none" },
        ],
        limits: { gateTimeoutMs: 500 },
      }),
      "utf-8",
    );
    _resetConfigCache();

    const pi = makeFakePi();
    extension(pi.api as never);
    const gate = pi.tools.get("jev_gate") as {
      execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown) => Promise<{
        content: Array<{ text: string }>;
        details: Record<string, unknown>;
      }>;
    };

    // An ambiguous action: the rules deliberately decline to judge it.
    const started = Date.now();
    const result = await gate.execute(
      "call1",
      { action: "./scripts/migrate.sh" },
      undefined,
      undefined,
      fakeContext(home),
    );

    assert.ok(Date.now() - started < 5_000, "an unreachable provider must not stall the gate");
    assert.equal(result.details.verdict, "confirm");
    assert.equal(result.details.source, "unavailable");
    assert.match(result.content[0]?.text ?? "", /could not be reached/);
    assert.match(result.content[0]?.text ?? "", /not a fail-open path/);
  });
});

/* ------------------------------------------------- the model layer, live */

/**
 * A stub standing in for the decision endpoint, answering in the shape the live
 * API returns.
 *
 * `respond` receives the parsed request body and returns the response body, so
 * a test can answer in whichever shape the provider under test expects: the Jev
 * endpoint's own, or an OpenAI-compatible chat completion.
 *
 * The score question is the whole point of these tests. A score's levels must
 * travel as an ordered list, because a map is refused with HTTP 422 — and
 * `jev_gate` always asks for one, so that single detail is the difference
 * between a gate that classifies an ambiguous action and one that can only ever
 * say "the classifier could not be reached".
 */
async function withDecisionStub(
  respond: (body: Record<string, unknown>) => unknown,
  run: (baseUrl: string, bodies: Array<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      bodies.push(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(respond(body)));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}/v1`, bodies);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The response shape api.typesafe.ai/v1/systemone answers with. */
const jevResponse = (answers: Record<string, unknown>) => (): unknown => ({
  model: "jev-1.13.0",
  answers,
  usage: { input_tokens: 120, output_tokens: 20 },
});

/** The response shape an OpenAI-compatible endpoint answers with. */
const compatResponse = (answers: Record<string, unknown>) => (): unknown => ({
  model: "stub",
  choices: [{ message: { content: JSON.stringify({ answers }) } }],
  usage: { prompt_tokens: 120, completion_tokens: 20 },
});

/** Point the extension at the stub, optionally with its own gate policy. */
function writeStubConfig(url: string, kind: "jev" | "openai-compat", gate?: Record<string, string>): void {
  const configPath = path.join(home, ".pi", "jev-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: [{ id: "stub", kind, baseUrl: url, model: "stub", apiKey: "x", jsonMode: false }],
      limits: { gateTimeoutMs: 2_000 },
      ...(gate ? { gate } : {}),
    }),
    "utf-8",
  );
  _resetConfigCache();
}

function callGate(pi: FakePi, action: string) {
  const gate = pi.tools.get("jev_gate") as {
    execute: (id: string, params: unknown, signal: undefined, update: undefined, ctx: unknown) => Promise<{
      content: Array<{ text: string }>;
      details: Record<string, unknown>;
    }>;
  };
  return gate.execute("call1", { action }, undefined, undefined, fakeContext(home));
}

const STUB_ANSWERS = {
  risk: {
    type: "choice",
    choice: "reversible",
    confidence: 0.8,
    probabilities: { read_only: 0.05, reversible: 0.8, destructive: 0.1, needs_human: 0.05 },
  },
  blast: {
    type: "score",
    score: 2.6,
    confidence: 0.7,
    legend: { 0: "a", 1: "b", 2: "c", 3: "d" },
    probabilities: { 0: 0, 1: 0.05, 2: 0.4, 3: 0.55 },
  },
};

describe("jev_gate against a reachable decision model", () => {
  it("sends a score's levels as an ordered list and reads the level back as a blast radius", async () => {
    await withDecisionStub(jevResponse(STUB_ANSWERS), async (url, bodies) => {
      writeStubConfig(url, "jev");
      const pi = makeFakePi();
      extension(pi.api as never);

      // The rules deliberately decline to judge this one, so it reaches layer 2.
      const result = await callGate(pi, "./scripts/migrate.sh");

      assert.equal(result.details.source, "model");
      assert.equal(result.details.risk, "reversible");
      // The distribution's peak is level 3, which is the level named "4".
      assert.equal(result.details.blast, 4);
      // A blast radius of 4 escalates the configured "confirm".
      assert.equal(result.details.verdict, "block");

      // The request the endpoint actually receives. Sent as a map, this is HTTP
      // 422 and every ambiguous action falls back to "could not be reached".
      const questions = bodies[0]?.questions as Record<string, { criteria?: unknown }>;
      const blastCriteria = questions.blast?.criteria;
      assert.ok(Array.isArray(blastCriteria), "a score's levels must go out as an ordered list, not a map");
      assert.equal(blastCriteria.length, 4);
      assert.ok(blastCriteria.every((level) => typeof level === "string"));
      // A choice keeps its map, because that is what names its options.
      const riskCriteria = questions.risk?.criteria;
      assert.ok(riskCriteria !== undefined && !Array.isArray(riskCriteria));
    });
  });

  it("enforces allowedRisk in the model layer instead of only mentioning it", async () => {
    const lowBlast = {
      risk: STUB_ANSWERS.risk,
      blast: { type: "score", score: 0.05, confidence: 0.95, probabilities: { 0: 0.95, 1: 0.05, 2: 0, 3: 0 } },
    };

    await withDecisionStub(compatResponse(lowBlast), async (url) => {
      // A policy that would clear a reversible action on its own.
      writeStubConfig(url, "openai-compat", {
        read_only: "allow",
        reversible: "allow",
        destructive: "block",
        needs_human: "confirm",
      });
      const pi = makeFakePi();
      extension(pi.api as never);

      const result = await callGate(pi, "./scripts/migrate.sh");

      assert.equal(result.details.risk, "reversible");
      assert.equal(result.details.blast, 1);
      // The configured policy says allow; the ceiling the caller set does not.
      assert.equal(result.details.verdict, "confirm");
      assert.match(result.content[0]?.text ?? "", /above the allowedRisk you set \(read_only\)/i);
    });
  });

  it("does not let a wide allowedRisk downgrade a rule that blocks", async () => {
    // No stub needed: the rules answer before any provider is consulted, which
    // is exactly why a caller cannot talk their way out of one.
    const pi = makeFakePi();
    extension(pi.api as never);
    const result = await callGate(pi, "rm -rf /");
    assert.equal(result.details.source, "rule");
    assert.equal(result.details.verdict, "block");
  });
});

/* ------------------------------------------ the decision layer, put to use */

const READ_ONLY_ANSWERS = {
  risk: {
    type: "choice",
    choice: "read_only",
    confidence: 0.95,
    probabilities: { read_only: 0.95, reversible: 0.03, destructive: 0.01, needs_human: 0.01 },
  },
  blast: { type: "score", score: 0.05, confidence: 0.95, probabilities: { 0: 0.95, 1: 0.05, 2: 0, 3: 0 } },
};

function withProviderConfig(extra: Record<string, unknown> = {}, url = "http://127.0.0.1:1/v1"): void {
  const configPath = path.join(home, ".pi", "jev-config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      providers: [{ id: "stub", kind: "jev", baseUrl: url, model: "stub", apiKey: "x" }],
      limits: { gateTimeoutMs: 2_000 },
      ...extra,
    }),
    "utf-8",
  );
  _resetConfigCache();
}

describe("the bash hook asks the decision model", () => {
  it("blocks a consequential command the model judges too far-reaching", async () => {
    await withDecisionStub(jevResponse(STUB_ANSWERS), async (url, bodies) => {
      writeStubConfig(url, "jev");
      const pi = makeFakePi();
      extension(pi.api as never);

      const result = (await toolCallHandler(pi, "guard")(
        { toolName: "bash", input: { command: "git push origin main" } },
        fakeContext(home),
      )) as BlockedCall | undefined;

      assert.equal(bodies.length, 1, "the model must be asked before the command runs");
      assert.equal(result?.block, true);
      assert.match(result?.reason ?? "", /decision model judged this command/);
      const hook = readLedger().filter((entry) => entry.kind === "decision");
      assert.equal(hook[0]?.kind === "decision" ? hook[0].tool : "", "jev_gate_hook");
    });
  });

  it("lets a command through when the model clears it, and asks only once for a repeat", async () => {
    await withDecisionStub(jevResponse(READ_ONLY_ANSWERS), async (url, bodies) => {
      writeStubConfig(url, "jev");
      const pi = makeFakePi();
      extension(pi.api as never);
      const handler = toolCallHandler(pi, "guard");

      // Not a command the read-only rules already clear on their own.
      const event = { toolName: "bash", input: { command: "aws s3 ls" } };
      assert.equal(await handler(event, fakeContext(home)), undefined);
      assert.equal(await handler(event, fakeContext(home)), undefined);
      // The second identical command is answered from the decision cache.
      assert.equal(bodies.length, 1);
      assert.equal(readLedger().filter((entry) => entry.kind === "decision").length, 1);
    });
  });

  it("does not spend a model call on a command that cannot reach past the working tree", async () => {
    await withDecisionStub(jevResponse(STUB_ANSWERS), async (url, bodies) => {
      writeStubConfig(url, "jev");
      const pi = makeFakePi();
      extension(pi.api as never);
      const handler = toolCallHandler(pi, "guard");

      for (const command of ["ls -la", "git status", "npm test", "grep -rn foo src", "cat README.md"]) {
        assert.equal(await handler({ toolName: "bash", input: { command } }, fakeContext(home)), undefined);
      }
      assert.equal(bodies.length, 0);
    });
  });

  it("asks the user when the model cannot be reached, and skips the dead provider next time", async () => {
    withProviderConfig();
    const pi = makeFakePi();
    extension(pi.api as never);
    const ctx = fakeContext(home);
    const asked: string[] = [];
    ctx.ui.confirm = async (_title: string, message?: string) => {
      asked.push(message ?? "");
      return true;
    };

    const handler = toolCallHandler(pi, "guard");
    assert.equal(await handler({ toolName: "bash", input: { command: "terraform apply" } }, ctx), undefined);
    assert.equal(asked.length, 1);
    assert.match(asked[0] ?? "", /could not be reached/);

    const started = Date.now();
    await handler({ toolName: "bash", input: { command: "terraform destroy -target=x" } }, ctx);
    assert.match(asked[1] ?? "", /failed recently/);
    assert.ok(Date.now() - started < 200, "a provider in cooldown must not be waited on");
  });

  it("stays out of the way when hook.model is off", async () => {
    await withDecisionStub(jevResponse(STUB_ANSWERS), async (url, bodies) => {
      withProviderConfig({ hook: { model: "off" } }, url);
      const pi = makeFakePi();
      extension(pi.api as never);
      assert.equal(
        await toolCallHandler(pi, "guard")({ toolName: "bash", input: { command: "git push" } }, fakeContext(home)),
        undefined,
      );
      assert.equal(bodies.length, 0);
    });
  });

  it("logs but does not act in shadow mode", async () => {
    await withDecisionStub(jevResponse(STUB_ANSWERS), async (url, bodies) => {
      withProviderConfig({ shadow: { gate: true } }, url);
      const pi = makeFakePi();
      extension(pi.api as never);
      assert.equal(
        await toolCallHandler(pi, "guard")({ toolName: "bash", input: { command: "git push" } }, fakeContext(home)),
        undefined,
      );
      assert.equal(bodies.length, 1);
    });
  });
});

describe("the system prompt section", () => {
  const beforeStart = (pi: FakePi) =>
    pi.handlers.get("before_agent_start")?.[0] as (event: unknown, ctx: unknown) => Promise<{ systemPrompt?: string } | undefined>;

  it("states the workflow once a provider is configured", async () => {
    withProviderConfig();
    const pi = makeFakePi();
    pi.api.getActiveTools = () => ["read", "bash", "jev_triage", "jev_gate", "jev_verify", "jev_decide"];
    extension(pi.api as never);

    const result = await beforeStart(pi)({ systemPrompt: "BASE", prompt: "hi" }, fakeContext(home));
    assert.ok(result?.systemPrompt?.startsWith("BASE"));
    assert.match(result?.systemPrompt ?? "", /jev_triage first/);
    assert.match(result?.systemPrompt ?? "", /jev_verify/);
  });

  it("only mentions tools that are active", () => {
    const text = promptSection(["jev_gate"]);
    assert.match(text, /jev_gate/);
    assert.doesNotMatch(text, /jev_triage|jev_verify|jev_decide/);
  });

  it("adds nothing without a provider, or when switched off", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    assert.equal(await beforeStart(pi)({ systemPrompt: "BASE" }, fakeContext(home)), undefined);

    withProviderConfig({ prompt: { inject: false } });
    assert.equal(await beforeStart(pi)({ systemPrompt: "BASE" }, fakeContext(home)), undefined);
  });
});

describe("the triage hint and the usage count", () => {
  const toolResult = (pi: FakePi) =>
    pi.handlers.get("tool_result")?.[0] as (event: unknown, ctx: unknown) => Promise<{ content?: Array<{ text?: string }> } | undefined>;
  const usage = (pi: FakePi) => (pi.handlers.get("tool_call") ?? [])[2] as (event: unknown, ctx: unknown) => Promise<unknown>;
  const agentEnd = (pi: FakePi) => pi.handlers.get("agent_end")?.[0] as (event: unknown, ctx: unknown) => Promise<unknown>;

  const grepResult = (hits: number) => ({
    toolName: "grep",
    isError: false,
    input: { pattern: "billing", path: "src" },
    content: [{ type: "text", text: Array.from({ length: hits }, (_, i) => `src/f${i}.ts:1: billing`).join("\n") }],
  });

  it("points at jev_triage on a large search result, with the pattern already filled in", async () => {
    withProviderConfig();
    const pi = makeFakePi();
    extension(pi.api as never);

    const result = await toolResult(pi)(grepResult(40), fakeContext(home));
    const last = result?.content?.at(-1)?.text ?? "";
    assert.match(last, /40 results/);
    assert.match(last, /jev_triage/);
    assert.match(last, /pattern="billing"/);
  });

  it("leaves a small result alone", async () => {
    withProviderConfig();
    const pi = makeFakePi();
    extension(pi.api as never);
    assert.equal(await toolResult(pi)(grepResult(5), fakeContext(home)), undefined);
  });

  it("records a missed triage and a missed verify when the run ends", async () => {
    withProviderConfig();
    const pi = makeFakePi();
    extension(pi.api as never);

    await toolResult(pi)(grepResult(40), fakeContext(home));
    await usage(pi)({ toolName: "edit", input: {} }, fakeContext(home));
    await agentEnd(pi)({ messages: [] }, fakeContext(home));

    const missed = readLedger().filter((entry) => entry.kind === "opportunity");
    assert.deepEqual(missed.map((entry) => (entry.kind === "opportunity" ? entry.tool : "")).sort(), ["jev_triage", "jev_verify"]);
  });

  it("does not count a miss when the agent follows the hint", async () => {
    withProviderConfig();
    const pi = makeFakePi();
    extension(pi.api as never);

    await toolResult(pi)(grepResult(40), fakeContext(home));
    await usage(pi)({ toolName: "jev_triage", input: {} }, fakeContext(home));
    await usage(pi)({ toolName: "write", input: {} }, fakeContext(home));
    await usage(pi)({ toolName: "jev_verify", input: {} }, fakeContext(home));
    await agentEnd(pi)({ messages: [] }, fakeContext(home));

    assert.equal(readLedger().filter((entry) => entry.kind === "opportunity").length, 0);
  });
});

describe("tool activation", () => {
  it("hides the provider-only tools until a provider exists, and brings back only those", async () => {
    const pi = makeFakePi();
    let active = ["read", "bash", "jev_gate", "jev_triage", "jev_decide"]; // jev_verify excluded by the user
    pi.api.getActiveTools = () => active;
    pi.api.setActiveTools = (names: string[]) => {
      active = names;
    };
    extension(pi.api as never);

    await pi.handlers.get("session_start")?.[0]?.({ reason: "resume" }, fakeContext(home));
    assert.deepEqual(active, ["read", "bash", "jev_gate"]);

    withProviderConfig();
    await (pi.handlers.get("tool_result")?.[0] as (e: unknown, c: unknown) => Promise<unknown>)(
      { toolName: "jev_setup", isError: false, input: {}, content: [] },
      fakeContext(home),
    );
    assert.deepEqual([...active].sort(), ["bash", "jev_decide", "jev_gate", "jev_triage", "read"]);
  });
});
