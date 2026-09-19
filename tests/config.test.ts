import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  _resetConfigCache,
  configPath,
  defaultConfig,
  getConfig,
  jevEntry,
  loadConfig,
  maskKey,
  ollamaEntry,
  providerChain,
  removeProvider,
  saveConfig,
  upsertProvider,
} from "../src/config.ts";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-jev-config-"));
  process.env.HOME = home;
  _resetConfigCache();
});

afterEach(() => {
  _resetConfigCache();
  fs.rmSync(home, { recursive: true, force: true });
});

const CONFIG_DIR = () => path.join(home, ".pi");
const CONFIG_FILE = () => path.join(CONFIG_DIR(), "jev-config.json");

function writeConfig(value: unknown): void {
  fs.mkdirSync(CONFIG_DIR(), { recursive: true });
  fs.writeFileSync(CONFIG_FILE(), JSON.stringify(value, null, 2), "utf-8");
}

describe("defaults", () => {
  it("starts with no providers but sane limits", () => {
    const config = defaultConfig();
    assert.deepEqual(config.providers, []);
    assert.equal(config.limits.minConfidence, 0.5);
    assert.equal(config.gate.destructive, "block");
    assert.equal(config.gate.read_only, "allow");
    assert.equal(config.shadow.triage, false);
  });

  it("keeps a destructive action blocked by default rather than allow", () => {
    // Inverting this in a refactor would silently disarm the gate.
    assert.notEqual(defaultConfig().gate.destructive, "allow");
  });
});

describe("loadConfig", () => {
  it("returns defaults when no file exists", () => {
    assert.deepEqual(loadConfig().providers, []);
  });

  it("reads a file from disk", () => {
    writeConfig({ providers: [ollamaEntry("local-model", "local")] });
    const config = loadConfig();
    assert.equal(config.providers.length, 1);
    assert.equal(config.providers[0]?.id, "local");
  });

  it("fills in missing sections from defaults", () => {
    writeConfig({ providers: [jevEntry("key", "jev")] });
    const config = loadConfig();
    assert.equal(config.limits.maxKeep, 8);
    assert.equal(config.verify.supportedAt, 0.7);
    assert.equal(config.ledger.maxBytes, 8 * 1024 * 1024);
  });

  it("falls back to defaults for a corrupt file instead of throwing", () => {
    fs.mkdirSync(CONFIG_DIR(), { recursive: true });
    fs.writeFileSync(CONFIG_FILE(), "{ not json", "utf-8");
    assert.deepEqual(loadConfig().providers, []);
  });

  it("drops provider entries that are not usable", () => {
    writeConfig({ providers: [{ id: "ok", kind: "jev" }, { kind: "jev" }, { id: "bad", kind: "nope" }, null] });
    const config = loadConfig();
    assert.deepEqual(config.providers.map((entry) => entry.id), ["ok"]);
  });

  it("refuses to let a bad verdict value disarm the gate", () => {
    writeConfig({ gate: { destructive: "sure", read_only: 42, reversible: "confirm" } });
    const config = loadConfig();
    assert.equal(config.gate.destructive, "block");
    assert.equal(config.gate.read_only, "allow");
    assert.equal(config.gate.reversible, "confirm");
  });

  it("tightens file permissions to 0600 on load", () => {
    writeConfig({ providers: [] });
    fs.chmodSync(CONFIG_FILE(), 0o644);
    loadConfig();
    assert.equal(fs.statSync(CONFIG_FILE()).mode & 0o777, 0o600);
  });

  it("caches, so repeated reads do not hit the disk", () => {
    writeConfig({ providers: [ollamaEntry("local-model")] });
    loadConfig();
    fs.writeFileSync(CONFIG_FILE(), JSON.stringify({ providers: [] }), "utf-8");
    assert.equal(loadConfig().providers.length, 1, "second load should come from the cache");
    _resetConfigCache();
    assert.equal(loadConfig().providers.length, 0);
  });
});

describe("saveConfig", () => {
  it("writes a 0600 file in a 0700 directory", () => {
    saveConfig({ ...defaultConfig(), providers: [jevEntry("secret", "jev")] });
    assert.equal(fs.statSync(CONFIG_FILE()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(CONFIG_DIR()).mode & 0o777, 0o700);
  });

  it("round-trips through load", () => {
    saveConfig({ ...defaultConfig(), providers: [ollamaEntry("local-model", "local")] });
    _resetConfigCache();
    assert.equal(loadConfig().providers[0]?.model, "local-model");
  });

  it("leaves no temp file behind", () => {
    saveConfig(defaultConfig());
    const leftovers = fs.readdirSync(CONFIG_DIR()).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});

describe("upsertProvider", () => {
  it("appends a new provider to the end of the chain", () => {
    upsertProvider(ollamaEntry("local-model", "local"));
    const config = upsertProvider(jevEntry("k", "jev"));
    assert.deepEqual(config.providers.map((entry) => entry.id), ["local", "jev"]);
  });

  it("inserts at a position when asked", () => {
    upsertProvider(ollamaEntry("local-model", "local"));
    const config = upsertProvider(jevEntry("k", "jev"), 0);
    assert.deepEqual(config.providers.map((entry) => entry.id), ["jev", "local"]);
  });

  it("replaces in place rather than duplicating", () => {
    upsertProvider(ollamaEntry("old-model", "local"));
    const config = upsertProvider(ollamaEntry("new-model", "local"));
    assert.equal(config.providers.length, 1);
    assert.equal(config.providers[0]?.model, "new-model");
  });

  it("preserves order when replacing the first of two", () => {
    upsertProvider(ollamaEntry("first-model", "first"));
    upsertProvider(jevEntry("k", "second"));
    const config = upsertProvider(ollamaEntry("changed-model", "first"));
    assert.deepEqual(config.providers.map((entry) => entry.id), ["first", "second"]);
  });
});

describe("removeProvider", () => {
  it("removes by id and reports success", () => {
    upsertProvider(ollamaEntry("local-model", "local"));
    assert.equal(removeProvider("local"), true);
    assert.equal(getConfig().providers.length, 0);
  });

  it("reports failure for an unknown id", () => {
    assert.equal(removeProvider("nope"), false);
  });
});

describe("providerChain", () => {
  it("returns the configured order", () => {
    upsertProvider(jevEntry("k", "jev"));
    upsertProvider(ollamaEntry("local-model", "local"));
    assert.deepEqual(providerChain(getConfig()).map((entry) => entry.id), ["jev", "local"]);
  });

  it("skips manual entries so they are never chosen by accident", () => {
    upsertProvider(jevEntry("k", "jev"));
    upsertProvider({ ...ollamaEntry("local-model", "local"), manual: true });
    assert.deepEqual(providerChain(getConfig()).map((entry) => entry.id), ["jev"]);
  });

  it("returns a manual entry when it is asked for by id", () => {
    upsertProvider({ ...ollamaEntry("local-model", "local"), manual: true });
    assert.deepEqual(providerChain(getConfig(), "local").map((entry) => entry.id), ["local"]);
  });

  it("explains the failure when an unknown id is requested", () => {
    upsertProvider(jevEntry("k", "jev"));
    assert.throws(() => providerChain(getConfig(), "ghost"), /Configured: jev/);
  });
});

describe("maskKey", () => {
  it("hides the middle of a key", () => {
    const masked = maskKey("ol_api_tNKaLA0XNoMxJTa2xnQs2NPmieJ9MVLbcHUpOS");
    assert.ok(masked.startsWith("ol_api_tNK"));
    assert.ok(masked.endsWith("UpOS".slice(-4)));
    assert.ok(!masked.includes("LA0XNoMxJTa2xnQs2NPmieJ9MVLbcH"));
  });

  it("reports a missing key instead of printing undefined", () => {
    assert.equal(maskKey(undefined), "(none)");
  });

  it("does not leak a short key", () => {
    assert.equal(maskKey("abc"), "abc…");
  });
});

describe("path handling", () => {
  it("places the config under the home directory", () => {
    assert.equal(configPath(), CONFIG_FILE());
  });
});
