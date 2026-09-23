/**
 * Trimming long command output before it enters the context.
 *
 * A failing test run or a build prints two thousand lines, and the agent needs
 * thirty of them: the failure, its stack trace, the summary. Everything that
 * enters the context is re-sent on every later turn, so the other 1970 lines
 * are paid for again and again.
 *
 * Three layers, cheapest first:
 *
 *   1. Head and tail are always kept. Commands put their summary at the end and
 *      what they are doing at the start.
 *   2. A block that contains a line saying error, fail, warn, panic, traceback…
 *      is kept by regex, with no model call.
 *   3. The decision model judges what is left, one yes/no per block, all blocks
 *      of an output in one or a few parallel calls.
 *
 * The full output is written to a file and the agent is told where, so a wrong
 * drop costs one read rather than a wrong conclusion — and that read is exactly
 * what the ledger records as a miss.
 *
 * On any failure the output is returned untouched. Unlike the gate, failing
 * open is the safe direction here: the cost of not trimming is tokens, the cost
 * of trimming wrongly is information.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { getConfig } from "./config.ts";
import { newId } from "./ledger.ts";
import { decide } from "./providers/index.ts";
import { mapConcurrent } from "./concurrency.ts";
import type { QuestionSpec } from "./types.ts";

/** Lines that are kept without asking. Deliberately broad: a false keep costs a few tokens. */
const SIGNAL =
  /\b(error|errors|fail(ed|ure|ing|s)?|fatal|panic|exception|traceback|warn(ing)?|assert(ion)?|expected|received|denied|refused|not found|undefined|cannot|unable|segfault|abort(ed)?|timeout|timed out|exit code|exited with)\b|✗|✘|×|FAIL|ERR!|^\s+at\s|^\s*File ".*", line \d+/i;

const BLOCKS_PER_CALL = 10;

export interface Block {
  /** 0-based index of the first line. */
  start: number;
  lines: string[];
}

export interface TrimPlan {
  /** Blocks the model has to judge. */
  ask: Block[];
  /** Lines kept regardless: head, tail and signal blocks, as [start, end) ranges. */
  alwaysKeep: Array<[number, number]>;
  total: number;
}

/** Split an output into head, tail, signal blocks and blocks to ask about. */
export function planTrim(lines: readonly string[], blockLines: number, keepHead: number, keepTail: number): TrimPlan {
  const total = lines.length;
  const headEnd = Math.min(keepHead, total);
  const tailStart = Math.max(headEnd, total - keepTail);
  const alwaysKeep: Array<[number, number]> = [];
  if (headEnd > 0) alwaysKeep.push([0, headEnd]);

  const ask: Block[] = [];
  for (let start = headEnd; start < tailStart; start += blockLines) {
    const end = Math.min(start + blockLines, tailStart);
    const block = lines.slice(start, end);
    if (block.some((line) => SIGNAL.test(line))) alwaysKeep.push([start, end]);
    else if (block.some((line) => line.trim().length > 0)) ask.push({ start, lines: block });
  }

  if (tailStart < total) alwaysKeep.push([tailStart, total]);
  return { ask, alwaysKeep, total };
}

export function blockQuestion(index: number, block: Block, command: string): QuestionSpec {
  return {
    id: `b${index}`,
    type: "noul",
    instructions:
      `Block B${index} (lines ${block.start + 1}–${block.start + block.lines.length}) is part of the output of \`${command.slice(0, 200)}\`. ` +
      "Does it contain anything someone needs to understand what the command did or why it failed — a result, a failure, " +
      "a warning, a value, a path, a summary? Answer false only when the block is clearly routine noise: progress output, " +
      "download bars, lists of passing tests, repeated compile steps. When unsure, answer true: a dropped block that " +
      "mattered costs far more than a kept block that did not.",
  };
}

function renderBlocks(blocks: readonly Block[], offset: number, maxChars: number): string {
  const parts = blocks.map((block, index) => `### B${offset + index}\n${block.lines.join("\n")}`);
  let text = parts.join("\n\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n…`;
  return text;
}

/** Merge ranges and render the kept lines with markers where lines were left out. */
export function renderKept(lines: readonly string[], ranges: Array<[number, number]>, note: (omitted: number) => string): string {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }

  const out: string[] = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) out.push(note(start - cursor));
    out.push(...lines.slice(start, end));
    cursor = end;
  }
  if (cursor < lines.length) out.push(note(lines.length - cursor));
  return out.join("\n");
}

function outputDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, ".pi", "jev-outputs");
}

const KEEP_FILES = 50;

/** Save the full output; returns the path, or null when it could not be written. */
function saveFull(text: string): string | null {
  try {
    const dir = outputDir();
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${newId("out")}.log`);
    fs.writeFileSync(file, text, { encoding: "utf-8", mode: 0o600 });
    // Bounded, oldest first. These are a safety net for the current session,
    // not an archive.
    const files = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .map((name) => ({ name, at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => a.at - b.at);
    for (const old of files.slice(0, Math.max(0, files.length - KEEP_FILES))) {
      fs.rmSync(path.join(dir, old.name), { force: true });
    }
    return file;
  } catch {
    return null;
  }
}

/* ------------------------------------------ which full outputs were re-read */

const savedOutputs = new Map<string, string>();

/** Did the agent just open a full output a trim had cut down? Returns the decision id. */
export function trimMissFor(candidate: string, cwd: string): string | null {
  const resolved = path.resolve(cwd, candidate);
  return savedOutputs.get(resolved) ?? null;
}

/** Test only. */
export function _resetTrimMemory(): void {
  savedOutputs.clear();
}

export interface TrimResult {
  /** The text to put in the context instead; absent when nothing changes. */
  text?: string;
  decisionIds: string[];
  keptLines: number;
  droppedLines: number;
  shadow: boolean;
}

/**
 * Trim one output. Never throws: on any failure the result carries no text and
 * the caller leaves the output as it was.
 */
export async function trimOutput(
  text: string,
  command: string,
  options: { fullOutputPath?: string; signal?: AbortSignal } = {},
): Promise<TrimResult> {
  const config = getConfig();
  const shadow = config.shadow.trim;
  const none: TrimResult = { decisionIds: [], keptLines: 0, droppedLines: 0, shadow };

  const lines = text.split("\n");
  if (lines.length < config.trim.minLines) return none;

  const plan = planTrim(lines, Math.max(1, config.trim.blockLines), config.trim.keepHead, config.trim.keepTail);
  const kept: Array<[number, number]> = [...plan.alwaysKeep];
  const decisionIds: string[] = [];

  if (plan.ask.length > 0) {
    const offsets: number[] = [];
    for (let offset = 0; offset < plan.ask.length; offset += BLOCKS_PER_CALL) offsets.push(offset);

    const results = await mapConcurrent(offsets, Math.max(1, config.limits.concurrency), async (offset) => {
      const chunk = plan.ask.slice(offset, offset + BLOCKS_PER_CALL);
      try {
        const outcome = await decide({
          tool: "jev_trim",
          purpose: `trim: ${command.slice(0, 120)}`,
          state: `## COMMAND\n${command}\n\n## OUTPUT BLOCKS\n${renderBlocks(chunk, offset, config.limits.maxStateChars)}`,
          questions: chunk.map((block, index) => blockQuestion(offset + index, block, command)),
          shadow,
          itemCount: chunk.length,
          timeoutMs: config.trim.timeoutMs,
          ...(options.signal ? { signal: options.signal } : {}),
          annotate: (answers) => {
            const keptKeys: string[] = [];
            const droppedKeys: string[] = [];
            for (const [index, block] of chunk.entries()) {
              const key = `lines ${block.start + 1}-${block.start + block.lines.length}`;
              if ((answers[`b${offset + index}`]?.p ?? 1) >= config.trim.minConfidence) keptKeys.push(key);
              else droppedKeys.push(key);
            }
            return { kept: keptKeys, dropped: droppedKeys };
          },
        });
        return { ok: true as const, offset, chunk, outcome };
      } catch {
        return { ok: false as const, offset, chunk };
      }
    });

    for (const result of results) {
      if (!result.ok) {
        // A batch that could not be judged is kept whole.
        for (const block of result.chunk) kept.push([block.start, block.start + block.lines.length]);
        continue;
      }
      decisionIds.push(result.outcome.decisionId);
      for (const [index, block] of result.chunk.entries()) {
        // A missing answer counts as "keep": no answer is not a verdict.
        const p = result.outcome.answers[`b${result.offset + index}`]?.p ?? 1;
        if (p >= config.trim.minConfidence) kept.push([block.start, block.start + block.lines.length]);
      }
    }
  }

  const keptLines = new Set<number>();
  for (const [start, end] of kept) for (let line = start; line < end; line += 1) keptLines.add(line);
  const droppedLines = lines.length - keptLines.size;

  if (decisionIds.length === 0 || droppedLines === 0) {
    return { decisionIds, keptLines: keptLines.size, droppedLines: 0, shadow };
  }
  if (shadow) return { decisionIds, keptLines: keptLines.size, droppedLines, shadow };

  const fullPath = options.fullOutputPath ?? saveFull(text);
  if (fullPath) savedOutputs.set(path.resolve(fullPath), decisionIds[0] ?? "unknown");

  const trimmed = renderKept(lines, kept, (omitted) => `[… ${omitted} line${omitted === 1 ? "" : "s"} omitted by pi-jev]`);
  const footer =
    `\n[pi-jev: kept ${keptLines.size} of ${lines.length} lines (decision ${decisionIds.join(", ")}). ` +
    (fullPath ? `Full output: ${fullPath} — read it if something you need is missing.]` : "The full output could not be saved.]");

  return { text: trimmed + footer, decisionIds, keptLines: keptLines.size, droppedLines, shadow };
}
