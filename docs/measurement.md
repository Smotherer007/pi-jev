# Measuring it


Every decision is written to `~/.pi/jev-ledger.jsonl` — provider, model,
probabilities, latency, cost, and for triage what was kept and what was dropped.

Nothing can label a decision automatically. Whether a classification was right
is knowledge that arrives later, so `/jev-label` records it when you know and
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

## Shadow mode

Every step that can withhold something — triage, trim, prune — can run in
shadow mode: it decides and logs, but acts as if it had not. The ledger then
records what it *would* have withheld, and whether the agent went on to read
exactly that (a *miss*). Trim and prune start in shadow mode.

```
/jev-shadow                 show the current state
/jev-shadow trim off        go live once the misses are boringly low
/jev-shadow all on          measure everything
```

## Used vs. missed

`/jev` also shows how much of the work actually went through the decision
layer: per tool, how often it was used, and how often the agent did the same job
without it (a large search result nobody triaged, edits nobody verified). If a
tool's coverage stays near zero, the agent does not reach for it, and it is
cheaper to drop it (`pi -xt jev_verify`) than to keep paying for its prompt surface.

## Labelling

Nothing can label a decision automatically — whether a verdict was right is
knowledge that arrives later, and it is yours. `/jev-label` lists recent
decisions; `/jev-label <id> ok|wrong [q=<question>] [note]` records the outcome;
`/jev-calibration` turns the labels into a reliability curve and a threshold sweep.
