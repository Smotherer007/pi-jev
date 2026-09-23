/**
 * The slash commands. Setup and labelling live here rather than as tools: they
 * are the user's job, not the agent's, and an API key typed into a command
 * never passes through the model's context.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getConfig, saveConfig } from "../config.ts";
import { readLedger } from "../ledger.ts";
import { calibrationReport, joinLabels, type LabelledAnswer } from "../calibration.ts";
import { formatCalibration } from "../format.ts";
import { describeStatus } from "./status.ts";
import { parseSetupArgs, setupProvider, SETUP_USAGE } from "./setup.ts";
import { labelDecision, listDecisions, parseLabelArgs, LABEL_USAGE } from "./label.ts";
import { show } from "../hooks/shared.ts";

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

export function registerCommands(pi: ExtensionAPI, hooks: { syncActiveTools: () => void }): void {
  pi.registerCommand("jev", {
    description: "pi-jev status: providers, configuration, ledger, used vs. missed",
    handler: async (args, ctx: ExtensionContext) => {
      show(ctx, await describeStatus({ verbose: args.trim() === "verbose" }));
    },
  });

  pi.registerCommand("jev-setup", {
    description: "Configure providers: /jev-setup [list] | add jev|ollama|openai-compat [key=value…] | remove <id>",
    getArgumentCompletions: (prefix: string) => {
      const options = ["list", "add jev", "add ollama", "add openai-compat", "remove"];
      const filtered = options.filter((option) => option.startsWith(prefix)).map((option) => ({ value: option, label: option }));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args, ctx: ExtensionContext) => {
      try {
        const params = parseSetupArgs(args);
        // Ask for what is missing rather than failing, when there is someone to ask.
        if (params.action === "add" && ctx.hasUI) {
          if (params.kind === "jev" && !params.apiKey) {
            params.apiKey = (await ctx.ui.input("TypeSafe API key (console.typesafe.ai)")) || undefined;
          }
          if (params.kind !== "jev" && !params.model) {
            params.model = (await ctx.ui.input(params.kind === "ollama" ? "Model (see `ollama list`)" : "Model")) || undefined;
          }
        }
        const text = await setupProvider(params);
        hooks.syncActiveTools();
        show(ctx, text);
      } catch (error) {
        show(ctx, `${(error as Error).message}\n\n${SETUP_USAGE}`, "error");
      }
    },
  });

  pi.registerCommand("jev-label", {
    description: "Record ground truth: /jev-label [list] | <decisionId> ok|wrong [q=<questionId>] [note]",
    handler: async (args, ctx: ExtensionContext) => {
      try {
        const parsed = parseLabelArgs(args);
        show(ctx, parsed.action === "list" ? listDecisions(parsed.limit) : labelDecision(parsed));
      } catch (error) {
        show(ctx, `${(error as Error).message}\n\n${LABEL_USAGE}`, "error");
      }
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
        show(ctx, text);
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
      show(ctx, text);
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
        show(ctx, text);
        return;
      }

      const targets =
        targetRaw === "all" || targetRaw === "none" ? Object.keys(config.shadow) : [targetRaw];
      for (const target of targets) {
        if (!(target in config.shadow)) {
          const text = `Unknown target "${target}". Use triage, verify, gate, trim, prune, all or none.`;
          show(ctx, text, "error");
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

}
