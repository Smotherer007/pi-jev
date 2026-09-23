/** Small things every hook module needs. */

import type { JevConfig } from "../config.ts";

/**
 * The tools that need a provider to do anything. Without one they can only
 * fail, and a tool that can only fail still costs prompt surface and a wrong
 * turn when the model tries it — so they are hidden until a provider exists.
 * jev_gate stays: its rule layer works with no provider at all.
 */
export const PROVIDER_TOOLS = ["jev_decide", "jev_triage", "jev_verify"];

export function hasProvider(config: JevConfig): boolean {
  return config.providers.some((provider) => !provider.manual);
}

/** Show a report in the UI when there is one, on stdout otherwise. */
export function show(ctx: { hasUI: boolean; ui: { notify: (text: string, level: "info" | "error") => void } }, text: string, level: "info" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else process.stdout.write(`${text}\n`);
}
