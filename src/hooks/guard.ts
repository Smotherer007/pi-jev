/**
 * The bash hook: deterministic rules first, then — for consequential commands
 * the rules cannot judge — the decision model, before the command runs.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getConfig, type JevConfig } from "../config.ts";
import { hardGuard } from "../guard.ts";
import { classifyWithModel, isConsequential } from "../gate-model.ts";
import { hasProvider } from "./shared.ts";

export function registerGuard(pi: ExtensionAPI): void {
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

}
