/**
 * Session wiring: which tools are active, the first-run config file, the
 * provider warm-up, and the system-prompt section.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getConfig } from "../config.ts";
import { warmUp } from "../providers/index.ts";
import { ensureConfigFile } from "../commands/setup.ts";
import { hasProvider, PROVIDER_TOOLS } from "./shared.ts";

let warmupEnabled = true;

/** Test only: keep session_start from opening network connections. */
export function _disableWarmup(): void {
  warmupEnabled = false;
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

/** Every jev_* tool name, for when pi cannot say which are active. */
const ALL_TOOLS = ["jev_decide", "jev_triage", "jev_verify", "jev_gate"];

/**
 * Registers the session handlers and returns `syncActiveTools`, which the
 * setup command calls after the provider chain changes.
 */
export function registerSession(pi: ExtensionAPI): { syncActiveTools: () => void } {
  /**
   * Show or hide the tools that need a provider, to match the configuration.
   * Runs at session start and again after /jev-setup, so adding a provider makes
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
        `pi-jev: no provider configured yet. Run /jev-setup add jev (TypeSafe) or /jev-setup add ollama model=<name> (local), or edit ${fresh.path}. The local guard rules work either way.`,
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
    if (!config.hook.prompt || !hasProvider(config)) return;

    let active: string[];
    try {
      active = pi.getActiveTools();
    } catch {
      active = [...ALL_TOOLS];
    }
    if (!active.some((name) => name.startsWith("jev_"))) return;

    const shortening =
      (config.hook.trim && !config.shadow.trim) || (config.hook.prune && !config.shadow.prune);
    return { systemPrompt: `${event.systemPrompt}\n\n${promptSection(active, { shortening })}` };
  });

  return { syncActiveTools };
}
