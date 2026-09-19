import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import extension from "../index.ts";
import { _resetConfigCache } from "../src/config.ts";

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
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
    },
    isProjectTrusted: () => true,
    sessionManager: { getEntries: () => [] },
    signal: undefined,
  };
}

let home: string;
let notifications: string[];
let statuses: Array<{ key: string; text: string | undefined }>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-ext-"));
  process.env.HOME = home;
  // The config is cached per process, so each test needs it dropped or it would
  // keep reading the previous test's HOME.
  _resetConfigCache();
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
    assert.equal(pi.handlers.get("tool_call")?.length, 1);
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

  it("/jev-providers prints the chain", async () => {
    await runCommand("jev-providers", "");
    assert.ok(notifications.some((text) => text.includes("pi-jev")));
  });
});

describe("shadow-miss detection", () => {
  it("ignores tool calls whose name is unrelated", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    const handler = pi.handlers.get("tool_call")?.[0] as (e: unknown, c: unknown) => Promise<unknown>;
    assert.doesNotReject(() => handler({ toolName: "ls", input: {} }, fakeContext(home)));
  });

  it("ignores a read when shadow mode is off, so nothing is misattributed", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    const handler = pi.handlers.get("tool_call")?.[0] as (e: unknown, c: unknown) => Promise<unknown>;
    await handler({ toolName: "read", input: { path: "src/anything.ts" } }, fakeContext(home));

    const ledger = path.join(home, ".pi", "jev-ledger.jsonl");
    assert.equal(fs.existsSync(ledger), false);
  });

  it("survives a tool call with no useful path", async () => {
    const pi = makeFakePi();
    extension(pi.api as never);
    const handler = pi.handlers.get("tool_call")?.[0] as (e: unknown, c: unknown) => Promise<unknown>;
    await handler({ toolName: "read", input: {} }, fakeContext(home));
    await handler({ toolName: "read" }, fakeContext(home));
    await handler({ toolName: "grep", input: { path: 42 } }, fakeContext(home));
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
