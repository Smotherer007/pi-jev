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
 * Tools, for the agent:
 *   jev_triage   filter many candidates down before reading any of them
 *   jev_verify   check claims against the diff
 *   jev_gate     classify an action's risk before it runs
 *   jev_decide   the raw primitive: typed questions over a state
 *
 * Automatic, without being asked (src/hooks):
 *   guard        rules, then the model, before consequential bash commands
 *   usage        triage hint, used-vs-missed counts, shadow misses
 *   context      trim long bash output, prune outputs the task has moved past
 *   session      tool activation, system-prompt section, provider warm-up
 *
 * Commands, for the user (src/commands):
 *   /jev                 status: providers, config, ledger, used vs. missed
 *   /jev-setup           configure the provider chain
 *   /jev-label           attach ground truth, so calibration means something
 *   /jev-calibration     reliability curve and threshold sweep
 *   /jev-shadow <spec>   turn shadow mode on or off per step
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { JevDecideTool } from "./src/tools/jev-decide.ts";
import { JevTriageTool } from "./src/tools/jev-triage.ts";
import { JevVerifyTool } from "./src/tools/jev-verify.ts";
import { JevGateTool } from "./src/tools/jev-gate.ts";
import { registerSession } from "./src/hooks/session.ts";
import { registerGuard } from "./src/hooks/guard.ts";
import { registerUsage } from "./src/hooks/usage.ts";
import { registerContext } from "./src/hooks/context.ts";
import { registerCommands } from "./src/commands/index.ts";

export { _disableWarmup, promptSection } from "./src/hooks/session.ts";

/** The tools the agent reaches for. Everything administrative is a command. */
const TOOLS = [JevTriageTool, JevVerifyTool, JevGateTool, JevDecideTool];

export default function (pi: ExtensionAPI) {
  for (const tool of TOOLS) pi.registerTool(tool as never);

  // Order matters where two modules listen to the same event: the guard's
  // tool_call handler runs first, so a dangerous command is refused before any
  // bookkeeping looks at it.
  const session = registerSession(pi);
  registerGuard(pi);
  registerUsage(pi);
  registerContext(pi);
  registerCommands(pi, session);
}
