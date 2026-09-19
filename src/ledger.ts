/**
 * The ledger.
 *
 * Append-only JSONL under `~/.pi/jev-ledger.jsonl`. Three entry kinds share
 * the file: decisions, labels (ground truth attached after the fact), and
 * shadow misses (pi touched something Jev had dropped).
 *
 * Why it exists at all: every claim about a decision model is unverifiable
 * unless the decisions and their outcomes are recorded next to each other.
 * The ledger is the only part of pi-jev that can say whether any of it works.
 *
 * Writing never fails the caller. A decision that was made but not logged is
 * a gap in the record; a decision that was not made because logging failed is
 * a broken tool.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getConfig } from "./config.ts";
import type { LedgerDecision, LedgerEntry, LedgerLabel, LedgerShadowMiss } from "./types.ts";

let warnedOnce = false;

export function ledgerPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".pi", "jev-ledger.jsonl");
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

/** Short, stable hash of a state. Lets repeated states be recognised. */
export function hashState(state: unknown): string {
  const text = typeof state === "string" ? state : JSON.stringify(state) ?? "";
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function estimateTokens(text: string): number {
  // Good enough for the ledger; cost only needs the right order of magnitude.
  return Math.ceil(text.length / 4);
}

export function costOf(inputTokens: number, costPerMillionInput: number): number {
  return (inputTokens / 1_000_000) * costPerMillionInput;
}

/* ------------------------------------------------------------------ append */

function append(entry: LedgerEntry): void {
  try {
    const file = ledgerPath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    // A crash mid-write leaves a line with no trailing newline. Appending
    // straight onto it would fuse the corrupt line and this entry into one,
    // so the new entry would be lost along with the bad one. Starting on a
    // fresh line keeps the damage to the single line that caused it.
    let prefix = "";
    try {
      const size = fs.statSync(file).size;
      if (size > 0) {
        const tail = Buffer.alloc(1);
        const fd = fs.openSync(file, "r");
        try {
          fs.readSync(fd, tail, 0, 1, size - 1);
        } finally {
          fs.closeSync(fd);
        }
        if (tail[0] !== 0x0a) prefix = "\n";
      }
    } catch {
      /* a missing or unreadable file needs no prefix */
    }

    fs.appendFileSync(file, `${prefix}${JSON.stringify(entry)}\n`, "utf-8");
    rotateIfNeeded(file);
  } catch (error) {
    if (!warnedOnce) {
      warnedOnce = true;
      process.stderr.write(
        `pi-jev: could not write the ledger (${(error as Error).message}). Decisions still work; calibration data will be incomplete.\n`,
      );
    }
  }
}

/**
 * Keep the file bounded by rewriting it with the most recent entries. Rotation
 * is checked after every append but only triggers past `maxBytes`, so the
 * rewrite cost is amortised over megabytes of writes.
 */
function rotateIfNeeded(file: string): void {
  const config = getConfig();
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  if (size <= config.ledger.maxBytes) return;

  try {
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
    const kept = lines.slice(-config.ledger.keepEntries);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, kept.length > 0 ? `${kept.join("\n")}\n` : "", "utf-8");
    fs.renameSync(tmp, file);
  } catch {
    /* leave the file as it is rather than lose data */
  }
}

export function recordDecision(decision: LedgerDecision): void {
  append(decision);
}

export function recordLabel(decisionId: string, questionId: string, correct: boolean, note?: string): LedgerLabel {
  const entry: LedgerLabel = {
    kind: "label",
    id: newId("lbl"),
    ts: new Date().toISOString(),
    decisionId,
    questionId,
    correct,
  };
  if (note) entry.note = note;
  append(entry);
  return entry;
}

export function recordShadowMiss(decisionId: string, item: string, via: string): LedgerShadowMiss {
  const entry: LedgerShadowMiss = {
    kind: "shadow-miss",
    id: newId("shm"),
    ts: new Date().toISOString(),
    decisionId,
    item,
    via,
  };
  append(entry);
  return entry;
}

/* ------------------------------------------------------------------- read */

export function readLedger(limit?: number): LedgerEntry[] {
  const file = ledgerPath();
  if (!fs.existsSync(file)) return [];

  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return [];
  }

  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const slice = limit !== undefined && lines.length > limit ? lines.slice(-limit) : lines;

  const entries: LedgerEntry[] = [];
  for (const line of lines.length !== slice.length ? slice : lines) {
    try {
      const parsed = JSON.parse(line) as LedgerEntry;
      if (parsed && typeof parsed === "object" && "kind" in parsed) entries.push(parsed);
    } catch {
      // A truncated final line (crash mid-write) or a hand-edit. Skip it.
    }
  }
  return entries;
}

export function clearLedger(): void {
  try {
    fs.rmSync(ledgerPath(), { force: true });
  } catch {
    /* ignore */
  }
}

/* --------------------------------------------------- shadow miss detection */

/**
 * Recent triage decisions, so a later `read` can be matched against what Jev
 * dropped. In-memory only: this is a within-session signal, and a stale entry
 * from last week would misattribute an unrelated read.
 */
const recentDrops = new Map<string, { dropped: Set<string>; tool: string; at: number }>();

const DROP_TTL_MS = 30 * 60 * 1000;

export function rememberDrops(decisionId: string, dropped: string[], tool: string): void {
  if (dropped.length === 0) return;
  recentDrops.set(decisionId, { dropped: new Set(dropped), tool, at: Date.now() });
  for (const [id, entry] of recentDrops) {
    if (Date.now() - entry.at > DROP_TTL_MS) recentDrops.delete(id);
  }
}

/**
 * Did a recently-dropped item just get touched? Matching is path-based and
 * deliberately loose: an absolute path, a relative path or a bare basename all
 * count, because the tool that touches the file may use any of them.
 */
export function findShadowMiss(candidate: string): { decisionId: string; item: string } | null {
  const normalised = candidate.replace(/\\/g, "/");
  for (const [decisionId, entry] of recentDrops) {
    if (Date.now() - entry.at > DROP_TTL_MS) {
      recentDrops.delete(decisionId);
      continue;
    }
    for (const item of entry.dropped) {
      const itemNorm = item.replace(/\\/g, "/");
      if (
        normalised === itemNorm ||
        normalised.endsWith(`/${itemNorm}`) ||
        itemNorm.endsWith(`/${normalised}`) ||
        path.basename(normalised) === path.basename(itemNorm)
      ) {
        return { decisionId, item };
      }
    }
  }
  return null;
}

/** Test only. */
export function _resetDropMemory(): void {
  recentDrops.clear();
}
