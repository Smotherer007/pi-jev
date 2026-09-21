/**
 * Configuration and persistence.
 *
 * The file holds API keys, so it is written atomically to a private temp file
 * and renamed into place, and it is chmod 0600 on every load.
 *
 * Provider entries form an *ordered chain*. That ordering is the whole point:
 * a sensitive state and a public one can be answered by different providers,
 * and if the first one is down or unconfigured the next one answers instead.
 * Nothing above this module knows which provider ran.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GateVerdict, RiskClass } from "./types.ts";
import { RISK_CLASSES } from "./types.ts";

export type ProviderKind = "jev" | "ollama" | "openai-compat";

export interface ProviderEntry {
  /** Stable id used in the ledger and by `provider` overrides. */
  id: string;
  kind: ProviderKind;
  /** Workspace/label, for the TUI and `jev_status`. */
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Ask the endpoint for JSON output. Ignored by the jev provider. */
  jsonMode?: boolean;
  costPerMillionInput?: number;
  description?: string;
  /**
   * When true this provider is never chosen automatically, only by an explicit
   * `provider` argument. Use it to park a provider without deleting it.
   */
  manual?: boolean;
}

export interface JevConfig {
  providers: ProviderEntry[];
  limits: {
    /** Upper bound for the state we hand to a provider. */
    maxStateChars: number;
    /** Default cap on survivors for `jev_triage`. */
    maxKeep: number;
    /** Default lower bound on probability for acting on an answer. */
    minConfidence: number;
    /**
     * Deadline for the gate's model call, in milliseconds. Deliberately short:
     * the gate sits on the critical path of every consequential action, so a
     * slow provider must not turn a guardrail into a stall. A local model on
     * consumer hardware can take tens of seconds to answer, which is fine for
     * triage and wrong here — on timeout the verdict falls back to "confirm".
     */
    gateTimeoutMs: number;
  };
  verify: {
    /** At or above this, a claim counts as supported. */
    supportedAt: number;
    /** At or below this, a claim counts as refuted. */
    refutedAt: number;
  };
  gate: Record<RiskClass, GateVerdict>;
  /**
   * The deterministic rules, enforced rather than offered.
   *
   * `jev_gate` is advice: it fires only when the model chooses to ask, and a
   * model that has already decided to run a command is not the party you want
   * asking on its own behalf. The rules in `guard.ts` need no provider, no key
   * and no network, so there is nothing to weigh against applying them to every
   * shell command before it runs.
   */
  hook: {
    /**
     * Apply `hardGuard` to every `bash` call and act on its verdict before the
     * command runs. Turn it off to go back to the gate being a tool the model
     * may or may not call.
     */
    bash: boolean;
  };
  shadow: {
    triage: boolean;
    verify: boolean;
    gate: boolean;
  };
  ledger: {
    /** Rotate once the file grows past this. */
    maxBytes: number;
    /** Entries kept when rotating. */
    keepEntries: number;
  };
}

/** Modelled on TypeSafe's published price. Output tokens are free. */
export const JEV_COST_PER_MILLION_INPUT = 0.042;

export function configPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".pi", "jev-config.json");
}

export function defaultConfig(): JevConfig {
  return {
    providers: [],
    limits: {
      maxStateChars: 60_000,
      maxKeep: 8,
      minConfidence: 0.5,
      gateTimeoutMs: 2_500,
    },
    verify: {
      supportedAt: 0.7,
      refutedAt: 0.3,
    },
    gate: {
      read_only: "allow",
      reversible: "confirm",
      destructive: "block",
      needs_human: "confirm",
    },
    hook: {
      bash: true,
    },
    shadow: {
      triage: false,
      verify: false,
      gate: false,
    },
    ledger: {
      maxBytes: 8 * 1024 * 1024,
      keepEntries: 5_000,
    },
  };
}

/** A ready-to-use provider entry for a local Ollama install. */
export function ollamaEntry(model: string, id = "local"): ProviderEntry {
  return {
    id,
    kind: "ollama",
    name: `Ollama (${model})`,
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    model,
    jsonMode: true,
    costPerMillionInput: 0,
    description: "Local inference. Use for state that must not leave the machine.",
  };
}

export function jevEntry(apiKey: string, id = "jev", model = "jev-latest"): ProviderEntry {
  return {
    id,
    kind: "jev",
    name: "TypeSafe Jev",
    baseUrl: "https://api.typesafe.ai/v1",
    apiKey,
    model,
    costPerMillionInput: JEV_COST_PER_MILLION_INPUT,
    description: "Calibrated typed decisions. Cheapest and fastest option when reachable.",
  };
}

/* ------------------------------------------------------------- persistence */

let cached: JevConfig | null = null;

function mergeConfig(raw: unknown): JevConfig {
  const base = defaultConfig();
  if (!raw || typeof raw !== "object") return base;
  const input = raw as Partial<JevConfig>;

  return {
    providers: Array.isArray(input.providers) ? input.providers.filter(isProviderEntry) : base.providers,
    limits: { ...base.limits, ...(input.limits ?? {}) },
    verify: { ...base.verify, ...(input.verify ?? {}) },
    gate: normaliseGate(input.gate, base.gate),
    hook: normaliseHook(input.hook, base.hook),
    shadow: { ...base.shadow, ...(input.shadow ?? {}) },
    ledger: { ...base.ledger, ...(input.ledger ?? {}) },
  };
}

function isProviderEntry(value: unknown): value is ProviderEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as ProviderEntry;
  return (
    typeof entry.id === "string" &&
    entry.id.length > 0 &&
    (entry.kind === "jev" || entry.kind === "ollama" || entry.kind === "openai-compat")
  );
}

/** Drop unknown risk classes and bad verdicts, so a typo cannot disarm a gate. */
function normaliseGate(input: unknown, fallback: Record<RiskClass, GateVerdict>): Record<RiskClass, GateVerdict> {
  const out = { ...fallback };
  if (!input || typeof input !== "object") return out;
  const raw = input as Record<string, unknown>;
  for (const risk of RISK_CLASSES) {
    const value = raw[risk];
    if (value === "allow" || value === "confirm" || value === "block") out[risk] = value;
  }
  return out;
}

/**
 * Only a real boolean counts, so `"false"` cannot quietly leave the hook on and
 * an unexpected value cannot quietly turn it off.
 */
function normaliseHook(input: unknown, fallback: { bash: boolean }): { bash: boolean } {
  if (!input || typeof input !== "object") return { ...fallback };
  const raw = input as Record<string, unknown>;
  return { bash: typeof raw.bash === "boolean" ? raw.bash : fallback.bash };
}

export function loadConfig(): JevConfig {
  if (cached) return cached;
  const file = configPath();

  if (!fs.existsSync(file)) {
    cached = defaultConfig();
    return cached;
  }

  try {
    // A config written by hand or by an older version may be world-readable.
    const mode = fs.statSync(file).mode & 0o777;
    if (mode !== 0o600) fs.chmodSync(file, 0o600);
  } catch {
    /* not fatal */
  }

  try {
    cached = mergeConfig(JSON.parse(fs.readFileSync(file, "utf-8")));
  } catch {
    // A corrupt config must not take the extension down; fall back to defaults
    // and let `jev_status` report it.
    cached = defaultConfig();
  }
  return cached;
}

export function getConfig(): JevConfig {
  return cached ?? loadConfig();
}

export function saveConfig(config: JevConfig): void {
  const file = configPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw error;
  }
  cached = config;
}

/** Add or replace a provider entry, preserving chain order for new entries. */
export function upsertProvider(entry: ProviderEntry, position?: number): JevConfig {
  const config = structuredClone(getConfig());
  const index = config.providers.findIndex((p) => p.id === entry.id);
  if (index >= 0) {
    config.providers[index] = entry;
  } else if (position !== undefined && position >= 0 && position <= config.providers.length) {
    config.providers.splice(position, 0, entry);
  } else {
    config.providers.push(entry);
  }
  saveConfig(config);
  return config;
}

export function removeProvider(id: string): boolean {
  const config = structuredClone(getConfig());
  const before = config.providers.length;
  config.providers = config.providers.filter((p) => p.id !== id);
  if (config.providers.length === before) return false;
  saveConfig(config);
  return true;
}

/**
 * The provider chain to try, in order: reachable entries first, then any
 * explicit `manual` entries when the caller asked for one by id.
 */
export function providerChain(config: JevConfig, explicitId?: string): ProviderEntry[] {
  if (explicitId) {
    const match = config.providers.find((p) => p.id === explicitId);
    if (match) return [match];
    throw new Error(
      `No provider "${explicitId}". Configured: ${config.providers.map((p) => p.id).join(", ") || "none"}`,
    );
  }
  return config.providers.filter((p) => !p.manual);
}

/** Mask a key for display. */
export function maskKey(key: string | undefined): string {
  if (!key) return "(none)";
  if (key.length <= 10) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}

/** Reset the module-level cache. Test only. */
export function _resetConfigCache(): void {
  cached = null;
}
