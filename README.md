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

## The problem it addresses

An agent burns tokens in three specific ways, and none of them is reasoning:

| | Where a model loses | What pi-jev takes off it |
|---|---|---|
| **Latency** | Exploration loops: grep → read → grep → read. Every turn is a full model call. | One filter call instead of three turns. |
| **Tokens** | It reads broadly to be safe. Fifty files, in case the right one is in there. | Filtering happens *before* the read. The noise never enters the context window. |
| **Precision** | It parses prose — logs, findings, hit lists — and hopes it understood. It states things and never checks them. | Answers are typed: they cannot be misread. And they come with a probability you can act on. |

The saving is not linear. Each turn re-sends the whole context, so exploratory
reading costs tokens × turns. That is where the money goes, and that is where a
100 ms filter that removes an entire exploration loop pays for itself.

**What that is worth depends on what your main model costs**, and it is worth
saying so rather than implying a saving that only exists at frontier prices.
Against a model at dollars per million tokens, this is a large win. Against a
budget model at a few cents, the tokens pi-jev removes are worth fractions of a
cent per call — the ledger will show you plainly: a triage call over nineteen
files costs about $0.00015, which is not a reason to use anything. What is left
at that price is a cleaner context, one fewer exploration loop, and the guard in
point 1 below, which costs nothing, needs no provider, and is the part that works
whether or not the money argument applies to you.

---

## Install

```bash
pi install npm:@patimweb/pi-jev
```

Then configure a provider:

```
jev_setup:
  action: add
  id: jev
  kind: jev
  apiKey: <key from console.typesafe.ai>
  model: jev-latest
```

Or point it at a local model instead, for state that must not leave the machine:

```
jev_setup:
  action: add
  id: local
  kind: ollama
  model: <whatever `ollama list` shows>
```

Providers form an ordered chain. The first reachable one answers, so a hosted
provider and a local one can coexist and the local one takes over when the
hosted one is down. Nothing above the provider layer knows which one ran.

---

## Tools

| Tool | What it does |
|---|---|
| `jev_triage` | Filter many files or matches down to the few that matter, **before** reading any of them. Candidates come from your filesystem at zero token cost; only the survivors are returned. |
| `jev_verify` | Check claims against the diff (including new files). Per claim: a probability and a verdict of supported / unclear / refuted. |
| `jev_gate` | Classify an action as read_only, reversible, destructive or needs_human, with a blast radius and an allow / confirm / block verdict. |
| `jev_decide` | The raw primitive: your state, your typed questions, calibrated answers. |
| `jev_label` | Attach ground truth to a past decision, so calibration means something. |
| `jev_status` | Configuration, provider reachability, ledger statistics. |
| `jev_setup` | Configure the provider chain. |

Commands: `/jev`, `/jev-calibration`, `/jev-shadow`, `/jev-providers`.

---

## Three decisions worth explaining

### 1. Deterministic rules decide danger; the model decides meaning

`jev_gate` runs in two layers. Danger that is visible in the string —
`rm -rf`, `mkfs`, `DROP TABLE`, force-push, `--no-preserve-root` — is decided by
regex in `src/guard.ts`, before any provider is consulted, and cannot be argued
away by reassuring context.

Everything else goes to the model. *Is this migration routine or one-way? Is
this cleanup or a catastrophe?* Intent is not in the string, and that is the
part worth a model call.

Two consequences worth stating plainly:

- **The gate works with no provider, no key and no network.**
- **The rules are enforced, not merely offered.** `jev_gate` fires only when the
  model chooses to call it, and a model that has already decided to run a command
  is not the party you want asking on its own behalf. So the same rules also run
  as a `tool_call` hook on every `bash` command (`hook.bash`, on by default): a
  `block` verdict stops the command before it runs, a `confirm` verdict is put to
  the user. A guardrail the model can skip is not a guardrail.
  The one deliberate relaxation: a `confirm` verdict runs when there is no UI to
  ask through, because those rules mean "worth a look" rather than "unambiguous
  danger", and silently refusing every `sudo` in a scripted session is how a
  guardrail gets uninstalled. The `block` tier is refused with or without a UI.
- **A model is not a security boundary.** It is probabilistic, and a
  probability of 0.95 is not a guarantee. Calling this "deterministic safety"
  would be dishonest; what is deterministic is the rule layer, and the model
  only refines what the rules could not see.

### 2. When the model is unreachable, the gate says *confirm* — never *allow*

The usual advice for a service in a critical path is to fail open. For a
guardrail that is backwards: it would mean the destructive command runs exactly
when the safety check is broken.

pi-jev fails safe instead. On timeout or an unreachable provider, `jev_gate`
returns *confirm* and says why. The local rules already handled everything
dangerous on its face, so what remains is genuinely ambiguous, and asking is
the right answer.

The gate also carries its own short deadline (`limits.gateTimeoutMs`, 2.5 s by
default). A gate that waits for a local model to finish thinking has stopped
being a gate.

### 3. A filter that drops the wrong thing is silent, so triage ships in shadow mode

A verifier that is wrong fails loudly: the next test catches it. A filter that
is wrong fails silently — the agent reads five files instead of fifty, sees only
those five, and reaches a confident wrong conclusion with no error anywhere.

So `jev_triage` can run in shadow mode. It filters and logs, but returns every
candidate marked `keep` or `drop`. pi-jev then watches whether the agent reads
something the filter had rejected, and records it as a **candidate false
negative** — resolving both paths against the directory they are relative to
first, so two files that merely share a name (`index.ts`, `types.ts`) are not
counted as each other.

```
/jev-shadow triage on
```

Run in shadow until that number is boringly low, then turn it off.

---

## Does it actually work? Measure it, do not assume it

Every decision is written to `~/.pi/jev-ledger.jsonl` — provider, model,
probabilities, latency, cost, and for triage what was kept and what was dropped.

Nothing can label a decision automatically. Whether a classification was right
is knowledge that arrives later, so `jev_label` records it when you know and
`/jev-calibration` computes:

| Metric | The question it answers |
|---|---|
| **Brier score** | How good are the probabilities, versus predicting the base rate every time? |
| **ECE** | How far is claimed confidence from observed accuracy? |
| **Reliability bins** | When it says 0.9, how often is it right? |
| **Threshold sweep** | If you act only above a threshold, what do you buy and what do you hand over? |
| **Shadow misses** | How often did the filter withhold something that mattered? |

This exists because the alternative is repeating vendor benchmarks. A
probability is only useful if it means something *on your data*, and the only
way to know is to write down what happened.

---

## What pi-jev is not

| | |
|---|---|
| **A calculator** | No counting, no arithmetic. Keep that in code and pass in the result or a named bucket. |
| **An explainer** | It produces a judgement, not a rationale. Anything you will read still comes from your model. |
| **A search engine** | It needs the questions defined in advance. Open-ended "find out why X happens" is not a decision. |
| **A guardrail on its own** | The rules catch the unambiguous; the model refines the rest. Neither is a sandbox and neither is a permission system. |
| **Free** | Jev is roughly $0.042 per million input tokens with free output. Local models cost nothing but take seconds — fine for triage, too slow for the gate. |
| **A way to save money on a cheap model** | At a few cents per million tokens the token saving is a rounding error, and the ledger will say so. What remains is context precision, latency, and the guard — which costs nothing and works with no provider at all. |
| **Verified against a live account** | See below. |

### The API contract, as verified

The request shape is documented. The response shape was described only in prose
and blog samples, so it was checked against the live endpoint instead of assumed
— and that check turned up a bug, which is the argument for doing it.

- **A score's levels go out as an ordered list, not a map.** A map is refused
  with HTTP 422 before a single token is spent. `jev_gate` asks for a score on
  every ambiguous action, so this was the difference between a gate that
  classifies and one that could only ever report that its classifier was
  unreachable. Choice and Noul do take a map, which is why the conversion lives
  in one place (`serialiseQuestion`).
- **`score` is a position on the level number line, not a level.** It is each
  level number multiplied by its probability, so 0.57 on level 1 plus 0.43 on
  level 2 comes back as 1.43. pi-jev reports the level the distribution peaks
  on — under the name you gave it, if you named your levels — together with that
  level's own probability, which is the quantity calibration is computed over.
- **`usage` is `input_tokens` / `output_tokens`, and a Noul answer arrives under
  `noul`.** Those are read as they come; the parser still accepts the other
  spellings for compatible endpoints.

What has not changed is the failure mode. When a probability cannot be read, the
answer is recorded `degraded` with `p=0.5` and the raw body is kept, rather than a
confidence being invented. Nothing downstream depends on a guess.

---

## Configuration

`~/.pi/jev-config.json`, mode 0600, written atomically.

```jsonc
{
  "providers": [ /* ordered chain: jev, ollama, openai-compat */ ],
  "limits": {
    "maxStateChars": 60000,   // reject states bigger than this rather than truncating silently
    "maxKeep": 8,             // triage survivors returned
    "minConfidence": 0.5,     // triage filter threshold
    "gateTimeoutMs": 2500     // gate deadline; on timeout the verdict is "confirm"
  },
  "verify": { "supportedAt": 0.7, "refutedAt": 0.3 },
  "gate": {
    "read_only": "allow",
    "reversible": "confirm",
    "destructive": "block",
    "needs_human": "confirm"
  },
  "hook": { "bash": true }, // apply the deterministic rules to every bash call, not only to jev_gate
  "shadow": { "triage": false, "verify": false, "gate": false },
  "ledger": { "maxBytes": 8388608, "keepEntries": 5000 }
}
```

The gate mapping is config, not prompt, on purpose: the model reports a risk
class, and the policy that turns a class into allow / confirm / block is
readable, reviewable and changeable without touching a model call.

The thresholds in `verify` and `limits.minConfidence` start as reasonable
guesses. The ledger exists to replace them with measured ones.

---

## Development

```bash
npm install
npm test        # 274 tests, no network required
npm run typecheck
```

```
index.ts              tools, commands, event wiring
src/guard.ts          deterministic risk rules
src/candidates.ts     zero-token candidate generation
src/questions.ts      request building, tolerant answer parsing
src/calibration.ts    Brier, ECE, reliability, threshold sweep
src/ledger.ts         append-only JSONL record
src/providers/        jev | ollama | openai-compatible
src/tools/            one file per tool
```

The tests are deliberately heavy on the parts that decide things — the guard
rules, the calibration maths, the answer parser, the candidate walker — because
those are the parts where a quiet bug changes what the agent believes.

---

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
