/**
 * Internal tuning.
 *
 * These used to be config keys. They are the numbers a user should never have
 * to think about — block sizes, deadlines, cache lifetimes — and every one of
 * them in the config file was one more thing to read, doubt and mistype. The
 * config keeps what is a *decision*: which provider, which policy, which
 * automatic step is on, what is only measured.
 *
 * If one of these turns out to need changing per user, the ledger will show it,
 * and it can go back into the config with a reason attached.
 */

export interface Tuning {
  /** Upper bound for the state handed to a provider; bigger states are refused, not truncated. */
  maxStateChars: number;
  /** Default cap on triage survivors. */
  maxKeep: number;
  /** Provider calls in flight at once, for triage, trim and prune. */
  concurrency: number;
  /** Identical decisions are answered from memory for this long. */
  cacheTtlMs: number;
  /** A provider that failed is skipped for this long. */
  providerCooldownMs: number;
  /** A grep/find result this large gets the jev_triage hint. */
  triageHintAt: number;
  trim: {
    minLines: number;
    blockLines: number;
    keepHead: number;
    keepTail: number;
    /** Low on purpose: a wrong drop is the expensive mistake. */
    minConfidence: number;
    timeoutMs: number;
  };
  prune: {
    /** Estimated tokens before pruning starts. */
    minContextTokens: number;
    minChars: number;
    keepRecentTurns: number;
    minConfidence: number;
    timeoutMs: number;
  };
  ledger: {
    maxBytes: number;
    keepEntries: number;
  };
}

function defaults(): Tuning {
  return {
    maxStateChars: 60_000,
    maxKeep: 8,
    concurrency: 4,
    cacheTtlMs: 10 * 60 * 1000,
    providerCooldownMs: 30_000,
    triageHintAt: 20,
    trim: { minLines: 150, blockLines: 25, keepHead: 10, keepTail: 40, minConfidence: 0.3, timeoutMs: 4_000 },
    prune: { minContextTokens: 40_000, minChars: 2_000, keepRecentTurns: 2, minConfidence: 0.3, timeoutMs: 3_000 },
    ledger: { maxBytes: 8 * 1024 * 1024, keepEntries: 5_000 },
  };
}

export const TUNING: Tuning = defaults();

/** Test only: override some values. */
export function _setTuning(patch: Partial<Omit<Tuning, "trim" | "prune" | "ledger">> & {
  trim?: Partial<Tuning["trim"]>;
  prune?: Partial<Tuning["prune"]>;
  ledger?: Partial<Tuning["ledger"]>;
}): void {
  const { trim, prune, ledger, ...flat } = patch;
  Object.assign(TUNING, flat);
  if (trim) Object.assign(TUNING.trim, trim);
  if (prune) Object.assign(TUNING.prune, prune);
  if (ledger) Object.assign(TUNING.ledger, ledger);
}

/** Test only: back to the defaults. */
export function _resetTuning(): void {
  const fresh = defaults();
  Object.assign(TUNING, fresh);
  TUNING.trim = fresh.trim;
  TUNING.prune = fresh.prune;
  TUNING.ledger = fresh.ledger;
}
