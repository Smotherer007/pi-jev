![pi on the left, feeding a JEV decision core on the right, which returns a decision, a distribution, a calibrated gauge and a yes/no pair](screenshot.png)

# pi-jev

A decision layer for the [pi coding agent](https://github.com/earendil-works/pi).

pi-jev gives the agent a cheap, fast, **typed** way to make the small judgements
it currently spends frontier tokens and extra turns on: which of these forty
files matter, is this diff really what the summary claims, is this command
safe to run.

It is not a replacement for your model. It sits underneath it.

```
candidates (filesystem + regex)   →  0 tokens
Jev: typed, calibrated answers    →  ~100 ms, cents per million tokens
your model in pi                  →  reasoning, judgement, the answer to the user
```

Jev does not generate text and cannot explain itself, so everything you read
still comes from your model. pi-jev only decides **what that model does and
reads**. Route · Guard · Triage · Verify.

---

pi-jev puts that decision model to work in three places:

- **Before reading** — `jev_triage` filters fifty candidate files down to the five that matter, before any of them enter the context.
- **Before acting** — every consequential `bash` command is checked by deterministic rules and, where they cannot tell, by the model. Nobody has to remember to ask.
- **Before reporting** — `jev_verify` checks the agent's claims against the diff.

And it keeps the context small: long command output is cut to what matters, and earlier outputs the task has moved past are replaced by a one-line stub.

---

## Install

```bash
pi install npm:@patimweb/pi-jev
```

Then, inside pi:

```
/jev-setup add jev                    # asks for the key from console.typesafe.ai
/jev-setup add ollama model=<name>    # or a local model, for state that must not leave the machine
```

Providers form an ordered chain; the first reachable one answers. The key is
typed into a command, so it never passes through the model's context. Without
any provider, the bash guard rules still work.

---

## What runs automatically

| | What happens | Needs a provider |
|---|---|---|
| **Bash guard** | Unambiguous danger (`rm -rf`, `mkfs`, force-push, `DROP TABLE`…) is blocked or put to you by regex, before the command runs. | no |
| **Bash model check** | Consequential commands the rules cannot judge — pushes, cloud CLIs, databases, remote shells, deploys — are classified by the model before they run. Unreachable model → *confirm*, never *allow*. | yes |
| **System prompt** | One short section: triage before reading, gate before acting, verify before reporting. | yes |
| **Triage hint** | A `grep`/`find` with 20+ results gets one line pointing at `jev_triage`, pattern filled in. | yes |
| **Trim** *(shadow)* | Long `bash` output (150+ lines) cut to the lines that matter; full output saved and pointed to. | yes |
| **Prune** *(shadow)* | Past ~40k tokens, earlier outputs the task has moved past become a one-line stub. | yes |

*Shadow* means it decides and logs but changes nothing yet. Turn it live with
`/jev-shadow trim off` once `/jev` shows the misses are boringly low.

## Tools, for the agent

| Tool | What it does |
|---|---|
| `jev_triage` | Filter many files or matches down to the few that matter, before reading any of them. |
| `jev_verify` | Check claims against the diff: per claim a probability and supported / unclear / refuted. |
| `jev_gate` | Classify an action as read_only / reversible / destructive / needs_human, with a blast radius and allow / confirm / block. |
| `jev_decide` | The raw primitive: your state, your typed questions, calibrated answers. |

Drop what you do not use: `pi -xt jev_verify,jev_decide`.

## Commands, for you

| Command | |
|---|---|
| `/jev [verbose]` | Providers, configuration, ledger, used vs. missed per tool. |
| `/jev-setup` | `add jev\|ollama\|openai-compat [key=value…]`, `remove <id>`, or no argument to list. |
| `/jev-shadow` | `triage\|verify\|gate\|trim\|prune\|all\|none [on\|off]` |
| `/jev-label` | `<decisionId> ok\|wrong [q=<question>] [note]` — ground truth, so calibration means something. |
| `/jev-calibration` | Brier score, ECE, reliability curve, threshold sweep over labelled decisions. |

---

## Configuration

`~/.pi/jev-config.json`, mode 0600. Everything here is a decision, not a tuning number:

```jsonc
{
  "providers": [ /* ordered chain, managed with /jev-setup */ ],
  "gate": {                      // risk class → verdict; policy, not prompt
    "read_only": "allow", "reversible": "confirm",
    "destructive": "block", "needs_human": "confirm"
  },
  "hook": {                      // what runs automatically
    "bash": true,                // deterministic rules on every bash call
    "model": "consequential",    // model check on bash: off | consequential | all
    "triageHint": true,
    "trim": true,
    "prune": true,
    "prompt": true
  },
  "shadow": { "triage": false, "verify": false, "gate": false, "trim": true, "prune": true },
  "limits": { "minConfidence": 0.5, "gateTimeoutMs": 2500 },
  "verify": { "supportedAt": 0.7, "refutedAt": 0.3 }
}
```

The thresholds start as reasonable guesses; the ledger exists to replace them
with measured ones.

---

## What pi-jev is not

- **Not a text generator.** It produces judgements, not explanations; everything you read still comes from your model.
- **Not a calculator or a search engine.** No counting, no open-ended "find out why". The questions are fixed in advance.
- **Not a sandbox.** The rules catch what is dangerous on its face; the model refines the rest. Neither is a permission system.
- **Not a big saving on a cheap model.** At a few cents per million tokens the token saving is a rounding error. What remains is a cleaner context, fewer exploration loops, and the guard.

## Further reading

- [Design notes](docs/design.md) — why rules decide danger, why the gate fails to *confirm*, why filters ship in shadow mode, how decisions stay fast.
- [Measuring it](docs/measurement.md) — the ledger, calibration, shadow misses, used vs. missed.
- [The API contract, as verified](docs/api-contract.md) — what the live endpoint actually expects and returns.

## Development

```bash
npm install
npm test        # 328 tests, no network required
npm run typecheck
```

```
index.ts              registration only
src/guard.ts          deterministic risk rules
src/gate-model.ts     the model half of the gate, shared by jev_gate and the bash hook
src/trim.ts           long bash output cut to what matters
src/prune.ts          earlier outputs stubbed once the task has moved past them
src/candidates.ts     zero-token candidate generation
src/questions.ts      request building, tolerant answer parsing
src/calibration.ts    Brier, ECE, reliability, threshold sweep
src/ledger.ts         append-only JSONL record
src/providers/        jev | ollama | openai-compatible
src/tools/            the four agent tools, one file each
src/hooks/            what runs automatically: guard, usage, context, session
src/commands/         /jev, /jev-setup, /jev-label, /jev-calibration, /jev-shadow
src/tuning.ts         internal numbers that are not config
```

The tests are deliberately heavy on the parts that decide things — the guard
rules, the calibration maths, the answer parser, the candidate walker — because
those are the parts where a quiet bug changes what the agent believes.

## Prior art and related

- [TypeSafe AI](https://typesafe.ai) and Jev — the decision model this wraps.
- [pi-mindplace](https://github.com/Smotherer007/pi-mindplace) — structural
  orientation from a code graph. Together they form a funnel: mindplace narrows
  by structure, Jev narrows by meaning, the model reasons about what is left.
- [pi-sentinel](https://github.com/Smotherer007/pi-sentinel) — verification and
  checkpoints. Sentinel verifies and can undo; `jev_gate` is the part that
  declines to start.

## License

MIT
