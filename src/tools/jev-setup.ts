/**
 * jev_setup — configure the provider chain.
 */

import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as fs from "node:fs";

import {
  configPath,
  getConfig,
  jevEntry,
  maskKey,
  ollamaEntry,
  removeProvider,
  saveConfig,
  upsertProvider,
  type ProviderEntry,
  type ProviderKind,
} from "../config.ts";
import { buildProvider } from "../providers/index.ts";

interface SetupParams {
  action: "add" | "remove" | "list" | "test";
  id?: string;
  kind?: ProviderKind;
  name?: string;
  url?: string;
  apiKey?: string;
  model?: string;
  description?: string;
  costPerMillionInput?: number;
  jsonMode?: boolean;
  manual?: boolean;
  position?: number;
}

async function describeChain(): Promise<string> {
  const config = getConfig();
  if (config.providers.length === 0) {
    return `No providers configured yet. Config file: ${configPath()}`;
  }

  const lines: string[] = ["Provider chain (tried in order):", ""];
  for (const [index, entry] of config.providers.entries()) {
    const provider = buildProvider(entry);
    const health = await provider.available();
    const status = entry.manual ? "manual" : health.ok ? "ready" : "unavailable";
    lines.push(
      `${index + 1}. ${entry.id.padEnd(12)} ${entry.kind.padEnd(14)} ${status.padEnd(12)} ${health.detail}`,
    );
    lines.push(`   ${entry.name ?? "(unnamed)"}${entry.model ? ` · model ${entry.model}` : ""}`);
    if (entry.kind === "jev") lines.push(`   key ${maskKey(entry.apiKey)}${entry.baseUrl ? ` · ${entry.baseUrl}` : ""}`);
    if (entry.description) lines.push(`   ${entry.description}`);
    lines.push("");
  }
  lines.push(`Config: ${configPath()}`);
  return lines.join("\n");
}

export const JevSetupTool = {
  name: "jev_setup",
  label: "Set up Jev",
  description:
    "Configure the pi-jev provider chain. Providers are tried in order, so a local model can sit behind a hosted one as a fallback. Run with action=list first to see the current chain.",
  promptSnippet: "Configure pi-jev providers (Jev API key, local Ollama fallback)",
  promptGuidelines: [
    "Use jev_setup only when the user asks to configure pi-jev, an API key or a provider; the other jev_* tools report their own configuration problems.",
  ],
  parameters: Type.Object({
    action: StringEnum(["add", "remove", "list", "test"] as const),
    id: Type.Optional(
      Type.String({ description: "Stable provider id, e.g. \"jev\" or \"local\". Required for add and remove." }),
    ),
    kind: Type.Optional(
      StringEnum(["jev", "ollama", "openai-compat"] as const, {
        description: "jev = TypeSafe. ollama = local OpenAI-compatible. openai-compat = any other compatible endpoint.",
      }),
    ),
    name: Type.Optional(Type.String({ description: "Display name for the chain listing" })),
    url: Type.Optional(Type.String({ description: "Base URL. Defaults: https://api.typesafe.ai/v1 or http://localhost:11434/v1" })),
    apiKey: Type.Optional(Type.String({ description: "API key. Stored 0600 in ~/.pi/jev-config.json." })),
    model: Type.Optional(Type.String({ description: "Model id, e.g. jev-latest, or a locally pulled Ollama model" })),
    description: Type.Optional(Type.String({ description: "What this provider is for, in one line" })),
    costPerMillionInput: Type.Optional(
      Type.Number({ description: "USD per million input tokens, for the cost column in the ledger" }),
    ),
    jsonMode: Type.Optional(Type.Boolean({ description: "Ask the endpoint for JSON output (OpenAI-compatible only)" })),
    manual: Type.Optional(
      Type.Boolean({ description: "Never chosen automatically; only when a tool passes provider= explicitly" }),
    ),
    position: Type.Optional(
      Type.Number({ description: "Where to insert a new provider in the chain (0-based). Default: append." }),
    ),
  }),
  async execute(_toolCallId: string, params: SetupParams) {
    if (params.action === "list" || params.action === "test") {
      return {
        content: [{ type: "text" as const, text: await describeChain() }],
        details: { providers: getConfig().providers.length },
      };
    }

    if (params.action === "remove") {
      if (!params.id) throw new Error("action=remove needs an id.");
      const removed = removeProvider(params.id);
      if (!removed) throw new Error(`No provider "${params.id}" to remove.`);
      return {
        content: [{ type: "text" as const, text: `Removed provider "${params.id}".\n\n${await describeChain()}` }],
        details: { removed: params.id },
      };
    }

    // add
    if (!params.id) throw new Error("action=add needs an id.");
    if (!params.kind) throw new Error("action=add needs a kind.");

    let entry: ProviderEntry;
    if (params.kind === "jev") {
      if (!params.apiKey) throw new Error("A jev provider needs an apiKey (starts with ol_api_ for Outline, not here — TypeSafe keys come from console.typesafe.ai).");
      entry = jevEntry(params.apiKey, params.id, params.model ?? "jev-latest");
    } else if (params.kind === "ollama") {
      // No default model: pi-jev must not assume anything about what is pulled
      // locally, and a guessed model name fails at call time rather than here.
      if (!params.model) {
        throw new Error(
          "An ollama provider needs a model. List what is pulled with `ollama list` and pass it, e.g. model=<name>.",
        );
      }
      entry = ollamaEntry(params.model, params.id);
    } else {
      if (!params.url) throw new Error("An openai-compat provider needs a url.");
      if (!params.model) throw new Error("An openai-compat provider needs a model.");
      entry = {
        id: params.id,
        kind: "openai-compat",
        name: params.name ?? params.id,
        baseUrl: params.url,
        model: params.model,
        costPerMillionInput: params.costPerMillionInput ?? 0,
        jsonMode: params.jsonMode ?? true,
      };
    }

    // Explicit arguments win over the template defaults.
    if (params.name) entry.name = params.name;
    if (params.url) entry.baseUrl = params.url;
    if (params.apiKey && params.kind !== "jev") entry.apiKey = params.apiKey;
    if (params.model) entry.model = params.model;
    if (params.description) entry.description = params.description;
    if (params.costPerMillionInput !== undefined) entry.costPerMillionInput = params.costPerMillionInput;
    if (params.jsonMode !== undefined) entry.jsonMode = params.jsonMode;
    if (params.manual !== undefined) entry.manual = params.manual;

    upsertProvider(entry, params.position);

    const health = await buildProvider(entry).available();
    const verdict = health.ok
      ? `Reachable: ${health.detail}`
      : `Not reachable yet: ${health.detail}\nThat is not fatal — it stays in the chain and gets skipped while it is down.`;

    return {
      content: [{ type: "text" as const, text: `${verdict}\n\n${await describeChain()}` }],
      details: { provider: entry.id, ok: health.ok },
    };
  },
};

/**
 * Create the config file on first run so it is discoverable.
 *
 * It is written with no providers rather than a guessed one: naming a local
 * model here would put a model id in the extension that the user never chose,
 * and it would fail at call time instead of at setup time. The notification
 * says where the file is and what to do with it.
 */
export function ensureConfigFile(): { created: boolean; path: string } {
  const file = configPath();
  if (fs.existsSync(file)) return { created: false, path: file };
  saveConfig(getConfig());
  return { created: true, path: file };
}

export { removeProvider };
