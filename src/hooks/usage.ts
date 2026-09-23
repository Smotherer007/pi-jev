/**
 * Is the decision layer actually used, and did it withhold anything that
 * mattered? Shadow misses for triage, trim and prune; missed triages and
 * verifies; and the triage hint on large search results.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getConfig } from "../config.ts";
import { findShadowMiss, recordOpportunity, recordShadowMiss } from "../ledger.ts";
import { trimMissFor } from "../trim.ts";
import { forgetPruneMiss, pruneMissFor } from "../prune.ts";
import { TUNING } from "../tuning.ts";
import { hasProvider } from "./shared.ts";

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

export function registerUsage(pi: ExtensionAPI): void {
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
    if (hasProvider(config)) {
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
  pi.on("tool_result", async (event) => {
    // Not ls: a directory listing is orientation, and a hint on every large one
    // would be noise the model learns to ignore — hints included.
    if (event.toolName !== "grep" && event.toolName !== "find") return;
    if (event.isError) return;

    const config = getConfig();
    const threshold = TUNING.triageHintAt;
    if (!config.hook.triageHint || !hasProvider(config)) return;

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

}
