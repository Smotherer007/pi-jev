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

import { configPath, getConfig, saveConfig } from "./src/config.ts";
import { hardGuard } from "./src/guard.ts";
import { findShadowMiss, readLedger, recordShadowMiss } from "./src/ledger.ts";
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

  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    if (event.reason !== "startup") return;

    const config = getConfig();
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
    // Nothing is certain about it, so this hook has no opinion. `jev_gate` still
    // can, if the model asks.
    if (!hard) return;

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
    description: "Turn shadow mode on or off: /jev-shadow triage|verify|gate|all|none [on|off]",
    getArgumentCompletions: (prefix: string) => {
      const options = ["triage", "verify", "gate", "all", "none"];
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
          const text = `Unknown target "${target}". Use triage, verify, gate, all or none.`;
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
