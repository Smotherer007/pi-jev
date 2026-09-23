/**
 * Less context on every turn: long bash output trimmed before it enters the
 * context, earlier outputs pruned before each LLM call.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getConfig } from "../config.ts";
import { trimOutput } from "../trim.ts";
import { pruneContext, type Msg } from "../prune.ts";
import { hasProvider } from "./shared.ts";

export function registerContext(pi: ExtensionAPI): void {
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
    if (!config.hook.trim || !hasProvider(config)) return;

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
    if (!config.hook.prune || !hasProvider(config)) return;
    const result = await pruneContext(event.messages as unknown as Msg[], ctx.cwd, ctx.signal);
    if (!result.messages) return;
    return { messages: result.messages as unknown as typeof event.messages };
  });

  pi.on("tool_result", async (event, ctx: ExtensionContext) => {
    if (event.toolName !== "bash") return;
    const content = await trimBash(event as never, ctx);
    return content ? { content: content as typeof event.content } : undefined;
  });
}
