/**
 * /jev-setup — configure the provider chain.
 *
 * A command rather than a tool: configuration is the user's job, and an API key
 * typed here never passes through the model's context or its transcript.
 */

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

export interface SetupParams {
  action: "add" | "remove" | "list";
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

export const SETUP_USAGE = [
  "Usage:",
  "  /jev-setup                                   show the provider chain",
  "  /jev-setup add jev [apiKey=…] [model=jev-latest]",
  "  /jev-setup add ollama model=<name from `ollama list`>",
  "  /jev-setup add openai-compat id=<id> url=<base url> model=<model> [apiKey=…]",
  "  /jev-setup remove <id>",
  "Optional for add: id=, name=, position=<0-based>, manual=true, cost=<USD per M input tokens>",
].join("\n");

const KINDS: readonly ProviderKind[] = ["jev", "ollama", "openai-compat"];

/** `add jev apiKey=abc model=x` → params. Values may be quoted. */
export function parseSetupArgs(args: string): SetupParams {
  const tokens = [...args.trim().matchAll(/(\S+?=)?(?:"([^"]*)"|'([^']*)'|(\S+))/g)].map((match) =>
    (match[1] ?? "") + (match[2] ?? match[3] ?? match[4] ?? ""),
  );
  const [action = "list", ...rest] = tokens;

  if (action === "list" || action === "test") return { action: "list" };
  if (action === "remove") {
    const id = rest[0];
    if (!id) throw new Error("remove needs a provider id.");
    return { action: "remove", id };
  }
  if (action !== "add") throw new Error(`Unknown action "${action}".`);

  const kind = rest[0] as ProviderKind | undefined;
  if (!kind || !KINDS.includes(kind)) throw new Error(`add needs a kind: ${KINDS.join(", ")}.`);

  const params: SetupParams = { action: "add", kind };
  for (const token of rest.slice(1)) {
    const eq = token.indexOf("=");
    if (eq <= 0) throw new Error(`Expected key=value, got "${token}".`);
    const key = token.slice(0, eq);
    const value = token.slice(eq + 1);
    switch (key) {
      case "id":
      case "name":
      case "url":
      case "apiKey":
      case "model":
      case "description":
        params[key] = value;
        break;
      case "position":
        params.position = Number(value);
        break;
      case "cost":
        params.costPerMillionInput = Number(value);
        break;
      case "manual":
      case "jsonMode":
        params[key] = value === "true";
        break;
      default:
        throw new Error(`Unknown option "${key}".`);
    }
  }
  params.id ??= kind === "ollama" ? "local" : kind;
  return params;
}

export async function describeChain(): Promise<string> {
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

/** Apply a setup request and describe the resulting chain. Throws on bad input. */
export async function setupProvider(params: SetupParams): Promise<string> {
  if (params.action === "list") {
    return await describeChain();
  }

  if (params.action === "remove") {
    if (!params.id) throw new Error("remove needs an id.");
    const removed = removeProvider(params.id);
    if (!removed) throw new Error(`No provider "${params.id}" to remove.`);
    return `Removed provider "${params.id}".\n\n${await describeChain()}`;
  }

  // add
  if (!params.id) throw new Error("add needs an id.");
  if (!params.kind) throw new Error("add needs a kind.");

  let entry: ProviderEntry;
  if (params.kind === "jev") {
    if (!params.apiKey) throw new Error("A jev provider needs an apiKey — TypeSafe keys come from console.typesafe.ai.");
    entry = jevEntry(params.apiKey, params.id, params.model ?? "jev-latest");
  } else if (params.kind === "ollama") {
    // No default model: pi-jev must not assume anything about what is pulled
    // locally, and a guessed model name fails at call time rather than here.
    if (!params.model) {
      throw new Error(
        "An ollama provider needs a model. List what is pulled with `ollama list` and pass it: /jev-setup add ollama model=<name>.",
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

  return `${verdict}\n\n${await describeChain()}`;
}

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

