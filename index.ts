/**
 * pi-jev — a typed decision layer for the pi coding agent.
 *
 * The idea in one line: give the agent a cheap, fast, *typed* way to make the
 * small judgements it currently spends frontier tokens and extra turns on.
 *
 * Where it sits:
 *
 *     candidates (fs + regex)  →  0 tokens
 *     Jev: typed, calibrated   →  ~100 ms, cents per million tokens
 *     pi / frontier model       →  reasoning, judgement, the answer to the user
 *
 * The extension never puts Jev in front of the user. Jev does not generate text
 * and cannot explain itself, so everything the user reads still comes from the
 * main model. Jev gates what that model does and reads.
 *
 * Tools:
 *   jev_setup    configure the provider chain (Jev, local Ollama, any compatible)
 *   jev_status   configuration, reachability, ledger statistics
 *   jev_decide   the raw primitive: typed questions over a state
 *   jev_triage   filter many candidates down before reading any of them
 *   jev_verify   check claims against the diff
 *   jev_gate     classify an action's risk before it runs
 *   jev_label    attach ground truth, so calibration means something
 *
 * Commands:
 *   /jev                 status
 *   /jev-calibration     reliability curve and threshold sweep
 *   /jev-shadow <spec>   turn shadow mode on or off per tool
 *   /jev-providers       provider chain
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { configPath, getConfig, saveConfig, type JevConfig } from "./src/config.ts";
import { hardGuard } from "./src/guard.ts";
import { classifyWithModel, isConsequential } from "./src/gate-model.ts";
import { findShadowMiss, readLedger, recordOpportunity, recordShadowMiss } from "./src/ledger.ts";
import { warmUp } from "./src/providers/index.ts";
import { trimMissFor, trimOutput } from "./src/trim.ts";
import { forgetPruneMiss, pruneContext, pruneMissFor, type Msg } from "./src/prune.ts";
import {
  calibrationReport,
  joinLabels,
  ledgerOverview,
  type LabelledAnswer,
} from "./src/calibration.ts";
import { formatCalibration, formatOverview } from "./src/format.ts";
import { ensureConfigFile, JevSetupTool } from "./src/tools/jev-setup.ts";
import { JevStatusTool, describeStatus } from "./src/tools/jev-status.ts";
import { JevDecideTool } from "./src/tools/jev-decide.ts";
import { JevTriageTool } from "./src/tools/jev-triage.ts";
import { JevVerifyTool } from "./src/tools/jev-verify.ts";
import { JevGateTool } from "./src/tools/jev-gate.ts";
import { JevLabelTool } from "./src/tools/jev-label.ts";

/**
 * Every tool the extension registers.
 *
 * The four the agent is meant to reach for on its own — jev_decide, jev_triage,
 * jev_verify, jev_gate — carry prompt guidelines that say when to use them.
 * jev_setup, jev_status and jev_label are administrative or retrospective, so
 * they carry only a snippet and stay out of the Guidelines section.
 */
const TOOLS = [JevSetupTool, JevStatusTool, JevDecideTool, JevTriageTool, JevVerifyTool, JevGateTool, JevLabelTool];

/**
 * The tools that need a provider to do anything. Without one they can only
 * fail, and a tool that can only fail still costs prompt surface and a wrong
 * turn when the model tries it — so they are hidden until a provider exists.
 * jev_gate stays: its rule layer works with no provider at all.
 */
const PROVIDER_TOOLS = ["jev_decide", "jev_triage", "jev_verify"];

let warmupEnabled = true;

/** Test only: keep session_start from opening network connections. */
export function _disableWarmup(): void {
  warmupEnabled = false;
}

function hasProvider(config: JevConfig): boolean {
  return config.providers.some((provider) => !provider.manual);
}

/**
 * The section added to the system prompt.
 *
 * The per-tool guidelines are appended as loose bullets among everyone else's,
 * and a model skims past them. This states the workflow once, in the order it
 * applies, which is what makes a model reach for the tools at the right moment
 * instead of only when it happens to remember them.
 */
export function promptSection(active: readonly string[], options: { shortening?: boolean } = {}): string {
  const has = (name: string) => active.includes(name);
  const lines = [
    "## Decision layer (pi-jev)",
    "",
    "You have a fast typed decision model (~100 ms per call, a fraction of a cent) for bounded judgements. " +
      "Use it for the small decisions instead of spending turns and context on them yourself:",
  ];
  if (has("jev_triage")) {
    lines.push(
      "- Before reading: when a search or listing gives more than ~20 candidates, call jev_triage first and read only what survives. Do not read files speculatively to find out which matter.",
    );
  }
  if (has("jev_gate")) {
    lines.push(
      "- Before acting: call jev_gate before a command whose effect is not obvious — remote systems, databases, history rewrites, deletes, deploys. Consequential bash commands are also checked automatically before they run.",
    );
  }
  if (has("jev_verify")) {
    lines.push(
      "- Before reporting: after changing files, call jev_verify with your key claims as single checkable assertions before telling the user the work is done.",
    );
  }
  if (has("jev_decide")) {
    lines.push(
      "- Any other bounded choice (classify, route, yes/no): jev_decide, with every question you already know you need in one call.",
    );
  }
  if (options.shortening) {
    lines.push(
      "- Long command output and earlier tool outputs that no longer matter may be shortened. A `[pi-jev: …]` note says what was left out and how to get it back — one tool call, when you actually need it.",
    );
  }
  lines.push("", "The decision model answers; you still reason and write everything the user reads.");
  return lines.join("\n");
}

/** Count the result lines a search or listing produced, ignoring pi's own notes. */
function countHits(content: ReadonlyArray<{ type: string; text?: string }>): number {
  let count = 0;
  for (const block of content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    for (const line of block.text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (/^\[.*\]$/.test(trimmed) || /^\(.*\)$/.test(trimmed)) continue;
      count += 1;
    }
  }
  return count;
}

function reportText(scope: string, answers: LabelledAnswer[]): string {
  const pairs = answers.map((answer) => ({ p: answer.p, correct: answer.correct }));
  return formatCalibration(calibrationReport(pairs), scope);
}

/** Group labelled answers by a key, so each view gets its own curve. */
function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const bucket = out.get(key(item));
    if (bucket) bucket.push(item);
    else out.set(key(item), [item]);
  }
  return out;
}

export default function (pi: ExtensionAPI) {
  for (const tool of TOOLS) pi.registerTool(tool as never);

  /* ------------------------------------------------------ config seeding */

  /**
   * Show or hide the tools that need a provider, to match the configuration.
   * Runs at session start and again after jev_setup, so adding a provider makes
   * them appear without a restart.
   */
  const hiddenByUs = new Set<string>();
  const syncActiveTools = () => {
    try {
      const active = pi.getActiveTools();
      // An empty list means pi has not settled its tools yet; setting one now
      // would replace the whole set with ours.
      if (active.length === 0) return;

      let next: string[];
      if (hasProvider(getConfig())) {
        // Only bring back what this extension hid. A tool the user excluded on
        // the command line (`pi -xt jev_verify`) stays excluded.
        next = [...active, ...[...hiddenByUs].filter((name) => !active.includes(name))];
        hiddenByUs.clear();
      } else {
        for (const name of PROVIDER_TOOLS) if (active.includes(name)) hiddenByUs.add(name);
        next = active.filter((name) => !PROVIDER_TOOLS.includes(name));
      }
      if (next.length !== active.length) pi.setActiveTools(next);
    } catch {
      /* an older pi without tool activation: leave everything registered */
    }
  };

  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    const config = getConfig();
    syncActiveTools();

    if (hasProvider(config) && warmupEnabled) {
      // Not awaited: the session must not wait on a network round trip.
      void warmUp();
    }

    if (event.reason !== "startup") return;

    const fresh = ensureConfigFile();

    if (!ctx.hasUI) return;

    if (config.providers.length === 0) {
      ctx.ui.notify(
        `pi-jev: no provider configured yet. Run jev_setup (kind=jev for TypeSafe, kind=ollama for a local model), or edit ${fresh.path}. The local guard rules work either way.`,
        "info",
      );
    }

    const shadow = config.shadow;
    if (shadow.triage || shadow.verify || shadow.gate) {
      const active = Object.entries(shadow)
        .filter(([, on]) => on)
        .map(([name]) => name)
        .join(", ");
      ctx.ui.setStatus("jev-shadow", `jev shadow: ${active}`);
    }
  });

  /**
   * The workflow, stated once in the system prompt, so the model reaches for
   * the decision layer at the right moment rather than when it remembers to.
   */
  pi.on("before_agent_start", async (event) => {
    const config = getConfig();
    if (!config.prompt.inject || !hasProvider(config)) return;

    let active: string[];
    try {
      active = pi.getActiveTools();
    } catch {
      active = TOOLS.map((tool) => tool.name);
    }
    if (!active.some((name) => name.startsWith("jev_"))) return;

    const shortening =
      (config.trim.enabled && !config.shadow.trim) || (config.prune.enabled && !config.shadow.prune);
    return { systemPrompt: `${event.systemPrompt}\n\n${promptSection(active, { shortening })}` };
  });

  /**
   * The deterministic rules, as a hook rather than as advice.
   *
   * `jev_gate` only fires when the model chooses to call it, and a model that
   * has already decided to run a command is not the party you want asking on its
   * own behalf. The rules in `guard.ts` need no provider, no key and no network,
   * so there is nothing to weigh against applying them to every shell command
   * before it runs. This is the one part of pi-jev that works before anything
   * else does.
   *
   * What it is not: a sandbox, or a permission system. It reads a command string,
   * so it catches what is dangerous on its face and nothing else. A danger that
   * arrives through a variable, a downloaded script or a path is invisible to it
   * — which is exactly the part `jev_gate` exists to judge.
   *
   * The rule's own verdict is used as it stands. `config.gate` maps the risk
   * classes the *model* reports; a rule that can see what it is looking at does
   * not consult a table about it, and a typo in that table cannot disarm it.
   *
   * The `confirm` tier is the one place the doctrine is relaxed. Those rules
   * mean "worth a look", not "unambiguous danger", and in a session with no UI
   * to ask through, refusing every `sudo` is how a guardrail gets uninstalled.
   * The `block` tier is refused with or without a UI.
   */
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    const config = getConfig();
    if (!config.hook.bash) return;
    if (event.toolName !== "bash") return;

    const input = event.input as { command?: unknown } | undefined;
    const command = typeof input?.command === "string" ? input.command : "";
    if (command.trim().length === 0) return;

    const hard = hardGuard({ action: command });
    // Nothing is certain about it to the rules. Whether the decision model gets a
    // say depends on hook.model; otherwise `jev_gate` still can, if asked.
    if (!hard) return modelGate(command, config, ctx);

    const reason =
      `pi-jev: ${hard.verdict} · risk=${hard.risk} · blast=${hard.blast}/4 — ${hard.reason} ` +
      `(matched ${hard.matched}). Local rules decided this, not the model, so rewording the command will not change it.`;

    if (hard.verdict === "block") {
      return { block: true, reason };
    }

    if (hard.verdict === "confirm" && ctx.hasUI) {
      const allowed = await ctx.ui.confirm("pi-jev: this command needs a look", `${reason}\n\n${command}`);
      if (!allowed) return { block: true, reason: "pi-jev: the user declined this command." };
    }
  });

  /**
   * The model half of the hook: what the rules could not see, judged before the
   * command runs instead of only when the agent thinks to ask.
   *
   * Speed is the constraint here, because this sits in front of every matching
   * command. So: only consequential commands by default, a 2.5 s deadline,
   * identical commands answered from the decision cache, and a provider that
   * just failed skipped rather than waited on. A read-only `ls` never gets here.
   *
   * Fail-safe as everywhere else: an unreachable model means "confirm", never
   * "allow". With no UI to ask through, confirm runs — the same relaxation, for
   * the same reason, as the rule layer's confirm tier.
   */
  async function modelGate(command: string, config: JevConfig, ctx: ExtensionContext) {
    if (config.hook.model === "off" || !hasProvider(config)) return;
    if (config.hook.model === "consequential" && !isConsequential(command)) return;

    const shadow = config.shadow.gate;
    let verdict: "allow" | "confirm" | "block";
    let summary: string;
    try {
      const result = await classifyWithModel({
        action: command,
        context: `bash in ${ctx.cwd}`,
        // The configured policy decides, not a per-call ceiling: the hook has no
        // caller with its own risk appetite.
        allowedRisk: "needs_human",
        tool: "jev_gate_hook",
        shadow,
      });
      verdict = result.verdict;
      summary =
        `risk=${result.risk}${result.blast === null ? "" : ` · blast=${result.blast}/4`} · p=${result.p.toFixed(2)} · ` +
        `${result.outcome.cached ? "cached" : `${result.outcome.latencyMs} ms`} · decision ${result.outcome.decisionId}` +
        (result.rationale.length > 0 ? ` — ${result.rationale.join("; ")}` : "");
    } catch (error) {
      verdict = "confirm";
      // "Every provider failed." followed by one line per provider; fold it into one.
      const detail = (error as Error).message
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !/^Every provider failed/.test(line))
        .join("; ");
      summary = `the decision model could not be reached${detail ? ` (${detail})` : ""}`;
    }

    // Shadow mode: logged in the ledger, not acted on.
    if (shadow || verdict === "allow") return;

    const reason = `pi-jev: ${verdict} · ${summary}. The decision model judged this command before it ran.`;

    if (verdict === "block") {
      return {
        block: true,
        reason: `${reason} Ask the user rather than rephrasing the command until it passes.`,
      };
    }

    if (ctx.hasUI) {
      const allowed = await ctx.ui.confirm("pi-jev: the decision model wants a look", `${reason}\n\n${command}`);
      if (!allowed) return { block: true, reason: "pi-jev: the user declined this command." };
    }
    return;
  }

  /**
   * Shadow-miss detection.
   *
   * The failure mode a filter has and a verifier does not: dropping the one
   * item that mattered, silently. So when triage runs in shadow mode it
   * remembers what it *would* have dropped, and here we notice if the agent
   * goes on to read exactly that. It is a heuristic — the read may be
   * unrelated — hence "candidate false negative" everywhere in the report.
   */
  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (event.toolName !== "read" && event.toolName !== "grep" && event.toolName !== "edit") return;
    const config = getConfig();
    if (!config.shadow.triage) return;

    const input = event.input as { path?: unknown; file_path?: unknown; pattern?: unknown } | undefined;
    const candidate = input?.path ?? input?.file_path ?? input?.pattern;
    if (typeof candidate !== "string" || candidate.length === 0) return;

    // The working directory matters: a triage key is relative to the search root
    // and a read path is relative to the cwd, so both sides are resolved against
    // the real location before anything is recorded as a miss.
    const miss = findShadowMiss(candidate, ctx.cwd);
    if (miss) {
      recordShadowMiss(miss.decisionId, miss.item, event.toolName);
    }
  });

  /* ------------------------------------------ is the layer actually used? */

  /**
   * Per agent run: search results big enough to triage that nobody triaged, and
   * edits that nobody verified. Flushed to the ledger when the run ends, so a
   * triage that follows the hint a moment later cancels its opportunity instead
   * of being counted as both a use and a miss.
   */
  const run = { pendingTriage: [] as string[], edits: 0, verified: false };

  pi.on("tool_call", async (event, ctx: ExtensionContext) => {
    if (event.toolName === "read") {
      // A read of something trim or prune took out of the context is the one
      // signal that they withheld something that mattered.
      const input = event.input as { path?: unknown; file_path?: unknown } | undefined;
      const target = input?.path ?? input?.file_path;
      if (typeof target === "string" && target.length > 0) {
        const trimmed = trimMissFor(target, ctx.cwd);
        if (trimmed) recordShadowMiss(trimmed, target, "read (trimmed output)");
        const pruned = pruneMissFor(target, ctx.cwd);
        if (pruned) {
          recordShadowMiss(pruned, target, "read again (pruned)");
          forgetPruneMiss(target, ctx.cwd);
        }
      }
    }
    if (event.toolName === "jev_triage") run.pendingTriage.shift();
    else if (event.toolName === "jev_verify") run.verified = true;
    else if (event.toolName === "edit" || event.toolName === "write") run.edits += 1;
  });

  pi.on("agent_end", async () => {
    const config = getConfig();
    if (config.hook.opportunities && hasProvider(config)) {
      for (const detail of run.pendingTriage) recordOpportunity("jev_triage", detail);
      if (run.edits > 0 && !run.verified) {
        recordOpportunity("jev_verify", `${run.edits} edit${run.edits === 1 ? "" : "s"}, no verify`);
      }
    }
    run.pendingTriage = [];
    run.edits = 0;
    run.verified = false;
  });

  /**
   * The triage hint, placed where it changes behaviour: on the search result
   * itself, at the moment the agent decides what to read next. One line, and
   * only past the threshold, so a normal search is left alone.
   */
  pi.on("tool_result", async (event, ctx: ExtensionContext) => {
    if (event.toolName === "jev_setup") {
      syncActiveTools();
      return;
    }
    if (event.toolName === "bash") {
      const content = await trimBash(event as never, ctx);
      return content ? { content: content as typeof event.content } : undefined;
    }
    // Not ls: a directory listing is orientation, and a hint on every large one
    // would be noise the model learns to ignore — hints included.
    if (event.toolName !== "grep" && event.toolName !== "find") return;
    if (event.isError) return;

    const config = getConfig();
    const threshold = config.hook.triageHintAt;
    if (threshold <= 0 || !hasProvider(config)) return;

    const hits = countHits(event.content as Array<{ type: string; text?: string }>);
    if (hits < threshold) return;

    run.pendingTriage.push(`${event.toolName}: ${hits} results`);

    const input = event.input as { pattern?: unknown; path?: unknown };
    const pattern = typeof input.pattern === "string" && event.toolName === "grep" ? input.pattern : undefined;
    const root = typeof input.path === "string" ? input.path : undefined;
    const args = [
      'question="<what you are looking for>"',
      ...(pattern ? [`pattern=${JSON.stringify(pattern)}`] : []),
      ...(root ? [`root=${JSON.stringify(root)}`] : []),
    ].join(" ");

    return {
      content: [
        ...event.content,
        {
          type: "text" as const,
          text: `\n[pi-jev] ${hits} results. Before reading any of them, jev_triage ${args} filters them down to the few that matter in one ~100 ms call.`,
        },
      ],
    };
  });

  /* ------------------------------------------- less context, every turn */

  /**
   * Long bash output, cut to what matters before it enters the context. Failed
   * commands included: a failing test run is the most common two-thousand-line
   * output and the one where thirty lines matter.
   */
  async function trimBash(
    event: { content: Array<{ type: string; text?: string }>; input: Record<string, unknown>; details?: unknown },
    ctx: ExtensionContext,
  ) {
    const config = getConfig();
    if (!config.trim.enabled || !hasProvider(config)) return;

    const text = event.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n");
    const command = typeof event.input.command === "string" ? event.input.command : "";
    const details = event.details as { fullOutputPath?: unknown } | undefined;
    const fullOutputPath = typeof details?.fullOutputPath === "string" ? details.fullOutputPath : undefined;

    const result = await trimOutput(text, command, {
      ...(fullOutputPath ? { fullOutputPath } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (!result.text) return;

    return [...event.content.filter((part) => part.type !== "text"), { type: "text" as const, text: result.text }];
  }

  /**
   * Earlier outputs that no longer matter, stubbed before each LLM call. The
   * messages pi hands over are a copy, so this changes what is sent, not the
   * session: the full history stays on disk and in /tree.
   */
  pi.on("context", async (event, ctx: ExtensionContext) => {
    const config = getConfig();
    if (!config.prune.enabled || !hasProvider(config)) return;
    const result = await pruneContext(event.messages as unknown as Msg[], ctx.cwd, ctx.signal);
    if (!result.messages) return;
    return { messages: result.messages as unknown as typeof event.messages };
  });

  /* ------------------------------------------------------------- commands */

  pi.registerCommand("jev", {
    description: "pi-jev status: configuration, provider health, ledger statistics",
    handler: async (_args, ctx: ExtensionContext) => {
      const entries = readLedger();
      const text = [
        `config ${configPath()}`,
        "",
        formatOverview(ledgerOverview(entries)),
      ].join("\n");
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else process.stdout.write(`${text}\n`);
    },
  });

  pi.registerCommand("jev-calibration", {
    description: "Calibration of past decisions: reliability curve and threshold sweep",
    getArgumentCompletions: (prefix: string) => {
      const scopes = ["all", "by-tool", "by-provider"];
      const filtered = scopes.filter((scope) => scope.startsWith(prefix)).map((scope) => ({ value: scope, label: scope }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx: ExtensionContext) => {
      const scope = (args || "all").trim();
      const labelled = joinLabels(readLedger());

      if (labelled.length === 0) {
        const text = reportText("all decisions", []);
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        else process.stdout.write(`${text}\n`);
        return;
      }

      const sections: string[] = [];
      if (scope === "by-tool") {
        for (const [tool, answers] of groupBy(labelled, (answer) => answer.tool)) {
          sections.push(reportText(`tool ${tool}`, answers));
          sections.push("");
        }
      } else if (scope === "by-provider") {
        for (const [provider, answers] of groupBy(labelled, (answer) => answer.provider)) {
          sections.push(reportText(`provider ${provider}`, answers));
          sections.push("");
        }
      } else {
        sections.push(reportText("all labelled answers", labelled));
        sections.push("");
        sections.push(reportText("excluding shadow-mode decisions", labelled.filter((answer) => !answer.shadow)));
        sections.push("");
        sections.push(reportText("shadow-mode decisions only", labelled.filter((answer) => answer.shadow)));
      }

      const text = sections.join("\n").replace(/\n{3,}/g, "\n\n").trim();
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else process.stdout.write(`${text}\n`);
    },
  });

  pi.registerCommand("jev-shadow", {
    description: "Turn shadow mode on or off: /jev-shadow triage|verify|gate|trim|prune|all|none [on|off]",
    getArgumentCompletions: (prefix: string) => {
      const options = ["triage", "verify", "gate", "trim", "prune", "all", "none"];
      const filtered = options.filter((option) => option.startsWith(prefix)).map((option) => ({ value: option, label: option }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx: ExtensionContext) => {
      const [targetRaw, stateRaw] = args.trim().split(/\s+/);
      const config = structuredClone(getConfig());

      if (!targetRaw) {
        const current = Object.entries(config.shadow)
          .map(([name, on]) => `${name}=${on ? "on" : "off"}`)
          .join("  ");
        const text =
          `Shadow mode: ${current}\n\n` +
          "In shadow mode the tool runs and the decision is logged, but nothing is withheld — " +
          "jev_triage returns every candidate and marks what it would have dropped, and pi-jev " +
          "records any of those you then read as a candidate false negative. Run in shadow until " +
          "that number is boringly low, then turn it off.";
        if (ctx.hasUI) ctx.ui.notify(text, "info");
        else process.stdout.write(`${text}\n`);
        return;
      }

      const targets =
        targetRaw === "all" || targetRaw === "none" ? Object.keys(config.shadow) : [targetRaw];
      for (const target of targets) {
        if (!(target in config.shadow)) {
          const text = `Unknown target "${target}". Use triage, verify, gate, trim, prune, all or none.`;
          if (ctx.hasUI) ctx.ui.notify(text, "error");
          else process.stdout.write(`${text}\n`);
          return;
        }
      }

      // Naming `none` is itself the answer for the state, so `/jev-shadow none`
      // cannot mean "turn everything on". An explicit on/off still wins.
      const on =
        stateRaw === undefined ? targetRaw !== "none" : stateRaw === "on" || stateRaw === "true";
      for (const target of targets) {
        config.shadow[target as keyof typeof config.shadow] = on;
      }
      saveConfig(config);

      const state = Object.entries(config.shadow)
        .map(([name, value]) => `${name}=${value ? "on" : "off"}`)
        .join("  ");

      if (ctx.hasUI) {
        ctx.ui.setStatus("jev-shadow", on ? `jev shadow: ${targets.join(", ")}` : undefined);
        ctx.ui.notify(`Shadow mode: ${state}`, "info");
      } else {
        process.stdout.write(`Shadow mode: ${state}\n`);
      }
    },
  });

  pi.registerCommand("jev-providers", {
    description: "Show the pi-jev provider chain and its reachability",
    handler: async (_args, ctx: ExtensionContext) => {
      // Reuse the status rendering so there is exactly one of it.
      const text = await describeStatus();
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else process.stdout.write(`${text}\n`);
    },
  });
}
