# Design notes

Why pi-jev works the way it does. The [README](../README.md) says what it does.

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


## 1. Deterministic rules decide danger; the model decides meaning

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

## 2. When the model is unreachable, the gate says *confirm* — never *allow*

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

## 3. A filter that drops the wrong thing is silent, so triage ships in shadow mode

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

## Making sure it is actually used

A tool the model has to remember to call is a tool it mostly does not call. So
pi-jev does not rely on the per-tool guidelines alone:

| | What happens | Switch |
|---|---|---|
| **System prompt** | One short section states the workflow — triage before reading, gate before acting, verify before reporting — naming only the jev_* tools that are active. | `hook.prompt` |
| **Triage hint** | A `grep` or `find` with 20+ results gets one line appended, with the pattern already filled in: the moment the agent decides what to read next. | `hook.triageHint` |
| **Model in the bash hook** | Consequential commands the rules cannot judge (pushes, cloud CLIs, databases, remote shells, publishes, deploys) are classified by the model *before they run*, with the same policy and fail-safe as `jev_gate`. Everyday local commands never pay for a call. | `hook.model` |
| **Used vs. missed** | Large search results nobody triaged and edits nobody verified are recorded per agent run. `/jev` shows coverage per tool, so "is it used?" is a number, not a feeling. | always, once a provider exists |
| **No dead tools** | Without a provider, `jev_triage`, `jev_verify` and `jev_decide` are hidden instead of failing; `/jev-setup` brings them back. Tools you excluded with `-xt` stay excluded. | — |

## Less context on every turn

Every LLM call re-sends the whole conversation, so anything that enters the
context is paid for again on every later turn. Two automatic steps keep out
what is not needed. Both start in **shadow mode**: they decide and log, but
change nothing until you turn them live.

**Trim** — long `bash` output (150+ lines, failed commands included). Head and
tail are always kept, blocks with a line saying error / fail / warn / traceback
are kept by regex without a model call, and Jev judges the rest block by block,
keeping anything it is unsure about. The full output is saved (or pi's own
saved copy is used) and the agent is told where. Reading that file is recorded
as a miss.

**Prune** — once the context passes ~40k tokens, earlier tool outputs of 2000+
characters from before the last two turns are judged against the current task.
The ones the task has moved past are replaced by a one-line stub saying what was
there and how to get it back. Verdicts are sticky per task, so each output is
judged once and the message prefix stays stable for the provider's prompt
cache. Reading a pruned file again is recorded as a miss. Only what is *sent*
changes; the session on disk keeps everything.

On any failure both leave the content untouched: here the cost of doing nothing
is tokens, the cost of doing it wrong is information.

```
/jev-shadow trim off     # go live once the misses in /jev are boringly low
/jev-shadow prune off
```

## Keeping decisions fast

The decision layer sits in front of real work, so its latency is the agent's latency.

- **Rules first.** Read-only commands and unambiguous danger are decided by regex in microseconds; the model is never called for them.
- **Decision cache.** An identical question over an identical state (the same command, the same triage) is answered from memory for ten minutes, not charged and not logged twice.
- **Provider cooldown.** A provider that just failed is skipped for thirty seconds, so a down hosted provider costs one timeout, not one per decision, and the local fallback answers immediately.
- **Warm-up.** At session start the first provider is contacted in the background, so the first real decision does not also pay for DNS and TLS — and an unreachable one is known before it is needed.
- **Parallel triage.** Chunks of candidates run side by side (four at a time), so 200 candidates take about one round trip instead of five. The reported latency is wall-clock.
