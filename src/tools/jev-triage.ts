/**
 * jev_triage — keep the noise out of the context window.
 *
 * The mechanism, in order:
 *   1. Candidates are produced by walking the filesystem and matching a regex.
 *      This costs zero model tokens.
 *   2. Each candidate is trimmed to a short preview.
 *   3. One noul question per candidate is asked, batched into chunks that share
 *      one state. Extra questions are nearly free because the state is sent once
 *      per chunk, not once per candidate.
 *   4. Only the survivors are returned. Everything else never reaches the agent.
 *
 * The dangerous property of a filter is that dropping the wrong thing is
 * silent, so shadow mode exists: the filter runs, the answer is logged, and
 * nothing is actually dropped. pi-jev then watches whether the agent reads
 * something the filter had rejected and records that as a candidate false
 * negative. Run in shadow until that number is boringly low.
 *
 * One distinction worth keeping straight: `minConfidence` is a *filter* — below
 * it, the agent is told nothing. `maxKeep` is a *ranking cap* — above the
 * threshold but past the cap is still a keep, just not in the returned list.
 * Only the former is recorded as a drop, because only the former can hide an
 * answer from the agent.
 */

import * as path from "node:path";

import { Type } from "typebox";

import { getConfig } from "../config.ts";
import { generateCandidates, renderCandidatesForState, type Candidate } from "../candidates.ts";
import { rememberDrops } from "../ledger.ts";
import { decide } from "../providers/index.ts";
import { formatTriage, type TriageRow } from "../format.ts";
import type { QuestionSpec } from "../types.ts";

interface TriageParams {
  question: string;
  criteria?: string;
  root?: string;
  globs?: string[];
  pattern?: string;
  perLine?: boolean;
  items?: string[];
  maxCandidates?: number;
  questionsPerCall?: number;
  maxKeep?: number;
  minConfidence?: number;
  showCandidates?: boolean;
  shadow?: boolean;
  provider?: string;
}

/** How many noul questions share one provider call. */
const DEFAULT_QUESTIONS_PER_CALL = 40;

/**
 * Run `worker` over `items` with at most `limit` in flight, keeping input order
 * in the output. A tiny pool rather than a dependency: this is the only place
 * pi-jev needs one.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(lanes);
  return out;
}

export function questionFor(index: number, candidate: Candidate, params: TriageParams): QuestionSpec {
  return {
    id: `c${index}`,
    type: "noul",
    instructions:
      `Does candidate \`${candidate.key}\` matter for this question: ${params.question}? ` +
      "Judge only what the excerpt shows. The two possible mistakes do not cost the same: " +
      "keeping a candidate that did not matter costs one file read, while dropping one that did " +
      "costs the answer. So when the excerpt is too thin to tell, answer true and let the reader " +
      "decide.",
    criteria: {
      true:
        params.criteria ??
        "The excerpt shows this candidate is relevant to the question, or it is too thin to rule it out.",
      false: "The excerpt shows this candidate is not relevant to the question.",
    },
  };
}

export const JevTriageTool = {
  name: "jev_triage",
  label: "Triage candidates",
  description:
    "Filter a large set of files or matches down to the few that matter, before reading any of them. Candidates are generated locally (glob/grep) at zero token cost, judged in one or a few calls, and only the survivors are returned — the rest never enter the context window. Use it whenever a grep or a directory listing yields far more hits than you can read.",
  promptSnippet: "Filter many files or matches down to the relevant few before reading them",
  promptGuidelines: [
    "Use jev_triage when a grep, glob or directory listing yields more than roughly 20 candidates and you would otherwise read them to find out which matter.",
    "Prefer jev_triage over reading files speculatively: it answers with paths and probabilities, so the follow-up read can be aimed instead of broad.",
    "Do not use jev_triage on fewer than about 10 candidates — the filtering overhead is not worth it, read them directly instead.",
  ],
  parameters: Type.Object({
    question: Type.String({
      description: "What you are looking for, in one sentence. Every candidate is judged against this.",
    }),
    criteria: Type.Optional(
      Type.String({ description: "What counts as relevant, when it is not obvious from the question" }),
    ),
    root: Type.Optional(
      Type.String({ description: "Directory to search, relative to the working directory. Default: the whole project." }),
    ),
    globs: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Patterns like "*.ts" or "src/**/*.java". A pattern without a slash matches the basename.',
      }),
    ),
    pattern: Type.Optional(
      Type.String({ description: "Only consider candidates whose content matches this regular expression" }),
    ),
    perLine: Type.Optional(
      Type.Boolean({ description: "Emit one candidate per matching line instead of one per file" }),
    ),
    items: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Explicit candidate list, for triaging things that are not files (search hits, findings, links). Overrides the file walk.",
      }),
    ),
    maxCandidates: Type.Optional(Type.Number({ description: "Cap on candidates considered (default 200)" })),
    questionsPerCall: Type.Optional(
      Type.Number({ description: "How many candidates share one provider call (default 40)" }),
    ),
    maxKeep: Type.Optional(Type.Number({ description: "Maximum survivors returned (default from config: 8)" })),
    minConfidence: Type.Optional(Type.Number({ description: "Minimum probability to survive (default from config: 0.5)" })),
    showCandidates: Type.Optional(
      Type.Boolean({
        description: "Also list everything that was dropped — spends the tokens the filter just saved, so only when debugging",
      }),
    ),
    shadow: Type.Optional(
      Type.Boolean({
        description: "Run the filter and log it, but return every candidate. Use while measuring false negatives.",
      }),
    ),
    provider: Type.Optional(Type.String({ description: "Force one configured provider id" })),
  }),
  async execute(
    _toolCallId: string,
    params: TriageParams,
    signal: AbortSignal,
    _onUpdate: unknown,
    ctx: { cwd: string },
  ) {
    const config = getConfig();
    const maxKeep = params.maxKeep ?? config.limits.maxKeep;
    const minConfidence = params.minConfidence ?? config.limits.minConfidence;
    const shadow = params.shadow ?? config.shadow.triage;
    const questionsPerCall = Math.max(1, params.questionsPerCall ?? DEFAULT_QUESTIONS_PER_CALL);
    // What the candidate keys are relative to. An explicit `items` list is not
    // made of paths, so there is no root to resolve those against.
    const searchRoot =
      params.items && params.items.length > 0 ? undefined : path.resolve(ctx.cwd, params.root ?? ".");

    /* ------------------------------------------------------ candidates */

    let candidates: Candidate[];
    let considered: number;
    let truncated: boolean;

    if (params.items && params.items.length > 0) {
      const cap = params.maxCandidates ?? 200;
      candidates = params.items.slice(0, cap).map((item) => ({
        key: item.length > 80 ? `${item.slice(0, 77)}…` : item,
        path: item,
        preview: item,
      }));
      considered = params.items.length;
      truncated = params.items.length > candidates.length;
    } else {
      const generated = generateCandidates({
        cwd: ctx.cwd,
        ...(params.root ? { root: params.root } : {}),
        ...(params.globs ? { globs: params.globs } : {}),
        ...(params.pattern ? { pattern: params.pattern } : {}),
        ...(params.perLine !== undefined ? { perLine: params.perLine } : {}),
        maxCandidates: params.maxCandidates ?? 200,
      });
      candidates = generated.candidates;
      considered = generated.considered;
      truncated = generated.truncated;
    }

    if (candidates.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: params.pattern
              ? `No candidate matched ${JSON.stringify(params.pattern)} among ${considered} files considered.`
              : `No files found to consider${params.globs ? ` matching ${params.globs.join(", ")}` : ""}.`,
          },
        ],
        details: { considered, candidates: 0, kept: 0, dropped: 0 },
      };
    }

    /* --------------------------------------------------------- scoring */

    const scored: Array<{ item: Candidate; p: number; keep: boolean }> = [];
    const decisions: string[] = [];
    const attempts: Array<{ provider: string; error: string }> = [];
    let provider = "";
    let latencyMs = 0;
    let costUsd = 0;
    let degraded = false;
    let partialFailure: string | null = null;

    // Chunks are independent questions over disjoint candidates, so they run side
    // by side up to `limits.concurrency`. A triage over 200 candidates used to be
    // five sequential round trips; now it is about one. Results are folded back
    // in chunk order, so the ranking does not depend on which call returned first.
    const chunkOffsets: number[] = [];
    for (let offset = 0; offset < candidates.length; offset += questionsPerCall) chunkOffsets.push(offset);

    type ChunkResult =
      | { ok: true; offset: number; chunk: Candidate[]; outcome: Awaited<ReturnType<typeof decide>> }
      | { ok: false; offset: number; error: Error };

    const runChunk = async (offset: number): Promise<ChunkResult> => {
      const chunk = candidates.slice(offset, offset + questionsPerCall);
      const questions = chunk.map((candidate, index) => questionFor(offset + index, candidate, params));
      const stateText = renderCandidatesForState(chunk, config.limits.maxStateChars);
      try {
        const outcome = await decide({
          tool: "jev_triage",
          purpose: `triage: ${params.question}`.slice(0, 180),
          state: stateText,
          questions,
          shadow,
          itemCount: chunk.length,
          ...(params.provider ? { providerId: params.provider } : {}),
          signal,
          annotate: (answers) => {
            // Filter by the threshold only. The ranking cap is applied later,
            // globally, and is deliberately not recorded as a drop.
            const kept: string[] = [];
            const dropped: string[] = [];
            for (const [index, candidate] of chunk.entries()) {
              const p = answers[`c${offset + index}`]?.p ?? 0;
              if (p >= minConfidence) kept.push(candidate.key);
              else dropped.push(candidate.key);
            }
            return { kept, dropped };
          },
        });
        return { ok: true, offset, chunk, outcome };
      } catch (error) {
        return { ok: false, offset, error: error as Error };
      }
    };

    const started = Date.now();
    const results = await mapConcurrent(chunkOffsets, Math.max(1, config.limits.concurrency), runChunk);
    // Wall-clock, not the sum: with parallel chunks the sum overstates what the
    // agent actually waited for.
    const wallMs = Date.now() - started;

    for (const result of results) {
      if (!result.ok) {
        attempts.push({ provider: params.provider ?? "chain", error: result.error.message });
        // Keep whatever other chunks produced rather than losing the whole
        // triage to one bad batch; report the shortfall instead.
        if (!partialFailure) partialFailure = result.error.message;
        continue;
      }
      const { outcome, chunk, offset } = result;
      decisions.push(outcome.decisionId);
      provider = outcome.provider;
      costUsd += outcome.costUsd;
      degraded = degraded || outcome.degraded;
      attempts.push(...outcome.attempts);

      for (const [index, candidate] of chunk.entries()) {
        const p = outcome.answers[`c${offset + index}`]?.p ?? 0;
        scored.push({ item: candidate, p, keep: p >= minConfidence });
      }
    }
    latencyMs = wallMs;

    if (scored.length === 0) {
      throw new Error(
        `Triage produced no scores.\n${attempts.map((attempt) => `  ${attempt.provider}: ${attempt.error}`).join("\n")}`,
      );
    }

    /* ------------------------------------------------------- assemble */

    const ranked = [...scored].sort((a, b) => b.p - a.p);
    const survivors = ranked.filter((row) => row.keep).slice(0, maxKeep);
    const survivorKeys = new Set(survivors.map((row) => row.item.key));

    // What the returned list looks like. Shadow mode lists every candidate so the
    // agent can read freely while the filter is measured, and an explicit
    // showCandidates request does the same outside shadow mode. Printing only the
    // survivors under a heading that says "all candidates" would misreport what
    // the filter did.
    const showAll = shadow || params.showCandidates === true;
    const rows: TriageRow[] = showAll
      ? ranked.map((row) => ({ key: row.item.key, preview: row.item.preview, p: row.p, keep: row.keep }))
      : survivors.map((row) => ({ key: row.item.key, preview: row.item.preview, p: row.p, keep: true }));

    const allDrops = ranked.filter((row) => !row.keep).map((row) => row.item.key);

    if (shadow && allDrops.length > 0 && decisions.length > 0) {
      // The search root travels with the drops, so a later read can be resolved
      // against the same directory the keys are relative to.
      rememberDrops(decisions[decisions.length - 1] ?? "unknown", allDrops, "jev_triage", searchRoot);
    }

    const text = formatTriage(rows, {
      provider: provider || "(none)",
      latencyMs,
      costUsd,
      considered,
      truncated,
      shadow,
      showDropped: showAll && !shadow,
      decisions,
      degraded,
    });

    const notes: string[] = [];
    if (shadow && allDrops.length > 0) {
      notes.push("");
      notes.push(
        `SHADOW MODE: all ${ranked.length} candidates were returned and ranked. The ${allDrops.length} marked \`drop\` are what the filter would have withheld; pi-jev records any of those you go on to read as a candidate false negative.`,
      );
    }
    if (survivors.length < ranked.filter((row) => row.keep).length) {
      notes.push("");
      notes.push(
        `${ranked.filter((row) => row.keep).length - survivors.length} further candidates were above the threshold but past maxKeep (${maxKeep}). They are not drops; raise maxKeep to see them.`,
      );
    }
    if (partialFailure) {
      notes.push("");
      notes.push(
        `Some batches failed, so this ranking covers only ${scored.length} of ${candidates.length} candidates. Reason: ${partialFailure}`,
      );
    }
    if (attempts.length > 0 && !partialFailure) {
      notes.push("");
      notes.push(`Earlier providers failed: ${attempts.map((a) => `${a.provider} (${a.error})`).join("; ")}`);
    }

    return {
      content: [{ type: "text" as const, text: text + notes.join("\n") }],
      details: {
        considered,
        candidates: candidates.length,
        scored: scored.length,
        kept: survivorKeys.size,
        dropped: allDrops.length,
        shadow,
        decisions,
        provider,
        latencyMs,
        costUsd,
      },
    };
  },
};
