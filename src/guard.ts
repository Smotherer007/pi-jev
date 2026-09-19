/**
 * Deterministic guard rules — the floor under the model.
 *
 * The division of labour here matters more than the individual patterns:
 *
 *   A decision model is good at *meaning*. Is `find . -name "*.log" -delete`
 *   a cleanup or a catastrophe? Is this migration routine or one-way? That is
 *   a judgement about intent, and intent is not in the string.
 *
 *   A decision model is bad at *certainty*. It can be talked into rating
 *   `rm -rf /` as safe by surrounding it with reassuring context, and a
 *   probability of 0.92 is not a guarantee. Some commands are dangerous
 *   regardless of what anyone says about them.
 *
 * So danger that is visible in the string is decided by regex, before any
 * provider is consulted, and cannot be argued away. Everything ambiguous is
 * handed to the model. This also means `jev_gate` still does something useful
 * with no provider configured and no network.
 *
 * The rules are deliberately conservative: a false positive costs a
 * confirmation prompt, a false negative is the failure this file exists to
 * prevent. When in doubt a rule does *not* fire, and the model decides.
 */

import type { GateVerdict, RiskClass } from "./types.ts";

export interface HardVerdict {
  risk: RiskClass;
  blast: number;
  verdict: GateVerdict;
  /** Why the rule fired, in words the user can argue with. */
  reason: string;
  /** The literal pattern that matched, so the rule can be reviewed. */
  matched: string;
  source: "rule";
}

interface Rule {
  /** The pattern that triggers it. */
  pattern: RegExp;
  risk: RiskClass;
  blast: 1 | 2 | 3 | 4;
  verdict: GateVerdict;
  reason: string;
}

/**
 * Rules that fire on the action string. Ordered from most to least severe so
 * the first match is the one reported.
 */
const RULES: readonly Rule[] = [
  // ---------------------------------------------------- unrecoverable system
  {
    pattern: /\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*[rR])\b/,
    risk: "destructive",
    blast: 3,
    verdict: "block",
    reason: "recursive force delete — no undo outside version control",
  },
  {
    pattern: /\b(mkfs(\.\w+)?|wipefs|shred|blkdiscard)\b/,
    risk: "destructive",
    blast: 4,
    verdict: "block",
    reason: "destroys a filesystem or device; nothing survives to restore from",
  },
  {
    pattern: /\bdd\s+[^\n]*\bof=\s*\/dev\//,
    risk: "destructive",
    blast: 4,
    verdict: "block",
    reason: "writes raw data over a device",
  },
  {
    pattern: /\b(fdisk|parted|diskpart)\b/,
    risk: "destructive",
    blast: 4,
    verdict: "block",
    reason: "modifies the partition table",
  },
  {
    // The classic fork bomb, and the two common variants.
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    risk: "destructive",
    blast: 3,
    verdict: "block",
    reason: "fork bomb",
  },
  {
    pattern: /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\/(\s|$)/,
    risk: "destructive",
    blast: 4,
    verdict: "block",
    reason: "makes the whole filesystem world-writable",
  },
  {
    pattern: /--no-preserve-root/,
    risk: "destructive",
    blast: 4,
    verdict: "block",
    reason: "explicitly disables the guard on deleting the root filesystem",
  },
  {
    pattern: /(^|\s)>\s*\/(dev\/(sd|nvme|hd)|etc\/)/,
    risk: "destructive",
    blast: 4,
    verdict: "block",
    reason: "truncates a device or system configuration by redirect",
  },

  // ------------------------------------------------------------ data loss
  {
    pattern: /\b(DROP\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\s+TABLE)\b/i,
    risk: "destructive",
    blast: 4,
    verdict: "block",
    reason: "drops or truncates database objects irreversibly",
  },
  {
    pattern: /\bDELETE\s+FROM\s+\w+\s*(;|$)/i,
    risk: "destructive",
    blast: 4,
    verdict: "block",
    reason: "unqualified DELETE with no WHERE clause",
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/,
    risk: "destructive",
    blast: 2,
    verdict: "confirm",
    reason: "discards uncommitted work in the working tree",
  },
  {
    pattern: /\bgit\s+(push|send-email)\b[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/,
    risk: "destructive",
    blast: 3,
    verdict: "confirm",
    reason: "rewrites published history for everyone who has the branch",
  },
  {
    pattern: /\bgit\s+clean\s+-[a-zA-Z]*[fdx]/,
    risk: "destructive",
    blast: 2,
    verdict: "confirm",
    reason: "deletes untracked files, which are not in any commit",
  },
  {
    pattern: /\b(git\s+checkout\s+--\s+\.|git\s+restore\s+\.)/,
    risk: "destructive",
    blast: 2,
    verdict: "confirm",
    reason: "overwrites every modified file in the tree",
  },

  // ---------------------------------------------------------------- blast
  {
    pattern: /\brm\b[^\n]*\s(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)\b/,
    risk: "destructive",
    blast: 2,
    verdict: "confirm",
    reason: "recursive delete without force; still worth a look at the target",
  },
  {
    pattern: /\bmv\b[^\n]*\s(\/(etc|var|usr|home)\b|~\/?(\s|$))/,
    risk: "destructive",
    blast: 3,
    verdict: "confirm",
    reason: "moves a system or home directory",
  },

  // ------------------------------------------------------------ privilege
  {
    pattern: /(^|\s)sudo\b/,
    risk: "needs_human",
    blast: 3,
    verdict: "confirm",
    reason: "runs with elevated privileges; the blast radius stops being visible in the command",
  },
];

/**
 * Read-only actions that are safe to fast-track with no model call at all.
 *
 * This list is deliberately short and anchored: a command is only cleared when
 * it matches from the start and contains nothing that would make it a write.
 * Anything not on the list falls through to the model, because "not obviously
 * read-only" and "writes" are the same thing as far as caution goes.
 */
const READ_ONLY_PATTERNS: readonly RegExp[] = [
  /^\s*(ls|ll|pwd|whoami|id|hostname|date|uname|which|type|stat|file|tree|du|df|wc|head|tail|cat|nl|less|more|bat)\b/,
  /^\s*(grep|rg|ag|egrep|fgrep|findstr)\b/,
  /^\s*(find|fd)\b(?!.*(-delete|-exec|-execdir|-ok|-okdir|-fprint|-fls))/,
  /^\s*git\s+(status|log|show|diff|branch|remote|describe|rev-parse|ls-files|blame|shortlog|tag|config\s+--get|stash\s+list)\b/,
  /^\s*(npm|pnpm|yarn|bun)\s+(ls|list|view|why|outdated|audit|--version)\b/,
  /^\s*(node|deno|python3?|go|cargo|java)\s+--version\b/,
  /^\s*(ps|top|htop|free|uptime|env|printenv|echo|printf|sort|uniq|cut|awk|sed\s+-n)\b/,
  /^\s*(curl|wget)\b(?!.*(-X\s*(POST|PUT|PATCH|DELETE)|--data|-d\s|-O\b|--output|-o\s))/,
  /^\s*(docker|kubectl|podman)\s+(ps|images|logs|describe|get|version|inspect)\b/,
  /^\s*(ollama|pip|pip3)\s+(list|show|--version)\b/,
];

/** Characters that make an otherwise read-only command into a chain of writes. */
const SHELL_CHAIN = /(\|\||&&|;|`|\$\(|>\s*[^&]|>>)/;

export interface GuardInput {
  /** The command or action, verbatim. */
  action: string;
  /** Optional context, e.g. "production". Considered for escalation only. */
  context?: string;
}

/**
 * Apply the deterministic rules.
 *
 * Returns null when nothing is certain, which is the common case and the one
 * that should reach the model.
 */
export function hardGuard(input: GuardInput): HardVerdict | null {
  const action = input.action.trim();
  if (action.length === 0) return null;

  for (const rule of RULES) {
    const match = rule.pattern.exec(action);
    if (!match) continue;
    return {
      risk: rule.risk,
      blast: rule.blast,
      verdict: rule.verdict,
      reason: rule.reason,
      matched: match[0],
      source: "rule",
    };
  }

  // Only fast-track a read when it cannot be part of a larger write or of a
  // chain that hides one behind it.
  if (!SHELL_CHAIN.test(action)) {
    for (const pattern of READ_ONLY_PATTERNS) {
      if (pattern.test(action)) {
        return {
          risk: "read_only",
          blast: 1,
          verdict: "allow",
          reason: "matched a read-only command pattern and contains no chaining, redirect or substitution",
          matched: pattern.source,
          source: "rule",
        };
      }
    }
  }

  // Context never lowers a verdict, only raises one: "production" in the
  // context is a reason for more care, never less.
  const context = (input.context ?? "").toLowerCase();
  // Prefix matches for the German stems, because "kundensystem" and
  // "produktivsystem" are the forms that actually appear in a context string.
  if (/\b(prod\w*|live|customer\w*|kunde\w*)\b/.test(context) && SHELL_CHAIN.test(action)) {
    return {
      risk: "needs_human",
      blast: 4,
      verdict: "block",
      reason: "a chained or redirected command aimed at production; the effect is not readable from the command alone",
      matched: "production context",
      source: "rule",
    };
  }

  return null;
}

/** Exposed for tests and for `jev_gate` output. */
export function ruleCount(): number {
  return RULES.length;
}
