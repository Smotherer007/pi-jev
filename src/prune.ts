/**
 * Pruning earlier tool outputs that no longer matter.
 *
 * Every LLM call re-sends the whole conversation. A file read on turn 3 that the
 * task has since moved past is paid for again on turns 4, 5, 6 … until
 * compaction. This asks the decision model, before an LLM call, which of the
 * larger earlier outputs are still needed for the current task, and replaces
 * the rest with a one-line stub that says what was there and how to get it back.
 *
 * What keeps it cheap and fast:
 *
 *   - Nothing happens until the context is actually large (`minContextTokens`).
 *   - Outputs from the most recent turns are never candidates.
 *   - Every verdict is sticky for the current task: an output is judged once,
 *     not before every call. That also keeps the message prefix stable after the
 *     first prune, which is what a provider's prompt cache needs.
 *   - All candidates go in one or a few parallel calls, under a short deadline.
 *     On failure nothing is pruned: the cost of not pruning is tokens.
 *
 * What it measures: an elided `read` that the agent reads again is recorded as a
 * miss, in live and in shadow mode alike.
 */

import * as path from "node:path";

import { getConfig } from "./config.ts";
import { hashState } from "./ledger.ts";
import { decide } from "./providers/index.ts";
import { mapConcurrent } from "./concurrency.ts";
import type { QuestionSpec } from "./types.ts";

/** The parts of pi's message shapes this module reads. */
interface TextPart {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface Msg {
  role: string;
  content?: string | TextPart[];
  toolCallId?: string;
  toolName?: string;
  [key: string]: unknown;
}

const PER_CALL = 8;
const STUB_MARK = "[pi-jev: output of ";

function textOf(content: Msg["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

/** Rough token count of the whole conversation; the same /4 rule the ledger uses. */
export function estimateContextTokens(messages: readonly Msg[]): number {
  let chars = 0;
  for (const message of messages) chars += textOf(message.content).length;
  return Math.ceil(chars / 4);
}

function describeCall(name: string, args: Record<string, unknown> | undefined): string {
  const value = args?.path ?? args?.file_path ?? args?.command ?? args?.pattern ?? args?.url;
  const detail = typeof value === "string" ? value : "";
  return detail ? `${name} ${detail.length > 120 ? `${detail.slice(0, 117)}…` : detail}` : name;
}

export interface Candidate {
  index: number;
  toolCallId: string;
  label: string;
  toolName: string;
  path?: string;
  text: string;
}

/**
 * The outputs worth asking about: tool results older than the last
 * `keepRecentTurns` assistant turns, at least `minChars` long, not already stubbed.
 */
export function findCandidates(messages: readonly Msg[], keepRecentTurns: number, minChars: number): Candidate[] {
  // The boundary: the index of the Nth assistant message from the end.
  let seen = 0;
  let boundary = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      seen += 1;
      boundary = index;
      if (seen >= keepRecentTurns) break;
    }
  }
  if (seen < keepRecentTurns) return [];

  // Tool calls by id, so a result can say what produced it.
  const calls = new Map<string, { name: string; args?: Record<string, unknown> }>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "toolCall" && typeof part.id === "string") {
        calls.set(part.id, { name: String(part.name ?? "tool"), ...(part.arguments ? { args: part.arguments } : {}) });
      }
    }
  }

  const out: Candidate[] = [];
  for (let index = 0; index < boundary; index += 1) {
    const message = messages[index];
    if (!message || message.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
    const text = textOf(message.content);
    if (text.length < minChars || text.startsWith(STUB_MARK)) continue;
    // Images are not text we can judge or stub faithfully.
    if (Array.isArray(message.content) && message.content.some((part) => part.type === "image")) continue;

    const call = calls.get(message.toolCallId);
    const toolName = call?.name ?? message.toolName ?? "tool";
    const readPath = call?.args?.path ?? call?.args?.file_path;
    out.push({
      index,
      toolCallId: message.toolCallId,
      label: describeCall(toolName, call?.args),
      toolName,
      ...(toolName === "read" && typeof readPath === "string" ? { path: readPath } : {}),
      text,
    });
  }
  return out;
}

/** The current task: the latest user message, and what the agent last said. */
export function currentTask(messages: readonly Msg[]): { task: string; progress: string } {
  let task = "";
  let progress = "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (!progress && message.role === "assistant") progress = textOf(message.content);
    if (message.role === "user") {
      task = textOf(message.content);
      break;
    }
  }
  return { task: task.slice(0, 3_000), progress: progress.slice(-2_000) };
}

function excerpt(text: string): string {
  if (text.length <= 1_800) return text;
  return `${text.slice(0, 1_500)}\n…\n${text.slice(-300)}`;
}

export function pruneQuestion(id: number, candidate: Candidate): QuestionSpec {
  return {
    id: `o${id}`,
    type: "noul",
    instructions:
      `Is earlier output O${id} (${candidate.label}) still needed to finish the current task? ` +
      "It is needed when the next steps will rely on something in it that the latest progress does not already restate. " +
      "Answer false only when the task has clearly moved past it — a file that was looked at and ruled out, a search " +
      "that was superseded, a run whose result was already acted on. When unsure, answer true: dropping an output " +
      "that mattered costs a repeated tool call and possibly a wrong step.",
  };
}

/* ------------------------------------------------------------ sticky state */

interface Verdict {
  elide: boolean;
  decisionId: string;
  chars: number;
  label: string;
}

const verdicts = new Map<string, Verdict>();
/** Resolved path of an elided read → the decision that elided it. */
const elidedReads = new Map<string, string>();
const VERDICT_CAP = 2_000;

function verdictKey(toolCallId: string, taskHash: string): string {
  return `${taskHash}:${toolCallId}`;
}

/** Did the agent just read a file whose earlier read was elided? */
export function pruneMissFor(candidate: string, cwd: string): string | null {
  return elidedReads.get(path.resolve(cwd, candidate)) ?? null;
}

/** Forget a re-read, so it is counted once. */
export function forgetPruneMiss(candidate: string, cwd: string): void {
  elidedReads.delete(path.resolve(cwd, candidate));
}

/** Test only. */
export function _resetPruneMemory(): void {
  verdicts.clear();
  elidedReads.clear();
}

export function stubFor(verdict: Verdict): string {
  return (
    `${STUB_MARK}${verdict.label} (${verdict.chars.toLocaleString("en-US")} chars) left out as no longer ` +
    `relevant to the current task (decision ${verdict.decisionId}). Run the tool again if you need it.]`
  );
}

export interface PruneResult {
  /** Replacement messages; absent when nothing changes. */
  messages?: Msg[];
  asked: number;
  elided: number;
  savedChars: number;
}

/**
 * Decide and apply. Never throws: any failure leaves the messages as they were.
 */
export async function pruneContext(messages: Msg[], cwd: string, signal?: AbortSignal): Promise<PruneResult> {
  const config = getConfig();
  const none: PruneResult = { asked: 0, elided: 0, savedChars: 0 };
  if (!config.prune.enabled) return none;
  if (estimateContextTokens(messages) < config.prune.minContextTokens) return none;

  const candidates = findCandidates(messages, Math.max(1, config.prune.keepRecentTurns), config.prune.minChars);
  if (candidates.length === 0) return none;

  const { task, progress } = currentTask(messages);
  const taskHash = hashState(task);
  const shadow = config.shadow.prune;

  const open = candidates.filter((candidate) => !verdicts.has(verdictKey(candidate.toolCallId, taskHash)));
  let asked = 0;

  if (open.length > 0) {
    const offsets: number[] = [];
    for (let offset = 0; offset < open.length; offset += PER_CALL) offsets.push(offset);

    await mapConcurrent(offsets, Math.max(1, config.limits.concurrency), async (offset) => {
      const chunk = open.slice(offset, offset + PER_CALL);
      const state = [
        `## CURRENT TASK\n${task || "(unknown)"}`,
        `## LATEST PROGRESS\n${progress || "(none yet)"}`,
        "## EARLIER OUTPUTS",
        ...chunk.map((candidate, index) => `### O${offset + index}: ${candidate.label}\n${excerpt(candidate.text)}`),
      ]
        .join("\n\n")
        .slice(0, config.limits.maxStateChars);

      try {
        const outcome = await decide({
          tool: "jev_prune",
          purpose: `prune: ${task.slice(0, 120)}`,
          state,
          questions: chunk.map((candidate, index) => pruneQuestion(offset + index, candidate)),
          shadow,
          itemCount: chunk.length,
          timeoutMs: config.prune.timeoutMs,
          ...(signal ? { signal } : {}),
          annotate: (answers) => {
            const kept: string[] = [];
            const dropped: string[] = [];
            for (const [index, candidate] of chunk.entries()) {
              if ((answers[`o${offset + index}`]?.p ?? 1) >= config.prune.minConfidence) kept.push(candidate.label);
              else dropped.push(candidate.label);
            }
            return { kept, dropped };
          },
        });
        asked += chunk.length;
        for (const [index, candidate] of chunk.entries()) {
          const p = outcome.answers[`o${offset + index}`]?.p ?? 1;
          const verdict: Verdict = {
            elide: p < config.prune.minConfidence,
            decisionId: outcome.decisionId,
            chars: candidate.text.length,
            label: candidate.label,
          };
          verdicts.set(verdictKey(candidate.toolCallId, taskHash), verdict);
          if (verdict.elide && candidate.path) elidedReads.set(path.resolve(cwd, candidate.path), outcome.decisionId);
        }
      } catch {
        // Unjudged outputs stay, and are asked about again next time.
      }
    });

    while (verdicts.size > VERDICT_CAP) {
      const oldest = verdicts.keys().next().value;
      if (oldest === undefined) break;
      verdicts.delete(oldest);
    }
  }

  let elided = 0;
  let savedChars = 0;
  const next = shadow ? messages : messages.map((message) => ({ ...message }));
  for (const candidate of candidates) {
    const verdict = verdicts.get(verdictKey(candidate.toolCallId, taskHash));
    if (!verdict?.elide) continue;
    elided += 1;
    savedChars += candidate.text.length;
    if (!shadow) {
      const stub = stubFor(verdict);
      next[candidate.index] = { ...next[candidate.index], content: [{ type: "text", text: stub }] } as Msg;
      savedChars -= stub.length;
    }
  }

  if (shadow || elided === 0) return { asked, elided, savedChars: shadow ? savedChars : 0 };
  return { messages: next, asked, elided, savedChars };
}
